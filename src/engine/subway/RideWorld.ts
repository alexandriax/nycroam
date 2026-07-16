import * as THREE from 'three';
import type { NetworkData, StationSpec } from './types';
import { routeColor, bulletTextColor } from './types';
import { makeWallTexture, makeNameMosaicTexture } from './signage';
import { SANS, BLACK, LED } from '../fonts';

export interface RideHud {
  route: string;
  state: 'dwell' | 'closing' | 'moving';
  thisStop: string;
  nextStop: string | null;
  terminal: string;
  atEnd: boolean;
}

const CAR_INTERIOR_H = 2.15;

// Arrival/departure choreography. The platform backdrop slides along world-x so
// the station rolls in through the windows instead of popping on at dwell. ROLLX
// is how far ahead (+x) / behind (-x) the platform sits at the ends of the slide;
// the roll-in occupies the last (1-RIN) of `moving`, the roll-out the first ROUT.
const RIDE_ROLLX = 60;
const RIDE_RIN = 0.75;
const RIDE_ROUT = 0.2;

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
  const x0 = 96, x1 = cv.width - 130; // wider right margin so the terminal label fits
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
    const label = name.length > 18 ? name.slice(0, 17) + '…' : name;
    ctx.save();
    ctx.translate(x, y + 24);
    ctx.rotate(0.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let fs: number, fam: string;
    if (current) { fs = 19; fam = BLACK; ctx.fillStyle = '#111'; }
    else if (visited) { fs = 17; fam = SANS; ctx.fillStyle = '#9d9c93'; }
    else { fs = 18; fam = SANS; ctx.fillStyle = '#2f2e2a'; }
    // Shrink the font so the rotated label never runs off the right or bottom of
    // the canvas: a label of pixel-width W reaches cos(0.5)*W right and sin(0.5)*W
    // down from its anchor, so cap W by whichever edge is nearer.
    const budget = Math.min((cv.width - 8 - x) / Math.cos(0.5), (cv.height - 6 - (y + 24)) / Math.sin(0.5));
    ctx.font = `${fs}px ${fam}`;
    const tw = ctx.measureText(label).width;
    if (tw > budget) { fs = Math.max(11, Math.floor((fs * budget) / tw)); ctx.font = `${fs}px ${fam}`; }
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
  private rollInStarted = false;             // one-shot guard: set backdrop content when the roll-in begins

  private doorPanels: { mesh: THREE.Object3D; home: number; dir: 1 | -1; side: 1 | -1 }[] = [];
  private streaks!: THREE.InstancedMesh;
  private backdrop = new THREE.Group();      // +z platform (door side)
  private backdropNeg = new THREE.Group();   // -z platform (mirror, for island platforms)
  private backdropWall!: THREE.Mesh;
  private mosaicPlane!: THREE.Mesh;
  private stripMat!: THREE.MeshBasicMaterial;
  private nextSign = new THREE.Group();      // center hanging next-stop announcement sign
  private nextSignMat!: THREE.MeshBasicMaterial;
  private ledCv?: HTMLCanvasElement;         // reused canvas for the red-on-black LED sign bake
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
    // interior steel: shifted a touch darker/cooler than the old 0xc9ccd0 so the
    // car reads as an interior, not an exterior panel, seen under the cabin lights.
    const steel = this.track(new THREE.MeshStandardMaterial({ color: 0xb4b7ba, metalness: 0.55, roughness: 0.45 }));
    const floorM = this.track(new THREE.MeshLambertMaterial({ color: 0x9a8f7c }));
    const benchM = this.track(new THREE.MeshLambertMaterial({ color: 0x2b4d8c }));
    const cabWinM = this.track(new THREE.MeshLambertMaterial({ color: 0x0d1116 }));
    const lightM = this.track(new THREE.MeshBasicMaterial({ color: 0xfff7e4 }));
    const poleM = this.track(new THREE.MeshStandardMaterial({ color: 0xb9bdc2, metalness: 0.8, roughness: 0.25 }));
    const doorM = this.track(new THREE.MeshStandardMaterial({ color: 0xb4b8bd, metalness: 0.5, roughness: 0.5 }));
    // storm-door steel: a shade darker than the wall so the end-of-car door reads
    // as its own fixture, not a continuation of the wall plane.
    const stormDoorM = this.track(new THREE.MeshStandardMaterial({ color: 0x9a9ea3, metalness: 0.55, roughness: 0.4 }));
    // next-car diorama palette: dimmer greys/blue than the main cabin so the car
    // glimpsed through the storm-door window reads as farther away / less lit.
    const dioramaFloorM = this.track(new THREE.MeshLambertMaterial({ color: 0x6f6656 }));
    const dioramaWallM = this.track(new THREE.MeshLambertMaterial({ color: 0x7c7f82 }));
    const dioramaBenchM = this.track(new THREE.MeshLambertMaterial({ color: 0x1f3660 }));
    const dioramaLightM = this.track(new THREE.MeshBasicMaterial({ color: 0xd9c79c }));
    const dioramaPoleGeo = this.track(new THREE.CylinderGeometry(0.024, 0.024, 1.9, 8));

    // floor / ceiling
    this.box(len, 0.12, w, floorM, 0, -0.06, 0);
    this.box(len, 0.1, w, steel, 0, CAR_INTERIOR_H + 0.05, 0);
    for (let x = -len / 2 + 1.4; x < len / 2; x += 2.6) {
      this.box(1.7, 0.05, 0.3, lightM, x, CAR_INTERIOR_H - 0.03, -0.5);
      this.box(1.7, 0.05, 0.3, lightM, x, CAR_INTERIOR_H - 0.03, 0.5);
    }
    // end walls: a storm door (with a real window into the next car) flanked by
    // two small dark windows. The flush end-wall skin has a genuine rectangular
    // OPENING directly behind the door's own window opening — both real holes,
    // zero transparency — so riders looking through see a lit next-car diorama
    // beyond the end of this car instead of blackness.
    const dsHalfW = 0.35;               // storm-door half-width (0.7 m door)
    const winHalfW = 0.20;              // door-window half-width (0.4 m opening)
    const winY0 = 1.05, winY1 = 1.85;   // door-window y-range (0.8 m tall, eye height)
    const doorY0 = 0.08, doorY1 = 1.98; // storm-door panel y-range (1.9 m tall)
    const doorProud = 0.05;             // door sits this far in front of the wall skin, toward the interior
    const bandH = winY1 - winY0, bandYc = (winY0 + winY1) / 2;
    const flankSegW = hw - winHalfW;    // wall width on either side of the window opening
    for (const e of [-1, 1] as const) {
      const xw = e * (len / 2);         // flush end-wall plane
      const xd = xw - e * doorProud;    // storm-door plane, proud toward the car interior

      // flush end-wall skin: solid bands above/below the window, solid flanking
      // segments beside it — the gap between them is the real opening.
      this.box(0.08, winY0, w, steel, xw, winY0 / 2, 0);
      this.box(0.08, CAR_INTERIOR_H - winY1, w, steel, xw, (winY1 + CAR_INTERIOR_H) / 2, 0);
      if (flankSegW > 0.02) {
        this.box(0.08, bandH, flankSegW, steel, xw, bandYc, (hw + winHalfW) / 2);
        this.box(0.08, bandH, flankSegW, steel, xw, bandYc, -(hw + winHalfW) / 2);
      }
      // two small flanking windows: opaque dark panes proud of the flush wall
      // (decorative, not real openings — same trick the old single cab-window pane used)
      this.box(0.06, 0.7, 0.5, cabWinM, xw - e * 0.03, bandYc, (hw + winHalfW) / 2);
      this.box(0.06, 0.7, 0.5, cabWinM, xw - e * 0.03, bandYc, -(hw + winHalfW) / 2);

      // storm-door panel: proud door-grey frame with its own matching window
      // opening (below-window band, above-window band, two stiles).
      this.box(0.06, winY0 - doorY0, dsHalfW * 2, stormDoorM, xd, (doorY0 + winY0) / 2, 0);
      this.box(0.06, doorY1 - winY1, dsHalfW * 2, stormDoorM, xd, (winY1 + doorY1) / 2, 0);
      const stileW = dsHalfW - winHalfW;
      this.box(0.06, bandH, stileW, stormDoorM, xd, bandYc, (winHalfW + dsHalfW) / 2);
      this.box(0.06, bandH, stileW, stormDoorM, xd, bandYc, -(winHalfW + dsHalfW) / 2);

      // next-car diorama: parented beyond the end wall (x runs from the wall out
      // to xw + e*dioramaDepth) so the storm-door window looks into a short lit
      // interior with real depth instead of the tunnel/void.
      const dd = 2.4;       // diorama depth
      const dw = w - 0.1;   // stay within the car's own width
      const dh = 2.05;      // slightly shorter than this car's interior height
      const cx = xw + e * (dd / 2);
      this.box(dd, 0.1, dw, dioramaFloorM, cx, -0.06, 0);                                    // floor
      this.box(dd, 0.08, dw, dioramaWallM, cx, dh + 0.04, 0);                                // ceiling
      this.box(dd, dh, 0.06, dioramaWallM, cx, dh / 2, dw / 2);                              // side wall
      this.box(dd, dh, 0.06, dioramaWallM, cx, dh / 2, -dw / 2);                             // side wall
      this.box(0.08, dh, dw, dioramaWallM, xw + e * dd, dh / 2, 0);                          // far wall — closes off the void
      this.box(dd * 0.85, 0.04, 0.5, dioramaLightM, cx, dh - 0.04, 0);                       // dim ceiling light strip
      this.box(dd * 0.5, 0.1, 0.4, dioramaBenchM, xw + e * dd * 0.62, 0.42, dw / 2 - 0.25);  // bench hint
      for (const pz of [-0.4, 0.4]) {
        const p = new THREE.Mesh(dioramaPoleGeo, poleM);
        p.position.set(xw + e * dd * 0.35, dh / 2 - 0.05, pz);
        this.scene.add(p);
      }
    }

    // side walls with 3 door bays; door bay centers at -len/3, 0, +len/3
    const bays = [-len / 3, 0, len / 3];
    const doorW = 1.3;
    for (const side of [-1, 1] as const) {
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
          // opaque near-black "dark glass" pane filling the window opening so a
          // shut door reads as shut (no see-through hole). Slightly inset toward
          // the interior; it slides away with the panel when the door opens.
          this.box(pw - 2 * stile, 0.77, 0.04, cabWinM, 0, 1.435, -side * 0.012, panel);
          this.doorPanels.push({ mesh: panel, home: homeX, dir: d, side });
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

    // center hanging NEXT-STOP sign: a WIDE, THIN red dot-matrix LED strip (like
    // the ones on real rolling stock), built from two back-to-back single-sided
    // quads facing ±x so it reads from either end of the car. The sign width runs
    // along z (across the car), so a literal ~4.2 m strip would punch through the
    // ~2.5–3 m-wide walls into the tunnel; it's sized to span the interior instead
    // while keeping the wide/thin LED aspect (matches the 2048×280 bake canvas).
    this.nextSignMat = this.track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const signGeo = this.track(new THREE.PlaneGeometry(2.5, 0.34));
    for (const ry of [Math.PI / 2, -Math.PI / 2]) {
      const s = new THREE.Mesh(signGeo, this.nextSignMat);
      s.rotation.y = ry;
      this.nextSign.add(s);
    }
    this.nextSign.position.set(0, CAR_INTERIOR_H - 0.20, 0); // just under the ceiling
    this.scene.add(this.nextSign);
    this.box(0.06, 0.12, 0.06, steel, 0, CAR_INTERIOR_H - 0.05, 0); // mount bracket to ceiling
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

    // arrival backdrop (station wall + mosaic) on BOTH sides: +z is the door
    // side, -z is the mirrored island-platform view so neither window row is black.
    this.scene.add(this.backdrop);
    this.backdrop.position.set(0, 0, 2.75);
    this.backdrop.visible = true;
    this.scene.add(this.backdropNeg);
    this.backdropNeg.position.set(0, 0, -2.75);
    this.backdropNeg.visible = true;
    // start dwelling: both platforms shown, both tunnels hidden
    this.sideNeg.visible = false;
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
    // clear previous content on both platforms
    for (const grp of [this.backdrop, this.backdropNeg]) {
      for (const c of [...grp.children]) {
        grp.remove(c);
        const mesh = c as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.MeshLambertMaterial | undefined;
        if (mat?.map) mat.map.dispose();
        mat?.dispose();
      }
    }
    const band = this.bandColors.get(stationId) ?? '#555';
    const name = this.names.get(stationId) ?? '';
    // Build a mirrored copy on each side. The group sits at z = S*2.75; local z
    // is signed by S and the wall/mosaic face the car (rot.y = PI on +z, 0 on -z)
    // so both window rows look out onto a lit platform + tiled wall + name tablet.
    for (const S of [1, -1] as const) {
      const grp = S === 1 ? this.backdrop : this.backdropNeg;
      const face = S === 1 ? Math.PI : 0;
      const wallTex = makeWallTexture(band);
      wallTex.repeat.set(8, 1);
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(64, 5.6), new THREE.MeshLambertMaterial({ map: wallTex }));
      wall.rotation.y = face;
      wall.position.set(0, 1.6, S * 0.2);
      grp.add(wall);
      const mosaic = makeNameMosaicTexture(name, band);
      const mw = 0.8 * mosaic.aspect;
      for (const mx of [-12, 0, 12]) {
        const mp = new THREE.Mesh(new THREE.PlaneGeometry(mw, 0.8), new THREE.MeshLambertMaterial({ map: mosaic.texture }));
        mp.rotation.y = face;
        mp.position.set(mx, 1.9, S * 0.1);
        grp.add(mp);
      }
      // platform floor slab (horizontal; normal faces up either way)
      const slab = new THREE.Mesh(new THREE.PlaneGeometry(64, 4.4), new THREE.MeshLambertMaterial({ color: 0x8f8f8c }));
      slab.rotation.x = -Math.PI / 2;
      slab.position.set(0, -0.02, S * -2.2);
      grp.add(slab);
    }
  }

  /**
   * Bake the center announcement sign as bright MTA-red ALL-CAPS text on a black
   * panel in the VT323 LED face — the classic NYC car interior next-stop strip.
   * The caps message is auto-fit to the strip width and drawn WITHOUT synthetic
   * bold (the pixel face smears) with a soft same-color glow so it reads as a lit
   * LED display. One reusable canvas backs it; the CanvasTexture is remade and
   * the old map disposed on each redraw.
   */
  private setNextSign(text: string) {
    const W = 2048, H = 280;
    if (!this.ledCv) { this.ledCv = document.createElement('canvas'); this.ledCv.width = W; this.ledCv.height = H; }
    const ctx = this.ledCv.getContext('2d')!;
    const caps = text.toUpperCase();

    // black panel
    ctx.fillStyle = '#080609';
    ctx.fillRect(0, 0, W, H);

    // auto-fit the caps line to the strip width (VT323, no bold keyword)
    let fs = Math.round(H * 0.82);
    const maxW = W * 0.94;
    ctx.font = `${fs}px ${LED}`;
    while (ctx.measureText(caps).width > maxW && fs > 40) {
      fs -= 4;
      ctx.font = `${fs}px ${LED}`;
    }

    // bright red glyphs with a slight same-color glow for the lit-LED feel
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ff2d3a';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ff2d3a';                 // MTA red-pink, in #ff2d20..#ff2d4b
    ctx.fillText(caps, W / 2, H / 2);
    ctx.shadowBlur = 0;

    const tex = new THREE.CanvasTexture(this.ledCv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (this.nextSignMat.map) this.nextSignMat.map.dispose();
    this.nextSignMat.map = tex;
    this.nextSignMat.needsUpdate = true;
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
    this.rollInStarted = false;
    this.setBackdrop(this.stops[this.idx]);
    // finalize the roll-in: platform parked at x=0, tunnel hidden — no visual pop
    this.backdrop.position.x = 0;
    this.backdropNeg.position.x = 0;
    this.backdrop.visible = true;      // +z platform
    this.backdropNeg.visible = true;   // -z platform (mirror) — no black side
    this.sidePos.visible = false;      // both sides show the platform, not the tunnel
    this.sideNeg.visible = false;
    this.expressActive = false;
    this.expressStation.visible = false;
    if (this.streaks) this.streaks.visible = false;
    this.setStrip();
    const thisName = this.names.get(this.stops[this.idx]) ?? '';
    this.setNextSign(this.atEnd ? `(${this.route}) LAST STOP — ${thisName}` : `(${this.route}) THIS IS ${thisName}`);
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
        this.setNextSign(`(${this.route}) STAND CLEAR OF THE CLOSING DOORS`);
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
        // departure: keep the platform we're leaving on-screen (the backdrop still
        // holds the previous station's content) so it rolls OUT through the windows
        // during the first ROUT of `moving`; the tunnel stays hidden until it clears.
        this.rollInStarted = false;
        this.backdrop.position.x = 0;
        this.backdropNeg.position.x = 0;
        this.backdrop.visible = true;
        this.backdropNeg.visible = true;
        this.sidePos.visible = false;
        this.sideNeg.visible = false;
        this.streaks.visible = false;
        this.setNextSign(`(${this.route}) THE NEXT STOP IS ${this.names.get(this.stops[this.idx]) ?? ''}`);
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

      const BW = 32;                       // backdrop wall half-width (PlaneGeometry(64,..))
      const coverX = BW - this.carHalf;    // |x| below which the wall fully backs every window
      const clearX = -(BW + this.carHalf); // x below which the wall is fully past the -x windows

      if (p < RIDE_ROUT) {
        // DEPARTURE roll-out: the station we just left accelerates off toward -x;
        // the tunnel takes over the instant the platform has fully cleared.
        const v = p / RIDE_ROUT;
        const x = -RIDE_ROLLX * v * v;     // ease-in (accelerate away): 0 -> -ROLLX
        const cleared = x <= clearX;
        this.backdrop.position.x = x;
        this.backdropNeg.position.x = x;
        this.backdrop.visible = !cleared;
        this.backdropNeg.visible = !cleared;
        this.sidePos.visible = cleared;
        this.sideNeg.visible = cleared;
        this.streaks.visible = cleared;
      } else if (p < RIDE_RIN) {
        // MID-SEGMENT: pure scrolling tunnel on both sides.
        if (this.backdrop.visible) {
          this.backdrop.visible = false;
          this.backdropNeg.visible = false;
          this.backdrop.position.x = 0;
          this.backdropNeg.position.x = 0;
        }
        if (!this.sidePos.visible) {
          this.sidePos.visible = true;
          this.sideNeg.visible = true;
          this.streaks.visible = true;
        }
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
      } else {
        // ARRIVAL roll-in: the approaching station (idx already points at it)
        // glides in from +x and decelerates to a stop at x=0 as p->1. The tunnel
        // is cut the moment the wall fully backs the windows, so no double-image.
        if (!this.rollInStarted) {
          this.rollInStarted = true;
          this.expressStation.visible = false;
          this.setBackdrop(this.stops[this.idx]);
        }
        const u = (p - RIDE_RIN) / (1 - RIDE_RIN);
        const x = RIDE_ROLLX * (1 - u) * (1 - u); // ease-out (decelerate): ROLLX -> 0
        const covered = x <= coverX;
        this.backdrop.position.x = x;
        this.backdropNeg.position.x = x;
        this.backdrop.visible = true;
        this.backdropNeg.visible = true;
        this.sidePos.visible = !covered;
        this.sideNeg.visible = !covered;
        this.streaks.visible = !covered;
      }

      if (this.t >= this.stateLen) this.enterDwell(12);
    }

    // door panel animation — only the +z (platform) side opens; -z stays shut
    const slide = 0.62 * this.doorOpenAmt;
    for (const d of this.doorPanels) {
      d.mesh.position.x = d.side === 1 ? d.home + d.dir * slide : d.home;
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
