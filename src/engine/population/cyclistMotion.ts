export interface CyclistPose {
  bob: number;
  lean: number;
}

export function cyclistBikeLaneOffset(variation: number): number {
  return 0.28 + Math.min(1, Math.max(0, variation)) * 0.14;
}

export function cyclistLookaheadDistance(
  routeDistance: number,
  direction: number,
  routeLength: number,
  lookahead = 1.8,
): number {
  if (!Number.isFinite(routeLength) || routeLength <= 0) return 0;
  // sampleLaneRoute intentionally wraps at routeLength. Keep a tiny inset so
  // forward lookahead at a turnaround samples the end tangent, not the start.
  const endpointInset = Math.min(0.001, routeLength * 0.001);
  const maximum = Math.max(0, routeLength - endpointInset);
  const travelDirection = direction < 0 ? -1 : 1;
  return Math.min(
    maximum,
    Math.max(0, routeDistance + travelDirection * Math.max(0, lookahead)),
  );
}

export function cyclistCadencePose(
  nowSeconds: number,
  speed: number,
  phase: number,
  directionChange: number,
): CyclistPose {
  const cadence = nowSeconds * speed * 2.4 + phase;
  return {
    bob: (Math.abs(Math.sin(cadence)) - 0.5) * 0.012,
    lean: Math.min(
      0.11,
      Math.max(-0.11, directionChange * 0.16 + Math.sin(cadence * 0.5) * 0.012),
    ),
  };
}
