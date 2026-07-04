import { CANONICAL_FORMAT } from "call-sdk";
import { describe, expect, it } from "vitest";
import { concatFrames, silenceFrames, toneFrames } from "./audio";

describe("audio helpers", () => {
  it("builds canonical silence frames with advancing timestamps", () => {
    const frames = silenceFrames(60);
    expect(frames).toHaveLength(3);
    for (let i = 0; i < frames.length; i++) {
      expect(frames[i]).toBeCanonicalFrame();
      expect(frames[i].timestamp).toBe(i * CANONICAL_FORMAT.frameMs);
      expect(frames[i].samples.every((s) => s === 0)).toBe(true);
    }
  });

  it("builds canonical tone frames with non-zero energy", () => {
    const frames = toneFrames(40, { hz: 440, amplitude: 0.5 });
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame).toBeCanonicalFrame();
    }
    expect(frames[0].samples.some((s) => s !== 0)).toBe(true);
  });

  it("concatenates and re-timestamps sequentially", () => {
    const merged = concatFrames(toneFrames(40), silenceFrames(40));
    expect(merged).toHaveLength(4);
    merged.forEach((frame, i) => {
      expect(frame.timestamp).toBe(i * CANONICAL_FORMAT.frameMs);
    });
  });
});
