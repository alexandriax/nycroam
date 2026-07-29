import * as THREE from 'three';
import { dataUrl } from './dataver';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TileManager } from './TileManager';
import { PlayerControls } from './controls';
import {
  resolveBuildingCollision, nearestWallDir, floorAt, floorAtAny,
  pointInBuildings, buildingRingsAt, pointInBuildingsExcept, roofBelow,
} from './collision';
import { PATH_KIND_ROAD, type RoadPaths } from './tileTypes';
import { setupSky, setupLights, followSun, makeOutdoorEnvironment, SKY } from './sky';
import { mobileQualityRequested, quality, runtimePerformanceProfile } from './quality';
import { installAtmosphere } from './atmosphere';
import { makeSkylineMaterial, makeFlatMaterial, makeWaterMaterial } from './materials';
import { materialLibrary } from './materialLibrary';
import { EntranceManager, disposeGroup } from './EntranceManager';
import { PlaqueManager, type PlaqueInfo } from './PlaqueManager';
import { BikeManager, buildMountedBike } from './bikes';
import { LandmarkManager } from './landmarks/LandmarkManager';
import { LANDMARKS_REG } from './landmarks/registry';
import { BikeView } from './bikeview';
import { WalkBob } from './walkbob';
import { AudioManager } from './audio';
import { GoalTracker } from './goals';
import { BusSystem, type BusRideHandle } from './bus/BusSystem';
import { TramSystem, type TramRideHandle } from './tram';
import { BusModel } from './bus/model';
import { buildBusStop } from './bus/stops';
import { BUS, type BusHud, type BusRouteBadge } from './bus/types';
import { loadSans } from './fonts';
import { StationWorld } from './subway/StationWorld';
import { ElevatedStationWorld } from './subway/ElevatedStationWorld';
import { ComplexStationWorld } from './subway/ComplexStationWorld';
import { complexFor } from './subway/complexes';
import { TrainScheduler } from './subway/scheduler';
import { RideWorld, type RideHud } from './subway/RideWorld';
import type { StationSpec, NetworkData, Arrival } from './subway/types';
import { routeColor } from './subway/types';
import { boardLabel } from './subway/directions';
import { lonLatToXZ, xzToLonLat, googleMapsUrl, ORIGIN, M_PER_DEG_LAT, M_PER_DEG_LON } from './geo';
import { loadTerrain, heightAt } from './terrain';
import { StreetLife } from './StreetLife';
import type { DensityAnchor } from './population/density';
import {
  QualityGovernor,
  type QualityDecision,
  type RuntimeQualitySettings,
} from './performance/QualityGovernor';
import { WebGLGpuTimer } from './performance/WebGLGpuTimer';
import { RenderingPipeline } from './rendering/RenderingPipeline';
import {
  PerformanceRecorder,
  estimateSceneResources,
  estimateShadowDrawCalls,
} from './performance/PerformanceRecorder';
import {
  GOLDEN_ROUTES,
  goldenRouteIds,
  type GoldenRouteId,
} from './performance/goldenRoutes';

const SAVE_KEY = 'nycroam';
const LEGACY_SAVE_KEY = 'nycworld'; // read-only: keeps positions saved before the rename
const WALK_EYE = 1.7; // standing; BikeView.eyeHeight is the seated one
const START = { lat: 40.766931, lon: -73.981573 }; // Columbus Circle — first-visit spawn
const START_LOOK = { yaw: (21.3 * Math.PI) / 180, pitch: (6.2 * Math.PI) / 180 }; // first-visit facing

/** Anything the rider can be aboard in mode 'bus': an MTA bus or the tram.
 * The tram handle carries its own cabin geometry (interior box, floor, eye,
 * both-side doors); buses fall back to the BUS constants. */
type TransitHandle = BusRideHandle | TramRideHandle;
const rideInterior = (h: TransitHandle) => ('interior' in h ? h.interior : BUS.interior);
const rideFloorY = (h: TransitHandle) => ('floorY' in h ? h.floorY : BUS.floorY);
const rideEye = (h: TransitHandle) => ('eye' in h ? h.eye : BUS.eye);

/**
 * A curb-side kit's ground footprint, for clearing it off the roadbed. The kit's
 * long axis runs ALONG the street (bus shelter, dock rack, stair pit all parallel
 * the curb); `hL` is that half-length and `pR` the perpendicular half-reach toward
 * the road. The eject keeps this whole oriented rectangle `margin` metres clear of
 * every ribbon — so a long shelter/rack end can't poke a crossing lane even when
 * the pole itself is on the sidewalk (the residual that left a bus-stop corner in
 * the Columbus Circle roadbed). `bldgClear` is the wall stand-off; `fixed` freezes
 * the tangent to the RAW point (a bus kit's facing is set by BusSystem from the
 * serving street the GTFS point sits on, not by whichever ribbon is nearest the
 * moved anchor); `drop` lets a stop that can't be seated clear of the lane be
 * skipped rather than rendered in traffic.
 */
interface KitFootprint {
  hL: number; pR: number; margin: number; bldgClear: number; fixed?: boolean; drop?: boolean;
}
const BUS_FP: KitFootprint = { hL: 5.5, pR: 1.0, margin: 0.6, bldgClear: 1.6, fixed: true, drop: true };
const DOCK_FP: KitFootprint = { hL: 7.4, pR: 1.05, margin: 0.5, bldgClear: 2.6 };
const ENTRANCE_FP: KitFootprint = { hL: 3.6, pR: 1.2, margin: 0.5, bldgClear: 2.2 };
// Footprint sample offsets in the kit-local (along-street, perp-to-road) frame:
// the four corners, the four edge mid-points, and the anchor. Clearing all nine
// keeps the whole rectangle out of the roadbed without a full polygon test.
function fpSamples(hL: number, pR: number): [number, number][] {
  return [[0, 0], [hL, pR], [-hL, pR], [hL, -pR], [-hL, -pR], [hL, 0], [-hL, 0], [0, pR], [0, -pR]];
}

export interface HudState {
  mode: 'street' | 'station' | 'ride' | 'bus';
  fly: boolean;
  prompt: string | null; // e.g. "72 St · 1·2·3"
  promptRoutes: string[];
  promptBus: BusRouteBadge[]; // bus route chips on the prompt (stops / boarding)
  promptHint: string | null; // action verb ("grab a bike"); null = subway walk-in default
  riding: boolean; // on a bike
  area: string | null; // current neighborhood (street mode)
  street: string | null; // street the player is standing on (street/bus mode)
  cross: string | null; // nearest cross street to that position
  stationName: string | null;
  stationRoutes: string[];
  nearInfo: { label: string; lm: boolean } | null; // building plaque within reach — press i / tap ⓘ
  ride: RideHud | null;
  bus: BusHud | null; // set while riding a bus (mode 'bus')
  tilesLoaded: number;
  tilesPending: number;
  fps: number;
  loading: boolean;
  error: string | null;
}

export const LANDMARKS: { name: string; lat: number; lon: number }[] = [
  { name: 'Times Square', lat: 40.758, lon: -73.9855 },
  { name: 'Empire State Building', lat: 40.7484, lon: -73.9857 },
  { name: 'Grand Central', lat: 40.7527, lon: -73.9772 },
  { name: 'Central Park: Bethesda', lat: 40.774, lon: -73.9708 },
  { name: 'Columbus Circle', lat: 40.7681, lon: -73.9819 },
  { name: 'Washington Sq Park', lat: 40.7308, lon: -73.9973 },
  { name: 'Wall Street', lat: 40.7069, lon: -74.0113 },
  { name: 'One World Trade', lat: 40.7130, lon: -74.01319 },
  { name: 'The Battery', lat: 40.7033, lon: -74.017 },
  { name: 'Union Square', lat: 40.7359, lon: -73.9906 },
  { name: 'Rockefeller Center', lat: 40.7587, lon: -73.9787 },
  { name: 'Apollo Theater (Harlem)', lat: 40.81, lon: -73.95 },
  { name: 'Inwood', lat: 40.867, lon: -73.9212 },
];

export class World {
  private renderer: THREE.WebGLRenderer;
  private rendering: RenderingPipeline;
  private camera: THREE.PerspectiveCamera;
  private streetScene = new THREE.Scene();
  private tiles: TileManager;
  private streetLife: StreetLife;
  private retailAnchorTimer = 0;
  private readonly retailAnchorScratch: number[] = [];
  private entrances: EntranceManager;
  private plaques: PlaqueManager;
  private nearPlaque: PlaqueInfo | null = null; // building whose plaque is in reach (street mode)
  private bikes: BikeManager;
  private landmarks: LandmarkManager;
  private hoods: { n: string; rings: number[][]; bbox: [number, number, number, number] }[] | null = null;
  private hoodTimer = 0;
  private riding = false; // on a bike (street mode only)
  private bikeView: BikeView | null = null; // built on the first ride, kept after
  private walkBob = new WalkBob(); // subtle on-foot head-bob (cosmetic camera offset)
  private onFootBob = false; // apply the walk-bob to the camera this frame
  /** Diegetic sound: footsteps, bike/bus/train/heli ambiences, doors, arrivals. */
  readonly audio = new AudioManager();
  /** Goals / achievements: transit events + a per-frame spatial/motion sample. */
  readonly goals = new GoalTracker();
  private prevBusHudState: string | null = null; // ridden-bus door-open edge
  private lastArriveSound = 0; // throttle the "train pulling in" one-shot
  private footstepsEnabled = true; // footstep SFX (uses the updated sample)
  private controls: PlayerControls;
  private station: StationWorld | ElevatedStationWorld | ComplexStationWorld | null = null;
  private scheduler: TrainScheduler | null = null;
  private ride: RideWorld | null = null;
  private network: NetworkData | null = null;
  private buses: BusSystem;
  private tram: TramSystem;
  private busRide: TransitHandle | null = null;
  private ridingTram = false; // busRide came from the tram (grade-level cabin, both-side doors)
  private busLocal = new THREE.Vector3(3.0, 0, 0.2); // rider offset inside the cabin
  private prevBusYaw = 0;
  private busEndSince = 0;
  private busBike: THREE.Group | null = null; // bike mounted on the bus front while riding
  private broughtBike = false; // boarded this bus on a bike — remount it on exit
  private mode: 'street' | 'station' | 'ride' | 'bus' = 'street';
  private pos = new THREE.Vector3(0, 0, 40); // feet position
  private returnPos = new THREE.Vector3();
  private eyeHeight = WALK_EYE;
  private isMobile: boolean;
  private clock = new THREE.Clock();
  private raf = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private hudTimer = 0;
  // Adaptive resolution: render at the device's full (capped) pixel ratio and
  // step down only when the GPU can't hold frame rate, stepping back up when
  // headroom returns. Strong machines never leave full res; weak ones trade
  // pixels they can't push for a steady frame rate. Quality is only ever
  // reduced UNDER LOAD, and recovers by itself.
  private maxPixelRatio = 2;
  private dynPixelRatio = 2;
  private authoredShadowMapSize = 1024;
  private authoredLoadRadius = 1150;
  private tileWorkerCount = 2;
  private qualityGovernor: QualityGovernor;
  private gpuTimer: WebGLGpuTimer;
  private performanceRecorder = new PerformanceRecorder();
  private lastGpuMs: number | null = null;
  private activeRenderScene: THREE.Scene = this.streetScene;
  private shadowDrawEstimate = 0;
  private benchmarkActive = false;
  private governorSawTransition = false;
  /** What the adaptive loop has given up so far, newest last (settings UI + debug). */
  perfNotes: string[] = [];
  private transitioning = false;
  private lastEnterGuard = 0; // avoid instant re-trigger loops
  private spawnResolve = false; // eject from a building after a teleport/exit, once tiles load
  private spawnLookAt: { x: number; z: number } | null = null; // menu jump target, cleared after safe arrival
  private spawnLandmarkId: string | null = null; // wait for replacement massing before resolving a landmark jump
  private spawnWaitStarted = 0;
  private skyDome: THREE.Object3D | null = null;
  private lastRaf = 0;
  private tickInterval = 0;
  /** Outdoor sky/ground probe used by street glass, metal and vehicles. */
  private streetEnvTex: THREE.Texture | null = null;
  /** Indoor softbox probe used by stations and subway rides. */
  private envTex: THREE.Texture | null = null;
  private baseLoadRadius = 1150;
  private currentStationSpec: StationSpec | null = null;
  private atEndSince = 0;
  private sun: THREE.DirectionalLight | null = null;
  private waterUpdate: ((dt: number) => void) | null = null;
  private flyVel = new THREE.Vector3();
  private flyTarget = new THREE.Vector3();
  private velSX = 0; // smoothed ground velocity (m/s) — leads the tile stream ahead of fast movers
  private velSZ = 0;
  private _eye = new THREE.Vector3(); // reused camera-eye scratch (per-frame, hot path)
  hud: HudState = {
    mode: 'street', fly: false, prompt: null, promptRoutes: [], promptBus: [], promptHint: null, riding: false, area: null, street: null, cross: null, stationName: null,
    stationRoutes: [], nearInfo: null, ride: null, bus: null, tilesLoaded: 0, tilesPending: 0, fps: 0, loading: true, error: null,
  };
  onHud: ((h: HudState) => void) | null = null;
  onFade: ((opaque: boolean) => void) | null = null;
  onInfo: ((info: PlaqueInfo) => void) | null = null; // open the building-info modal (i key / mobile button)

  constructor(canvas: HTMLCanvasElement) {
    // Rewrites three's shared fog chunks, so it must land before anything
    // compiles a program. Materials resolve chunks at first render, not at
    // construction, but keeping this first removes the question entirely.
    installAtmosphere();
    this.isMobile = mobileQualityRequested();
    const q = quality();
    const runtimeProfile = runtimePerformanceProfile();
    // Full-screen AA is tiered in RenderingPipeline. Requesting default-framebuffer
    // MSAA as well would pay for samples that the composer never reads.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.info.autoReset = false;
    this.maxPixelRatio = Math.min(window.devicePixelRatio, q.pixelRatioCap);
    this.dynPixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.dynPixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The shared uniform objects start on 1px neutral textures and swap to the
    // device-native KTX2 transcodes in place, so already-compiled city shaders
    // do not stall for a second compilation when the atlases become ready.
    void materialLibrary.initialize(this.renderer, q.level);
    this.authoredShadowMapSize = q.shadowMapSize;
    this.authoredLoadRadius = q.loadRadius;
    this.tileWorkerCount = q.tileWorkers;
    const authoredEffects: 0 | 1 | 2 = q.level === 'low' ? 0 : q.level === 'medium' ? 1 : 2;
    this.qualityGovernor = new QualityGovernor({
      targetFrameMs: 1000 / runtimeProfile.targetFps,
      minRenderScale: runtimeProfile.minRenderScale,
      minPopulationScale: runtimeProfile.minPopulationScale,
      minDetailDistanceScale: runtimeProfile.minDetailDistanceScale,
      minStreamingScale: runtimeProfile.minStreamingScale,
    }, {
      effectsLevel: authoredEffects,
      shadowLevel: q.shadows ? 2 : 0,
    });
    this.gpuTimer = new WebGLGpuTimer(this.renderer.getContext());
    if (q.shadows) {
      this.renderer.shadowMap.enabled = true;
      // PCF on the low-memory tiers: soft PCF costs a 4x wider kernel for a
      // blur that a 1536 map does not have the resolution to justify.
      this.renderer.shadowMap.type = q.shadowMapSize >= 2048 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    }

    // Keep indoor and outdoor probes separate. A studio RoomEnvironment makes
    // subway steel legible, but produces implausible rectangular highlights on
    // street glass. The outdoor PMREM mirrors the visible sun/sky/ground and is
    // generated only once, not rendered every frame.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
    pmrem.dispose();
    this.streetEnvTex = makeOutdoorEnvironment(this.renderer);
    this.streetScene.environment = this.streetEnvTex;
    this.streetScene.environmentIntensity = q.level === 'low' ? 0.4 : 0.56;

    // Draw distance, streaming radius and worker count all come from the tier
    // now, not from a UA regex: a recent tablet earns more of them than a
    // touch-capable laptop on integrated graphics does.
    const far = q.farPlane;
    const loadRadius = q.loadRadius;
    this.baseLoadRadius = loadRadius;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, far);
    this.rendering = new RenderingPipeline(
      this.renderer,
      this.streetScene,
      this.camera,
      q.level,
      authoredEffects,
    );
    this.skyDome = setupSky(this.streetScene, loadRadius, far);
    this.sun = setupLights(this.streetScene).sun;

