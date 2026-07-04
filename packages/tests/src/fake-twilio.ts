/**
 * A protocol-accurate fake Twilio *client* — the counterpart to
 * `@call-adapter/twilio`'s server-side adapter, used to drive an adapter (or
 * a full `Call`) end-to-end in tests without a real Twilio account.
 *
 * This module intentionally does **not** import `@call-adapter/twilio`:
 * `@call-adapter/tests` stays adapter-independent (mirroring how the
 * conformance kit and mock adapter are provider-agnostic), so the Twilio
 * request-signing algorithm is reproduced here rather than imported — see
 * {@link computeFakeTwilioSignature}.
 *
 * `startFakeTwilioCall` drives the full lifecycle a real Twilio call would:
 * POST the inbound webhook (signed like Twilio signs it), parse the returned
 * `<Connect><Stream>` TwiML for the media URL and `<Parameter>`s, open the
 * media WebSocket, and send `connected`/`start`. From there, `speak()` sends
 * paced 20ms mu-law frames as if a caller were talking, and `received` tracks
 * everything the server (the adapter under test) sends back.
 */

import { createHmac, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mulawEncode } from "call-sdk";
import WebSocket from "ws";

const FRAME_MS = 20;
const SAMPLE_RATE = 8000;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 160
const INT16_MAX = 32_767;
const SILENCE_MULAW_BYTE = 0xff;
const DEFAULT_WEBHOOK_PATH = "/twilio/voice";
const DEFAULT_AUTH_TOKEN = "test-auth-token";
const DEFAULT_WAIT_TIMEOUT_MS = 2000;
const WAIT_POLL_INTERVAL_MS = 10;

/**
 * Duplicated (not imported — see module doc) implementation of Twilio's
 * request-signing algorithm: HMAC-SHA1 over the request URL followed by
 * every POST parameter (sorted by key, concatenated as `key + value`),
 * base64-encoded. See https://www.twilio.com/docs/usage/security#validating-requests
 * and `@call-adapter/twilio`'s `signature.ts`, which implements the exact
 * same formula independently.
 */
export function computeFakeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

const STREAM_URL_RE = /<Stream\s+url="([^"]*)"/i;

function parseStreamUrl(twiml: string): string | undefined {
  return twiml.match(STREAM_URL_RE)?.[1];
}

function parseTwimlParameters(twiml: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /<Parameter\s+name="([^"]*)"\s+value="([^"]*)"\s*\/?>/gi;
  for (const match of twiml.matchAll(re)) {
    params[unescapeXml(match[1])] = unescapeXml(match[2]);
  }
  return params;
}

function toneSamples(
  count: number,
  hz: number,
  startSampleIndex: number
): Int16Array {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const n = startSampleIndex + i;
    const value = 0.5 * Math.sin((2 * Math.PI * hz * n) / SAMPLE_RATE);
    samples[i] = Math.round(value * INT16_MAX);
  }
  return samples;
}

export interface FakeTwilioCallOptions {
  /** Twilio's auth token — signs the webhook request. Defaults to `"test-auth-token"`. */
  authToken?: string;
  /** Simulated playback: echo marks back after their simulated duration elapses. Default `true`. */
  autoEchoMarks?: boolean;
  /** e.g. `"http://127.0.0.1:PORT"` — the host running the adapter's webhook + media handlers. */
  baseUrl: string;
  callSid?: string;
  from?: string;
  to?: string;
  /** Defaults to `"/twilio/voice"`. */
  webhookPath?: string;
}

/** Everything the server (the adapter under test) has sent back over the media socket so far. */
export interface FakeTwilioReceived {
  clears: number;
  marks: string[];
  /** Total duration (ms) of media audio received: `payload bytes / 8` (mu-law is 1 byte/sample @ 8kHz). */
  mediaMs: number;
  payloads: Uint8Array[];
}

export interface FakeTwilioCall {
  /** Closes the media WebSocket without sending `stop` (simulates a dropped connection). */
  close(): Promise<void>;
  /** Resolves once the media WebSocket has closed. */
  readonly closed: Promise<void>;
  /** Sends `stop`, then closes the socket (a normal hangup). */
  hangup(): Promise<void>;
  readonly received: FakeTwilioReceived;
  /** Sends `stop` without closing the socket. */
  sendStop(): void;
  /**
   * Sends `ms` worth of paced, real-time 20ms mu-law media frames (160
   * bytes @ 8kHz each) as inbound caller audio. `kind: "silence"` sends the
   * canonical mu-law silence byte (`0xff`); `"tone"` sends a sine wave.
   */
  speak(input: {
    hz?: number;
    kind: "tone" | "silence";
    ms: number;
  }): Promise<void>;
  /** The resolved media WebSocket URL parsed out of the webhook's TwiML response. */
  readonly streamUrl: string;
  /** The raw webhook HTTP response — inspect this to assert rejection (403, etc). */
  readonly twimlResponse: { body: string; status: number };
  /** Polls `pred(received)` every 10ms until it's true or `timeoutMs` elapses. */
  waitFor(
    pred: (received: FakeTwilioReceived) => boolean,
    timeoutMs?: number
  ): Promise<void>;
}

/**
 * Drives a full fake Twilio call: signs and POSTs the inbound webhook, then
 * (if accepted) opens the media WebSocket and starts the stream.
 */
