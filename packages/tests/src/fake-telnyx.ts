/**
 * A protocol-accurate fake Telnyx *client* — the counterpart to a
 * `@call-adapter/telnyx` server-side adapter, used to drive an adapter (or a
 * full `Call`) end-to-end in tests without a real Telnyx account. It mirrors
 * {@link ./fake-twilio} in role and shape, adapted to Telnyx Call Control v2's
 * asynchronous command/consequence-webhook model.
 *
 * This module intentionally does **not** import the Telnyx adapter package:
 * `@call-adapter/tests` stays adapter-independent (mirroring how the
 * conformance kit and mock adapter are provider-agnostic), so Telnyx's
 * Ed25519 webhook-signing scheme and media-WS protocol are reproduced here
 * rather than imported.
 *
 * Unlike Twilio (which answers the inbound webhook synchronously with TwiML),
 * Telnyx acks the webhook with a bare 200 and issues call-control commands
 * asynchronously as `POST {apiBaseUrl}/v2/calls/{ccid}/actions/{command}`.
 * {@link startFakeTelnyxApi} stands in for Telnyx's REST API (recording those
 * commands and emitting the consequence webhooks that drive multi-step verbs),
 * and {@link startFakeTelnyxCall} drives a full inbound call: sign + POST
 * `call.initiated`, inspect the commands the adapter issued, and — if it
 * answered with inline stream params — open the media WebSocket and speak the
 * Telnyx media wire protocol.
 */

import { sign as edSign, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { int16ToBytes, mulawEncode } from "call-sdk";
import WebSocket from "ws";

const FRAME_MS = 20;
const INT16_MAX = 32_767;
const DEFAULT_WEBHOOK_URL = "http://fake-telnyx.local/telnyx/webhook";
const DEFAULT_WAIT_TIMEOUT_MS = 2000;
const WAIT_POLL_INTERVAL_MS = 10;

/** Per-codec media-plane parameters (canonical L16@16k default, or PCMU@8k). */
const CODEC_PARAMS = {
  L16: {
    encoding: "L16",
    sampleRate: 16_000,
    bytesPerMs: 32,
    samplesPerFrame: 320,
  },
  PCMU: {
    encoding: "PCMU",
    sampleRate: 8000,
    bytesPerMs: 8,
    samplesPerFrame: 160,
  },
} as const;

export type TelnyxCodec = keyof typeof CODEC_PARAMS;

function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

// ---------------------------------------------------------------------------
// 1. Keypair + signing helpers
// ---------------------------------------------------------------------------

export interface FakeTelnyxKeys {
  /** Base64 of the raw 32-byte Ed25519 public key, as Telnyx distributes it. */
  readonly publicKey: string;
  /** Signs `${timestamp}|${rawBody}` with the private key → base64 signature. */
  sign(timestamp: string, rawBody: string): string;
}

/**
 * Generates a fresh Ed25519 keypair and returns Telnyx-shaped signing helpers.
 * The public key is the base64 of the raw 32 key bytes (extracted from the
 * SPKI DER encoding), matching how Telnyx publishes verification keys. This is
 * an independent reimplementation of the adapter's verification scheme — the
 * adapter is deliberately not imported.
 */
export function createFakeTelnyxKeys(): FakeTelnyxKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  return {
    publicKey: Buffer.from(raw).toString("base64"),
    sign(timestamp: string, rawBody: string): string {
      return edSign(
        null,
        Buffer.from(`${timestamp}|${rawBody}`),
        privateKey
      ).toString("base64");
    },
  };
}

export interface TelnyxWebhookEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

interface SignedTelnyxParts {
  rawBody: string;
  signature: string;
  timestamp: string;
}

function signTelnyxWebhook(
  keys: FakeTelnyxKeys,
  event: TelnyxWebhookEvent,
  opts: { timestamp?: string } = {}
): SignedTelnyxParts {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const rawBody = JSON.stringify({
    data: {
      event_type: event.event_type,
      payload: event.payload,
      record_type: "event",
    },
  });
  return { rawBody, signature: keys.sign(timestamp, rawBody), timestamp };
}

/**
 * Builds a signed inbound Telnyx webhook `Request`: JSON body
 * `{data: {event_type, payload, record_type: "event"}}` with a
 * `content-type: application/json` header plus the two Ed25519 signature
 * headers (`telnyx-signature-ed25519`, `telnyx-timestamp`).
 */
