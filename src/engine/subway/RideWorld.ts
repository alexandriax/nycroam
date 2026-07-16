import * as THREE from 'three';
import type { NetworkData, StationSpec } from './types';
import { routeColor, bulletTextColor } from './types';
import { makeWallTexture, makeNameMosaicTexture } from './signage';
import { SANS, BLACK } from '../fonts';

export interface RideHud {
  route: string;
  state: 'dwell' | 'closing' | 'moving';
  thisStop: string;
  nextStop: string | null;
  terminal: string;
  atEnd: boolean;
}

const CAR_INTERIOR_H = 2.15;

/** Heavy route bullet for the strip map (Archivo Black glyph on a colored disc). */
function drawHeavyBullet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, routeId: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = routeColor(routeId);
  ctx.fill();
  ctx.fillStyle = bulletTextColor(routeId);
  ctx.font = `${Math.round(r * 1.1)}px ${BLACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(routeId, x, y + r * 0.04);
  ctx.restore();
}

/**
 * MTA-style line diagram baked to a texture. Left -> right is the direction of
 * travel (stops arrive pre-reversed by direction). Stations behind the train
 * are dimmed (greyed hollow dots + muted labels), the current station is a big
 * filled dot with a "you are here" triangle and a heavy label, and upcoming
 * stations are open route-colored circles. The traveled portion of the line is
 * greyed; the portion ahead is drawn in the route color.
 */
function makeStripMap(routeId: string, stops: string[], names: Map<string, string>, currentIdx: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 2048; cv.height = 128;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#f4f2ec';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const color = routeColor(routeId);
  const dim = '#c7c6bd'; // greyed line/ring for already-visited stops
  const x0 = 96, x1 = cv.width - 44;
  const y = 48;
  const n = stops.length;
  const cur = x0 + ((x1 - x0) * currentIdx) / Math.max(1, n - 1);

  ctx.lineCap = 'round';
  // traveled portion (behind the train): greyed
  ctx.lineWidth = 9;
  ctx.strokeStyle = dim;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(Math.max(x0, cur), y); ctx.stroke();
  // portion ahead: full route color
  ctx.lineWidth = 11;
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(cur, y); ctx.lineTo(x1, y); ctx.stroke();

  drawHeavyBullet(ctx, 46, y, 30, routeId);

  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / Math.max(1, n - 1);
    const visited = i < currentIdx;
    const current = i === currentIdx;
    if (current) {
      // "you are here" triangle just above the dot
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.moveTo(x, y - 15); ctx.lineTo(x - 9, y - 27); ctx.lineTo(x + 9, y - 27); ctx.closePath();
      ctx.fill();
      // large filled dot: dark ring, route-colored core, white pin
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    } else if (visited) {
      // already served: greyed hollow dot
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#eae8e1'; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = '#b4b3aa'; ctx.stroke();
    } else {
      // upcoming: open route-colored circle
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = color; ctx.stroke();
    }
    const name = names.get(stops[i]) ?? stops[i];
    const label = name.length > 20 ? name.slice(0, 19) + '…' : name;
    ctx.save();
    ctx.translate(x, y + 24);
    ctx.rotate(0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (current) { ctx.font = `19px ${BLACK}`; ctx.fillStyle = '#111'; }
    else if (visited) { ctx.font = `17px ${SANS}`; ctx.fillStyle = '#9d9c93'; }
    else { ctx.font = `18px ${SANS}`; ctx.fillStyle = '#2f2e2a'; }
    ctx.fillText(label, 0, 0);
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

  private doorPanels: { mesh: THREE.Object3D; home: number; dir: 1 | -1 }[] = [];
  private streaks!: THREE.InstancedMesh;
  private backdrop = new THREE.Group();
  private backdropWall!: THREE.Mesh;
  private mosaicPlane!: THREE.Mesh;
  private stripMat!: THREE.MeshBasicMaterial;
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private carHalf: number;

  // two-sided outside world + scrolling tunnel
  private sidePos = new THREE.Group();   // +z (door/platform) side — tunnel while moving
  private sideNeg = new THREE.Group();   // -z side — opposing track, always visible
  private scrollOffset = 0;
  private scrollers: { mesh: THREE.InstancedMesh; rest: THREE.Matrix4[]; baseX: number[]; span: number; factor: number }[] = [];
  private expressStation = new THREE.Group();
  private expressNameMat!: THREE.MeshLambertMaterial;
  private expressActive = false;

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
    const cabWinM = this.track(new THREE.MeshLambertMaterial({ color: 0x0d1116 }));
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
    // end walls with cab door — window is an opaque dark panel (no transparency to mis-sort)
    for (const e of [-1, 1]) {
      this.box(0.08, CAR_INTERIOR_H, w, steel, e * (len / 2), CAR_INTERIOR_H / 2, 0);
      this.box(0.06, 1.5, 0.7, cabWinM, e * (len / 2) - e * 0.03, 1.35, 0);
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
        // lower wall + upper band are solid steel; the window row (y 1.1..1.82) is
        // left as a real OPENING so you see straight out with zero transparency sort.
        this.box(seg, 1.1, 0.06, steel, (a + b) / 2, 0.55, z);
        this.box(seg, CAR_INTERIOR_H - 1.82, 0.06, steel, (a + b) / 2, (1.82 + CAR_INTERIOR_H) / 2, z);
        // thin opaque frame around the opening: sill lip, header lip, vertical mullions
        this.box(seg, 0.06, 0.09, steel, (a + b) / 2, 1.11, z);
        this.box(seg, 0.06, 0.09, steel, (a + b) / 2, 1.81, z);
        const panes = Math.max(1, Math.round(seg / 1.5));
        for (let k = 1; k < panes; k++) {
          this.box(0.05, 0.7, 0.09, steel, a + (seg * k) / panes, 1.46, z);
        }
      }
      // benches between bays (skip door bays)
      for (let i = 2; i < cuts.length - 2; i += 2) {
        const a = cuts[i] + 0.15, b = cuts[i + 1] - 0.15;
        if (b - a < 1) continue;
        this.box(b - a, 0.1, 0.55, benchM, (a + b) / 2, 0.46, side * (hw - 0.33));
        this.box(b - a, 0.5, 0.08, benchM, (a + b) / 2, 0.75, side * (hw - 0.08));
      }
      // doors (two panels per bay, slide along x). Each panel is an opaque frame
      // built around a real window OPENING so the outside shows through cleanly.
      const pw = doorW / 2;
      const H = CAR_INTERIOR_H - 0.1;
      for (const b of bays) {
        for (const d of [-1, 1] as const) {
          const homeX = b + (d * doorW) / 4;
          const panel = new THREE.Group();
          panel.position.set(homeX, 0, z);
          this.scene.add(panel);
          this.box(pw, 1.05, 0.06, doorM, 0, 0.525, 0, panel);              // below window
          this.box(pw, H - 1.82, 0.06, doorM, 0, (1.82 + H) / 2, 0, panel);  // above window
          const stile = 0.09;
          this.box(stile, 0.77, 0.06, doorM, -pw / 2 + stile / 2, 1.435, 0, panel);
          this.box(stile, 0.77, 0.06, doorM, pw / 2 - stile / 2, 1.435, 0, panel);
          this.doorPanels.push({ mesh: panel, home: homeX, dir: d });
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
    const SPAN = 100;
    // dark tunnel materials (all opaque so nothing z-fights)
    const wallM = this.track(new THREE.MeshLambertMaterial({ color: 0x15171b }));
    const bedM = this.track(new THREE.MeshLambertMaterial({ color: 0x0b0c0f }));
    const railM = this.track(new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.35 }));
    const tieM = this.track(new THREE.MeshLambertMaterial({ color: 0x241d17 }));
    const colM = this.track(new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.7, roughness: 0.5 }));
    const litM = this.track(new THREE.MeshBasicMaterial({ color: 0xf3e6c0 }));
    const groundM = this.track(new THREE.MeshLambertMaterial({ color: 0x090a0c }));

    // shared ballast floor under the whole trackway
    this.box(SPAN + 24, 0.3, 11, groundM, 0, -0.95, 0);

    // shared geometries for the scrolling instanced layers
    const colGeo = this.track(new THREE.BoxGeometry(0.14, 3.4, 0.14));
    const tieGeo = this.track(new THREE.BoxGeometry(0.2, 0.08, 1.15));
    const litGeo = this.track(new THREE.BoxGeometry(0.5, 0.16, 0.16));

    this.scene.add(this.sideNeg);
    this.scene.add(this.sidePos);

    for (const S of [1, -1] as const) {
      const grp = S === 1 ? this.sidePos : this.sideNeg;
      const ph = S === 1 ? 0 : 2.1; // phase so the two sides aren't mirror-identical
      // static shell: dark back wall, track bed, two continuous rails
      this.box(SPAN + 24, 6.6, 0.4, wallM, 0, 1.5, S * 4.0, grp);
      this.box(SPAN + 24, 0.24, 1.7, bedM, 0, -0.36, S * 2.65, grp);
      this.box(SPAN + 24, 0.07, 0.07, railM, 0, -0.2, S * 2.3, grp);
      this.box(SPAN + 24, 0.07, 0.07, railM, 0, -0.2, S * 3.0, grp);

      // scrolling steel columns close to the window — the main motion cue
      const colP: { x: number; y: number; z: number }[] = [];
      for (let x = -SPAN / 2; x < SPAN / 2; x += 4.5) colP.push({ x: x + ph, y: 1.3, z: S * 1.95 });
      this.addScroller(colGeo, colM, colP, SPAN, 1.0, grp);
      // scrolling sleepers across the opposing track
      const tieP: { x: number; y: number; z: number }[] = [];
      for (let x = -SPAN / 2; x < SPAN / 2; x += 2.2) tieP.push({ x: x + ph * 0.5, y: -0.28, z: S * 2.65 });
      this.addScroller(tieGeo, tieM, tieP, SPAN, 1.0, grp);
      // scrolling ceiling/wall lights
      const litP: { x: number; y: number; z: number }[] = [];
      for (let x = -SPAN / 2; x < SPAN / 2; x += 5.0) litP.push({ x: x + ph, y: 2.75, z: S * 3.5 });
      this.addScroller(litGeo, litM, litP, SPAN, 1.0, grp);
    }

    // fast foreground streaks just outside both window lines
    const streakGeo = this.track(new THREE.PlaneGeometry(0.6, 0.1));
    const streakMat = this.track(new THREE.MeshBasicMaterial({ color: 0xd8e6ff }));
    const streakP: { x: number; y: number; z: number; ry: number }[] = [];
    for (const S of [1, -1] as const) {
      for (let i = 0; i < 30; i++) {
        streakP.push({ x: -SPAN / 2 + Math.random() * SPAN, y: 1.15 + Math.random() * 0.6, z: S * 1.75, ry: S === 1 ? Math.PI : 0 });
      }
    }
    this.streaks = this.addScroller(streakGeo, streakMat, streakP, SPAN, 1.35, this.scene);
    this.streaks.visible = false;

    // express pass-through platform (lives on the +z side group, hidden until used)
    this.buildExpressStation();

    // arrival backdrop (station wall + mosaic) on the +z (door-opening) side
    this.scene.add(this.backdrop);
    this.backdrop.position.set(0, 0, 2.75);
    this.backdrop.visible = true;
    this.sideNeg.visible = true;
    this.sidePos.visible = false;
  }

  /** Build an InstancedMesh whose instances scroll along x while the train moves. */
  private addScroller(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    placements: { x: number; y: number; z: number; ry?: number }[],
    span: number,
    factor: number,
    parent: THREE.Object3D,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, placements.length);
    mesh.frustumCulled = false;
    const rest: THREE.Matrix4[] = [];
    const baseX: number[] = [];
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const eu = new THREE.Euler();
    for (let i = 0; i < placements.length; i++) {
      const pl = placements[i];
      eu.set(0, pl.ry ?? 0, 0);
      q.setFromEuler(eu);
      pos.set(0, pl.y, pl.z);
      const m = new THREE.Matrix4().compose(pos, q, s);
      rest.push(m);
      baseX.push(pl.x);
      mesh.setMatrixAt(i, m.clone().setPosition(pl.x, pl.y, pl.z));
    }
    mesh.instanceMatrix.needsUpdate = true;
    parent.add(mesh);
    this.scrollers.push({ mesh, rest, baseX, span, factor });
    return mesh;
  }

  /** Advance every scroll layer by the shared offset, wrapping within its span. */
  private updateScroll() {
    const tmp = new THREE.Matrix4();
    for (const sc of this.scrollers) {
      const half = sc.span / 2;
      for (let i = 0; i < sc.baseX.length; i++) {
        let x = sc.baseX[i] - this.scrollOffset * sc.factor;
        x = (((x + half) % sc.span) + sc.span) % sc.span - half;
        tmp.copy(sc.rest[i]);
        tmp.elements[12] = x;
        sc.mesh.setMatrixAt(i, tmp);
      }
      sc.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** A lit local-station platform that sweeps past the +z windows mid-segment. */
  private buildExpressStation() {
    const g = this.expressStation;
    g.visible = false;
    this.sidePos.add(g);
    const slabM = this.track(new THREE.MeshLambertMaterial({ color: 0x6f6f6c }));
    this.box(9, 0.3, 3.0, slabM, 0, -0.15, 3.0, g);
    const wallMat = this.track(new THREE.MeshLambertMaterial({ color: 0xdedad0 }));
    const wt = this.track(makeWallTexture('#6b6b6b'));
    wt.repeat.set(6, 1);
    wallMat.map = wt;
    this.box(9, 3.4, 0.2, wallMat, 0, 1.5, 3.9, g);
    const edgeM = this.track(new THREE.MeshBasicMaterial({ color: 0xfff3d0 }));
    this.box(9, 0.12, 0.12, edgeM, 0, 0.06, 2.4, g);                    // lit platform edge
    for (let x = -4; x <= 4; x += 2) this.box(1.2, 0.16, 0.5, edgeM, x, 2.9, 3.4, g); // ceiling lights
    this.expressNameMat = this.track(new THREE.MeshLambertMaterial({ color: 0x111111 }));
    for (const mx of [-2.7, 2.7]) this.box(2.3, 0.72, 0.05, this.expressNameMat, mx, 1.7, 3.75, g);
  }

  /** Swap the express platform's name mosaic to a plausible skipped stop on this line. */
  private setExpressName(name: string) {
    const band = this.bandColors.get(this.stops[this.idx]) ?? '#8a8a8a';
    const { texture } = makeNameMosaicTexture(name, band);
    if (this.expressNameMat.map) this.expressNameMat.map.dispose();
    this.expressNameMat.map = texture;
    this.expressNameMat.needsUpdate = true;
  }

  private pickExpressName(): string {
    const pool = this.stops
      .map((s) => this.names.get(s) ?? s)
      .filter((_, k) => Math.abs(k - this.idx) > 1);
    if (pool.length === 0) return this.names.get(this.stops[this.idx]) ?? 'LOCAL';
    return pool[Math.floor(Math.random() * pool.length)];
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
    this.sidePos.visible = false;      // +z shows the platform, not the tunnel
    this.expressActive = false;
    this.expressStation.visible = false;
    if (this.streaks) this.streaks.visible = false;
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
        // reveal the tunnel on both sides, hide the platform backdrop
        this.backdrop.visible = false;
        this.sidePos.visible = true;
        this.streaks.visible = true;
        // schedule an express fly-by for long (express) segments
        this.expressActive = this.stateLen >= 15;
        if (this.expressActive) this.setExpressName(this.pickExpressName());
        this.expressStation.visible = false;
      }
    } else {
      // moving: scroll the whole tunnel with an ease-in/out speed profile
      const p = Math.min(1, this.t / this.stateLen);
      const speed = 24 * Math.pow(Math.sin(Math.PI * p), 0.7);
      this.scrollOffset += speed * dt; // world slides backward past the windows
      this.updateScroll();
      // express platform sweeps past the +z windows around mid-segment
      if (this.expressActive) {
        const w0 = 0.32, w1 = 0.68;
        if (p > w0 && p < w1) {
          this.expressStation.visible = true;
          this.expressStation.position.x = (0.5 - (p - w0) / (w1 - w0)) * 80;
        } else {
          this.expressStation.visible = false;
        }
      }
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
