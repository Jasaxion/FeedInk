/** Deterministic work counters for tests/benchmarks, not wall-clock performance claims. */
export const engineWork = {
  boundsPoints: 0, pathPoints: 0, encodedStrokes: 0, resolutions: 0,
  committedPaints: 0, activePaints: 0, nativeBatches: 0, nativeFrames: 0, segmentSearches: 0, segmentPositions: 0,
};
export function resetEngineWork(): void {
  for (const key of Object.keys(engineWork) as Array<keyof typeof engineWork>) engineWork[key] = 0;
}