    this.tiles = new TileManager(this.streetScene, q.tileWorkers, (g) => this.compileGroup(g));
    this.tiles.loadRadius = loadRadius;
    this.tiles.unloadRadius = this.tiles.loadRadius + 300;
    this.streetLife = new StreetLife(this.streetScene, q.level);
    this.entrances = new EntranceManager(
      this.streetScene,
      // OSM entrance points often sit in the roadway (Columbus Circle's island
      // entrances, wide-avenue corners) or against a wall. Clear the WHOLE kiosk
      // + stair-pit footprint off the lane and never phase it into a building.
      (x, z) => this.resolveFootprint(x, z, ENTRANCE_FP),
      (x, z) => nearestWallDir(x, z, 15, this.tiles.collisionNear(x, z)),
      // pre-warm the kit's shaders off the render frame before it's revealed
      (g) => this.compileGroup(g),
    );
    // road-clearance callback: landmark props (Times Square billboard masts)
    // that bake into a roadbed get nudged onto the sidewalk; null defers a
    // road-sensitive landmark until its tiles load
    this.landmarks = new LandmarkManager(
      this.streetScene,
      (x, z, clearance) => this.ejectFromRoads(x, z, clearance),
      // pre-warm each bespoke landmark's shaders off the render frame (they
      // introduce new materials — bronze glass, curtain wall — that otherwise
      // compile in the first frame that shows them)
      (g) => this.compileGroup(g),
    );
    // a landmark that builds OVER an already-placed street kit (subway
    // entrance half-inside the Times Square billboard block) evicts it; the
    // managers re-place it next tick, and their eject callbacks now see the
    // landmark's collision, so the kit re-seats outside the walls
    this.landmarks.onBuilt = (_id, x0, z0, x1, z1) => {
      const PAD = 6; // kits eject with their own clearance; a small pad catches edge-sitters
      this.entrances.evictWithin(x0 - PAD, z0 - PAD, x1 + PAD, z1 + PAD);
      this.bikes.evictWithin(x0 - PAD, z0 - PAD, x1 + PAD, z1 + PAD);
      this.buses.evictStopsWithin(x0 - PAD, z0 - PAD, x1 + PAD, z1 + PAD);
    };
    this.bikes = new BikeManager(
      this.streetScene,
      // Citi Bike station coordinates often land in the roadbed (docks are
      // curbside but the source point can fall mid-avenue). Clear the whole ~14.5m
      // rack footprint off the lane and off the building.
      (x, z) => this.resolveFootprint(x, z, DOCK_FP),
      // Orient the rack along the CURB (nearest vehicular ribbon), not just the
      // nearest wall: ~half of docks sit in plazas/greenways with no building
      // within 15m, where a wall-or-random angle used to swing the long rack
      // across the roadway. Running it parallel to the street is what keeps a
      // 14.5m rack out of the lane (the footprint eject then only trims the ends).
      (x, z) => this.curbDir(x, z),
    );

    // buses: sim + culling live in BusSystem; the vehicle/stop visuals are
    // injected so the system stays compile-independent of the mesh modules
    this.buses = new BusSystem(
      this.streetScene,
      (o) => new BusModel(o, this.streetEnvTex),
      buildBusStop,
    );
    // pull each stop kit off the roadway onto the sidewalk once its tiles load
    this.buses.resolvePlacement = (x, z) => this.resolveBusStop(x, z);

    // Roosevelt Island Tramway: always-simulated shuttle, rideable both ways
    this.tram = new TramSystem(this.streetScene);

    // address plaques: numbered plates on every building's street-facing wall,
    // streamed like tiles; walk up + press i for the building-info modal
    this.plaques = new PlaqueManager(this.streetScene, (g) => this.compileGroup(g));

    this.controls = new PlayerControls(canvas);
    this.controls.onToggleFly = () => {
      if (this.riding || this.mode === 'bus') return; // dock the bike / step off first
      this.controls.fly = !this.controls.fly; // allowed everywhere (rescue hatch in stations)
    };
    this.controls.onAction = () => this.tryAction();
    this.controls.onInfo = () => this.tryInfo();

