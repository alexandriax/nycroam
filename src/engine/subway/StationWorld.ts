import * as THREE from 'three';
import type { StationSpec, TrackInfo, Arrival } from './types';
import {
  makeNameMosaicTexture, makeHangingSignTexture,
  makeColumnSignTexture, makeExitSignTexture, drawBullet,
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
import { BLACK, SANS } from '../fonts';

export interface CrossSection {
  width: number;
  tracks: number[]; // z centers
  platforms: { zMin: number; zMax: number }[];
}

export const TRACK_W = 4.4;

export function crossSection(spec: StationSpec): CrossSection {
  const { type, tracks, passTracks } = spec.layout;
  const segs: { kind: 'track' | 'plat'; w: number }[] = [];
  const platW = type === 'island' ? 7 : type === 'dual-island' ? 5.5 : 4.5;
  if (type === 'side') {
    segs.push({ kind: 'plat', w: platW });
    const mid = Math.max(2, tracks); // service tracks incl pass-through
    for (let i = 0; i < mid; i++) segs.push({ kind: 'track', w: TRACK_W });
    segs.push({ kind: 'plat', w: platW });
  } else if (type === 'island') {
    segs.push({ kind: 'track', w: TRACK_W });
    segs.push({ kind: 'plat', w: platW });
    segs.push({ kind: 'track', w: TRACK_W });
  } else {
    segs.push({ kind: 'track', w: TRACK_W });
    segs.push({ kind: 'plat', w: platW });
    segs.push({ kind: 'track', w: TRACK_W });
    segs.push({ kind: 'track', w: TRACK_W });
    segs.push({ kind: 'plat', w: platW });
    segs.push({ kind: 'track', w: TRACK_W });
  }
  const margin = 0.5;
  const width = segs.reduce((s, x) => s + x.w, 0) + margin * 2;
  let z = -width / 2 + margin;
  const cs: CrossSection = { width, tracks: [], platforms: [] };
  for (const s of segs) {
    if (s.kind === 'track') cs.tracks.push(z + s.w / 2);
    else cs.platforms.push({ zMin: z, zMax: z + s.w });
    z += s.w;
  }
  return cs;
}

/** Axis-aligned rect minus holes -> covering rects (simple scanline decomposition). */
export function rectSubtract(
  outer: { minX: number; maxX: number; minZ: number; maxZ: number },
  holes: { minX: number; maxX: number; minZ: number; maxZ: number }[]
): { minX: number; maxX: number; minZ: number; maxZ: number }[] {
  const xs = new Set<number>([outer.minX, outer.maxX]);
  for (const h of holes) {
    if (h.minX > outer.minX && h.minX < outer.maxX) xs.add(h.minX);
    if (h.maxX > outer.minX && h.maxX < outer.maxX) xs.add(h.maxX);
  }
  const xList = Array.from(xs).sort((a, b) => a - b);
  const out: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  for (let i = 0; i < xList.length - 1; i++) {
    const x0 = xList[i], x1 = xList[i + 1];
    const cx = (x0 + x1) / 2;
    // z intervals blocked by holes in this column
    const blocked = holes
      .filter((h) => h.minX <= cx && h.maxX >= cx)
      .map((h) => [Math.max(h.minZ, outer.minZ), Math.min(h.maxZ, outer.maxZ)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let z = outer.minZ;
    for (const [bz0, bz1] of blocked) {
      if (bz0 > z) out.push({ minX: x0, maxX: x1, minZ: z, maxZ: bz0 });
      z = Math.max(z, bz1);
    }
    if (z < outer.maxZ) out.push({ minX: x0, maxX: x1, minZ: z, maxZ: outer.maxZ });
  }
  return out;
}

export interface ExitZone {
  minX: number; maxX: number; minZ: number; maxZ: number; y: number;
}

export class StationWorld {
  readonly scene: THREE.Scene;
  readonly walkBoxes: WalkBox[] = [];
  readonly spawn = new THREE.Vector3();
  readonly platformSpawn = new THREE.Vector3();
  readonly exitZones: ExitZone[] = [];
  readonly name: string;
  trackInfo!: TrackInfo;
  /** Set by the orchestrator: returns the soonest arrival per direction so the
   *  platform countdown clocks can tick. Consumed in update(); never set here. */
  arrivalsFn?: () => Arrival[];
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  // One redrawable LED countdown panel per served direction (built in build()).
  private countdownClocks: {
    dir: 1 | -1;
    routes: string[];
    label: string;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    texture: THREE.CanvasTexture;
    lastText: string;
  }[] = [];
  private clockTimer = 0;

  constructor(spec: StationSpec, env: THREE.Texture | null = null) {
    this.name = spec.name;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#08090b');
    if (env) {
      this.scene.environment = env;
      this.scene.environmentIntensity = 0.55;
    }
    setupStationLights(this.scene, spec.layout.platformLength / 2 + 25);
    this.build(spec);
    // selective shadows: small furniture + columns cast; floors/walls receive.
    // Ceilings must not cast (the light sits above them) — they're excluded
    // by only enabling casting on the prop groups below.
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.receiveShadow = true;
    });
    for (const g of this.shadowCasters) {
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) o.castShadow = true;
      });
    }
  }

  private shadowCasters: THREE.Object3D[] = [];

  private track<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(t: T): T {
    this.disposables.push(t);
    return t;
  }

  private box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) {
    const geo = this.track(new THREE.BoxGeometry(w, h, d));
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    parent.add(m);
    return m;
  }

  private build(spec: StationSpec) {
    const L = spec.layout.platformLength;
    const cs = crossSection(spec);
    const W = cs.width;
    const half = L / 2;
    const CEIL = 3.6;
    const MEZZ_Y = 6;
    const MEZZ_CEIL = 9;
    const root = new THREE.Group();
    this.scene.add(root);

    // ---- materials ----
    // glossy tiled walls: procedural tile+grime texture, low roughness so the
    // scene env-map gives the classic subway sheen
    const wallKit = makeSubwayWallTexture(spec.layout.bandColor);
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
    const terrazzo = makeTerrazzoTexture();
    const platMat = this.track(makeWorldDetailMaterial(0xa8a49a, terrazzo.map, 2, 0.85));
    const platSideMat = this.track(new THREE.MeshLambertMaterial({ color: 0x5c5c58 }));
    const ceilMat = this.track(new THREE.MeshLambertMaterial({ color: 0xb8b6ae }));
    const beamMat = this.track(new THREE.MeshLambertMaterial({ color: 0x4a5548 }));
    const troughMat = this.track(new THREE.MeshLambertMaterial({ color: 0x1c1d1f }));
    const railMat = this.track(new THREE.MeshStandardMaterial({ color: 0x9aa0a4, metalness: 0.85, roughness: 0.3 }));
    const thirdRailMat = this.track(new THREE.MeshLambertMaterial({ color: 0x3a3630 }));
    const yellowMat = this.track(new THREE.MeshLambertMaterial({ color: 0xf2c53d }));
    const darkMat = this.track(new THREE.MeshBasicMaterial({ color: 0x020304 }));
    const lightMat = this.track(new THREE.MeshBasicMaterial({ color: 0xfff6e0 }));
    const mezzFloorMat = this.track(makeWorldDetailMaterial(0xaaa69b, terrazzo.map, 2, 0.85));

    // ---- track troughs + rails ----
    for (const tz of cs.tracks) {
      this.box(L + 90, 0.3, TRACK_W - 0.2, troughMat, 0, -1.65, tz, root);
      for (const off of [-0.72, 0.72]) {
        this.box(L + 90, 0.16, 0.12, railMat, 0, -1.2, tz + off, root);
      }
      this.box(L + 90, 0.1, 0.25, thirdRailMat, 0, -0.95, tz + 1.35, root);
    }

    // ---- platforms ---- (walkboxes added after stair layout, minus stair footprints)
    for (const p of cs.platforms) {
      const pw = p.zMax - p.zMin, pc = (p.zMin + p.zMax) / 2;
      this.box(L, 1.5, pw, platMat, 0, -0.75, pc, root);
      // vertical faces toward tracks
      this.box(L, 1.5, 0.08, platSideMat, 0, -0.75, p.zMin - 0.04, root);
      this.box(L, 1.5, 0.08, platSideMat, 0, -0.75, p.zMax + 0.04, root);
      // yellow tactile edge strips
      this.box(L, 0.03, 0.55, yellowMat, 0, 0.015, p.zMin + 0.3, root);
      this.box(L, 0.03, 0.55, yellowMat, 0, 0.015, p.zMax - 0.3, root);
    }

    // ---- side walls (tiled) with mosaics ----
    const mosaic = makeNameMosaicTexture(spec.name, spec.layout.bandColor);
    this.track(mosaic.texture);
    const mosaicMat = this.track(new THREE.MeshLambertMaterial({ map: mosaic.texture }));
    for (const side of [-1, 1]) {
      const z = side * (W / 2);
      const wall = new THREE.Mesh(this.track(new THREE.PlaneGeometry(L + 90, CEIL + 1.8)), wallMat);
      wall.position.set(0, (CEIL - 1.8) / 2 + 0.15, z);
      if (side === 1) wall.rotation.y = Math.PI;
      wall.matrixAutoUpdate = false;
      wall.updateMatrix();
      root.add(wall);
      // name mosaics every ~22m
      const mosaicH = 0.85;
      const mosaicW = mosaicH * mosaic.aspect;
      for (let x = -half + 12; x < half - 6; x += 22) {
        const mp = new THREE.Mesh(this.track(new THREE.PlaneGeometry(mosaicW, mosaicH)), mosaicMat);
        mp.position.set(x, 1.95, z - side * 0.06);
        if (side === 1) mp.rotation.y = Math.PI;
        mp.matrixAutoUpdate = false;
        mp.updateMatrix();
        root.add(mp);
      }
    }

    // ---- end walls with tunnel portals ----
    for (const end of [-1, 1]) {
      const x = end * (half + 0.1);
      // wall segments between/outside tracks
      const gaps = cs.tracks.map((tz) => ({ min: tz - 1.9, max: tz + 1.9 }));
      gaps.sort((a, b) => a.min - b.min);
      let z = -W / 2;
      const segs: { z0: number; z1: number }[] = [];
      for (const g of gaps) {
        if (g.min > z) segs.push({ z0: z, z1: g.min });
        z = Math.max(z, g.max);
      }
      if (z < W / 2) segs.push({ z0: z, z1: W / 2 });
      for (const s of segs) {
        const wSeg = s.z1 - s.z0;
        const wall = new THREE.Mesh(this.track(new THREE.PlaneGeometry(wSeg, CEIL + 1.8)), wallEndMat);
        wall.position.set(x, (CEIL - 1.8) / 2 + 0.15, (s.z0 + s.z1) / 2);
        wall.rotation.y = end === 1 ? -Math.PI / 2 : Math.PI / 2;
        wall.matrixAutoUpdate = false;
        wall.updateMatrix();
        root.add(wall);
      }
      // lintel above portals
      this.box(0.4, 1.4, W, ceilMat, x, CEIL - 0.7 + 0.15, 0, root);
      // dark tunnel boxes (long enough to swallow a full departing consist)
      const tunLen = 280;
      for (const tz of cs.tracks) {
        this.box(tunLen, 0.1, 4.2, darkMat, end * (half + tunLen / 2), CEIL - 0.4, tz, root);
        this.box(tunLen, CEIL + 2, 0.1, darkMat, end * (half + tunLen / 2), 0.8, tz - 2.05, root);
        this.box(tunLen, CEIL + 2, 0.1, darkMat, end * (half + tunLen / 2), 0.8, tz + 2.05, root);
      }
    }

    // ---- stopping tracks + the direction each serves ----
    // Single source of truth: the scheduler runs trains by these, and every
    // directional sign below reads from the same arrays. Dual-island stations
    // give each island ONE direction (local + express side by side); all other
    // layouts alternate uptown/downtown across the stopping tracks.
    const stoppingZs = spec.layout.type === 'dual-island' && cs.tracks.length === 4
      ? [...cs.tracks]
      : cs.tracks.length > 1 ? [cs.tracks[0], cs.tracks[cs.tracks.length - 1]] : [...cs.tracks];
    const trackDirs: (1 | -1)[] = stoppingZs.map((_, i) =>
      spec.layout.type === 'dual-island' && stoppingZs.length === 4
        ? (i < 2 ? 1 : -1)
        : (i % 2 === 0 ? 1 : -1));
    // Realistic per-route direction labels (the shuttle points at Grand Central /
    // Times Sq, not "Uptown & The Bronx"; crosstown lines name their real ends).
    const dirLabel = (d: 1 | -1) => directionLabel(spec.routes, d, spec.name);
    // directions boardable from a platform = dirs of stopping tracks adjacent to it
    const platformDirs = (pl: { zMin: number; zMax: number }): (1 | -1)[] => {
      const dirs = new Set<1 | -1>();
      stoppingZs.forEach((tz, i) => {
        if (Math.abs(tz - pl.zMin) < TRACK_W * 0.8 || Math.abs(tz - pl.zMax) < TRACK_W * 0.8) dirs.add(trackDirs[i]);
      });
      return [...dirs];
    };

    // ---- stair layout (shared by ceiling openings + mezzanine) ----
    const mezzLen = Math.min(60, L / 2.4);
    const mezzHalf = mezzLen / 2;
    const mezzW = W + 8;
    const stairW = 2.6, stairRun = 7.2;
    const stairHoles: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
    const stairDefs: { x: number; z: number }[] = [];
    for (const p of cs.platforms) {
      const cz = (p.zMin + p.zMax) / 2;
      for (const sx of [-mezzHalf + 6, mezzHalf - 6 - stairRun]) {
        stairDefs.push({ x: sx, z: cz });
        stairHoles.push({ minX: sx - 0.4, maxX: sx + stairRun + 0.4, minZ: cz - stairW / 2 - 0.3, maxZ: cz + stairW / 2 + 0.3 });
      }
    }

    // platform walkboxes: platform area minus stair footprints, so the only
    // floor inside a stairwell is its ramp (no auto-scooping onto stairs)
    for (const p of cs.platforms) {
      const cz = (p.zMin + p.zMax) / 2;
      const feet = stairDefs
        .filter((s) => s.z === cz)
        .map((s) => ({ minX: s.x - 0.45, maxX: s.x + stairRun, minZ: cz - stairW / 2, maxZ: cz + stairW / 2 }));
      const rect = { minX: -half + 0.4, maxX: half - 0.4, minZ: p.zMin + 0.35, maxZ: p.zMax - 0.35 };
      for (const r of rectSubtract(rect, feet)) {
        if (r.maxX - r.minX < 0.05 || r.maxZ - r.minZ < 0.05) continue;
        this.walkBoxes.push({ ...r, y: 0 });
      }
    }

    // ---- ceiling (with stairwell openings) + beams + lights + columns ----
    const ceilRect = { minX: -L / 2, maxX: L / 2, minZ: -W / 2, maxZ: W / 2 };
    for (const r of rectSubtract(ceilRect, stairHoles)) {
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
      if (w < 0.05 || d < 0.05) continue;
      this.box(w, 0.18, d, ceilMat, (r.minX + r.maxX) / 2, CEIL + 0.09, (r.minZ + r.maxZ) / 2, root);
    }
    // stairwell shaft walls between platform ceiling and mezzanine floor
    const shaftH = MEZZ_Y - CEIL;
    for (const h of stairHoles) {
      const cx = (h.minX + h.maxX) / 2, chz = (h.minZ + h.maxZ) / 2;
      const wx = h.maxX - h.minX, wz = h.maxZ - h.minZ;
      this.box(wx, shaftH, 0.1, platSideMat, cx, CEIL + shaftH / 2, h.minZ, root);
      this.box(wx, shaftH, 0.1, platSideMat, cx, CEIL + shaftH / 2, h.maxZ, root);
      this.box(0.1, shaftH, wz, platSideMat, h.minX, CEIL + shaftH / 2, chz, root);
    }

    const beamGeo = this.track(new THREE.BoxGeometry(0.3, 0.35, W));
    const lightGeo = this.track(new THREE.BoxGeometry(3.4, 0.08, 0.24));
    const colColor = '#1f4d3d';
    for (let x = -half + 4; x < half; x += 4.6) {
      if (stairHoles.some((h) => x > h.minX - 0.3 && x < h.maxX + 0.3)) continue;
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(x, CEIL - 0.18, 0);
      beam.matrixAutoUpdate = false;
      beam.updateMatrix();
      root.add(beam);
    }
    // columns along platform edges + light strips over platforms
    const colSign = makeColumnSignTexture(spec.name);
    this.track(colSign.texture);
    const colSignMat = this.track(new THREE.MeshLambertMaterial({ map: colSign.texture }));
    let colIdx = 0;
    for (const p of cs.platforms) {
      const rows = p.zMax - p.zMin > 6 ? [(p.zMin + p.zMax) / 2] : [(p.zMin + p.zMax) / 2];
      for (const cz of rows) {
        for (let x = -half + 6; x < half - 2; x += 4.6) {
          const pillar = buildPillar(CEIL, colColor);
          pillar.position.set(x, 0, cz);
          root.add(pillar);
          this.shadowCasters.push(pillar);
          if (colIdx % 3 === 0) {
            const sw = 0.62, sh = sw / colSign.aspect;
            for (const face of [-1, 1]) {
              const sp = new THREE.Mesh(this.track(new THREE.PlaneGeometry(sw, sh)), colSignMat);
              sp.position.set(x, 1.75, cz + face * 0.16);
              if (face === -1) sp.rotation.y = Math.PI;
              sp.matrixAutoUpdate = false;
              sp.updateMatrix();
              root.add(sp);
            }
          }
          colIdx++;
        }
      }
      for (let x = -half + 3; x < half; x += 4.6) {
        // skip strips that would float over a stairwell opening (same guard as
        // the ceiling beams) so no light bar hangs in the middle of the stairs
        if (stairHoles.some((h) => x > h.minX - 0.3 && x < h.maxX + 0.3)) continue;
        const strip = new THREE.Mesh(lightGeo, lightMat);
        strip.position.set(x, CEIL - 0.06, (p.zMin + p.zMax) / 2);
        strip.matrixAutoUpdate = false;
        strip.updateMatrix();
        root.add(strip);
      }
    }

    // ---- hanging directional signs (per TRACK, not per position) ----
    // A direction belongs to a track: signs hang over each platform EDGE naming
    // where trains on that side go, readable from both directions of approach
    // (two front-facing quads — a single DoubleSide plane mirrors its text).
    const signMats = new Map<string, { mat: THREE.Material; aspect: number }>();
    const signMatFor = (routes: string[], text: string) => {
      const key = routes.join('') + '|' + text;
      let entry = signMats.get(key);
      if (!entry) {
        const t = makeHangingSignTexture({ routes, text, arrow: 'none' });
        this.track(t.texture);
        entry = { mat: this.track(new THREE.MeshBasicMaterial({ map: t.texture })), aspect: t.aspect };
        signMats.set(key, entry);
      }
      return entry;
    };
    const hangSign = (routes: string[], text: string, x: number, y: number, z: number, alongX: boolean) => {
      const { mat, aspect } = signMatFor(routes, text);
      const h = 0.5, w = Math.min(h * aspect, 5.2);
      const geo = this.track(new THREE.PlaneGeometry(w, h));
      const g = new THREE.Group();
      const a = new THREE.Mesh(geo, mat);
      const b = new THREE.Mesh(geo, mat);
      if (alongX) { // panel spans z, readable walking along x
        a.rotation.y = Math.PI / 2; a.position.x = 0.012;
        b.rotation.y = -Math.PI / 2; b.position.x = -0.012;
      } else { // panel spans x, readable walking along z
        a.position.z = 0.012;
        b.rotation.y = Math.PI; b.position.z = -0.012;
      }
      g.add(a, b);
      g.position.set(x, y, z);
      g.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
      root.add(g);
    };
    for (const p of cs.platforms) {
      stoppingZs.forEach((tz, i) => {
        const nearMin = Math.abs(tz - p.zMin) < TRACK_W * 0.8;
        const nearMax = Math.abs(tz - p.zMax) < TRACK_W * 0.8;
        if (!nearMin && !nearMax) return;
        const edgeZ = nearMin ? p.zMin + 0.55 : p.zMax - 0.55;
        for (const sx of [-L / 4, 0, L / 4]) {
          hangSign(spec.routes, dirLabel(trackDirs[i]), sx, CEIL - 0.55, edgeZ, true);
        }
      });
    }

    // ---- platform countdown clocks (one per served direction) ----
    // An MTA-style black LED panel hangs over the platform edge that a
    // direction's trains stop at — right beside that direction's hanging sign,
    // offset in x so the two don't coincide — reading "Next <dir> train: M:SS".
    // Each owns a redrawable CanvasTexture ticked from arrivalsFn() in update().
    const clockDone = new Set<1 | -1>();
    for (const p of cs.platforms) {
      stoppingZs.forEach((tz, i) => {
        const dir = trackDirs[i];
        if (clockDone.has(dir)) return;
        const nearMin = Math.abs(tz - p.zMin) < TRACK_W * 0.8;
        const nearMax = Math.abs(tz - p.zMax) < TRACK_W * 0.8;
        if (!nearMin && !nearMax) return;
        clockDone.add(dir);
        const edgeZ = nearMin ? p.zMin + 0.55 : p.zMax - 0.55;
        this.buildCountdownClock(root, spec.routes, dir, dirLabel(dir), 4, CEIL - 0.55, edgeZ);
      });
    }

    // ---- platform furniture ----
    for (const p of cs.platforms) {
      const cz = (p.zMin + p.zMax) / 2;
      for (const bx of [-L / 3, 0, L / 3]) {
        const bench = buildBench();
        bench.position.set(bx, 0, cz + 1.2);
        root.add(bench);
        this.shadowCasters.push(bench);
        const trash = buildTrashCan();
        trash.position.set(bx + 3, 0, cz - 1.2);
        root.add(trash);
        this.shadowCasters.push(trash);
      }
    }

    // ---- mezzanine ----
    // Exit stairs live inside the mezzanine, x-disjoint from the platform
    // stairwells so their ramps never overlap other walkable floor.
    const exX = -mezzHalf + 5;
    const exTop = exX - 4.5;
    const exitZs = [-mezzW / 4, mezzW / 4];
    const exitRects = exitZs.map((ez) => ({
      minX: exTop - 0.45, maxX: exX + 0.4,
      minZ: ez - stairW / 2 - 0.3, maxZ: ez + stairW / 2 + 0.3,
    }));
    const mezzRect = { minX: -mezzHalf, maxX: mezzHalf, minZ: -mezzW / 2, maxZ: mezzW / 2 };
    for (const r of rectSubtract(mezzRect, [...stairHoles, ...exitRects])) {
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
      if (w < 0.05 || d < 0.05) continue;
      this.box(w, 0.5, d, mezzFloorMat, (r.minX + r.maxX) / 2, MEZZ_Y - 0.25, (r.minZ + r.maxZ) / 2, root);
      // walkable only where floor exists (stair openings excluded)
      this.walkBoxes.push({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ, y: MEZZ_Y });
    }

    // mezz ceiling (holes over the exit stair tops), walls, lights
    const exitCeilHoles = exitZs.map((ez) => ({
      minX: exTop - 0.45, maxX: exTop + 2.9,
      minZ: ez - stairW / 2 - 0.3, maxZ: ez + stairW / 2 + 0.3,
    }));
    for (const r of rectSubtract(mezzRect, exitCeilHoles)) {
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
      if (w < 0.05 || d < 0.05) continue;
      this.box(w, 0.15, d, ceilMat, (r.minX + r.maxX) / 2, MEZZ_CEIL + 0.07, (r.minZ + r.maxZ) / 2, root);
    }
    const mezzWallTex = wallKit.map.clone();
    this.track(mezzWallTex);
    mezzWallTex.repeat.set(Math.ceil(mezzLen / 7), 1);
    const mezzWallMat = this.track(new THREE.MeshStandardMaterial({
      map: mezzWallTex, roughness: 0.36, metalness: 0.03,
    }));
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(this.track(new THREE.PlaneGeometry(mezzLen, MEZZ_CEIL - MEZZ_Y)), mezzWallMat);
      wall.position.set(0, (MEZZ_Y + MEZZ_CEIL) / 2, side * (mezzW / 2));
      if (side === 1) wall.rotation.y = Math.PI;
      wall.matrixAutoUpdate = false;
      wall.updateMatrix();
      root.add(wall);
    }
    for (const end of [-1, 1]) {
      const wall = new THREE.Mesh(this.track(new THREE.PlaneGeometry(mezzW, MEZZ_CEIL - MEZZ_Y)), mezzWallMat);
      wall.position.set(end * mezzHalf, (MEZZ_Y + MEZZ_CEIL) / 2, 0);
      wall.rotation.y = end === 1 ? -Math.PI / 2 : Math.PI / 2;
      wall.matrixAutoUpdate = false;
      wall.updateMatrix();
      root.add(wall);
    }
    for (let x = -mezzHalf + 3; x < mezzHalf; x += 4.2) {
      // same stairwell-opening guard: skip any strip over a stair x-range so no
      // light bar shows through the platform-stair holes in the mezz floor
      if (stairHoles.some((h) => x > h.minX - 0.3 && x < h.maxX + 0.3)) continue;
      const strip = new THREE.Mesh(lightGeo, lightMat);
      strip.position.set(x, MEZZ_CEIL - 0.06, 0);
      strip.matrixAutoUpdate = false;
      strip.updateMatrix();
      root.add(strip);
      const strip2 = strip.clone();
      strip2.position.z = mezzW / 3;
      strip2.updateMatrix();
      root.add(strip2);
      const strip3 = strip.clone();
      strip3.position.z = -mezzW / 3;
      strip3.updateMatrix();
      root.add(strip3);
    }

    // railings around mezzanine stair openings (the stair's own rails cover the run)
    for (const h of stairHoles) {
      const wz = h.maxZ - h.minZ;
      for (const zEdge of [h.minZ, h.maxZ]) {
        const rail = buildRailing(h.maxX - h.minX);
        rail.position.set((h.minX + h.maxX) / 2, MEZZ_Y, zEdge);
        root.add(rail);
      }
      const railEnd = buildRailing(wz);
      railEnd.rotation.y = Math.PI / 2;
      railEnd.position.set(h.maxX, MEZZ_Y, (h.minZ + h.maxZ) / 2);
      root.add(railEnd);
    }

    // stairs platform -> mezz (visual + ramp walkboxes)
    for (const s of stairDefs) {
      const stair = buildStairs(stairW, MEZZ_Y, stairRun);
      // buildStairs ascends toward local -z; rotate +90° so it ascends toward -x,
      // with its bottom edge at the platform end of the opening (s.x + stairRun)
      stair.rotation.y = Math.PI / 2;
      stair.position.set(s.x + stairRun, 0, s.z);
      root.add(stair);
      // ramp walkbox covers the ENTIRE floor opening (padding included) so
      // there is no dead strip where no floor accepts the player
      this.walkBoxes.push({
        minX: s.x - 0.45, maxX: s.x + stairRun + 0.4,
        minZ: s.z - stairW / 2 - 0.3, maxZ: s.z + stairW / 2 + 0.3,
        y: 0,
        ramp: { axis: 'x', y0: MEZZ_Y, y1: 0 },
      });
      // mezzanine sign over the stair head: which trains this stair reaches
      {
        const pl = cs.platforms.find((pp) => Math.abs((pp.zMin + pp.zMax) / 2 - s.z) < 0.5);
        const dirs = pl ? platformDirs(pl) : [];
        const text = dirs.length === 1 ? dirLabel(dirs[0]) : bothDirectionsLabel(spec.routes, spec.name);
        hangSign(spec.routes, text, s.x + stairRun / 2, MEZZ_Y + 2.25, s.z, true);
      }
    }

    // ---- fare control on mezzanine ----
    // One continuous fare line spanning z across the mezzanine, at an x clear of
    // EVERY opening for every layout. Platform stairwells occupy the x within
    // ~13.6m of each mezz end and the street-exit stairs sit at the -x end, so
    // the central band is always open. fcX sits toward the unpaid (-x) side of
    // that band and the deepest prop (the booth, ~1.6m deep) is kept clear of
    // the platform-stair openings. The line reads as: [barrier][booth][4
    // turnstiles][rotogate][barrier], wall to wall — the only way across is a
    // turnstile.
    const holeLeftX = Math.max(
      -mezzHalf,
      ...stairHoles.filter((h) => (h.minX + h.maxX) / 2 < 0).map((h) => h.maxX),
      ...exitRects.map((r) => r.maxX),
    );
    const holeRightX = Math.min(
      mezzHalf,
      ...stairHoles.filter((h) => (h.minX + h.maxX) / 2 > 0).map((h) => h.minX),
    );
    const boothHalfDepth = 0.8; // BOOTH_D / 2 — deepest fare prop in x
    const fcXmin = holeLeftX + boothHalfDepth + 0.5;
    const fcXmax = holeRightX - boothHalfDepth - 0.5;
    if (fcXmin > fcXmax) console.warn('[StationWorld] mezzanine too narrow for a clear fare line');
    const fcX = Math.max(fcXmin, Math.min(fcXmax, -mezzHalf + 18));

    const fareGroups: THREE.Group[] = [];
    const tsHalfZ = (4 * 0.85) / 2; // turnstile bank half-span in z (pitch 0.85)
    const turnstiles = buildTurnstileRow(4);
    turnstiles.rotation.y = Math.PI / 2; // bank spans z; riders pass toward +x (paid side)
    turnstiles.position.set(fcX, MEZZ_Y, 0);
    fareGroups.push(turnstiles);
    // token booth inline on the -z flank, abutting the bank
    const boothHalfZ = 1.1; // BOOTH_W / 2 (booth is rotated, so its width lies along z)
    const boothZ = -(tsHalfZ + boothHalfZ);
    const booth = buildBooth();
    booth.rotation.y = Math.PI / 2;
    booth.position.set(fcX, MEZZ_Y, boothZ);
    fareGroups.push(booth);
    // exit rotogate inline on the +z flank, abutting the bank
    const rotoHalfZ = 0.6;
    const rotoZ = tsHalfZ + rotoHalfZ;
    const roto = buildRotogate();
    roto.position.set(fcX, MEZZ_Y, rotoZ);
    fareGroups.push(roto);
    // fixed barriers close the line from each flank out to the mezzanine walls
    const barSpans: [number, number][] = [
      [-mezzW / 2, boothZ - boothHalfZ], // -z wall -> booth
      [rotoZ + rotoHalfZ, mezzW / 2],    // rotogate -> +z wall
    ];
    for (const [z0, z1] of barSpans) {
      const len = z1 - z0;
      if (len < 0.1) continue;
      const bar = buildFareBarrier(len);
      bar.rotation.y = Math.PI / 2;
      bar.position.set(fcX, MEZZ_Y, (z0 + z1) / 2);
      fareGroups.push(bar);
    }
    for (const g of fareGroups) { root.add(g); this.shadowCasters.push(g); }
    // MetroCard machines on the unpaid side, backed against the -z wall
    for (let i = 0; i < 3; i++) {
      const mvm = buildMetroCardMachine();
      mvm.position.set(fcX - 3.5 + i * 1.1, MEZZ_Y, -mezzW / 2 + 0.55);
      root.add(mvm);
    }

    // ---- exit stairs (to street) ----
    const exitInfo = makeExitSignTexture(true);
    this.track(exitInfo.texture);
    const exitMat = this.track(new THREE.MeshLambertMaterial({ map: exitInfo.texture, side: THREE.DoubleSide }));
    for (const ez of exitZs) {
      const stair = buildStairs(stairW, 3.2, 4.5);
      stair.rotation.y = Math.PI / 2; // ascend toward -x
      stair.position.set(exX, MEZZ_Y, ez);
      root.add(stair);
      this.walkBoxes.push({
        minX: exTop - 0.45, maxX: exX + 0.45,
        minZ: ez - stairW / 2 - 0.3, maxZ: ez + stairW / 2 + 0.3,
        y: MEZZ_Y,
        ramp: { axis: 'x', y0: MEZZ_Y + 3.2, y1: MEZZ_Y },
      });
      this.exitZones.push({ minX: exTop, maxX: exTop + 1.3, minZ: ez - stairW / 2, maxZ: ez + stairW / 2, y: MEZZ_Y + 3.2 });
      // railings along the open floor edges
      for (const zEdge of [ez - stairW / 2 - 0.3, ez + stairW / 2 + 0.3]) {
        const rail = buildRailing(exX + 0.4 - (exTop - 0.45));
        rail.position.set((exTop - 0.45 + exX + 0.4) / 2, MEZZ_Y, zEdge);
        root.add(rail);
      }
      // exit-stair shaft: thin walls rising from the mezz ceiling opening up to
      // a lit street opening. Nothing hangs below the ceiling (y=MEZZ_CEIL); the
      // +x side — the side the stair ascends FROM — is left open so the player
      // looks up the stairs toward the light instead of at a dark cap.
      {
        const sMinX = exTop - 0.45, sMaxX = exTop + 2.9;
        const sMinZ = ez - stairW / 2 - 0.3, sMaxZ = ez + stairW / 2 + 0.3;
        const sCx = (sMinX + sMaxX) / 2, sWx = sMaxX - sMinX, sWz = sMaxZ - sMinZ;
        const yBot = MEZZ_CEIL, yTop = MEZZ_Y + 5.0, sh = yTop - yBot;
        this.box(sWx, sh, 0.1, platSideMat, sCx, yBot + sh / 2, sMinZ, root); // side wall
        this.box(sWx, sh, 0.1, platSideMat, sCx, yBot + sh / 2, sMaxZ, root); // side wall
        this.box(0.1, sh, sWz, lightMat, sMinX, yBot + sh / 2, ez, root);     // lit street opening (-x end)
        this.box(sWx, 0.12, sWz, lightMat, sCx, yTop, ez, root);             // lit sky cap
      }
      const sh = 0.42, sw = sh * exitInfo.aspect;
      const sign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(sw, sh)), exitMat);
      sign.position.set(exX + 0.85, MEZZ_Y + 2.3, ez);
      sign.rotation.y = Math.PI / 2;
      sign.matrixAutoUpdate = false;
      sign.updateMatrix();
      root.add(sign);
    }

    // spawn: on the mezzanine on the UNPAID side, facing the fare line. The
    // candidate spot may land inside a stairwell floor hole (it did at Grand
    // Central — the player spawned hovering over the platform stairs, unable to
    // move), so scan z offsets until the spot is solid mezzanine floor.
    {
      const sx = fcX - 3.2;
      let sz = 0;
      for (const cand of [0, 2.6, -2.6, 3.6, -3.6, 5, -5]) {
        const onMezz = this.walkBoxes.some((b) =>
          !b.ramp && b.y === MEZZ_Y &&
          sx >= b.minX && sx <= b.maxX && cand >= b.minZ && cand <= b.maxZ);
        if (onMezz) { sz = cand; break; }
      }
      this.spawn.set(sx, MEZZ_Y, sz);
    }

    // ---- track info for the train scheduler ----
    // Which z-side each stopping track's platform sits on: nearest platform
    // center vs the track z (+1 = platform toward +z, -1 = toward -z; a dead-on
    // tie picks +1). Aligned with trackZs/trackDirs so the scheduler opens the
    // doors on the platform side only.
    const platformSides: (1 | -1)[] = stoppingZs.map((tz) => {
      let bestC = tz, bestD = Infinity;
      for (const p of cs.platforms) {
        const pc = (p.zMin + p.zMax) / 2;
        const d = Math.abs(pc - tz);
        if (d < bestD) { bestD = d; bestC = pc; }
      }
      const s = Math.sign(bestC - tz);
      return (s === 0 ? 1 : s) as 1 | -1;
    });
    const isSidePass = spec.layout.type === 'side' && spec.layout.passTracks > 0 && cs.tracks.length > 2;
    this.trackInfo = {
      trackZs: stoppingZs,
      trackDirs,
      platformSides,
      passTrackZs: isSidePass ? cs.tracks.slice(1, -1) : undefined,
      railY: -1.1,
      half,
      portal: half + 45,
    };
    const p0 = cs.platforms[0];
    this.platformSpawn.set(4, 0, (p0.zMin + p0.zMax) / 2);
  }

  /** Build one redrawable LED countdown panel and register it for ticking. */
  private buildCountdownClock(
    parent: THREE.Object3D, routes: string[], dir: 1 | -1, label: string,
    x: number, y: number, z: number,
  ) {
    const cw = 1024, ch = 256;
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // no 2D context (non-browser); skip the clock, station still builds
    const texture = this.track(new THREE.CanvasTexture(canvas));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    // signage is UNLIT: MeshBasic, two back-to-back front-facing quads (never a
    // single DoubleSide plane, which would mirror the text on its far face)
    const mat = this.track(new THREE.MeshBasicMaterial({ map: texture }));
    const ph = 0.6, pw = ph * (cw / ch); // ~2.4 m LED panel
    const geo = this.track(new THREE.PlaneGeometry(pw, ph));
    const g = new THREE.Group();
    const a = new THREE.Mesh(geo, mat);
    const b = new THREE.Mesh(geo, mat);
    a.rotation.y = Math.PI / 2; a.position.x = 0.012;   // panel spans z, read walking along x
    b.rotation.y = -Math.PI / 2; b.position.x = -0.012;
    g.add(a, b);
    g.position.set(x, y, z);
    g.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    parent.add(g);
    const clock = { dir, routes, label, canvas, ctx, texture, lastText: '' };
    this.countdownClocks.push(clock);
    this.drawCountdownFace(clock, '—');
  }

  /** Re-fill one clock's canvas with its bullets/label and the given time. The
   *  bullets and label are static, so only redraw when the time text changed. */
  private drawCountdownFace(clock: StationWorld['countdownClocks'][number], timeStr: string) {
    if (timeStr === clock.lastText) return;
    clock.lastText = timeStr;
    const { ctx, canvas } = clock;
    const w = canvas.width, h = canvas.height;
    const midY = h * 0.46;

    ctx.fillStyle = '#050506';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#242629';
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, w - 12, h - 12);

    // route bullets on the left
    let x = 34;
    const r = clock.routes.length > 3 ? 40 : 50;
    for (const route of clock.routes.slice(0, 4)) {
      drawBullet(ctx, x + r, midY, r, route);
      x += r * 2 + 14;
    }
    x += 16;

    // bright amber time on the right ("Now" / "M:SS" / "—")
    const timeRight = w - 34;
    ctx.font = `64px ${BLACK}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffb020';
    ctx.fillText(timeStr, timeRight, midY);
    const timeLeft = timeRight - ctx.measureText(timeStr).width;

    // "Next <direction> train" fit between the bullets and the time
    const head = `Next ${clock.label} train`;
    const maxW = Math.max(40, timeLeft - 22 - x);
    let size = 46;
    ctx.textAlign = 'left';
    ctx.font = `${size}px ${SANS}`;
    while (ctx.measureText(head).width > maxW && size > 16) {
      size -= 2;
      ctx.font = `${size}px ${SANS}`;
    }
    ctx.fillStyle = '#f4f4ec';
    ctx.fillText(head, x, midY);

    // amber "min" tag under a real countdown (not under "Now"/"—")
    if (timeStr !== 'Now' && timeStr !== '—') {
      ctx.font = `26px ${SANS}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#c07a10';
      ctx.fillText('min', timeRight, h * 0.82);
    }

    clock.texture.needsUpdate = true;
  }

  /** "M:SS", or "Now" at ≤0, or "—" when the arrival is missing/non-finite. */
  private formatArrival(a: Arrival | undefined): string {
    if (!a || !Number.isFinite(a.seconds)) return '—';
    const s = Math.max(0, Math.round(a.seconds));
    if (s <= 0) return 'Now';
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  }

  update(dt: number) {
    // Structure is static; the only live thing is the countdown clocks. Poll
    // arrivalsFn() ~2x/sec and redraw only the panels whose time changed (canvas
    // and texture are reused — no per-frame allocation).
    if (this.countdownClocks.length === 0) return;
    this.clockTimer += dt;
    if (this.clockTimer < 0.5) return;
    this.clockTimer = 0;
    const arrivals = this.arrivalsFn?.();
    for (const clock of this.countdownClocks) {
      const a = arrivals?.find((ar) => ar.dirSign === clock.dir);
      this.drawCountdownFace(clock, this.formatArrival(a));
    }
  }

  dispose() {
    // prop groups create their own geometries; free everything in the scene
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.scene.clear();
  }
}
