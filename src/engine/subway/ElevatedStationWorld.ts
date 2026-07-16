import * as THREE from 'three';
import type { StationSpec, TrackInfo } from './types';
import { crossSection, rectSubtract } from './StationWorld';
import type { ExitZone } from './StationWorld';
import { makeHangingSignTexture, makeColumnSignTexture, makeExitSignTexture } from './signage';
import { buildBench, buildTrashCan, buildRailing, buildStairs, buildTurnstileRow, buildBooth } from './props';
import type { WalkBox } from '../collision';
import { quality } from '../quality';

const RAIL_Y = 8.2;
const PLAT_Y = 9.3;

/**
 * Open-air elevated station on a steel viaduct (e.g. 125 St on the 1):
 * platforms in the sky, stairs down to a street-level fare area between the
 * viaduct's support bents. Exposes the same surface as StationWorld so the
 * scheduler and World transitions treat them identically.
 */
export class ElevatedStationWorld {
  readonly scene: THREE.Scene;
  readonly walkBoxes: WalkBox[] = [];
  readonly spawn = new THREE.Vector3();
  readonly platformSpawn = new THREE.Vector3();
  readonly exitZones: ExitZone[] = [];
  readonly name: string;
  trackInfo!: TrackInfo;
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(spec: StationSpec, env: THREE.Texture | null = null) {
    this.name = spec.name;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#a9c6e2');
    if (env) { this.scene.environment = env; this.scene.environmentIntensity = 0.5; }
    const q = quality();
    const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x8a8478, q.shadows ? 0.9 : 1.2);
    const sun = new THREE.DirectionalLight(0xfff2dd, q.shadows ? 2.4 : 1.8);
    sun.position.set(-140, 220, -95);
    this.scene.add(hemi, sun, sun.target);
    this.build(spec);
    if (q.shadows) {
      // outdoor scene: real sun shadows on everything (viaduct onto street,
      // canopy onto platform, trains onto the deck)
      sun.castShadow = true;
      sun.shadow.mapSize.set(q.stationShadowMapSize, q.stationShadowMapSize);
      const r = spec.layout.platformLength / 2 + 60;
      sun.shadow.camera.left = -r;
      sun.shadow.camera.right = r;
      sun.shadow.camera.top = r;
      sun.shadow.camera.bottom = -r;
      sun.shadow.camera.near = 20;
      sun.shadow.camera.far = 700;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.7;
      this.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
      });
    }
  }

  private track<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(t: T): T {
    this.disposables.push(t);
    return t;
  }

  private box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) {
    const m = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, z);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    this.scene.add(m);
    return m;
  }

  private build(spec: StationSpec) {
    const L = spec.layout.platformLength;
    const half = L / 2;
    const cs = crossSection(spec);
    const W = cs.width;
    const deckLen = L + 300; // long enough to swallow departing consists

    const steel = this.track(new THREE.MeshLambertMaterial({ color: 0x274d3d }));
    const steelDark = this.track(new THREE.MeshLambertMaterial({ color: 0x1d3a2e }));
    const concrete = this.track(new THREE.MeshLambertMaterial({ color: 0x9a9a94 }));
    const platMat = this.track(new THREE.MeshLambertMaterial({ color: 0x8f8f8c }));
    const yellowMat = this.track(new THREE.MeshLambertMaterial({ color: 0xf2c53d }));
    const bedMat = this.track(new THREE.MeshLambertMaterial({ color: 0x2a2723 }));
    const railMat = this.track(new THREE.MeshStandardMaterial({ color: 0x9aa0a4, metalness: 0.85, roughness: 0.3 }));
    const roofMat = this.track(new THREE.MeshLambertMaterial({ color: 0x5a4638, side: THREE.DoubleSide }));
    const screenMat = this.track(new THREE.MeshLambertMaterial({ color: 0xcfc9b8, transparent: true, opacity: 0.92 }));
    const sidewalk = this.track(new THREE.MeshLambertMaterial({ color: 0xa3a7ab }));
    const asphalt = this.track(new THREE.MeshLambertMaterial({ color: 0x3f4348 }));

    // ---- street level: sidewalk slab + a hint of roadway under the viaduct ----
    const streetHalfW = W / 2 + 14;
    this.box(deckLen * 0.55, 0.1, streetHalfW * 2, sidewalk, 0, -0.05, 0);
    this.box(deckLen * 0.55, 0.06, 7.5, asphalt, 0, 0.0, -W / 2 - 8);
    this.box(deckLen * 0.55, 0.06, 7.5, asphalt, 0, 0.0, W / 2 + 8);
    this.walkBoxes.push({ minX: -34, maxX: 34, minZ: -streetHalfW, maxZ: streetHalfW, y: 0 });

    // ---- viaduct deck, girders, track bed, rails ----
    this.box(deckLen, 0.14, W, steelDark, 0, 8.0 - 0.07, 0);
    for (const side of [-1, 1]) {
      this.box(deckLen, 1.15, 0.28, steel, 0, 7.35, side * (W / 2 - 0.14));
    }
    for (let x = -deckLen / 2 + 3; x < deckLen / 2; x += 4.6) {
      this.box(0.28, 0.32, W, steel, x, 7.75, 0);
    }
    for (const tz of cs.tracks) {
      this.box(deckLen, 0.16, 3.6, bedMat, 0, 8.02, tz);
      for (const off of [-0.72, 0.72]) this.box(deckLen, 0.14, 0.12, railMat, 0, RAIL_Y - 0.07, tz + off);
      this.box(deckLen, 0.09, 0.24, this.track(new THREE.MeshLambertMaterial({ color: 0x3a3630 })), 0, RAIL_Y + 0.12, tz + 1.35);
    }

    // ---- support bents (paired columns + cap beam) every ~13m ----
    const stairXs = [-half * 0.3, half * 0.3];
    for (let x = -half - 20; x < half + 20; x += 13) {
      if (stairXs.some((sx) => Math.abs(x - sx) < 7)) continue;
      for (const side of [-1, 1]) {
        this.box(0.55, 7.3, 0.55, steel, x, 3.65, side * (W / 2 - 1.2));
        this.box(0.35, 4.5, 0.35, steelDark, x, 2.6, side * (W / 2 - 3.4));
      }
      this.box(0.5, 0.55, W - 1.2, steel, x, 7.05, 0);
    }

    // ---- platforms ----
    const stairW = 2.6, stairRun = 11;
    const stairFeet: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
    for (const p of cs.platforms) {
      const pw = p.zMax - p.zMin, pc = (p.zMin + p.zMax) / 2;
      this.box(L, 0.7, pw, platMat, 0, PLAT_Y - 0.35, pc);
      this.box(L, 0.03, 0.5, yellowMat, 0, PLAT_Y + 0.015, p.zMin + 0.28);
      this.box(L, 0.03, 0.5, yellowMat, 0, PLAT_Y + 0.015, p.zMax - 0.28);

      // canopy over the middle: posts + gabled roof + under-lights
      const canLen = L * 0.55;
      for (let x = -canLen / 2; x <= canLen / 2; x += 4.6) {
        this.box(0.16, 3.0, 0.16, steel, x, PLAT_Y + 1.5, pc);
        if (Math.round(x / 4.6) % 3 === 0) {
          const signTex = makeColumnSignTexture(spec.name);
          this.track(signTex.texture);
          const sMat = this.track(new THREE.MeshLambertMaterial({ map: signTex.texture, side: THREE.DoubleSide }));
          const plate = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.8, 0.8 / signTex.aspect)), sMat);
          plate.position.set(x, PLAT_Y + 1.9, pc + 0.17);
          plate.matrixAutoUpdate = false; plate.updateMatrix();
          this.scene.add(plate);
        }
      }
      for (const tilt of [-1, 1]) {
        const panel = new THREE.Mesh(this.track(new THREE.BoxGeometry(canLen, 0.06, pw * 0.62)), roofMat);
        panel.position.set(0, PLAT_Y + 3.15, pc + tilt * pw * 0.26);
        panel.rotation.x = tilt * 0.22;
        panel.matrixAutoUpdate = false; panel.updateMatrix();
        this.scene.add(panel);
      }
      // windscreen along the outer edge
      const outerZ = pc < 0 ? p.zMin + 0.12 : p.zMax - 0.12;
      if (cs.platforms.length > 1) {
        this.box(canLen, 2.1, 0.08, screenMat, 0, PLAT_Y + 1.05, outerZ);
      }
      // benches + cans
      for (const bx of [-L / 4, L / 4]) {
        const bench = buildBench();
        bench.position.set(bx, PLAT_Y, pc);
        this.scene.add(bench);
        const can = buildTrashCan();
        can.position.set(bx + 2.5, PLAT_Y, pc);
        this.scene.add(can);
      }
      // hanging signs under the canopy
      const up = makeHangingSignTexture({ routes: spec.routes, text: 'Uptown & The Bronx', arrow: 'left' });
      const dn = makeHangingSignTexture({ routes: spec.routes, text: 'Downtown & Brooklyn', arrow: 'right' });
      this.track(up.texture); this.track(dn.texture);
      for (const [sx, info] of [[-L / 5, up], [L / 5, dn]] as [number, { texture: THREE.Texture; aspect: number }][]) {
        const mat = this.track(new THREE.MeshLambertMaterial({ map: info.texture, side: THREE.DoubleSide }));
        const sign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(0.5 * info.aspect, 0.5)), mat);
        sign.position.set(sx, PLAT_Y + 2.6, pc);
        sign.matrixAutoUpdate = false; sign.updateMatrix();
        this.scene.add(sign);
      }

      // stairs down to the street (two per platform), descending toward +x
      for (const sx of stairXs) {
        const stair = buildStairs(stairW, PLAT_Y, stairRun);
        stair.rotation.y = Math.PI / 2; // ascends toward -x: bottom at sx+run
        stair.position.set(sx + stairRun, 0, pc);
        this.scene.add(stair);
        this.walkBoxes.push({
          minX: sx - 0.45, maxX: sx + stairRun,
          minZ: pc - stairW / 2, maxZ: pc + stairW / 2,
          y: 0,
          ramp: { axis: 'x', y0: PLAT_Y, y1: 0 },
        });
        stairFeet.push({ minX: sx - 0.45, maxX: sx + stairRun, minZ: pc - stairW / 2, maxZ: pc + stairW / 2 });
        // railings around the platform opening
        for (const zEdge of [pc - stairW / 2 - 0.25, pc + stairW / 2 + 0.25]) {
          const rail = buildRailing(stairRun + 0.9);
          rail.position.set(sx + stairRun / 2, PLAT_Y, zEdge);
          this.scene.add(rail);
        }
      }

      // platform walkboxes minus stair openings
      const rect = { minX: -half + 0.4, maxX: half - 0.4, minZ: p.zMin + 0.3, maxZ: p.zMax - 0.3 };
      const feet = stairFeet.filter((f) => f.minZ < p.zMax && f.maxZ > p.zMin);
      for (const r of rectSubtract(rect, feet)) {
        if (r.maxX - r.minX < 0.05 || r.maxZ - r.minZ < 0.05) continue;
        this.walkBoxes.push({ ...r, y: PLAT_Y });
      }
    }

    // ---- street-level fare control under the viaduct ----
    const t = buildTurnstileRow(3);
    t.rotation.y = Math.PI / 2;
    t.position.set(-2, 0, 0);
    this.scene.add(t);
    const booth = buildBooth();
    booth.rotation.y = Math.PI / 2;
    booth.position.set(-4.5, 0, -3.5);
    this.scene.add(booth);
    const exitTex = makeExitSignTexture(false);
    this.track(exitTex.texture);
    const exitMat = this.track(new THREE.MeshLambertMaterial({ map: exitTex.texture, side: THREE.DoubleSide }));
    for (const ex of [-30, 30]) {
      this.exitZones.push({ minX: ex - 3, maxX: ex + 3, minZ: -streetHalfW, maxZ: streetHalfW, y: 0 });
      const sign = new THREE.Mesh(this.track(new THREE.PlaneGeometry(1.4, 1.4 / exitTex.aspect)), exitMat);
      sign.position.set(ex * 0.85, 2.6, 0);
      sign.rotation.y = Math.PI / 2;
      sign.matrixAutoUpdate = false; sign.updateMatrix();
      this.scene.add(sign);
    }

    this.spawn.set(-6, 0, 0);
    const p0 = cs.platforms[0];
    this.platformSpawn.set(4, PLAT_Y, (p0.zMin + p0.zMax) / 2);

    const isSidePass = spec.layout.type === 'side' && spec.layout.passTracks > 0 && cs.tracks.length > 2;
    const elevStopping = cs.tracks.length > 1 ? [cs.tracks[0], cs.tracks[cs.tracks.length - 1]] : [...cs.tracks];
    this.trackInfo = {
      trackZs: elevStopping,
      trackDirs: elevStopping.map((_, i) => (i % 2 === 0 ? 1 : -1)) as (1 | -1)[],
      passTrackZs: isSidePass ? cs.tracks.slice(1, -1) : undefined,
      railY: RAIL_Y,
      half,
      portal: half + 45,
    };
    if (spec.layout.type === 'dual-island' && cs.tracks.length === 4) {
      this.trackInfo.trackZs = [...cs.tracks];
    }
  }

  update(_dt: number) { /* structure only */ }

  dispose() {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) o.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.scene.clear();
  }
}
