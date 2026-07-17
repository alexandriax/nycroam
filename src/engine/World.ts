import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TileManager } from './TileManager';
import { PlayerControls } from './controls';
import { resolveBuildingCollision, nearestWallDir, floorAt, floorAtAny, pointInBuildings } from './collision';
import { setupSky, setupLights, followSun, SKY } from './sky';
import { quality } from './quality';
import { makeSkylineMaterial, makeFlatMaterial, makeWaterMaterial } from './materials';
import { EntranceManager, disposeGroup } from './EntranceManager';
import { BikeManager, buildMountedBike } from './bikes';
import { LandmarkManager } from './landmarks/LandmarkManager';
import { LANDMARKS_REG } from './landmarks/registry';
import { BikeView } from './bikeview';
import { BusSystem, type BusRideHandle } from './bus/BusSystem';
import { BusModel } from './bus/model';
import { buildBusStop } from './bus/stops';
import { BUS, type BusHud, type BusRouteBadge } from './bus/types';
import { loadSans } from './fonts';
import { StationWorld } from './subway/StationWorld';
import { ElevatedStationWorld } from './subway/ElevatedStationWorld';
import { TrainScheduler } from './subway/scheduler';
import { RideWorld, type RideHud } from './subway/RideWorld';
import type { StationSpec, NetworkData, Arrival } from './subway/types';
import { routeColor } from './subway/types';
import { boardLabel } from './subway/directions';
import { lonLatToXZ } from './geo';
import { loadTerrain, heightAt } from './terrain';

const SAVE_KEY = 'nycroam';
const LEGACY_SAVE_KEY = 'nycworld'; // read-only: keeps positions saved before the rename
const WALK_EYE = 1.7; // standing; BikeView.eyeHeight is the seated one
const START = { lat: 40.7681, lon: -73.9819 }; // Columbus Circle — first-visit spawn

export interface HudState {
  mode: 'street' | 'station' | 'ride' | 'bus';
  fly: boolean;
  prompt: string | null; // e.g. "72 St · 1·2·3"
  promptRoutes: string[];
  promptBus: BusRouteBadge[]; // bus route chips on the prompt (stops / boarding)
  promptHint: string | null; // action verb ("grab a bike"); null = subway walk-in default
  riding: boolean; // on a bike
  area: string | null; // current neighborhood (street mode)
  stationName: string | null;
  stationRoutes: string[];
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
  { name: 'Central Park — Bethesda', lat: 40.774, lon: -73.9708 },
  { name: 'Columbus Circle', lat: 40.7681, lon: -73.9819 },
  { name: 'Washington Sq Park', lat: 40.7308, lon: -73.9973 },
  { name: 'Wall Street', lat: 40.7069, lon: -74.0113 },
  { name: 'One World Trade', lat: 40.7127, lon: -74.0134 },
  { name: 'The Battery', lat: 40.7033, lon: -74.017 },
  { name: 'Union Square', lat: 40.7359, lon: -73.9906 },
  { name: 'Rockefeller Center', lat: 40.7587, lon: -73.9787 },
  { name: 'Apollo Theater (Harlem)', lat: 40.81, lon: -73.95 },
  { name: 'Inwood', lat: 40.867, lon: -73.9212 },
];

