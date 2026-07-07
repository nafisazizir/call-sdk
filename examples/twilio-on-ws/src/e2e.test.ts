/**
 * Zero-credential end-to-end test for this example: a real `createCallServer`
 * (the exact wiring in `app.ts`) driven entirely through `FakeTwilioCall`, a
 * protocol-accurate fake Twilio client from `@call-adapter/tests` — no real
 * Twilio account, no real STT/TTS/LLM provider, no network egress at all.
 *
 * Stages are the real `createEnergyVadStage` + `createSilenceTurnStage` (SDK
 * defaults, shrunk to test-scale windows) plus the mock STT/TTS stages from
 * the test kit; only the provider edges are mocked, exactly as
 * `@call-adapter/twilio`'s `integration.test.ts` does — the timings here
 * (activation frames, hangover/silence windows, mock-TTS pacing) are copied
 * from that file because it's the known-stable reference for this harness.
 *
 * The example's default greeting is disabled here (`greeting: null`): with it
 * on, every session would open with an extra unscripted utterance racing the
 * scripted turns, which only muddies the mark/interruption assertions below
 * without adding coverage (the greeting is just another `voice.say()` call,
 * already exercised implicitly by every scripted turn).
 */

import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { startFakeTwilioCall } from "@call-adapter/tests";
import type { Call, CallEventMap, CallSession, TelemetryMark } from "call-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCallServer, MEDIA_PATH, WEBHOOK_PATH } from "./app";
import {
  createEnergyVadStage,
  createMockSttStage,
  createMockTtsStage,
  createSilenceTurnStage,
  type SayResult,
  type VoiceSession,
} from "./pipeline/index";
import { recordEvents } from "./pipeline/testing/matchers";

const AUTH_TOKEN = "test-auth-token";

// First (turnIndex 1) reply: long enough that the mock-TTS's simulated
// playback window (proportional to text length) comfortably outlasts a
// barge-in injected right after the mark request — see the barge-in test.
const TURN_1_TRANSCRIPT = "hello there, checking on my order status";
const LONG_RESPONSE =
  "Thanks for calling! Let me pull up your account details now and walk you through everything step by step.";
// Second reply: short, just to prove a fresh scripted turn (and the second
// mock-STT script entry) completes normally after the first.
const TURN_2_TRANSCRIPT = "great, that's all I needed";
const SHORT_RESPONSE = "Sounds good, thanks!";

/** Probes a free TCP port by briefly listening on port 0, then releases it. */
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForSession(
  call: Call,
  sessionId: string,
  timeoutMs = 2000
): Promise<CallSession> {
  const start = Date.now();
  for (;;) {
    const session = call.getSession(sessionId);
    if (session) {
      return session;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `session "${sessionId}" was never created within ${timeoutMs}ms`
      );
    }
    await delay(10);
  }
}

