import { dataUrl } from '../dataver';
import { lonLatToXZ } from '../geo';
import { LANDMARKS_REG } from '../landmarks/registry';
import {
  composePopulationDensity,
  smoothDensityFalloff,
  type PopulationDensitySample,
} from './densityKernel';

export type DensityAnchorKind =
  | 'station'
  | 'bus'
  | 'landmark'
  | 'park'
  | 'bike'
  | 'retail';

export interface DensityAnchor {
  x: number;
  z: number;
  kind: DensityAnchorKind;
  weight: number;
}

interface SubwayContextJson {
  stations?: Array<{ pos: [number, number]; routes?: string[] }>;
  entrances?: Array<{ pos: [number, number] }>;
}

interface GoalsContextJson {
  parks?: Array<{ rings: number[][][] }>;
}

interface BikesContextJson {
  docks?: Array<{ c?: number; p: [number, number] }>;
}

interface BusesContextJson {
  stops?: Record<string, { p: [number, number]; r?: string[] }>;
}

const CELL_SIZE = 160;

function cellKey(x: number, z: number): string {
  return `${Math.floor(x / CELL_SIZE)}:${Math.floor(z / CELL_SIZE)}`;
}

/**
 * Small spatial density field grounded in data already shipped with the world.
 * Queries inspect at most a 5x5 cell neighborhood and allocate nothing.
 */
export class PopulationDensityField {
  private readonly cells = new Map<string, DensityAnchor[]>();
  private readonly anchors: DensityAnchor[] = [];
  private loaded = false;

  constructor(seedLandmarks = true) {
    if (seedLandmarks) {
      for (const landmark of LANDMARKS_REG) {
        if (landmark.aliasOf || landmark.id === 'liberty-statue') continue;
        const [x, z] = lonLatToXZ(landmark.lon, landmark.lat);
        this.add({ x, z, kind: 'landmark', weight: landmark.alwaysOn ? 0.8 : 0.58 });
      }
    }
  }

  get ready(): boolean {
    return this.loaded;
  }

  get anchorCount(): number {
    return this.anchors.length;
  }

  add(anchor: DensityAnchor): void {
    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.z)) return;
    this.anchors.push(anchor);
    const key = cellKey(anchor.x, anchor.z);
    const cell = this.cells.get(key);
    if (cell) cell.push(anchor);
    else this.cells.set(key, [anchor]);
  }

  addMany(anchors: DensityAnchor[]): void {
    for (const anchor of anchors) this.add(anchor);
  }

  async load(): Promise<boolean> {
    if (this.loaded) return true;
    const requests = await Promise.allSettled([
      fetch(dataUrl('/subway/subway.json')).then(async (response) =>
        response.ok ? await response.json() as SubwayContextJson : null),
      fetch(dataUrl('/geo/goalsdata.json')).then(async (response) =>
        response.ok ? await response.json() as GoalsContextJson : null),
      fetch(dataUrl('/geo/bikes.json')).then(async (response) =>
        response.ok ? await response.json() as BikesContextJson : null),
      fetch(dataUrl('/geo/buses.json')).then(async (response) =>
        response.ok ? await response.json() as BusesContextJson : null),
    ]);

    const subway = requests[0].status === 'fulfilled' ? requests[0].value : null;
    // Entrances localize foot traffic more accurately than station centroids.
    for (const entrance of subway?.entrances ?? []) {
      this.add({ x: entrance.pos[0], z: entrance.pos[1], kind: 'station', weight: 0.92 });
    }
    for (const station of subway?.stations ?? []) {
      this.add({
        x: station.pos[0],
        z: station.pos[1],
        kind: 'station',
        weight: Math.min(1, 0.55 + (station.routes?.length ?? 1) * 0.08),
      });
    }

    const goals = requests[1].status === 'fulfilled' ? requests[1].value : null;
    for (const park of goals?.parks ?? []) {
      for (const ring of park.rings) {
        if (!ring.length) continue;
        let x = 0;
        let z = 0;
        for (const point of ring) {
          x += point[0];
          z += point[1];
        }
        this.add({
          x: x / ring.length,
          z: z / ring.length,
          kind: 'park',
          weight: 0.66,
        });
        // Large parks need edge activity rather than one remote centroid.
        const stride = Math.max(1, Math.floor(ring.length / 12));
        for (let i = 0; i < ring.length; i += stride) {
          this.add({ x: ring[i][0], z: ring[i][1], kind: 'park', weight: 0.42 });
        }
      }
    }

    const bikes = requests[2].status === 'fulfilled' ? requests[2].value : null;
    for (const dock of bikes?.docks ?? []) {
      this.add({
        x: dock.p[0],
        z: dock.p[1],
        kind: 'bike',
        weight: Math.min(0.58, 0.2 + (dock.c ?? 15) / 150),
      });
    }
    const buses = requests[3].status === 'fulfilled' ? requests[3].value : null;
    for (const stop of Object.values(buses?.stops ?? {})) {
      this.add({
        x: stop.p[0],
        z: stop.p[1],
        kind: 'bus',
        weight: Math.min(0.38, 0.17 + (stop.r?.length ?? 1) * 0.035),
      });
    }
    this.loaded = true;
    return requests.some((request) => request.status === 'fulfilled' && request.value !== null);
  }

  sample(x: number, z: number): PopulationDensitySample {
    let station = 0;
    let landmark = 0;
    let park = 0;
    let bike = 0;
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const cell = this.cells.get(`${cx + dx}:${cz + dz}`);
        if (!cell) continue;
        for (const anchor of cell) {
          const distance = Math.hypot(anchor.x - x, anchor.z - z);
          if (anchor.kind === 'station') {
            station = Math.max(station, anchor.weight * smoothDensityFalloff(distance, 150));
          } else if (anchor.kind === 'bus') {
            station = Math.max(station, anchor.weight * smoothDensityFalloff(distance, 85));
          } else if (anchor.kind === 'landmark') {
            landmark = Math.max(landmark, anchor.weight * smoothDensityFalloff(distance, 190));
          } else if (anchor.kind === 'park') {
            park = Math.max(park, anchor.weight * smoothDensityFalloff(distance, 135));
          } else if (anchor.kind === 'bike') {
            bike = Math.max(bike, anchor.weight * smoothDensityFalloff(distance, 100));
          } else {
            landmark = Math.max(landmark, anchor.weight * smoothDensityFalloff(distance, 120));
          }
        }
      }
    }
    return composePopulationDensity(station, landmark, park, bike);
  }

  /** Exact functional-kit clearance without weakening the surrounding crowd. */
  nearestDistance(
    x: number,
    z: number,
    kinds: readonly DensityAnchorKind[],
    maxDistance: number,
  ): number {
    let best = maxDistance;
    const cellRadius = Math.max(1, Math.ceil(maxDistance / CELL_SIZE));
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    for (let dz = -cellRadius; dz <= cellRadius; dz++) {
      for (let dx = -cellRadius; dx <= cellRadius; dx++) {
        const cell = this.cells.get(`${cx + dx}:${cz + dz}`);
        if (!cell) continue;
        for (const anchor of cell) {
          if (!kinds.includes(anchor.kind)) continue;
          const distance = Math.hypot(anchor.x - x, anchor.z - z);
          if (distance < best) best = distance;
        }
      }
    }
    return best;
  }
}
