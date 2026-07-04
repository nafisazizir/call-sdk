import {
  Call,
  createEnergyVadStage,
  createSilenceTurnStage,
  type SayResult,
  type SessionHandlers,
  type Stage,
} from "call-sdk";
import { describe, expect, it, vi } from "vitest";
import { concatFrames, silenceFrames, toneFrames } from "./audio";
import {
  type CreateMockAdapterOptions,
  createMockAdapter,
  type MockAdapter,
} from "./factories";
import { recordEvents } from "./matchers";
import {
  createMockSttStage,
  createMockTtsStage,
  type MockSttScriptEntry,
} from "./mock-stages";

interface BuildOptions {
  adapterOptions?: CreateMockAdapterOptions;
  extraStages?: Stage[];
  onEndOfTurn?: SessionHandlers["onEndOfTurn"];
  sttScript?: MockSttScriptEntry[];
  ttsConfig?: { msPerChar?: number; chunkMs?: number };
}

function buildCall(opts: BuildOptions = {}): {
  adapter: MockAdapter;
  call: Call;
} {
  const adapter = createMockAdapter("mock", opts.adapterOptions);
  const call = new Call({
    adapters: { mock: adapter },
    stages: [
      createEnergyVadStage({ hangoverMs: 100 }),
      createSilenceTurnStage({ silenceMs: 200 }),
      createMockSttStage({
        script: opts.sttScript ?? [{ final: "hello there" }],
      }),
      createMockTtsStage(opts.ttsConfig),
      ...(opts.extraStages ?? []),
    ],
    logger: "silent",
    ...(opts.onEndOfTurn ? { onEndOfTurn: opts.onEndOfTurn } : {}),
  });
  return { adapter, call };
}

const userTurnAudio = () => concatFrames(toneFrames(600), silenceFrames(400));

describe("full duplex loop", () => {
  it("runs a complete turn: audio → VAD → STT → end-of-turn → say → TTS → playback", async () => {
    let sayResult: Promise<SayResult> | undefined;
    const { adapter, call } = buildCall({
      onEndOfTurn: (_turn, session) => {
        sayResult = session.say("Sure, one moment.");
      },
    });
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    expect(session).toBeDefined();
    if (!session) {
      return;
    }
    const recorded = recordEvents(session.bus);

    driver.sendAudio(userTurnAudio());

    await vi.waitFor(() =>
      expect(recorded.of("end-of-turn").length).toBeGreaterThan(0)
    );
    await vi.waitFor(() => expect(driver.written.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(driver.marks.length).toBeGreaterThan(0));

    driver.echoAllMarks();
    const result = await sayResult;
    expect(result?.interrupted).toBe(false);

    expect(
      recorded.of("agent-speech-end").some((e) => e.interrupted === false)
    ).toBe(true);
    expect(session.state).toBe("idle");

    const roles = session.transcript.map((entry) => entry.role);
    expect(roles).toContain("user");
    expect(roles).toContain("agent");
    for (const frame of driver.written) {
      expect(frame).toBeCanonicalFrame();
    }
  });

  it("barges in mid-utterance: interrupt, flush, resolve interrupted", async () => {
    let sayResult: Promise<SayResult> | undefined;
    const longText = "This is a fairly long agent response ".repeat(6);
    const { adapter, call } = buildCall({
      onEndOfTurn: (_turn, session) => {
        sayResult = session.say(longText);
      },
    });
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }
    const recorded = recordEvents(session.bus);

    driver.sendAudio(userTurnAudio());
    await vi.waitFor(() => expect(driver.written.length).toBeGreaterThan(0));
    expect(session.state).toBe("agent-speaking");

    // Caller starts talking over the agent.
    driver.sendAudio(toneFrames(100));
    await vi.waitFor(() =>
      expect(recorded.of("interruption").length).toBeGreaterThan(0)
    );

    expect(driver.clears).toBe(1);
    const result = await sayResult;
    expect(result?.interrupted).toBe(true);
    expect(
      recorded.of("agent-speech-end").some((e) => e.interrupted === true)
    ).toBe(true);
    expect(session.state).toBe("user-speaking");

    const writtenAfterInterrupt = driver.written.length;
    // Caller stops → speech-end returns state to idle, no new agent audio.
    driver.sendAudio(silenceFrames(200));
    await vi.waitFor(() => expect(session.state).toBe("idle"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(driver.written.length).toBe(writtenAfterInterrupt);
  });

  it("completes playback via the duration-timer fallback when the adapter has no marks", async () => {
    let sayResult: Promise<SayResult> | undefined;
    const { adapter, call } = buildCall({
      adapterOptions: { supportsMarks: false },
      ttsConfig: { msPerChar: 5 },
      onEndOfTurn: (_turn, session) => {
        sayResult = session.say("ok");
      },
    });
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }

    driver.sendAudio(userTurnAudio());
    await vi.waitFor(() => expect(sayResult).toBeDefined());
    const result = await sayResult;
    expect(result?.interrupted).toBe(false);
    expect(driver.marks).toHaveLength(0);
  });

  it("records positive response latency and the expected telemetry marks", async () => {
    let sayResult: Promise<SayResult> | undefined;
    const { adapter, call } = buildCall({
      onEndOfTurn: (_turn, session) => {
        sayResult = session.say("Sure, one moment.");
      },
    });
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }

    driver.sendAudio(userTurnAudio());
    await vi.waitFor(() => expect(driver.marks.length).toBeGreaterThan(0));
    driver.echoAllMarks();
    await sayResult;

    const turn0 = session.telemetry.turns[0];
    expect(turn0).toBeDefined();
    expect(turn0.responseLatencyMs).toBeGreaterThan(0);

    const markNames = session.telemetry.marks.map((mark) => mark.name);
    expect(markNames).toContain("say-called");
    expect(markNames).toContain("first-outbound-write");
  });
});

describe("outbound call setup", () => {
  it("resolves startCall once the provider connects media for the same call", async () => {
    const { adapter, call } = buildCall();
    const pending = call.startCall("mock", { to: "+61400000000" });
    // Provider dials back into the media plane with the minted call id.
    const driver = adapter.connectCall({ callId: "mock-call-1" });
    const session = await pending;
    expect(session.id).toBe(driver.sessionId);
    await session.end("local-end");
  });

  it("rejects startCall when the media stream never arrives", async () => {
    const { call } = buildCall();
    await expect(
      call.startCall("mock", { to: "+61400000000", timeoutMs: 50 })
    ).rejects.toThrow();
  });
});
