/**
 * Mini end-to-end integration test: a real Node `http` server + a real `ws`
 * `WebSocketServer`, a real `Call` wired to the real `TwilioAdapter`, driven
 * entirely through `FakeTwilioCall`, a protocol-accurate fake Twilio client.
 *
 * The consumer here is a tiny inline agent that drives `session.audio`
 * directly — `frames()`/`audio-frame` in, `write()`/`mark()`/`clear()` out —
 * with **no voice pipeline**. The point is to prove the *adapter's* three
 * duties over the real wire, not any semantic layer above it: inbound mu-law
 * normalizes to canonical frames, outbound canonical frames de-normalize back
 * onto the wire, `clear()` flushes the provider queue for barge-in, and every
 * call ends with exactly one `call-ended`. (The semantic pipeline is
 * exercised in `examples/twilio-on-ws`, which owns it.)
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
  adapterContract,
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
const CANONICAL_SAMPLES_PER_FRAME = 320;

// A ~1s outbound playback window (50 canonical 20ms frames): long enough that
// a barge-in injected shortly after the mark request lands while the utterance
// is still "playing", short enough to keep the test fast.
const OUTBOUND_FRAMES = 50;
// A run of silent inbound frames that ends the caller's turn (~60ms).
const END_OF_TURN_SILENCE_FRAMES = 3;
// Canonical inbound amplitude above which a frame counts as speech.
const SPEECH_AMPLITUDE = 1000;

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

/**
 * A minimal media-plane consumer driving `session.audio` directly — no
 * pipeline. A tiny silence-based turn detector: once the caller has spoken
 * and then gone quiet, it writes a fixed burst of outbound frames plus a
 * playback mark (the "reply"); fresh caller speech while that reply is still
 * playing is treated as barge-in and flushes the outbound queue via `clear()`.
 * Just enough behavior to drive the adapter's full duplex wire path.
 */
function attachRawDuplexAgent(session: CallSession): void {
  let speaking = false;
  let sawSpeech = false;
  let silenceRun = 0;
  let uttered = 0;

  const speak = (): void => {
    speaking = true;
    uttered += 1;
    for (let i = 0; i < OUTBOUND_FRAMES; i++) {
      session.audio.write({
        samples: new Int16Array(CANONICAL_SAMPLES_PER_FRAME),
        timestamp: i * 20,
      });
    }
    session.audio.mark(`utt-${uttered}`);
  };

  // Playback completed (the provider echoed our mark) — back to idle.
  session.bus.subscribe("audio-mark", () => {
    speaking = false;
    sawSpeech = false;
    silenceRun = 0;
  });

  session.bus.subscribe("audio-frame", ({ frame }) => {
    const energetic = frame.samples.some((s) => Math.abs(s) > SPEECH_AMPLITUDE);
    if (speaking) {
      if (energetic) {
        // Barge-in: the caller talks over the reply — flush the queue.
        session.audio.clear();
        speaking = false;
        sawSpeech = false;
        silenceRun = 0;
      }
      return;
    }
    if (energetic) {
      sawSpeech = true;
      silenceRun = 0;
      return;
    }
    if (sawSpeech) {
      silenceRun += 1;
      if (silenceRun >= END_OF_TURN_SILENCE_FRAMES) {
        speak();
      }
    }
  });
}

interface Harness {
  baseUrl: string;
  call: Call;
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
  call.onCallStarted((session) => {
    attachRawDuplexAgent(session);
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

  return { harness: { baseUrl, call }, stop };
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

  it("drives a full duplex turn: inbound mu-law normalizes to frames, outbound frames + mark reach the wire, mark echoes back", async () => {
    const callSid = "CAfullloop00000000000000000000000";
    const fake = await startFakeTwilioCall({
      baseUrl: harness.baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
      callSid,
    });
    expect(fake.twimlResponse.status).toBe(200);
    expect(fake.twimlResponse.body).toContain("<Connect><Stream");

    const session = await waitForSession(harness.call, `twilio:${callSid}`);
    const recorded = recordEvents(session.bus);

    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });

    // Inbound mu-law was normalized and delivered as canonical PCM16 frames.
    const inbound = recorded.of("audio-frame");
    expect(inbound.length).toBeGreaterThan(0);
    for (const { frame } of inbound) {
      expect(frame.samples).toBeInstanceOf(Int16Array);
      expect(frame.samples.length).toBe(CANONICAL_SAMPLES_PER_FRAME);
    }

    // caller silence -> end-of-turn -> the inline agent writes outbound frames
    // + a mark, which de-normalize back onto the wire.
    await fake.waitFor((r) => r.mediaMs > 0, 3000);
    await fake.waitFor((r) => r.marks.length > 0, 3000);

    // autoEchoMarks (default on) echoes the mark back once its simulated
    // playback window elapses; the adapter surfaces it as `audio-mark`.
    await fake.waitFor(() => recorded.of("audio-mark").length > 0, 3000);
    expect(recorded.of("audio-mark")[0].name).toBe("utt-1");

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
    // Ensure the media session actually connected before driving audio.
    await waitForSession(harness.call, `twilio:${callSid}`);

    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });

    // Wait for the agent to start talking (mark request queued behind its
    // audio) but NOT for the mark echo — the simulated playback window is
    // still open, so the utterance is still "playing" from the SDK's POV.
    await fake.waitFor((r) => r.marks.length > 0, 3000);
    expect(fake.received.clears).toBe(0);

    // Barge in: fresh caller speech while the reply is still playing.
    await fake.speak({ ms: 60, kind: "tone" });

    await fake.waitFor((r) => r.clears === 1, 2000);
    const mediaMsAtInterrupt = fake.received.mediaMs;
    await delay(150);
    // Media flow plateaus: nothing more is written once the clear fires.
    expect(fake.received.mediaMs).toBe(mediaMsAtInterrupt);

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
        forwardMultiple: ({ body }) => {
          expect(verbs(body)).toMatchObject([
            {
              tag: "Dial",
              children: [
                { tag: "Number", text: "+15550001111" },
                { tag: "Number", text: "+15550003333" },
              ],
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
