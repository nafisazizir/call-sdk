import { describe, expect, it } from "vitest";
import {
  bytesToInt16,
  CANONICAL_FORMAT,
  FrameChunker,
  frameDurationMs,
  int16ToBytes,
} from "./format";

describe("frameDurationMs", () => {
  it("computes duration from sample count at the canonical sample rate", () => {
    const frame = {
      samples: new Int16Array(CANONICAL_FORMAT.samplesPerFrame),
      timestamp: 0,
    };
    expect(frameDurationMs(frame)).toBeCloseTo(20, 5);
  });

  it("scales with a non-canonical sample count", () => {
    const frame = { samples: new Int16Array(160), timestamp: 0 };
    expect(frameDurationMs(frame)).toBeCloseTo(10, 5);
  });
});

describe("bytesToInt16 / int16ToBytes", () => {
  it("round-trips arbitrary samples", () => {
    const samples = Int16Array.from([
      0, 1, -1, 32_767, -32_768, 12_345, -12_345,
    ]);
    const bytes = int16ToBytes(samples);
    expect(bytes.length).toBe(samples.length * 2);
    const roundTripped = bytesToInt16(bytes);
    expect(Array.from(roundTripped)).toEqual(Array.from(samples));
  });

  it("encodes little-endian regardless of host endianness", () => {
    // 0x0102 as an int16 = 258. Little-endian bytes: [0x02, 0x01].
    const bytes = int16ToBytes(Int16Array.from([0x01_02]));
    expect(Array.from(bytes)).toEqual([0x02, 0x01]);
  });

  it("decodes little-endian bytes back to the same value regardless of host endianness", () => {
    const bytes = Uint8Array.from([0x02, 0x01]);
    const samples = bytesToInt16(bytes);
    expect(samples[0]).toBe(0x01_02);
  });

  it("decodes a negative value correctly", () => {
    // -1 as int16 little-endian is [0xFF, 0xFF].
    const samples = bytesToInt16(Uint8Array.from([0xff, 0xff]));
    expect(samples[0]).toBe(-1);
  });
});

describe("FrameChunker", () => {
  it("emits exact samplesPerFrame frames from a single push aligned to frame size", () => {
    const chunker = new FrameChunker();
    const input = new Int16Array(CANONICAL_FORMAT.samplesPerFrame * 2).fill(7);
    const frames = chunker.push(input);
    expect(frames).toHaveLength(2);
    expect(frames[0].samples).toHaveLength(CANONICAL_FORMAT.samplesPerFrame);
    expect(frames[1].samples).toHaveLength(CANONICAL_FORMAT.samplesPerFrame);
  });

  it("carries a remainder across odd-sized pushes and advances timestamps by 20ms", () => {
    const chunker = new FrameChunker();
    // 400 samples = 1 full frame (320) + 80 remainder.
    const oddPush = new Int16Array(400).fill(1);
    const frames1 = chunker.push(oddPush);
    expect(frames1).toHaveLength(1);
    expect(frames1[0].timestamp).toBe(0);

    // 80 carried remainder + 400 new = 1 more full frame (320), leaving a
    // new 160-sample remainder.
    const frames2 = chunker.push(oddPush);
    expect(frames2).toHaveLength(1);
    expect(frames2[0].timestamp).toBe(20);

    const flushed = chunker.flush();
    expect(flushed?.samples).toHaveLength(CANONICAL_FORMAT.samplesPerFrame);
    expect(flushed?.timestamp).toBe(40);
  });

  it("flush pads the final partial frame with silence", () => {
    const chunker = new FrameChunker();
    chunker.push(new Int16Array(100).fill(9));
    const flushed = chunker.flush();
    expect(flushed).not.toBeNull();
    expect(flushed?.samples).toHaveLength(CANONICAL_FORMAT.samplesPerFrame);
    // First 100 samples are the real data...
    expect(Array.from(flushed?.samples.slice(0, 100) ?? [])).toEqual(
      new Array(100).fill(9)
    );
    // ...the rest is silence.
    expect(Array.from(flushed?.samples.slice(100) ?? [])).toEqual(
      new Array(CANONICAL_FORMAT.samplesPerFrame - 100).fill(0)
    );
  });

  it("flush returns null when there is no remainder", () => {
    const chunker = new FrameChunker();
    chunker.push(new Int16Array(CANONICAL_FORMAT.samplesPerFrame));
    expect(chunker.flush()).toBeNull();
  });

  it("accepts raw little-endian bytes as input", () => {
    const chunker = new FrameChunker();
    const samples = new Int16Array(CANONICAL_FORMAT.samplesPerFrame).fill(42);
    const frames = chunker.push(int16ToBytes(samples));
    expect(frames).toHaveLength(1);
    expect(frames[0].samples[0]).toBe(42);
  });

  it("advances timestamps by exactly frameMs across many frames", () => {
    const chunker = new FrameChunker();
    const frames = chunker.push(
      new Int16Array(CANONICAL_FORMAT.samplesPerFrame * 5)
    );
    expect(frames.map((f) => f.timestamp)).toEqual([0, 20, 40, 60, 80]);
  });

  it("supports a custom samplesPerFrame / sampleRate / startTimestamp", () => {
    const chunker = new FrameChunker({
      samplesPerFrame: 160,
      sampleRate: 8000,
      startTimestamp: 1000,
    });
    const frames = chunker.push(new Int16Array(320));
    expect(frames).toHaveLength(2);
    expect(frames[0].timestamp).toBe(1000);
    expect(frames[1].timestamp).toBe(1020);
  });
});
