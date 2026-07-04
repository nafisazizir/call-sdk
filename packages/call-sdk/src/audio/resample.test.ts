import { describe, expect, it } from "vitest";
import { downsampleX2, upsampleX2 } from "./resample";

function sine(n: number, cyclesOverN: number, amplitude = 20_000): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(
      amplitude * Math.sin((2 * Math.PI * cyclesOverN * i) / n)
    );
  }
  return out;
}

function countZeroCrossings(samples: Int16Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) {
      crossings++;
    }
  }
  return crossings;
}

describe("upsampleX2", () => {
  it("doubles the sample count", () => {
    const input = new Int16Array(160);
    expect(upsampleX2(input).length).toBe(320);
  });

  it("preserves original samples at even output indices", () => {
    const input = Int16Array.from([100, 200, 300, 400]);
    const out = upsampleX2(input);
    expect(out[0]).toBe(100);
    expect(out[2]).toBe(200);
    expect(out[4]).toBe(300);
    expect(out[6]).toBe(400);
  });

  it("interpolates the midpoint between adjacent samples", () => {
    const input = Int16Array.from([0, 100]);
    const out = upsampleX2(input);
    expect(out[1]).toBe(50);
  });

  it("repeats the last sample at the trailing edge instead of ramping toward silence", () => {
    const input = Int16Array.from([100, 200]);
    const out = upsampleX2(input);
    // Last input sample (200) has no successor: its interpolated output
    // should equal itself, not drop toward 0.
    expect(out.at(-1)).toBe(200);
  });
});

describe("downsampleX2", () => {
  it("halves the sample count for even-length input", () => {
    const input = new Int16Array(320);
    expect(downsampleX2(input).length).toBe(160);
  });

  it("averages adjacent pairs", () => {
    const input = Int16Array.from([0, 100, 300, 500]);
    const out = downsampleX2(input);
    expect(Array.from(out)).toEqual([50, 400]);
  });

  it("passes through a trailing odd sample unaveraged", () => {
    const input = Int16Array.from([0, 100, 300]);
    const out = downsampleX2(input);
    expect(out.length).toBe(2);
    expect(out[1]).toBe(300);
  });
});

describe("upsample then downsample", () => {
  it("approximates identity within a tolerance appropriate for a linear-interpolation + averaging resampler", () => {
    // Neither stage is a brickwall filter — upsample interpolates, downsample
    // averages — so up-then-down is a smoothing operation, not exact
    // identity. For a low-frequency tone (slow sample-to-sample change) the
    // smoothing error stays small and bounded relative to the signal's
    // amplitude; that's what we assert here, generously.
    const amplitude = 8000;
    const input = sine(320, 2, amplitude);
    const roundTripped = downsampleX2(upsampleX2(input));
    expect(roundTripped.length).toBe(input.length);

    let maxAbsError = 0;
    for (let i = 0; i < input.length; i++) {
      maxAbsError = Math.max(maxAbsError, Math.abs(roundTripped[i] - input[i]));
    }
    expect(maxAbsError).toBeLessThanOrEqual(amplitude * 0.1);
  });

  it("is an exact identity for constant (DC) input", () => {
    const input = new Int16Array(320).fill(1234);
    const roundTripped = downsampleX2(upsampleX2(input));
    expect(Array.from(roundTripped)).toEqual(Array.from(input));
  });
});

describe("sine wave frequency preservation (coarse zero-crossing check)", () => {
  it("upsampleX2 preserves the number of zero crossings", () => {
    const input = sine(320, 4);
    const upsampled = upsampleX2(input);
    expect(countZeroCrossings(upsampled)).toBe(countZeroCrossings(input));
  });

  it("downsampleX2 preserves the number of zero crossings for a low-frequency tone", () => {
    const input = sine(320, 4);
    const downsampled = downsampleX2(input);
    expect(countZeroCrossings(downsampled)).toBe(countZeroCrossings(input));
  });
});
