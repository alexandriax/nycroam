export interface PassengerPoint { x: number; z: number }
export interface PassengerRect { minX: number; maxX: number; minZ: number; maxZ: number }
export interface PassengerPlatform extends PassengerRect { y: number; holes: PassengerRect[]; boarding?: boolean }
const BODY_RADIUS = .31;
function contains(r: PassengerRect, p: PassengerPoint): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
}
function intersectsSegment(r: PassengerRect, a: PassengerPoint, b: PassengerPoint): boolean {
  let lo = 0, hi = 1;
  for (const [origin, delta, min, max] of [[a.x, b.x - a.x, r.minX, r.maxX], [a.z, b.z - a.z, r.minZ, r.maxZ]]) {
    if (Math.abs(delta) < 1e-9) { if (origin < min || origin > max) return false; continue; }
    const t0 = (min - origin) / delta, t1 = (max - origin) / delta;
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
    if (lo > hi) return false;
  }
  return true;
}

/** Platform-only visibility paths. Stair/furniture footprints are inflated by
 * body radius, so a valid center path keeps shoulders clear of their edges. */
export class PassengerNavigation {
  readonly bounds: PassengerRect;
  readonly holes: PassengerRect[];
  private readonly corners: PassengerPoint[];
  private readonly cornerIds = new Map<PassengerPoint, number>();
  private readonly visibility = new Map<number, boolean>();
  constructor(platform: PassengerPlatform) {
    this.bounds = { minX: platform.minX + .55, maxX: platform.maxX - .55, minZ: platform.minZ + .55, maxZ: platform.maxZ - .55 };
    this.holes = platform.holes.filter(h => h.minX < platform.maxX && h.maxX > platform.minX && h.minZ < platform.maxZ && h.maxZ > platform.minZ).map(h => ({ minX: h.minX - BODY_RADIUS, maxX: h.maxX + BODY_RADIUS, minZ: h.minZ - BODY_RADIUS, maxZ: h.maxZ + BODY_RADIUS }));
    this.corners = this.holes.flatMap(h => [
      { x: h.minX - .03, z: h.minZ - .03 }, { x: h.maxX + .03, z: h.minZ - .03 },
      { x: h.minX - .03, z: h.maxZ + .03 }, { x: h.maxX + .03, z: h.maxZ + .03 },
    ]).filter(p => this.valid(p));
    this.corners.forEach((point, index) => this.cornerIds.set(point, index));
  }
  valid(p: PassengerPoint): boolean { return contains(this.bounds, p) && !this.holes.some(h => contains(h, p)); }
  clear(a: PassengerPoint, b: PassengerPoint): boolean {
    return this.valid(a) && this.valid(b) && !this.holes.some(h => intersectsSegment(h, a, b));
  }
  path(a: PassengerPoint, b: PassengerPoint): PassengerPoint[] | null {
    if (!this.valid(a) || !this.valid(b)) return null;
    if (this.clear(a, b)) return [{ ...b }];
    // Commuters take short local trips. Never rebuild a visibility graph for
    // the entire 180m platform just to step around one column; an excessive
    // detour can wait for another destination/doorway on the next decision.
    const near = this.corners.filter(p => p.x >= Math.min(a.x, b.x) - 5 && p.x <= Math.max(a.x, b.x) + 5
      && p.z >= Math.min(a.z, b.z) - 5 && p.z <= Math.max(a.z, b.z) + 5).slice(0, 48);
    const loX = Math.min(a.x, b.x) - 5, hiX = Math.max(a.x, b.x) + 5;
    const loZ = Math.min(a.z, b.z) - 5, hiZ = Math.max(a.z, b.z) + 5;
    const obstacles = this.holes.filter(h => h.minX < hiX && h.maxX > loX && h.minZ < hiZ && h.maxZ > loZ);
    const visible = (from: PassengerPoint, to: PassengerPoint): boolean => {
      const i = this.cornerIds.get(from), j = this.cornerIds.get(to);
      const key = i === undefined || j === undefined ? -1 : Math.min(i, j) * this.corners.length + Math.max(i, j);
      const cached = key < 0 ? undefined : this.visibility.get(key);
      if (cached !== undefined) return cached;
      const result = !obstacles.some(h => intersectsSegment(h, from, to));
      if (key >= 0) this.visibility.set(key, result);
      return result;
    };
    const nodes = [a, b, ...near], distances = nodes.map(() => Infinity), previous = nodes.map(() => -1), visited = new Set<number>();
    distances[0] = 0;
    for (let step = 0; step < nodes.length; step++) {
      let best = -1;
      for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && (best < 0 || distances[i] < distances[best])) best = i;
      if (best < 0 || !Number.isFinite(distances[best])) return null;
      if (best === 1) break;
      visited.add(best);
      for (let i = 1; i < nodes.length; i++) {
        if (visited.has(i) || !visible(nodes[best], nodes[i])) continue;
        const cost = distances[best] + Math.hypot(nodes[best].x - nodes[i].x, nodes[best].z - nodes[i].z);
        if (cost < distances[i]) { distances[i] = cost; previous[i] = best; }
      }
    }
    if (previous[1] < 0) return null;
    const result: PassengerPoint[] = [];
    for (let i = 1; i > 0; i = previous[i]) result.push({ ...nodes[i] });
    return result.reverse();
  }
}

export function pathLength(from: PassengerPoint, path: readonly PassengerPoint[]): number {
  let total = 0, prev = from;
  for (const p of path) { total += Math.hypot(p.x - prev.x, p.z - prev.z); prev = p; }
  return total;
}
/** Nobody enters a doorway unless there is time to clear it before closure. */
export function canExchangePassengers(doorsReady: boolean, boardingRemaining: number, distance: number, speed = 1.25): boolean {
  return doorsReady && boardingRemaining > distance / speed + .45;
}
