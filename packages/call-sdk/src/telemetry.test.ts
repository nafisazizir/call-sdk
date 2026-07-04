import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus";
import type { CallEventMap } from "./events";
import { SessionTelemetry } from "./telemetry";

describe("SessionTelemetry.mark", () => {
  it("pushes marks to the marks array in order", () => {
    const telemetry = new SessionTelemetry("s1");
    telemetry.mark("a");
    telemetry.mark("b");
    expect(telemetry.marks.map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("stamps sessionId and a numeric `at` on every mark", () => {
    const telemetry = new SessionTelemetry("session-9");
    const mark = telemetry.mark("something");
    expect(mark.sessionId).toBe("session-9");
    expect(typeof mark.at).toBe("number");
  });

  it("lifts stage/turnIndex out of detail onto the mark, keeping the rest under detail", () => {
    const telemetry = new SessionTelemetry("s1");
    const mark = telemetry.mark("thing", {
      stage: "vad",
      turnIndex: 2,
      foo: "bar",
    });
    expect(mark.stage).toBe("vad");
    expect(mark.turnIndex).toBe(2);
    expect(mark.detail).toEqual({ foo: "bar" });
  });

  it("omits detail entirely when there's nothing left after stage/turnIndex", () => {
    const telemetry = new SessionTelemetry("s1");
    const mark = telemetry.mark("thing", { stage: "vad" });
    expect(mark.detail).toBeUndefined();
  });

  it("forwards every mark to a provided sink", () => {
    const sink = vi.fn();
    const telemetry = new SessionTelemetry("s1", { sink });
    const mark = telemetry.mark("a");
    expect(sink).toHaveBeenCalledWith(mark);
  });

  it("defaults to debug-logging via the logger when no sink is provided", () => {
    const debug = vi.fn();
    const telemetry = new SessionTelemetry("s1", {
      logger: {
        debug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    telemetry.mark("a");
    expect(debug).toHaveBeenCalledTimes(1);
  });
});

describe("SessionTelemetry.observe", () => {
  function makeBus() {
    return new EventBus<CallEventMap>("s1");
  }

  it("marks first-audio-frame only once", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    const frame = { samples: new Int16Array(320), timestamp: 0 };
    bus.publish("audio-frame", { frame });
    bus.publish("audio-frame", { frame });
    bus.publish("audio-frame", { frame });
    expect(
      telemetry.marks.filter((m) => m.name === "first-audio-frame")
    ).toHaveLength(1);
  });

  it("marks every speech-start and speech-end", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    bus.publish("speech-start", { timestamp: 0 });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    bus.publish("speech-start", { timestamp: 200 });
    bus.publish("speech-end", { timestamp: 300, durationMs: 100 });
    expect(
      telemetry.marks.filter((m) => m.name === "speech-start")
    ).toHaveLength(2);
    expect(telemetry.marks.filter((m) => m.name === "speech-end")).toHaveLength(
      2
    );
  });

  it("marks only the first transcript-interim per turn", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);

    bus.publish("transcript-interim", { text: "a", timestamp: 0 });
    bus.publish("transcript-interim", { text: "ab", timestamp: 10 });
    bus.publish("transcript-interim", { text: "abc", timestamp: 20 });
    expect(
      telemetry.marks.filter((m) => m.name === "first-transcript-interim")
    ).toHaveLength(1);

    bus.publish("end-of-turn", { transcript: "abc", turnIndex: 0, finals: [] });

    // A new turn starts: the next interim should be marked again.
    bus.publish("transcript-interim", { text: "next", timestamp: 30 });
    bus.publish("transcript-interim", { text: "next turn", timestamp: 40 });
    expect(
      telemetry.marks.filter((m) => m.name === "first-transcript-interim")
    ).toHaveLength(2);
  });

  it("marks every transcript-final", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    bus.publish("transcript-final", { text: "a" });
    bus.publish("transcript-final", { text: "b" });
    expect(
      telemetry.marks.filter((m) => m.name === "transcript-final")
    ).toHaveLength(2);
  });

  it("marks end-of-turn with its turnIndex", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    bus.publish("end-of-turn", { transcript: "hi", turnIndex: 3, finals: [] });
    const mark = telemetry.marks.find((m) => m.name === "end-of-turn");
    expect(mark?.turnIndex).toBe(3);
  });

  it("marks tts-first-audio and first-outbound-write once per utteranceId", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    const frame = { samples: new Int16Array(320), timestamp: 0 };
    bus.publish("audio-out", { frame, utteranceId: "u1" });
    bus.publish("audio-out", { frame, utteranceId: "u1" });
    bus.publish("audio-out", { frame, utteranceId: "u2" });
    expect(
      telemetry.marks.filter((m) => m.name === "tts-first-audio")
    ).toHaveLength(2);
    expect(
      telemetry.marks.filter((m) => m.name === "first-outbound-write")
    ).toHaveLength(2);
  });

  it("marks every interruption", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    bus.publish("interruption", { utteranceId: "u1", timestamp: 0 });
    bus.publish("interruption", { utteranceId: "u2", timestamp: 10 });
    expect(
      telemetry.marks.filter((m) => m.name === "interruption")
    ).toHaveLength(2);
  });

  it("marks call-ended", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    bus.publish("call-ended", { sessionId: "s1", reason: "hangup" });
    expect(telemetry.marks.filter((m) => m.name === "call-ended")).toHaveLength(
      1
    );
  });

  it("supports say-called marks made directly (not via a bus event)", () => {
    const telemetry = new SessionTelemetry("s1");
    const mark = telemetry.mark("say-called", { turnIndex: 1 });
    expect(mark.name).toBe("say-called");
    expect(mark.turnIndex).toBe(1);
  });

  it("republishes every mark as a telemetry bus event once observing, without looping", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    const telemetryEvents: string[] = [];
    bus.subscribe("telemetry", ({ mark }) => telemetryEvents.push(mark.name));
    telemetry.observe(bus);

    bus.publish("speech-start", { timestamp: 0 });
    bus.publish("speech-end", { timestamp: 10, durationMs: 10 });

    expect(telemetryEvents).toEqual(["speech-start", "speech-end"]);
    // No infinite loop: exactly 2 telemetry events for 2 marked source events.
    expect(telemetryEvents).toHaveLength(2);
  });

  it("stops marking after the returned unsubscribe-all is called", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    const stopObserving = telemetry.observe(bus);
    stopObserving();
    bus.publish("speech-start", { timestamp: 0 });
    expect(telemetry.marks).toHaveLength(0);
  });
});

