import * as THREE from 'three';
import { mergeByMaterial } from './EntranceManager';
import { FRAME_BLUE, RUBBER, STEEL, tube } from './bikes';

/**
 * The bike you see from the saddle: bars, stem, fork, front wheel, top tube
 * and cranks, drawn in world space in front of the rider while `riding`.
 *
 * ---- why the geometry isn't to scale with the docked bike ----
 * On a real bike the bars sit ~0.65 m ahead of your eyes and ~0.55 m below
 * them. The camera's vertical FOV is 70 deg, so at that distance the frame
 * bottoms out 0.65 * tan(35 deg) = 0.46 m below eye level and the bars fall
 * *under* the screen — you'd see nothing at level pitch and everything only
 * when looking down. Human peripheral vision doesn't have that problem; a
 * 70 deg frustum does. So this is a viewmodel, not a physical bike: the
 * assembly is pushed forward to BAR_Z, where the same bars clear the frame
 * edge and sit in the bottom quarter of the view. Proportions and materials
 * still come from bikes.ts, so it reads as the bike you undocked.
 *
 * Everything is local to the rider: origin on the ground under the saddle,
 * +z forward, yaw applied by the caller.
 */

const RIDE_EYE = 1.53; // seated eye height (walking is 1.7 — mounting drops you)

// Frame stations, bike-local. Tuned against the 70 deg frustum, not a tape
// measure: bars land ~78% down the frame and ~45% of its width, which is
// where a real bike sits in your vision. Cross-checked in-browser — moving
// BAR_Z out to arm's length shrinks the bars to a distant sliver.
const SADDLE = new THREE.Vector3(0, 0.96, -0.02); // just under the camera
const SEAT_TOP = new THREE.Vector3(0, 0.92, 0.0);
const BB = new THREE.Vector3(0, 0.30, 0.28); // bottom bracket / crank axis
const HEAD_TOP = new THREE.Vector3(0, 1.10, 0.72); // steering axis
const HEAD_LOW = new THREE.Vector3(0, 0.68, 0.80);
const HUB = new THREE.Vector3(0, 0.34, 0.95); // front hub, relative to the frame
const BAR_Y = 1.17; // high and swept back, the way a share bike's bars are
const BAR_Z = 0.66;
const BAR_HALF = 0.34; // 68 cm bars
const WHEEL_R = 0.31;
const CRANK_R = 0.17;

/** Front wheel: tire, spokes and hub, centered on the origin, spinning on x. */
function buildWheel(unit: THREE.CylinderGeometry): THREE.Group {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(WHEEL_R, 0.036, 6, 18), RUBBER);
  tire.rotateY(Math.PI / 2);
  g.add(tire);
  // spokes are what make the spin read at all — a bare torus looks static
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    const p = new THREE.Vector3(0, Math.sin(a) * WHEEL_R, Math.cos(a) * WHEEL_R);
    g.add(tube(unit, STEEL, p, p.clone().negate(), 0.006));
  }
  const hub = new THREE.Mesh(unit, STEEL);
  hub.scale.set(0.032, 0.10, 0.032);
  hub.rotateZ(Math.PI / 2);
  g.add(hub);
  return mergeByMaterial(g);
}

/**
 * Bars, grips, stem and fork, built around the HEAD_TOP steering axis so the
 * group can be rotated in place. The wheel hangs off it as a live child.
 */
function buildSteer(unit: THREE.CylinderGeometry, wheel: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  // The grips sit closest to the camera and occupy far more pixels than any
  // docked-bike tube. Give only these viewmodel pieces a rounder cross-section;
  // the world bikes retain their cheaper shared six-sided tube.
  const gripUnit = new THREE.CylinderGeometry(1, 1, 1, 12);
  const rel = (v: THREE.Vector3) => v.clone().sub(HEAD_TOP);

  const barL = new THREE.Vector3(-BAR_HALF, BAR_Y, BAR_Z);
  const barR = new THREE.Vector3(BAR_HALF, BAR_Y, BAR_Z);
  const barMid = new THREE.Vector3(0, BAR_Y, BAR_Z);
  g.add(tube(unit, STEEL, rel(barL), rel(barR), 0.019)); // handlebar
  g.add(tube(unit, STEEL, rel(HEAD_TOP), rel(barMid), 0.022)); // stem
  g.add(tube(unit, STEEL, rel(HEAD_TOP), rel(HEAD_LOW), 0.03)); // head tube
  g.add(tube(unit, STEEL, rel(HEAD_LOW), rel(HUB), 0.018)); // fork

  // grips: the closest thing on screen, so they get their own segments
  for (const s of [-1, 1]) {
    const outer = new THREE.Vector3(s * BAR_HALF, BAR_Y, BAR_Z);
    const inner = new THREE.Vector3(s * (BAR_HALF - 0.11), BAR_Y, BAR_Z);
    g.add(tube(gripUnit, RUBBER, rel(inner), rel(outer), 0.026));
  }

  const merged = mergeByMaterial(g);
  merged.add(wheel);
  wheel.position.copy(rel(HUB));
  const pivot = new THREE.Group();
  pivot.position.copy(HEAD_TOP);
  pivot.add(merged);
  return pivot;
}

