/**
 * Mini end-to-end integration test for the Telnyx adapter: a real Node `http`
 * server + a real `ws` `WebSocketServer`, a real `Call` wired to the real
 * `TelnyxAdapter`, driven entirely through `startFakeTelnyxCall`, a
 * protocol-accurate fake Telnyx *client*.
 *
 * Where the Twilio adapter answers each webhook synchronously with TwiML,
 * Telnyx is asynchronous: the webhook is acked with a bare 200 and control
 * happens through follow-up REST commands whose outcomes arrive as more
 * webhooks. The fake REST API ({@link startFakeTelnyxApi}) records those
 * commands and — via its `webhookSink` — signs and delivers the consequence
 * webhooks back to the live webhook endpoint so multi-step verbs advance.
 *
 * The consumer here is a tiny inline agent that drives `session.audio`
 * directly — `audio-frame` in, `write()`/`mark()`/`clear()` out — with **no
 * voice pipeline**. The point is to prove the *adapter's* three duties over
 * the real wire: inbound L16/PCMU normalizes to canonical frames, outbound
 * canonical frames de-normalize back onto the wire, `clear()` flushes the
 * provider queue for barge-in, and every call ends with exactly one
 * `call-ended`.
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
  buildSignedTelnyxWebhook,
  createFakeTelnyxKeys,
  decodeTelnyxClientState,
  type FakeTelnyxApi,
  type FakeTelnyxKeys,
  matchers,
  type RecordedCommand,
  recordEvents,
  routingContract,
  startFakeTelnyxApi,
  startFakeTelnyxCall,
  type TelnyxWebhookEvent,
} from "@call-adapter/tests";
import { Call, type CallSession, type MediaSocket } from "call-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  createTelnyxAdapter,
  type TelnyxAdapter,
  telnyxCommandId,
} from "./index";

expect.extend(matchers);

const API_KEY = "test-api-key";
const WEBHOOK_PATH = "/telnyx/webhook";
const MEDIA_PATH = "/telnyx/media";
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

/** Reads the decoded `client_state` queue length off a recorded command. */
function queueLength(command: RecordedCommand): number {
  const state = decodeTelnyxClientState(
    command.body.client_state as string
  ) as {
    q?: unknown[];
  };
  return state.q?.length ?? -1;
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
  api: FakeTelnyxApi;
  baseUrl: string;
  call: Call;
  keys: FakeTelnyxKeys;
}

async function startHarness(): Promise<{
  harness: Harness;
  stop: () => Promise<void>;
}> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const webhookEndpoint = `${baseUrl}${WEBHOOK_PATH}`;

  const keys = createFakeTelnyxKeys();

  // The fake REST API records the adapter's commands and drives multi-step
  // verbs by signing + delivering each consequence webhook back to the live
  // webhook endpoint (with the same keys — the adapter validates every one).
  const api = await startFakeTelnyxApi({
    webhookSink: async (event: TelnyxWebhookEvent) => {
      try {
        await fetch(
          buildSignedTelnyxWebhook(keys, event, { url: webhookEndpoint })
        );
      } catch {
        // A consequence webhook that lands after teardown is harmless.
      }
    },
  });

  const telnyxAdapter = createTelnyxAdapter({
    apiBaseUrl: api.baseUrl,
    apiKey: API_KEY,
    publicKey: keys.publicKey,
    mediaUrl: `ws://127.0.0.1:${port}${MEDIA_PATH}`,
    mediaPath: MEDIA_PATH,
  });

  const call = new Call({
    adapters: { telnyx: telnyxAdapter },
    logger: "silent",
  });
  call.onIncomingCall((incoming) => incoming.stream());
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
        const response = await call.webhooks.telnyx(request);
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
      call.media.telnyx(ws);
    });
  });

  const stop = async (): Promise<void> => {
    await call.shutdown();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await api.close();
  };

  return { harness: { baseUrl, call, keys, api }, stop };
}

