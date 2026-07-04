/**
 * Root-mean-square energy helpers for PCM16 frames — the basis for a simple
 * energy-gate VAD and for level metering.
 */

const FULL_SCALE = 32_768;

/**
 * RMS energy of a PCM16 frame, normalized to `0..1` against full scale
 * (`32768`). Returns `0` for an empty frame.
 */
export function frameRms(samples: Int16Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms / FULL_SCALE;
}

/**
 * Converts a normalized `0..1` RMS value (see {@link frameRms}) to dBFS.
 * Returns `-Infinity` for silence (`rms <= 0`).
 */
export function rmsToDbfs(rms: number): number {
  if (rms <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return 20 * Math.log10(rms);
}
