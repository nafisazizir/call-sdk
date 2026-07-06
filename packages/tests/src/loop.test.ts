import {
  attachVoice,
  createEnergyVadStage,
  createMockSttStage,
  createMockTtsStage,
  createSilenceTurnStage,
  type MockSttScriptEntry,
  type SayResult,
  type Stage,
  type VoiceOptions,
  type VoiceSession,
} from "@call-adapter/pipeline";
import { Call } from "call-sdk";
import { describe, expect, it, vi } from "vitest";
import { concatFrames, silenceFrames, toneFrames } from "./audio";
import {
  type CreateMockAdapterOptions,
  createMockAdapter,
  type MockAdapter,
} from "./factories";
import { type RecordedEvents, recordEvents } from "./matchers";

interface BuildOptions {
  adapterOptions?: CreateMockAdapterOptions;
  extraStages?: Stage[];
  onEndOfTurn?: VoiceOptions["onEndOfTurn"];
  sttScript?: MockSttScriptEntry[];
  ttsConfig?: { msPerChar?: number; chunkMs?: number };
}

/**
 * Builds a `Call` wired to a mock adapter and attaches the voice pipeline
 * synchronously inside `onCallStarted` (before any await), per
 * `attachVoice`'s contract — buffered inbound audio and any pre-attach
 * `say()` calls replay once the stage graph is live. `voice`/`recorded` are
 * captured at that same synchronous point so `recordEvents` never misses an
 * event produced during the (async) stage-attach + buffered-replay window.
 */
function buildCall(opts: BuildOptions = {}): {
  adapter: MockAdapter;
  call: Call;
  getRecorded: () => RecordedEvents | undefined;
  getVoice: () => VoiceSession | undefined;
} {
  const adapter = createMockAdapter("mock", opts.adapterOptions);
  let voice: VoiceSession | undefined;
  let recorded: RecordedEvents | undefined;
  const call = new Call({
    adapters: { mock: adapter },
    logger: "silent",
  });
  call.onCallStarted((session) => {
    voice = attachVoice(session, {
      logger: "silent",
      stages: [
        createEnergyVadStage({ hangoverMs: 100 }),
        createSilenceTurnStage({ silenceMs: 200 }),
        createMockSttStage({
          script: opts.sttScript ?? [{ final: "hello there" }],
        }),
        createMockTtsStage(opts.ttsConfig),
        ...(opts.extraStages ?? []),
      ],
      ...(opts.onEndOfTurn ? { onEndOfTurn: opts.onEndOfTurn } : {}),
    });
    recorded = recordEvents(voice.bus);
  });
  return {
    adapter,
    call,
    getVoice: () => voice,
    getRecorded: () => recorded,
  };
}

const userTurnAudio = () => concatFrames(toneFrames(600), silenceFrames(400));

describe("full duplex loop", () => {
  it("runs a complete turn: audio → VAD → STT → end-of-turn → say → TTS → playback", async () => {
    let sayResult: Promise<SayResult> | undefined;
    const { adapter, getVoice, getRecorded } = buildCall({
      onEndOfTurn: (_turn, voice) => {
        sayResult = voice.say("Sure, one moment.");
      },
    });
    const driver = adapter.connectCall();

    driver.sendAudio(userTurnAudio());

    await vi.waitFor(() =>
      expect(getRecorded()?.of("end-of-turn").length ?? 0).toBeGreaterThan(0)
    );
    const voice = getVoice();
    const recorded = getRecorded();
    if (!(voice && recorded)) {
      throw new Error("voice not attached");
    }
    await vi.waitFor(() => expect(driver.written.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(driver.marks.length).toBeGreaterThan(0));

    driver.echoAllMarks();
    const result = await sayResult;
    expect(result?.interrupted).toBe(false);

    expect(
      recorded.of("agent-speech-end").some((e) => e.interrupted === false)
    ).toBe(true);
    expect(voice.state).toBe("idle");

    const roles = voice.transcript.map((entry) => entry.role);
    expect(roles).toContain("user");
    expect(roles).toContain("agent");
    for (const frame of driver.written) {
      expect(frame).toBeCanonicalFrame();
    }
  });

  it("barges in mid-utterance: interrupt, flush, resolve interrupted", async () => {
    let sayResult: Promise<SayResult> | undefined;
    const longText = "This is a fairly long agent response ".repeat(6);
    const { adapter, getVoice, getRecorded } = buildCall({
      onEndOfTurn: (_turn, voice) => {
        sayResult = voice.say(longText);
      },
    });
    const driver = adapter.connectCall();

    driver.sendAudio(userTurnAudio());
    await vi.waitFor(() => expect(driver.written.length).toBeGreaterThan(0));
    const voice = getVoice();
    const recorded = getRecorded();
    if (!(voice && recorded)) {
      throw new Error("voice not attached");
    }
    expect(voice.state).toBe("agent-speaking");

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
    expect(voice.state).toBe("user-speaking");

    const writtenAfterInterrupt = driver.written.length;
    // Caller stops → speech-end returns state to idle, no new agent audio.
    driver.sendAudio(silenceFrames(200));
    await vi.waitFor(() => expect(voice.state).toBe("idle"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(driver.written.length).toBe(writtenAfterInterrupt);
  });

  it("completes playback via the duration-timer fallback when the adapter has no marks", async () => {
    let sayResult: Promise<SayResult> | undefined;
    const { adapter } = buildCall({
      adapterOptions: { supportsMarks: false },
      ttsConfig: { msPerChar: 5 },
      onEndOfTurn: (_turn, voice) => {
        sayResult = voice.say("ok");
      },
    });
    const driver = adapter.connectCall();

    driver.sendAudio(userTurnAudio());
    await vi.waitFor(() => expect(sayResult).toBeDefined());
    const result = await sayResult;
    expect(result?.interrupted).toBe(false);
    expect(driver.marks).toHaveLength(0);
  });

  it("records positive response latency and the expected telemetry marks", async () => {
    let sayResult: Promise<SayResult> | undefined;
    const { adapter, getVoice } = buildCall({
      onEndOfTurn: (_turn, voice) => {
        sayResult = voice.say("Sure, one moment.");
      },
    });
    const driver = adapter.connectCall();

    driver.sendAudio(userTurnAudio());
    await vi.waitFor(() => expect(driver.marks.length).toBeGreaterThan(0));
    driver.echoAllMarks();
    await sayResult;

    const voice = getVoice();
    if (!voice) {
      throw new Error("voice not attached");
    }
    const turn0 = voice.turns[0];
    expect(turn0).toBeDefined();
    expect(turn0.responseLatencyMs).toBeGreaterThan(0);

    const markNames = voice.session.telemetry.marks.map((mark) => mark.name);
    expect(markNames).toContain("say-called");
    expect(markNames).toContain("first-outbound-write");
  });
});

describe("outbound call setup", () => {
  it("resolves dial once the provider connects media for the same call", async () => {
    const { adapter, call } = buildCall();
    const pending = call.dial({ adapter: "mock", to: "+61400000000" });
    // Provider dials back into the media plane with the minted call id.
    const driver = adapter.connectCall({ callId: "mock-call-1" });
    const session = await pending;
    expect(session.id).toBe(driver.sessionId);
    await session.end("local-end");
  });

  it("rejects dial when the media stream never arrives", async () => {
    const { call } = buildCall();
    await expect(
      call.dial({ adapter: "mock", to: "+61400000000", timeoutMs: 50 })
    ).rejects.toThrow();
  });
});
