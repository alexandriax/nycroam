import * as THREE from 'three';
import type { NetworkData, StationSpec } from './types';
import { routeColor, bulletTextColor } from './types';
import { makeWallTexture, makeNameMosaicTexture, drawBullet } from './signage';
import { SANS } from '../fonts';

export interface RideHud {
  route: string;
  state: 'dwell' | 'closing' | 'moving';
  thisStop: string;
  nextStop: string | null;
  terminal: string;
  atEnd: boolean;
}

const CAR_INTERIOR_H = 2.15;

function makeStripMap(routeId: string, stops: string[], names: Map<string, string>, currentIdx: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 2048; cv.height = 128;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#f4f2ec';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const color = routeColor(routeId);
  const x0 = 90, x1 = cv.width - 40;
  const y = 46;
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  drawBullet(ctx, 44, y, 30, routeId);
  const n = stops.length;
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / Math.max(1, n - 1);
    ctx.beginPath();
    ctx.arc(x, y, i === currentIdx ? 14 : 9, 0, Math.PI * 2);
    ctx.fillStyle = i === currentIdx ? '#111' : '#ffffff';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = i === currentIdx ? '#111' : color;
    ctx.stroke();
    if (i < currentIdx) { // already served: dim
      ctx.fillStyle = 'rgba(244,242,236,0.55)';
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
    }
    const name = names.get(stops[i]) ?? stops[i];
    ctx.save();
    ctx.translate(x, y + 24);
    ctx.rotate(0.5);
    ctx.font = i === currentIdx ? `bold 21px ${SANS}` : `19px ${SANS}`;
    ctx.fillStyle = '#222';
    ctx.textAlign = 'left';
    ctx.fillText(name.length > 20 ? name.slice(0, 19) + '…' : name, 0, 0);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * The rideable train: a car interior + scrolling tunnel. Between stops the
 * world outside the windows moves; on arrival a station backdrop appears and
 * the doors open. The engine swaps to a full StationWorld if the rider exits.
 */
export class RideWorld {
  readonly scene: THREE.Scene;
  readonly route: string;
  private stops: string[];
  private times: number[];
  private idx: number;
  private dirSign: 1 | -1;
  private names = new Map<string, string>();
  private bandColors = new Map<string, string>();

  private state: 'dwell' | 'closing' | 'moving' = 'dwell';
  private t = 0;
  private stateLen = 6;
  private doorOpenAmt = 1;

  private doorPanels: { mesh: THREE.Mesh; home: number; dir: 1 | -1 }[] = [];
  private streaks!: THREE.InstancedMesh;
  private backdrop = new THREE.Group();
  private backdropWall!: THREE.Mesh;
  private mosaicPlane!: THREE.Mesh;
  private stripMat!: THREE.MeshBasicMaterial;
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private carHalf: number;

  constructor(
    routeId: string,
    dirSign: 1 | -1,
    startStationId: string,
    network: NetworkData,
    stations: Map<string, StationSpec>,
    env: THREE.Texture | null,
  ) {
    this.route = routeId;
    this.dirSign = dirSign;
    const r = network.routes[routeId];
    this.stops = r.stops;
    this.times = r.t;
    this.idx = Math.max(0, this.stops.indexOf(startStationId));
    for (const [id, s] of stations) {
      this.names.set(id, s.name);
      this.bandColors.set(id, s.layout.bandColor);
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#050607');
    if (env) { this.scene.environment = env; this.scene.environmentIntensity = 0.5; }
    const hemi = new THREE.HemisphereLight(0xfff6e2, 0x55524c, 1.35);
    this.scene.add(hemi);
    const amb = new THREE.AmbientLight(0xfff4e0, 0.45);
    this.scene.add(amb);

    const isIRT = /IRT/i.test(stations.get(startStationId)?.division ?? 'IRT');
    const carLen = isIRT ? 15.4 : 18.2;
    const carW = isIRT ? 2.66 : 2.96;
    this.carHalf = carLen / 2;
    this.buildCar(carLen, carW);
    this.buildOutside();
    this.setStrip();
    this.enterDwell(8);
  }

  private track<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(t: T): T {
    this.disposables.push(t);
    return t;
  }

  private box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.scene) {
    const geo = this.track(new THREE.BoxGeometry(w, h, d));
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  private buildCar(len: number, w: number) {
    const hw = w / 2;
    const steel = this.track(new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.55, roughness: 0.45 }));
    const floorM = this.track(new THREE.MeshLambertMaterial({ color: 0x9a8f7c }));
    const benchM = this.track(new THREE.MeshLambertMaterial({ color: 0x2b4d8c }));
    const glassM = this.track(new THREE.MeshLambertMaterial({ color: 0x1a2027, transparent: true, opacity: 0.42 }));
    const lightM = this.track(new THREE.MeshBasicMaterial({ color: 0xfff7e4 }));
    const poleM = this.track(new THREE.MeshStandardMaterial({ color: 0xb9bdc2, metalness: 0.8, roughness: 0.25 }));
    const doorM = this.track(new THREE.MeshStandardMaterial({ color: 0xb4b8bd, metalness: 0.5, roughness: 0.5 }));

    // floor / ceiling
    this.box(len, 0.12, w, floorM, 0, -0.06, 0);
    this.box(len, 0.1, w, steel, 0, CAR_INTERIOR_H + 0.05, 0);
    for (let x = -len / 2 + 1.4; x < len / 2; x += 2.6) {
      this.box(1.7, 0.05, 0.3, lightM, x, CAR_INTERIOR_H - 0.03, -0.5);
      this.box(1.7, 0.05, 0.3, lightM, x, CAR_INTERIOR_H - 0.03, 0.5);
    }
    // end walls with cab door
    for (const e of [-1, 1]) {
      this.box(0.08, CAR_INTERIOR_H, w, steel, e * (len / 2), CAR_INTERIOR_H / 2, 0);
      this.box(0.1, 1.5, 0.7, glassM, e * (len / 2), 1.35, 0);
    }

    // side walls with 3 door bays; door bay centers at -len/3, 0, +len/3
    const bays = [-len / 3, 0, len / 3];
    const doorW = 1.3;
    for (const side of [-1, 1]) {
      const z = side * hw;
      // wall segments between bays
      const cuts = [-len / 2, ...bays.flatMap((b) => [b - doorW / 2, b + doorW / 2]), len / 2];
      for (let i = 0; i < cuts.length; i += 2) {
        const a = cuts[i], b = cuts[i + 1];
        if (b - a < 0.05) continue;
        const seg = b - a;
        // lower wall, window, upper band
        this.box(seg, 1.1, 0.06, steel, (a + b) / 2, 0.55, z);
        this.box(seg, 0.72, 0.05, glassM, (a + b) / 2, 1.46, z);
        this.box(seg, CAR_INTERIOR_H - 1.82, 0.06, steel, (a + b) / 2, (1.82 + CAR_INTERIOR_H) / 2, z);
      }
      // benches between bays (skip door bays)
      for (let i = 2; i < cuts.length - 2; i += 2) {
        const a = cuts[i] + 0.15, b = cuts[i + 1] - 0.15;
        if (b - a < 1) continue;
        this.box(b - a, 0.1, 0.55, benchM, (a + b) / 2, 0.46, side * (hw - 0.33));
        this.box(b - a, 0.5, 0.08, benchM, (a + b) / 2, 0.75, side * (hw - 0.08));
      }
      // doors (two panels per bay, slide along x)
      for (const b of bays) {
        for (const d of [-1, 1] as const) {
          const panel = this.box(doorW / 2, CAR_INTERIOR_H - 0.1, 0.06, doorM, b + (d * doorW) / 4, (CAR_INTERIOR_H - 0.1) / 2, z);
          const win = this.box(doorW / 2 - 0.18, 0.65, 0.052, glassM, 0, 0.35, 0.002, panel);
          win.position.set(0, 0.35, 0.002);
          this.doorPanels.push({ mesh: panel, home: b + (d * doorW) / 4, dir: d });
        }
      }
    }

    // poles
    const poleGeo = this.track(new THREE.CylinderGeometry(0.028, 0.028, CAR_INTERIOR_H, 8));
    for (const x of [-len / 4, len / 4]) {
      for (const z of [-0.5, 0.5]) {
        const p = new THREE.Mesh(poleGeo, poleM);
        p.position.set(x, CAR_INTERIOR_H / 2, z);
        this.scene.add(p);
      }
    }

    // strip maps above the windows (both sides)
    this.stripMat = this.track(new THREE.MeshBasicMaterial({ transparent: false }));
    const stripGeo = this.track(new THREE.PlaneGeometry(4.6, 0.29));
    for (const side of [-1, 1]) {
      const sm = new THREE.Mesh(stripGeo, this.stripMat);
      sm.position.set(0, 1.98, side * (hw - 0.075));
      if (side === 1) sm.rotation.y = Math.PI;
      this.scene.add(sm);
    }
  }

  private buildOutside() {
    // tunnel walls
    const wallM = this.track(new THREE.MeshLambertMaterial({ color: 0x101215 }));
    this.box(90, 6, 0.3, wallM, 0, 1.5, 3.1);
    this.box(90, 6, 0.3, wallM, 0, 1.5, -3.1);
    this.box(90, 0.3, 6.5, wallM, 0, -0.9, 0);

    // moving light streaks
    const n = 26;
    const geo = this.track(new THREE.PlaneGeometry(0.5, 0.12));
    const mat = this.track(new THREE.MeshBasicMaterial({ color: 0xd8e6ff }));
    this.streaks = new THREE.InstancedMesh(geo, mat, n * 2);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n * 2; i++) {
      const side = i < n ? 1 : -1;
      const x = -45 + Math.random() * 90;
      m.makeRotationY(side === 1 ? Math.PI : 0).setPosition(x, 1.4 + Math.random() * 0.7, side * 2.9);
      this.streaks.setMatrixAt(i, m);
    }
    this.scene.add(this.streaks);

    // arrival backdrop (station wall + mosaic) on the +z (door-opening) side,
    // between the car and the tunnel wall so it isn't occluded
    this.scene.add(this.backdrop);
    this.backdrop.position.set(0, 0, 2.75);
    this.backdrop.visible = true;
  }

  private setBackdrop(stationId: string) {
    // clear previous
    for (const c of [...this.backdrop.children]) {
      this.backdrop.remove(c);
      const mesh = c as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.MeshLambertMaterial | undefined;
      if (mat?.map) mat.map.dispose();
      mat?.dispose();
    }
    const band = this.bandColors.get(stationId) ?? '#555';
    const name = this.names.get(stationId) ?? '';
    const wallTex = makeWallTexture(band);
    wallTex.repeat.set(8, 1);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(64, 5.6), new THREE.MeshLambertMaterial({ map: wallTex }));
    wall.rotation.y = Math.PI;
    wall.position.set(0, 1.6, 0.2);
    this.backdrop.add(wall);
    const mosaic = makeNameMosaicTexture(name, band);
    const mw = 0.8 * mosaic.aspect;
    for (const mx of [-12, 0, 12]) {
      const mp = new THREE.Mesh(new THREE.PlaneGeometry(mw, 0.8), new THREE.MeshLambertMaterial({ map: mosaic.texture }));
      mp.rotation.y = Math.PI;
      mp.position.set(mx, 1.9, 0.1);
      this.backdrop.add(mp);
    }
    // platform floor slab
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(64, 4.4), new THREE.MeshLambertMaterial({ color: 0x8f8f8c }));
    slab.rotation.x = -Math.PI / 2;
    slab.position.set(0, -0.02, -2.2);
    this.backdrop.add(slab);
  }

  private setStrip() {
    const tex = makeStripMap(this.route, this.dirStops(), this.names, this.dirIdx());
    if (this.stripMat.map) this.stripMat.map.dispose();
    this.stripMat.map = tex;
    this.stripMat.needsUpdate = true;
  }

  /** Stops in travel order for the strip map. */
  private dirStops(): string[] {
    return this.dirSign === 1 ? this.stops : [...this.stops].reverse();
  }
  private dirIdx(): number {
    return this.dirSign === 1 ? this.idx : this.stops.length - 1 - this.idx;
  }

  private enterDwell(len = 12) {
    this.state = 'dwell';
    this.t = 0;
    this.stateLen = len;
    this.setBackdrop(this.stops[this.idx]);
    this.backdrop.visible = true;
    this.setStrip();
  }

  get currentStationId() { return this.stops[this.idx]; }
  get canExit() { return this.state === 'dwell'; }
  get atEnd() {
    const next = this.idx + this.dirSign;
    return next < 0 || next >= this.stops.length;
  }

  get hudInfo(): RideHud {
    const nextIdx = this.idx + this.dirSign;
    const terminalId = this.dirSign === 1 ? this.stops[this.stops.length - 1] : this.stops[0];
    return {
      route: this.route,
      state: this.state,
      thisStop: this.names.get(this.stops[this.idx]) ?? '',
      nextStop: nextIdx >= 0 && nextIdx < this.stops.length ? this.names.get(this.stops[nextIdx]) ?? null : null,
      terminal: this.names.get(terminalId) ?? '',
      atEnd: this.atEnd,
    };
  }

  update(dt: number) {
    this.t += dt;

    if (this.state === 'dwell') {
      this.doorOpenAmt = Math.min(1, this.doorOpenAmt + dt * 1.6);
      if (this.t >= this.stateLen && !this.atEnd) {
        this.state = 'closing';
        this.t = 0;
        this.stateLen = 1.4;
      }
    } else if (this.state === 'closing') {
      this.doorOpenAmt = Math.max(0, this.doorOpenAmt - dt * 1.1);
      if (this.t >= this.stateLen) {
        this.idx += this.dirSign;
        const segIdx = this.dirSign === 1 ? this.idx - 1 : this.idx;
        const secs = this.times[segIdx] ?? 90;
        this.state = 'moving';
        this.t = 0;
        this.stateLen = Math.max(8, Math.min(38, secs / 2.2));
        this.backdrop.visible = false;
      }
    } else {
      // moving: streaks scroll with an ease-in/out speed profile
      const p = Math.min(1, this.t / this.stateLen);
      const speed = 22 * Math.pow(Math.sin(Math.PI * p), 0.75);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const v = new THREE.Vector3();
      const s = new THREE.Vector3();
      for (let i = 0; i < this.streaks.count; i++) {
        this.streaks.getMatrixAt(i, m);
        m.decompose(v, q, s);
        v.x -= speed * dt; // world slides backward past the windows
        if (v.x < -45) v.x += 90;
        m.compose(v, q, s);
        this.streaks.setMatrixAt(i, m);
      }
      this.streaks.instanceMatrix.needsUpdate = true;
      if (this.t >= this.stateLen) this.enterDwell(12);
    }

    // door panel animation
    const slide = 0.62 * this.doorOpenAmt;
    for (const d of this.doorPanels) {
      d.mesh.position.x = d.home + d.dir * slide;
    }
  }

  dispose() {
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mt of mats) {
          const lm = mt as THREE.MeshLambertMaterial;
          if (lm.map) lm.map.dispose();
        }
      }
    });
    for (const d of this.disposables) d.dispose();
    this.scene.clear();
  }
}
