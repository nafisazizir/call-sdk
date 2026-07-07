import {
  createMockAdapter,
  type MockAdapter,
  type MockCallDriver,
  toneFrames,
} from "@call-adapter/tests";
import {
  Call,
  CallConfigError,
  type CallEventMap,
  type CallSession,
} from "call-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  attachVoice,
  createEnergyVadStage,
  createMockSttStage,
  createMockTtsStage,
  createSilenceTurnStage,
  type MockSttScriptEntry,
  type Stage,
  type StageContext,
  type VoiceOptions,
  type VoiceSession,
} from "./index";
import { type RecordedEvents, recordEvents } from "./testing/matchers";

interface BuildOptions {
  onEndOfTurn?: VoiceOptions["onEndOfTurn"];
  onError?: (
    event: CallEventMap["error"],
    session: CallSession
  ) => void | Promise<void>;
  stages?: Stage[];
  sttScript?: MockSttScriptEntry[];
}

/**
 * Builds a `Call` wired to a mock adapter and attaches the voice pipeline
 * synchronously inside `onCallStarted`, capturing the resulting
 * `VoiceSession` for the test to reach once the call is live.
 */
function buildCall(opts: BuildOptions = {}): {
  adapter: MockAdapter;
  call: Call;
  getVoice: () => VoiceSession | undefined;
} {
  const adapter = createMockAdapter("mock");
  let voice: VoiceSession | undefined;
  const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
  call.onCallStarted((session) => {
    voice = attachVoice(session, {
      logger: "silent",
      stages: opts.stages ?? [
        createEnergyVadStage({ hangoverMs: 100 }),
        createSilenceTurnStage({ silenceMs: 200 }),
        createMockSttStage({
          script: opts.sttScript ?? [{ final: "hello there" }],
        }),
        createMockTtsStage(),
      ],
      ...(opts.onEndOfTurn ? { onEndOfTurn: opts.onEndOfTurn } : {}),
    });
  });
  if (opts.onError) {
    call.onError(opts.onError);
  }
  return { adapter, call, getVoice: () => voice };
}

async function liveSession(
  adapter: MockAdapter,
  call: Call,
  getVoice: () => VoiceSession | undefined
): Promise<{
  driver: MockCallDriver;
  recorded: RecordedEvents;
  session: CallSession;
  voice: VoiceSession;
}> {
  const driver = adapter.connectCall();
  const session = call.getSession(driver.sessionId);
  if (!session) {
    throw new Error("no session");
  }
  await vi.waitFor(() => {
    if (!getVoice()) {
      throw new Error("voice not attached yet");
    }
  });
  const voice = getVoice();
  if (!voice) {
    throw new Error("voice not attached");
  }
  // Nothing has happened on the pipeline bus yet at this point (no audio,
  // no say()) — safe to subscribe here rather than at attach time.
  const recorded = recordEvents(voice.bus);
  return { driver, session, voice, recorded };
}

describe("teardown & exactly-once semantics", () => {
  it("treats post-end operations as silent no-ops", async () => {
    const { adapter, call, getVoice } = buildCall();
    const { driver, session, voice } = await liveSession(
      adapter,
      call,
      getVoice
    );
    driver.hangup();
    await session.ended;

    const result = await voice.say("too late");
    expect(result.interrupted).toBe(true);
    expect(() => driver.sendAudio(toneFrames(20))).not.toThrow();
    expect(() => driver.echoMark("x")).not.toThrow();
  });

  it("disposes already-attached stages when a later stage's attach throws", async () => {
    const disposed: string[] = [];
    const good: Stage = {
      name: "good",
      consumes: [],
      emits: [],
      attach: () => ({
        dispose: () => {
          disposed.push("good");
        },
      }),
    };
    const boom: Stage = {
      name: "boom",
      consumes: [],
      emits: [],
      attach: () => {
        throw new Error("attach failed");
      },
    };
    const { adapter, call } = buildCall({ stages: [good, boom] });
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }
    // Transport-level: attachVoice's error surfaces on the session bus and
    // ends the call, regardless of the pipeline bus.
    const recorded = recordEvents(session.bus);
    await session.ended;

    expect(recorded).toHaveEndedOnce();
    expect(recorded.of("call-ended")[0].reason).toBe("error");
    expect(disposed).toContain("good");
  });
});

