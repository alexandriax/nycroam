/**
 * A subtle first-person walking bob for on-foot movement — the footfall
 * counterpart to BikeView's out-of-saddle jostle. It produces three small
 * camera offsets the caller adds at eye time:
 *
 *   bobY  vertical dip/rise (metres) — add to eye.y
 *   swayX lateral sway (metres) — add along the camera's right vector
 *   roll  head tilt (radians) — passed to controls.applyToCamera
 *
 * Nothing here touches the player position: the offsets are cosmetic, so the
 * sim (collision, saves, minimap) stays on the real feet position.
 *
 * Gait model: the stride phase advances at a cadence derived from ground
 * speed. The head is lowest at each footfall (heel strike / double support)
 * and highest at mid-stance, so vertical bob runs at 2x footfall frequency;
 * the body sways to the stance side once per stride, so sway + roll run at
 * footfall frequency. `update` returns true on the frame a foot lands, which
 * the caller uses to trigger a footstep sound.
 */

const AMP_Y = 0.032; // vertical bob, metres (peak-to-centre)
const AMP_X = 0.026; // lateral sway, metres
const AMP_ROLL = 0.007; // head roll, radians (~0.4 deg)
const CADENCE = 0.42; // steps per second per m/s of ground speed
const MAX_STEPS = 6; // cap cadence so a sprint doesn't buzz

export class WalkBob {
  bobY = 0;
  swayX = 0;
  roll = 0;

  private phase = 0; // stride phase, radians; one footfall every PI
  private amp = 0; // eases 0..1 with movement so a standstill is dead still
  private footIndex = 0; // integer part of phase/PI, for footfall edges

  /**
   * @param dt      seconds since last frame
   * @param speed   ground speed actually travelled (m/s), not the input
   * @param active  true only while genuinely on foot (not riding/flying)
   * @returns       true on the frame a foot lands
   */
  update(dt: number, speed: number, active: boolean): boolean {
    const moving = active && speed > 0.25;
    const target = moving ? 1 : 0;
    this.amp += (target - this.amp) * Math.min(1, dt * 7);

    let footfall = false;
    if (moving) {
      const steps = Math.min(MAX_STEPS, speed * CADENCE);
      const prevFoot = this.footIndex;
      this.phase += steps * Math.PI * dt;
      if (this.phase > 1e6) { this.phase %= Math.PI * 2; this.footIndex = 0; }
      this.footIndex = Math.floor(this.phase / Math.PI);
      // only ring a footstep once the bob has faded up, so easing in from a
      // standstill doesn't fire a stray step
      if (this.footIndex !== prevFoot && this.amp > 0.35) footfall = true;
    }

    const a = this.amp;
    // vertical: lowest at footfall (phase = 0, PI), highest mid-stance
    this.bobY = -AMP_Y * Math.cos(2 * this.phase) * a;
    // lateral + roll: one cycle per stride, zero at footfalls
    this.swayX = AMP_X * Math.sin(this.phase) * a;
    this.roll = -AMP_ROLL * Math.sin(this.phase) * a;
    return footfall;
  }

  /** Drop the bob to neutral without a fade (mode change, teleport). */
  reset() {
    this.phase = 0;
    this.footIndex = 0;
    this.amp = 0;
    this.bobY = this.swayX = this.roll = 0;
  }
}