/** Cranks + pedals on the bottom-bracket axis — visible when you look down. */
function buildCranks(unit: THREE.CylinderGeometry): THREE.Group {
  const g = new THREE.Group();
  for (const s of [-1, 1]) {
    // arms oppose each other, as they do on a real spindle
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.022, CRANK_R, 0.03), STEEL);
    arm.position.set(s * 0.075, (s * CRANK_R) / 2, 0);
    g.add(arm);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.018, 0.055), RUBBER);
    pedal.position.set(s * 0.10, s * CRANK_R, 0);
    g.add(pedal);
  }
  const spindle = new THREE.Mesh(unit, STEEL);
  spindle.scale.set(0.024, 0.17, 0.024);
  spindle.rotateZ(Math.PI / 2);
  g.add(spindle);
  const merged = mergeByMaterial(g);
  merged.position.copy(BB);
  return merged;
}

/** Everything that doesn't move: main triangle, saddle, chain stay. */
function buildFrame(unit: THREE.CylinderGeometry): THREE.Group {
  const g = new THREE.Group();
  const rearHub = new THREE.Vector3(0, 0.34, -0.55);
  g.add(tube(unit, FRAME_BLUE, BB, SEAT_TOP, 0.028)); // seat tube
  g.add(tube(unit, FRAME_BLUE, BB, HEAD_LOW, 0.032)); // down tube
  g.add(tube(unit, FRAME_BLUE, SEAT_TOP, HEAD_TOP, 0.026)); // top tube
  g.add(tube(unit, FRAME_BLUE, BB, rearHub, 0.02)); // chain stay
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.26), RUBBER);
  saddle.position.copy(SADDLE);
  g.add(saddle);
  return mergeByMaterial(g);
}

export class BikeView {
  readonly root = new THREE.Group(); // yaw only
  private tilt = new THREE.Group(); // lean + bob, so yaw stays clean
  private steer: THREE.Group;
  private wheel = new THREE.Group();
  private cranks: THREE.Group;
  private steerAngle = 0;
  private lean = 0;
  private pedalPhase = 0;
  private prevYaw: number | null = null;
  private scene: THREE.Scene | null = null;

  static readonly eyeHeight = RIDE_EYE;

  constructor() {
    const unit = new THREE.CylinderGeometry(1, 1, 1, 6);
    this.wheel = buildWheel(unit);
    this.steer = buildSteer(unit, this.wheel);
    this.cranks = buildCranks(unit);
    this.tilt.add(buildFrame(unit), this.steer, this.cranks);
    this.root.add(this.tilt);
    unit.dispose();
    // always 1 m in front of the camera, so the cull test can only ever pass
    this.root.traverse((o) => { o.frustumCulled = false; });
  }

  attach(scene: THREE.Scene) {
    if (this.scene) return;
    this.scene = scene;
    scene.add(this.root);
    this.prevYaw = null; // no phantom steer kick from yaw drift while off the bike
  }

  detach() {
    this.scene?.remove(this.root);
    this.scene = null;
  }

  get attached() { return this.scene !== null; }

  /**
   * @param speed metres/second actually travelled — not the input, so pedals
   *              and wheel stall when a wall stops you.
   */
  update(dt: number, speed: number, yaw: number, x: number, y: number, z: number, strafe: number) {
    this.root.position.set(x, y, z);
    // controls.basis() puts the camera's forward at (-sin yaw, -cos yaw), which
    // is where rotating local +z by yaw + PI lands. Plain `yaw` builds the bike
    // behind your head.
    this.root.rotation.y = yaw + Math.PI;

    // steer toward how fast the rider is turning, nudged by the strafe keys.
    // yaw grows counter-clockwise, so a right turn (yaw falling) has to swing
    // the bars right = negative rotation.y.
    const yawRate = this.prevYaw === null ? 0 : shortestAngle(yaw - this.prevYaw) / Math.max(dt, 1e-4);
    this.prevYaw = yaw;
    const target = clamp(yawRate * 0.22 - strafe * 0.3, -0.5, 0.5);
    this.steerAngle += (target - this.steerAngle) * Math.min(1, dt * 9);
    this.steer.rotation.y = this.steerAngle;

    // Lean INTO the turn, proportional to how hard you're actually going.
    // +z is forward and +y is up, which puts the rider's left at +x — so a
    // positive roll lifts the left side, and a right turn (steer < 0) needs it.
    const leanTarget = clamp(-this.steerAngle * 0.42 * Math.min(1, speed / 8), -0.16, 0.16);
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * 5);
    this.tilt.rotation.z = this.lean;

    // pedals and wheel are driven off ground speed, so a track stand looks like one.
    // Rolling forward is +rotation.x: it carries the tyre's top point toward +z.
    this.pedalPhase += dt * speed * 0.85;
    this.cranks.rotation.x = this.pedalPhase;
    this.wheel.rotation.x += (speed / WHEEL_R) * dt;

    // out-of-saddle bob, at pedal cadence and fading in with speed
    const bob = Math.min(1, speed / 10);
    this.tilt.position.y = Math.sin(this.pedalPhase * 2) * 0.012 * bob;
    this.tilt.rotation.z += Math.sin(this.pedalPhase) * 0.012 * bob;
  }

  dispose() {
    this.detach();
    this.root.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    // materials stay: bikes.ts shares them with every docked bike
  }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** Wrap to (-PI, PI] so a yaw that crosses the seam doesn't spike the steer. */
function shortestAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