describe("say() lifecycle edge cases", () => {
  it("supersedes an in-flight say with exactly one clear", async () => {
    const { adapter, call, getVoice } = buildCall();
    const { driver, voice } = await liveSession(adapter, call, getVoice);

    const first = voice.say("first message, long enough to synthesize");
    const second = voice.say("second message, long enough to synthesize");

    const firstResult = await first;
    expect(firstResult.interrupted).toBe(true);
    expect(driver.clears).toBe(1);

    await vi.waitFor(() => expect(driver.marks.length).toBeGreaterThan(0));
    driver.echoAllMarks();
    const secondResult = await second;
    expect(secondResult.interrupted).toBe(false);
    expect(driver.clears).toBe(1);

    await voice.session.end();
  });

  it("completes a zero-frame utterance without speech events", async () => {
    const { adapter, call, getVoice } = buildCall();
    const { voice, recorded } = await liveSession(adapter, call, getVoice);

    const result = await voice.say("");
    expect(result.interrupted).toBe(false);
    expect(recorded.of("agent-speech-start")).toHaveLength(0);
    expect(recorded.of("agent-speech-end")).toHaveLength(0);

    await voice.session.end();
  });

  it("resolves once when a mark echo wins the race against speech-start", async () => {
    const { adapter, call, getVoice } = buildCall();
    const { driver, voice, recorded } = await liveSession(
      adapter,
      call,
      getVoice
    );

    const say = voice.say(
      "Hello there, this is a long enough agent response to keep speaking."
    );
    await vi.waitFor(() =>
      expect(recorded.of("agent-speech-start").length).toBeGreaterThan(0)
    );
    const utteranceId = recorded.of("agent-speech-start")[0].utteranceId;

    // Mark echo first, then speech-start in the same synchronous turn.
    driver.echoMark(utteranceId);
    voice.bus.publish("speech-start", { timestamp: 0 });

    const result = await say;
    expect(result.interrupted).toBe(false);
    expect(recorded.of("interruption")).toHaveLength(0);

    await voice.session.end();
  });

  it("resolves interrupted when speech-start wins the race against a mark echo", async () => {
    const { adapter, call, getVoice } = buildCall();
    const { driver, voice, recorded } = await liveSession(
      adapter,
      call,
      getVoice
    );

    const say = voice.say(
      "Another long enough agent response for the reverse race case here."
    );
    await vi.waitFor(() =>
      expect(recorded.of("agent-speech-start").length).toBeGreaterThan(0)
    );
    const utteranceId = recorded.of("agent-speech-start")[0].utteranceId;

    // Speech-start first (interrupt), then a late mark echo (no-op).
    voice.bus.publish("speech-start", { timestamp: 0 });
    driver.echoMark(utteranceId);

    const result = await say;
    expect(result.interrupted).toBe(true);
    expect(driver.clears).toBe(1);

    await voice.session.end();
  });
});

describe("graph validation & error handling", () => {
  it("throws CallConfigError from attachVoice when silence-turn has no STT", () => {
    const adapter = createMockAdapter("mock");
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    // attachVoice validates synchronously — a live session (any session)
    // is enough to call it on directly; the throw happens before any
    // stage attaches.
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }
    expect(() =>
      attachVoice(session, {
        logger: "silent",
        stages: [createSilenceTurnStage()],
      })
    ).toThrow(CallConfigError);
  });

  it("invokes onError then ends the call on a fatal mid-call stage failure", async () => {
    const errors: CallEventMap["error"][] = [];
    // Triggered by the first replayed inbound frame (i.e. once the call is
    // actually live), rather than by "call-started" — that transport event
    // has already fired by the time attachVoice's stages subscribe, so it
    // would never reach a stage's own bus subscription.
    const midFail: Stage = {
      name: "mid-fail",
      consumes: ["audio-frame"],
      emits: [],
      attach: (ctx: StageContext) => {
        const unsubscribe = ctx.bus.subscribe("audio-frame", () => {
          ctx.fail(new Error("mid-call boom"), { fatal: true });
        });
        return { dispose: () => unsubscribe() };
      },
    };
    const { adapter, call } = buildCall({
      stages: [midFail],
      onError: (error) => {
        errors.push(error);
      },
    });
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }
    const recorded = recordEvents(session.bus);
    driver.sendAudio(toneFrames(20));
    await session.ended;

    expect(errors.length).toBeGreaterThan(0);
    expect(recorded).toHaveEndedOnce();
    expect(recorded.of("call-ended")[0].reason).toBe("error");
  });
});
