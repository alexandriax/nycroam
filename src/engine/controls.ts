import * as THREE from 'three';

export interface MoveInput {
  forward: number; // -1..1
  strafe: number; // -1..1
  up: number; // -1..1 (fly)
  sprint: boolean;
}

/**
 * First-person controls: pointer lock on desktop (drag fallback), virtual
 * joysticks feed in via setTouchMove/setTouchLook from the HUD layer.
 */
export class PlayerControls {
  yaw = Math.PI; // face north (-z)
  pitch = 0;
  fly = false;
  run = false; // sticky sprint, toggled by the touch Run button (no Shift key on mobile)
  private keys = new Set<string>();
  private el: HTMLElement;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private touchMove = { x: 0, y: 0 }; // joystick vector -1..1
  private touchLook = { dx: 0, dy: 0 }; // accumulated pixels since last frame
  private pointerLockAvailable = true;
  onAction: (() => void) | null = null; // E key / action button
  onToggleFly: (() => void) | null = null;
  onInfo: (() => void) | null = null; // i key / mobile info button — open building-info modal

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', () => (this.dragging = false));
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.el) this.dragging = false;
    });
    document.addEventListener('pointerlockerror', () => (this.pointerLockAvailable = false));
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (this.pointerLockAvailable && !document.pointerLockElement) {
      this.el.requestPointerLock?.();
    }
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onMouseMove = (e: MouseEvent) => {
    let dx = 0, dy = 0;
    if (document.pointerLockElement === this.el) {
      dx = e.movementX; dy = e.movementY;
    } else if (this.dragging) {
      dx = e.clientX - this.lastX; dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
    } else return;
    this.applyLook(dx, dy);
  };

  private applyLook(dx: number, dy: number) {
    this.yaw -= dx * 0.0024;
    this.pitch -= dy * 0.0022;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (k === 'f') this.onToggleFly?.();
    if (k === 'e' || k === 'enter') this.onAction?.();
    if (k === 'i') this.onInfo?.();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  setTouchMove(x: number, y: number) { this.touchMove.x = x; this.touchMove.y = y; }
  setTouchVertical(v: number) { this.touchVertical = v; }
  private touchVertical = 0;
  addTouchLook(dx: number, dy: number) { this.touchLook.dx += dx; this.touchLook.dy += dy; }

  consumeInput(): MoveInput {
    if (this.touchLook.dx || this.touchLook.dy) {
      this.applyLook(this.touchLook.dx * 2.4, this.touchLook.dy * 2.4);
      this.touchLook.dx = 0; this.touchLook.dy = 0;
    }
    const k = this.keys;
    let forward = (k.has('w') || k.has('arrowup') ? 1 : 0) + (k.has('s') || k.has('arrowdown') ? -1 : 0);
    let strafe = (k.has('d') || k.has('arrowright') ? 1 : 0) + (k.has('a') || k.has('arrowleft') ? -1 : 0);
    const up = (k.has(' ') ? 1 : 0) + (k.has('c') || k.has('control') ? -1 : 0) + this.touchVertical;
    forward += -this.touchMove.y;
    strafe += this.touchMove.x;
    const len = Math.hypot(forward, strafe);
    if (len > 1) { forward /= len; strafe /= len; }
    return { forward, strafe, up, sprint: k.has('shift') || this.run };
  }

  /** Direction vectors on the ground plane. */
  basis(): { fwd: THREE.Vector3; right: THREE.Vector3 } {
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    return { fwd, right };
  }

  applyToCamera(cam: THREE.PerspectiveCamera, eye: THREE.Vector3, roll = 0) {
    cam.position.copy(eye);
    cam.rotation.set(0, 0, 0);
    cam.rotateY(this.yaw);
    cam.rotateX(this.pitch);
    if (roll) cam.rotateZ(roll); // subtle walk sway; 0 everywhere else
  }

  dispose() {
    this.el.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }
}