export async function startFakeTwilioCall(
  opts: FakeTwilioCallOptions
): Promise<FakeTwilioCall> {
  const webhookPath = opts.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  const authToken = opts.authToken ?? DEFAULT_AUTH_TOKEN;
  const callSid = opts.callSid ?? `CA${randomHex(32)}`;
  const accountSid = `AC${randomHex(32)}`;
  const from = opts.from ?? "+15550001111";
  const to = opts.to ?? "+15550002222";
  const autoEchoMarks = opts.autoEchoMarks ?? true;

  const webhookUrl = new URL(webhookPath, opts.baseUrl).toString();
  const formFields: Record<string, string> = {
    CallSid: callSid,
    From: from,
    To: to,
    Direction: "inbound",
    AccountSid: accountSid,
  };
  const signature = computeFakeTwilioSignature(
    authToken,
    webhookUrl,
    formFields
  );
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(formFields).toString(),
  });
  const responseBody = await response.text();
  const twimlResponse = { status: response.status, body: responseBody };
  const received: FakeTwilioReceived = {
    mediaMs: 0,
    payloads: [],
    marks: [],
    clears: 0,
  };

  const waitFor = async (
    pred: (r: FakeTwilioReceived) => boolean,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS
  ): Promise<void> => {
    const start = Date.now();
    while (!pred(received)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `FakeTwilioCall.waitFor: condition not met within ${timeoutMs}ms ` +
            `(received: mediaMs=${received.mediaMs}, marks=${JSON.stringify(received.marks)}, clears=${received.clears}, payloads=${received.payloads.length})`
        );
      }
      await delay(WAIT_POLL_INTERVAL_MS);
    }
  };

  if (response.status !== 200) {
    // Webhook rejected the call (e.g. bad signature) — expose the response
    // for assertions, and don't open a media socket (there's nothing to
    // connect to: Twilio never received a valid <Stream> to dial).
    return {
      streamUrl: "",
      twimlResponse,
      received,
      waitFor,
      speak: () => Promise.resolve(),
      sendStop: () => {
        // no-op: no media socket was ever opened
      },
      close: () => Promise.resolve(),
      hangup: () => Promise.resolve(),
      closed: Promise.resolve(),
    };
  }

  const streamUrl = parseStreamUrl(responseBody);
  if (!streamUrl) {
    throw new Error(
      `FakeTwilioCall: no <Stream url="..."> found in webhook TwiML response: ${responseBody}`
    );
  }
  const twimlParameters = parseTwimlParameters(responseBody);

  const ws = new WebSocket(streamUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  ws.on("close", () => resolveClosed());

  const streamSid = `MZfake${randomHex(24)}`;
  let sequenceNumber = 0;
  let chunkCounter = 0;
  let mediaTimestampMs = 0;
  let sampleCursor = 0;
  // Tracks the `received.mediaMs` checkpoint as of the last mark request, so
  // an echo waits out only the audio queued *since* that checkpoint — not
  // the whole call's worth (see the `clear` handling below for the barge-in
  // case, where that queued audio is discarded rather than "played").
  let markCheckpointMs = 0;
  const pendingMarkTimers = new Set<ReturnType<typeof setTimeout>>();

  const send = (message: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  send({ event: "connected", protocol: "Call", version: "1.0.0" });
  send({
    event: "start",
    sequenceNumber: String(++sequenceNumber),
    streamSid,
    start: {
      streamSid,
      accountSid,
      callSid,
      tracks: ["inbound"],
      customParameters: twimlParameters,
      mediaFormat: {
        encoding: "audio/x-mulaw",
        sampleRate: SAMPLE_RATE,
        channels: 1,
      },
    },
  });

  ws.on("message", (raw) => {
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
      const bytes = new Uint8Array(Buffer.from(payload, "base64"));
      received.payloads.push(bytes);
      received.mediaMs += bytes.length / 8;
      return;
    }

    if (message.event === "mark") {
      const name = message.mark?.name;
      if (typeof name !== "string") {
        return;
      }
      received.marks.push(name);
      if (!autoEchoMarks) {
        return;
      }
      const delayMs = Math.max(0, received.mediaMs - markCheckpointMs);
      markCheckpointMs = received.mediaMs;
      const timer = setTimeout(() => {
        pendingMarkTimers.delete(timer);
        send({ event: "mark", streamSid, mark: { name } });
      }, delayMs);
      pendingMarkTimers.add(timer);
      return;
    }

    if (message.event === "clear") {
      received.clears += 1;
      // The provider just flushed its outbound buffer: any audio queued
      // since the last mark checkpoint will never actually "play", so
      // cancel echoes waiting on it and reset the checkpoint to now —
      // otherwise the next mark's echo would be delayed by audio that was
      // just discarded.
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
      const mulaw =
        input.kind === "silence"
          ? new Uint8Array(SAMPLES_PER_FRAME).fill(SILENCE_MULAW_BYTE)
          : mulawEncode(
              toneSamples(SAMPLES_PER_FRAME, input.hz ?? 440, sampleCursor)
            );
      sampleCursor += SAMPLES_PER_FRAME;
      send({
        event: "media",
        sequenceNumber: String(++sequenceNumber),
        streamSid,
        media: {
          track: "inbound",
          chunk: String(++chunkCounter),
          timestamp: String(mediaTimestampMs),
          payload: Buffer.from(mulaw).toString("base64"),
        },
      });
      mediaTimestampMs += FRAME_MS;
      await delay(FRAME_MS);
    }
  };

  const sendStop = (): void => {
    send({ event: "stop", streamSid, stop: { accountSid, callSid } });
  };

  const close = async (): Promise<void> => {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }
    await closed;
  };

  const hangup = async (): Promise<void> => {
    sendStop();
    await close();
  };

  return {
    streamUrl,
    twimlResponse,
    received,
    speak,
    waitFor,
    sendStop,
    close,
    hangup,
    closed,
  };
}
