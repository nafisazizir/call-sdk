import { type AudioFrame, CANONICAL_FORMAT } from "call-sdk";

const SAMPLES_PER_FRAME = CANONICAL_FORMAT.samplesPerFrame;
const FRAME_MS = CANONICAL_FORMAT.frameMs;
const SAMPLE_RATE = CANONICAL_FORMAT.sampleRate;
const INT16_MAX = 32_767;

function frameCount(ms: number): number {
  return Math.max(0, Math.round(ms / FRAME_MS));
}

/**
 * Generates `ms` worth of pure-silence {@link AudioFrame}s (320 zero int16
 * samples per 20ms frame), timestamps advancing by 20ms from `startTimestamp`.
 */
export function silenceFrames(ms: number, startTimestamp = 0): AudioFrame[] {
  const frames: AudioFrame[] = [];
  const count = frameCount(ms);
  for (let i = 0; i < count; i++) {
    frames.push({
      samples: new Int16Array(SAMPLES_PER_FRAME),
      timestamp: startTimestamp + i * FRAME_MS,
    });
  }
  return frames;
}

/**
 * Generates `ms` worth of sine-tone {@link AudioFrame}s (16kHz, default 440Hz,
 * amplitude 0.5), in canonical 320-sample / 20ms frames.
 */
export function toneFrames(
  ms: number,
  opts: { hz?: number; amplitude?: number; startTimestamp?: number } = {}
): AudioFrame[] {
  const hz = opts.hz ?? 440;
  const amplitude = opts.amplitude ?? 0.5;
  const startTimestamp = opts.startTimestamp ?? 0;
  const frames: AudioFrame[] = [];
  const count = frameCount(ms);
  for (let i = 0; i < count; i++) {
    const samples = new Int16Array(SAMPLES_PER_FRAME);
    for (let k = 0; k < SAMPLES_PER_FRAME; k++) {
      const n = i * SAMPLES_PER_FRAME + k;
      const value = amplitude * Math.sin((2 * Math.PI * hz * n) / SAMPLE_RATE);
      samples[k] = Math.round(value * INT16_MAX);
    }
    frames.push({ samples, timestamp: startTimestamp + i * FRAME_MS });
  }
  return frames;
}

/**
 * Concatenates frame groups and re-timestamps the result sequentially in 20ms
 * increments, continuing from the first group's start timestamp (or 0).
 */
export function concatFrames(...groups: AudioFrame[][]): AudioFrame[] {
  const start = groups[0]?.[0]?.timestamp ?? 0;
  const out: AudioFrame[] = [];
  let i = 0;
  for (const group of groups) {
    for (const frame of group) {
      out.push({ samples: frame.samples, timestamp: start + i * FRAME_MS });
      i++;
    }
  }
  return out;
}