export function buildSignedTelnyxWebhook(
  keys: FakeTelnyxKeys,
  event: TelnyxWebhookEvent,
  opts: { url?: string; timestamp?: string } = {}
): Request {
  const { rawBody, signature, timestamp } = signTelnyxWebhook(keys, event, {
    ...(opts.timestamp === undefined ? {} : { timestamp: opts.timestamp }),
  });
  return new Request(opts.url ?? DEFAULT_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": signature,
      "telnyx-timestamp": timestamp,
    },
    body: rawBody,
  });
}

// ---------------------------------------------------------------------------
// 2. Fake Telnyx REST server
// ---------------------------------------------------------------------------

/** One command the adapter under test issued against the fake REST API. */
export interface RecordedCommand {
  body: Record<string, unknown>;
  ccid: string;
  command: string;
}

export interface FakeTelnyxApi {
  /** Base URL to hand the adapter as its `apiBaseUrl` (e.g. `http://127.0.0.1:PORT`). */
  readonly baseUrl: string;
  /** Shuts the HTTP server down. */
  close(): Promise<void>;
  /** Every command recorded so far, in the order received. */
  readonly commands: readonly RecordedCommand[];
  /** The subset of {@link commands} issued against a given call-control id. */
  commandsFor(ccid: string): RecordedCommand[];
  /** Polls `pred` over recorded commands every 10ms until one matches or `timeoutMs` elapses. */
  waitForCommand(
    pred: (command: RecordedCommand) => boolean,
    timeoutMs?: number
  ): Promise<RecordedCommand>;
}

export interface StartFakeTelnyxApiOptions {
  /** Invoked synchronously as each command is recorded. */
  onCommand?: (command: RecordedCommand) => void;
  /**
   * Emits consequence webhooks back to the adapter. Wire this to a function
   * that signs and delivers the event to the adapter's webhook handler so
   * multi-step verbs (speak → speak.ended, etc.) advance.
   */
  webhookSink?: (event: TelnyxWebhookEvent) => Promise<void> | void;
}

/**
 * Maps a recorded command to the consequence `event_type` that advances it.
 * `*.ended`/`*.saved`/`hangup` events are what drive sequencing; `create` has
 * no consequence webhook here (outbound is not modeled by the inbound driver).
 */
const CONSEQUENCE_EVENT: Record<string, string | undefined> = {
  answer: "call.answered",
  speak: "call.speak.ended",
  playback_start: "call.playback.ended",
  record_start: "call.recording.saved",
  reject: "call.hangup",
  hangup: "call.hangup",
  transfer: "call.hangup",
};

