import { describe, expect, it } from "vitest";
import { frameRms, rmsToDbfs } from "./rms";

describe("frameRms", () => {
  it("returns 0 for silence", () => {
    expect(frameRms(new Int16Array(320))).toBe(0);
  });

  it("returns 0 for an empty frame", () => {
    expect(frameRms(new Int16Array(0))).toBe(0);
  });

  it("returns ~1 for a full-scale square wave", () => {
    const samples = new Int16Array(320);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = i % 2 === 0 ? 32_767 : -32_768;
    }
    expect(frameRms(samples)).toBeCloseTo(1, 3);
  });

  it("returns ~0.354 for a half-scale sine wave", () => {
    const amplitude = 16_384; // half of full scale (32768)
    const samples = new Int16Array(320);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(
        amplitude * Math.sin((2 * Math.PI * 4 * i) / samples.length)
      );
    }
    // RMS of a sine wave = amplitude / sqrt(2); normalized: 0.5 / sqrt(2) ≈ 0.3536
    expect(frameRms(samples)).toBeCloseTo(0.354, 2);
  });
});

describe("rmsToDbfs", () => {
  it("returns -Infinity for 0 (silence)", () => {
    expect(rmsToDbfs(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("returns -Infinity for negative input", () => {
    expect(rmsToDbfs(-0.1)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("returns ~0 dBFS for rms = 1 (full scale)", () => {
    expect(rmsToDbfs(1)).toBeCloseTo(0, 5);
  });

  it("returns a negative value for rms < 1", () => {
    expect(rmsToDbfs(0.5)).toBeLessThan(0);
    expect(rmsToDbfs(0.5)).toBeCloseTo(-6.02, 1);
  });
});