describe("Telnyx adapter mini integration", () => {
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
    const fake = await startFakeTelnyxCall({
      api: harness.api,
      keys: harness.keys,
      webhookUrl: `${harness.baseUrl}${WEBHOOK_PATH}`,
      callControlId: "telnyx-badsig",
      invalidSignature: true,
    });
    expect(fake.webhookResponse.status).toBe(403);
    expect(fake.connected).toBe(false);
    expect(harness.api.commandsFor("telnyx-badsig")).toHaveLength(0);
  });

  it("drives a full duplex turn: inbound L16 normalizes to frames, outbound frames + mark reach the wire, mark echoes back", async () => {
    const callControlId = "telnyx-fullloop";
    const fake = await startFakeTelnyxCall({
      api: harness.api,
      keys: harness.keys,
      webhookUrl: `${harness.baseUrl}${WEBHOOK_PATH}`,
      callControlId,
    });
    expect(fake.webhookResponse.status).toBe(200);
    expect(fake.connected).toBe(true);

    const session = await waitForSession(
      harness.call,
      `telnyx:${callControlId}`
    );
    const recorded = recordEvents(session.bus);

    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 200, kind: "silence" });

    // Inbound L16 was normalized and delivered as canonical PCM16 frames.
    const inbound = recorded.of("audio-frame");
    expect(inbound.length).toBeGreaterThan(0);
    for (const { frame } of inbound) {
      expect(frame).toBeCanonicalFrame();
    }

    // caller silence -> end-of-turn -> the inline agent writes outbound frames
    // + a mark, which de-normalize back onto the wire.
    await fake.waitFor((r) => r.mediaMs > 0, 3000);
    await fake.waitFor((r) => r.marks.includes("utt-1"), 3000);

    // The fake echoes the mark back once its simulated playback window elapses;
    // the adapter surfaces it as `audio-mark`.
    await fake.waitFor(() => recorded.of("audio-mark").length > 0, 3000);
    expect(recorded.of("audio-mark")[0].name).toBe("utt-1");

    await fake.hangup();
    await session.ended;
    expect(recorded).toHaveEndedOnce();
  }, 15_000);

  it("barge-in: caller speech while the agent is talking clears playback exactly once and stops further audio", async () => {
    const callControlId = "telnyx-bargein";
    const fake = await startFakeTelnyxCall({
      api: harness.api,
      keys: harness.keys,
      webhookUrl: `${harness.baseUrl}${WEBHOOK_PATH}`,
      callControlId,
    });
    await waitForSession(harness.call, `telnyx:${callControlId}`);

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
  }, 15_000);

  it("tears down with exactly one call-ended event on a provider-initiated hangup", async () => {
    const callControlId = "telnyx-hangup";
    const fake = await startFakeTelnyxCall({
      api: harness.api,
      keys: harness.keys,
      webhookUrl: `${harness.baseUrl}${WEBHOOK_PATH}`,
      callControlId,
    });
    const session = await waitForSession(
      harness.call,
      `telnyx:${callControlId}`
    );
    const recorded = recordEvents(session.bus);

    // `hangup()` sends `stop` then closes the socket (a normal provider hangup).
    await fake.hangup();
    await session.ended;
    await fake.closed;

    expect(recorded).toHaveEndedOnce();
    // A second, redundant teardown attempt must not double the event.
    await session.end("local-end");
    expect(recorded).toHaveEndedOnce();
  });

  it("a PCMU@8k call still yields canonical frames — the decode matrix works end-to-end", async () => {
    const callControlId = "telnyx-pcmu";
    const fake = await startFakeTelnyxCall({
      api: harness.api,
      keys: harness.keys,
      webhookUrl: `${harness.baseUrl}${WEBHOOK_PATH}`,
      callControlId,
      codec: "PCMU",
    });
    expect(fake.connected).toBe(true);

    const session = await waitForSession(
      harness.call,
      `telnyx:${callControlId}`
    );
    const recorded = recordEvents(session.bus);

    await fake.speak({ ms: 300, kind: "tone" });
    await fake.speak({ ms: 100, kind: "silence" });

    const inbound = recorded.of("audio-frame");
    expect(inbound.length).toBeGreaterThan(0);
    for (const { frame } of inbound) {
      // PCMU@8k -> µ-law decode -> ×2 upsample -> canonical 320-sample frames.
      expect(frame).toBeCanonicalFrame();
    }

    await fake.hangup();
  }, 15_000);
});

