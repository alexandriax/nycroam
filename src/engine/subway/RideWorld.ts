import * as THREE from 'three';
import { transitFinish, transitGlass } from '../transitMaterials';
import { mergeByMaterial } from '../EntranceManager';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { NetworkData, StationSpec } from './types';
import { routeColor, bulletTextColor } from './types';
import { rideStationLayout, cabinRailSegments, RIDE_CEILING_Y, RIDE_RAIL_Y, rideTravelDistance, rideLegDistance, type RideStationLayout } from './rideLayout';
import { RideScenery } from './rideScenery';
import { RidePassengers } from './RidePassengers';
import { passengerSeed } from './transitPassengers';
import { SANS, BLACK, LED } from '../fonts';
import { canvas2d } from '../canvas2d';

export interface RideHud {
  route: string;
  state: 'dwell' | 'closing' | 'moving';
  thisStop: string;
  nextStop: string | null;
  terminal: string;
  atEnd: boolean;
}

const CAR_INTERIOR_H = RIDE_CEILING_Y;

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
  const { cv, ctx } = canvas2d(2048, 128);
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
  private stations: Map<string, StationSpec>;
  private stationLayout!: RideStationLayout;
  private scenery!: RideScenery;
  private passengers!: RidePassengers;
  private carWidth = 2.66;
  private doorBays: number[] = [];
  private legDistance = 0;
  private legOriginLength = 156;
  private stationVisualId = '';

  private state: 'dwell' | 'closing' | 'moving' = 'dwell';
  private t = 0;
  private stateLen = 6;
  private doorOpenAmt = 1;

  private doorPanels: { mesh: THREE.Object3D; home: number; dir: 1 | -1; side: 1 | -1 }[] = [];
  private stripMat!: THREE.MeshBasicMaterial;
  private nextSign = new THREE.Group();      // center hanging next-stop announcement sign
  private nextSignMat!: THREE.MeshBasicMaterial;
  private ledCv?: HTMLCanvasElement;         // reused canvas for the red-on-black LED sign bake
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private carHalf: number;

  private scrollOffset = 0;
  /** Integrated travel distance this update, independent of frame partition. */
  distanceThisFrame = 0;

  constructor(
    routeId: string,
    dirSign: 1 | -1,
    startStationId: string,
    network: NetworkData,
    stations: Map<string, StationSpec>,
    env: THREE.Texture | null,
  ) {
    this.route = routeId;
    this.stations = stations;
    this.dirSign = dirSign;
    // Callers validate route/start against the network, but a bad pair must
    // never take the whole app down with it — degrade to a one-stop ride
    // (instantly "Last stop" → auto-exit back to the station) instead.
    const r = network.routes[routeId] ?? { stops: [startStationId], t: [], color: '#808183' };
    this.stops = r.stops.length ? r.stops : [startStationId];
    this.times = r.t;
    this.idx = Math.max(0, this.stops.indexOf(startStationId));
    for (const [id, s] of stations) {
      this.names.set(id, s.name);
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
    this.carWidth = carW;
    this.buildCar(carLen, carW);
    this.scenery = new RideScenery(this.scene);
    this.passengers = new RidePassengers(this.scene, carLen, carW, this.doorBays, passengerSeed(routeId));
    this.setStrip();
    this.enterDwell(8);
    this.updateDoorPanels();
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
    const steel = this.track(transitFinish(new THREE.MeshStandardMaterial({ color: 0xb4b7ba, metalness: .55, roughness: .45 }), 'steel'));
    const floorM = this.track(transitFinish(new THREE.MeshStandardMaterial({ color: '#424649', roughness: .88 }), 'rubber'));
    const windowGlass = this.track(transitGlass());
    const benchM = this.track(new THREE.MeshStandardMaterial({ color: '#3976a3', roughness: .38, metalness: .05 }));
    const cabWinM = this.track(new THREE.MeshLambertMaterial({ color: 0x0d1116 }));
    const lightM = this.track(new THREE.MeshBasicMaterial({ color: 0xfff7e4 }));
    const poleM = this.track(new THREE.MeshStandardMaterial({ color: 0xb9bdc2, metalness: 0.8, roughness: 0.25 }));
    const doorM = this.track(transitFinish(new THREE.MeshStandardMaterial({ color: 0xb4b8bd, metalness: .5, roughness: .5 }), 'steel'));
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
      this.box(2.3, 0.025, 0.13, lightM, x, CAR_INTERIOR_H - 0.03, -0.5);
      this.box(2.3, 0.025, 0.13, lightM, x, CAR_INTERIOR_H - 0.03, 0.5);
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

    // Three IRT or four B-division door bays, matching the platform train.
    const bays = this.doorBays = (len < 17 ? [-.27, 0, .27] : [-.34, -.34 / 3, .34 / 3, .34]).map(x => x * len);
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
        // glazed to preserve the view through the car.
        this.box(seg, 1.1, 0.06, steel, (a + b) / 2, 0.55, z);
        this.box(seg, CAR_INTERIOR_H - 1.82, 0.06, steel, (a + b) / 2, (1.82 + CAR_INTERIOR_H) / 2, z);
        // thin opaque frame around the opening: sill lip, header lip, vertical mullions
        this.box(seg, 0.06, 0.09, steel, (a + b) / 2, 1.11, z);
        this.box(seg, 0.06, 0.09, steel, (a + b) / 2, 1.81, z);
        const panes = Math.max(1, Math.round(seg / 1.5));
        this.box(seg - .05, .65, .012, windowGlass, (a + b) / 2, 1.46, z);
        for (let k = 1; k < panes; k++) {
          this.box(0.05, 0.7, 0.09, steel, a + (seg * k) / panes, 1.46, z);
        }
      }
      // benches between bays (skip door bays)
      for (let i = 2; i < cuts.length - 2; i += 2) {
        const a = cuts[i] + 0.15, b = cuts[i + 1] - 0.15;
        if (b - a < 1) continue;
        this.box(b - a - .12, .24, .28, steel, (a + b) / 2, .25, side * (hw - .20));
        const seats = Math.max(2, Math.floor((b - a) / .46));
        const pitch = (b - a) / seats;
        for (let seat = 0; seat < seats; seat++) {
          const x = a + (seat + .5) * pitch;
          const cushion = new THREE.Mesh(this.track(new RoundedBoxGeometry(pitch - .018, .105, .49, 2, .04)), benchM);
          cushion.position.set(x, .46, side * (hw - .31)); this.scene.add(cushion);
          const back = new THREE.Mesh(this.track(new RoundedBoxGeometry(pitch - .018, .42, .09, 2, .035)), benchM);
          back.position.set(x, .71, side * (hw - .105)); back.rotation.x = -side * .10; this.scene.add(back);
        }
        for (const end of [a, b]) {
          this.box(.032, .035, .49, poleM, end, .69, side * (hw - .30));
          const seatPole = new THREE.Mesh(this.track(new THREE.CylinderGeometry(.024, .024, CAR_INTERIOR_H, 10)), poleM);
          seatPole.position.set(end, CAR_INTERIOR_H / 2, side * (hw - .53)); this.scene.add(seatPole);
          // Full-height seat dividers tie into the overhead rail, with visible
          // mounting shoes at the floor and ceiling instead of floating ends.
          this.box(.075, .035, .075, poleM, end, .018, side * (hw - .53));
          this.box(.075, .035, .075, poleM, end, CAR_INTERIOR_H - .018, side * (hw - .53));
          this.box(.046, .046, Math.abs(hw - .53 - .57), poleM, end, RIDE_RAIL_Y, side * ((hw - .53 + .57) / 2));
        }
      }
      // doors (two panels per bay, slide along x). Each panel is an opaque frame
      // built around a real window OPENING so the outside shows through cleanly.
      const pw = doorW / 2;
      const H = CAR_INTERIOR_H - 0.1;
      for (const b of bays) {
        this.box(doorW + .16, .028, .20, poleM, b, .014, z - side * .045);
        for (const edge of [-1, 1]) this.box(.045, 1.94, .10, poleM, b + edge * (doorW / 2 + .03), .97, z - side * .05);
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
          // Glazing and the edge seal travel with the steel leaf.
          this.box(pw - 2 * stile, 0.77, 0.015, windowGlass, 0, 1.435, -side * 0.012, panel);
          this.box(.015, H, .07, cabWinM, -d * (pw / 2 - .009), H / 2, 0, panel);
          this.doorPanels.push({ mesh: panel, home: homeX, dir: d, side });
        }
      }
    }

    // poles
    const poleGeo = this.track(new THREE.CylinderGeometry(0.028, 0.028, CAR_INTERIOR_H, 8));
    for (const x of [-len / 4, len / 4]) {
      for (const z of [-0.57, 0.57]) {
        const p = new THREE.Mesh(poleGeo, poleM);
        p.position.set(x, CAR_INTERIOR_H / 2, z);
        this.scene.add(p);
      }
    }

    // Continuous grab rails, mounting collars, ceiling joints and HVAC grilles.
    for (const side of [-1, 1]) {
      for (const [a, b] of cabinRailSegments(len)) {
        const railGeo = this.track(new THREE.CylinderGeometry(.023, .023, b - a, 10).rotateZ(Math.PI / 2));
        const rail = new THREE.Mesh(railGeo, poleM); rail.position.set((a + b) / 2, RIDE_RAIL_Y, side * .57); this.scene.add(rail);
        for (const x of [a + .035, b - .035]) this.box(.04, CAR_INTERIOR_H - RIDE_RAIL_Y, .04, poleM, x, (CAR_INTERIOR_H + RIDE_RAIL_Y) / 2, side * .57);
      }
      this.box(len - .3, .025, .18, steel, 0, CAR_INTERIOR_H - .014, side * .5);
      for (let x = -len / 2 + .7; x < len / 2; x += 1.3) {
        if (Math.abs(x) > .24) this.box(.035, CAR_INTERIOR_H - RIDE_RAIL_Y, .035, poleM, x, (CAR_INTERIOR_H + RIDE_RAIL_Y) / 2, side * .57);
        this.box(.014, .014, w * .90, stormDoorM, x, CAR_INTERIOR_H - .014, 0);
      }
      for (let x = -len / 2 + .8; x < len / 2 - .5; x += 2.6) {
        this.box(.85, .018, .18, cabWinM, x, CAR_INTERIOR_H - .014, side * .95);
        for (let rib = 0; rib < 12; rib++) this.box(.018, .026, .18, steel, x - .40 + rib * .07, CAR_INTERIOR_H - .03, side * .95);
      }
      this.box(len, .07, .025, stormDoorM, 0, .035, side * (hw - .04));
    }
    for (const end of [-1, 1]) {
      this.box(.07, .035, .18, poleM, end * (len / 2 - .095), .98, .28);
      this.box(.05, .17, .035, poleM, end * (len / 2 - .095), 1.035, .35);
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

    // A shallow, cased transverse LED fits below the ceiling. The longitudinal
    // rails terminate on either side of its footprint; no tube crosses its face.
    this.nextSignMat = this.track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const signGeo = this.track(new THREE.PlaneGeometry(1.86, .22));
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(signGeo, this.nextSignMat);
      panel.rotation.y = side * Math.PI / 2; panel.position.x = side * .091;
      this.nextSign.add(panel);
    }
    this.nextSign.position.set(0, CAR_INTERIOR_H - .14, 0);
    this.scene.add(this.nextSign);
    this.box(.17, .26, 1.92, cabWinM, 0, CAR_INTERIOR_H - .14, 0);
    for (const z of [-.77, .77]) this.box(.10, .035, .10, steel, 0, CAR_INTERIOR_H - .013, z);

    // Hundreds of cabin fittings become one static mesh per material. Doors
    // retain independent movement, with one frame and one glazing batch each.
    const statics = new THREE.Group();
    for (const child of [...this.scene.children]) if (child instanceof THREE.Mesh) statics.add(child);
    this.scene.add(mergeByMaterial(statics));
    for (const { mesh } of this.doorPanels) {
      const position = mesh.position.clone(); mesh.position.set(0, 0, 0);
      const merged = mergeByMaterial(mesh as THREE.Group);
      mesh.clear(); mesh.add(merged); mesh.position.copy(position);
    }
    this.disposables = this.disposables.filter(d => !(d instanceof THREE.BufferGeometry));
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
    if (!this.ledCv) this.ledCv = canvas2d(W, H).cv;
    const ctx = this.ledCv.getContext('2d');
    if (!ctx) return;   // canvas budget exhausted: keep the last sign rather than crash
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

  private resolveLayout(stationId: string): RideStationLayout {
    const spec = this.stations.get(stationId) ?? this.stations.values().next().value;
    if (!spec) throw new Error('A subway ride requires a station specification');
    return rideStationLayout(spec, this.route, this.dirSign);
  }

  private showStation(layout: RideStationLayout): void {
    if (this.stationVisualId === layout.stationId) return;
    this.scenery.setStation(layout); this.stationVisualId = layout.stationId;
  }

  private enterDwell(len = 12) {
    this.state = 'dwell'; this.t = 0; this.stateLen = len;
    this.stationLayout = this.resolveLayout(this.stops[this.idx]);
    this.showStation(this.stationLayout); this.scenery.update(this.scrollOffset, 0, true);
    const upcoming = this.stops[this.idx + this.dirSign];
    if (upcoming) this.scenery.prepareStation(this.resolveLayout(upcoming));
    this.setStrip();
    const name = this.names.get(this.stops[this.idx]) ?? '';
    this.setNextSign(this.atEnd ? `(${this.route}) LAST STOP: ${name}` : `(${this.route}) ${name} — DOORS ${this.platformSide === 1 ? 'RIGHT' : 'LEFT'}`);
  }

  get currentStationId() { return this.stops[this.idx]; }
  get canExit() { return this.state === 'dwell' && this.doorOpenAmt >= .95; }
  get platformSide(): 1 | -1 { return this.stationLayout.platformSide; }
  get interiorBounds() { return { halfLength: this.carHalf - .3, halfWidth: this.carWidth / 2 - .2, doorHalfWidth: .46 }; }
  isAtOpenDoor(x: number, z: number): boolean {
    return this.canExit && z * this.platformSide > this.carWidth / 2 - .48
      && this.doorBays.some(b => Math.abs(x - b) < .46);
  }
  clampPosition(x: number, z: number): { x: number; z: number } {
    const half = this.interiorBounds.halfLength;
    const px = Math.max(-half, Math.min(half, x));
    const atBay = this.doorBays.some(b => Math.abs(px - b) < this.interiorBounds.doorHalfWidth);
    // Keep the rider clear of the benches and seated passengers. Door bays
    // retain their full interior width even while the steel leaves are closed.
    const halfW = atBay ? this.interiorBounds.halfWidth : this.carWidth / 2 - .72;
    const reach = atBay && this.canExit ? this.carWidth / 2 + .1 : halfW;
    return { x: px, z: Math.max(this.platformSide === -1 ? -reach : -halfW, Math.min(this.platformSide === 1 ? reach : halfW, z)) };
  }

  /**
   * Snapshot for deep links: the segment ORIGIN stop (during 'moving', idx has
   * already advanced to the stop being approached) plus progress through the
   * current leg — enough to rebuild this exact between-stations moment.
   */
  get shareInfo(): { route: string; dirSign: 1 | -1; originId: string; prog: number } {
    const originIdx = this.state === 'moving' ? this.idx - this.dirSign : this.idx;
    return {
      route: this.route,
      dirSign: this.dirSign,
      originId: this.stops[Math.max(0, Math.min(this.stops.length - 1, originIdx))],
      prog: this.state === 'moving' ? Math.min(0.99, this.t / this.stateLen) : 0,
    };
  }

  /**
   * Drive the real state machine forward until we're `prog` of the way through
   * the leg out of the CURRENT (origin) station — used by deep links to restore
   * a mid-segment ride. No-op for prog ≤ 0; capped so an atEnd ride can't spin.
   */
  jumpTo(prog: number) {
    if (prog <= 0.02 || this.atEnd) return;
    let guard = 400;
    while (this.state !== 'moving' && guard-- > 0) this.update(0.5);
    while (this.state === 'moving' && this.t / this.stateLen < prog && guard-- > 0) this.update(0.25);
  }
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
    this.distanceThisFrame = 0;
    if (!Number.isFinite(dt) || dt <= 0) return;
    let remaining = dt;
    // Carry time over phase boundaries so low frame rates do not stretch trips.
    while (remaining > 1e-8) {
      const step = Math.min(remaining, Math.max(1e-8, this.stateLen - this.t));
      const previous = this.t;
      this.t += step; remaining -= step;
      if (this.state === 'dwell') this.doorOpenAmt = Math.min(1, this.doorOpenAmt + step * 1.6);
      else if (this.state === 'closing') this.doorOpenAmt = Math.max(0, this.doorOpenAmt - step * 1.1);
      else {
        const delta = rideTravelDistance(this.t / this.stateLen, this.legDistance) - rideTravelDistance(previous / this.stateLen, this.legDistance);
        this.scrollOffset += delta; this.distanceThisFrame += delta;
        const traveled = rideTravelDistance(this.t / this.stateLen, this.legDistance);
        const arriving = traveled >= this.legDistance / 2;
        if (arriving) this.showStation(this.stationLayout);
        const x = arriving ? this.legDistance - traveled : -traveled;
        const half = (arriving ? this.stationLayout.length : this.legOriginLength) / 2;
        this.scenery.update(this.scrollOffset, x, Math.abs(x) < half + this.carHalf + 22);
      }
      this.scenery.animate(step);
      this.passengers.update(step, {
stationId: this.currentStationId, platformSide: this.platformSide,
        doorOpenAmt: this.doorOpenAmt, state: this.state, boardingRemaining: this.stateLen - this.t
});
      if (this.t + 1e-8 < this.stateLen) continue;
      if (this.state === 'dwell') {
        if (this.atEnd) { this.t = 0; remaining = 0; break; }
        this.state = 'closing'; this.t = 0; this.stateLen = 1.4;
        this.setNextSign(`(${this.route}) STAND CLEAR OF THE CLOSING DOORS`);
      } else if (this.state === 'closing') {
        this.legOriginLength = this.stationLayout.length;
        this.idx += this.dirSign;
        const segment = this.dirSign === 1 ? this.idx - 1 : this.idx;
        this.state = 'moving'; this.t = 0; this.stateLen = Math.max(14, Math.min(38, (this.times[segment] ?? 90) / 2.2));
        this.doorOpenAmt = 0;
        this.stationLayout = this.resolveLayout(this.currentStationId);
        this.legDistance = rideLegDistance(this.stateLen, this.legOriginLength, this.stationLayout.length);
        this.setNextSign(`(${this.route}) NEXT: ${this.stationLayout.name} — DOORS ${this.platformSide === 1 ? 'RIGHT' : 'LEFT'}`);
      } else this.enterDwell(12);
    }
    this.updateDoorPanels();
  }

  private updateDoorPanels(): void {
    const slide = .67 * this.doorOpenAmt;
    for (const d of this.doorPanels) d.mesh.position.x = d.side === this.platformSide ? d.home + d.dir * slide : d.home;
  }

  dispose() {
    this.passengers.dispose();
    this.scenery.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        if (o instanceof THREE.InstancedMesh) o.dispose();
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