describe("SessionTelemetry turn summaries", () => {
  it("computes responseLatencyMs and voiceToVoiceMs when both are present", () => {
    const bus = new EventBus<CallEventMap>("s1");
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    const frame = { samples: new Int16Array(320), timestamp: 0 };

    bus.publish("speech-start", { timestamp: 0 });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 }); // speechEndAt ~ t0
    bus.publish("transcript-final", { text: "hello" });
    bus.publish("end-of-turn", {
      transcript: "hello",
      turnIndex: 0,
      finals: [],
    }); // endOfTurnAt ~ t1
    telemetry.mark("say-called", { turnIndex: 0 });
    bus.publish("audio-out", { frame, utteranceId: "u1" }); // firstOutboundWriteAt ~ t2

    const [turn] = telemetry.turns;
    expect(turn.turnIndex).toBe(0);
    expect(turn.speechEndAt).toBeDefined();
    expect(turn.transcriptFinalAt).toBeDefined();
    expect(turn.endOfTurnAt).toBeDefined();
    expect(turn.sayCalledAt).toBeDefined();
    expect(turn.firstOutboundWriteAt).toBeDefined();
    expect(turn.responseLatencyMs).toBeCloseTo(
      (turn.firstOutboundWriteAt as number) - (turn.endOfTurnAt as number),
      5
    );
    expect(turn.voiceToVoiceMs).toBeCloseTo(
      (turn.firstOutboundWriteAt as number) - (turn.speechEndAt as number),
      5
    );
    expect(turn.responseLatencyMs).toBeGreaterThanOrEqual(0);
    expect(turn.voiceToVoiceMs).toBeGreaterThanOrEqual(0);
  });

  it("leaves latency fields undefined when audio-out never arrives for a turn", () => {
    const bus = new EventBus<CallEventMap>("s1");
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    bus.publish("speech-end", { timestamp: 0, durationMs: 0 });
    bus.publish("end-of-turn", { transcript: "hi", turnIndex: 0, finals: [] });

    const [turn] = telemetry.turns;
    expect(turn.firstOutboundWriteAt).toBeUndefined();
    expect(turn.responseLatencyMs).toBeUndefined();
    expect(turn.voiceToVoiceMs).toBeUndefined();
  });

  it("attributes audio-out to the turn whose end-of-turn it followed, not an earlier one", () => {
    const bus = new EventBus<CallEventMap>("s1");
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    const frame = { samples: new Int16Array(320), timestamp: 0 };

    bus.publish("end-of-turn", { transcript: "t0", turnIndex: 0, finals: [] });
    bus.publish("audio-out", { frame, utteranceId: "u0" });
    bus.publish("end-of-turn", { transcript: "t1", turnIndex: 1, finals: [] });
    bus.publish("audio-out", { frame, utteranceId: "u1" });

    const turns = telemetry.turns;
    expect(turns).toHaveLength(2);
    const writeMarks = telemetry.marks.filter(
      (m) => m.name === "first-outbound-write"
    );
    expect(writeMarks).toHaveLength(2);
    // Attribution is by arrival order (see computeTurns' index-based
    // windowing), so turn 0 gets the first audio-out and turn 1 gets the
    // second — this holds even if both events land in the same
    // low-resolution timer tick, which plain timestamp comparison would not
    // reliably distinguish.
    expect(turns[0].firstOutboundWriteAt).toBe(writeMarks[0].at);
    expect(turns[1].firstOutboundWriteAt).toBe(writeMarks[1].at);
  });

  it("returns an empty turns array when there are no end-of-turn marks", () => {
    const telemetry = new SessionTelemetry("s1");
    telemetry.mark("something-unrelated");
    expect(telemetry.turns).toEqual([]);
  });
});

describe("SessionTelemetry.flush", () => {
  it("is idempotent and caches the computed turns", () => {
    const bus = new EventBus<CallEventMap>("s1");
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    bus.publish("end-of-turn", { transcript: "hi", turnIndex: 0, finals: [] });

    telemetry.flush();
    const first = telemetry.turns;
    telemetry.flush();
    const second = telemetry.turns;
    expect(second).toBe(first);
  });
});
