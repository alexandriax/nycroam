import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TileManager } from './TileManager';
import { PlayerControls } from './controls';
import { resolveBuildingCollision, floorAt } from './collision';
import { setupSky, setupLights, followSun, SKY } from './sky';
import { quality } from './quality';
import { makeSkylineMaterial, makeFlatMaterial, makeWaterMaterial } from './materials';
import { EntranceManager } from './EntranceManager';
import { StationWorld } from './subway/StationWorld';
import { ElevatedStationWorld } from './subway/ElevatedStationWorld';
import { TrainScheduler } from './subway/scheduler';
import { RideWorld, type RideHud } from './subway/RideWorld';
import type { StationSpec, NetworkData } from './subway/types';
import { lonLatToXZ } from './geo';
import { loadTerrain, heightAt } from './terrain';

export interface HudState {
  mode: 'street' | 'station' | 'ride';
  fly: boolean;
  prompt: string | null; // e.g. "72 St · 1·2·3"
  promptRoutes: string[];
  stationName: string | null;
  stationRoutes: string[];
  ride: RideHud | null;
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
  private controls: PlayerControls;
  private station: StationWorld | ElevatedStationWorld | null = null;
  private scheduler: TrainScheduler | null = null;
  private ride: RideWorld | null = null;
  private network: NetworkData | null = null;
  private mode: 'street' | 'station' | 'ride' = 'street';
  private pos = new THREE.Vector3(0, 0, 40); // feet position
  private returnPos = new THREE.Vector3();
  private eyeHeight = 1.7;
  private isMobile: boolean;
  private clock = new THREE.Clock();
  private raf = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private hudTimer = 0;
  private transitioning = false;
  private lastEnterGuard = 0; // avoid instant re-trigger loops
  private skyDome: THREE.Object3D | null = null;
  private lastRaf = 0;
  private tickInterval = 0;
  private envTex: THREE.Texture | null = null;
  private baseLoadRadius = 1150;
  private currentStationSpec: StationSpec | null = null;
  private atEndSince = 0;
  private sun: THREE.DirectionalLight | null = null;
  private waterUpdate: ((dt: number) => void) | null = null;
  hud: HudState = {
    mode: 'street', fly: false, prompt: null, promptRoutes: [], stationName: null,
    stationRoutes: [], ride: null, tilesLoaded: 0, tilesPending: 0, fps: 0, loading: true, error: null,
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
    this.entrances = new EntranceManager(this.streetScene);

    this.controls = new PlayerControls(canvas);
    this.controls.onToggleFly = () => {
      this.controls.fly = !this.controls.fly;
      if (this.mode === 'station') this.controls.fly = false;
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
      this.loadGround(),
      this.loadSkyline(),
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
    const q = new URLSearchParams(location.search).get('station');
    if (q) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const spec = this.entrances.findStation((s) => s.id.toLowerCase() === q.toLowerCase())
        ?? this.entrances.findStation((s) => norm(s.name).includes(norm(q)));
      if (spec) this.enterStation(spec, spec.pos);
    }
  }

  private async loadNetwork() {
    try {
      const res = await fetch('/subway/network.json');
      if (res.ok) this.network = (await res.json()) as NetworkData;
    } catch { /* riding disabled without network data */ }
  }

