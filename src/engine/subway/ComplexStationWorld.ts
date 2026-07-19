// Multi-group station-complex world. Builds a walkable, transfer-navigable
// interior for a whole station complex (Times Sq, Fulton St, ...) from a
// ComplexSpec: several track GROUPS — each its own platform/track cross-section
// with its own axis (quarter-turn rotations), level and per-track service —
// connected by mezzanines, corridors and stairs. Auto-generates the MTA
// wayfinding that makes it navigable: per-track direction signs, stair-head
// signs (what's down there), transfer/exit routing signs derived from a BFS
// over the walkable-rect graph, fare lines and countdown boards.
//
// Frames: everything WALKABLE (walkBoxes, exitZones, spawn) is in world/complex
// frame — quarter-turn group rotations keep every rect axis-aligned. Visuals of
// a group live under its rotated node in group-local frame (trains included:
// each group gets its own TrainScheduler attached to its node).
import * as THREE from 'three';
import type { StationSpec, TrackInfo, NetworkData, Arrival } from './types';
import {
  makeNameMosaicTexture, makeHangingSignTexture, makeColumnSignTexture,
  makeExitSignTexture, type SignArrow,
} from './signage';
import { makeSubwayWallTexture, makeTerrazzoTexture } from '../textures';
import { makeWorldDetailMaterial } from '../materials';
import {
  buildTurnstileRow, buildBooth, buildBench, buildTrashCan, buildRotogate,
  buildStairs, buildPillar, buildMetroCardMachine, buildRailing, buildFareBarrier,
} from './props';
import type { WalkBox } from '../collision';
import { setupStationLights } from '../sky';
import { directionLabel, bothDirectionsLabel } from './directions';
import {
  rectSubtract, pickBoardPositions, PlatformCountdown, TRACK_W,
  type ExitZone,
} from './StationWorld';
import { TrainScheduler, type BoardableTrain } from './scheduler';
import type {
  ComplexSpec, GroupSpec, MezzSpec, StairSpec, TrackSpec,
} from './complextypes';
import { groupToWorld, worldToGroup, groupRectToWorld } from './complextypes';

const CEIL = 3.6; // platform-level ceiling above platform floor
const MEZZ_HEADROOM = 3.0; // mezz/corridor ceiling above its floor
const STAIR_W = 2.6;
const FLIGHT_MAX_RISE = 3.2; // longer drops get intermediate landings
const RUN_PER_RISE = 1.2; // stair steepness (matches the classic station stairs)
const ESC_RUN_PER_RISE = 1.75; // escalators are shallower, single continuous run

interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }

const rectsIntersect = (a: Rect, b: Rect) =>
  a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const rectContains = (r: Rect, x: number, z: number) =>
  x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;

const DIR_VEC: Record<'x+' | 'x-' | 'z+' | 'z-', [number, number]> = {
  'x+': [1, 0], 'x-': [-1, 0], 'z+': [0, 1], 'z-': [0, -1],
};

/** One resolved stair: full plan rect, per-flight segments, endpoints. */
interface BuiltStair {
  spec: StairSpec;
  rect: Rect; // full padded plan rect (carved from the top floor)
  topY: number;
  bottomY: number;
  bottom: [number, number]; // bottom landing center
  segs: { rect: Rect; y0: number; y1: number; axis: 'x' | 'z' }[]; // walk segments (y0 at min edge)
  width: number;
}

/** Walkable-graph node: a flat rect the player can stand on. */
interface WalkNode {
  rect: Rect;
  y: number;
  kind: 'plat' | 'mezz';
  groupIdx?: number; // plat: which group
  platIdx?: number; //  ... and which of its platforms
  mezzIdx?: number; // mezz: which spec entry
}

interface BuiltGroup {
  spec: GroupSpec;
  node: THREE.Group;
  stationSpec: StationSpec;
  trackInfo: TrackInfo;
  countdown: PlatformCountdown;
  scheduler: TrainScheduler | null;
  half: number;
  csWidth: number;
  platLocals: { zMin: number; zMax: number }[];
  platWorldRects: Rect[]; // uncarved platform rects (world)
}

export class ComplexStationWorld {
  readonly scene: THREE.Scene;
  readonly walkBoxes: WalkBox[] = [];
  readonly spawn = new THREE.Vector3();
  readonly platformSpawn = new THREE.Vector3();
  readonly exitZones: ExitZone[] = [];
  readonly name: string;
  /** Present for interface parity with StationWorld; complexes drive their own
   *  per-group countdowns from their own schedulers instead. */
  arrivalsFn?: () => Arrival[];
  /** Forwarded to every group scheduler: fires when any train pulls in. */
  onArrive: (() => void) | null = null;
  readonly groups: BuiltGroup[] = [];

  private cx: ComplexSpec;
  private stairs: BuiltStair[] = [];
  private wrapRects: { rect: Rect; y: number }[] = []; // terminal head floors
  private nodes: WalkNode[] = [];
  private edges = new Map<number, { to: number; via: 'flat' | 'stair'; stair?: BuiltStair; from: number }[]>();
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private shadowCasters: THREE.Object3D[] = [];
  private root: THREE.Group;
  private spawnByStation = new Map<string, THREE.Vector3>();
  private platformSpawnByStation = new Map<string, THREE.Vector3>();
  // sign textures are cached by content — complexes hang dozens of signs and
  // repeated labels (3 per track, shared transfer banks) must share bakes
  private signCache = new Map<string, { texture: THREE.Texture; aspect: number; mat: THREE.Material }>();

  // shared materials
  private platMat!: THREE.Material;
  private platSideMat!: THREE.Material;
  private ceilMat!: THREE.Material;
  private beamMat!: THREE.Material;
  private troughMat!: THREE.Material;
  private railMat!: THREE.Material;
  private thirdRailMat!: THREE.Material;
  private yellowMat!: THREE.Material;
  private darkMat!: THREE.Material;
  private lightMat!: THREE.Material;
  private mezzWallMat!: THREE.Material;
  private lightGeo!: THREE.BufferGeometry;