describe("Telnyx adapter contract", () => {
  // `adapterContract` opens a session via `opts.openSession` and drives
  // teardown/no-op-after-end assertions generically. The adapter's `media()`
  // state machine only needs a structural `MediaSocket`, so we hand it a
  // minimal hand-rolled fake rather than a real `ws`/HTTP round trip — session
  // creation only depends on a `start` message reaching `media()`.
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

  adapterContract("telnyx", () => createTelnyxAdapter(), {
    openSession: (_call, adapter) => {
      counter += 1;
      const callId = `telnyx-contract-${counter}`;
      const socket = makeFakeSocket();
      (adapter as TelnyxAdapter).media(socket as unknown as MediaSocket);
      socket.emitMessage(
        JSON.stringify({
          event: "start",
          stream_id: "fake-stream-contract",
          start: {
            call_control_id: callId,
            from: "+15550001111",
            to: "+15550002222",
            media_format: {
              encoding: "L16",
              sample_rate: 16_000,
              channels: 1,
            },
          },
        })
      );
      return Promise.resolve({
        sessionId: `telnyx:${callId}`,
        endFromProvider: () => socket.emitClose(),
      });
    },
  });
});

describe("Telnyx routing contract", () => {
  // The third adapter duty, asserted provider-agnostically by the kit and
  // provider-specifically here: each verb decision must come back as the exact
  // Call Control command Telnyx speaks. Telnyx acks the webhook with a bare
  // 200 (uninformative), so each verb's assertion closes over the fake API's
  // recorded commands. A fresh call-control id per request isolates each test's
  // commands; without a `webhookSink` no consequence flows, so only the FIRST
  // command lands — the documented fallback the "routing sequences" describe
  // below then extends to the full multi-step chain.
  let api: FakeTelnyxApi;
  const keys = createFakeTelnyxKeys();
  let requestCounter = 0;
  let currentCcid = "";

  beforeEach(async () => {
    api = await startFakeTelnyxApi();
  });

  afterEach(async () => {
    await api.close();
  });

  const makeAdapter = () =>
    createTelnyxAdapter({
      apiBaseUrl: api.baseUrl,
      apiKey: API_KEY,
      publicKey: keys.publicKey,
      mediaUrl: "wss://media.example.com/telnyx/media",
    });

  function makeInboundRequest(): Request {
    requestCounter += 1;
    currentCcid = `telnyx-route-${requestCounter}`;
    return buildSignedTelnyxWebhook(keys, {
      event_type: "call.initiated",
      payload: {
        call_control_id: currentCcid,
        from: "+15550001111",
        to: "+15550002222",
        direction: "incoming",
        state: "parked",
      },
    });
  }

  const commandFor = (predicate: (c: RecordedCommand) => boolean) =>
    api.waitForCommand((c) => c.ccid === currentCcid && predicate(c));

  routingContract("telnyx", makeAdapter, {
    makeInboundRequest,
    expectTranslated: {
      reject: async () => {
        const cmd = await commandFor((c) => c.command === "reject");
        expect(cmd.body.cause).toBe("CALL_REJECTED");
      },
      forward: async () => {
        const cmd = await commandFor((c) => c.command === "answer");
        expect(cmd.body.stream_url).toBeUndefined();
        const state = decodeTelnyxClientState(
          cmd.body.client_state as string
        ) as { mode: string; q: unknown[] };
        expect(state.mode).toBe("sequence");
        expect(state.q).toMatchObject([
          { type: "forward", to: ["+15550001111"] },
        ]);
      },
      forwardMultiple: async () => {
        const cmd = await commandFor((c) => c.command === "answer");
        expect(cmd.body.stream_url).toBeUndefined();
        const state = decodeTelnyxClientState(
          cmd.body.client_state as string
        ) as { mode: string; q: unknown[] };
        expect(state.mode).toBe("sequence");
        expect(state.q).toMatchObject([
          { type: "forward", to: ["+15550001111", "+15550003333"] },
        ]);
      },
      say: async () => {
        const cmd = await commandFor((c) => c.command === "answer");
        expect(cmd.body.stream_url).toBeUndefined();
        const state = decodeTelnyxClientState(
          cmd.body.client_state as string
        ) as { q: unknown[] };
        expect(state.q).toMatchObject([
          { type: "say", text: "hello" },
          { type: "hangup" },
        ]);
      },
      play: async () => {
        const cmd = await commandFor((c) => c.command === "answer");
        expect(cmd.body.stream_url).toBeUndefined();
        const state = decodeTelnyxClientState(
          cmd.body.client_state as string
        ) as { q: unknown[] };
        expect(state.q).toMatchObject([
          { type: "play", url: "https://example.com/a.mp3" },
          { type: "hangup" },
        ]);
      },
      voicemail: async () => {
        const cmd = await commandFor((c) => c.command === "answer");
        expect(cmd.body.stream_url).toBeUndefined();
        const state = decodeTelnyxClientState(
          cmd.body.client_state as string
        ) as { q: unknown[] };
        expect(state.q).toMatchObject([
          { type: "say", text: "leave a message" },
          { type: "record", maxLengthSeconds: 120, playBeep: true },
          { type: "hangup" },
        ]);
      },
      hangup: async () => {
        const cmd = await commandFor((c) => c.command === "hangup");
        expect(cmd.command).toBe("hangup");
      },
      stream: async () => {
        const cmd = await commandFor((c) => c.command === "answer");
        expect(cmd.body.stream_url).toBeTruthy();
        expect(cmd.body.stream_bidirectional_mode).toBe("rtp");
        expect(cmd.body.stream_codec).toBe("L16");
        expect(cmd.body.stream_bidirectional_sampling_rate).toBe(16_000);
        const state = decodeTelnyxClientState(
          cmd.body.client_state as string
        ) as { mode: string };
        expect(state.mode).toBe("stream");
      },
    },
  });
});