export class World {
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private streetScene = new THREE.Scene();
  private tiles: TileManager;
  private entrances: EntranceManager;
  private bikes: BikeManager;
  private landmarks: LandmarkManager;
  private hoods: { n: string; rings: number[][]; bbox: [number, number, number, number] }[] | null = null;
  private hoodTimer = 0;
  private riding = false; // on a bike (street mode only)
  private bikeView: BikeView | null = null; // built on the first ride, kept after
  private controls: PlayerControls;
  private station: StationWorld | ElevatedStationWorld | null = null;
  private scheduler: TrainScheduler | null = null;
  private ride: RideWorld | null = null;
  private network: NetworkData | null = null;
  private buses: BusSystem;
  private busRide: BusRideHandle | null = null;
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
  private transitioning = false;
  private lastEnterGuard = 0; // avoid instant re-trigger loops
  private spawnResolve = false; // eject from a building after a teleport/exit, once tiles load
  private skyDome: THREE.Object3D | null = null;
  private lastRaf = 0;
  private tickInterval = 0;
  private envTex: THREE.Texture | null = null;
  private baseLoadRadius = 1150;
  private currentStationSpec: StationSpec | null = null;
  private atEndSince = 0;
  private sun: THREE.DirectionalLight | null = null;
  private waterUpdate: ((dt: number) => void) | null = null;
  private flyVel = new THREE.Vector3();
  private flyTarget = new THREE.Vector3();
  hud: HudState = {
    mode: 'street', fly: false, prompt: null, promptRoutes: [], promptBus: [], promptHint: null, riding: false, area: null, stationName: null,
    stationRoutes: [], ride: null, bus: null, tilesLoaded: 0, tilesPending: 0, fps: 0, loading: true, error: null,
  };
  onHud: ((h: HudState) => void) | null = null;
  onFade: ((opaque: boolean) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
    const q = quality();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    if (q.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    // env map so metallic materials (trains, rails, turnstiles) read as steel
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const far = this.isMobile ? 4200 : 6500;
    const loadRadius = this.isMobile ? 750 : 1150;
    this.baseLoadRadius = loadRadius;
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, far);
    this.skyDome = setupSky(this.streetScene, loadRadius, far);
    this.sun = setupLights(this.streetScene).sun;

    this.tiles = new TileManager(this.streetScene, this.isMobile ? 2 : 3);
    this.tiles.loadRadius = loadRadius;
    this.tiles.unloadRadius = this.tiles.loadRadius + 300;
    this.entrances = new EntranceManager(
      this.streetScene,
      (x, z) => {
        if (!this.tiles.readyAround(x, z)) return null; // wait for building collision before placing
        return resolveBuildingCollision(x, z, 4.2, this.tiles.collisionNear(x, z));
      },
      (x, z) => nearestWallDir(x, z, 15, this.tiles.collisionNear(x, z)),
    );
    // road-clearance callback: landmark props (Times Square billboard masts)
    // that bake into a roadbed get nudged onto the sidewalk; null defers a
    // road-sensitive landmark until its tiles load
    this.landmarks = new LandmarkManager(
      this.streetScene,
      (x, z, clearance) => this.ejectFromRoads(x, z, clearance),
    );
    this.bikes = new BikeManager(
      this.streetScene,
      (x, z) => {
        if (!this.tiles.readyAround(x, z)) return null;
        return resolveBuildingCollision(x, z, 2.6, this.tiles.collisionNear(x, z));
      },
      (x, z) => nearestWallDir(x, z, 15, this.tiles.collisionNear(x, z)),
    );

    // buses: sim + culling live in BusSystem; the vehicle/stop visuals are
    // injected so the system stays compile-independent of the mesh modules
    this.buses = new BusSystem(
      this.streetScene,
      (o) => new BusModel(o, this.envTex),
      buildBusStop,
    );
    // pull each stop kit off the roadway onto the sidewalk once its tiles load
    this.buses.resolvePlacement = (x, z) => this.resolveBusStop(x, z);

    this.controls = new PlayerControls(canvas);
    this.controls.onToggleFly = () => {
      if (this.riding || this.mode === 'bus') return; // dock the bike / step off first
      this.controls.fly = !this.controls.fly; // allowed everywhere (rescue hatch in stations)
    };
    this.controls.onAction = () => this.tryAction();

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

  get controlsRef() { return this.controls; }

  async init() {
    const results = await Promise.allSettled([
      loadTerrain(),
      this.loadNetwork(),
      this.tiles.init(),
      this.entrances.init(),
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

    // deep-link: ?landmark=<id or name> teleports to a premium landmark for fast
    // QA (the LandmarkManager streams it in the moment we land inside its radius).
    // Lift into helicopter view so you never spawn buried inside the build.
    const lm = params.get('landmark');
    if (lm) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const entry = LANDMARKS_REG.find((l) => l.id.toLowerCase() === lm.toLowerCase())
        ?? LANDMARKS_REG.find((l) => norm(l.name).includes(norm(lm)));
      if (entry) {
        this.teleport(entry.lat, entry.lon);
        this.controls.fly = true;
      }
    }
  }

  private async loadNetwork() {
    try {
      const res = await fetch('/subway/network.json');
      if (res.ok) this.network = (await res.json()) as NetworkData;
    } catch { /* riding disabled without network data */ }
  }

  private async loadHoods() {
    try {
      const res = await fetch('/geo/hoods.json');
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
    const res = await fetch('/geo/ground.bin');
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
    const res = await fetch('/tiles/skyline.json');
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
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  teleport(lat: number, lon: number) {
    if (this.mode === 'station') this.exitStation(true);
    const [x, z] = lonLatToXZ(lon, lat);
    this.pos.set(x, 0, z);
    this.spawnResolve = true; // resolved out of any building once tiles arrive
    this.save();
  }

  /**
   * A standing point at/near (x,z) that is NOT inside a building. If the target
   * is already clear, just resolve grazing contact. Otherwise spiral outward and
   * take the nearest open point — guarantees a teleport/exit never leaves the
   * player embedded in a building (where they could then walk out through walls).
   */
  private freeSpawn(x: number, z: number): [number, number] {
    const near0 = this.tiles.collisionNear(x, z);
    if (!pointInBuildings(x, z, near0)) return resolveBuildingCollision(x, z, 0.5, near0);
    for (let ring = 2.5; ring <= 26; ring += 2.5) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const tx = x + Math.cos(ang) * ring, tz = z + Math.sin(ang) * ring;
        const near = this.tiles.collisionNear(tx, tz);
        if (!pointInBuildings(tx, tz, near)) return resolveBuildingCollision(tx, tz, 0.5, near);
      }
    }
    return [x, z]; // fully enclosed (shouldn't happen in Manhattan) — leave as-is
  }

  /**
   * Curb-resolve a bus stop's raw GTFS point: defer until its tiles load (null),
   * then push it out of any roadway ribbon onto the sidewalk and clear of
   * buildings. GTFS points are curbside but some land in wide roadbeds; buses
   * pass on the street side, so the pole belongs a couple meters curbward.
   */
  private resolveBusStop(x: number, z: number): [number, number] | null {
    const off = this.ejectFromRoads(x, z, 1.6);
    if (!off) return null; // tiles not ready yet — defer
    return resolveBuildingCollision(off[0], off[1], 0.8, this.tiles.collisionNear(off[0], off[1]));
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
        // roll up to an open bus and it carries you AND the bike; else dock
        const bb = this.buses.boardable(this.pos.x, this.pos.z);
        if (bb) { this.boardBus(bb.key); return; }
        if (nearDock?.canDock && this.bikes.dockBike(nearDock.dock)) this.setRiding(false);
        return;
      }
      // an open bus at the curb wins: you walked to the stop for it
      const bb = this.controls.fly ? null : this.buses.boardable(this.pos.x, this.pos.z);
      if (bb) { this.boardBus(bb.key); return; }
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
      // action near an exit zone exits
      const p = this.pos;
      for (const zn of this.station.exitZones) {
        if (p.x >= zn.minX - 2 && p.x <= zn.maxX + 2 && p.z >= zn.minZ - 2 && p.z <= zn.maxZ + 2) {
          this.exitStation();
          return;
        }
      }
      // otherwise: board a dwelling train if one is open next to us
      if (this.scheduler && this.network) {
        const b = this.scheduler.boardable(this.pos.x, this.pos.z);
        if (b && this.network.routes[b.route]) this.beginRide(b.route, b.dirSign);
      }
    }
  }