const ACTION_ROUTE_RE = /^\/v2\/calls\/([^/]+)\/actions\/([^/]+)$/;
const CREATE_ROUTE_RE = /^\/v2\/calls\/?$/;
const HTTP_SCHEME_RE = /^http/i;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(raw: string): Record<string, unknown> {
  if (raw.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function startFakeTelnyxApi(
  opts: StartFakeTelnyxApiOptions = {}
): Promise<FakeTelnyxApi> {
  const commands: RecordedCommand[] = [];
  let createCounter = 0;

  const emitConsequence = async (command: RecordedCommand): Promise<void> => {
    const eventType = CONSEQUENCE_EVENT[command.command];
    if (!(eventType && opts.webhookSink)) {
      return;
    }
    const payload: Record<string, unknown> = {
      call_control_id: command.ccid,
    };
    // Echo the command's `client_state` back on the consequence webhook — the
    // adapter threads it through every command and Telnyx returns it verbatim.
    if (typeof command.body.client_state === "string") {
      payload.client_state = command.body.client_state;
    }
    await opts.webhookSink({ event_type: eventType, payload });
  };

  const scheduleConsequence = (command: RecordedCommand): void => {
    // `speak` reports completion a macrotask later (mirroring the real
    // speak.started → speak.ended gap); other events fire on the next
    // microtask, after the command's own 200 has flushed.
    if (command.command === "speak") {
      setTimeout(() => void emitConsequence(command), 0);
    } else {
      queueMicrotask(() => void emitConsequence(command));
    }
  };

  const record = (command: RecordedCommand): void => {
    commands.push(command);
    opts.onCommand?.(command);
    scheduleConsequence(command);
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    const rawBody = await readBody(req);

    if (req.method === "POST") {
      const actionMatch = path.match(ACTION_ROUTE_RE);
      if (actionMatch) {
        const [, ccid, command] = actionMatch;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { result: "ok" } }));
        record({ ccid, command, body: parseJsonBody(rawBody) });
        return;
      }
      if (CREATE_ROUTE_RE.test(path)) {
        const n = ++createCounter;
        const ccid = `fake-ccid-${n}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              call_control_id: ccid,
              call_leg_id: `fake-leg-${n}`,
              call_session_id: `fake-session-${n}`,
            },
          })
        );
        record({ ccid, command: "create", body: parseJsonBody(rawBody) });
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ detail: "not found" }] }));
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  return new Promise<FakeTelnyxApi>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${port}`;

      const waitForCommand = async (
        pred: (command: RecordedCommand) => boolean,
        timeoutMs = DEFAULT_WAIT_TIMEOUT_MS
      ): Promise<RecordedCommand> => {
        const start = Date.now();
        for (;;) {
          const found = commands.find(pred);
          if (found) {
            return found;
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error(
              `FakeTelnyxApi.waitForCommand: no matching command within ${timeoutMs}ms ` +
                `(recorded: ${commands.map((c) => `${c.command}@${c.ccid}`).join(", ") || "none"})`
            );
          }
          await delay(WAIT_POLL_INTERVAL_MS);
        }
      };

      resolve({
        baseUrl,
        commands,
        commandsFor: (ccid) => commands.filter((c) => c.ccid === ccid),
        waitForCommand,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 3. startFakeTelnyxCall — the full inbound driver
// ---------------------------------------------------------------------------

/** base64→JSON.parse of a Telnyx `client_state`, or `undefined` if it isn't valid. */
export function decodeTelnyxClientState(s: string): unknown {
  try {
    return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return;
  }
}

/** Everything the adapter under test has sent back over the media socket so far. */
export interface FakeTelnyxReceived {
  clears: number;
  marks: string[];
  /** Total duration (ms) of media audio received: `payload bytes / bytesPerMs` for the codec. */
  mediaMs: number;
  /** Raw base64 media payloads, in receive order. */
  payloads: string[];
}

export interface FakeTelnyxCallOptions {
  /** Caller-created fake REST API (so its `baseUrl` can be the adapter's `apiBaseUrl` before construction). */
  api: FakeTelnyxApi;
  /** Overrides the generated inbound call-control id. */
  callControlId?: string;
  /** Media codec the adapter answered with. Default `"L16"` (canonical 16kHz PCM). */
  codec?: TelnyxCodec;
  from?: string;
  /** Corrupt the signature to exercise the adapter's rejection path. */
  invalidSignature?: boolean;
  /** Signing keys; defaults to a fresh {@link createFakeTelnyxKeys}. */
  keys?: FakeTelnyxKeys;
  to?: string;
  /** A webhook handler function to invoke directly (fetch-style). Mutually exclusive with `webhookUrl`. */
  webhook?: (req: Request) => Promise<Response>;
  /** A URL to POST the signed webhook to. Mutually exclusive with `webhook`. */
  webhookUrl?: string;
}

export interface FakeTelnyxCall {
  readonly callControlId: string;
  /** Drops the media WebSocket without sending `stop` (simulates a dropped connection). */
  close(): void;
  /** Resolves once the media WebSocket has closed (already resolved for control-plane-only calls). */
  readonly closed: Promise<void>;
  /**
   * `true` iff the adapter answered with inline stream params (media plane).
   * `false` for a control-plane-only outcome (reject/transfer/hangup, or an
   * answer without `stream_url`) — no WebSocket is opened and the media
   * methods are no-ops.
   */
  readonly connected: boolean;
  /** Sends `stop`, then closes the socket (a normal hangup). */
  hangup(): Promise<void>;
  readonly received: FakeTelnyxReceived;
  /** Sends `{event:"stop"}` without closing the socket. */
  sendStop(): void;
  /**
   * Sends `ms` worth of paced, real-time 20ms media frames as inbound caller
   * audio, encoded for the negotiated codec (L16 = 640-byte PCM16 frames @
   * 16kHz; PCMU = 160-byte μ-law frames @ 8kHz).
   */
  speak(input: {
    hz?: number;
    kind: "tone" | "silence";
    ms: number;
  }): Promise<void>;
  /** Polls `pred(received)` every 10ms until it's true or `timeoutMs` elapses. */
  waitFor(
    pred: (received: FakeTelnyxReceived) => boolean,
    timeoutMs?: number
  ): Promise<void>;
  /** The raw inbound-webhook HTTP response — inspect to assert rejection (401, etc). */
  readonly webhookResponse: { body: string; status: number };
}

function toneSamples(
  count: number,
  hz: number,
  startSampleIndex: number,
  sampleRate: number
): Int16Array {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const n = startSampleIndex + i;
    const value = 0.5 * Math.sin((2 * Math.PI * hz * n) / sampleRate);
    samples[i] = Math.round(value * INT16_MAX);
  }
  return samples;
}

function corruptSignature(signature: string): string {
  const first = signature.charAt(0) === "A" ? "B" : "A";
  return first + signature.slice(1);
}

function makeWaitFor(received: FakeTelnyxReceived) {
  return async (
    pred: (r: FakeTelnyxReceived) => boolean,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS
  ): Promise<void> => {
    const start = Date.now();
    while (!pred(received)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `FakeTelnyxCall.waitFor: condition not met within ${timeoutMs}ms ` +
            `(received: mediaMs=${received.mediaMs}, marks=${JSON.stringify(received.marks)}, clears=${received.clears}, payloads=${received.payloads.length})`
        );
      }
      await delay(WAIT_POLL_INTERVAL_MS);
    }
  };
}

/**
 * Drives a full fake inbound Telnyx call: signs and delivers the
 * `call.initiated` webhook, inspects the commands the adapter issued in
 * response, and — if it answered with inline stream params — connects the
 * media WebSocket and speaks the Telnyx media wire protocol. Otherwise returns
 * a control-plane-only stub whose media methods are no-ops.
 */
export async function startFakeTelnyxCall(
  opts: FakeTelnyxCallOptions
): Promise<FakeTelnyxCall> {
  const keys = opts.keys ?? createFakeTelnyxKeys();
  const codec = opts.codec ?? "L16";
  const params = CODEC_PARAMS[codec];
  const from = opts.from ?? "+15550001111";
  const to = opts.to ?? "+15550002222";
  const callControlId = opts.callControlId ?? `fake-ccid-${randomHex(16)}`;

  const initiated: TelnyxWebhookEvent = {
    event_type: "call.initiated",
    payload: {
      call_control_id: callControlId,
      call_session_id: `fake-session-${randomHex(12)}`,
      call_leg_id: `fake-leg-${randomHex(12)}`,
      connection_id: `fake-conn-${randomHex(10)}`,
      from,
      to,
      direction: "incoming",
      state: "parked",
    },
  };

  const { rawBody, signature, timestamp } = signTelnyxWebhook(keys, initiated);
  const wireSignature = opts.invalidSignature
    ? corruptSignature(signature)
    : signature;
  const headers = {
    "content-type": "application/json",
    "telnyx-signature-ed25519": wireSignature,
    "telnyx-timestamp": timestamp,
  };

  let webhookResponse: { body: string; status: number };
  if (opts.webhookUrl) {
    const res = await fetch(opts.webhookUrl, {
      method: "POST",
      headers,
      body: rawBody,
    });
    webhookResponse = { status: res.status, body: await res.text() };
  } else if (opts.webhook) {
    const res = await opts.webhook(
      new Request(DEFAULT_WEBHOOK_URL, {
        method: "POST",
        headers,
        body: rawBody,
      })
    );
    webhookResponse = { status: res.status, body: await res.text() };
  } else {
    throw new Error(
      "startFakeTelnyxCall: provide either `webhookUrl` or `webhook`."
    );
  }

  const received: FakeTelnyxReceived = {
    mediaMs: 0,
    payloads: [],
    marks: [],
    clears: 0,
  };
  const waitFor = makeWaitFor(received);

  const controlPlaneStub = (): FakeTelnyxCall => ({
    callControlId,
    connected: false,
    webhookResponse,
    received,
    waitFor,
    speak: () => Promise.resolve(),
    sendStop: () => {
      // no-op: no media socket was ever opened
    },
    hangup: () => Promise.resolve(),
    close: () => {
      // no-op: no media socket was ever opened
    },
    closed: Promise.resolve(),
  });

  // The adapter issues commands (answer/reject/...) before it acks; give the
  // first one a beat to land, then decide media-plane vs control-plane.
  try {
    await opts.api.waitForCommand((c) => c.ccid === callControlId, 1000);
  } catch {
    // No command for this call — treat as control-plane-only.
    return controlPlaneStub();
  }

  const answer = opts.api
    .commandsFor(callControlId)
    .find((c) => c.command === "answer");
  const streamUrl =
    typeof answer?.body.stream_url === "string"
      ? answer.body.stream_url
      : undefined;
  if (!streamUrl) {
    return controlPlaneStub();
  }

  const clientState =
    typeof answer?.body.client_state === "string"
      ? answer.body.client_state
      : undefined;

  // Media plane: connect to the adapter's media WS as Telnyx would.
  const wsUrl = streamUrl.replace(HTTP_SCHEME_RE, "ws");
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  ws.on("close", () => resolveClosed());

  let sampleCursor = 0;
  // Tracks the `received.mediaMs` checkpoint as of the last mark, so an echo
  // waits out only the audio queued *since* that checkpoint (see `clear`).
  let markCheckpointMs = 0;
  const pendingMarkTimers = new Set<ReturnType<typeof setTimeout>>();

  const send = (message: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  send({ event: "connected" });
  send({
    event: "start",
    stream_id: "fake-stream-1",
    start: {
      call_control_id: callControlId,
      ...(clientState === undefined ? {} : { client_state: clientState }),
      from,
      to,
      media_format: {
        encoding: params.encoding,
        sample_rate: params.sampleRate,
        channels: 1,
      },
    },
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || !("event" in parsed)) {
      return;
    }
    const message = parsed as {
      event: unknown;
      media?: { payload?: unknown };
      mark?: { name?: unknown };
    };

    if (message.event === "media") {
      const payload = message.media?.payload;
      if (typeof payload !== "string") {
        return;
      }
      received.payloads.push(payload);
      received.mediaMs +=
        Buffer.from(payload, "base64").length / params.bytesPerMs;
      return;
    }

    if (message.event === "mark") {
      const name = message.mark?.name;
      if (typeof name !== "string") {
        return;
      }
      received.marks.push(name);
      const delayMs = Math.max(0, received.mediaMs - markCheckpointMs);
      markCheckpointMs = received.mediaMs;
      const timer = setTimeout(() => {
        pendingMarkTimers.delete(timer);
        send({ event: "mark", stream_id: "fake-stream-1", mark: { name } });
      }, delayMs);
      pendingMarkTimers.add(timer);
      return;
    }

    if (message.event === "clear") {
      received.clears += 1;
      // The adapter flushed its outbound buffer: audio queued since the last
      // mark checkpoint will never "play", so cancel pending echoes and reset
      // the checkpoint to now.
      for (const timer of pendingMarkTimers) {
        clearTimeout(timer);
      }
      pendingMarkTimers.clear();
      markCheckpointMs = received.mediaMs;
    }
  });

  const speak = async (input: {
    hz?: number;
    kind: "tone" | "silence";
    ms: number;
  }): Promise<void> => {
    const frameCount = Math.max(0, Math.round(input.ms / FRAME_MS));
    for (let i = 0; i < frameCount; i++) {
      let bytes: Uint8Array;
      if (input.kind === "silence") {
        bytes =
          codec === "PCMU"
            ? new Uint8Array(params.samplesPerFrame).fill(0xff)
            : new Uint8Array(params.samplesPerFrame * 2);
      } else {
        const samples = toneSamples(
          params.samplesPerFrame,
          input.hz ?? 440,
          sampleCursor,
          params.sampleRate
        );
        bytes = codec === "PCMU" ? mulawEncode(samples) : int16ToBytes(samples);
      }
      sampleCursor += params.samplesPerFrame;
      send({
        event: "media",
        media: { payload: Buffer.from(bytes).toString("base64") },
      });
      await delay(FRAME_MS);
    }
  };

  const sendStop = (): void => {
    send({ event: "stop" });
  };

  const close = (): void => {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }
  };

  const hangup = async (): Promise<void> => {
    sendStop();
    close();
    await closed;
  };

  return {
    callControlId,
    connected: true,
    webhookResponse,
    received,
    speak,
    waitFor,
    sendStop,
    hangup,
    close,
    closed,
  };
}
