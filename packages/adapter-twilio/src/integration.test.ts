/**
 * Mini end-to-end integration test: a real Node `http` server + a real `ws`
 * `WebSocketServer`, a real `Call` wired to the real `TwilioAdapter`, real
 * (shrunk-window) energy-VAD and silence-turn stages, and mock STT/TTS from
 * `@call-adapter/tests` — driven entirely through `FakeTwilioCall`, a
 * protocol-accurate fake Twilio client. No part of the pipeline is mocked
 * except the STT/TTS providers, exactly as SPEC.md's "The Adapter Contract"
 * and "Two Entry Points, One Graph" describe: the adapter is thin, everything
 * semantic lives above it.
 *
 * This is also where `call.media.twilio(ws)` proves the structural-typing
 * claim in call-sdk's `MediaSocket` doc comment: a raw `ws` `WebSocket`
 * instance is handed to it with **no wrapper** — if that stopped
 * type-checking, this file is where it would surface.
 */

/**
 * biome-ignore-all lint/suspicious/noMisplacedAssertion: the routing
 * contract's per-verb callbacks run inside the kit's `it()` blocks — Biome
 * just can't see across the `routingContract` call boundary.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  attachVoice,
  createEnergyVadStage,
  createSilenceTurnStage,
  type VoiceSession,
} from "@call-adapter/pipeline";
import {
  adapterContract,
  createMockSttStage,
  createMockTtsStage,
  parseTwiml,
  recordEvents,
  routingContract,
  startFakeTwilioCall,
} from "@call-adapter/tests";
import { Call, type CallSession, type MediaSocket } from "call-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createTwilioAdapter, type TwilioAdapter } from "./index";
import { computeTwilioSignature } from "./signature";

const AUTH_TOKEN = "test-auth-token";
const WEBHOOK_PATH = "/twilio/voice";
const MEDIA_PATH = "/twilio/media";
// Long enough that the simulated playback window (proportional to length)
// comfortably outlasts a barge-in injected shortly after the mark request,
// short enough to keep the test fast.
const RESPONSE_TEXT =
  "This is the fixed agent reply used to validate the full duplex loop end to end.";
const TRANSCRIPT_TRIGGER = "hello there";

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

interface Harness {
  baseUrl: string;
  call: Call;
  voices: Map<string, VoiceSession>;
}

async function startHarness(): Promise<{
  harness: Harness;
  stop: () => Promise<void>;
}> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const twilioAdapter = createTwilioAdapter({
    authToken: AUTH_TOKEN,
    validateSignature: true,
    mediaUrl: `ws://127.0.0.1:${port}${MEDIA_PATH}`,
    mediaPath: MEDIA_PATH,
  });

  const call = new Call({
    adapters: { twilio: twilioAdapter },
    logger: "silent",
  });
  const voices = new Map<string, VoiceSession>();
  call.onCallStarted((session) => {
    // Attached synchronously so the buffered inbound audio replays into the
    // stages once they finish attaching.
    voices.set(
      session.id,
      attachVoice(session, {
        logger: "silent",
        stages: [
          // Shrunk windows so VAD/turn detection resolve in tens of ms
          // instead of the real-world hundreds-of-ms defaults — this is a
          // test, not a production latency profile.
          createEnergyVadStage({ activationFrames: 1, hangoverMs: 60 }),
          createMockSttStage({ script: [{ final: TRANSCRIPT_TRIGGER }] }),
          createSilenceTurnStage({ silenceMs: 60, finalGraceMs: 200 }),
          createMockTtsStage({ msPerChar: 15, chunkMs: 20 }),
        ],
        onEndOfTurn: (_turn, voice) => {
          void voice.say(RESPONSE_TEXT);
        },
      })
    );
  });

  server.on("request", (req, res) => {
    if (req.method !== "POST" || req.url !== WEBHOOK_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers.set(key, value);
          }
        }
        const request = new Request(`${baseUrl}${req.url}`, {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
        });
        const response = await call.webhooks.twilio(request);
        res.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries())
        );
        res.end(await response.text());
      })();
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== MEDIA_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The structural-typing claim under test — see the file doc comment.
      call.media.twilio(ws);
    });
  });

  const stop = async (): Promise<void> => {
    await call.shutdown();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { harness: { baseUrl, call, voices }, stop };
}

describe("Twilio adapter mini integration", () => {
  let harness: Harness;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    const started = await startHarness();
    harness = started.harness;
    stop = started.stop;
  });

  afterEach(async () => {
    await stop();
  });

  it("rejects a webhook with an invalid signature and never opens the media socket", async () => {
    const fake = await startFakeTwilioCall({
      baseUrl: harness.baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: "wrong-token",
      callSid: "CAbadsignature000000000000000000",
    });
    expect(fake.twimlResponse.status).toBe(403);
    expect(fake.streamUrl).toBe("");
  });

  it("drives a full turn: caller speech -> transcript -> agent reply -> mark echo -> agent-speech-end", async () => {
    const callSid = "CAfullloop00000000000000000000000";
    const fake = await startFakeTwilioCall({
      baseUrl: harness.baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
      callSid,
    });
    expect(fake.twimlResponse.status).toBe(200);

    const session = await waitForSession(harness.call, `twilio:${callSid}`);
    const voice = harness.voices.get(session.id);
    if (!voice) {
      throw new Error("voice pipeline was not attached");
    }
    const recorded = recordEvents(voice.bus);

    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });

    // end-of-turn -> onEndOfTurn -> voice.say() -> audio-out -> outbound
    // media frames flow back to the fake client.
    await fake.waitFor((r) => r.mediaMs > 0, 3000);
    await fake.waitFor((r) => r.marks.length > 0, 3000);

    // autoEchoMarks (default on) echoes the mark back once its simulated
    // playback window elapses, which resolves the utterance.
    await fake.waitFor(() => recorded.of("agent-speech-end").length > 0, 3000);

    const speechEnds = recorded.of("agent-speech-end");
    expect(speechEnds).toHaveLength(1);
    expect(speechEnds[0].interrupted).toBe(false);
    expect(recorded.of("end-of-turn")).toHaveLength(1);
    expect(recorded.of("end-of-turn")[0].transcript).toBe(TRANSCRIPT_TRIGGER);

    await fake.hangup();
    await session.ended;
    expect(recorded.of("call-ended")).toHaveLength(1);
  });

  it("barge-in: caller speech while the agent is talking clears playback exactly once and stops further audio", async () => {
    const callSid = "CAbargein000000000000000000000000";
    const fake = await startFakeTwilioCall({
      baseUrl: harness.baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
      callSid,
    });
    const session = await waitForSession(harness.call, `twilio:${callSid}`);
    const voice = harness.voices.get(session.id);
    if (!voice) {
      throw new Error("voice pipeline was not attached");
    }
    const recorded = recordEvents(voice.bus);

    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });

    // Wait for the agent to start talking (mark request queued behind its
    // audio) but NOT for the mark echo — the simulated playback window is
    // still open, so the utterance is still active from the SDK's POV.
    await fake.waitFor((r) => r.marks.length > 0, 3000);
    expect(fake.received.clears).toBe(0);

    // Barge in: 1 activation frame (20ms) is enough to flip VAD to speaking
    // while state is still "agent-speaking".
    await fake.speak({ ms: 60, kind: "tone" });

    await fake.waitFor((r) => r.clears === 1, 2000);
    const mediaMsAtInterrupt = fake.received.mediaMs;
    await delay(150);
    expect(fake.received.mediaMs).toBe(mediaMsAtInterrupt);

    const interrupted = recorded
      .of("agent-speech-end")
      .filter((e) => e.interrupted);
    expect(interrupted.length).toBeGreaterThanOrEqual(1);
    expect(recorded.of("interruption").length).toBeGreaterThanOrEqual(1);

    await fake.hangup();
  });

  it("tears down with exactly one call-ended event on a provider-initiated hangup", async () => {
    const callSid = "CAhangup0000000000000000000000000";
    const fake = await startFakeTwilioCall({
      baseUrl: harness.baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
      callSid,
    });
    const session = await waitForSession(harness.call, `twilio:${callSid}`);
    const recorded = recordEvents(session.bus);

    await fake.hangup();
    await session.ended;
    await fake.closed;

    expect(recorded.of("call-ended")).toHaveLength(1);
    // A second, redundant teardown attempt must not double the event.
    await session.end("local-end");
    expect(recorded.of("call-ended")).toHaveLength(1);
  });
});

describe("Twilio adapter contract", () => {
  // `adapterContract` opens a session via `opts.openSession` and drives
  // teardown/no-op-after-end assertions generically. The adapter's real
  // `media()` state machine only needs a structural `MediaSocket`, so we
  // hand it a minimal hand-rolled fake rather than a real `ws`/HTTP round
  // trip — this fits the descriptor cleanly because `AdapterSessionHandle`
  // creation only depends on a `start` message reaching `media()`, not on
  // any real network transport.
  function makeFakeSocket() {
    type Listener = (event: never) => void;
    const listeners: Record<"message" | "close" | "error", Listener[]> = {
      message: [],
      close: [],
      error: [],
    };
    return {
      addEventListener: (
        type: "message" | "close" | "error",
        listener: Listener
      ) => {
        listeners[type].push(listener);
      },
      send: () => {
        // outbound writes aren't exercised by the contract suite
      },
      close: () => {
        // no-op: the contract suite ends sessions via the handle, not the socket
      },
      emitMessage: (data: unknown) => {
        for (const l of listeners.message) {
          l({ data } as never);
        }
      },
      emitClose: () => {
        for (const l of listeners.close) {
          l({} as never);
        }
      },
    };
  }

  let counter = 0;

  adapterContract("twilio", () => createTwilioAdapter(), {
    openSession: (_call, adapter) => {
      counter += 1;
      const callId = `CAcontract${counter}`.padEnd(34, "0");
      const socket = makeFakeSocket();
      (adapter as TwilioAdapter).media(socket as unknown as MediaSocket);
      socket.emitMessage(
        JSON.stringify({
          event: "start",
          sequenceNumber: "1",
          streamSid: "MZcontract",
          start: {
            streamSid: "MZcontract",
            accountSid: "ACcontract",
            callSid: callId,
            tracks: ["inbound"],
            customParameters: { direction: "inbound" },
            mediaFormat: {
              encoding: "audio/x-mulaw",
              sampleRate: 8000,
              channels: 1,
            },
          },
        })
      );
      return Promise.resolve({
        sessionId: `twilio:${callId}`,
        endFromProvider: () => socket.emitClose(),
      });
    },
  });
});

describe("Twilio routing contract", () => {
  // The third adapter duty, asserted provider-agnostically by the kit and
  // provider-specifically here: each verb decision must come back as the
  // exact TwiML dialect Twilio speaks.
  const ROUTING_URL = "https://voice.example.com/twilio/voice";

  function makeInboundRequest(): Request {
    const fields = {
      CallSid: "CArouting000000000000000000000000",
      From: "+15550001111",
      To: "+15550002222",
      Direction: "inbound",
    };
    return new Request(ROUTING_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": computeTwilioSignature(
          AUTH_TOKEN,
          ROUTING_URL,
          fields
        ),
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  function verbs(body: string) {
    return parseTwiml(body);
  }

  routingContract(
    "twilio",
    () =>
      createTwilioAdapter({
        authToken: AUTH_TOKEN,
        mediaUrl: "wss://media.example.com/twilio/media",
      }),
    {
      makeInboundRequest,
      expectTranslated: {
        reject: ({ body }) => {
          expect(verbs(body)).toMatchObject([
            { tag: "Reject", attributes: { reason: "rejected" } },
          ]);
        },
        forward: ({ body }) => {
          expect(verbs(body)).toMatchObject([
            {
              tag: "Dial",
              children: [{ tag: "Number", text: "+15550001111" }],
            },
          ]);
        },
        say: ({ body }) => {
          expect(verbs(body)).toMatchObject([{ tag: "Say", text: "hello" }]);
        },
        play: ({ body }) => {
          expect(verbs(body)).toMatchObject([
            { tag: "Play", text: "https://example.com/a.mp3" },
          ]);
        },
        voicemail: ({ body }) => {
          const [say, record] = verbs(body);
          expect(say).toMatchObject({ tag: "Say", text: "leave a message" });
          expect(record).toMatchObject({
            tag: "Record",
            attributes: expect.objectContaining({
              maxLength: "120",
              playBeep: "true",
            }),
          });
          expect(record?.attributes.action).toContain("call_sdk_action=hangup");
        },
        hangup: ({ body }) => {
          expect(verbs(body)).toMatchObject([{ tag: "Hangup" }]);
        },
        stream: ({ body }) => {
          expect(body).toContain("<Connect><Stream");
        },
      },
    }
  );
});