  /** Mount / dismount: the view model, the seated eye height, and the HUD flag. */
  private setRiding(on: boolean) {
    this.riding = on;
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
    if (!h) return;
    const broughtBike = this.riding;
    this.transitioning = true;
    try {
      this.onFade?.(true);
      await wait(280);
      if (broughtBike) this.setRiding(false); // stow the viewmodel; the rack carries it
      this.broughtBike = broughtBike;
      this.busRide = h;
      this.mode = 'bus';
      this.hud.mode = 'bus';
      this.controls.fly = false;
      if (broughtBike) {
        // clamp the bike to the front rack (bus local +x, just past the bumper)
        this.busBike = buildMountedBike();
        this.busBike.position.set(6.35, 0, 0);
        h.model.group.add(this.busBike);
      }
      // start mid-cabin in the aisle, facing whatever way you were looking
      this.busLocal.set(0.6, 0, 0.1);
      this.prevBusYaw = h.pos.yaw;
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
      this.mode = 'street';
      this.hud.mode = 'street';
      this.hud.bus = null;
      // narrow sidewalks: never step off INTO a building face
      [ex, ez] = resolveBuildingCollision(ex, ez, 0.42, this.tiles.collisionNear(ex, ez));
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
  private exitBusStranded(h: BusRideHandle) {
    h.end();
    this.busRide = null;
    this.mode = 'street';
    this.hud.mode = 'street';
    this.hud.bus = null;
    this.pos.set(h.pos.x, heightAt(h.pos.x, h.pos.z), h.pos.z);
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

  private async beginRide(route: string, dirSign: 1 | -1) {
    if (this.transitioning || !this.network || !this.currentStationSpec) return;
    this.transitioning = true;
    try {
      this.onFade?.(true);
      await wait(420);
      const startId = this.currentStationSpec.id;
      // The 42nd St shuttle is a terminal at BOTH ends (only Times Sq <-> Grand
      // Central): whichever platform you board, the sole destination is the other
      // stop. Force the direction toward it so a 2-stop line never boards you into
      // an instant "Last stop" (dirSign +1 rides toward stops[last]).
      const rStops = this.network.routes[route]?.stops;
      if (rStops && rStops.length <= 2) {
        const i = rStops.indexOf(startId);
        if (i >= 0) dirSign = i === 0 ? 1 : -1;
      }
      this.scheduler?.dispose();
      this.scheduler = null;
      this.station?.dispose();
      this.station = null;
      this.ride = new RideWorld(route, dirSign, startId, this.network, this.entrances.stationsMap, this.envTex);
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
      this.ride.dispose();
      this.ride = null;
      const spec = this.entrances.stationsMap.get(stationId);
      if (spec) {
        this.buildStation(spec);
        this.pos.copy(this.station!.platformSpawn);
        // exiting the subway drops you back on the street at this station's entrance
        const ent = this.entrances.entranceFor(spec);
        this.returnPos.set(ent[0] + 2.2, 0, ent[1] + 2.2);
        this.mode = 'station';
        this.hud.mode = 'station';
        this.hud.stationName = spec.name;
        this.hud.stationRoutes = spec.routes;
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
    const elevated = /elev|viaduct/i.test(spec.structure);
    this.station = elevated
      ? new ElevatedStationWorld(spec, this.envTex)
      : new StationWorld(spec, this.envTex);
    this.scheduler = new TrainScheduler(this.station.scene, spec, this.station.trackInfo, this.network);
    // feed the platform countdown clocks: the station redraws them from this on
    // its own timer (reads the live scheduler each call, so it survives rebuilds).
    (this.station as { arrivalsFn?: () => Arrival[] }).arrivalsFn = () => this.scheduler?.arrivals() ?? [];
    this.currentStationSpec = spec;
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
      this.pos.copy(this.station!.spawn);
      this.hud.mode = 'station';
      this.hud.stationName = spec.name;
      this.hud.stationRoutes = spec.routes;
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
    this.step();
  };

  private step = () => {
    // self-heal: if we were constructed while the window reported zero size
    // (embedded panes, background tabs), pick up the real size on first frame
    if (this.renderer.domElement.width === 0 && window.innerWidth > 0) this.resize();
    const dt = Math.min(0.05, this.clock.getDelta());
    const input = this.controls.consumeInput();
    const { fwd, right } = this.controls.basis();

    // bike = 2x a full run (run = 5.2 walk x 2.1 sprint = 10.9 -> bike 21.8);
    // no sprint modifier on wheels
    const baseSpeed = this.mode === 'station' ? 3.6 : this.controls.fly ? 42 : this.riding ? 21.8 : 5.2;
    const speed = baseSpeed * (input.sprint && !this.riding ? (this.controls.fly ? 3.2 : 2.1) : 1);
    let dx = (fwd.x * input.forward + right.x * input.strafe) * speed * dt;
    let dz = (fwd.z * input.forward + right.z * input.strafe) * speed * dt;

    if (this.mode === 'street') {
      // safe spawn: after a teleport / exit we may have landed inside a building
      // footprint (entrances hug walls, jump targets are raw lat/lon). Once the
      // tiles here have integrated, push out to the nearest sidewalk. Skip while
      // flying — the helicopter teleport lands you above the rooftops on purpose.
      if (this.spawnResolve && !this.controls.fly && this.tiles.readyAround(this.pos.x, this.pos.z)) {
        const [rx, rz] = this.freeSpawn(this.pos.x, this.pos.z);
        this.pos.x = rx; this.pos.z = rz;
        this.pos.y = heightAt(rx, rz);
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
        this.pos.x += this.flyVel.x * dt;
        this.pos.z += this.flyVel.z * dt;
        // never descend below the ground under you: clamp to terrain + clearance
        // (Manhattan hills rise ~80m, so a fixed floor let you sink underground)
        const floorY = heightAt(this.pos.x, this.pos.z) + 1.3;
        this.pos.y = Math.max(floorY, Math.min(1200, this.pos.y + this.flyVel.y * dt));
      } else {
        this.flyVel.set(0, 0, 0);
        let nx = this.pos.x + dx, nz = this.pos.z + dz;
        [nx, nz] = resolveBuildingCollision(nx, nz, 0.42, this.tiles.collisionNear(nx, nz));
        const g = heightAt(nx, nz);
        // follow terrain smoothly (streets are graded, not stepped)
        this.pos.y += (g - this.pos.y) * Math.min(1, dt * 10);
        if (Math.abs(g - this.pos.y) < 0.02) this.pos.y = g;
        this.pos.x = nx; this.pos.z = nz;
      }

      // widen fog + streaming with altitude so flying shows more of the island
      const altBoost = Math.min(500, Math.max(0, this.pos.y - 60)) * 1.6;
      this.tiles.loadRadius = this.baseLoadRadius + altBoost;
      this.tiles.unloadRadius = this.tiles.loadRadius + 300;
      const fog = this.streetScene.fog as THREE.Fog | null;
      if (fog) {
        fog.near = (this.baseLoadRadius + altBoost) * 0.38;
        fog.far = (this.baseLoadRadius + altBoost) * 1.18;
      }

      if (this.sun) followSun(this.sun, this.pos.x, this.pos.z);
      this.waterUpdate?.(dt);
      this.tiles.update(this.pos.x, this.pos.z);
      this.entrances.update(this.pos.x, this.pos.z, dt);
      this.bikes.update(this.pos.x, this.pos.z, dt);
      this.buses.update(this.pos.x, this.pos.z, dt);
      this.landmarks.update(this.pos.x, this.pos.z, dt);

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
      }

      // proximity prompts. On a bike the subway is out of reach (dock first),
      // but an OPEN bus at the curb still takes you — the bike rides the front
      // rack. On foot an OPEN bus wins (it's leaving; everything else keeps),
      // then the closer of entrance/dock, then a waiting-at-the-stop readout.
      const near = this.riding ? null : this.entrances.nearest(this.pos.x, this.pos.z, 5);
      const nearDock = this.bikes.nearest(this.pos.x, this.pos.z, 4.5);
      const boardBus = this.controls.fly ? null : this.buses.boardable(this.pos.x, this.pos.z);
      const dE = near ? Math.hypot(near.pos[0] - this.pos.x, near.pos[1] - this.pos.z) : Infinity;
      this.hud.prompt = null;
      this.hud.promptRoutes = [];
      this.hud.promptBus = [];
      this.hud.promptHint = null;
      if (boardBus) {
        this.hud.prompt = `to ${boardBus.dest}`;
        this.hud.promptBus = [{ id: boardBus.route, color: boardBus.color, sbs: boardBus.sbs }];
        this.hud.promptHint = this.riding ? 'board — bike rides up front' : 'board the bus';
        const dDoor = Math.hypot(boardBus.door[0] - this.pos.x, boardBus.door[1] - this.pos.z);
        if (dDoor < 1.7 && performance.now() - this.lastEnterGuard > 2500 && !this.transitioning) {
          this.boardBus(boardBus.key);
        }
      } else if (near && !this.controls.fly && dE <= (nearDock?.d ?? Infinity)) {
        this.hud.prompt = `${near.station.name}`;
        this.hud.promptRoutes = near.station.routes;
        if (dE < 1.9 && performance.now() - this.lastEnterGuard > 2500 && !this.transitioning) {
          this.enterStation(near.station, near.pos);
        }
      } else if (nearDock && !this.controls.fly && (this.riding ? nearDock.canDock : nearDock.canGrab)) {
        this.hud.prompt = nearDock.dock.spec.n;
        this.hud.promptHint = this.riding ? 'dock your bike' : 'grab a bike';
      } else if (!this.riding && !this.controls.fly) {
        const stop = this.buses.nearestStop(this.pos.x, this.pos.z, 5);
        if (stop) {
          this.hud.prompt = stop.name;
          this.hud.promptBus = stop.badges;
          const a = stop.arrivals[0];
          this.hud.promptHint = a
            ? `${a.route} ${a.seconds < 45 ? 'due' : `${Math.round(a.seconds / 60)} min`}`
            : 'bus stop';
        }
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
        // walk the aisle: camera-space input mapped into bus-local axes
        const th = h.pos.yaw;
        const lx = dx * Math.cos(th) - dz * Math.sin(th);
        const lz = dx * Math.sin(th) + dz * Math.cos(th);
        this.busLocal.x = Math.max(BUS.interior.minX, Math.min(BUS.interior.maxX, this.busLocal.x + lx));
        this.busLocal.z = Math.max(BUS.interior.minZ, Math.min(BUS.interior.maxZ, this.busLocal.z + lz));
        // keep the player anchored to the bus for tiles/minimap/save
        this.pos.set(h.pos.x, heightAt(h.pos.x, h.pos.z), h.pos.z);
        if (this.sun) followSun(this.sun, this.pos.x, this.pos.z);
        this.waterUpdate?.(dt);
        this.tiles.update(this.pos.x, this.pos.z);
        this.entrances.update(this.pos.x, this.pos.z, dt);
        this.bikes.update(this.pos.x, this.pos.z, dt);
        this.landmarks.update(this.pos.x, this.pos.z, dt);
        this.hoodTimer -= dt;
        if (this.hoodTimer <= 0) {
          this.hoodTimer = 1.0;
          this.hud.area = this.hoodAt(this.pos.x, this.pos.z);
        }
        this.hud.bus = h.hud;
        this.hud.prompt = null;
        this.hud.promptRoutes = [];
        this.hud.promptBus = [];
        this.hud.promptHint = null;
        // walk-off: while dwelling, stepping into an open door bay steps you
        // off — the same affordance as walking on (E still works)
        const nearDoor = Math.abs(this.busLocal.x - BUS.doorX.front) < 1.1
          || Math.abs(this.busLocal.x - BUS.doorX.rear) < 1.2;
        if (h.canExit && nearDoor && this.busLocal.z > BUS.interior.maxZ - 0.08
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

      // exit zones: auto-exit at top of street stairs
      let inExit = false;
      for (const zn of st.exitZones) {
        if (this.pos.x >= zn.minX && this.pos.x <= zn.maxX && this.pos.z >= zn.minZ && this.pos.z <= zn.maxZ) {
          inExit = true;
          if (performance.now() - this.lastEnterGuard > 2500 && !this.transitioning) this.exitStation();
        }
      }
      const b = !inExit && this.network ? this.scheduler?.boardable(this.pos.x, this.pos.z) : null;
      this.hud.promptBus = [];
      if (inExit) {
        this.hud.prompt = 'Exit to street';
        this.hud.promptRoutes = [];
      } else if (b) {
        this.hud.prompt = `Board — ${boardLabel([b.route], b.dirSign, st.name)}`;
        this.hud.promptRoutes = [b.route];
        // Walk-in boarding: stepping up to the open doors boards you, no key
        // needed — the same "walk into it" affordance as a street entrance (E
        // still works via tryAction). The guard blocks an instant re-board right
        // after stepping off, and the ~3m band means you must reach the platform
        // edge, not just stand on the platform.
        if (Math.abs(this.pos.z - b.trackZ) < 3.0
          && performance.now() - this.lastEnterGuard > 2500
          && !this.transitioning
          && this.network?.routes[b.route]) {
          this.beginRide(b.route, b.dirSign);
        }
      } else {
        this.hud.prompt = null;
        this.hud.promptRoutes = [];
      }
    }

    let eye: THREE.Vector3;
    if (this.mode === 'bus' && this.busRide) {
      // camera rides the cabin: local aisle offset through the bus transform
      const g = this.busRide.model.group;
      g.updateMatrixWorld();
      eye = g.localToWorld(new THREE.Vector3(this.busLocal.x, BUS.floorY + BUS.eye, this.busLocal.z));
    } else {
      eye = new THREE.Vector3(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    }
    this.controls.applyToCamera(this.camera, eye);
    this.skyDome?.position.copy(this.camera.position);
    const scene = this.mode === 'ride' && this.ride ? this.ride.scene
      : this.mode === 'station' && this.station ? this.station.scene
      : this.streetScene;
    this.renderer.render(scene, this.camera);

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
      this.fpsAcc = 0; this.fpsFrames = 0;
      this.pushHud();
      this.save();
    }
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
  getTrains() { return this.scheduler?.trainStates ?? []; }
  getRide() { return this.ride?.hudInfo ?? null; }
  /** Debug: advance the station/ride sim by `s` seconds in fixed steps. */
  ffStation(s: number) {
    for (let t = 0; t < s; t += 0.05) {
      this.scheduler?.update(0.05);
      this.ride?.update(0.05);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    if (this.tickInterval) clearInterval(this.tickInterval);
    window.removeEventListener('resize', this.resize);
    this.controls.dispose();
    this.tiles.destroy();
    this.entrances.destroy();
    this.bikes.destroy();
    this.buses.dispose();
    this.landmarks.destroy();
    this.bikeView?.dispose();
    this.scheduler?.dispose();
    this.station?.dispose();
    this.ride?.dispose();
    this.renderer.dispose();
  }
}

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Wrap to (-PI, PI] so a bus heading crossing the seam doesn't spin the view. */
function shortAngle(a: number) { return Math.atan2(Math.sin(a), Math.cos(a)); }
