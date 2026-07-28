import type { AudioFrame } from "./audio/format";
import { CallConfigError } from "./errors";
import type { CallEndReason } from "./events";
import type { Logger } from "./logger";
import type { IncomingCallInit, RoutingDecision } from "./routing";

/**
 * The contracts of the Call SDK: `Adapter` (one per telephony/voice
 * provider) plus the small runtime interfaces that connect it to the core
 * (`MediaSocket`, `AdapterContext`, `OutboundAudio`, ...).
 *
 * An adapter does exactly three things: emit call lifecycle
 * events, execute call-control instructions (translate the SDK's
 * provider-agnostic verbs into the provider's dialect), and move normalized
 * audio bidirectionally. All semantic processing (VAD, transcription, turn
 * detection, TTS) lives above the adapter.
 */

// ---------------------------------------------------------------------------
// Media plane socket
// ---------------------------------------------------------------------------

export interface MediaSocketMessageEvent {
  data: unknown;
}

export interface MediaSocketCloseEvent {
  code?: number;
  reason?: string;
}

/**
 * The minimal server-side WebSocket the SDK accepts for the media plane.
 *
 * WHATWG defines no *server* WebSocket, so the SDK stays host-agnostic by
 * depending only on this structural interface. The `ws` package's
 * `WebSocket` satisfies it as-is (`call.media.twilio(socket)` with a raw
 * `ws` socket just works); Bun/Deno/uWS sockets can be wrapped in a few
 * lines.
 */
export interface MediaSocket {
  addEventListener(
    type: "message",
    listener: (event: MediaSocketMessageEvent) => void
  ): void;
  addEventListener(
    type: "close",
    listener: (event: MediaSocketCloseEvent) => void
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  close(code?: number, reason?: string): void;
  send(data: string | Uint8Array): void;
}

/** Normalizes a MediaSocket message payload (string | Buffer | ArrayBuffer | ...) to text. */
export function mediaSocketDataToText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  }
  if (Array.isArray(data)) {
    // `ws` can deliver fragmented messages as Buffer[]
    return data.map((part) => mediaSocketDataToText(part)).join("");
  }
  return String(data);
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface WebhookOptions {
  /**
   * Register work that should outlive the webhook response (e.g. a
   * serverless host's `waitUntil`). Adapters answer webhooks fast and hand
   * slow work to this when provided.
   */
  backgroundTask?: (task: Promise<unknown>) => void;
}

export interface AdapterDialOptions {
  from?: string;
  /** Provider-specific extras, passed through to the adapter. */
  metadata?: Record<string, string>;
  to: string;
}

export interface SessionInit {
  /** Provider-native call id (e.g. a Twilio CallSid). */
  callId: string;
  direction: "inbound" | "outbound";
  from?: string;
  /** The provider's raw call-start payload — escape hatch, never interpreted by core. */
  raw?: unknown;
  to?: string;
}

/**
 * The adapter-owned outbound audio sink — the spec's `write`/`clear`
 * contract. Core drives it; the adapter de-normalizes canonical frames into
 * provider format and moves them, interpreting nothing.
 */
export interface OutboundAudio {
  /**
   * Flush: immediately discard outbound audio already queued on the
   * provider. This is what makes barge-in actually silence the agent.
   */
  clear(): void;
  /**
   * Optional: enqueue a named marker behind the audio already written. The
   * provider echoes it back (via `AdapterSessionHandle.mark`) when playback
   * reaches it — core uses this for precise playback-completion detection.
   * Adapters without provider marks omit this; core falls back to a
   * duration-based timer.
   */
  mark?(name: string): void;
  /** Enqueue canonical audio for playback on the call. */
  write(frame: AudioFrame): void;
}

/**
 * What the adapter uses to push a live call into the core. Obtained from
 * `AdapterContext.createSession`. Every method is a safe no-op (logged at
 * debug/warn) after the call has ended — provider events racing teardown are
 * expected, not errors.
 */
export interface AdapterSessionHandle {
  /** The provider reports the call was answered / media is flowing. */
  answered(): void;
  /** Deliver one canonical inbound audio frame (already normalized by the adapter). */
  deliverAudio(frame: AudioFrame): void;
  /** The call is over (hangup, media socket closed, ...). Triggers teardown exactly once. */
  end(reason: CallEndReason): void;
  /** A provider-level failure. Fatal by default: core ends the call gracefully. */
  fail(error: Error): void;
  /** The provider echoed a playback mark previously sent via `OutboundAudio.mark`. */
  mark(name: string): void;
  /** `${adapterName}:${callId}` */
  readonly sessionId: string;
}

/** Injected into the adapter once, by `new Call(...)`, via `Adapter.bind`. */
export interface AdapterContext {
  /**
   * Called by the adapter when a media stream starts. Core creates the
   * `CallSession`, attaches the pipeline stages, and returns the handle the
   * adapter pushes into. Synchronous — the adapter can deliver audio
   * immediately (core buffers until the stages finish attaching).
   */
  createSession(
    init: SessionInit,
    outbound: OutboundAudio
  ): AdapterSessionHandle;
  readonly logger: Logger;
  /**
   * The call-control channel: the adapter calls this between parsing the
   * provider's inbound webhook and building its response. Core runs the
   * consumer's `onIncomingCall` handler (no handler → `stream`; handler
   * error or timeout → `reject`, logged) and returns the decision the
   * adapter must translate into the provider's dialect. Never rejects —
   * core converts every failure into a decision.
   */
  routeIncomingCall(init: IncomingCallInit): Promise<RoutingDecision>;
}

/**
 * A telephony/voice provider adapter. Thin by design — it does exactly
 * three things: emit call lifecycle events, execute call-control
 * instructions (pure translation of a decision the consumer already made),
 * and move normalized audio in and out. An adapter that interprets audio or
 * picks a route on its own is a bug, not a feature.
 */
export interface Adapter {
  /** Called once by `new Call(...)`; gives the adapter its session registrar. */
  bind(ctx: AdapterContext): void;
  /**
   * Place an outbound call via the provider's API. The call enters the
   * media plane once the provider connects (v1: outbound calls always
   * stream).
   */
  dial(options: AdapterDialOptions): Promise<{ callId: string }>;
  /** Media plane: the provider dialed our WebSocket; the adapter owns the wire protocol from here. */
  media(socket: MediaSocket): void;
  /** Stable name, used in session ids and as the key hint in `Call` config. */
  readonly name: string;
  /** Optional global cleanup (close pooled connections etc.). */
  shutdown?(): Promise<void>;
  /** Control plane: the provider's inbound-call webhook. Fetch-style, host-agnostic. */
  webhook(request: Request, options?: WebhookOptions): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Session ids
// ---------------------------------------------------------------------------

/** Builds the canonical `${adapterName}:${callId}` session id. */
export function formatSessionId(adapterName: string, callId: string): string {
  return `${adapterName}:${callId}`;
}

/** Parses a session id produced by `formatSessionId`. */
export function parseSessionId(sessionId: string): {
  adapter: string;
  callId: string;
} {
  const separator = sessionId.indexOf(":");
  if (separator <= 0 || separator === sessionId.length - 1) {
    throw new CallConfigError(
      `Invalid session id "${sessionId}" — expected "{adapter}:{callId}"`
    );
  }
  return {
    adapter: sessionId.slice(0, separator),
    callId: sessionId.slice(separator + 1),
  };
}
