import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../bus.js";
import type { CallEventMap } from "../events.js";
import type { StageContext, StageHandle } from "../types.js";
import { createSilenceTurnStage } from "./silence-turn.js";

function ctxFor(bus: EventBus<CallEventMap>): StageContext {
  return {
    sessionId: "test:turn",
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

describe("SilenceTurnStage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function setup(config?: Parameters<typeof createSilenceTurnStage>[0]) {
    const bus = new EventBus<CallEventMap>("test:turn");
    const turns: CallEventMap["end-of-turn"][] = [];
    bus.subscribe("end-of-turn", (p) => turns.push(p));
    const stage = createSilenceTurnStage(config);
    const handle = stage.attach(ctxFor(bus)) as StageHandle;
    return { bus, turns, handle };
  }

  it("emits end-of-turn after silenceMs with accumulated finals", () => {
    const { bus, turns } = setup({ silenceMs: 200 });
    bus.publish("speech-start", { timestamp: 0 });
    bus.publish("transcript-final", { text: "hello" });
    bus.publish("transcript-final", { text: "there" });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    expect(turns).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      transcript: "hello there",
      turnIndex: 1,
      finals: [{ text: "hello" }, { text: "there" }],
    });
  });

  it("cancels the armed timer when the caller resumes speaking", () => {
    const { bus, turns } = setup({ silenceMs: 200 });
    bus.publish("transcript-final", { text: "hello" });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    vi.advanceTimersByTime(100);
    bus.publish("speech-start", { timestamp: 150 });
    vi.advanceTimersByTime(500);
    expect(turns).toHaveLength(0);
  });

  it("emits immediately when a late final arrives within the grace window", () => {
    const { bus, turns } = setup({ silenceMs: 200, finalGraceMs: 500 });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    // no finals yet: turn timer fires, arms grace
    vi.advanceTimersByTime(200);
    expect(turns).toHaveLength(0);
    // final lands mid-grace
    vi.advanceTimersByTime(100);
    bus.publish("transcript-final", { text: "late" });
    expect(turns).toHaveLength(1);
    expect(turns[0].transcript).toBe("late");
  });

  it("emits nothing when silence has no finals even after grace expires", () => {
    const { bus, turns } = setup({ silenceMs: 200, finalGraceMs: 500 });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    vi.advanceTimersByTime(200 + 500 + 10);
    expect(turns).toHaveLength(0);
  });

  it("short-circuits the wait on stt-endpoint when finals are present", () => {
    const { bus, turns } = setup({ silenceMs: 800 });
    bus.publish("transcript-final", { text: "done" });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    bus.publish("stt-endpoint", { timestamp: 120 });
    expect(turns).toHaveLength(1);
    expect(turns[0].transcript).toBe("done");
  });

  it("ignores stt-endpoint while speech is still ongoing", () => {
    const { bus, turns } = setup({ silenceMs: 200 });
    bus.publish("speech-start", { timestamp: 0 });
    bus.publish("transcript-final", { text: "mid" });
    bus.publish("stt-endpoint", { timestamp: 20 });
    expect(turns).toHaveLength(0);
  });

  it("increments turnIndex across multiple turns", () => {
    const { bus, turns } = setup({ silenceMs: 200 });
    for (let t = 0; t < 3; t++) {
      bus.publish("speech-start", { timestamp: t * 1000 });
      bus.publish("transcript-final", { text: `turn ${t}` });
      bus.publish("speech-end", { timestamp: t * 1000 + 100, durationMs: 100 });
      vi.advanceTimersByTime(200);
    }
    expect(turns.map((turn) => turn.turnIndex)).toEqual([1, 2, 3]);
  });

  it("clears all timers on dispose (no leaked handles)", () => {
    const { bus, turns, handle } = setup({ silenceMs: 200, finalGraceMs: 500 });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    void handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(turns).toHaveLength(0);
  });
});
