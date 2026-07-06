import {
  type AudioFrame,
  CANONICAL_FORMAT,
  type CallEventMap,
  EventBus,
} from "call-sdk";
import { describe, expect, it } from "vitest";
import type { StageContext } from "../stage.js";
import { createEnergyVadStage } from "./energy-vad.js";

const FRAME_MS = CANONICAL_FORMAT.frameMs;
const SAMPLES = CANONICAL_FORMAT.samplesPerFrame;

function ctxFor(bus: EventBus<CallEventMap>): StageContext {
  return {
    sessionId: "test:vad",
    bus,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    signal: new AbortController().signal,
    mark: () => undefined,
    fail: () => undefined,
  };
}

function toneFrame(index: number, amplitude = 0.5): AudioFrame {
  const samples = new Int16Array(SAMPLES);
  for (let k = 0; k < SAMPLES; k++) {
    const n = index * SAMPLES + k;
    samples[k] = Math.round(
      amplitude * 32_767 * Math.sin((2 * Math.PI * 440 * n) / 16_000)
    );
  }
  return { samples, timestamp: index * FRAME_MS };
}

function silenceFrame(index: number): AudioFrame {
  return { samples: new Int16Array(SAMPLES), timestamp: index * FRAME_MS };
}

async function attach(
  bus: EventBus<CallEventMap>,
  config?: Parameters<typeof createEnergyVadStage>[0]
) {
  const stage = createEnergyVadStage(config);
  return await stage.attach(ctxFor(bus));
}

describe("EnergyVadStage", () => {
  it("fires speech-start after exactly activationFrames voiced frames", async () => {
    const bus = new EventBus<CallEventMap>("test:vad");
    const starts: CallEventMap["speech-start"][] = [];
    bus.subscribe("speech-start", (p) => starts.push(p));
    await attach(bus, { activationFrames: 3 });

    bus.publish("audio-frame", { frame: toneFrame(0) });
    bus.publish("audio-frame", { frame: toneFrame(1) });
    expect(starts).toHaveLength(0);
    bus.publish("audio-frame", { frame: toneFrame(2) });
    expect(starts).toHaveLength(1);
    // timestamp is that of the FIRST voiced frame in the run
    expect(starts[0].timestamp).toBe(0);
  });

  it("does not fire on sub-activation blips", async () => {
    const bus = new EventBus<CallEventMap>("test:vad");
    const starts: CallEventMap["speech-start"][] = [];
    bus.subscribe("speech-start", (p) => starts.push(p));
    await attach(bus, { activationFrames: 3 });

    // two voiced, then silence — run resets before reaching activation
    bus.publish("audio-frame", { frame: toneFrame(0) });
    bus.publish("audio-frame", { frame: toneFrame(1) });
    bus.publish("audio-frame", { frame: silenceFrame(2) });
    bus.publish("audio-frame", { frame: toneFrame(3) });
    bus.publish("audio-frame", { frame: toneFrame(4) });
    expect(starts).toHaveLength(0);
  });

  it("fires speech-end after exactly hangover frames of silence, with correct durationMs", async () => {
    const bus = new EventBus<CallEventMap>("test:vad");
    const ends: CallEventMap["speech-end"][] = [];
    bus.subscribe("speech-end", (p) => ends.push(p));
    // hangoverMs 100 => 5 frames
    await attach(bus, { activationFrames: 3, hangoverMs: 100 });

    // 10 voiced frames (0..9): speech-start at frame 2, timestamp 0
    for (let i = 0; i < 10; i++) {
      bus.publish("audio-frame", { frame: toneFrame(i) });
    }
    // silence frames start at index 10
    for (let i = 10; i < 14; i++) {
      bus.publish("audio-frame", { frame: silenceFrame(i) });
    }
    expect(ends).toHaveLength(0); // only 4 silence frames so far
    bus.publish("audio-frame", { frame: silenceFrame(14) }); // 5th silence frame
    expect(ends).toHaveLength(1);
    // speech-end timestamp = first unvoiced frame (index 10 => 200ms)
    expect(ends[0].timestamp).toBe(10 * FRAME_MS);
    // duration = firstUnvoiced - speechStart = 200 - 0
    expect(ends[0].durationMs).toBe(10 * FRAME_MS);
  });

  it("resets the hangover count when voice resumes mid-silence", async () => {
    const bus = new EventBus<CallEventMap>("test:vad");
    const ends: CallEventMap["speech-end"][] = [];
    bus.subscribe("speech-end", (p) => ends.push(p));
    await attach(bus, { activationFrames: 3, hangoverMs: 100 });

    for (let i = 0; i < 5; i++) {
      bus.publish("audio-frame", { frame: toneFrame(i) });
    }
    // 4 silence, then a voiced frame resets the hangover, then 4 more silence
    for (let i = 5; i < 9; i++) {
      bus.publish("audio-frame", { frame: silenceFrame(i) });
    }
    bus.publish("audio-frame", { frame: toneFrame(9) });
    for (let i = 10; i < 14; i++) {
      bus.publish("audio-frame", { frame: silenceFrame(i) });
    }
    expect(ends).toHaveLength(0); // never 5 consecutive silence frames
    bus.publish("audio-frame", { frame: silenceFrame(14) });
    expect(ends).toHaveLength(1);
  });

  it("never triggers on a quiet hum below the adaptive threshold", async () => {
    const bus = new EventBus<CallEventMap>("test:vad");
    const starts: CallEventMap["speech-start"][] = [];
    bus.subscribe("speech-start", (p) => starts.push(p));
    await attach(bus, { activationFrames: 3, thresholdDb: 12 });

    // A steady low-amplitude hum (~-57 dBFS): sits below the initial floor +
    // threshold (-53 dBFS), and stays below as the floor tracks up toward it.
    for (let i = 0; i < 200; i++) {
      bus.publish("audio-frame", { frame: toneFrame(i, 0.002) });
    }
    expect(starts).toHaveLength(0);
  });

  it("stops processing after dispose", async () => {
    const bus = new EventBus<CallEventMap>("test:vad");
    const starts: CallEventMap["speech-start"][] = [];
    bus.subscribe("speech-start", (p) => starts.push(p));
    const handle = await attach(bus, { activationFrames: 3 });
    await handle.dispose();

    for (let i = 0; i < 5; i++) {
      bus.publish("audio-frame", { frame: toneFrame(i) });
    }
    expect(starts).toHaveLength(0);
  });
});