describe("examples/twilio-on-ws E2E (zero credentials)", () => {
  let baseUrl: string;
  let call: Call;
  let close: () => Promise<void>;
  let marks: TelemetryMark[];
  let sayResults: SayResult[];
  let voices: Map<string, VoiceSession>;

  beforeEach(async () => {
    marks = [];
    sayResults = [];
    const port = await getFreePort();

    const server = createCallServer({
      twilio: {
        authToken: AUTH_TOKEN,
        validateSignature: true,
        // The adapter would otherwise derive `wss://{Host header}` from the
        // inbound webhook — a scheme FakeTwilioCall's plain `ws` client
        // can't dial against this plain (non-TLS) test server. Since the
        // port is only known after `listen()`, but `mediaUrl` must be set
        // before it, probe a free port up front and reuse it for both.
        mediaUrl: `ws://127.0.0.1:${port}${MEDIA_PATH}`,
      },
      stages: [
        // Shrunk windows so VAD/turn detection resolve in tens of ms instead
        // of the real-world hundreds-of-ms defaults — mirrors
        // `@call-adapter/twilio`'s integration.test.ts exactly.
        createEnergyVadStage({ activationFrames: 1, hangoverMs: 60 }),
        createMockSttStage({
          script: [{ final: TURN_1_TRANSCRIPT }, { final: TURN_2_TRANSCRIPT }],
        }),
        createSilenceTurnStage({ silenceMs: 60, finalGraceMs: 200 }),
        createMockTtsStage({ msPerChar: 15, chunkMs: 20 }),
      ],
      // Instant barge-in: this suite tests the interruption *mechanism*
      // deterministically, not the example's noise-robust default
      // (`minSpeechMs: 500`), which would require sustained tone to trip.
      interruption: { minSpeechMs: 0 },
      agent: async (turn: CallEventMap["end-of-turn"], voice: VoiceSession) => {
        const text = turn.turnIndex === 1 ? LONG_RESPONSE : SHORT_RESPONSE;
        const result = await voice.say(text);
        sayResults.push(result);
      },
      greeting: null,
      telemetrySink: (mark) => marks.push(mark),
      // "error" keeps CI logs clean while still surfacing anything unexpected.
      logger: "error",
    });

    call = server.call;
    voices = server.voices;
    const listening = await server.listen(port);
    baseUrl = `http://127.0.0.1:${listening.port}`;
    close = listening.close;
  });

  afterEach(async () => {
    await close();
  });

  async function getVoice(sessionId: string): Promise<VoiceSession> {
    const voice = voices.get(sessionId);
    if (!voice) {
      throw new Error(`voice pipeline was not attached for ${sessionId}`);
    }
    return voice;
  }

  it("happy path: caller speech -> transcript -> agent reply -> mark echo -> agent-speech-end, across two turns", async () => {
    const callSid = "CAhappypath0000000000000000000000";
    const fake = await startFakeTwilioCall({
      baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
      callSid,
    });
    expect(fake.twimlResponse.status).toBe(200);
    expect(fake.twimlResponse.body).toContain("<Connect><Stream");

    const session = await waitForSession(call, `twilio:${callSid}`);
    const voice = await getVoice(session.id);
    const recorded = recordEvents(voice.bus);

    // Low-level bus tap (SPEC.md, "Two Entry Points, One Graph") — observed
    // independently of the `recordEvents` helper used for the rest of the
    // assertions below.
    let firstSpeechEndViaOn: CallEventMap["agent-speech-end"] | undefined;
    voice.on("agent-speech-end", (payload) => {
      firstSpeechEndViaOn ??= payload;
    });

    // Turn 1: caller speaks, then goes quiet.
    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });

    // end-of-turn -> onEndOfTurn -> voice.say() -> audio-out -> outbound
    // media frames flow back to the fake client -> mark request -> echo.
    await fake.waitFor((r) => r.mediaMs > 0, 5000);
    await fake.waitFor((r) => r.marks.length > 0, 5000);
    await fake.waitFor(() => recorded.of("agent-speech-end").length > 0, 5000);

    expect(firstSpeechEndViaOn?.interrupted).toBe(false);
    const firstTurnSpeechEnds = recorded.of("agent-speech-end");
    expect(firstTurnSpeechEnds).toHaveLength(1);
    expect(firstTurnSpeechEnds[0].interrupted).toBe(false);
    expect(recorded.of("end-of-turn")).toHaveLength(1);
    expect(recorded.of("end-of-turn")[0].transcript).toBe(TURN_1_TRANSCRIPT);

    // Turn 2: prove a fresh scripted turn completes normally too.
    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });
    await fake.waitFor(
      () => recorded.of("agent-speech-end").length === 2,
      5000
    );

    const allSpeechEnds = recorded.of("agent-speech-end");
    expect(allSpeechEnds.every((e) => !e.interrupted)).toBe(true);
    expect(recorded.of("end-of-turn")).toHaveLength(2);
    expect(recorded.of("end-of-turn").map((e) => e.transcript)).toEqual([
      TURN_1_TRANSCRIPT,
      TURN_2_TRANSCRIPT,
    ]);

    expect(voice.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: TURN_1_TRANSCRIPT }),
        expect.objectContaining({ role: "agent", text: LONG_RESPONSE }),
        expect.objectContaining({ role: "user", text: TURN_2_TRANSCRIPT }),
        expect.objectContaining({ role: "agent", text: SHORT_RESPONSE }),
      ])
    );

    const turns = voice.turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]?.responseLatencyMs).toBeGreaterThan(0);
    // Printed once for the README (M7): the measured happy-path latency
    // numbers on this machine's mock pipeline.
    console.info(
      `[e2e] happy-path turn 1: responseLatencyMs=${turns[0]?.responseLatencyMs?.toFixed(1)}ms ` +
        `voiceToVoiceMs=${turns[0]?.voiceToVoiceMs?.toFixed(1)}ms`
    );

    await fake.hangup();
    await session.ended;
  }, 20_000);

  it("barge-in: caller speech while the agent is talking interrupts, clears playback, and resolves say() as interrupted", async () => {
    const callSid = "CAbargein000000000000000000000000";
    const fake = await startFakeTwilioCall({
      baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
      callSid,
    });
    const session = await waitForSession(call, `twilio:${callSid}`);
    const voice = await getVoice(session.id);
    const recorded = recordEvents(voice.bus);

    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });

    // Wait for the agent to start talking (mark request queued behind its
    // audio) but NOT for the mark echo — the simulated playback window is
    // still open, so the utterance is still active from the SDK's POV.
    await fake.waitFor((r) => r.marks.length > 0, 5000);
    expect(fake.received.clears).toBe(0);

    // Barge in: 1 activation frame (20ms) is enough to flip VAD to
    // speaking while state is still "agent-speaking".
    await fake.speak({ ms: 60, kind: "tone" });

    await fake.waitFor((r) => r.clears === 1, 3000);
    const mediaMsAtInterrupt = fake.received.mediaMs;
    // Media flow plateaus: nothing more is written once the clear fires.
    await delay(150);
    expect(fake.received.mediaMs).toBe(mediaMsAtInterrupt);

    const interruptedEnds = recorded
      .of("agent-speech-end")
      .filter((e) => e.interrupted);
    expect(interruptedEnds.length).toBeGreaterThanOrEqual(1);
    expect(recorded.of("interruption").length).toBeGreaterThanOrEqual(1);

    await fake.hangup();
    await session.ended;

    // The scripted agent's `voice.say()` call for turn 1 must resolve
    // as interrupted, not hang or resolve as a clean completion.
    expect(sayResults).toHaveLength(1);
    expect(sayResults[0]?.interrupted).toBe(true);
  }, 20_000);

  it("teardown + telemetry: exactly one call-ended, sessions map clears, and a positive-latency turn summary is recorded", async () => {
    const callSid = "CAteardown00000000000000000000000";
    const fake = await startFakeTwilioCall({
      baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
      callSid,
    });
    // Capture the session object before hangup: it's removed from
    // `call.sessions` on teardown, but the reference (and its telemetry)
    // stays valid.
    const session = await waitForSession(call, `twilio:${callSid}`);
    const voice = await getVoice(session.id);
    const recorded = recordEvents(voice.bus);

    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });
    await fake.waitFor(() => recorded.of("agent-speech-end").length > 0, 5000);

    expect(call.sessions.size).toBe(1);

    await fake.hangup();
    await session.ended;
    await fake.closed;

    expect(recorded.of("call-ended")).toHaveLength(1);
    expect(call.sessions.size).toBe(0);
    expect(voices.has(session.id)).toBe(false);

    // A second, redundant teardown attempt must not double the event.
    await session.end("local-end");
    expect(recorded.of("call-ended")).toHaveLength(1);

    expect(marks.some((m) => m.name === "say-called")).toBe(true);
    const turns = voice.turns;
    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0]?.responseLatencyMs).toBeGreaterThan(0);
  }, 20_000);

  it("rejects a webhook with an invalid signature and never opens a session", async () => {
    const callSid = "CAbadsignature000000000000000000";
    const fake = await startFakeTwilioCall({
      baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: "wrong-token",
      callSid,
    });

    expect(fake.twimlResponse.status).toBe(403);
    expect(fake.streamUrl).toBe("");
    expect(call.sessions.size).toBe(0);
  });
});
