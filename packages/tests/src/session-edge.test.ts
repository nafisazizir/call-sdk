import {
  Call,
  CallConfigError,
  type CallEventMap,
  createEnergyVadStage,
  createSilenceTurnStage,
  type SessionHandlers,
  type Stage,
  type StageContext,
} from "call-sdk";
import { describe, expect, it, vi } from "vitest";
import { toneFrames } from "./audio";
import { createMockAdapter, type MockAdapter } from "./factories";
import { recordEvents } from "./matchers";
import {
  createMockSttStage,
  createMockTtsStage,
  type MockSttScriptEntry,
} from "./mock-stages";

interface BuildOptions {
  onEndOfTurn?: SessionHandlers["onEndOfTurn"];
  onError?: SessionHandlers["onError"];
  stages?: Stage[];
  sttScript?: MockSttScriptEntry[];
}

function buildCall(opts: BuildOptions = {}): {
  adapter: MockAdapter;
  call: Call;
} {
  const adapter = createMockAdapter("mock");
  const call = new Call({
    adapters: { mock: adapter },
    stages: opts.stages ?? [
      createEnergyVadStage({ hangoverMs: 100 }),
      createSilenceTurnStage({ silenceMs: 200 }),
      createMockSttStage({
        script: opts.sttScript ?? [{ final: "hello there" }],
      }),
      createMockTtsStage(),
    ],
    logger: "silent",
    ...(opts.onEndOfTurn ? { onEndOfTurn: opts.onEndOfTurn } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  return { adapter, call };
}

async function liveSession(adapter: MockAdapter, call: Call) {
  const driver = adapter.connectCall();
  const session = call.getSession(driver.sessionId);
  if (!session) {
    throw new Error("no session");
  }
  const recorded = recordEvents(session.bus);
  await vi.waitFor(() => {
    if (recorded.of("call-started").length === 0) {
      throw new Error("call not started yet");
    }
  });
  return { driver, session, recorded };
}

describe("teardown & exactly-once semantics", () => {
  it("emits exactly one call-ended under concurrent hangup / end / fail", async () => {
    const { adapter, call } = buildCall();
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }
    const recorded = recordEvents(session.bus);

    driver.hangup();
    const endPromise = session.end();
    driver.fail(new Error("boom"));

    await endPromise;
    await session.ended;

    expect(recorded).toHaveEndedOnce();
    expect(call.sessions.has(session.id)).toBe(false);
  });

  it("treats post-end operations as silent no-ops", async () => {
    const { adapter, call } = buildCall();
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }
    driver.hangup();
    await session.ended;

    const result = await session.say("too late");
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
    const recorded = recordEvents(session.bus);
    await session.ended;

    expect(recorded).toHaveEndedOnce();
    expect(recorded.of("call-ended")[0].reason).toBe("error");
    expect(disposed).toContain("good");
  });
});

describe("say() lifecycle edge cases", () => {
  it("supersedes an in-flight say with exactly one clear", async () => {
    const { adapter, call } = buildCall();
    const { driver, session } = await liveSession(adapter, call);

    const first = session.say("first message, long enough to synthesize");
    const second = session.say("second message, long enough to synthesize");

    const firstResult = await first;
    expect(firstResult.interrupted).toBe(true);
    expect(driver.clears).toBe(1);

    await vi.waitFor(() => expect(driver.marks.length).toBeGreaterThan(0));
    driver.echoAllMarks();
    const secondResult = await second;
    expect(secondResult.interrupted).toBe(false);
    expect(driver.clears).toBe(1);

    await session.end();
  });

  it("completes a zero-frame utterance without speech events", async () => {
    const { adapter, call } = buildCall();
    const { session, recorded } = await liveSession(adapter, call);

    const result = await session.say("");
    expect(result.interrupted).toBe(false);
    expect(recorded.of("agent-speech-start")).toHaveLength(0);
    expect(recorded.of("agent-speech-end")).toHaveLength(0);

    await session.end();
  });

  it("resolves once when a mark echo wins the race against speech-start", async () => {
    const { adapter, call } = buildCall();
    const { driver, session, recorded } = await liveSession(adapter, call);

    const say = session.say(
      "Hello there, this is a long enough agent response to keep speaking."
    );
    await vi.waitFor(() =>
      expect(recorded.of("agent-speech-start").length).toBeGreaterThan(0)
    );
    const utteranceId = recorded.of("agent-speech-start")[0].utteranceId;

    // Mark echo first, then speech-start in the same synchronous turn.
    driver.echoMark(utteranceId);
    session.bus.publish("speech-start", { timestamp: 0 });

    const result = await say;
    expect(result.interrupted).toBe(false);
    expect(recorded.of("interruption")).toHaveLength(0);

    await session.end();
  });

  it("resolves interrupted when speech-start wins the race against a mark echo", async () => {
    const { adapter, call } = buildCall();
    const { driver, session, recorded } = await liveSession(adapter, call);

    const say = session.say(
      "Another long enough agent response for the reverse race case here."
    );
    await vi.waitFor(() =>
      expect(recorded.of("agent-speech-start").length).toBeGreaterThan(0)
    );
    const utteranceId = recorded.of("agent-speech-start")[0].utteranceId;

    // Speech-start first (interrupt), then a late mark echo (no-op).
    session.bus.publish("speech-start", { timestamp: 0 });
    driver.echoMark(utteranceId);

    const result = await say;
    expect(result.interrupted).toBe(true);
    expect(driver.clears).toBe(1);

    await session.end();
  });
});

describe("graph validation & error handling", () => {
  it("throws CallConfigError at construction when silence-turn has no STT", () => {
    expect(
      () =>
        new Call({
          adapters: { mock: createMockAdapter() },
          stages: [createSilenceTurnStage()],
          logger: "silent",
        })
    ).toThrow(CallConfigError);
  });

  it("invokes onError then ends the call on a fatal mid-call stage failure", async () => {
    const errors: CallEventMap["error"][] = [];
    const midFail: Stage = {
      name: "mid-fail",
      consumes: ["call-started"],
      emits: [],
      attach: (ctx: StageContext) => {
        const unsubscribe = ctx.bus.subscribe("call-started", () => {
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
    await session.ended;

    expect(errors.length).toBeGreaterThan(0);
    expect(recorded).toHaveEndedOnce();
    expect(recorded.of("call-ended")[0].reason).toBe("error");
  });
});