    // water plane: animated waves + fresnel (subdivided so lighting varies)
    const waterKit = makeWaterMaterial(SKY.fog.clone());
    this.waterUpdate = waterKit.update;
    const water = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000, 1, 1), waterKit.mat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.7;
    this.streetScene.add(water);

    this.resize();
    window.addEventListener('resize', this.resize);
    this.restore();
  }

  /**
   * Pre-warm a freshly-built group's shader programs OFF the render frame, so
   * the streaming manager can add it to the scene without the first-visible
   * frame hitching. The first frame a new material combo becomes visible
   * otherwise triggers a synchronous GL program link inside renderer.render() —
   * measured at ~82ms for the opening ring of tiles and ~52ms per bespoke
   * landmark, then 0.5ms forever after (programs are cached for the session).
   * That one-frame compile spike, invisible to the 0.5s-averaged FPS meter, is
   * the "stutter into new areas, smooth on the way back" the user reported.
   *
   * compileAsync links on the driver thread via KHR_parallel_shader_compile and
   * resolves when ready; the caller adds the group only then. Compiled against
   * streetScene (as targetScene) so the program permutation — lights, fog,
   * environment, shadows — matches the one the real render uses, so there is no
   * second compile at draw time. Never throws: a compile failure degrades to the
   * caller adding the group uncompiled (at worst one legacy hitch), never a hole.
   */
  private async compileGroup(group: THREE.Object3D): Promise<void> {
    try {
      await this.rendering.compileAsync(group, this.camera, this.streetScene);
    } catch {
      /* ignore — caller still adds the group; worst case one first-frame hitch */
    }
  }

  get controlsRef() { return this.controls; }

  async init() {
    const results = await Promise.allSettled([
      loadTerrain(),
      this.loadNetwork(),
      this.tiles.init(),
      this.entrances.init(),
      this.plaques.init(),
      this.bikes.init(),
      this.loadHoods(),
      this.loadGround(),
      this.loadSkyline(),
      // must settle before the first step(): sign textures bake lazily from
      // update() and a canvas drawn pre-webfont keeps the fallback for good
      loadSans(),
      this.buses.init(), // optional like the subway network — keep last (indexes below)
    ]);
    results.shift(); results.shift(); // terrain/network optional; index 0 = tiles below
    const tileFail = results[0].status === 'rejected';
    if (tileFail) {
      this.hud.error = 'Map tiles not found. Run `npm run data:all` to build Manhattan, then reload.';
    }
    this.hud.loading = false;
    this.pushHud();
    this.clock.start();
    this.loop();

    // Fallback ticker for environments that suspend rAF (embedded/hidden panes).
    // Opt-in via ?tick=1 — real browsers drive everything from rAF.
    if (new URLSearchParams(location.search).has('tick')) {
      this.tickInterval = window.setInterval(() => {
        if (performance.now() - this.lastRaf > 300) this.step();
      }, 50);
    }

    // deep-link: ?station=<name or gtfs id> jumps straight into a station interior
    const params = new URLSearchParams(location.search);
    const q = params.get('station');
    if (q) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const spec = this.entrances.findStation((s) => s.id.toLowerCase() === q.toLowerCase())
        ?? this.entrances.findStation((s) => norm(s.name).includes(norm(q)));
      if (spec) this.enterStation(spec, spec.pos);
    }

    // deep-link: ?landmark=<id or name> opens the same safe, framed presentation
    // used by "Jump to…" for fast QA. Do not force helicopter mode here: doing
    // so bypassed spawnResolve and left y=0 at the raw landmark anchor — exactly
    // inside the premium build that this route is meant to inspect.
    const lm = params.get('landmark');
    if (lm) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const entry = LANDMARKS_REG.find((l) => l.id.toLowerCase() === lm.toLowerCase())
        ?? LANDMARKS_REG.find((l) => norm(l.name).includes(norm(lm)));
      if (entry) {
        this.teleport(entry.lat, entry.lon, entry.id);
      }
    }

    // deep-link: shared views from the share button (see shareLink()) — exact
    // camera, then whichever transit context the sharer was in
    const look = params.get('look');
    if (look) {
      const [ly, lp] = look.split(',').map(Number);
      if (Number.isFinite(ly)) this.controls.yaw = (ly * Math.PI) / 180;
      if (Number.isFinite(lp)) this.controls.pitch = Math.max(-1.45, Math.min(1.45, (lp * Math.PI) / 180));
    }
    if (!q && !lm) {
      const rideQ = params.get('ride');
      const busQ = params.get('bus');
      const atQ = params.get('at');
      if (rideQ) {
        this.restoreRideLink(rideQ);
      } else if (busQ) {
        void this.restoreBusLink(busQ);
      } else if (atQ) {
        const [la, lo] = atQ.split(',').map(Number);
        if (Number.isFinite(la) && Number.isFinite(lo)) {
          const [x, z] = lonLatToXZ(lo, la);
          const altS = params.get('alt');
          const alt = altS === null ? NaN : Number(altS);
          this.pos.set(x, Number.isFinite(alt) ? alt : heightAt(x, z), z);
          this.spawnResolve = false; // an exact shared spot — restore it verbatim
          const m = params.get('mode');
          if (m === 'fly') this.controls.fly = true;
          else if (m === 'bike') this.setRiding(true);
          this.save();
        }
      }
    }
  }

  /** Absolute URL that restores this exact view: position, camera, and the
   *  transit context (station, mid-segment subway ride, or the precise bus
   *  run). The share button copies this. */
  shareLink(): string {
    const p = new URLSearchParams();
    const yaw = (((this.controls.yaw * 180) / Math.PI) % 360).toFixed(1);
    const pitch = ((this.controls.pitch * 180) / Math.PI).toFixed(1);
    p.set('look', `${yaw},${pitch}`);
    if (this.mode === 'ride' && this.ride) {
      const s = this.ride.shareInfo;
      p.set('ride', `${s.route}.${s.dirSign === 1 ? 'u' : 'd'}.${s.originId}.${s.prog.toFixed(2)}`);
    } else if (this.mode === 'bus' && this.busRide && !this.ridingTram) {
      const b = this.buses.rideShare;
      if (b) p.set('bus', `${b.route}.${b.dirIdx}.${b.k}.${b.tau}`);
    } else if (this.mode === 'station' && this.currentStationSpec) {
      p.set('station', this.currentStationSpec.id);
    } else {
      // street / fly / bike / on a rooftop — the tram degrades to its street
      // position (its cabins aren't addressable by a stable key)
      const lat = (ORIGIN.lat - this.pos.z / M_PER_DEG_LAT).toFixed(6);
      const lon = (ORIGIN.lon + this.pos.x / M_PER_DEG_LON).toFixed(6);
      p.set('at', `${lat},${lon}`);
      const g = heightAt(this.pos.x, this.pos.z);
      if (this.controls.fly) {
        p.set('mode', 'fly');
        p.set('alt', this.pos.y.toFixed(1));
      } else if (this.riding) {
        p.set('mode', 'bike');
      } else if (this.pos.y - g > 2) {
        p.set('alt', this.pos.y.toFixed(1)); // standing on a rooftop
      }
    }
    return `${location.origin}/?${p.toString()}`;
  }

  /** Google Maps pin at the current spot (street mode, incl. bike and fly). */
  mapsLink(): string | null {
    if (this.mode !== 'street') return null;
    const [lon, lat] = xzToLonLat(this.pos.x, this.pos.z);
    return googleMapsUrl(lat, lon);
  }

  /**
   * Street View URL for (x,z) facing headingDeg (compass, 0=north) at tiltDeg
   * (measured from nadir: 90=level, >90=up). Shared by the HUD button (player
   * position + gaze) and the building-info modal (a plaque's own position +
   * facade-facing heading).
   *
   * The viewpoint snaps to the nearest vehicular centerline (within 30m): the
   * panoramas were shot from the roadway, and our stylized street widths mean
   * a game-world point can project to a spot inside the real building line,
   * where Google's nearest-pano pick is often an indoor/plaza photosphere with
   * an uncalibrated compass. Centerlines are true OSM geometry, so snapping
   * lands on the road imagery. The URL is the exact camera form Maps itself
   * emits (…/@lat,lng,3a,{fov}y,{heading}h,{tilt}t) — unlike the documented
   * api=1 pano action, it reliably honors the camera after snapping.
   */
  private streetViewUrl(x: number, z: number, headingDeg: number, tiltDeg: number): string {
    let sx = x, sz = z, bestD2 = 30 * 30;
    for (const rp of this.tiles.roadPathsNear(x, z, 1)) {
      const roadCount = rp.start.length - 1;
      for (let r = 0; r < roadCount; r++) {
        if (rp.kind[r] !== PATH_KIND_ROAD) continue;
        const a = rp.start[r], b = rp.start[r + 1];
        for (let j = a; j < b - 1; j++) {
          const x1 = rp.pts[j * 2], z1 = rp.pts[j * 2 + 1];
          const x2 = rp.pts[(j + 1) * 2], z2 = rp.pts[(j + 1) * 2 + 1];
          const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
          if (l2 < 1e-6) continue;
          let t = ((x - x1) * dx + (z - z1) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = x1 + t * dx, pz = z1 + t * dz;
          const d2 = (x - px) ** 2 + (z - pz) ** 2;
          if (d2 < bestD2) { bestD2 = d2; sx = px; sz = pz; }
        }
      }
    }
    const [lon, lat] = xzToLonLat(sx, sz);
    return (
      `https://www.google.com/maps/@${lat.toFixed(6)},${lon.toFixed(6)},3a,75y,` +
      `${headingDeg.toFixed(1)}h,${tiltDeg.toFixed(1)}t/data=!3m1!1e1`
    );
  }

  /**
   * Google Street View from the current spot and gaze. Compass heading comes
   * from the horizontal facing (yaw 0 = north = -z). While flying this anchors
   * to the ground below with a level gaze: panoramas only exist at street
   * level, and a bird's-eye pitch aimed at the pavement would show nothing.
   */
  streetViewLink(): string | null {
    if (this.mode !== 'street') return null;
    const { fwd } = this.controls.basis();
    let heading = (Math.atan2(fwd.x, -fwd.z) * 180) / Math.PI;
    if (heading < 0) heading += 360;
    const pitch = this.controls.fly
      ? 0
      : Math.max(-85, Math.min(85, (this.controls.pitch * 180) / Math.PI));
    return this.streetViewUrl(this.pos.x, this.pos.z, heading, 90 + pitch);
  }

  /**
   * Street View facing a building's own street-facing wall (used by the info
   * modal, so the shot always shows the facade regardless of where the player
   * was standing when they opened it). `outwardBearingDeg` is a plaque's
   * baked facing angle — atan2(nz,nx) of the wall's outward normal, the same
   * convention PlaqueManager uses to orient the plate — so the camera looks
   * the opposite way, back at the wall: heading = outward + 180, converted
   * from that math angle to compass via the same +90 offset streetViewLink
   * uses for the player's facing.
   */
  streetViewLinkForPlaque(x: number, z: number, outwardBearingDeg: number): string {
    const heading = ((outwardBearingDeg - 90) % 360 + 360) % 360;
    return this.streetViewUrl(x, z, heading, 90);
  }

  /** Restore a shared mid-ride subway view: `<route>.<u|d>.<originStop>.<prog>`. */
  private restoreRideLink(spec: string) {
    const m = spec.match(/^([A-Za-z0-9]+)\.([ud])\.([^.]+)\.([\d.]+)$/);
    if (!m || !this.network) return;
    const route = m[1];
    const dirSign: 1 | -1 = m[2] === 'u' ? 1 : -1;
    const originId = m[3];
    const prog = Math.min(0.99, Number(m[4]) || 0);
    if (!this.network.routes[route]?.stops.includes(originId)) return;
    // seed the station context so stepping off returns somewhere sensible
    const stSpec = this.entrances.stationsMap.get(originId);
    if (stSpec) {
      const ent = this.entrances.entranceFor(stSpec);
      this.returnPos.set(ent[0] + 2.2, 0, ent[1] + 2.2);
      this.currentStationSpec = stSpec;
    }
    this.ride = new RideWorld(route, dirSign, originId, this.network, this.entrances.stationsMap, this.envTex);
    this.ride.jumpTo(prog);
    this.mode = 'ride';
    this.pos.set(0, 0, 0);
    this.hud.mode = 'ride';
    this.lastEnterGuard = performance.now();
    this.pushHud();
  }

  /** Restore a shared bus ride: `<routeId>.<dirIdx>.<k>.<tau>`. */
  private async restoreBusLink(spec: string) {
    const m = spec.match(/^([A-Za-z0-9+-]+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return;
    const h = this.buses.restoreRide(m[1], Number(m[2]), Number(m[3]), Number(m[4]));
    if (h) await this.enterTransit(h, false);
  }

  private async loadNetwork() {
    try {
      const res = await fetch(dataUrl('/subway/network.json'));
      if (res.ok) this.network = (await res.json()) as NetworkData;
    } catch { /* riding disabled without network data */ }
  }

  private async loadHoods() {
    try {
      const res = await fetch(dataUrl('/geo/hoods.json'));
      if (!res.ok) return;
      const json = await res.json();
      this.hoods = (json.hoods as { n: string; rings: number[][] }[]).map((h) => {
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const ring of h.rings) {
          for (let i = 0; i < ring.length; i += 2) {
            if (ring[i] < minX) minX = ring[i];
            if (ring[i] > maxX) maxX = ring[i];
            if (ring[i + 1] < minZ) minZ = ring[i + 1];
            if (ring[i + 1] > maxZ) maxZ = ring[i + 1];
          }
        }
        return { ...h, bbox: [minX, minZ, maxX, maxZ] as [number, number, number, number] };
      });
    } catch { /* label falls back to "Manhattan" */ }
  }

  /**
   * Building collision around (x,z): baked tile footprints plus the coarse
   * packs of any active premium landmarks (which replace cleared massing).
   */
  private colNear(x: number, z: number) {
    const sets = this.tiles.collisionNear(x, z);
    const lm = this.landmarks.collisionNear(x, z);
    return lm.length ? sets.concat(lm) : sets;
  }

  /**
   * Street at (x,z) plus its nearest cross street: nearest street centerline
   * within its ribbon (+ a sidewalk margin), named by the surrounding corner
   * signs — each sign blade carries a street name and that street's bearing.
   * The blade whose line best passes through the player, running PARALLEL to
   * the road they're on, is the street they're standing on; the nearest
   * corner's CROSSING blade names the cross street ("Broadway / W 72 St").
   */
  private streetAt(x: number, z: number): { street: string | null; cross: string | null } {
    const paths = this.tiles.roadPathsNear(x, z, 1);
    let best = Infinity; // distance beyond acceptance, for tie-breaks
    let tanX = 0, tanZ = 0;
    for (const rp of paths) {
      const roadCount = rp.start.length - 1;
      for (let r = 0; r < roadCount; r++) {
        if (rp.kind[r] !== PATH_KIND_ROAD) continue; // bike lanes don't name streets
        const allow = rp.width[r] * 0.5 + 6; // ribbon + sidewalk margin
        const a = rp.start[r], b = rp.start[r + 1];
        for (let j = a; j < b - 1; j++) {
          const x1 = rp.pts[j * 2], z1 = rp.pts[j * 2 + 1];
          const x2 = rp.pts[(j + 1) * 2], z2 = rp.pts[(j + 1) * 2 + 1];
          const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
          if (l2 < 1e-6) continue;
          let t = ((x - x1) * dx + (z - z1) * dz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz)) - allow;
          if (d < best) { best = d; tanX = dx; tanZ = dz; }
        }
      }
    }
    if (best > 0) return { street: null, cross: null }; // not on/near any street
    const roadAng = Math.atan2(tanZ, tanX);
    let bestScore = Infinity;
    let name: string | null = null;
    let bestCrossD = Infinity;
    let cross: string | null = null;
    for (const s of this.tiles.signsNear(x, z)) {
      const dSign = Math.hypot(s.x - x, s.z - z);
      if (dSign > 170) continue;
      for (let b = 0; b < s.names.length; b++) {
        const blade = ((s.angles[b] ?? 0) * Math.PI) / 180;
        // parallel-ness to the road under the player (mod 180°)
        let dAng = Math.abs(roadAng - blade) % Math.PI;
        if (dAng > Math.PI / 2) dAng = Math.PI - dAng;
        if (dAng <= 0.55) { // ~31°: runs with our street — candidate for its name
          // perpendicular distance from the player to the blade's street line
          const px = x - s.x, pz = z - s.z;
          const perp = Math.abs(px * -Math.sin(blade) + pz * Math.cos(blade));
          const score = perp + dSign * 0.18 + dAng * 12;
          if (score < bestScore) { bestScore = score; name = s.names[b]; }
        } else if (dAng >= 0.9 && dSign < bestCrossD) {
          // ≥ ~52°: a street CROSSING ours — the nearest corner names it
          bestCrossD = dSign;
          cross = s.names[b];
        }
      }
    }
    if (cross !== null && cross === name) cross = null;
    return { street: name, cross };
  }

  /** Neighborhood containing (x,z) — even-odd over all rings, so holes work. */
  private hoodAt(x: number, z: number): string | null {
    if (!this.hoods) return null;
    for (const h of this.hoods) {
      const [minX, minZ, maxX, maxZ] = h.bbox;
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      let inside = false;
      for (const ring of h.rings) {
        const n = ring.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = ring[i * 2], zi = ring[i * 2 + 1];
          const xj = ring[j * 2], zj = ring[j * 2 + 1];
          if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
      }
      if (inside) return h.n;
    }
    return null;
  }

  private async loadGround() {
    // ground.bin (v3): welded vertices in integer decimeters + delta-coded
    // indices. See encodeGroundBin in scripts/build-tiles.mjs. Decoding is a
    // typed-array view plus one expand loop — no JSON.parse of ~1M vertices.
    const res = await fetch(dataUrl('/geo/ground.bin'));
    if (!res.ok) throw new Error('no ground');
    const buf = await res.arrayBuffer();
    const head = new DataView(buf);
    if (head.getUint32(0, true) !== 0x4743594e) throw new Error('ground.bin: bad magic');
    if (head.getUint32(4, true) !== 3) throw new Error('ground.bin: unsupported version');
    const unique = head.getUint32(8, true);
    const vcount = head.getUint32(12, true);
    let o = 16;
    const vx = new Int32Array(buf, o, unique); o += unique * 4;
    const vz = new Int32Array(buf, o, unique); o += unique * 4;
    const vy = new Int16Array(buf, o, unique); o += unique * 2;
    o = (o + 3) & ~3;
    const deltas = new Int32Array(buf, o, vcount);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(vcount * 3);
    // re-expand to the same non-indexed vertex order the mesh had as JSON, so
    // computeVertexNormals below still yields per-face (flat) terrain shading
    for (let i = 0, cur = 0; i < vcount; i++) {
      cur += deltas[i];
      pos[i * 3] = vx[cur] / 10;
      pos[i * 3 + 1] = vy[cur] / 10;
      pos[i * 3 + 2] = vz[cur] / 10;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // fix winding per-triangle for +y and set normals up
    const idx: number[] = [];
    for (let t = 0; t < vcount / 3; t++) {
      const a = t * 3, b = t * 3 + 1, c = t * 3 + 2;
      const cross = (pos[b * 3 + 2] - pos[a * 3 + 2]) * (pos[c * 3] - pos[a * 3])
        - (pos[b * 3] - pos[a * 3]) * (pos[c * 3 + 2] - pos[a * 3 + 2]);
      if (cross < 0) idx.push(a, c, b); else idx.push(a, b, c);
    }
    geo.setIndex(idx);
    // real normals so hills shade
    geo.computeVertexNormals();
    // every ground vertex carried the same colour, so a vertex-colour buffer
    // here was ~12MB of identical floats — the flat material's grass detail is
    // worldspace and unaffected. (TileManager's areas DO vary per vertex.)
    const mat = makeFlatMaterial();
    mat.vertexColors = false;
    mat.color.copy(SKY.ground);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -3;
    mesh.receiveShadow = true;
    this.streetScene.add(mesh);
  }

  private async loadSkyline() {
    const res = await fetch(dataUrl('/tiles/skyline.json'));
    if (!res.ok) throw new Error('no skyline');
    const data = await res.json();
    const mat = makeSkylineMaterial(SKY.fog.clone());
    const positions: number[] = [];
    const indices: number[] = [];
    for (const b of data.b as { p: number[]; h: number; m: number; g?: number }[]) {
      const ring: number[] = b.p;
      const n = ring.length / 2;
      if (n < 3) continue;
      // silhouette layer: extend parts to the ground (overdraw is invisible,
      // and it prevents floating slabs when a part's base is below the cutoff)
      const ground = (b as { g?: number }).g ?? 0;
      const y0 = ground - 3, y1 = ground + b.h;
      const base = positions.length / 3;
      for (let i = 0; i < n; i++) {
        positions.push(ring[i * 2], y0, ring[i * 2 + 1]);
        positions.push(ring[i * 2], y1, ring[i * 2 + 1]);
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = base + i * 2, bIdx = base + j * 2;
        indices.push(a, bIdx, a + 1, a + 1, bIdx, bIdx + 1);
      }
      // roof fan
      const roofBase = positions.length / 3;
      for (let i = 0; i < n; i++) positions.push(ring[i * 2], y1, ring[i * 2 + 1]);
      for (let i = 1; i < n - 1; i++) indices.push(roofBase, roofBase + i, roofBase + i + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -2;
    (mat as THREE.Material).depthWrite = false;
    mesh.frustumCulled = false;
    this.streetScene.add(mesh);
  }

  private resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(this.dynPixelRatio); // keep the adaptive scale across resizes
    this.renderer.setSize(w, h, false);
    this.rendering.setSize(w, h, this.dynPixelRatio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  teleport(lat: number, lon: number, landmarkId: string | null = null) {
    if (this.transitioning) return; // mid fade/exit — ignore rather than corrupt state
    this.leaveTransit();            // abandon any train/bus/tram/bike so `pos` takes effect
    // "Jump to…" is a street-level presentation arrival from every mode.
    // Leaving transit already clears vehicles, but helicopter is a controls
    // state rather than a world mode; carrying it through skipped freeSpawn
    // and dropped the player at y=0 inside the selected building footprint.
    this.controls.fly = false;
    this.flyVel.set(0, 0, 0);
    this.flyTarget.set(0, 0, 0);
    const [x, z] = lonLatToXZ(lon, lat);
    const landmark = landmarkId ? LANDMARKS_REG.find((lm) => lm.id === landmarkId) : undefined;
    // A few supertalls are surrounded by nearly continuous block-front slabs:
    // automatic radial sampling can find a technically clear keyhole while the
    // resulting first view is still mostly neighboring walls. A surveyed
    // presentation point starts on a known-clear public path; freeSpawn below
    // still validates building clearance and frames the real landmark target.
    const hasArrival = landmark?.arrivalLat !== undefined && landmark.arrivalLon !== undefined;
    const [spawnX, spawnZ] = hasArrival
      ? lonLatToXZ(landmark.arrivalLon!, landmark.arrivalLat!)
      : [x, z];
    const hasArrivalLook = landmark?.arrivalLookLat !== undefined && landmark.arrivalLookLon !== undefined;
    const [lookX, lookZ] = hasArrivalLook
      ? lonLatToXZ(landmark.arrivalLookLon!, landmark.arrivalLookLat!)
      : [x, z];
    this.pos.set(spawnX, 0, spawnZ);
    this.spawnLookAt = { x: lookX, z: lookZ };
    this.spawnLandmarkId = landmarkId;
    this.spawnWaitStarted = performance.now();
    this.spawnResolve = true; // resolved out of any building once tiles arrive
    this.save();
  }

  /**
   * Synchronously abandon any active train / bus / tram ride (and dismount a
   * bike), dropping straight back to street mode with no fade or exit-placement.
   * "Jump to…" (teleport) must work from any mode, but the ride and bus render
   * branches pin the camera to the vehicle each frame, so moving `pos` alone is
   * ignored until we actually leave the ride.
   */
  private leaveTransit() {
    if (this.mode === 'station') { void this.exitStation(true); return; }
    if (this.ride) {
      this.ride.dispose();
      this.ride = null;
      this.hud.ride = null;
      this.atEndSince = 0;
    }
    if (this.busRide) {
      this.busRide.end();
      this.busRide = null;
      this.ridingTram = false;
      this.hud.bus = null;
      this.busEndSince = 0;
    }
    // drop a bike whether standalone or carried on a bus's front rack
    if (this.busBike) { this.busBike.removeFromParent(); disposeGroup(this.busBike); this.busBike = null; }
    this.broughtBike = false;
    if (this.riding) this.setRiding(false);
    this.mode = 'street';
    this.hud.mode = 'street';
  }

  /**
   * A standing point at/near (x,z) that is NOT inside a building. If the target
   * is already clear, just resolve grazing contact. If it is inside, project
   * directly through the nearest footprint edge first: landmark anchors often
   * sit at the center of a 70-250m building, well beyond the old 26m spiral.
   * Only fall back to the wider spiral for overlapping/nested footprints.
   */
  private freeSpawn(x: number, z: number, standOff = 0.75, preferredAngle: number | null = null): [number, number] {
    const near0 = this.colNear(x, z);
    const y0 = heightAt(x, z);
    if (!pointInBuildings(x, z, near0, y0)) return resolveBuildingCollision(x, z, 0.5, near0, y0);

    // The collision resolver already knows the exact polygon edges, so this is
    // both closer and much cheaper than sampling every few metres from a large
    // building's center (AMNH is ~267x237m; New York Life is ~70m wide). Repeat
    // until stable because a multi-volume landmark can push out of one ring and
    // into the clearance band of another later in the same resolver pass.
    const settle = (sx: number, sz: number): [number, number] | null => {
      let px = sx, pz = sz;
      for (let pass = 0; pass < 10; pass++) {
        const py = heightAt(px, pz);
        const near = this.colNear(px, pz);
        const [nx, nz] = resolveBuildingCollision(px, pz, standOff, near, py);
        const moved2 = (nx - px) ** 2 + (nz - pz) ** 2;
        px = nx; pz = nz;
        if (moved2 < 0.01) {
          const finalY = heightAt(px, pz);
          return pointInBuildings(px, pz, this.colNear(px, pz), finalY) ? null : [px, pz];
        }
      }
      return null;
    };

    // Menu jumps should PRESENT a building, not merely eject to the closest
    // courtyard or service slot. Estimate the containing massing's reach from
    // its collision AABBs, then look for a clearance-stable point just beyond
    // it. Small buildings land across the street; campus-sized landmarks such
    // as AMNH land beyond the whole complex (typically in Central Park).
    if (standOff >= 4) {
      let reach = 0;
      for (const set of near0) {
        const n = set.ringStart.length - 1;
        for (let i = 0; i < n; i++) {
          if (y0 + 1.75 <= set.base[i] || y0 >= set.top[i] - 0.6) continue;
          const x0 = set.aabb[i * 4], z0 = set.aabb[i * 4 + 1];
          const x1 = set.aabb[i * 4 + 2], z1 = set.aabb[i * 4 + 3];
          if (x < x0 || x > x1 || z < z0 || z > z1) continue;
          reach = Math.max(reach, x - x0, x1 - x, z - z0, z1 - z);
        }
      }
      const targetRoof = roofBelow(x, z, 1200, near0) ?? 0;
      // A human-scale facade needs a street-width stand-off; a 200m tower needs
      // roughly a block so its base and crown fit in the same first view.
      const firstRing = Math.max(32, Math.min(210, Math.max(reach + 24, targetRoof * 0.72)));
      const hostRings = buildingRingsAt(x, z, near0, y0);
      for (let ring = firstRing; ring <= Math.min(210, firstRing + 48); ring += 16) {
        const samples = Math.max(28, Math.ceil((Math.PI * 2 * ring) / 12));
        let best: [number, number] | null = null, bestScore = Infinity;
        for (let a = 0; a < samples; a++) {
          const ang = (a / samples) * Math.PI * 2;
          const tx = x + Math.cos(ang) * ring, tz = z + Math.sin(ang) * ring;
          const candidate = settle(tx, tz);
          if (!candidate) continue;
          // Trees are intentionally passable world detail, so collision alone
          // cannot tell that this "safe" point puts the first-person camera
          // inside opaque leaves. TileManager retains the already-streamed
          // five-float tree records specifically for this teleport-only test.
          if (this.tiles.treeCanopyNear(candidate[0], candidate[1])) continue;
          const dist = Math.hypot(candidate[0] - x, candidate[1] - z);
          if (dist < firstRing * 0.72) continue;

          // Prefer an unobstructed presentation axis. Ignore only the exact
          // host rings, not their entire tile collision pack: one pack can hold
          // scores of unrelated buildings, and ignoring all of it let a same-
          // tile tower completely block the selected landmark.
          let blocked = 0;
          const vx = (x - candidate[0]) / dist, vz = (z - candidate[1]) / dist;
          // A single center ray can thread a meter-wide slot between two slabs
          // and call the tower "visible" even though both screen edges are
          // filled by foreground buildings. Trace the center plus rays toward
          // the landmark's left/right facade edges; the edge separation grows
          // toward the target like a real view cone. This rejects canyon
          // keyholes while remaining a cheap, menu-jump-only test.
          const edgeHalf = Math.min(18, Math.max(6, targetRoof * 0.03));
          const sideX = -vz, sideZ = vx;
          for (const edge of [-1, 0, 1]) {
            for (let along = 10; along < dist - 10; along += 10) {
              const spread = edge * edgeHalf * (along / dist);
              const sx = candidate[0] + vx * along + sideX * spread;
              const sz = candidate[1] + vz * along + sideZ * spread;
              const sy = heightAt(sx, sz);
              if (pointInBuildingsExcept(sx, sz, this.colNear(sx, sz), hostRings, sy)) blocked++;
            }
          }
          // A few landmarks have a documented presentation axis because an
          // elevated/passable structure is visually opaque but deliberately
          // absent from collision (Park Avenue's viaduct by Chrysler). Keep
          // occlusion dominant, then prefer that bearing among equally clear
          // and equally distant street points.
          const angleDelta = preferredAngle === null
            ? 0
            : Math.abs(Math.atan2(Math.sin(ang - preferredAngle), Math.cos(ang - preferredAngle)));
          const score = blocked * 10000 + angleDelta * 100 + Math.abs(dist - ring);
          if (score < bestScore) { bestScore = score; best = candidate; }
        }
        if (best) return best;
      }
    }

    const projected = settle(x, z);
    if (projected) return projected;

    for (let ring = 4; ring <= 160; ring += 4) {
      const samples = Math.max(20, Math.ceil((Math.PI * 2 * ring) / 8));
      for (let a = 0; a < samples; a++) {
        const ang = (a / samples) * Math.PI * 2;
        const tx = x + Math.cos(ang) * ring, tz = z + Math.sin(ang) * ring;
        const near = this.colNear(tx, tz);
        const ty = heightAt(tx, tz);
        if (!pointInBuildings(tx, tz, near, ty)) {
          const candidate = settle(tx, tz);
          if (candidate) return candidate;
        }
      }
    }
    return [x, z]; // fully enclosed (shouldn't happen in Manhattan) — leave as-is
  }

  /** Curb-resolve a bus stop's raw GTFS point (BUS_FP; null = defer or drop). */
  private resolveBusStop(x: number, z: number): [number, number] | null {
    return this.resolveFootprint(x, z, BUS_FP);
  }

  /**
   * Unit direction along the CURB at (x,z) — the tangent of the nearest vehicular
   * ribbon — so a bike rack runs parallel to the street. Falls back to the nearest
   * building wall, then null (BikeManager then uses a stable per-dock hash angle).
   */
  private curbDir(x: number, z: number): [number, number] | null {
    const paths = this.tiles.roadPathsNear(x, z, 1);
    let best = 45 * 45, tx = 0, tz = 0, found = false; // ignore ribbons > 45m off
    for (const rp of paths) {
      const roadCount = rp.start.length - 1;
      for (let r = 0; r < roadCount; r++) {
        if (rp.kind[r] !== PATH_KIND_ROAD) continue; // curb = vehicular street, not a bike lane
        const a = rp.start[r], b = rp.start[r + 1];
        for (let j = a; j < b - 1; j++) {
          const x1 = rp.pts[j * 2], z1 = rp.pts[j * 2 + 1];
          const x2 = rp.pts[(j + 1) * 2], z2 = rp.pts[(j + 1) * 2 + 1];
          const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
          if (l2 < 1e-6) continue;
          let t = ((x - x1) * dx + (z - z1) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ox = x - (x1 + t * dx), oz = z - (z1 + t * dz), d2 = ox * ox + oz * oz;
          if (d2 < best) { best = d2; const l = Math.sqrt(l2); tx = dx / l; tz = dz / l; found = true; }
        }
      }
    }
    if (found) return [tx, tz];
    return nearestWallDir(x, z, 15, this.tiles.collisionNear(x, z));
  }

  /** Kit-local frame at (x,z): [tx,tz] = nearest vehicular ribbon tangent (the
   *  kit's long axis), [nx,nz] = unit toward that ribbon's centerline (the road
   *  side). Bike lanes don't set the long axis; degenerate → perpendicular fallback. */
  private roadFrame(paths: RoadPaths[], x: number, z: number): [number, number, number, number] {
    let best = Infinity, tx = 1, tz = 0, cx = x, cz = z;
    for (const rp of paths) {
      const roadCount = rp.start.length - 1;
      for (let r = 0; r < roadCount; r++) {
        if (rp.kind[r] !== PATH_KIND_ROAD) continue;
        const a = rp.start[r], b = rp.start[r + 1];
        for (let j = a; j < b - 1; j++) {
          const x1 = rp.pts[j * 2], z1 = rp.pts[j * 2 + 1];
          const x2 = rp.pts[(j + 1) * 2], z2 = rp.pts[(j + 1) * 2 + 1];
          const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
          if (l2 < 1e-6) continue;
          let t = ((x - x1) * dx + (z - z1) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = x1 + t * dx, qz = z1 + t * dz, d = Math.hypot(x - qx, z - qz);
          if (d < best) { best = d; const l = Math.sqrt(l2); tx = dx / l; tz = dz / l; cx = qx; cz = qz; }
        }
      }
    }
    let nx = cx - x, nz = cz - z; const nl = Math.hypot(nx, nz);
    if (nl > 1e-6) { nx /= nl; nz /= nl; } else { nx = -tz; nz = tx; }
    return [tx, tz, nx, nz];
  }

  /**
   * Clip the broad 2-tile road query to segments that could geometrically
   * affect a local footprint solve. The old spiral tested every candidate
   * against every segment in up to 25 tiles; in dense Lower Manhattan that
   * turned one difficult entrance into a 50–115 ms main-thread task.
   */
  private localRoadPaths(paths: RoadPaths[], x: number, z: number, radius: number): RoadPaths[] {
    const pts: number[] = [];
    const start: number[] = [0];
    const width: number[] = [];
    const kind: number[] = [];
    for (const rp of paths) {
      const roadCount = rp.start.length - 1;
      for (let r = 0; r < roadCount; r++) {
        const a = rp.start[r], b = rp.start[r + 1];
        for (let j = a; j < b - 1; j++) {
          const x1 = rp.pts[j * 2], z1 = rp.pts[j * 2 + 1];
          const x2 = rp.pts[(j + 1) * 2], z2 = rp.pts[(j + 1) * 2 + 1];
          if (
            Math.max(x1, x2) < x - radius || Math.min(x1, x2) > x + radius
            || Math.max(z1, z2) < z - radius || Math.min(z1, z2) > z + radius
          ) continue;
          pts.push(x1, z1, x2, z2);
          width.push(rp.width[r]);
          kind.push(rp.kind[r]);
          start.push(start[start.length - 1] + 2);
        }
      }
    }
    if (!width.length) return paths;
    return [{
      start: Uint32Array.from(start),
      pts: Float32Array.from(pts),
      width: Float32Array.from(width),
      kind: Uint8Array.from(kind),
    }];
  }

  /** Signed clearance of a point to the nearest ribbon edge (incl. bike lanes):
   *  distance to centerline minus half-width; negative = inside that ribbon. */
  private ribbonClearance(paths: RoadPaths[], x: number, z: number): number {
    let best = Infinity;
    for (const rp of paths) {
      const roadCount = rp.start.length - 1;
      for (let r = 0; r < roadCount; r++) {
        const half = rp.width[r] * 0.5;
        const a = rp.start[r], b = rp.start[r + 1];
        for (let j = a; j < b - 1; j++) {
          const x1 = rp.pts[j * 2], z1 = rp.pts[j * 2 + 1];
          const x2 = rp.pts[(j + 1) * 2], z2 = rp.pts[(j + 1) * 2 + 1];
          const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
          if (l2 < 1e-6) continue;
          let t = ((x - x1) * dx + (z - z1) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(x - (x1 + t * dx), z - (z1 + t * dz)) - half;
          if (d < best) best = d;
        }
      }
    }
    return best;
  }

  /** True once every sample of the oriented footprint sits `pad` clear of every ribbon. */
  private footprintClear(paths: RoadPaths[], px: number, pz: number, fp: KitFootprint, frame: [number, number, number, number]): boolean {
    const [tx, tz, nx, nz] = frame, pad = fp.margin * 0.6;
    for (const [al, pe] of fpSamples(fp.hL, fp.pR)) {
      if (this.ribbonClearance(paths, px + al * tx + pe * nx, pz + al * tz + pe * nz) < pad) return false;
    }
    return true;
  }

  /** True if any footprint sample lands inside a building at street level. */
  private footprintInBuilding(px: number, pz: number, fp: KitFootprint, frame: [number, number, number, number]): boolean {
    const [tx, tz, nx, nz] = frame, sets = this.colNear(px, pz), y = heightAt(px, pz);
    for (const [al, pe] of fpSamples(fp.hL, fp.pR)) {
      if (pointInBuildings(px + al * tx + pe * nx, pz + al * tz + pe * nz, sets, y)) return true;
    }
    return false;
  }

  /**
   * True if any footprint sample lands inside a PREMIUM LANDMARK ring at street
   * level. Split from footprintInBuilding because the two read differently in
   * the world: grazing low-res tile massing is a tolerable last resort for a
   * kit, but half-sinking into a modeled landmark (the Times Square billboard
   * block, Hearst's base) is exactly the overlap bug — never acceptable.
   */
  private footprintInLandmark(px: number, pz: number, fp: KitFootprint, frame: [number, number, number, number]): boolean {
    const sets = this.landmarks.collisionNear(px, pz);
    if (!sets.length) return false;
    const [tx, tz, nx, nz] = frame, y = heightAt(px, pz);
    for (const [al, pe] of fpSamples(fp.hL, fp.pR)) {
      if (pointInBuildings(px + al * tx + pe * nx, pz + al * tz + pe * nz, sets, y)) return true;
    }
    return false;
  }

  /**
   * Push a kit's WHOLE footprint out of every roadbed ribbon (greedy on the
   * deepest-penetrating sample, iterated), so a long shelter/rack end clears a
   * crossing or curving lane — not just the anchor. `frameFixed` (bus stops) keeps
   * the kit's long axis on the serving street the raw point sits on.
   */
  private ejectFootprint(paths: RoadPaths[], x: number, z: number, fp: KitFootprint, frameFixed?: [number, number, number, number]): [number, number] {
    const samples = fpSamples(fp.hL, fp.pR);
    let px = x, pz = z;
    for (let iter = 0; iter < 12; iter++) {
      const [tx, tz, nx, nz] = frameFixed ?? this.roadFrame(paths, px, pz);
      let worst = 0, wux = 0, wuz = 0;
      for (const [al, pe] of samples) {
        const sx = px + al * tx + pe * nx, sz = pz + al * tz + pe * nz;
        for (const rp of paths) {
          const roadCount = rp.start.length - 1;
          for (let r = 0; r < roadCount; r++) {
            const target = rp.width[r] * 0.5 + fp.margin;
            const a = rp.start[r], b = rp.start[r + 1];
            for (let j = a; j < b - 1; j++) {
              const x1 = rp.pts[j * 2], z1 = rp.pts[j * 2 + 1];
              const x2 = rp.pts[(j + 1) * 2], z2 = rp.pts[(j + 1) * 2 + 1];
              const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
              if (l2 < 1e-6) continue;
              let t = ((sx - x1) * dx + (sz - z1) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
              const ox = sx - (x1 + t * dx), oz = sz - (z1 + t * dz), d = Math.hypot(ox, oz);
              const pen = target - d;
              // move the ANCHOR (so the whole footprint shifts) by this sample's escape
              if (pen > worst) { worst = pen; if (d > 1e-3) { wux = ox / d; wuz = oz / d; } else { wux = nx; wuz = nz; } }
            }
          }
        }
      }
      if (worst <= 0.02) break;
      px += wux * worst; pz += wuz * worst;
    }
    return [px, pz];
  }

  /**
   * Place a footprint-carrying kit (bus stop, subway entrance, bike dock) clear of
   * BOTH the roadway and any building. Alternating single ejects (the previous
   * approach) cleared only the ANCHOR, leaving long shelter/rack ends poking a
   * crossing lane — the Columbus Circle bug. Now:
   *  1. joint solve — alternate building-eject + whole-footprint road-eject until
   *     the anchor stops moving;
   *  2. if the footprint still isn't fully clear (a pocket between the overlapping
   *     ribbons of a traffic circle, a tight corner), SPIRAL out from the raw point
   *     for the nearest spot where the whole footprint clears, preferring one off
   *     any building but accepting a wall graze (road-clear is the priority);
   *  3. fail-safe — a footprint-only eject OUT of the lane. If it still can't seat
   *     clear and the kit is droppable (bus stops), return null so it's skipped
   *     rather than rendered in traffic.
   * Returns null while tiles here are still streaming (the readyAround/null-defer
   * contract every caller relies on) — so a dropped stop simply keeps deferring.
   */
  private resolveFootprint(x: number, z: number, fp: KitFootprint): [number, number] | null {
    if (!this.tiles.readyAround(x, z)) return null; // wait for road/building data
    // The source query stays broad enough to catch a wide avenue whose
    // centerline lies in a neighboring tile, then a conservative 96 m AABB
    // clip removes segments that cannot touch the 36 m fallback spiral.
    const paths = this.localRoadPaths(this.tiles.roadPathsNear(x, z, 2), x, z, 96);
    const frameFixed = fp.fixed ? this.roadFrame(paths, x, z) : undefined;
    // 1) joint building + whole-footprint road solve
    let px = x, pz = z;
    for (let i = 0; i < 5; i++) {
      const [bx, bz] = resolveBuildingCollision(px, pz, fp.bldgClear, this.colNear(px, pz), heightAt(px, pz));
      const [rx, rz] = this.ejectFootprint(paths, bx, bz, fp, frameFixed);
      const moved = Math.hypot(rx - px, rz - pz);
      px = rx; pz = rz;
      if (moved < 0.05) break;
    }
    // accept only if the footprint is clear of the LANE and not swallowed by a
    // building: the alternating solve can oscillate (building push out, road
    // push back in, net movement ~0) and a point fully inside a tower base is
    // trivially "road-clear" — the Hearst entrance bug. Unhealthy sites fall
    // through to the spiral, which prefers genuinely clear ground.
    const frame1 = frameFixed ?? this.roadFrame(paths, px, pz);
    if (this.footprintClear(paths, px, pz, fp, frame1) && !this.footprintInBuilding(px, pz, fp, frame1)) return [px, pz];
    // 2) spiral from the RAW point for the nearest fully-clear seat
    let clearX = 0, clearZ = 0, clearD = Infinity, hasClear = false;
    let grazeX = 0, grazeZ = 0, grazeD = Infinity, hasGraze = false;
    // 36 m radius: a full-block landmark base (Hearst) beside a wide avenue can
    // leave no legal seat within 24 m of the mapped point
    for (let ring = 1; ring <= 36 && !hasClear; ring++) {
      // About 3 m between angular probes: tighter than the stair/dock width,
      // while avoiding thousands of redundant sub-meter tests at large radii.
      const steps = Math.max(8, Math.ceil((Math.PI * 2 * ring) / 3));
      for (let a = 0; a < steps; a++) {
        const ang = (a / steps) * Math.PI * 2;
        let cx = x + Math.cos(ang) * ring, cz = z + Math.sin(ang) * ring;
        [cx, cz] = resolveBuildingCollision(cx, cz, Math.min(fp.bldgClear, 0.6), this.colNear(cx, cz), heightAt(cx, cz));
        const fr = frameFixed ?? this.roadFrame(paths, cx, cz);
        if (!this.footprintClear(paths, cx, cz, fp, fr)) continue;
        // a premium landmark is never an acceptable graze — tile massing only
        if (this.footprintInLandmark(cx, cz, fp, fr)) continue;
        const d = Math.hypot(cx - x, cz - z);
        if (this.footprintInBuilding(cx, cz, fp, fr)) {
          if (d < grazeD) { grazeD = d; grazeX = cx; grazeZ = cz; hasGraze = true; }
        } else if (d < clearD) { clearD = d; clearX = cx; clearZ = cz; hasClear = true; }
      }
    }
    if (hasClear) return [clearX, clearZ];
    if (hasGraze) return [grazeX, grazeZ];
    // 3) fail-safe: shove the footprint out of the lane, wall-graze if need be
    const [rx, rz] = this.ejectFootprint(paths, px, pz, fp, frameFixed);
    const frame3 = frameFixed ?? this.roadFrame(paths, rx, rz);
    if (fp.drop && !this.footprintClear(paths, rx, rz, fp, frame3)) {
      return null; // can't seat clear of the lane (highway/no-sidewalk pin) — skip it, don't render it in traffic
    }
    if (this.footprintInLandmark(rx, rz, fp, frame3)) {
      return null; // never seat ANY kit inside a landmark — defer instead (a late kit beats one inside Hearst's lobby)
    }
    return [rx, rz];
  }

  /**
   * Push a world point out of every nearby vehicular roadway onto the sidewalk,
   * `clearance` metres past the curb. Iterates on the deepest-penetrating ribbon
   * so a point in a two-street intersection converges to the corner. Returns
   * null when the road tiles here aren't loaded yet (caller should defer/retry).
   * Shared by bus-stop placement and the landmark road-clearance callback.
   */
  ejectFromRoads(x: number, z: number, clearance: number): [number, number] | null {
    if (!this.tiles.readyAround(x, z)) return null;
    // 2-tile radius so a wide avenue whose centerline sits in the neighbouring
    // tile still counts (a 1-tile lookup left edge stops half in the roadbed)
    const paths = this.tiles.roadPathsNear(x, z, 2);
    let px = x, pz = z;
    for (let iter = 0; iter < 6; iter++) {
      let worst = 0, wx = 0, wz = 0;
      for (const rp of paths) {
        const roadCount = rp.start.length - 1;
        for (let r = 0; r < roadCount; r++) {
          const target = rp.width[r] * 0.5 + clearance;
          const a = rp.start[r], b = rp.start[r + 1];
          for (let j = a; j < b - 1; j++) {
            const x1 = rp.pts[j * 2], z1 = rp.pts[j * 2 + 1];
            const x2 = rp.pts[(j + 1) * 2], z2 = rp.pts[(j + 1) * 2 + 1];
            const dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz;
            if (l2 < 1e-6) continue;
            let t = ((px - x1) * dx + (pz - z1) * dz) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ox = px - (x1 + t * dx), oz = pz - (z1 + t * dz);
            const pen = target - Math.hypot(ox, oz);
            if (pen > worst) { worst = pen; wx = ox; wz = oz; }
          }
        }
      }
      if (worst <= 0.02) break;
      const d = Math.hypot(wx, wz);
      if (d > 1e-3) { px += (wx / d) * worst; pz += (wz / d) * worst; } else px += worst;
    }
    return [px, pz];
  }

  private tryAction() {
    if (this.transitioning) return;
    if (this.mode === 'bus') {
      if (this.busRide?.canExit) this.exitBus();
      return;
    }
    if (this.mode === 'street') {
      const nearDock = this.bikes.nearest(this.pos.x, this.pos.z, 4.5);
      if (this.riding) {
        // roll up to an open bus/tram and it carries you AND the bike; else dock
        const bb = this.buses.boardable(this.pos.x, this.pos.z);
        if (bb) { this.boardBus(bb.key); return; }
        const tb = this.tram.boardable(this.pos.x, this.pos.z);
        if (tb) { this.boardTram(tb.key); return; }
        if (nearDock?.canDock && this.bikes.dockBike(nearDock.dock)) this.setRiding(false);
        return;
      }
      // an open bus at the curb wins: you walked to the stop for it
      const bb = this.controls.fly ? null : this.buses.boardable(this.pos.x, this.pos.z);
      if (bb) { this.boardBus(bb.key); return; }
      const tb = this.controls.fly ? null : this.tram.boardable(this.pos.x, this.pos.z);
      if (tb) { this.boardTram(tb.key); return; }
      const near = this.entrances.nearest(this.pos.x, this.pos.z, 4.5);
      const dE = near ? Math.hypot(near.pos[0] - this.pos.x, near.pos[1] - this.pos.z) : Infinity;
      if (near && dE <= (nearDock?.d ?? Infinity)) {
        this.enterStation(near.station, near.pos);
      } else if (nearDock?.canGrab && this.bikes.grab(nearDock.dock)) {
        this.setRiding(true);
        this.controls.fly = false;
      }
    } else if (this.mode === 'ride') {
      if (this.ride?.canExit) this.exitRide();
    } else if (this.station) {
      // action near an exit zone exits (y-guarded: complexes stack levels, so
      // a zone's rect may sit right above a deeper platform)
      const p = this.pos;
      for (const zn of this.station.exitZones) {
        if (p.x >= zn.minX - 2 && p.x <= zn.maxX + 2 && p.z >= zn.minZ - 2 && p.z <= zn.maxZ + 2
          && Math.abs(p.y - zn.y) < 2.4) {
          this.exitStation();
          return;
        }
      }
      // otherwise: board a dwelling train if one is open next to us
      if (this.network) {
        const b = this.stationBoardable();
        if (b && this.network.routes[b.route]) this.beginRide(b.route, b.dirSign, b.startId);
      }
    }
  }

  /** Mount / dismount: the view model, the seated eye height, and the HUD flag. */
  private setRiding(on: boolean) {
    this.riding = on;
    if (on) this.goals.onBikeMount(); // bike mount (bike-on-bus re-mount is idempotent)
    this.hud.riding = on;
    this.eyeHeight = on ? BikeView.eyeHeight : WALK_EYE;
    if (on) {
      this.bikeView ??= new BikeView();
      this.bikeView.attach(this.streetScene);
    } else {
      this.bikeView?.detach();
    }
    this.pushHud();
  }

  /** Step through the open doors of a dwelling bus. Street mode only. On a
   * bike, the bike rides mounted on the front rack and you get it back on exit. */
  private async boardBus(key: string) {
    if (this.transitioning) return;
    const h = this.buses.board(key);
    if (h) await this.enterTransit(h, false);
  }

  /** Step aboard a dwelling tram cabin (grade-level door, both sides). */
  private async boardTram(key: string) {
    if (this.transitioning) return;
    const h = this.tram.board(key);
    if (h) await this.enterTransit(h, true);
  }

  private async enterTransit(h: TransitHandle, tram: boolean) {
    const broughtBike = this.riding;
    this.transitioning = true;
    try {
      this.onFade?.(true);
      await wait(280);
      if (broughtBike) this.setRiding(false); // stow the viewmodel; remounts on exit
      this.broughtBike = broughtBike;
      this.busRide = h;
      this.ridingTram = tram;
      if (tram) this.goals.onTramBoard(); else this.goals.onBusBoard();
      this.mode = 'bus';
      this.hud.mode = 'bus';
      this.controls.fly = false;
      if (broughtBike && !tram) {
        // clamp the bike to the front rack (bus local +x, just past the bumper);
        // the tram has no rack — the bike rides "walked on" and reappears on exit
        this.busBike = buildMountedBike();
        this.busBike.position.set(6.35, 0, 0);
        h.model.group.add(this.busBike);
      }
      // start mid-cabin in the aisle, facing whatever way you were looking
      this.busLocal.set(tram ? 0.3 : 0.6, 0, 0.1);
      this.prevBusYaw = h.pos.yaw;
      // you board through the open doors — hiss them; prime the edge tracker so
      // the first frame's dwell state doesn't re-fire it
      if (!tram) this.audio.play('busDoors');
      this.prevBusHudState = h.hud.state;
      this.busEndSince = 0;
      this.lastEnterGuard = performance.now();
      this.hud.prompt = null;
      this.hud.promptRoutes = [];
      this.hud.promptBus = [];
      this.hud.promptHint = null;
      this.pushHud();
      await wait(80);
    } finally {
      this.onFade?.(false);
      this.transitioning = false;
    }
  }

  /** Step off at the current stop, onto the sidewalk by the front door. */
  private async exitBus(instant = false) {
    if ((this.transitioning && !instant) || !this.busRide) return;
    this.transitioning = true;
    try {
      if (!instant) { this.onFade?.(true); await wait(280); }
      let [ex, ez] = this.busRide.exitPos();
      this.busRide.end();
      this.busRide = null;
      this.ridingTram = false;
      this.mode = 'street';
      this.hud.mode = 'street';
      this.hud.bus = null;
      // narrow sidewalks: never step off INTO a building face
      [ex, ez] = resolveBuildingCollision(ex, ez, 0.42, this.colNear(ex, ez), heightAt(ex, ez));
      this.pos.set(ex, heightAt(ex, ez), ez);
      this.dismountBusBike(); // back on the bike if you brought one aboard
      this.spawnResolve = true; // re-eject once tiles here are fully loaded
      this.busEndSince = 0;
      this.lastEnterGuard = performance.now();
      this.pushHud();
      if (!instant) await wait(80);
    } finally {
      if (!instant) this.onFade?.(false);
      this.transitioning = false;
    }
  }

  /** Sync fallback when a ridden run ends unexpectedly: stand up where the bus was. */
  private exitBusStranded(h: TransitHandle) {
    h.end();
    this.busRide = null;
    this.ridingTram = false;
    this.mode = 'street';
    this.hud.mode = 'street';
    this.hud.bus = null;
    const [ex, ez] = resolveBuildingCollision(
      h.pos.x, h.pos.z, 0.42, this.colNear(h.pos.x, h.pos.z), heightAt(h.pos.x, h.pos.z),
    );
    this.pos.set(ex, heightAt(ex, ez), ez);
    this.spawnResolve = true; // full free-spawn pass once tiles are ready
    this.dismountBusBike();
    this.busEndSince = 0;
    this.lastEnterGuard = performance.now();
    this.pushHud();
  }

  /** Pull the bike off the front rack and put the rider back on it. */
  private dismountBusBike() {
    if (this.busBike) {
      this.busBike.removeFromParent();
      disposeGroup(this.busBike);
      this.busBike = null;
    }
    if (this.broughtBike) {
      this.broughtBike = false;
      this.setRiding(true); // remount: viewmodel + seated eye height return
    }
  }

  private async beginRide(route: string, dirSign: 1 | -1, startIdOverride?: string) {
    if (this.transitioning || !this.network || !this.currentStationSpec) return;
    // In a complex the ride starts from the GROUP the player boarded at
    // (e.g. the [7] platforms inside Times Sq), not the member station whose
    // entrance they happened to walk in through.
    const startId = startIdOverride ?? this.currentStationSpec.id;
    // Validate BEFORE the fade starts: a station can claim a route whose
    // modeled stop list doesn't actually include it (data mismatch) — starting
    // that ride would silently teleport the run to the route's first stop.
    const rStops = this.network.routes[route]?.stops;
    const si = rStops ? rStops.indexOf(startId) : -1;
    if (!rStops || si < 0) return;
    // At a terminal of the MODELED route (incl. both shuttle ends), the only
    // ride is toward the other end — otherwise the ride is born at "Last
    // stop", stuck dwelling until the auto-exit dumps the player back where
    // they started (the "boarded a downtown 1 at South Ferry" trap).
    dirSign = this.rideDirFor(route, startId, dirSign);
    this.transitioning = true;
    try {
      this.onFade?.(true);
      await wait(420);
      this.scheduler?.dispose();
      this.scheduler = null;
      this.station?.dispose();
      this.station = null;
      this.ride = new RideWorld(route, dirSign, startId, this.network, this.entrances.stationsMap, this.envTex);
      this.goals.onTrainBoard(route); // board a train (route id known here)
      this.mode = 'ride';
      this.pos.set(0, 0, 0);
      this.controls.fly = false;
      // block the walk-OFF check while the player is still holding the walk-IN key
      this.lastEnterGuard = performance.now();
      this.hud.mode = 'ride';
      this.pushHud();
      await wait(80);
    } finally {
      this.onFade?.(false);
      this.transitioning = false;
    }
  }

  private async exitRide() {
    if (this.transitioning || !this.ride) return;
    this.transitioning = true;
    try {
      this.onFade?.(true);
      await wait(420);
      const stationId = this.ride.currentStationId;
      // capture the line + direction BEFORE disposing the ride so we can re-seed
      // the train the player just rode as a doors-open dwell at this platform
      const rideRoute = this.ride.route;
      const rideDir = this.ride.shareInfo.dirSign;
      this.ride.dispose();
      this.ride = null;
      const spec = this.entrances.stationsMap.get(stationId);
      if (spec) {
        this.buildStation(spec);
        // Seed the ridden train standing at the platform, doors open, matching
        // the line + direction, so it's there to re-board for a few seconds
        // before it closes up and pulls out — instead of the track sitting empty
        // after the rebuild (the "that train disappears immediately" bug). Land
        // the player beside that seeded track; lastEnterGuard (reset below)
        // blocks an instant re-board while the seeded dwell outlives the guard.
        if (this.station instanceof ComplexStationWorld) {
          this.pos.copy(this.station.seedRideExit(stationId, rideRoute, rideDir)
            ?? this.station.platformSpawnFor(stationId));
        } else {
          this.scheduler?.seedDwell(rideRoute, rideDir);
          this.pos.copy(this.station!.platformSpawnForDir(rideDir));
        }
        // exiting the subway drops you back on the street at this station's entrance
        const ent = this.entrances.entranceFor(spec);
        this.returnPos.set(ent[0] + 2.2, 0, ent[1] + 2.2);
        this.mode = 'station';
        this.goals.onTrainWalkOff(); // stepped off inside a station — arm a transfer
        this.hud.mode = 'station';
        this.hud.stationName = this.station instanceof ComplexStationWorld ? this.station.name : spec.name;
        this.hud.stationRoutes = this.station instanceof ComplexStationWorld ? this.station.routesUnion : spec.routes;
      } else {
        this.mode = 'street';
        this.hud.mode = 'street';
        this.pos.copy(this.returnPos);
        this.spawnResolve = true;
      }
      this.hud.ride = null;
      this.lastEnterGuard = performance.now();
      this.pushHud();
      await wait(80);
    } finally {
      this.onFade?.(false);
      this.transitioning = false;
    }
  }

  private buildStation(spec: StationSpec) {
    // Station complexes with a bespoke layout (authored from the Project Subway
    // NYC drawings) build the whole multi-line complex — every member's trains
    // run on their own tracks and transfers happen inside one world.
    const cx = complexFor(spec.id);
    if (cx) {
      const world = new ComplexStationWorld(cx, this.envTex);
      world.onArrive = this.handleTrainArrive; // any group's train pulling in
      world.attachTrains(this.network);
      this.station = world;
      this.scheduler = null; // the complex owns one scheduler per track group
      this.currentStationSpec = spec;
      return;
    }
    const elevated = /elev|viaduct/i.test(spec.structure);
    this.station = elevated
      ? new ElevatedStationWorld(spec, this.envTex)
      : new StationWorld(spec, this.envTex);
    this.scheduler = new TrainScheduler(this.station.scene, spec, this.station.trackInfo, this.network);
    this.scheduler.onArrive = this.handleTrainArrive;
    // feed the platform countdown clocks: the station redraws them from this on
    // its own timer (reads the live scheduler each call, so it survives rebuilds).
    (this.station as { arrivalsFn?: () => Arrival[] }).arrivalsFn = () => this.scheduler?.arrivals() ?? [];
    this.currentStationSpec = spec;
  }

  /**
   * Direction a ride from `startId` can actually run: at the modeled route's
   * terminals (either end, incl. both shuttle ends) the only way is toward
   * the rest of the line; elsewhere the requested direction stands.
   */
  private rideDirFor(route: string, startId: string, dirSign: 1 | -1): 1 | -1 {
    const rStops = this.network?.routes[route]?.stops;
    if (!rStops) return dirSign;
    const i = rStops.indexOf(startId);
    if (i === 0) return 1;
    if (i >= 0 && i === rStops.length - 1) return -1;
    return dirSign;
  }

  /**
   * The boardable dwelling train nearest the player, unified across the two
   * station kinds: the classic single-line scheduler (track z in station
   * coords) or a complex's per-group schedulers (which report the door
   * distance and the GROUP's GTFS id — the ride must start from the group the
   * player actually boarded at, not the entrance's member station).
   */
  private stationBoardable(): { route: string; dirSign: 1 | -1; doorDist: number; startId: string } | null {
    if (this.scheduler) {
      const b = this.scheduler.boardable(this.pos.x, this.pos.z);
      if (!b || !this.currentStationSpec) return null;
      return {
        route: b.route, dirSign: b.dirSign,
        doorDist: Math.abs(this.pos.z - b.trackZ),
        startId: this.currentStationSpec.id,
      };
    }
    if (this.station instanceof ComplexStationWorld) {
      const b = this.station.boardable(this.pos.x, this.pos.y, this.pos.z);
      if (!b) return null;
      return { route: b.route, dirSign: b.dirSign, doorDist: b.doorDist, startId: b.stationId };
    }
    return null;
  }

  private async enterStation(spec: StationSpec, entrancePos: [number, number]) {
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      this.onFade?.(true);
      await wait(420);
      this.returnPos.set(entrancePos[0] + 2.2, 0, entrancePos[1] + 2.2);
      this.buildStation(spec);
      this.mode = 'station';
      this.controls.fly = false;
      // in a complex, spawn at the fare mezzanine nearest the member station
      // whose entrance we walked in through
      this.pos.copy(this.station instanceof ComplexStationWorld
        ? this.station.spawnFor(spec.id)
        : this.station!.spawn);
      this.hud.mode = 'station';
      this.hud.stationName = this.station instanceof ComplexStationWorld ? this.station.name : spec.name;
      this.hud.stationRoutes = this.station instanceof ComplexStationWorld ? this.station.routesUnion : spec.routes;
      this.lastEnterGuard = performance.now();
      this.pushHud();
      await wait(80);
    } finally {
      this.onFade?.(false);
      this.transitioning = false;
    }
  }

  private async exitStation(instant = false) {
    if (this.transitioning && !instant) return;
    this.transitioning = true;
    try {
    if (!instant) { this.onFade?.(true); await wait(420); }
    this.scheduler?.dispose();
    this.scheduler = null;
    this.station?.dispose();
    this.station = null;
    this.currentStationSpec = null;
    this.mode = 'street';
    this.goals.onStationLeave(); // out to the street — cancel any armed transfer
    this.pos.copy(this.returnPos);
    this.spawnResolve = true; // entrances sit against buildings — eject if inside one
    this.hud.mode = 'street';
    this.hud.stationName = null;
    this.hud.stationRoutes = [];
    this.lastEnterGuard = performance.now();
    this.pushHud();
    if (!instant) await wait(80);
    } finally {
      if (!instant) this.onFade?.(false);
      this.transitioning = false;
    }
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.lastRaf = performance.now();
    // A throw inside step() escapes the rAF callback entirely: the loop dies,
    // nothing repaints, and the framework's own error page replaces the app --
    // white text on black with the detail only in a console the player (on a
    // phone, especially) has no way to open. The same reasoning already guards
    // updateAudio; it applies to the whole frame.
    try {
      this.step();
    } catch (e) {
      this.onFrameError(e);
    }
  };

  private frameErrors = 0;

  /**
   * Survive a frame that threw. The first one is treated as recoverable and, if
   * we are inside a station / train / bus / tram, we bail back to the street --
   * those modes build a whole scene of their own and are where the unusual code
   * paths live, so dropping out of them clears the most likely bad state and
   * the player keeps playing. A second failure means the fault is not
   * mode-specific: stop the loop and put the real message on screen, where it
   * can be read and reported instead of vanishing into the console.
   */
  private onFrameError(e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    this.frameErrors++;
    console.error(`[world] frame error #${this.frameErrors}:`, err);
    if (this.frameErrors === 1 && this.mode !== 'street') {
      try {
        this.leaveTransit();
        this.transitioning = false;
        this.onFade?.(false);
        this.pushHud();
        return;
      } catch (e2) {
        console.error('[world] recovery failed:', e2);
      }
    }
    cancelAnimationFrame(this.raf);
    const where = (err.stack || '').split('\n').slice(1, 3).map((l) => l.trim()).join(' | ');
    this.hud.error = `Something went wrong: ${err.message}${where ? ` (${where})` : ''}`;
    this.hud.mode = 'street';
    try { this.pushHud(); } catch { /* the HUD callback is all we had left */ }
  }

  private step = () => {
    const cpuStartedAt = performance.now();
    // self-heal: if we were constructed while the window reported zero size
    // (embedded panes, background tabs), pick up the real size on first frame
    if (this.renderer.domElement.width === 0 && window.innerWidth > 0) this.resize();
    const rawDt = this.clock.getDelta();
    const dt = Math.min(0.05, rawDt);
    if (this.governorSawTransition && !this.transitioning) this.qualityGovernor.clearHistory();
    this.governorSawTransition = this.transitioning;
    const preX = this.pos.x, preZ = this.pos.z; // for the walk-bob's ground speed
    const input = this.controls.consumeInput();
    const { fwd, right } = this.controls.basis();

    // bike = 2x a full run (run = 5.2 walk x 2.1 sprint = 10.9 -> bike 21.8);
    // no sprint modifier on wheels
    const baseSpeed = this.mode === 'station' ? 3.6 : this.controls.fly ? 42 : this.riding ? 21.8 : 5.2;
    const speed = baseSpeed * (input.sprint && !this.riding ? (this.controls.fly ? 3.2 : 2.1) : 1);
    let dx = (fwd.x * input.forward + right.x * input.strafe) * speed * dt;
    let dz = (fwd.z * input.forward + right.z * input.strafe) * speed * dt;

    // Building-info reach is street-only; clear it before the mode dispatch so a
    // stale plaque prompt never lingers after entering a station/vehicle.
    this.hud.nearInfo = null;
    this.nearPlaque = null;

    if (this.mode === 'street') {
      // safe spawn: after a teleport / exit we may have landed inside a building
      // footprint (entrances hug walls, jump targets are raw lat/lon). Once the
      // tiles here have integrated, push out to the nearest sidewalk. Skip while
      // flying — the helicopter teleport lands you above the rooftops on purpose.
      const landmarkReady = !this.spawnLandmarkId
        || this.landmarks.isBuilt(this.spawnLandmarkId)
        || performance.now() - this.spawnWaitStarted > 8000;
      if (this.spawnResolve && !this.controls.fly && landmarkReady && this.tiles.readyAround(this.pos.x, this.pos.z)) {
        const lookAt = this.spawnLookAt;
        const spawnLandmark = this.spawnLandmarkId
          ? LANDMARKS_REG.find((lm) => lm.id === this.spawnLandmarkId)
          : undefined;
        const preferredAngle = spawnLandmark?.arrivalBearing ?? null;
        const [rx, rz] = this.freeSpawn(this.pos.x, this.pos.z, lookAt ? 8 : 0.75, preferredAngle);
        this.pos.x = rx; this.pos.z = rz;
        this.pos.y = heightAt(rx, rz);
        if (lookAt) {
          const dx = lookAt.x - rx, dz = lookAt.z - rz;
          if (dx * dx + dz * dz > 4) {
            // Frame the selected place from the safe view point. Aim at the
            // upper-middle of an explicit visual height (for non-solid tips) or
            // its real collision height, so towers present their complete crown
            // while a low museum/park structure stays near eye level.
            this.controls.yaw = Math.atan2(-dx, -dz);
            const targetRoof = roofBelow(lookAt.x, lookAt.z, 1200, this.colNear(lookAt.x, lookAt.z)) ?? 20;
            const aimY = spawnLandmark?.arrivalAimY ?? Math.max(12, targetRoof * 0.52);
            const horizontal = Math.hypot(dx, dz);
            this.controls.pitch = Math.max(0.08, Math.min(0.75, Math.atan2(aimY - this.pos.y - this.eyeHeight, horizontal)));
          }
        }
        this.spawnLookAt = null;
        this.spawnLandmarkId = null;
        this.spawnResolve = false;
      }
      const prevX = this.pos.x, prevZ = this.pos.z;
      if (this.controls.fly) {
        // helicopter: momentum-smoothed velocity incl. vertical
        this.flyTarget.set(
          (fwd.x * input.forward + right.x * input.strafe) * speed,
          input.up * speed * 0.55,
          (fwd.z * input.forward + right.z * input.strafe) * speed,
        );
        this.flyVel.lerp(this.flyTarget, 1 - Math.exp(-dt * 2.4));
        let fx = this.pos.x + this.flyVel.x * dt, fz = this.pos.z + this.flyVel.z * dt;
        // walls stop you at your altitude; rings you're above don't
        const nearFly = this.colNear(fx, fz);
        [fx, fz] = resolveBuildingCollision(fx, fz, 0.42, nearFly, this.pos.y);
        this.pos.x = fx; this.pos.z = fz;
        // never descend below the ground under you — terrain, or the roof of
        // whatever building you're over, so dropping out of the sky lands you
        // on top instead of falling through into the interior
        const roofFly = roofBelow(fx, fz, this.pos.y, nearFly);
        const floorY = Math.max(heightAt(fx, fz) + 1.3, roofFly ?? -Infinity);
        this.pos.y = Math.max(floorY, Math.min(1200, this.pos.y + this.flyVel.y * dt));
      } else {
        this.flyVel.set(0, 0, 0);
        let nx = this.pos.x + dx, nz = this.pos.z + dz;
        const nearWalk = this.colNear(nx, nz);
        // Walls vs roofs are decided by feet height (this.pos.y), and both tests
        // share collision.ts's ROOF_BAND so they partition cleanly:
        //  - BESIDE a building at street level (feet well below its roof) the ring
        //    is solid — pushed out, a wall you can't walk through.
        //  - ON TOP (feet within the band of the roof) the ring is passable, so
        //    you roam the whole footprint freely; roofBelow supplies the roof as
        //    the floor. Walk past the edge and no roof is under (nx,nz) any more,
        //    so g drops to the terrain/next roof and gravity eases you down.
        [nx, nz] = resolveBuildingCollision(nx, nz, 0.42, nearWalk, this.pos.y);
        const roof = roofBelow(nx, nz, this.pos.y, nearWalk);
        const g = Math.max(heightAt(nx, nz), roof ?? -Infinity);
        // one easing for everything: terrain grade, stepping up onto a roof, and
        // the smooth drop off a roof edge (streets are graded, not stepped)
        this.pos.y += (g - this.pos.y) * Math.min(1, dt * 10);
        if (Math.abs(g - this.pos.y) < 0.02) this.pos.y = g;
        this.pos.x = nx; this.pos.z = nz;
      }

      // Predictive streaming: lead the tile stream along the smoothed velocity
      // so fast movers — a bike at ~22 m/s, the helicopter at up to ~130 m/s —
      // arrive on tiles that are already resident instead of chasing the loader
      // into the fog (the nearest-first queue then also prioritizes the tiles
      // AHEAD, since distance is measured from the led center). Walking pace
      // gets no lead: the base radius already covers it. A teleport resets the
      // estimate rather than slinging the stream center across the island.
      const frameDx = this.pos.x - prevX, frameDz = this.pos.z - prevZ;
      if (dt > 0) {
        if (Math.hypot(frameDx, frameDz) > 60) {
          this.velSX = 0; this.velSZ = 0; // jump-to / station exit, not motion
        } else {
          const k = 1 - Math.exp(-dt * 1.6);
          this.velSX += (frameDx / dt - this.velSX) * k;
          this.velSZ += (frameDz / dt - this.velSZ) * k;
        }
      }
      const spd = Math.hypot(this.velSX, this.velSZ);
      const lead = spd > 7 ? Math.min(420, spd * 6) : 0; // ~6s of travel, capped
      const leadX = lead > 0 ? this.pos.x + (this.velSX / spd) * lead : this.pos.x;
      const leadZ = lead > 0 ? this.pos.z + (this.velSZ / spd) * lead : this.pos.z;

      // widen fog + streaming with altitude so flying shows more of the island
      const altBoost = Math.min(500, Math.max(0, this.pos.y - 60)) * 1.6;
      this.tiles.loadRadius = this.baseLoadRadius + altBoost;
      // + lead so the trailing edge (measured from the LED center) never
      // unloads tiles that are still within view behind the player
      this.tiles.unloadRadius = this.tiles.loadRadius + 300 + lead;
      const fog = this.streetScene.fog as THREE.Fog | null;
      if (fog) {
        fog.near = (this.baseLoadRadius + altBoost) * 0.38;
        fog.far = (this.baseLoadRadius + altBoost) * 1.18;
      }

      // Shadow coverage grows with altitude and leads along the view, so the
      // box edge stays out in the fog instead of sweeping across the city as
      // you fly (that sweep was the flicker).
      if (this.sun) followSun(this.sun, this.pos.x, this.pos.z, this.pos.y, fwd.x, fwd.z);
      this.waterUpdate?.(dt);
      // tiles + plaques stream around the led point (their unload margins beat
      // the lead); kit managers (entrances/bikes) keep the true position — their
      // evict radii are small enough that leading would despawn kits still in
      // view just behind
      this.tiles.update(leadX, leadZ, this.pos.y);
      this.updateRetailPopulationContext(dt);
      this.entrances.update(this.pos.x, this.pos.z, dt);
      this.plaques.unloadRadius = 440 + lead; // same trailing-edge guard as tiles
      this.plaques.update(leadX, leadZ, dt);
      this.bikes.update(this.pos.x, this.pos.z, dt);
      this.buses.update(this.pos.x, this.pos.z, dt);
      this.tram.update(this.pos.x, this.pos.z, dt);
      this.landmarks.update(this.pos.x, this.pos.z, dt);
      this.streetLife.update(
        this.pos.x,
        this.pos.z,
        () => this.tiles.roadPathsNear(this.pos.x, this.pos.z, 1),
        performance.now() / 1000,
      );

      if (this.riding && this.bikeView) {
        // ground speed, not input: ride into a wall and the pedals stop too
        const moved = Math.hypot(this.pos.x - prevX, this.pos.z - prevZ);
        this.bikeView.update(
          dt, moved / Math.max(dt, 1e-4), this.controls.yaw,
          this.pos.x, this.pos.y, this.pos.z, input.strafe,
        );
      }

      this.hoodTimer -= dt;
      if (this.hoodTimer <= 0) {
        this.hoodTimer = 1.0;
        this.hud.area = this.hoodAt(this.pos.x, this.pos.z);
        // street readout only while actually down on the street grid — not
        // flying, not standing on a rooftop
        const grounded = !this.controls.fly
          && this.pos.y - heightAt(this.pos.x, this.pos.z) < 3;
        const at = grounded ? this.streetAt(this.pos.x, this.pos.z) : { street: null, cross: null };
        this.hud.street = at.street;
        this.hud.cross = at.cross;
      }

      // proximity prompts. On a bike the subway is out of reach (dock first),
      // but an OPEN bus at the curb still takes you — the bike rides the front
      // rack. On foot an OPEN bus wins (it's leaving; everything else keeps),
      // then the closer of entrance/dock, then a waiting-at-the-stop readout.
      const near = this.riding ? null : this.entrances.nearest(this.pos.x, this.pos.z, 5);
      const nearDock = this.bikes.nearest(this.pos.x, this.pos.z, 4.5);
      const boardBus = this.controls.fly ? null : this.buses.boardable(this.pos.x, this.pos.z);
      const boardTram = this.controls.fly ? null : this.tram.boardable(this.pos.x, this.pos.z);
      const dE = near ? Math.hypot(near.pos[0] - this.pos.x, near.pos[1] - this.pos.z) : Infinity;
      this.hud.prompt = null;
      this.hud.promptRoutes = [];
      this.hud.promptBus = [];
      this.hud.promptHint = null;
      if (boardBus) {
        this.hud.prompt = `to ${boardBus.dest}`;
        this.hud.promptBus = [{ id: boardBus.route, color: boardBus.color, sbs: boardBus.sbs }];
        this.hud.promptHint = this.riding ? 'board, bike rides up front' : 'board the bus';
        const dDoor = Math.hypot(boardBus.door[0] - this.pos.x, boardBus.door[1] - this.pos.z);
        if (
          !this.benchmarkActive
          && dDoor < 1.7
          && performance.now() - this.lastEnterGuard > 2500
          && !this.transitioning
        ) {
          this.boardBus(boardBus.key);
        }
      } else if (boardTram) {
        this.hud.prompt = `to ${boardTram.dest}`;
        this.hud.promptBus = [{ id: 'TRAM', color: '#c8102e', sbs: false }];
        this.hud.promptHint = 'board the tram';
        const dDoor = Math.hypot(boardTram.door[0] - this.pos.x, boardTram.door[1] - this.pos.z);
        if (
          !this.benchmarkActive
          && dDoor < 1.7
          && performance.now() - this.lastEnterGuard > 2500
          && !this.transitioning
        ) {
          this.boardTram(boardTram.key);
        }
      } else if (near && !this.controls.fly && dE <= (nearDock?.d ?? Infinity)) {
        this.hud.prompt = `${near.station.name}`;
        this.hud.promptRoutes = near.station.routes;
        if (
          !this.benchmarkActive
          && dE < 1.9
          && performance.now() - this.lastEnterGuard > 2500
          && !this.transitioning
        ) {
          this.enterStation(near.station, near.pos);
        }
      } else if (nearDock && !this.controls.fly && (this.riding ? nearDock.canDock : nearDock.canGrab)) {
        this.hud.prompt = nearDock.dock.spec.n;
        this.hud.promptHint = this.riding ? 'dock your bike' : 'grab a bike';
      } else if (!this.riding && !this.controls.fly) {
        const stop = this.buses.nearestStop(this.pos.x, this.pos.z, 5);
        const tstn = this.tram.nearestStation(this.pos.x, this.pos.z, 8);
        if (stop) {
          this.hud.prompt = stop.name;
          this.hud.promptBus = stop.badges;
          const a = stop.arrivals[0];
          this.hud.promptHint = a
            ? `${a.route} ${a.seconds < 45 ? 'due' : `${Math.round(a.seconds / 60)} min`}`
            : 'bus stop';
        } else if (tstn) {
          this.hud.prompt = tstn.name;
          this.hud.promptBus = [{ id: 'TRAM', color: '#c8102e', sbs: false }];
          this.hud.promptHint = tstn.seconds < 20 ? 'tram due' : `tram in ${Math.round(tstn.seconds)}s`;
        }
      }

      // Building-info plaque within reach — a separate affordance from the transit
      // prompt (press i / tap the ⓘ button), so it coexists with a bus/dock prompt.
      if (!this.controls.fly) {
        const np = this.plaques.nearest(this.pos.x, this.pos.z, 7);
        this.nearPlaque = np?.info ?? null;
        this.hud.nearInfo = np
          ? { label: np.info.nm || [np.info.num, np.info.st].filter(Boolean).join(' ') || 'this building', lm: !!np.info.lm }
          : null;
      }
    } else if (this.mode === 'ride' && this.ride) {
      // constrained walking inside the car
      this.pos.x = Math.max(-6.8, Math.min(6.8, this.pos.x + dx));
      this.pos.z = Math.max(-1.05, Math.min(1.05, this.pos.z + dz));
      this.pos.y = 0;
      // walk-off: while dwelling, stepping into the open platform-side (+z)
      // doors steps you off — same affordance as walking in (E still works).
      if (this.ride.canExit && this.pos.z > 0.92
        && performance.now() - this.lastEnterGuard > 2500 && !this.transitioning) {
        this.exitRide();
      }
      this.ride.update(dt);
      this.goals.onRideDistance(this.ride.distanceThisFrame); // subway mileage: ride mode never calls goals.update()
      this.hud.ride = this.ride.hudInfo;
      this.hud.prompt = null;
      this.hud.promptRoutes = [];
      this.hud.promptBus = [];
      // end of the Manhattan run: hold the doors, then step off automatically
      if (this.ride.atEnd && this.ride.canExit) {
        if (this.atEndSince === 0) this.atEndSince = performance.now();
        else if (performance.now() - this.atEndSince > 6000) { this.atEndSince = 0; this.exitRide(); }
      } else {
        this.atEndSince = 0;
      }
    } else if (this.mode === 'bus' && this.busRide) {
      const h = this.busRide;
      // the world streams around the MOVING bus — that's the whole ride view
      this.buses.update(h.pos.x, h.pos.z, dt);
      if (!h.active) {
        // the run ended out from under us (terminal auto-exit should catch it
        // first) — step off right where the bus vanished, no fade
        this.exitBusStranded(h);
      } else {
        // the cabin turns and your view turns with it
        const dyaw = shortAngle(h.pos.yaw - this.prevBusYaw);
        this.controls.yaw += dyaw;
        this.prevBusYaw = h.pos.yaw;
        // walk the aisle: camera-space input mapped into cabin-local axes
        const th = h.pos.yaw;
        const box = rideInterior(h);
        const lx = dx * Math.cos(th) - dz * Math.sin(th);
        const lz = dx * Math.sin(th) + dz * Math.cos(th);
        this.busLocal.x = Math.max(box.minX, Math.min(box.maxX, this.busLocal.x + lx));
        this.busLocal.z = Math.max(box.minZ, Math.min(box.maxZ, this.busLocal.z + lz));
        // keep the player anchored to the vehicle for tiles/minimap/save
        this.pos.set(h.pos.x, heightAt(h.pos.x, h.pos.z), h.pos.z);
        if (this.sun) followSun(this.sun, this.pos.x, this.pos.z, this.pos.y, fwd.x, fwd.z);
        this.waterUpdate?.(dt);
        this.tiles.update(this.pos.x, this.pos.z, this.pos.y);
        this.updateRetailPopulationContext(dt);
        this.entrances.update(this.pos.x, this.pos.z, dt);
        this.bikes.update(this.pos.x, this.pos.z, dt);
        this.tram.update(this.pos.x, this.pos.z, dt);
        this.landmarks.update(this.pos.x, this.pos.z, dt);
        this.streetLife.update(
          this.pos.x,
          this.pos.z,
          () => this.tiles.roadPathsNear(this.pos.x, this.pos.z, 1),
          performance.now() / 1000,
        );
        this.hoodTimer -= dt;
        if (this.hoodTimer <= 0) {
          this.hoodTimer = 1.0;
          this.hud.area = this.hoodAt(this.pos.x, this.pos.z);
          const at = this.streetAt(this.pos.x, this.pos.z); // the street the bus is on
          this.hud.street = at.street;
          this.hud.cross = at.cross;
        }
        this.hud.bus = h.hud;
        this.hud.prompt = null;
        this.hud.promptRoutes = [];
        this.hud.promptBus = [];
        this.hud.promptHint = null;
        // walk-off: while dwelling, stepping into an open door bay steps you
        // off — the same affordance as walking on (E still works). The tram's
        // doors span the cabin on BOTH sides; the bus has curb-side bays.
        const walkOff = this.ridingTram
          ? Math.abs(this.busLocal.z) > box.maxZ - 0.08
          : (Math.abs(this.busLocal.x - BUS.doorX.front) < 1.1
            || Math.abs(this.busLocal.x - BUS.doorX.rear) < 1.2)
            && this.busLocal.z > box.maxZ - 0.08;
        if (h.canExit && walkOff
          && performance.now() - this.lastEnterGuard > 2500 && !this.transitioning) {
          this.exitBus();
        }
        // end of the run: hold the doors, then step off automatically
        if (h.atEnd && h.canExit) {
          if (this.busEndSince === 0) this.busEndSince = performance.now();
          else if (performance.now() - this.busEndSince > 6000) { this.busEndSince = 0; this.exitBus(); }
        } else {
          this.busEndSince = 0;
        }
      }
    } else if (this.station) {
      const st = this.station;
      if (this.controls.fly) {
        // free flight inside the station: escape hatch if footing is ever lost
        this.flyTarget.set(
          (fwd.x * input.forward + right.x * input.strafe) * 7,
          input.up * 5,
          (fwd.z * input.forward + right.z * input.strafe) * 7,
        );
        this.flyVel.lerp(this.flyTarget, 1 - Math.exp(-dt * 3.5));
        this.pos.x += this.flyVel.x * dt;
        this.pos.z += this.flyVel.z * dt;
        this.pos.y = Math.max(-1.4, Math.min(14, this.pos.y + this.flyVel.y * dt));
      } else {
      // footing recovery: if no walkbox accepts the current spot (hovering
      // over a stairwell, y drifted out of the step window, geometry gap),
      // settle onto whatever floor actually exists here; if none, drift back
      // toward the spawn until solid floor returns
      if (floorAt(st.walkBoxes, this.pos.x, this.pos.z, this.pos.y) === null) {
        const anyFloor = floorAtAny(st.walkBoxes, this.pos.x, this.pos.z);
        if (anyFloor !== null) {
          this.pos.y += (anyFloor - this.pos.y) * Math.min(1, dt * 6);
        } else {
          const rdx = st.spawn.x - this.pos.x, rdz = st.spawn.z - this.pos.z;
          const rd = Math.hypot(rdx, rdz) || 1;
          this.pos.x += (rdx / rd) * dt * 3;
          this.pos.z += (rdz / rd) * dt * 3;
          this.pos.y += (st.spawn.y - this.pos.y) * Math.min(1, dt * 3);
        }
      }
      // station movement: only onto walkable floors
      const tryMove = (mx: number, mz: number): boolean => {
        const f = floorAt(st.walkBoxes, this.pos.x + mx, this.pos.z + mz, this.pos.y);
        if (f !== null) {
          this.pos.x += mx; this.pos.z += mz;
          this.pos.y += (f - this.pos.y) * Math.min(1, dt * 14);
          if (Math.abs(f - this.pos.y) < 0.02) this.pos.y = f;
          return true;
        }
        return false;
      };
      if (!tryMove(dx, dz)) { if (!tryMove(dx, 0)) tryMove(0, dz); }
      }
      st.update(dt);
      this.scheduler?.update(dt);

      // exit zones: auto-exit at top of street stairs (y-guarded — complexes
      // stack levels, so a zone rect can sit directly above a deeper platform)
      let inExit = false;
      for (const zn of st.exitZones) {
        if (this.pos.x >= zn.minX && this.pos.x <= zn.maxX && this.pos.z >= zn.minZ && this.pos.z <= zn.maxZ
          && Math.abs(this.pos.y - zn.y) < 2.4) {
          inExit = true;
          if (performance.now() - this.lastEnterGuard > 2500 && !this.transitioning) this.exitStation();
        }
      }
      const b = !inExit && this.network ? this.stationBoardable() : null;
      this.hud.promptBus = [];
      if (inExit) {
        this.hud.prompt = 'Exit to street';
        this.hud.promptRoutes = [];
      } else if (b) {
        // label with the direction the ride will ACTUALLY run (terminals
        // clamp toward the line, so "downtown" at South Ferry reads Uptown)
        const effDir = this.rideDirFor(b.route, b.startId, b.dirSign);
        this.hud.prompt = `Board: ${boardLabel([b.route], effDir, st.name)}`;
        this.hud.promptRoutes = [b.route];
        // Walk-in boarding: stepping up to the open doors boards you, no key
        // needed — the same "walk into it" affordance as a street entrance (E
        // still works via tryAction). The guard blocks an instant re-board right
        // after stepping off, and the ~3m band means you must reach the platform
        // edge, not just stand on the platform.
        if (b.doorDist < 3.0
          && performance.now() - this.lastEnterGuard > 2500
          && !this.transitioning
          && this.network?.routes[b.route]) {
          this.beginRide(b.route, b.dirSign, b.startId);
        }
      } else {
        this.hud.prompt = null;
        this.hud.promptRoutes = [];
      }
    }

    // sound + the on-foot head-bob (writes walkBob.bobY/swayX/roll and onFootBob)
    this.updateAudio(dt, preX, preZ);

    // goals: spatial visits + run/heli/reservoir motion. Street (incl. bike/heli)
    // and bus only — subway rides teleport through tunnels, so no sightseeing
    // credit there. onFoot mirrors the walk-bob condition; groundSpeed is the
    // same per-frame move used for footsteps.
    if (this.mode === 'street' || this.mode === 'bus') {
      const moved = Math.hypot(this.pos.x - preX, this.pos.z - preZ);
      const groundSpeed = moved > 3 ? 0 : moved / Math.max(dt, 1e-4);
      const onFoot = this.mode === 'street' && !this.controls.fly && !this.riding;
      this.goals.update(dt, this.pos.x, this.pos.z, {
        onFoot,
        speed: groundSpeed,
        flying: this.controls.fly && this.mode === 'street',
        altAboveGround: this.pos.y - heightAt(this.pos.x, this.pos.z),
        busRiding: this.mode === 'bus',
      });
    }

    const eye = this._eye; // reused each frame — no per-frame Vector3 garbage
    if (this.mode === 'bus' && this.busRide) {
      // camera rides the cabin: local aisle offset through the bus transform
      const g = this.busRide.model.group;
      g.updateMatrixWorld();
      g.localToWorld(eye.set(
        this.busLocal.x, rideFloorY(this.busRide) + rideEye(this.busRide), this.busLocal.z,
      ));
    } else {
      eye.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
      if (this.onFootBob) {
        // vertical dip + a lateral sway along the camera-right axis; the roll
        // rides in through applyToCamera. Cosmetic only — this.pos is untouched.
        eye.y += this.walkBob.bobY;
        eye.x += right.x * this.walkBob.swayX;
        eye.z += right.z * this.walkBob.swayX;
      }
    }
    this.controls.applyToCamera(this.camera, eye, this.onFootBob ? this.walkBob.roll : 0);
    this.skyDome?.position.copy(this.camera.position);
    const scene = this.mode === 'ride' && this.ride ? this.ride.scene
      : this.mode === 'station' && this.station ? this.station.scene
      : this.streetScene;
    if (scene !== this.activeRenderScene) {
      this.activeRenderScene = scene;
      this.shadowDrawEstimate = estimateShadowDrawCalls(scene);
    }
    this.renderer.info.reset();
    this.gpuTimer.beginFrame();
    this.rendering.render(scene, this.mode, dt);
    this.gpuTimer.endFrame();
    this.lastGpuMs = this.gpuTimer.poll() ?? this.lastGpuMs;
    const cpuMs = performance.now() - cpuStartedAt;
    const streamingPressure = Math.min(
      1,
      this.hud.tilesPending / Math.max(4, this.tileWorkerCount * 3),
    );
    this.performanceRecorder.sample(
      this.renderer,
      rawDt * 1000,
      cpuMs,
      this.lastGpuMs,
      streamingPressure,
      this.shadowDrawEstimate,
    );
    const decision = this.qualityGovernor.sample({
      nowMs: performance.now(),
      frameMs: rawDt * 1000,
      cpuMs,
      gpuMs: this.lastGpuMs,
      streamingPressure,
      ignore: this.hud.loading || this.transitioning || document.hidden,
    });
    if (decision) this.applyRuntimeQuality(decision);

    // hud throttled
    this.fpsAcc += dt; this.fpsFrames++;
    this.hudTimer += dt;
    if (this.hudTimer > 0.5) {
      this.hudTimer = 0;
      const stats = this.tiles.stats();
      this.hud.tilesLoaded = stats.loaded;
      this.hud.tilesPending = stats.pending;
      this.hud.fps = Math.round(this.fpsFrames / Math.max(0.001, this.fpsAcc));
      this.hud.fly = this.controls.fly;
      this.shadowDrawEstimate = estimateShadowDrawCalls(scene);
      this.fpsAcc = 0; this.fpsFrames = 0;
      this.pushHud();
      this.save();
    }
  };

  private applyResolution() {
    this.renderer.setPixelRatio(this.dynPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.rendering.setSize(window.innerWidth, window.innerHeight, this.dynPixelRatio);
  }

  /**
   * Apply one decision from the percentile governor. The settings are a full
   * snapshot, so recovery walks the exact reverse path and every subsystem
   * stays in sync.
   */
  private applyRuntimeQuality(decision: QualityDecision) {
    const settings: RuntimeQualitySettings = decision.settings;
    const nextPixelRatio = Math.max(0.75, this.maxPixelRatio * settings.renderScale);
    if (Math.abs(nextPixelRatio - this.dynPixelRatio) >= 0.02) {
      this.dynPixelRatio = nextPixelRatio;
      this.applyResolution();
    }

    const sun = this.sun;
    if (sun) {
      const nextShadowSize = settings.shadowLevel === 2
        ? this.authoredShadowMapSize
        : settings.shadowLevel === 1
          ? Math.max(1024, Math.floor(this.authoredShadowMapSize / 2))
          : 0;
      if (nextShadowSize === 0) {
        sun.castShadow = false;
        this.renderer.shadowMap.enabled = false;
      } else {
        this.renderer.shadowMap.enabled = true;
        sun.castShadow = true;
        if (sun.shadow.mapSize.x !== nextShadowSize) {
          sun.shadow.mapSize.set(nextShadowSize, nextShadowSize);
          sun.shadow.map?.dispose();
          sun.shadow.map = null;
          // followSun derives bias/frustum state from the current map size.
          sun.userData.shMap = -1;
        }
      }
    }

    this.baseLoadRadius = Math.max(
      560,
      Math.round(this.authoredLoadRadius * settings.detailDistanceScale),
    );
    this.tiles.prefetchScale = settings.streamingScale;
    this.streetLife.setPopulationScale(settings.populationScale);
    this.rendering.setEffectsLevel(settings.effectsLevel);

    this.perfNotes.push(
      `${decision.direction} ${decision.knob}: ${decision.previous} -> ${decision.value}`,
    );
    if (this.perfNotes.length > 10) this.perfNotes.splice(0, this.perfNotes.length - 10);
  }

  /**
   * Fold streamed ground-floor semantics into the population density field.
   * Tile upgrades and unload/reloads revisit the same storefronts, while the
   * density field's quantized identity set makes the append-only feed
   * idempotent. Running once per second keeps this out of the frame hot path.
   */
  private updateRetailPopulationContext(dt: number) {
    this.retailAnchorTimer -= dt;
    if (this.retailAnchorTimer > 0) return;
    this.retailAnchorTimer = 1;
    const flat = this.tiles.retailAnchorsNear(
      this.pos.x,
      this.pos.z,
      360,
      this.retailAnchorScratch,
    );
    if (flat.length === 0) return;
    const anchors: DensityAnchor[] = [];
    for (let i = 0; i + 3 < flat.length; i += 4) {
      const category = Math.max(1, Math.min(7, Math.round(flat[i + 3])));
      anchors.push({
        x: flat[i],
        z: flat[i + 2],
        kind: 'retail',
        weight: Math.min(0.72, 0.43 + category * 0.045),
      });
    }
    this.streetLife.addContextAnchors(anchors);
  }

  /**
   * Drives every diegetic sound and the on-foot head-bob from the current mode.
   * Called each frame right before the camera is placed, so walkBob's offsets
   * are fresh. Loop targets are set unconditionally (silent = target 0), so a
   * mode you just left fades out instead of cutting.
   */
  private updateAudio(dt: number, preX: number, preZ: number) {
    try { this.updateAudioInner(dt, preX, preZ); }
    catch (e) {
      // sound + the cosmetic bob are non-essential — a failure here must never
      // take down the render loop (e.g. boarding a train). Degrade silently.
      this.onFootBob = false;
      if (!this.audioWarned) { this.audioWarned = true; console.warn('[audio] disabled after error:', e); }
    }
  }

  private audioWarned = false;

  private updateAudioInner(dt: number, preX: number, preZ: number) {
    const a = this.audio;
    const moved = Math.hypot(this.pos.x - preX, this.pos.z - preZ);
    // a teleport / mode swap jumps the position — don't read that as speed
    const groundSpeed = moved > 3 ? 0 : moved / Math.max(dt, 1e-4);

    // walk-bob + footsteps: genuinely on foot (street or on a platform)
    const onFoot = (this.mode === 'street' && !this.controls.fly && !this.riding)
      || (this.mode === 'station' && !this.controls.fly);
    this.onFootBob = onFoot;
    const footfall = this.walkBob.update(dt, onFoot ? groundSpeed : 0, onFoot);
    if (this.footstepsEnabled && footfall && !this.transitioning) {
      // walking = a full, soft step; running = softer + duller (a padded patter),
      // not a louder/higher machine-gun. Cadence already rises with speed.
      const running = groundSpeed > 7.5; // walk ~5.2 m/s, run ~10.9
      a.play('footstep', {
        volume: running ? 0.6 : 1,
        rate: (running ? 0.86 : 0.94) + Math.random() * 0.12,
      });
    }

    // bike: chain/tyre hum, scaled to how fast you're actually rolling
    const biking = this.mode === 'street' && this.riding && !this.controls.fly;
    a.loop('bike', biking ? Math.min(1, groundSpeed / 12) : 0, 0.75 + Math.min(0.6, groundSpeed / 22));
    // helicopter: rotor while in flight (street fly only — not the station hatch)
    a.loop('helicopter', this.mode === 'street' && this.controls.fly ? 1 : 0, 1);
    // bus: diesel engine while aboard an actual bus (the tram is electric — silent)
    const onBus = this.mode === 'bus' && !!this.busRide && !this.ridingTram;
    a.loop('bus', onBus ? 0.55 + Math.min(0.45, groundSpeed / 12) : 0,
      onBus ? 0.82 + Math.min(0.4, groundSpeed / 14) : 1);
    // train: car rumble — full while moving, a low idle at the platform
    let trainVol = 0, trainRate = 1;
    if (this.mode === 'ride' && this.ride) {
      const st = this.ride.hudInfo.state;
      trainVol = st === 'moving' ? 1 : st === 'closing' ? 0.35 : 0.12;
      trainRate = st === 'moving' ? 1 : 0.85;
    }
    a.loop('train', trainVol, trainRate);

    // bus doors: hiss + chime each time the ridden bus pulls in (state -> dwell)
    if (onBus && this.busRide) {
      const bstate = this.busRide.hud.state;
      if (bstate === 'dwell' && this.prevBusHudState !== null && this.prevBusHudState !== 'dwell') {
        a.play('busDoors');
      }
      this.prevBusHudState = bstate;
    } else {
      this.prevBusHudState = null;
    }

    a.update(dt);
  }

  /** A boardable train just started pulling into the platform. */
  private handleTrainArrive = () => {
    const now = performance.now();
    if (now - this.lastEnterGuard < 1200) return; // don't fire on the walk-in frame
    if (now - this.lastArriveSound < 3500) return; // one arrival roar at a time
    this.lastArriveSound = now;
    this.audio.play('trainArrive');
  };

  private pushHud() {
    this.onHud?.({ ...this.hud });
  }

  private save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        x: this.pos.x, z: this.pos.z, yaw: this.controls.yaw,
        mode: this.mode === 'station' || this.mode === 'bus' ? 'street' : this.mode,
      }));
    } catch { /* private mode */ }
  }

  private restore() {
    // first-visit default: Columbus Circle (a saved position overrides it below)
    const [sx, sz] = lonLatToXZ(START.lon, START.lat);
    this.pos.set(sx, 0, sz);
    this.controls.yaw = START_LOOK.yaw;
    this.controls.pitch = START_LOOK.pitch;
    // initial spawn gets the same building ejection as teleports — a saved (or
    // default) point can sit inside a footprint that streams in around it
    this.spawnResolve = true;
    try {
      // fall back to the pre-rename key so an existing saved position survives
      const raw = localStorage.getItem(SAVE_KEY) ?? localStorage.getItem(LEGACY_SAVE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.x === 'number' && typeof s.z === 'number') this.pos.set(s.x, 0, s.z);
      if (typeof s.yaw === 'number') this.controls.yaw = s.yaw;
    } catch { /* ignore */ }
  }

  action() { this.tryAction(); }

  /**
   * Open the building-info modal for the plaque in reach (i key / mobile ⓘ
   * button). Captured on press so the modal content is decoupled from the ~2Hz
   * HUD throttle. No-op unless a plaque is nearby in street mode.
   */
  private tryInfo() {
    if (this.mode !== 'street' || !this.nearPlaque) return;
    this.onInfo?.(this.nearPlaque);
  }

  info() { this.tryInfo(); }

  /** Debug/scripting hook: place the player (feet) and optionally aim. */
  setPos(x: number, y: number, z: number, yaw?: number, pitch?: number) {
    this.pos.set(x, y, z);
    if (yaw !== undefined) this.controls.yaw = yaw;
    if (pitch !== undefined) this.controls.pitch = pitch;
  }
  getPos() { return { x: this.pos.x, y: this.pos.y, z: this.pos.z, mode: this.mode }; }

  /** Static overlay data for the minimap. */
  mapData(): {
    stations: { x: number; z: number; color: string; name: string }[];
    entrances: [number, number][];
    docks: [number, number][];
    busStops: [number, number][];
  } {
    const stations = [...this.entrances.stationsMap.values()].map((s) => ({
      x: s.pos[0], z: s.pos[1], color: routeColor(s.routes[0]), name: s.name,
    }));
    // tram terminals show as named dots too — otherwise the line is invisible
    // on the map and riders can't find where to board
    for (const [x, z] of this.tram.stationPositions()) {
      stations.push({ x, z, color: '#c8102e', name: 'Roosevelt Island Tram' });
    }
    return {
      stations,
      entrances: this.entrances.entrancePositions(),
      docks: this.bikes.dockPositions(),
      busStops: this.buses.stopPositions(),
    };
  }
  /** Live bus positions, island-wide (minimap bus layer). */
  getBuses() { return this.buses.busPositions(); }
  /** Road centerlines near the player, for the minimap's closest zoom. */
  roadPathsNear(x: number, z: number, tileR = 2) { return this.tiles.roadPathsNear(x, z, tileR); }
  getTrains() {
    if (this.scheduler) return this.scheduler.trainStates;
    if (this.station instanceof ComplexStationWorld) return this.station.trainStates;
    return [];
  }
  getRide() { return this.ride?.hudInfo ?? null; }
  /** Start a bounded performance capture for browser/device golden-route QA. */
  resetPerformanceCapture(label = 'manual') { this.performanceRecorder.reset(label); }
  /**
   * Debug/automation report with true frame percentiles, GPU query samples,
   * submitted draw/triangle counts, memory estimates and active post effects.
   */
  performanceReport() {
    return {
      ...this.performanceRecorder.report(),
      mode: this.mode,
      quality: quality().level,
      pixelRatio: this.dynPixelRatio,
      rendererMemory: { ...this.renderer.info.memory },
      shaderPrograms: this.renderer.info.programs?.length ?? 0,
      sceneResources: estimateSceneResources(this.activeRenderScene),
      rendering: this.rendering.stats(),
      streaming: this.tiles.streamingReport(),
      landmarks: this.landmarks.lodStats(),
      governor: this.qualityGovernor.snapshot,
      materials: materialLibrary.report(),
    };
  }
  /**
   * Automation should not start a route while the asynchronously loaded world
   * catalogs are still empty. Returning no routes makes the browser harness's
   * existing readiness wait cover tiles, subway stations, and transit data.
   */
  benchmarkRoutes() { return this.hud.loading ? [] : goldenRouteIds(); }
  /**
   * Run one deterministic capture from `window.__nyc`. The route temporarily
   * mutes audio, preloads its first location, then records only the steady
   * traversal. This is suitable for desktop automation and physical-device
   * remote debugging without adding a production-only testing dependency.
   */
  async runBenchmarkRoute(id: GoldenRouteId) {
    if (this.benchmarkActive) throw new Error('A benchmark route is already running');
    const route = GOLDEN_ROUTES[id];
    if (!route) throw new Error(`Unknown benchmark route: ${id}`);
    const readyDeadline = performance.now() + 15_000;
    while (this.hud.loading && performance.now() < readyDeadline) await wait(50);
    if (this.hud.loading) throw new Error('Benchmark world initialization timed out');
    this.benchmarkActive = true;
    const wasMuted = this.audio.isMuted;
    this.audio.setMuted(true);
    try {
      this.leaveTransit();
      await wait(0);
      if (route.kind === 'station') {
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const spec = this.entrances.findStation((s) => norm(s.name).includes(norm(route.stationSearch)));
        if (!spec) throw new Error(`Benchmark station not found: ${route.stationSearch}`);
        await this.enterStation(spec, spec.pos);
        await wait(900);
        this.performanceRecorder.reset(route.label);
        const initialYaw = this.controls.yaw;
        await animateFor(route.seconds * 1000, (t) => {
          // Two measured turns exercise view-dependent station cells and shadow
          // culling while staying on the known-safe spawn point.
          this.controls.yaw = initialYaw + t * Math.PI * 4;
          this.controls.pitch = 0.02 + Math.sin(t * Math.PI * 2) * 0.08;
        });
      } else {
        const first = route.points[0];
        this.teleport(first.lat, first.lon);
        await wait(1600);
        // Additive tiles decode base -> mid -> near and integrate one layer per
        // frame. Record the traversal only after that starting neighborhood has
        // been genuinely idle for four consecutive probes; otherwise startup
        // work is mislabeled as steady-state streaming pressure.
        const streamDeadline = performance.now() + 6000;
        let idleProbes = 0;
        while (performance.now() < streamDeadline && idleProbes < 4) {
          idleProbes = this.tiles.stats().pending === 0 ? idleProbes + 1 : 0;
          await wait(100);
        }
        const [firstX, firstZ] = lonLatToXZ(first.lon, first.lat);
        this.pos.set(firstX, heightAt(firstX, firstZ), firstZ);
        this.spawnResolve = false;
        this.performanceRecorder.reset(route.label);
        for (let i = 1; i < route.points.length; i++) {
          const previous = route.points[i - 1];
          const next = route.points[i];
          const [x0, z0] = lonLatToXZ(previous.lon, previous.lat);
          const [x1, z1] = lonLatToXZ(next.lon, next.lat);
          const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
          await animateFor(next.seconds * 1000, (t) => {
            const eased = t * t * (3 - 2 * t);
            const x = THREE.MathUtils.lerp(x0, x1, eased);
            const z = THREE.MathUtils.lerp(z0, z1, eased);
            this.pos.set(x, heightAt(x, z), z);
            this.controls.yaw = yaw;
            this.controls.pitch = 0.035;
          });
        }
      }
      await wait(250);
      return this.performanceReport();
    } finally {
      this.benchmarkActive = false;
      this.audio.setMuted(wasMuted);
    }
  }
  /** Debug: advance the station/ride sim by `s` seconds in fixed steps. */
  ffStation(s: number) {
    for (let t = 0; t < s; t += 0.05) {
      this.scheduler?.update(0.05);
      if (this.station instanceof ComplexStationWorld) this.station.update(0.05);
      this.ride?.update(0.05);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    if (this.tickInterval) clearInterval(this.tickInterval);
    window.removeEventListener('resize', this.resize);
    this.controls.dispose();
    this.tiles.destroy();
    this.streetLife.destroy();
    this.entrances.destroy();
    this.plaques.destroy();
    this.bikes.destroy();
    this.buses.dispose();
    this.tram.destroy();
    this.landmarks.destroy();
    this.bikeView?.dispose();
    this.audio.dispose();
    this.scheduler?.dispose();
    this.station?.dispose();
    this.ride?.dispose();
    this.streetEnvTex?.dispose();
    this.envTex?.dispose();
    this.gpuTimer.dispose();
    this.rendering.dispose();
    materialLibrary.dispose();
    this.renderer.dispose();
  }
}

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function animateFor(ms: number, update: (progress: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.max(0, Math.min(1, (now - startedAt) / Math.max(1, ms)));
      update(progress);
      if (progress >= 1) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Wrap to (-PI, PI] so a bus heading crossing the seam doesn't spin the view. */
function shortAngle(a: number) { return Math.atan2(Math.sin(a), Math.cos(a)); }
