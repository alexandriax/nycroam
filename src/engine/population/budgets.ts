import type { QualityLevel } from '../quality';

export interface PopulationBudget {
  radius: number;
  nearRadius: number;
  parkedVehicles: number;
  movingVehicles: number;
  pedestriansNear: number;
  pedestriansFar: number;
  cyclists: number;
  activities: number;
  lamps: number;
  signals: number;
  nearUpdateHz: number;
  farUpdateHz: number;
}

/** Spatial rebuild hysteresis for a population field hundreds of metres wide. */
export function populationRebuildDistance(speedMps: number): number {
  if (speedMps > 55) return 260;
  if (speedMps > 15) return 82;
  return 36;
}

/**
 * Hard population pool contracts. These are capacities, not targets: the
 * density field and available road geometry normally leave some slots empty.
 * Keeping them in a data-only module makes the performance ceiling testable.
 */
export const POPULATION_BUDGETS: Record<QualityLevel, PopulationBudget> = {
  low: {
    radius: 135,
    nearRadius: 46,
    parkedVehicles: 28,
    movingVehicles: 6,
    pedestriansNear: 20,
    pedestriansFar: 28,
    cyclists: 3,
    activities: 8,
    lamps: 22,
    signals: 10,
    nearUpdateHz: 12,
    farUpdateHz: 4,
  },
  medium: {
    radius: 185,
    nearRadius: 58,
    parkedVehicles: 62,
    movingVehicles: 12,
    pedestriansNear: 42,
    pedestriansFar: 52,
    cyclists: 5,
    activities: 18,
    lamps: 42,
    signals: 18,
    nearUpdateHz: 20,
    farUpdateHz: 5,
  },
  high: {
    radius: 235,
    nearRadius: 72,
    parkedVehicles: 104,
    movingVehicles: 20,
    pedestriansNear: 70,
    pedestriansFar: 82,
    cyclists: 8,
    activities: 34,
    lamps: 68,
    signals: 28,
    nearUpdateHz: 30,
    farUpdateHz: 6,
  },
  ultra: {
    radius: 275,
    nearRadius: 86,
    parkedVehicles: 148,
    movingVehicles: 28,
    pedestriansNear: 96,
    pedestriansFar: 112,
    cyclists: 12,
    activities: 50,
    lamps: 92,
    signals: 38,
    nearUpdateHz: 60,
    farUpdateHz: 8,
  },
};

/**
 * The renderer owns exactly these fourteen instanced color submissions. Shadow
 * maps add at most two submissions (vehicle body + near people) on High/Ultra.
 */
export const POPULATION_COLOR_DRAW_CALLS = 14;
export const POPULATION_MAX_SHADOW_DRAW_CALLS = 2;

/**
 * Exact triangle counts of the shared unit geometries created by StreetLife.
 * A test compares these constants with the resulting BufferGeometry indices so
 * changing a primitive cannot silently move the production budget.
 */
export const POPULATION_TRIANGLES = {
  vehicleBody: 12,
  vehicleCabin: 12,
  vehicleWheels: 128,
  lamp: 52,
  signal: 72,
  pedestrianNear: 48,
  pedestrianFar: 2,
  contactShadow: 12,
  cyclist: 168,
  activity: 100,
} as const;

export interface PopulationCeiling {
  colorDrawCalls: number;
  shadowDrawCalls: number;
  triangles: number;
  dynamicMatrixWritesPerNearTick: number;
  dynamicMatrixWritesPerFarTick: number;
  matrixWritesPerRebuild: number;
}

export function populationCeiling(level: QualityLevel): PopulationCeiling {
  const b = POPULATION_BUDGETS[level];
  const vehicles = b.parkedVehicles + b.movingVehicles;
  const contactShadows = vehicles + b.pedestriansNear + b.cyclists;
  return {
    colorDrawCalls: POPULATION_COLOR_DRAW_CALLS,
    shadowDrawCalls: level === 'ultra'
      ? POPULATION_MAX_SHADOW_DRAW_CALLS
      : level === 'high' ? 1 : 0,
    triangles:
      vehicles * (
        POPULATION_TRIANGLES.vehicleBody
        + POPULATION_TRIANGLES.vehicleCabin
        + POPULATION_TRIANGLES.vehicleWheels
      )
      + b.lamps * POPULATION_TRIANGLES.lamp
      + b.signals * POPULATION_TRIANGLES.signal
      + b.pedestriansNear * POPULATION_TRIANGLES.pedestrianNear
      + b.pedestriansFar * POPULATION_TRIANGLES.pedestrianFar
      + contactShadows * POPULATION_TRIANGLES.contactShadow
      + b.cyclists * POPULATION_TRIANGLES.cyclist
      + b.activities * POPULATION_TRIANGLES.activity,
    // body + cabin + 4 wheels, one near-person matrix, one cyclist and its
    // contact blob. Parked matrices remain untouched between rebuilds.
    dynamicMatrixWritesPerNearTick:
      b.movingVehicles * 7 + b.pedestriansNear * 2 + b.cyclists * 2,
    // One billboard transform for each far pedestrian.
    dynamicMatrixWritesPerFarTick: b.pedestriansFar,
    matrixWritesPerRebuild:
      vehicles * 7
      + b.lamps * 3
      + b.signals * 3
      + b.activities
      + b.pedestriansNear * 2
      + b.pedestriansFar
      + b.cyclists * 2,
  };
}
