/**
 * Cheap, allocation-per-call 2x sample-rate converters for PCM16 mono audio.
 *
 * These exist to bridge 8kHz telephony audio (Twilio's μ-law is 8kHz) and
 * the SDK's canonical 16kHz format. They are intentionally simple — linear
 * interpolation on the way up, averaging (a crude low-pass) on the way down
 * — rather than a proper polyphase resampler, which is a fine trade-off at
 * a fixed, known 2x ratio on 20ms frames.
 */

/**
 * Upsamples 8kHz PCM16 to 16kHz via linear interpolation. Output length is
 * always exactly `2 * samples.length`.
 *
 * For each input sample `i`, emits `samples[i]` unchanged followed by the
 * midpoint between `samples[i]` and `samples[i + 1]`. Edge handling: the
 * very last input sample has no successor to interpolate toward, so its
 * "midpoint" output is a repeat of itself (flat extrapolation) rather than
 * interpolating toward silence, which would incorrectly ramp the signal
 * down at every chunk boundary.
 */
export function upsampleX2(samples: Int16Array): Int16Array {
  const n = samples.length;
  const out = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const current = samples[i];
    const next = i + 1 < n ? samples[i + 1] : current;
    out[2 * i] = current;
    out[2 * i + 1] = Math.round((current + next) / 2);
  }
  return out;
}

/**
 * Downsamples 16kHz PCM16 to 8kHz by averaging adjacent sample pairs (a
 * cheap low-pass filter) and decimating by 2. Output length is
 * `floor(samples.length / 2)`, plus one extra trailing sample — passed
 * through unaveraged — if `samples.length` is odd.
 */
export function downsampleX2(samples: Int16Array): Int16Array {
  const pairCount = Math.floor(samples.length / 2);
  const hasOddTail = samples.length % 2 === 1;
  const out = new Int16Array(pairCount + (hasOddTail ? 1 : 0));
  for (let i = 0; i < pairCount; i++) {
    out[i] = Math.round((samples[2 * i] + samples[2 * i + 1]) / 2);
  }
  if (hasOddTail) {
    // `samples` is non-empty whenever hasOddTail is true, so `.at(-1)` is
    // always defined; the `?? 0` only satisfies the type checker.
    out[pairCount] = samples.at(-1) ?? 0;
  }
  return out;
}