describe("Telnyx routing sequences", () => {
  // Closes the gap the routing-contract fallback leaves: here we own the
  // `Call`, so the fake API's `webhookSink` delivers each consequence webhook
  // straight into `call.webhooks.telnyx`, driving a verb's COMPLETE command
  // chain (answer -> speak -> hangup, etc.) with `client_state` threading.
  const keys = createFakeTelnyxKeys();
  let api: FakeTelnyxApi;
  let call: Call;

  afterEach(async () => {
    await call?.shutdown();
    await api?.close();
  });

  async function setup(
    route: Parameters<Call["onIncomingCall"]>[0],
    config: { connectionId?: string; phoneNumber?: string } = {}
  ): Promise<void> {
    api = await startFakeTelnyxApi({
      webhookSink: async (event: TelnyxWebhookEvent) => {
        try {
          await call.webhooks.telnyx(buildSignedTelnyxWebhook(keys, event));
        } catch {
          // Consequences that land after teardown are harmless.
        }
      },
    });
    const adapter = createTelnyxAdapter({
      apiBaseUrl: api.baseUrl,
      apiKey: API_KEY,
      publicKey: keys.publicKey,
      mediaUrl: "wss://media.example.com/telnyx/media",
      ...config,
    });
    call = new Call({ adapters: { telnyx: adapter }, logger: "silent" });
    call.onIncomingCall(route);
  }

  async function deliverInitiated(ccid: string): Promise<void> {
    await call.webhooks.telnyx(
      buildSignedTelnyxWebhook(keys, {
        event_type: "call.initiated",
        payload: {
          call_control_id: ccid,
          from: "+15550001111",
          to: "+15550002222",
          direction: "incoming",
        },
      })
    );
  }

  async function pollUntil(
    pred: () => boolean,
    timeoutMs = 2000
  ): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("pollUntil: condition not met in time");
      }
      await delay(10);
    }
  }

  it("say drives the full answer -> speak -> hangup chain with a decreasing client_state queue and distinct command ids", async () => {
    await setup((incoming) => incoming.say("hello"));
    const ccid = "seq-say";
    await deliverInitiated(ccid);

    await api.waitForCommand((c) => c.ccid === ccid && c.command === "hangup");
    const cmds = api.commandsFor(ccid);
    expect(cmds.map((c) => c.command)).toEqual(["answer", "speak", "hangup"]);

    // `client_state` threads a shrinking queue through each step.
    expect(cmds.map(queueLength)).toEqual([2, 1, 0]);

    // Each step's `command_id` is a distinct, deterministic id.
    const ids = cmds.map((c) => c.body.command_id);
    expect(ids).toEqual([
      telnyxCommandId(ccid, 1),
      telnyxCommandId(ccid, 2),
      telnyxCommandId(ccid, 3),
    ]);
    expect(new Set(ids).size).toBe(3);
  });

  it("voicemail drives answer -> speak -> record_start(play_beep, max_length) -> hangup", async () => {
    await setup((incoming) =>
      incoming.voicemail({ prompt: "leave a message" })
    );
    const ccid = "seq-vm";
    await deliverInitiated(ccid);

    await api.waitForCommand((c) => c.ccid === ccid && c.command === "hangup");
    const cmds = api.commandsFor(ccid);
    expect(cmds.map((c) => c.command)).toEqual([
      "answer",
      "speak",
      "record_start",
      "hangup",
    ]);

    const record = cmds.find((c) => c.command === "record_start");
    expect(record?.body.play_beep).toBe(true);
    expect(record?.body.max_length).toBe(120);

    expect(cmds.map(queueLength)).toEqual([3, 2, 1, 0]);
    const ids = cmds.map((c) => c.body.command_id);
    expect(new Set(ids).size).toBe(4);
  });

  it("multi-number forward: answer -> one linked dial ringing every destination, no parent hangup when a leg wins", async () => {
    await setup(
      (incoming) => incoming.forwardTo(["+15550003333", "+15550004444"]),
      { connectionId: "conn-test", phoneNumber: "+15559990000" }
    );
    const parent = "seq-fwd-multi";
    await deliverInitiated(parent);

    // The parent's `call.answered` consequence pops the forward: one create
    // dialing BOTH destinations, linked to the parent for bridge-on-answer.
    const create = await api.waitForCommand((c) => c.command === "create");
    expect(create.body.to).toEqual(["+15550003333", "+15550004444"]);
    expect(create.body.link_to).toBe(parent);
    expect(create.body.bridge_intent).toBe(true);
    expect(create.body.bridge_on_answer).toBe(true);
    expect(create.body.from).toBe("+15559990000");
    expect(create.body.connection_id).toBe("conn-test");
    const legState = decodeTelnyxClientState(
      create.body.client_state as string
    ) as { mode: string; parent: string };
    expect(legState.mode).toBe("forward-leg");
    expect(legState.parent).toBe(parent);

    // A leg answers (Telnyx bridges it itself), a sibling is canceled, then
    // the bridged conversation ends normally — none of these may hang the
    // parent up out from under the connected call.
    for (const [eventType, cause] of [
      ["call.answered", undefined],
      ["call.hangup", "originator_cancel"],
      ["call.hangup", "normal_clearing"],
    ] as const) {
      await call.webhooks.telnyx(
        buildSignedTelnyxWebhook(keys, {
          event_type: eventType,
          payload: {
            call_control_id: create.ccid,
            client_state: create.body.client_state,
            ...(cause === undefined ? {} : { hangup_cause: cause }),
          },
        })
      );
    }
    await delay(50);
    expect(api.commandsFor(parent).map((c) => c.command)).toEqual(["answer"]);
  });

  it("multi-number forward: a leg dying with no answer hangs the parent up (no dead air)", async () => {
    await setup(
      (incoming) => incoming.forwardTo(["+15550003333", "+15550004444"]),
      { connectionId: "conn-test", phoneNumber: "+15559990000" }
    );
    const parent = "seq-fwd-timeout";
    await deliverInitiated(parent);
    const create = await api.waitForCommand((c) => c.command === "create");

    await call.webhooks.telnyx(
      buildSignedTelnyxWebhook(keys, {
        event_type: "call.hangup",
        payload: {
          call_control_id: create.ccid,
          client_state: create.body.client_state,
          hangup_cause: "timeout",
        },
      })
    );
    await api.waitForCommand(
      (c) => c.ccid === parent && c.command === "hangup"
    );
  });

  it("a duplicate consequence webhook recomputes the identical command_id rather than appending a distinct command", async () => {
    await setup((incoming) => incoming.say("hello"));
    const ccid = "seq-dup";
    await deliverInitiated(ccid);
    await api.waitForCommand((c) => c.ccid === ccid && c.command === "hangup");

    const speak = api.commandsFor(ccid).find((c) => c.command === "speak");
    const firstHangup = api
      .commandsFor(ccid)
      .find((c) => c.command === "hangup");

    // Redeliver the SAME `call.speak.ended` (Telnyx's at-least-once delivery):
    // the sequencer recomputes the identical `hangup` at the same step, so its
    // `command_id` matches — dedupe is Telnyx-side, so the fake still appends.
    await call.webhooks.telnyx(
      buildSignedTelnyxWebhook(keys, {
        event_type: "call.speak.ended",
        payload: {
          call_control_id: ccid,
          client_state: speak?.body.client_state,
        },
      })
    );

    await pollUntil(
      () =>
        api.commandsFor(ccid).filter((c) => c.command === "hangup").length === 2
    );
    const hangups = api.commandsFor(ccid).filter((c) => c.command === "hangup");
    expect(hangups).toHaveLength(2);
    expect(hangups[1].body.command_id).toBe(firstHangup?.body.command_id);
  });
});
