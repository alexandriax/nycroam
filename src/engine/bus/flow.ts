/**
 * Bus-flow policy kept separate from rendering so schedule density and
 * right-of-way invariants can be regression-tested without constructing Three
 * scenes or loading GTFS geometry.
 */

export const BUS_HEADWAY_RANGE = Object.freeze({
  // SBS remains the most frequent service, but even its shortest headway leaves
  // enough time for one bus to clear a stop/intersection before the next arrives.
  sbs: Object.freeze({ min: 96, max: 150 }),
  local: Object.freeze({ min: 126, max: 216 }),
});

export const BUS_MOVING_SPEED = 0.15;
export const BUS_DEADLOCK_ESCAPE_AFTER = 4;
export const BUS_DEADLOCK_RETIRE_AFTER = 45;
export const BUS_MAX_SLOTS_PER_DIRECTION = 10;
export const BUS_TERMINAL_LAYOVER = 30;

const BUS_MESH_CAP = Object.freeze({
  low: 12,
  medium: 16,
  high: 24,
  ultra: 32,
});

function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Stable per-direction service headway, in world seconds. */
export function busHeadwaySeconds(
  routeIdx: number,
  dirIdx: number,
  sbs: boolean,
): number {
  const range = sbs ? BUS_HEADWAY_RANGE.sbs : BUS_HEADWAY_RANGE.local;
  return range.min
    + hash01(routeIdx * 17 + dirIdx * 7) * (range.max - range.min);
}

export interface BusScheduleDensity {
  headway: number;
  slots: number;
  cycle: number;
}

/**
 * Bound long routes as well as short-headway routes. A long crosstown/borough
 * run cannot silently allocate dozens of simultaneous timetable actors.
 */
export function busScheduleDensity(
  runSeconds: number,
  routeIdx: number,
  dirIdx: number,
  sbs: boolean,
): BusScheduleDensity {
  const baseHeadway = busHeadwaySeconds(routeIdx, dirIdx, sbs);
  let headway = Math.max(
    baseHeadway,
    (runSeconds + BUS_TERMINAL_LAYOVER)
      / BUS_MAX_SLOTS_PER_DIRECTION,
  );
  const slots = Math.max(
    1,
    Math.ceil(runSeconds / headway - 1e-9),
  );
  if (slots * headway < runSeconds + BUS_TERMINAL_LAYOVER) {
    headway = (runSeconds + BUS_TERMINAL_LAYOVER) / slots;
  }
  return {
    headway,
    slots,
    cycle: slots * headway,
  };
}

export function busMeshCap(
  level: 'low' | 'medium' | 'high' | 'ultra',
): number {
  return BUS_MESH_CAP[level];
}

export interface BusConflictState {
  keyNum: number;
  renderSpeed: number;
}

export interface BusRecoveryState {
  keyNum: number;
  ridden: boolean;
}

/**
 * Total, acyclic right-of-way order for a crossing conflict.
 *
 * A bus already clearing the junction continues; otherwise the stable numeric
 * key breaks the tie. Pairwise "closer to this conflict" comparisons can form a
 * three-way yield cycle, while this total order always leaves one winner.
 */
export function busYieldsAtConflict(
  a: BusConflictState,
  b: BusConflictState,
): boolean {
  const aMoving = a.renderSpeed > BUS_MOVING_SPEED;
  const bMoving = b.renderSpeed > BUS_MOVING_SPEED;
  if (aMoving !== bMoving) return bMoving;
  return a.keyNum > b.keyNum;
}

/**
 * Stable ownership of a bus-to-bus recovery maneuver.
 *
 * If both actors independently try to pass, their lateral sweeps can become a
 * mutual wait cycle even though the normal leader graph is acyclic. This total
 * order elects exactly one recoverer for every pair while keeping the ridden
 * bus responsive. Timetable state is deliberately excluded: if "finishing"
 * changed ownership mid-pass, the old and new winner could remember each other
 * and recreate the cycle this token exists to prevent.
 */
export function busRecoveryWins(
  a: BusRecoveryState,
  b: BusRecoveryState,
): boolean {
  if (a.ridden !== b.ridden) return a.ridden;
  return a.keyNum < b.keyNum;
}

/** A normal traffic hold becomes eligible for a bounded steering escape. */
export function busDeadlockEscapeReady(blockedSeconds: number): boolean {
  return blockedSeconds >= BUS_DEADLOCK_ESCAPE_AFTER;
}

/**
 * Remove cycles from the functional "bus i follows leader[i]" graph.
 *
 * Curved, coincident GTFS shapes can make three local tangent frames disagree
 * about who is ahead. The lowest-key bus in each cycle becomes the leader that
 * clears first; every other edge remains intact as a queue behind it.
 */
export function breakBusLeaderCycles(
  leaders: Int32Array,
  keyNums: ArrayLike<number>,
): void {
  const state = new Uint8Array(leaders.length);
  const stack: number[] = [];

  const visit = (index: number): void => {
    if (index < 0 || state[index] === 2) return;
    if (state[index] === 1) {
      const cycleStart = stack.lastIndexOf(index);
      if (cycleStart < 0) return;
      let winner = stack[cycleStart];
      for (let i = cycleStart + 1; i < stack.length; i++) {
        if (keyNums[stack[i]] < keyNums[winner]) winner = stack[i];
      }
      leaders[winner] = -1;
      return;
    }
    state[index] = 1;
    stack.push(index);
    visit(leaders[index]);
    stack.pop();
    state[index] = 2;
  };

  for (let index = 0; index < leaders.length; index++) visit(index);
}
