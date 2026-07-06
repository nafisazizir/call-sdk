import { type CallEventMap, EventBus, SessionTelemetry } from "call-sdk";
import { describe, expect, it } from "vitest";
import { computeTurnLatency, observeSemanticMarks } from "./telemetry";

function makeBus() {
  return new EventBus<CallEventMap>("s1");
}

const FRAME = { samples: new Int16Array(320), timestamp: 0 };

describe("observeSemanticMarks", () => {
  it("marks every speech-start and speech-end", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    observeSemanticMarks(bus, telemetry);
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
    observeSemanticMarks(bus, telemetry);

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
    observeSemanticMarks(bus, telemetry);
    bus.publish("transcript-final", { text: "a" });
    bus.publish("transcript-final", { text: "b" });
    expect(
      telemetry.marks.filter((m) => m.name === "transcript-final")
    ).toHaveLength(2);
  });

  it("marks end-of-turn with its turnIndex", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    observeSemanticMarks(bus, telemetry);
    bus.publish("end-of-turn", { transcript: "hi", turnIndex: 3, finals: [] });
    const mark = telemetry.marks.find((m) => m.name === "end-of-turn");
    expect(mark?.turnIndex).toBe(3);
  });

  it("marks tts-first-audio and first-outbound-write once per utteranceId", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    observeSemanticMarks(bus, telemetry);
    bus.publish("audio-out", { frame: FRAME, utteranceId: "u1" });
    bus.publish("audio-out", { frame: FRAME, utteranceId: "u1" });
    bus.publish("audio-out", { frame: FRAME, utteranceId: "u2" });
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
    observeSemanticMarks(bus, telemetry);
    bus.publish("interruption", { utteranceId: "u1", timestamp: 0 });
    bus.publish("interruption", { utteranceId: "u2", timestamp: 10 });
    expect(
      telemetry.marks.filter((m) => m.name === "interruption")
    ).toHaveLength(2);
  });

  it("stops marking after the returned unsubscribe-all is called", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    const stop = observeSemanticMarks(bus, telemetry);
    stop();
    bus.publish("speech-start", { timestamp: 0 });
    expect(telemetry.marks).toHaveLength(0);
  });
});

describe("computeTurnLatency", () => {
  it("computes responseLatencyMs and voiceToVoiceMs when both are present", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    observeSemanticMarks(bus, telemetry);

    bus.publish("speech-start", { timestamp: 0 });
    bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    bus.publish("transcript-final", { text: "hello" });
    bus.publish("end-of-turn", {
      transcript: "hello",
      turnIndex: 0,
      finals: [],
    });
    telemetry.mark("say-called", { turnIndex: 0 });
    bus.publish("audio-out", { frame: FRAME, utteranceId: "u1" });

    const [turn] = computeTurnLatency(telemetry.marks);
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
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    observeSemanticMarks(bus, telemetry);
    bus.publish("speech-end", { timestamp: 0, durationMs: 0 });
    bus.publish("end-of-turn", { transcript: "hi", turnIndex: 0, finals: [] });

    const [turn] = computeTurnLatency(telemetry.marks);
    expect(turn.firstOutboundWriteAt).toBeUndefined();
    expect(turn.responseLatencyMs).toBeUndefined();
    expect(turn.voiceToVoiceMs).toBeUndefined();
  });

  it("attributes audio-out to the turn whose end-of-turn it followed, not an earlier one", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    observeSemanticMarks(bus, telemetry);

    bus.publish("end-of-turn", { transcript: "t0", turnIndex: 0, finals: [] });
    bus.publish("audio-out", { frame: FRAME, utteranceId: "u0" });
    bus.publish("end-of-turn", { transcript: "t1", turnIndex: 1, finals: [] });
    bus.publish("audio-out", { frame: FRAME, utteranceId: "u1" });

    const turns = computeTurnLatency(telemetry.marks);
    expect(turns).toHaveLength(2);
    const writeMarks = telemetry.marks.filter(
      (m) => m.name === "first-outbound-write"
    );
    expect(writeMarks).toHaveLength(2);
    // Attribution is by arrival order (index-based windowing), so turn 0
    // gets the first audio-out and turn 1 the second — this holds even if
    // both events land in the same low-resolution timer tick, which plain
    // timestamp comparison would not reliably distinguish.
    expect(turns[0].firstOutboundWriteAt).toBe(writeMarks[0].at);
    expect(turns[1].firstOutboundWriteAt).toBe(writeMarks[1].at);
  });

  it("returns an empty array when there are no end-of-turn marks", () => {
    const telemetry = new SessionTelemetry("s1");
    telemetry.mark("something-unrelated");
    expect(computeTurnLatency(telemetry.marks)).toEqual([]);
  });
});