  constructor(cx: ComplexSpec, env: THREE.Texture | null = null) {
    this.cx = cx;
    this.name = cx.name;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#08090b');
    if (env) {
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.55;
    }
    this.root = new THREE.Group();
    this.scene.add(this.root);
    let extent = 40;
    for (const g of cx.groups) {
      extent = Math.max(extent, Math.abs(g.at[0]) + g.length / 2, Math.abs(g.at[1]) + g.length / 2);
    }
    setupStationLights(this.scene, Math.min(extent + 25, 160));
    this.build();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.receiveShadow = true;
    });
    for (const g of this.shadowCasters) {
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = true;
      });
    }
  }

  // ---- small helpers ------------------------------------------------------

  private track<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(t: T): T {
    this.disposables.push(t);
    return t;
  }

  private box(
    w: number, h: number, d: number, mat: THREE.Material,
    x: number, y: number, z: number, parent: THREE.Object3D,
  ) {
    const geo = this.track(new THREE.BoxGeometry(w, h, d));
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    parent.add(m);
    return m;
  }

  private freeze(o: THREE.Object3D) {
    o.traverse((c) => { c.matrixAutoUpdate = false; c.updateMatrix(); });
  }

  /**
   * Hang a black MTA sign at (x,y,z). `span` is the world axis the panel spans
   * ('x' = read walking along z, 'z' = read walking along x). `arrow` may be a
   * world direction — each face then gets the left/right arrow that points the
   * correct WORLD way for a viewer of that face. `faces`: both by default; pass
   * a single world sign ('+'/'-' along the panel's normal axis) for one-sided
   * signs (e.g. facing an approach corridor).
   */
  private hangSign(
    parent: THREE.Object3D,
    routes: string[], text: string,
    x: number, y: number, z: number,
    span: 'x' | 'z',
    arrow: SignArrow | 'wx+' | 'wx-' | 'wz+' | 'wz-' = 'none',
    faces: (1 | -1)[] = [1, -1],
  ) {
    // panel spans `span`; its normal is the other axis
    const normalAxis: 'x' | 'z' = span === 'x' ? 'z' : 'x';
    const texFor = (face: 1 | -1): { aspect: number; mat: THREE.Material } => {
      let a: SignArrow;
      if (arrow === 'wx+' || arrow === 'wx-' || arrow === 'wz+' || arrow === 'wz-') {
        const v = DIR_VEC[arrow.slice(1) as 'x+' | 'x-' | 'z+' | 'z-'];
        // screen-right of a face with world normal n is -(n x up)
        const n: [number, number] = normalAxis === 'x' ? [face, 0] : [0, face];
        const right: [number, number] = [n[1], -n[0]]; // -(n x ŷ) in (x,z)
        a = v[0] * right[0] + v[1] * right[1] > 0 ? 'right' : 'left';
      } else {
        a = arrow;
      }
      const key = `${routes.join('/')}|${text}|${a}`;
      let entry = this.signCache.get(key);
      if (!entry) {
        const t = makeHangingSignTexture({ routes, text, arrow: a, scale: 0.625 });
        this.track(t.texture);
        entry = { texture: t.texture, aspect: t.aspect, mat: this.track(new THREE.MeshBasicMaterial({ map: t.texture })) };
        this.signCache.set(key, entry);
      }
      return entry;
    };
    const g = new THREE.Group();
    for (const face of faces) {
      const t = texFor(face);
      const h = 0.5, w = Math.min(h * t.aspect, 5.2);
      const geo = this.track(new THREE.PlaneGeometry(w, h));
      const m = new THREE.Mesh(geo, t.mat);
      if (normalAxis === 'x') {
        m.rotation.y = face === 1 ? Math.PI / 2 : -Math.PI / 2;
        m.position.x = face * 0.014;
      } else {
        if (face === -1) m.rotation.y = Math.PI;
        m.position.z = face * 0.014;
      }
      g.add(m);
    }
    g.position.set(x, y, z);
    this.freeze(g);
    parent.add(g);
  }

  // ---- build orchestration ------------------------------------------------

  private build() {
    const terrazzo = makeTerrazzoTexture();
    this.platMat = this.track(makeWorldDetailMaterial(0xa8a49a, terrazzo.map, 2, 0.85));
    this.platSideMat = this.track(new THREE.MeshLambertMaterial({ color: 0x5c5c58 }));
    this.ceilMat = this.track(new THREE.MeshLambertMaterial({ color: 0xb8b6ae }));
    this.beamMat = this.track(new THREE.MeshLambertMaterial({ color: 0x4a5548 }));
    this.troughMat = this.track(new THREE.MeshLambertMaterial({ color: 0x1c1d1f }));
    this.railMat = this.track(new THREE.MeshStandardMaterial({ color: 0x9aa0a4, metalness: 0.85, roughness: 0.3 }));
    this.thirdRailMat = this.track(new THREE.MeshLambertMaterial({ color: 0x3a3630 }));
    this.yellowMat = this.track(new THREE.MeshLambertMaterial({ color: 0xf2c53d }));
    this.darkMat = this.track(new THREE.MeshBasicMaterial({ color: 0x020304 }));
    this.lightMat = this.track(new THREE.MeshBasicMaterial({ color: 0xfff6e0 }));
    this.lightGeo = this.track(new THREE.BoxGeometry(3.4, 0.08, 0.24));
    const mezzWallKit = makeSubwayWallTexture('#3d3f42');
    const mezzWallTex = mezzWallKit.map.clone();
    this.track(mezzWallTex);
    mezzWallTex.repeat.set(6, 1);
    this.mezzWallMat = this.track(new THREE.MeshStandardMaterial({
      map: mezzWallTex, roughness: 0.38, metalness: 0.03, side: THREE.DoubleSide,
    }));

    this.resolveStairs();
    this.cx.groups.forEach((g, i) => this.buildGroup(g, i));
    this.cx.mezzes.forEach((m, i) => this.buildMezz(m, i));
    this.buildStairVisuals();
    this.buildGraph();
    this.buildWayfinding();
    this.resolveSpawns();
  }

  // ---- stairs: resolve geometry first (floors need the holes) -------------

  private resolveStairs() {
    for (const s of this.cx.stairs) {
      const w = s.width ?? STAIR_W;
      const [dx, dz] = DIR_VEC[s.dir];
      const axis: 'x' | 'z' = dx !== 0 ? 'x' : 'z';
      const runPerRise = s.kind === 'escalator' ? ESC_RUN_PER_RISE : RUN_PER_RISE;
      // segment the drop into flights with landings
      const segs: BuiltStair['segs'] = [];
      let y = s.topY;
      let px = s.top[0], pz = s.top[1];
      let remaining = s.drop;
      const flights = s.kind === 'escalator' ? 1 : Math.ceil(s.drop / FLIGHT_MAX_RISE);
      const flightRise = s.drop / flights;
      while (remaining > 0.01) {
        const rise = Math.min(flightRise + 0.001, remaining);
        const run = rise * runPerRise;
        const ex = px + dx * run, ez = pz + dz * run;
        // 0.05 side tolerance: the floor hole hugs the stair flanks, so no
        // black void strip shows beside the steps (gap-free surfaces)
        const rect: Rect = {
          minX: Math.min(px, ex) - (axis === 'z' ? w / 2 + 0.05 : 0),
          maxX: Math.max(px, ex) + (axis === 'z' ? w / 2 + 0.05 : 0),
          minZ: Math.min(pz, ez) - (axis === 'x' ? w / 2 + 0.05 : 0),
          maxZ: Math.max(pz, ez) + (axis === 'x' ? w / 2 + 0.05 : 0),
        };
        // ramp y0 sits at the rect's MIN edge along the axis
        const downIsPositive = (axis === 'x' ? dx : dz) > 0;
        segs.push({
          rect,
          y0: downIsPositive ? y : y - rise,
          y1: downIsPositive ? y - rise : y,
          axis,
        });
        y -= rise;
        px = ex; pz = ez;
        remaining -= rise;
        if (remaining > 0.01) { // flat landing between flights
          const ll = 1.6;
          const lx = px + dx * ll, lz = pz + dz * ll;
          segs.push({
            rect: {
              minX: Math.min(px, lx) - (axis === 'z' ? w / 2 + 0.05 : 0),
              maxX: Math.max(px, lx) + (axis === 'z' ? w / 2 + 0.05 : 0),
              minZ: Math.min(pz, lz) - (axis === 'x' ? w / 2 + 0.05 : 0),
              maxZ: Math.max(pz, lz) + (axis === 'x' ? w / 2 + 0.05 : 0),
            },
            y0: y, y1: y, axis,
          });
          px = lx; pz = lz;
        }
      }
      // flat foot strip: the carved floor hole is padded 0.4 past the last
      // step, and that strip needs walkable floor of its own or the player
      // hits an invisible seam stepping off the stairs
      {
        const fx = px + dx * 0.7, fz = pz + dz * 0.7;
        segs.push({
          rect: {
            minX: Math.min(px, fx) - (axis === 'z' ? w / 2 + 0.05 : 0.05),
            maxX: Math.max(px, fx) + (axis === 'z' ? w / 2 + 0.05 : 0.05),
            minZ: Math.min(pz, fz) - (axis === 'x' ? w / 2 + 0.05 : 0.05),
            maxZ: Math.max(pz, fz) + (axis === 'x' ? w / 2 + 0.05 : 0.05),
          },
          y0: y, y1: y, axis,
        });
      }
      // full plan rect with a 0.4 pad behind the top edge and past the bottom
      let minX = Math.min(...segs.map((g) => g.rect.minX));
      let maxX = Math.max(...segs.map((g) => g.rect.maxX));
      let minZ = Math.min(...segs.map((g) => g.rect.minZ));
      let maxZ = Math.max(...segs.map((g) => g.rect.maxZ));
      // pad behind the TOP edge only (the flat foot strip already covers the
      // bottom); the top pad is closed by the filler ledge slab
      if (dx > 0) minX -= 0.4; else if (dx < 0) maxX += 0.4;
      if (dz > 0) minZ -= 0.4; else if (dz < 0) maxZ += 0.4;
      this.stairs.push({
        spec: s,
        rect: { minX, maxX, minZ, maxZ },
        topY: s.topY,
        bottomY: s.topY - s.drop,
        bottom: [px, pz],
        segs,
        width: w,
      });
    }
  }

  /** Plan rects (world) of stairs whose vertical span crosses `y`, for carving
   *  a floor/ceiling slab at that height. `atTop` also carves stairs STARTING
   *  exactly at y (their hole in the floor they descend from). */
  private stairHolesAt(y: number, atTop: boolean): Rect[] {
    const out: Rect[] = [];
    for (const st of this.stairs) {
      const crosses = y < st.topY - 0.01 && y > st.bottomY + 0.01;
      const starts = Math.abs(st.topY - y) < 0.01;
      if (crosses || (atTop && starts)) out.push(st.rect);
    }
    return out;
  }

  // ---- group (one line's platforms/tracks) --------------------------------

  private crossSection(g: GroupSpec): { width: number; tracks: { z: number; spec: TrackSpec }[]; platforms: { zMin: number; zMax: number }[] } {
    const platW = g.type === 'island' ? 7 : g.type === 'dual-island' ? 5.5 : 4.5;
    const n = g.tracks.length;
    // segment pattern: which platforms sit between which tracks
    const segs: ({ kind: 'track'; t: TrackSpec } | { kind: 'plat' })[] = [];
    if (g.type === 'side') {
      // single-track side stations (one platform, one track — the stacked
      // 5 Av/53 St levels) get the platform on the -z side only
      segs.push({ kind: 'plat' });
      for (const t of g.tracks) segs.push({ kind: 'track', t });
      if (n > 1) segs.push({ kind: 'plat' });
    } else if (g.type === 'island') {
      segs.push({ kind: 'track', t: g.tracks[0] });
      segs.push({ kind: 'plat' });
      for (const t of g.tracks.slice(1)) segs.push({ kind: 'track', t });
    } else { // dual-island: 4 -> t p t t p t; 3 -> t p t p t
      if (n === 3) {
        segs.push({ kind: 'track', t: g.tracks[0] }, { kind: 'plat' },
          { kind: 'track', t: g.tracks[1] }, { kind: 'plat' }, { kind: 'track', t: g.tracks[2] });
      } else {
        segs.push({ kind: 'track', t: g.tracks[0] }, { kind: 'plat' }, { kind: 'track', t: g.tracks[1] });
        for (const t of g.tracks.slice(2, -1)) segs.push({ kind: 'track', t });
        segs.push({ kind: 'track', t: g.tracks[n - 1] }, { kind: 'plat' });
        // (n===4 gives t p t t p t; the loop covers only exotic n>4)
      }
    }
    // dual-island n===4 needs the second island BETWEEN tracks 2 and 3 — fix order:
    if (g.type === 'dual-island' && n === 4) {
      segs.length = 0;
      segs.push(
        { kind: 'track', t: g.tracks[0] }, { kind: 'plat' },
        { kind: 'track', t: g.tracks[1] }, { kind: 'track', t: g.tracks[2] },
        { kind: 'plat' }, { kind: 'track', t: g.tracks[3] },
      );
    }
    const margin = 0.5;
    const width = segs.reduce((s, x) => s + (x.kind === 'track' ? TRACK_W : platW), 0) + margin * 2;
    let z = -width / 2 + margin;
    const tracks: { z: number; spec: TrackSpec }[] = [];
    const platforms: { zMin: number; zMax: number }[] = [];
    for (const s of segs) {
      const w = s.kind === 'track' ? TRACK_W : platW;
      if (s.kind === 'track') tracks.push({ z: z + w / 2, spec: s.t });
      else platforms.push({ zMin: z, zMax: z + w });
      z += w;
    }
    return { width, tracks, platforms };
  }

  private buildGroup(g: GroupSpec, gi: number) {
    const node = new THREE.Group();
    node.position.set(g.at[0], g.y, g.at[1]);
    node.rotation.y = -(g.rot * Math.PI) / 180;
    node.updateMatrix();
    this.root.add(node);

    const cs = this.crossSection(g);
    const L = g.length, half = L / 2, W = cs.width;
    const stub = g.stubEnd;
    const bumperX = stub ? stub * (half - 8) : 0;

    // stair holes that reach THIS group's level, in group-local frame
    const localHoles: Rect[] = [];
    const ceilHolesLocal: Rect[] = [];
    for (const st of this.stairs) {
      const lands = Math.abs(st.bottomY - g.y) < 0.6;
      // carve the ceiling only when the stair's occupied span actually crosses
      // it (an escalator ending on a mezz ABOVE this ceiling must not cut it)
      const crossesCeil = g.y + CEIL < st.topY - 0.01 && g.y + CEIL > st.bottomY + 0.01;
      if (!lands && !crossesCeil) continue;
      const a = worldToGroup(g, st.rect.minX, st.rect.minZ);
      const b = worldToGroup(g, st.rect.maxX, st.rect.maxZ);
      const lr: Rect = {
        minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]),
        minZ: Math.min(a[1], b[1]), maxZ: Math.max(a[1], b[1]),
      };
      if (lr.maxX < -half - 2 || lr.minX > half + 2 || lr.maxZ < -W / 2 || lr.minZ > W / 2) continue;
      if (lands) localHoles.push(lr);
      ceilHolesLocal.push(lr);
    }

    // ---- walls (tiled, with the group's band color) ----
    const wallKit = makeSubwayWallTexture(g.bandColor);
    const wallTex = wallKit.map.clone();
    this.track(wallTex);
    wallTex.repeat.set(Math.ceil(L / 7), 1);
    const wallNrm = wallKit.normal.clone();
    this.track(wallNrm);
    wallNrm.repeat.set(Math.ceil(L / 7), 1);
    const wallMat = this.track(new THREE.MeshStandardMaterial({
      map: wallTex, normalMap: wallNrm, roughness: 0.36, metalness: 0.03,
    }));
    const wallEndTex = wallKit.map.clone();
    this.track(wallEndTex);
    wallEndTex.repeat.set(Math.ceil(W / 7), 1);
    const wallEndMat = this.track(new THREE.MeshStandardMaterial({
      map: wallEndTex, roughness: 0.36, metalness: 0.03,
    }));

    // ---- track troughs + rails (stop at the bumper for stub groups) ----
    for (const t of cs.tracks) {
      const x0 = stub === -1 ? bumperX : -(L / 2 + 90);
      const x1 = stub === 1 ? bumperX : L / 2 + 90;
      const cxx = (x0 + x1) / 2, len = x1 - x0;
      this.box(len, 0.3, TRACK_W - 0.2, this.troughMat, cxx, -1.65, t.z, node);
      for (const off of [-0.72, 0.72]) {
        this.box(len, 0.16, 0.12, this.railMat, cxx, -1.2, t.z + off, node);
      }
      this.box(len, 0.1, 0.25, this.thirdRailMat, cxx, -0.95, t.z + 1.35, node);
      if (stub) {
        // bumper block: concrete base + yellow beam + red lamp
        const bg = new THREE.Group();
        this.box(1.2, 0.7, 1.6, this.platSideMat, 0, -1.15, 0, bg);
        this.box(0.5, 0.5, 2.2, this.yellowMat, 0, -0.55, 0, bg);
        const lampM = this.track(new THREE.MeshBasicMaterial({ color: 0xff2a1e }));
        this.box(0.14, 0.14, 0.14, lampM, 0, -0.2, 0, bg);
        bg.position.set(bumperX, 0, t.z);
        this.freeze(bg);
        node.add(bg);
      }
    }

    // ---- platforms ----
    for (const p of cs.platforms) {
      const pw = p.zMax - p.zMin, pc = (p.zMin + p.zMax) / 2;
      this.box(L, 1.5, pw, this.platMat, 0, -0.75, pc, node);
      this.box(L, 1.5, 0.08, this.platSideMat, 0, -0.75, p.zMin - 0.04, node);
      this.box(L, 1.5, 0.08, this.platSideMat, 0, -0.75, p.zMax + 0.04, node);
      this.box(L, 0.03, 0.55, this.yellowMat, 0, 0.015, p.zMin + 0.3, node);
      this.box(L, 0.03, 0.55, this.yellowMat, 0, 0.015, p.zMax - 0.3, node);
    }

    // ---- side walls + mosaics ----
    // A wall is pierced where a same-level mezz/corridor rect meets it (grade
    // transfer passages walk straight through); the wall is then built as
    // segments around those openings, and mosaics skip them.
    const mosaic = makeNameMosaicTexture(g.name, g.bandColor);
    this.track(mosaic.texture);
    const mosaicMat = this.track(new THREE.MeshLambertMaterial({ map: mosaic.texture }));
    for (const side of [-1, 1]) {
      const z = side * (W / 2);
      const wallSpan: [number, number] = [-(L + 90) / 2, (L + 90) / 2];
      const openings: [number, number][] = [];
      for (const m of this.cx.mezzes) {
        if (Math.abs(m.y - g.y) > 0.6) continue;
        const a = worldToGroup(g, m.rect[0], m.rect[1]);
        const b = worldToGroup(g, m.rect[2], m.rect[3]);
        const lz0 = Math.min(a[1], b[1]), lz1 = Math.max(a[1], b[1]);
        if (!(lz0 < z + 0.75 && lz1 > z - 0.75)) continue;
        const lx0 = Math.min(a[0], b[0]), lx1 = Math.max(a[0], b[0]);
        const ov = this.overlap1d(wallSpan[0], wallSpan[1], lx0, lx1);
        if (ov) openings.push(ov);
      }
      // stairs that pass through this wall (a run descending into the box from
      // an outside mezz) punch an opening too — walls stop at their flanks
      for (const st of this.stairs) {
        if (st.topY < g.y - 1.65 || st.bottomY > g.y + 5.4) continue;
        const a = worldToGroup(g, st.rect.minX, st.rect.minZ);
        const b = worldToGroup(g, st.rect.maxX, st.rect.maxZ);
        const lz0 = Math.min(a[1], b[1]), lz1 = Math.max(a[1], b[1]);
        if (!(lz0 < z + 0.4 && lz1 > z - 0.4)) continue;
        const lx0 = Math.min(a[0], b[0]), lx1 = Math.max(a[0], b[0]);
        const ov = this.overlap1d(wallSpan[0], wallSpan[1], lx0 - 0.2, lx1 + 0.2);
        if (ov) openings.push(ov);
      }
      openings.sort((p, q) => p[0] - q[0]);
      let cur = wallSpan[0];
      const spans: [number, number][] = [];
      for (const [lo, hi] of openings) {
        if (lo > cur) spans.push([cur, Math.min(lo, wallSpan[1])]);
        cur = Math.max(cur, hi);
      }
      if (cur < wallSpan[1]) spans.push([cur, wallSpan[1]]);
      for (const [x0, x1] of spans) {
        const len = x1 - x0;
        if (len < 0.25) continue;
        const wall = new THREE.Mesh(this.track(new THREE.PlaneGeometry(len, CEIL + 1.8)), wallMat);
        wall.position.set((x0 + x1) / 2, (CEIL - 1.8) / 2 + 0.15, z);
        if (side === 1) wall.rotation.y = Math.PI;
        wall.matrixAutoUpdate = false;
        wall.updateMatrix();
        node.add(wall);
      }
      const mosaicH = 0.85;
      const mosaicW = mosaicH * mosaic.aspect;
      for (let x = -half + 12; x < half - 6; x += 22) {
        if (openings.some(([lo, hi]) => x + mosaicW / 2 > lo && x - mosaicW / 2 < hi)) continue;
        const mp = new THREE.Mesh(this.track(new THREE.PlaneGeometry(mosaicW, mosaicH)), mosaicMat);
        mp.position.set(x, 1.95, z - side * 0.06);
        if (side === 1) mp.rotation.y = Math.PI;
        mp.matrixAutoUpdate = false;
        mp.updateMatrix();
        node.add(mp);
      }
    }

    // ---- end walls, portals, tunnels ----
    // A stub end gets NO wall: the platform wraps around the bumper head (the
    // Grand Central shuttle / WTC E-terminal arrangement), open toward any
    // concourse abutting beyond. The head floor fills the cross-section
    // between the platforms so every platform connects across the head.
    for (const end of [-1, 1]) {
      const x = end * (half + 0.1);
      if (stub === end) {
        const headIn = bumperX + stub * 1.6; // clear of the bumper blocks
        const headOut = stub * (half + 0.1);
        const hx0 = Math.min(headIn, headOut), hx1 = Math.max(headIn, headOut);
        if (hx1 - hx0 > 0.4) {
          const wrapRect = { minX: hx0, maxX: hx1, minZ: -W / 2 + 0.4, maxZ: W / 2 - 0.4 };
          // hole edges tuck 0.1 under the platform slabs so the wrap floor's
          // walk rects sit within adjacency range of the (inset) platform
          // rects; the sliver of coplanar overlap shares the platform material
          const platBands = cs.platforms.map((p) => ({
            minX: hx0 - 1, maxX: hx1 + 1, minZ: p.zMin + 0.1, maxZ: p.zMax - 0.1,
          }));
          for (const r of rectSubtract(wrapRect, platBands)) {
            const rw = r.maxX - r.minX, rd = r.maxZ - r.minZ;
            if (rw < 0.05 || rd < 0.05) continue;
            this.box(rw, 1.5, rd, this.platMat, (r.minX + r.maxX) / 2, -0.75, (r.minZ + r.maxZ) / 2, node);
            const wr = groupRectToWorld(g, r);
            this.walkBoxes.push({ ...wr, y: g.y });
            this.nodes.push({ rect: wr, y: g.y, kind: 'mezz' });
            this.wrapRects.push({ rect: wr, y: g.y }); // mezz walls open onto it
          }
          // railing over each track pit at the head floor's edge
          for (const t of cs.tracks) {
            const rail = buildRailing(TRACK_W);
            rail.rotation.y = Math.PI / 2;
            rail.position.set(headIn, 0, t.z);
            node.add(rail);
          }
        }
        continue;
      }
      const gaps = cs.tracks.map((t) => ({ min: t.z - 1.9, max: t.z + 1.9 }));
      gaps.sort((a, b) => a.min - b.min);
      let z = -W / 2;
      const segs: { z0: number; z1: number }[] = [];
      for (const gp of gaps) {
        if (gp.min > z) segs.push({ z0: z, z1: gp.min });
        z = Math.max(z, gp.max);
      }
      if (z < W / 2) segs.push({ z0: z, z1: W / 2 });
      for (const s of segs) {
        const wSeg = s.z1 - s.z0;
        const wall = new THREE.Mesh(this.track(new THREE.PlaneGeometry(wSeg, CEIL + 1.8)), wallEndMat);
        wall.position.set(x, (CEIL - 1.8) / 2 + 0.15, (s.z0 + s.z1) / 2);
        wall.rotation.y = end === 1 ? -Math.PI / 2 : Math.PI / 2;
        wall.matrixAutoUpdate = false;
        wall.updateMatrix();
        node.add(wall);
      }
      this.box(0.4, 1.4, W, this.ceilMat, x, CEIL - 0.7 + 0.15, 0, node);
      const tunLen = 280;
      for (const t of cs.tracks) {
        this.box(tunLen, 0.1, 4.2, this.darkMat, end * (half + tunLen / 2), CEIL - 0.4, t.z, node);
        this.box(tunLen, CEIL + 2, 0.1, this.darkMat, end * (half + tunLen / 2), 0.8, t.z - 2.05, node);
        this.box(tunLen, CEIL + 2, 0.1, this.darkMat, end * (half + tunLen / 2), 0.8, t.z + 2.05, node);
      }
    }

    // ---- ceiling (carve stair shafts) + beams ----
    const ceilRect = { minX: -half, maxX: half, minZ: -W / 2, maxZ: W / 2 };
    for (const r of rectSubtract(ceilRect, ceilHolesLocal)) {
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
      if (w < 0.05 || d < 0.05) continue;
      this.box(w, 0.18, d, this.ceilMat, (r.minX + r.maxX) / 2, CEIL + 0.09, (r.minZ + r.maxZ) / 2, node);
    }
    const beamGeo = this.track(new THREE.BoxGeometry(0.3, 0.35, W));
    for (let x = -half + 4; x < half; x += 4.6) {
      if (ceilHolesLocal.some((h) => x > h.minX - 0.3 && x < h.maxX + 0.3)) continue;
      const beam = new THREE.Mesh(beamGeo, this.beamMat);
      beam.position.set(x, CEIL - 0.18, 0);
      beam.matrixAutoUpdate = false;
      beam.updateMatrix();
      node.add(beam);
    }

    // ---- columns, signs, lights, furniture, boards per platform ----
    const colSign = makeColumnSignTexture(g.name);
    this.track(colSign.texture);
    const colSignMat = this.track(new THREE.MeshLambertMaterial({ map: colSign.texture }));
    const blockedByStair = (x: number, cz: number) =>
      localHoles.some((h) => x > h.minX - 0.3 && x < h.maxX + 0.3 && cz > h.minZ - 0.3 && cz < h.maxZ + 0.3);
    let colIdx = 0;
    for (const p of cs.platforms) {
      const cz = (p.zMin + p.zMax) / 2;
      for (let x = -half + 6; x < half - 2; x += 4.6) {
        if (blockedByStair(x, cz)) continue;
        const pillar = buildPillar(CEIL, '#1f4d3d');
        pillar.position.set(x, 0, cz);
        node.add(pillar);
        this.shadowCasters.push(pillar);
        if (colIdx % 3 === 0) {
          const sw = 0.62, sh = sw / colSign.aspect;
          for (const face of [-1, 1]) {
            const sp = new THREE.Mesh(this.track(new THREE.PlaneGeometry(sw, sh)), colSignMat);
            sp.position.set(x, 1.75, cz + face * 0.16);
            if (face === -1) sp.rotation.y = Math.PI;
            sp.matrixAutoUpdate = false;
            sp.updateMatrix();
            node.add(sp);
          }
        }
        colIdx++;
      }
      for (let x = -half + 3; x < half; x += 4.6) {
        if (ceilHolesLocal.some((h) => x > h.minX - 0.3 && x < h.maxX + 0.3
          && cz > h.minZ - 1.8 && cz < h.maxZ + 1.8)) continue;
        const strip = new THREE.Mesh(this.lightGeo, this.lightMat);
        strip.position.set(x, CEIL - 0.06, cz);
        strip.matrixAutoUpdate = false;
        strip.updateMatrix();
        node.add(strip);
      }
      // benches + trash (skip any that would clip a stair)
      for (const bx of [-L / 3, 0, L / 3]) {
        if (!blockedByStair(bx, cz + 1.2)) {
          const bench = buildBench();
          bench.position.set(bx, 0, cz + 1.2);
          node.add(bench);
          this.shadowCasters.push(bench);
        }
        if (!blockedByStair(bx + 3, cz - 1.2)) {
          const trash = buildTrashCan();
          trash.position.set(bx + 3, 0, cz - 1.2);
          node.add(trash);
          this.shadowCasters.push(trash);
        }
      }
    }

    // ---- board + sign x-positions (group-local x, picked together) ----
    // Boards run a ~33m cadence; the 4-5 per-edge direction signs a ~40m cadence,
    // so their bases stagger and the blocked() predicate slides off any residual
    // collision, the pillar lines and the stair wells.
    const pillarBlocked = (x: number) => {
      const nearestPillar = -half + 6 + Math.round((x - (-half + 6)) / 4.6) * 4.6;
      return Math.abs(x - nearestPillar) < 0.6;
    };
    const stairBlockedX = (x: number) =>
      localHoles.some((h) => x > h.minX - 0.5 && x < h.maxX + 0.5);
    const boardCount = Math.max(2, Math.round(L / 33));
    const boardXs = pickBoardPositions(
      half, boardCount, (x) => pillarBlocked(x) || stairBlockedX(x), half - 4,
    );
    const signCount = Math.max(4, Math.round(L / 40));
    const signXs = pickBoardPositions(
      half, signCount,
      (x) => stairBlockedX(x) || boardXs.some((bx) => Math.abs(x - bx) < 2.4),
      half - 4,
    );

    // ---- per-track hanging direction signs (ONLY that track's routes) ----
    // Face PARALLEL to the track (span 'x' => normal on z), readable standing on
    // the platform looking across it; 4-5 evenly along the platform per edge.
    const stopTracks = cs.tracks.filter((t) => !t.spec.pass);
    for (const p of cs.platforms) {
      for (const t of stopTracks) {
        const nearMin = Math.abs(t.z - p.zMin) < TRACK_W * 0.8;
        const nearMax = Math.abs(t.z - p.zMax) < TRACK_W * 0.8;
        if (!nearMin && !nearMax) continue;
        const edgeZ = nearMin ? p.zMin + 0.55 : p.zMax - 0.55;
        const label = directionLabel(t.spec.routes, t.spec.dir, g.name);
        for (const sx of signXs) {
          if (localHoles.some((h) => sx > h.minX - 1 && sx < h.maxX + 1
            && edgeZ > h.minZ - 1 && edgeZ < h.maxZ + 1)) continue;
          this.hangSign(node, t.spec.routes, label, sx, CEIL - 0.55, edgeZ, 'x');
        }
      }
    }

    // ---- countdown boards ----
    const countdown = new PlatformCountdown(g.name);
    for (const p of cs.platforms) {
      const dirs = new Set<1 | -1>();
      for (const t of stopTracks) {
        if (Math.abs(t.z - p.zMin) < TRACK_W * 0.8 || Math.abs(t.z - p.zMax) < TRACK_W * 0.8) dirs.add(t.spec.dir);
      }
      if (dirs.size === 0) continue;
      countdown.addPlatform(
        (r) => this.track(r), node, g.routes, [...dirs], boardXs, 2.6, (p.zMin + p.zMax) / 2,
      );
    }

    // ---- platform walkboxes (world frame, minus stair feet) ----
    const platWorldRects: Rect[] = [];
    const platLocals: { zMin: number; zMax: number }[] = [];
    for (const p of cs.platforms) {
      platLocals.push({ zMin: p.zMin, zMax: p.zMax });
      const inset = { minX: -half + 0.4, maxX: half - 0.4, minZ: p.zMin + 0.35, maxZ: p.zMax - 0.35 };
      const wr = groupRectToWorld(g, inset);
      platWorldRects.push(wr);
      const feet = this.stairs
        .filter((st) => Math.abs(st.bottomY - g.y) < 0.6 && rectsIntersect(st.rect, wr))
        .map((st) => st.rect);
      for (const r of rectSubtract(wr, feet)) {
        if (r.maxX - r.minX < 0.05 || r.maxZ - r.minZ < 0.05) continue;
        this.walkBoxes.push({ ...r, y: g.y });
      }
      this.nodes.push({ rect: wr, y: g.y, kind: 'plat', groupIdx: gi, platIdx: platLocals.length - 1 });
    }

    // ---- stair shaft walls platform-ceiling -> whatever is above ----
    for (const st of this.stairs) {
      if (Math.abs(st.bottomY - g.y) > 0.6) continue;
      const wr = st.rect;
      if (!platWorldRects.some((pr) => rectsIntersect(pr, wr))) continue;
      const yBot = g.y + CEIL, yTop = st.topY;
      if (yTop - yBot < 0.3) continue;
      const sh = yTop - yBot, cy = yBot + sh / 2;
      const cxx = (wr.minX + wr.maxX) / 2, czz = (wr.minZ + wr.maxZ) / 2;
      const wx = wr.maxX - wr.minX, wz = wr.maxZ - wr.minZ;
      const [ddx, ddz] = DIR_VEC[st.spec.dir];
      // wall the two flanks + the far (bottom) end; the top end stays open into
      // the floor above (that's where the stair arrives). Tiled, not dark —
      // deep shafts (Herald Sq's 9m wells) read as lit stairwells, not voids.
      if (ddx !== 0) {
        this.box(wx, sh, 0.12, this.mezzWallMat, cxx, cy, wr.minZ, this.root);
        this.box(wx, sh, 0.12, this.mezzWallMat, cxx, cy, wr.maxZ, this.root);
        this.box(0.12, sh, wz, this.mezzWallMat, ddx > 0 ? wr.maxX : wr.minX, cy, czz, this.root);
      } else {
        this.box(0.12, sh, wz, this.mezzWallMat, wr.minX, cy, czz, this.root);
        this.box(0.12, sh, wz, this.mezzWallMat, wr.maxX, cy, czz, this.root);
        this.box(wx, sh, 0.12, this.mezzWallMat, cxx, cy, ddz > 0 ? wr.maxZ : wr.minZ, this.root);
      }
    }

    // ---- scheduler geometry ----
    const stopping = cs.tracks.filter((t) => !t.spec.pass);
    const passing = cs.tracks.filter((t) => t.spec.pass);
    const platformSides: (1 | -1)[] = stopping.map((t) => {
      let bestC = t.z, bestD = Infinity;
      for (const p of cs.platforms) {
        const pc = (p.zMin + p.zMax) / 2;
        const d = Math.abs(pc - t.z);
        if (d < bestD) { bestD = d; bestC = pc; }
      }
      const s = Math.sign(bestC - t.z);
      return (s === 0 ? 1 : s) as 1 | -1;
    });
    const trackInfo: TrackInfo = {
      trackZs: stopping.map((t) => t.z),
      trackDirs: stopping.map((t) => t.spec.dir),
      platformSides,
      trackRoutes: stopping.map((t) => t.spec.routes),
      trackFlips: stopping.map((t) => t.spec.flip ?? false),
      passTrackZs: passing.length ? passing.map((t) => t.z) : undefined,
      passTrackRoutes: passing.length ? passing.map((t) => t.spec.routes) : undefined,
      passTrackDirs: passing.length ? passing.map((t) => t.spec.dir) : undefined,
      stubEnd: g.stubEnd,
      railY: -1.1,
      half,
      portal: half + 45,
    };
    const stationSpec: StationSpec = {
      id: g.id,
      complexId: this.cx.complexId,
      name: g.name,
      routes: g.routes,
      structure: 'Subway',
      division: g.division,
      pos: [g.at[0], g.at[1]],
      layout: {
        type: g.type,
        tracks: Math.min(4, Math.max(2, g.tracks.length)) as 2 | 3 | 4,
        passTracks: Math.min(2, passing.length) as 0 | 1 | 2,
        platformLength: g.length,
        depth: 14,
        bandColor: g.bandColor,
      },
    };

    // platform spawn for this group (post-ride drop-off)
    const p0 = cs.platforms[0];
    const pw0 = groupToWorld(g, 4, (p0.zMin + p0.zMax) / 2);
    this.platformSpawnByStation.set(g.id, new THREE.Vector3(pw0[0], g.y, pw0[1]));

    this.groups.push({
      spec: g, node, stationSpec, trackInfo, countdown, scheduler: null,
      half, csWidth: W, platLocals, platWorldRects,
    });
  }

  // ---- mezzanines / corridors ---------------------------------------------

  private buildMezz(m: MezzSpec, mi: number) {
    const [minX, minZ, maxX, maxZ] = m.rect;
    const rect: Rect = { minX, maxX, minZ, maxZ };
    const w = maxX - minX, d = maxZ - minZ;
    const cxx = (minX + maxX) / 2, czz = (minZ + maxZ) / 2;

    // floor: carve stairs starting here or passing through
    const holes = this.stairHolesAt(m.y, true).filter((h) => rectsIntersect(h, rect));
    for (const r of rectSubtract(rect, holes)) {
      const rw = r.maxX - r.minX, rd = r.maxZ - r.minZ;
      if (rw < 0.05 || rd < 0.05) continue;
      this.box(rw, 0.5, rd, this.platMat, (r.minX + r.maxX) / 2, m.y - 0.25, (r.minZ + r.maxZ) / 2, this.root);
    }
    for (const r of rectSubtract(rect, holes)) {
      const rw = r.maxX - r.minX, rd = r.maxZ - r.minZ;
      if (rw < 0.05 || rd < 0.05) continue;
      this.walkBoxes.push({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ, y: m.y });
    }
    this.nodes.push({ rect, y: m.y, kind: 'mezz', mezzIdx: mi });

    // railings around stair holes (skip the entering edge of each stair)
    for (const st of this.stairs) {
      if (Math.abs(st.topY - m.y) > 0.01 || !rectsIntersect(st.rect, rect)) continue;
      const hr = st.rect;
      const [ddx, ddz] = DIR_VEC[st.spec.dir];
      const edges: { x?: number; z?: number; skip: boolean }[] = [
        { z: hr.minZ, skip: ddz < 0 }, // stair enters from -z side when descending z-
        { z: hr.maxZ, skip: ddz > 0 },
        { x: hr.minX, skip: ddx < 0 },
        { x: hr.maxX, skip: ddx > 0 },
      ];
      for (const e of edges) {
        // the top edge (behind the first step) also stays open for entry:
        // entry edge is OPPOSITE the descent direction
        const isEntry = (e.z !== undefined && ((ddz > 0 && e.z === hr.minZ) || (ddz < 0 && e.z === hr.maxZ)))
          || (e.x !== undefined && ((ddx > 0 && e.x === hr.minX) || (ddx < 0 && e.x === hr.maxX)));
        if (isEntry) continue;
        if (e.z !== undefined) {
          const rail = buildRailing(hr.maxX - hr.minX);
          rail.position.set((hr.minX + hr.maxX) / 2, m.y, e.z);
          this.root.add(rail);
        } else if (e.x !== undefined) {
          const rail = buildRailing(hr.maxZ - hr.minZ);
          rail.rotation.y = Math.PI / 2;
          rail.position.set(e.x, m.y, (hr.minZ + hr.maxZ) / 2);
          this.root.add(rail);
        }
      }
    }

    // ceiling with holes for exit shafts + stairs from above
    if (!m.openTop) {
      const ceilY = m.y + MEZZ_HEADROOM;
      const ceilHoles = this.stairHolesAt(ceilY, false).filter((h) => rectsIntersect(h, rect));
      for (const ex of m.exits ?? []) {
        const [dx, dz] = DIR_VEC[ex.dir];
        const run = 4.5;
        ceilHoles.push({
          minX: ex.at[0] + Math.min(0, dx * run) - (dz !== 0 ? STAIR_W / 2 + 0.3 : 0.45),
          maxX: ex.at[0] + Math.max(0, dx * run) + (dz !== 0 ? STAIR_W / 2 + 0.3 : 0.45),
          minZ: ex.at[1] + Math.min(0, dz * run) - (dx !== 0 ? STAIR_W / 2 + 0.3 : 0.45),
          maxZ: ex.at[1] + Math.max(0, dz * run) + (dx !== 0 ? STAIR_W / 2 + 0.3 : 0.45),
        });
      }
      for (const r of rectSubtract(rect, ceilHoles)) {
        const rw = r.maxX - r.minX, rd = r.maxZ - r.minZ;
        if (rw < 0.05 || rd < 0.05) continue;
        this.box(rw, 0.15, rd, this.ceilMat, (r.minX + r.maxX) / 2, ceilY + 0.07, (r.minZ + r.maxZ) / 2, this.root);
      }
      // light strips in rows across the mezz
      const rows = Math.max(1, Math.round(d / 8));
      for (let ri = 0; ri < rows; ri++) {
        const z = minZ + (d * (ri + 0.5)) / rows;
        for (let x = minX + 2.4; x < maxX - 1; x += 4.2) {
          if (holes.some((h) => x > h.minX - 0.3 && x < h.maxX + 0.3 && z > h.minZ - 0.3 && z < h.maxZ + 0.3)) continue;
          const strip = new THREE.Mesh(this.lightGeo, this.lightMat);
          strip.position.set(x, ceilY - 0.06, z);
          strip.matrixAutoUpdate = false;
          strip.updateMatrix();
          this.root.add(strip);
        }
      }
    }

    // perimeter walls with openings where another mezz abuts / a stair crosses
    this.buildMezzWalls(m, rect);

    // fare line
    if (m.fare) this.buildFareLine(m, rect);

    // street exits
    for (const ex of m.exits ?? []) this.buildExit(m, ex);
  }

  private overlap1d(a0: number, a1: number, b0: number, b1: number): [number, number] | null {
    const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
    return hi - lo > 1.2 ? [lo, hi] : null;
  }

  private buildMezzWalls(m: MezzSpec, rect: Rect) {
    const wallH = MEZZ_HEADROOM;
    interface Edge { axis: 'x' | 'z'; at: number; lo: number; hi: number; inward: 1 | -1 }
    const edges: Edge[] = [
      { axis: 'z', at: rect.minZ, lo: rect.minX, hi: rect.maxX, inward: 1 },
      { axis: 'z', at: rect.maxZ, lo: rect.minX, hi: rect.maxX, inward: -1 },
      { axis: 'x', at: rect.minX, lo: rect.minZ, hi: rect.maxZ, inward: 1 },
      { axis: 'x', at: rect.maxX, lo: rect.minZ, hi: rect.maxZ, inward: -1 },
    ];
    for (const e of edges) {
      // openings: other mezz rects sharing this edge at the same level
      const open: [number, number][] = [];
      this.cx.mezzes.forEach((o) => {
        if (o === m || Math.abs(o.y - m.y) > 0.6) return;
        const [oMinX, oMinZ, oMaxX, oMaxZ] = o.rect;
        if (e.axis === 'z') {
          if (Math.abs(oMinZ - e.at) < 0.31 || Math.abs(oMaxZ - e.at) < 0.31
            || (oMinZ < e.at && oMaxZ > e.at)) {
            const ov = this.overlap1d(e.lo, e.hi, oMinX, oMaxX);
            if (ov) open.push(ov);
          }
        } else {
          if (Math.abs(oMinX - e.at) < 0.31 || Math.abs(oMaxX - e.at) < 0.31
            || (oMinX < e.at && oMaxX > e.at)) {
            const ov = this.overlap1d(e.lo, e.hi, oMinZ, oMaxZ);
            if (ov) open.push(ov);
          }
        }
      });
      // openings where a stair rect crosses this edge near this level
      for (const st of this.stairs) {
        if (st.topY < m.y - 0.5 || st.bottomY > m.y + 0.5) continue;
        const hr = st.rect;
        if (e.axis === 'z') {
          if (hr.minZ < e.at && hr.maxZ > e.at) {
            const ov = this.overlap1d(e.lo, e.hi, hr.minX, hr.maxX);
            if (ov) open.push(ov);
          }
        } else if (hr.minX < e.at && hr.maxX > e.at) {
          const ov = this.overlap1d(e.lo, e.hi, hr.minZ, hr.maxZ);
          if (ov) open.push(ov);
        }
      }
      // openings where a PLATFORM or a terminal head floor abuts at the same
      // level (grade transfer passages / the GC-shuttle "walk straight on")
      const abutRects: { rect: Rect; y: number }[] = [...this.wrapRects];
      for (const g of this.groups) {
        for (const pr of g.platWorldRects) abutRects.push({ rect: pr, y: g.spec.y });
      }
      for (const ar of abutRects) {
        if (Math.abs(ar.y - m.y) > 0.6) continue;
        const pr = ar.rect;
        if (e.axis === 'z') {
          if (Math.abs(pr.minZ - e.at) < 0.75 || Math.abs(pr.maxZ - e.at) < 0.75
            || (pr.minZ < e.at && pr.maxZ > e.at)) {
            const ov = this.overlap1d(e.lo, e.hi, pr.minX, pr.maxX);
            if (ov) open.push(ov);
          }
        } else if (Math.abs(pr.minX - e.at) < 0.75 || Math.abs(pr.maxX - e.at) < 0.75
          || (pr.minX < e.at && pr.maxX > e.at)) {
          const ov = this.overlap1d(e.lo, e.hi, pr.minZ, pr.maxZ);
          if (ov) open.push(ov);
        }
      }
      open.sort((a, b) => a[0] - b[0]);
      let cur = e.lo;
      const spans: [number, number][] = [];
      for (const [lo, hi] of open) {
        if (lo > cur) spans.push([cur, Math.min(lo, e.hi)]);
        cur = Math.max(cur, hi);
      }
      if (cur < e.hi) spans.push([cur, e.hi]);
      for (const [lo, hi] of spans) {
        const len = hi - lo;
        if (len < 0.25) continue;
        const mid = (lo + hi) / 2;
        if (e.axis === 'z') {
          this.box(len, wallH, 0.12, this.mezzWallMat, mid, m.y + wallH / 2, e.at + e.inward * 0.06, this.root);
        } else {
          this.box(0.12, wallH, len, this.mezzWallMat, e.at + e.inward * 0.06, m.y + wallH / 2, mid, this.root);
        }
      }
    }
  }

  private buildFareLine(m: MezzSpec, rect: Rect) {
    const fare = m.fare!;
    const spanAxis: 'x' | 'z' = fare.cross === 'x' ? 'z' : 'x'; // the axis the LINE spans
    const lo = spanAxis === 'z' ? rect.minZ : rect.minX;
    const hi = spanAxis === 'z' ? rect.maxZ : rect.maxX;
    const span = hi - lo;
    const mid = (lo + hi) / 2;
    const at = fare.at;
    const place = (obj: THREE.Group, s: number, rotBase: number) => {
      obj.rotation.y = rotBase;
      if (spanAxis === 'z') obj.position.set(at, m.y, s);
      else obj.position.set(s, m.y, at);
      this.root.add(obj);
      this.shadowCasters.push(obj);
    };
    // props' local +x spans the line; rotate π/2 when the line spans world z
    const rotBase = spanAxis === 'z' ? Math.PI / 2 : 0;
    const nGates = Math.max(3, Math.min(6, Math.floor(span / 3.2)));
    const tsHalf = (nGates * 0.85) / 2;
    place(buildTurnstileRow(nGates), mid, rotBase);
    const boothHalf = 1.1;
    const boothS = mid - (tsHalf + boothHalf);
    place(buildBooth(), boothS, rotBase);
    const rotoHalf = 0.6;
    const rotoS = mid + tsHalf + rotoHalf;
    place(buildRotogate(), rotoS, 0);
    const spans: [number, number][] = [
      [lo, boothS - boothHalf],
      [rotoS + rotoHalf, hi],
    ];
    for (const [s0, s1] of spans) {
      const len = s1 - s0;
      if (len < 0.1) continue;
      const bar = buildFareBarrier(len);
      place(bar, (s0 + s1) / 2, rotBase);
    }
    // MetroCard machines on the unpaid side, backed near the wall
    const unpaid = at - fare.paidSign * 2.6;
    for (let i = 0; i < 3; i++) {
      const mvm = buildMetroCardMachine();
      const s = lo + 1.2 + i * 1.1;
      if (fare.cross === 'x') {
        mvm.rotation.y = fare.paidSign === 1 ? Math.PI / 2 : -Math.PI / 2;
        mvm.position.set(unpaid, m.y, s);
      } else {
        mvm.rotation.y = fare.paidSign === 1 ? 0 : Math.PI;
        mvm.position.set(s, m.y, unpaid);
      }
      this.root.add(mvm);
    }
    // overhead signs: unpaid face lists every line here; paid face marks the
    // exit. Face signs are along the crossing axis (the panel's normal axis):
    // the unpaid side sits at -paidSign, so that face gets the route bank.
    const allRoutes = [...new Set(this.cx.groups.flatMap((g) => g.routes))].slice(0, 8);
    const signPos: [number, number] = fare.cross === 'x' ? [at, mid] : [mid, at];
    this.hangSign(
      this.root, allRoutes, 'All trains', signPos[0], m.y + 2.45, signPos[1],
      spanAxis, 'none', [-fare.paidSign as 1 | -1],
    );
    this.hangSign(
      this.root, [], 'Exit', signPos[0], m.y + 2.45, signPos[1],
      spanAxis, 'none', [fare.paidSign],
    );
  }

  private buildExit(m: MezzSpec, ex: { at: [number, number]; dir: 'x+' | 'x-' | 'z+' | 'z-' }) {
    const [dx, dz] = DIR_VEC[ex.dir];
    const rise = 3.2, run = 4.5;
    const axis: 'x' | 'z' = dx !== 0 ? 'x' : 'z';
    const stair = buildStairs(STAIR_W, rise, run);
    // buildStairs ascends toward local -z; rotate so it ascends toward `dir`
    stair.rotation.y = dx > 0 ? -Math.PI / 2 : dx < 0 ? Math.PI / 2 : dz > 0 ? Math.PI : 0;
    stair.position.set(ex.at[0], m.y, ex.at[1]);
    this.root.add(stair);
    const top: [number, number] = [ex.at[0] + dx * run, ex.at[1] + dz * run];
    const rect: Rect = {
      minX: Math.min(ex.at[0], top[0]) - (axis === 'z' ? STAIR_W / 2 + 0.3 : 0.45),
      maxX: Math.max(ex.at[0], top[0]) + (axis === 'z' ? STAIR_W / 2 + 0.3 : 0.45),
      minZ: Math.min(ex.at[1], top[1]) - (axis === 'x' ? STAIR_W / 2 + 0.3 : 0.45),
      maxZ: Math.max(ex.at[1], top[1]) + (axis === 'x' ? STAIR_W / 2 + 0.3 : 0.45),
    };
    const upIsPositive = (axis === 'x' ? dx : dz) > 0;
    this.walkBoxes.push({
      ...rect,
      y: m.y,
      ramp: { axis, y0: upIsPositive ? m.y : m.y + rise, y1: upIsPositive ? m.y + rise : m.y },
    });
    const zoneHalf = 0.8;
    this.exitZones.push({
      minX: top[0] - (axis === 'x' ? zoneHalf : STAIR_W / 2),
      maxX: top[0] + (axis === 'x' ? zoneHalf : STAIR_W / 2),
      minZ: top[1] - (axis === 'z' ? zoneHalf : STAIR_W / 2),
      maxZ: top[1] + (axis === 'z' ? zoneHalf : STAIR_W / 2),
      y: m.y + rise,
    });
    // railings along the run's flanks
    for (const side of [-1, 1]) {
      const rail = buildRailing(run + 0.8);
      if (axis === 'x') {
        rail.position.set((ex.at[0] + top[0]) / 2, m.y, ex.at[1] + side * (STAIR_W / 2 + 0.3));
      } else {
        rail.rotation.y = Math.PI / 2;
        rail.position.set(ex.at[0] + side * (STAIR_W / 2 + 0.3), m.y, (ex.at[1] + top[1]) / 2);
      }
      this.root.add(rail);
    }
    // lit shaft rising from the mezz ceiling to a bright street opening
    {
      const yBot = m.y + MEZZ_HEADROOM, yTop = m.y + rise + 1.8, sh = yTop - yBot;
      const cxx = (rect.minX + rect.maxX) / 2, czz = (rect.minZ + rect.maxZ) / 2;
      const wx = rect.maxX - rect.minX, wz = rect.maxZ - rect.minZ;
      if (axis === 'x') {
        this.box(wx, sh, 0.1, this.platSideMat, cxx, yBot + sh / 2, rect.minZ, this.root);
        this.box(wx, sh, 0.1, this.platSideMat, cxx, yBot + sh / 2, rect.maxZ, this.root);
        this.box(0.1, sh, wz, this.lightMat, dx > 0 ? rect.maxX : rect.minX, yBot + sh / 2, czz, this.root);
      } else {
        this.box(0.1, sh, wz, this.platSideMat, rect.minX, yBot + sh / 2, czz, this.root);
        this.box(0.1, sh, wz, this.platSideMat, rect.maxX, yBot + sh / 2, czz, this.root);
        this.box(wx, sh, 0.1, this.lightMat, cxx, yBot + sh / 2, dz > 0 ? rect.maxZ : rect.minZ, this.root);
      }
      this.box(wx, 0.12, wz, this.lightMat, cxx, yTop, czz, this.root);
    }
    // EXIT plate over the foot of the stairs — two back-to-back front-facing
    // quads (a single DoubleSide plane mirrors the lettering on its far face)
    const exitInfo = makeExitSignTexture(true);
    this.track(exitInfo.texture);
    const exitMat = this.track(new THREE.MeshLambertMaterial({ map: exitInfo.texture }));
    const sh2 = 0.42, sw2 = sh2 * exitInfo.aspect;
    const signGeo = this.track(new THREE.PlaneGeometry(sw2, sh2));
    const signG = new THREE.Group();
    for (const face of [1, -1] as const) {
      const m2 = new THREE.Mesh(signGeo, exitMat);
      if (axis === 'x') {
        m2.rotation.y = face === 1 ? Math.PI / 2 : -Math.PI / 2;
        m2.position.x = face * 0.012;
      } else {
        if (face === -1) m2.rotation.y = Math.PI;
        m2.position.z = face * 0.012;
      }
      signG.add(m2);
    }
    signG.position.set(ex.at[0] - dx * 0.9, m.y + 2.3, ex.at[1] - dz * 0.9);
    this.freeze(signG);
    this.root.add(signG);
  }

  // ---- stair visuals + walk ramps -----------------------------------------

  private buildStairVisuals() {
    for (const st of this.stairs) {
      const [dx, dz] = DIR_VEC[st.spec.dir];
      const axis: 'x' | 'z' = dx !== 0 ? 'x' : 'z';
      const esc = st.spec.kind === 'escalator';
      for (const seg of st.segs) {
        const isFlat = Math.abs(seg.y0 - seg.y1) < 0.01;
        const w = st.width;
        const topY = Math.max(seg.y0, seg.y1);
        const botY = Math.min(seg.y0, seg.y1);
        const rise = topY - botY;
        const run = axis === 'x' ? seg.rect.maxX - seg.rect.minX : seg.rect.maxZ - seg.rect.minZ;
        const cxx = (seg.rect.minX + seg.rect.maxX) / 2;
        const czz = (seg.rect.minZ + seg.rect.maxZ) / 2;
        if (isFlat) {
          this.box(seg.rect.maxX - seg.rect.minX, 0.5, seg.rect.maxZ - seg.rect.minZ,
            this.platMat, cxx, seg.y0 - 0.25, czz, this.root);
        } else if (esc) {
          // escalator bank: continuous ribbed incline + stainless balustrades
          const inc = new THREE.Group();
          const len = Math.hypot(run, rise);
          const slabGeo = this.track(new THREE.BoxGeometry(len, 0.35, w));
          const slabMat = this.track(new THREE.MeshStandardMaterial({ color: 0x707478, metalness: 0.6, roughness: 0.4 }));
          const slab = new THREE.Mesh(slabGeo, slabMat);
          inc.add(slab);
          const balGeo = this.track(new THREE.BoxGeometry(len, 0.95, 0.08));
          const balMat = this.track(new THREE.MeshStandardMaterial({ color: 0x2a2c2e, metalness: 0.5, roughness: 0.5 }));
          for (const side of [-1, 1]) {
            const bal = new THREE.Mesh(balGeo, balMat);
            bal.position.set(0, 0.62, side * (w / 2 - 0.04));
            inc.add(bal);
          }
          // rib the deck so it reads as steps
          const ribGeo = this.track(new THREE.BoxGeometry(0.06, 0.03, w - 0.2));
          const ribMat = this.track(new THREE.MeshLambertMaterial({ color: 0x9aa0a4 }));
          for (let s = -len / 2 + 0.4; s < len / 2 - 0.2; s += 0.55) {
            const rib = new THREE.Mesh(ribGeo, ribMat);
            rib.position.set(s, 0.19, 0);
            inc.add(rib);
          }
          const midY = (topY + botY) / 2;
          inc.position.set(cxx, midY - 0.05, czz);
          // point local +x down-slope along the descent direction
          const down = new THREE.Vector3(dx * run, -rise, dz * run).normalize();
          inc.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), down);
          this.freeze(inc);
          this.root.add(inc);
          this.shadowCasters.push(inc);
        } else {
          const stairG = buildStairs(w, rise, run);
          // buildStairs origin = bottom front edge, ascends toward -z
          stairG.rotation.y = dx > 0 ? Math.PI / 2 : dx < 0 ? -Math.PI / 2 : dz > 0 ? 0 : Math.PI;
          const bx = axis === 'x' ? (dx > 0 ? seg.rect.maxX : seg.rect.minX) : cxx;
          const bz = axis === 'z' ? (dz > 0 ? seg.rect.maxZ : seg.rect.minZ) : czz;
          stairG.position.set(bx, botY, bz);
          this.root.add(stairG);
          this.shadowCasters.push(stairG);
        }
        // walk ramp/flat box for the segment
        this.walkBoxes.push(isFlat
          ? { ...seg.rect, y: seg.y0 }
          : { ...seg.rect, y: botY, ramp: { axis: seg.axis, y0: seg.y0, y1: seg.y1 } });
      }
      // filler ledges at the TOP floor: close the pad behind the first step and
      // thin side margins so the floor meets the stairs with no black slivers
      {
        const first = st.segs[0];
        const w = st.width;
        if (dx !== 0) {
          const padX = dx > 0 ? st.rect.minX : first.rect.maxX;
          const padW = dx > 0 ? first.rect.minX - st.rect.minX : st.rect.maxX - first.rect.maxX;
          if (padW > 0.05) {
            this.box(padW, 0.5, w + 0.6, this.platMat, padX + padW / 2, st.topY - 0.25, (st.rect.minZ + st.rect.maxZ) / 2, this.root);
            this.walkBoxes.push({
              minX: padX, maxX: padX + padW,
              minZ: st.rect.minZ, maxZ: st.rect.maxZ, y: st.topY,
            });
          }
        } else {
          const padZ = dz > 0 ? st.rect.minZ : first.rect.maxZ;
          const padD = dz > 0 ? first.rect.minZ - st.rect.minZ : st.rect.maxZ - first.rect.maxZ;
          if (padD > 0.05) {
            this.box(w + 0.6, 0.5, padD, this.platMat, (st.rect.minX + st.rect.maxX) / 2, st.topY - 0.25, padZ + padD / 2, this.root);
            this.walkBoxes.push({
              minX: st.rect.minX, maxX: st.rect.maxX,
              minZ: padZ, maxZ: padZ + padD, y: st.topY,
            });
          }
        }
      }
      // validate the bottom lands on real floor (platform or mezz)
      const [bx2, bz2] = st.bottom;
      const landed = this.nodes.some((n) =>
        Math.abs(n.y - st.bottomY) < 0.6 && rectContains(n.rect, bx2, bz2))
        || this.groups.some((g) => Math.abs(g.spec.y - st.bottomY) < 0.6
          && g.platWorldRects.some((r) => rectContains(r, bx2, bz2)));
      if (!landed) {
        console.warn(`[complex ${this.cx.name}] stair at (${st.spec.top[0]},${st.spec.top[1]}) lands on NOTHING at y=${st.bottomY} (${bx2.toFixed(1)},${bz2.toFixed(1)})`);
      }
    }
  }

  // ---- wayfinding ----------------------------------------------------------

  private nodeAt(x: number, z: number, y: number): number {
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      if (Math.abs(n.y - y) < 0.6 && rectContains(n.rect, x, z)) return i;
    }
    return -1;
  }

  private buildGraph() {
    const addEdge = (a: number, b: number, via: 'flat' | 'stair', stair?: BuiltStair) => {
      if (a < 0 || b < 0 || a === b) return;
      const la = this.edges.get(a) ?? [];
      if (!la.some((e) => e.to === b)) la.push({ to: b, via, stair, from: a });
      this.edges.set(a, la);
      const lb = this.edges.get(b) ?? [];
      if (!lb.some((e) => e.to === a)) lb.push({ to: a, via, stair, from: b });
      this.edges.set(b, lb);
    };
    // flat adjacency between same-level rects that touch. Abutting rects often
    // leave a centimeters-wide seam (inset walkboxes, wall-line gaps) that
    // floorAt would treat as a void and refuse to cross — bridge every such
    // seam with a small overlap walkbox so the surfaces are truly continuous.
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const a = this.nodes[i], b = this.nodes[j];
        if (Math.abs(a.y - b.y) > 0.6) continue;
        const gx = Math.max(a.rect.minX, b.rect.minX) - Math.min(a.rect.maxX, b.rect.maxX);
        const gz = Math.max(a.rect.minZ, b.rect.minZ) - Math.min(a.rect.maxZ, b.rect.maxZ);
        if (!(gx < 0.31 && gz < 0.31 && (gx < 0 || gz < 0))) continue;
        addEdge(i, j, 'flat');
        const y = Math.min(a.y, b.y);
        if (gx >= 0 && gx < 0.31) {
          const lo = Math.min(a.rect.maxX, b.rect.maxX), hi = Math.max(a.rect.minX, b.rect.minX);
          const z0 = Math.max(a.rect.minZ, b.rect.minZ), z1 = Math.min(a.rect.maxZ, b.rect.maxZ);
          this.walkBoxes.push({ minX: lo - 0.25, maxX: hi + 0.25, minZ: z0, maxZ: z1, y });
        } else if (gz >= 0 && gz < 0.31) {
          const lo = Math.min(a.rect.maxZ, b.rect.maxZ), hi = Math.max(a.rect.minZ, b.rect.minZ);
          const x0 = Math.max(a.rect.minX, b.rect.minX), x1 = Math.min(a.rect.maxX, b.rect.maxX);
          this.walkBoxes.push({ minX: x0, maxX: x1, minZ: lo - 0.25, maxZ: hi + 0.25, y });
        }
      }
    }
    // stair edges: connect the rect at the stair top to the rect at its bottom
    for (const st of this.stairs) {
      const [dx, dz] = DIR_VEC[st.spec.dir];
      const topPt: [number, number] = [st.spec.top[0] - dx * 0.8, st.spec.top[1] - dz * 0.8];
      const a = this.nodeAt(topPt[0], topPt[1], st.topY);
      const b = this.nodeAt(st.bottom[0] + dx * 0.8, st.bottom[1] + dz * 0.8, st.bottomY);
      addEdge(a, b, 'stair', st);
    }
  }

  /** BFS parents from every node toward a set of target nodes (multi-source). */
  private bfsFrom(targets: number[]): Map<number, { next: number; stair?: BuiltStair }> {
    const out = new Map<number, { next: number; stair?: BuiltStair }>();
    const q = [...targets];
    const seen = new Set(targets);
    while (q.length) {
      const cur = q.shift()!;
      for (const e of this.edges.get(cur) ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        out.set(e.to, { next: cur, stair: e.via === 'stair' ? e.stair : undefined });
        q.push(e.to);
      }
    }
    return out;
  }

  private buildWayfinding() {
    // per-group route maps: from every node, the next hop toward that group
    const groupPaths = this.groups.map((_, gi) => {
      const targets: number[] = [];
      this.nodes.forEach((n, i) => { if (n.kind === 'plat' && n.groupIdx === gi) targets.push(i); });
      return this.bfsFrom(targets);
    });
    // exit route map: next hop toward any mezz with street exits
    const exitTargets: number[] = [];
    this.nodes.forEach((n, i) => {
      if (n.kind === 'mezz' && n.mezzIdx !== undefined
        && (this.cx.mezzes[n.mezzIdx].exits?.length ?? 0) > 0) exitTargets.push(i);
    });
    const exitPaths = this.bfsFrom(exitTargets);

    // 1) stair-head signs: what is DOWN this stair (platform dirs or transfers)
    for (const st of this.stairs) {
      const [dx, dz] = DIR_VEC[st.spec.dir];
      const bIdx = this.nodeAt(st.bottom[0] + dx * 0.8, st.bottom[1] + dz * 0.8, st.bottomY);
      if (bIdx < 0) continue;
      const bn = this.nodes[bIdx];
      const span: 'x' | 'z' = dx !== 0 ? 'z' : 'x'; // panel faces the approaching walker
      const sx = st.spec.top[0] + dx * 0.6, sz = st.spec.top[1] + dz * 0.6;
      if (bn.kind === 'plat') {
        const g = this.groups[bn.groupIdx!];
        const pl = g.platLocals[bn.platIdx!];
        const cs = this.crossSection(g.spec);
        const adj = cs.tracks.filter((t) => !t.spec.pass
          && (Math.abs(t.z - pl.zMin) < TRACK_W * 0.8 || Math.abs(t.z - pl.zMax) < TRACK_W * 0.8));
        const dirs = [...new Set(adj.map((t) => t.spec.dir))];
        const routes = [...new Set(adj.flatMap((t) => t.spec.routes))];
        const text = dirs.length === 1
          ? directionLabel(routes.length ? routes : g.spec.routes, dirs[0], g.spec.name)
          : bothDirectionsLabel(g.spec.routes, g.spec.name);
        this.hangSign(this.root, routes.length ? routes : g.spec.routes, text,
          sx, st.topY + 2.25, sz, span, 'down');
      } else {
        // stairs down to a corridor/mezz: list only the lines whose route from
        // down there does NOT climb straight back up this stair — a line
        // served from THIS level must not be signed "Downstairs"
        const reach: number[] = [];
        this.groups.forEach((_, gi) => {
          const hop = groupPaths[gi].get(bIdx);
          if (hop && hop.stair !== st) reach.push(gi);
        });
        const routes = [...new Set(reach.flatMap((gi) => this.groups[gi].spec.routes))].slice(0, 6);
        if (routes.length) {
          this.hangSign(this.root, routes, 'Downstairs', sx, st.topY + 2.25, sz, span, 'down');
        }
      }
      // 2) stair-foot signs: on platforms, exit & transfers UP this stair; on
      // mezzanines/landings, the specific lines (and exit) whose route from
      // down here climbs THIS stair — without these, a line reached via an
      // upper level is invisible from below (the Columbus Circle 1 problem)
      if (bn.kind === 'plat') {
        const g = this.groups[bn.groupIdx!];
        const others = this.groups.filter((og) => og.spec.id !== g.spec.id);
        const routes = [...new Set(others.flatMap((og) => og.spec.routes))].slice(0, 6);
        const text = others.length ? 'Transfer & Exit' : 'Exit';
        this.hangSign(this.root, routes, text,
          st.bottom[0] + dx * 1.4, st.bottomY + 2.25, st.bottom[1] + dz * 1.4, span, 'up');
      } else {
        const upRoutes: string[] = [];
        this.groups.forEach((g, gi) => {
          if (groupPaths[gi].get(bIdx)?.stair === st) upRoutes.push(...g.spec.routes);
        });
        const exitUp = exitPaths.get(bIdx)?.stair === st;
        const routes = [...new Set(upRoutes)].slice(0, 6);
        if (routes.length || exitUp) {
          this.hangSign(this.root, routes, exitUp && !routes.length ? 'Exit' : exitUp ? '& Exit' : '',
            st.bottom[0] + dx * 1.4, st.bottomY + 2.25, st.bottom[1] + dz * 1.4, span, 'up');
        }
      }
    }

    // 3) mezz junction signs: at each mezz, point toward each OTHER line and exit
    this.nodes.forEach((n, ni) => {
      if (n.kind !== 'mezz') return;
      const placed = new Set<string>(); // avoid duplicate (target-edge) signs
      const cxx = (n.rect.minX + n.rect.maxX) / 2;
      const czz = (n.rect.minZ + n.rect.maxZ) / 2;
      const sigFor = (hop: { next: number; stair?: BuiltStair }): { key: string; pos: [number, number]; arrow: 'wx+' | 'wx-' | 'wz+' | 'wz-'; span: 'x' | 'z' } | null => {
        if (hop.stair) return null; // stair-head sign already covers it
        const t = this.nodes[hop.next];
        const tx = Math.max(t.rect.minX, Math.min(t.rect.maxX, cxx));
        const tz = Math.max(t.rect.minZ, Math.min(t.rect.maxZ, czz));
        const ddx = tx - cxx, ddz = tz - czz;
        if (Math.abs(ddx) < 0.5 && Math.abs(ddz) < 0.5) return null;
        const horiz = Math.abs(ddx) >= Math.abs(ddz);
        const arrow = horiz ? (ddx > 0 ? 'wx+' : 'wx-') : (ddz > 0 ? 'wz+' : 'wz-');
        // sign hangs mid-mezz, panel across the walking direction
        const span: 'x' | 'z' = horiz ? 'z' : 'x';
        const pos: [number, number] = [
          horiz ? cxx + Math.sign(ddx) * Math.min(4, Math.abs(ddx) / 2) : cxx,
          horiz ? czz : czz + Math.sign(ddz) * Math.min(4, Math.abs(ddz) / 2),
        ];
        return { key: `${arrow}`, pos, arrow: arrow as 'wx+' | 'wx-' | 'wz+' | 'wz-', span };
      };
      // group targets sharing the same first move into one sign per direction
      const byDir = new Map<string, { routes: string[]; pos: [number, number]; arrow: 'wx+' | 'wx-' | 'wz+' | 'wz-'; span: 'x' | 'z' }>();
      this.groups.forEach((g, gi) => {
        const hop = groupPaths[gi].get(ni);
        if (!hop) return;
        const s = sigFor(hop);
        if (!s) return;
        const cur = byDir.get(s.key) ?? { routes: [], pos: s.pos, arrow: s.arrow, span: s.span };
        cur.routes = [...new Set([...cur.routes, ...g.spec.routes])];
        byDir.set(s.key, cur);
      });
      for (const [key, s] of byDir) {
        if (placed.has(key)) continue;
        placed.add(key);
        this.hangSign(this.root, s.routes.slice(0, 6), '', s.pos[0], n.y + 2.45, s.pos[1], s.span, s.arrow);
      }
      // exit pointer when this mezz has no exit of its own
      const hasOwnExit = n.mezzIdx !== undefined && (this.cx.mezzes[n.mezzIdx].exits?.length ?? 0) > 0;
      const eHop = exitPaths.get(ni);
      if (!hasOwnExit && eHop && !eHop.stair) {
        const s = sigFor(eHop);
        if (s && !placed.has(`exit-${s.key}`)) {
          placed.add(`exit-${s.key}`);
          this.hangSign(this.root, [], 'Exit', s.pos[0], n.y + 2.75, s.pos[1], s.span, s.arrow);
        }
      }
    });
  }

  // ---- spawns --------------------------------------------------------------

  private snapIntoWalk(x: number, z: number, y: number): THREE.Vector3 {
    const flat = this.walkBoxes.filter((b) => !b.ramp && Math.abs(b.y - y) < 0.6);
    for (const cand of [[0, 0], [0, 2.6], [0, -2.6], [2.6, 0], [-2.6, 0], [0, 4], [0, -4], [4, 0], [-4, 0]]) {
      const px = x + cand[0], pz = z + cand[1];
      if (flat.some((b) => px >= b.minX && px <= b.maxX && pz >= b.minZ && pz <= b.maxZ)) {
        return new THREE.Vector3(px, y, pz);
      }
    }
    // fall back to the center of the biggest flat box at this level
    let best: WalkBox | null = null;
    for (const b of flat) {
      if (!best || (b.maxX - b.minX) * (b.maxZ - b.minZ) > (best.maxX - best.minX) * (best.maxZ - best.minZ)) best = b;
    }
    if (best) return new THREE.Vector3((best.minX + best.maxX) / 2, y, (best.minZ + best.maxZ) / 2);
    return new THREE.Vector3(x, y, z);
  }

  private resolveSpawns() {
    // default spawn: unpaid side of the first fare mezz (prefer one with exits)
    const fareMezzes = this.cx.mezzes.filter((m) => m.fare);
    const main = fareMezzes.find((m) => (m.exits?.length ?? 0) > 0) ?? fareMezzes[0] ?? this.cx.mezzes[0];
    if (main) {
      const [minX, minZ, maxX, maxZ] = main.rect;
      if (main.fare) {
        const f = main.fare;
        const off = -f.paidSign * 3.2;
        const sx = f.cross === 'x' ? f.at + off : (minX + maxX) / 2;
        const sz = f.cross === 'z' ? f.at + off : (minZ + maxZ) / 2;
        this.spawn.copy(this.snapIntoWalk(sx, sz, main.y));
      } else {
        this.spawn.copy(this.snapIntoWalk((minX + maxX) / 2, (minZ + maxZ) / 2, main.y));
      }
    } else if (this.groups.length) {
      const g = this.groups[0];
      this.spawn.copy(this.platformSpawnByStation.get(g.spec.id) ?? new THREE.Vector3());
    }
    // per-station spawns: nearest fare mezz to that group's center
    for (const g of this.groups) {
      let best: MezzSpec | null = null, bestD = Infinity;
      for (const m of fareMezzes) {
        const [minX, minZ, maxX, maxZ] = m.rect;
        const mx = (minX + maxX) / 2, mz = (minZ + maxZ) / 2;
        const d = Math.hypot(mx - g.spec.at[0], mz - g.spec.at[1]);
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best?.fare) {
        const [minX, minZ, maxX, maxZ] = best.rect;
        const f = best.fare;
        const off = -f.paidSign * 3.2;
        const sx = f.cross === 'x' ? f.at + off : (minX + maxX) / 2;
        const sz = f.cross === 'z' ? f.at + off : (minZ + maxZ) / 2;
        this.spawnByStation.set(g.spec.id, this.snapIntoWalk(sx, sz, best.y));
      } else {
        this.spawnByStation.set(g.spec.id, this.spawn.clone());
      }
    }
    const p0 = this.groups[0];
    if (p0) this.platformSpawn.copy(this.platformSpawnByStation.get(p0.spec.id) ?? this.spawn);
  }

  // ---- runtime API ---------------------------------------------------------

  spawnFor(stationId: string): THREE.Vector3 {
    return this.spawnByStation.get(stationId)?.clone() ?? this.spawn.clone();
  }

  platformSpawnFor(stationId: string): THREE.Vector3 {
    return this.platformSpawnByStation.get(stationId)?.clone() ?? this.platformSpawn.clone();
  }

  get routesUnion(): string[] {
    return [...new Set(this.cx.groups.flatMap((g) => g.routes))];
  }

  attachTrains(network: NetworkData | null) {
    for (const g of this.groups) {
      g.scheduler = new TrainScheduler(g.node, g.stationSpec, g.trackInfo, network);
      g.scheduler.onArrive = () => this.onArrive?.();
    }
  }

  /**
   * Seed the group serving `stationId` with a doors-OPEN train on the (route,
   * dirSign) track and return a world-frame platform spawn beside it, so a rider
   * stepping off a ride finds the train they rode still standing at the platform,
   * re-boardable, before it closes up and departs. Returns null (caller falls
   * back to platformSpawnFor) when the group or track can't be matched.
   */
  seedRideExit(stationId: string, route: string, dirSign: 1 | -1): THREE.Vector3 | null {
    const g = this.groups.find((gg) => gg.spec.id === stationId);
    if (!g || !g.scheduler) return null;
    const tz = g.scheduler.seedDwell(route, dirSign);
    if (tz === null) return null;
    // platform adjacent to the seeded local track z, then group-local -> world
    const pl = g.platLocals.find((p) => Math.abs(tz - p.zMin) < TRACK_W * 0.9 || Math.abs(tz - p.zMax) < TRACK_W * 0.9)
      ?? g.platLocals[0];
    if (!pl) return null;
    const [wx, wz] = groupToWorld(g.spec, 4, (pl.zMin + pl.zMax) / 2);
    return new THREE.Vector3(wx, g.spec.y, wz);
  }

  /** A dwelling, doors-open train near the player. Player pos is WORLD; each
   *  group checks in its own local frame and only at its own level. */
  boardable(px: number, py: number, pz: number): (BoardableTrain & { stationId: string; doorDist: number }) | null {
    for (const g of this.groups) {
      if (!g.scheduler) continue;
      if (Math.abs(py - g.spec.y) > 1.6) continue; // must be ON that platform level
      const [lx, lz] = worldToGroup(g.spec, px, pz);
      const b = g.scheduler.boardable(lx, lz);
      if (b) return { ...b, stationId: g.spec.id, doorDist: Math.abs(lz - b.trackZ) };
    }
    return null;
  }

  get trainStates() {
    return this.groups.flatMap((g) => g.scheduler?.trainStates ?? []);
  }

  update(dt: number) {
    for (const g of this.groups) {
      g.scheduler?.update(dt);
      g.countdown.arrivalsFn = () => g.scheduler?.arrivals() ?? [];
      g.countdown.update(dt);
    }
  }

  dispose() {
    for (const g of this.groups) g.scheduler?.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.scene.clear();
  }
}