  private async loadGround() {
    const res = await fetch('/geo/ground.json');
    if (!res.ok) throw new Error('no ground');
    const data = await res.json();
    const tris: number[] = data.tris;
    const v2 = (data.v ?? 1) >= 2; // triples [x,z,y] instead of pairs
    const stride = v2 ? 3 : 2;
    const vcount = tris.length / stride;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);
    const g = SKY.ground;
    for (let i = 0; i < vcount; i++) {
      pos[i * 3] = tris[i * stride];
      pos[i * 3 + 1] = v2 ? tris[i * stride + 2] : 0;
      pos[i * 3 + 2] = tris[i * stride + 1];
      col[i * 3] = g.r; col[i * 3 + 1] = g.g; col[i * 3 + 2] = g.b;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // fix winding per-triangle for +y and set normals up
    const idx: number[] = [];
    for (let t = 0; t < vcount / 3; t++) {
      const a = t * 3, b = t * 3 + 1, c = t * 3 + 2;
      const cross = (pos[b * 3 + 2] - pos[a * 3 + 2]) * (pos[c * 3] - pos[a * 3])
        - (pos[b * 3] - pos[a * 3]) * (pos[c * 3 + 2] - pos[a * 3 + 2]);
      if (cross < 0) idx.push(a, c, b); else idx.push(a, b, c);
    }
    geo.setIndex(idx);
    // real normals so hills shade (v1 flat data still yields up-normals)
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, makeFlatMaterial());
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
    this.save();
  }

  private tryAction() {
    if (this.transitioning) return;
    if (this.mode === 'street') {
      const near = this.entrances.nearest(this.pos.x, this.pos.z, 4.5);
      if (near) this.enterStation(near.station, near.spec.pos);
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

  private async beginRide(route: string, dirSign: 1 | -1) {
    if (this.transitioning || !this.network || !this.currentStationSpec) return;
    this.transitioning = true;
    try {
      this.onFade?.(true);
      await wait(420);
      const startId = this.currentStationSpec.id;
      this.scheduler?.dispose();
      this.scheduler = null;
      this.station?.dispose();
      this.station = null;
      this.ride = new RideWorld(route, dirSign, startId, this.network, this.entrances.stationsMap, this.envTex);
      this.mode = 'ride';
      this.pos.set(0, 0, 0);
      this.controls.fly = false;
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

    const baseSpeed = this.mode === 'station' ? 3.6 : this.controls.fly ? 42 : 5.2;
    const speed = baseSpeed * (input.sprint ? (this.controls.fly ? 3.2 : 2.1) : 1);
    let dx = (fwd.x * input.forward + right.x * input.strafe) * speed * dt;
    let dz = (fwd.z * input.forward + right.z * input.strafe) * speed * dt;

    if (this.mode === 'street') {
      let nx = this.pos.x + dx, nz = this.pos.z + dz;
      if (!this.controls.fly) {
        [nx, nz] = resolveBuildingCollision(nx, nz, 0.42, this.tiles.collisionNear(nx, nz));
        const g = heightAt(nx, nz);
        // follow terrain smoothly (streets are graded, not stepped)
        this.pos.y += (g - this.pos.y) * Math.min(1, dt * 10);
        if (Math.abs(g - this.pos.y) < 0.02) this.pos.y = g;
      } else {
        this.pos.y = Math.max(1, Math.min(1200, this.pos.y + input.up * speed * 0.6 * dt));
      }
      this.pos.x = nx; this.pos.z = nz;

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

      // proximity prompt + auto-enter when stepping into the stairwell mouth
      const near = this.entrances.nearest(this.pos.x, this.pos.z, 5);
      if (near && !this.controls.fly) {
        this.hud.prompt = `${near.station.name}`;
        this.hud.promptRoutes = near.station.routes;
        const d = Math.hypot(near.spec.pos[0] - this.pos.x, near.spec.pos[1] - this.pos.z);
        if (d < 1.9 && performance.now() - this.lastEnterGuard > 2500 && !this.transitioning) {
          this.enterStation(near.station, near.spec.pos);
        }
      } else {
        this.hud.prompt = null;
        this.hud.promptRoutes = [];
      }
    } else if (this.mode === 'ride' && this.ride) {
      // constrained walking inside the car
      this.pos.x = Math.max(-6.8, Math.min(6.8, this.pos.x + dx));
      this.pos.z = Math.max(-1.05, Math.min(1.05, this.pos.z + dz));
      this.pos.y = 0;
      this.ride.update(dt);
      this.hud.ride = this.ride.hudInfo;
      this.hud.prompt = null;
      this.hud.promptRoutes = [];
      // end of the Manhattan run: hold the doors, then step off automatically
      if (this.ride.atEnd && this.ride.canExit) {
        if (this.atEndSince === 0) this.atEndSince = performance.now();
        else if (performance.now() - this.atEndSince > 6000) { this.atEndSince = 0; this.exitRide(); }
      } else {
        this.atEndSince = 0;
      }
    } else if (this.station) {
      // station movement: only onto walkable floors
      const st = this.station;
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
      if (inExit) {
        this.hud.prompt = 'Exit to street';
        this.hud.promptRoutes = [];
      } else if (b) {
        this.hud.prompt = `Board — ${b.dirSign === 1 ? 'Uptown' : 'Downtown'}`;
        this.hud.promptRoutes = [b.route];
      } else {
        this.hud.prompt = null;
        this.hud.promptRoutes = [];
      }
    }

    const eye = new THREE.Vector3(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
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
      localStorage.setItem('nycworld', JSON.stringify({
        x: this.pos.x, z: this.pos.z, yaw: this.controls.yaw, mode: this.mode === 'station' ? 'street' : this.mode,
      }));
    } catch { /* private mode */ }
  }

  private restore() {
    try {
      const raw = localStorage.getItem('nycworld');
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
    this.scheduler?.dispose();
    this.station?.dispose();
    this.ride?.dispose();
    this.renderer.dispose();
  }
}

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
