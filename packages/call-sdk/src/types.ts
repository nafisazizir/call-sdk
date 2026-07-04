import type { AudioFrame } from "./audio/format.js";
import type { EventBus } from "./bus.js";
import { CallConfigError } from "./errors.js";
import type { CallEndReason, CallEventMap, CallEventType } from "./events.js";
import type { Logger } from "./logger.js";

/**
 * The contracts of the Call SDK: `Adapter` (one per telephony/voice
 * provider) and `Stage` (one per pipeline processing unit), plus the small
 * runtime interfaces that connect them to the core (`MediaSocket`,
 * `AdapterContext`, `StageContext`, ...).
 *
 * Per SPEC.md, an adapter does exactly two things: emit call lifecycle
 * events and move normalized audio bidirectionally. All semantic processing
 * (VAD, transcription, turn detection, TTS) lives in stages, above the
 * adapter.
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

export interface StartCallOptions {
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
}

/**
 * A telephony/voice provider adapter. Thin by design: lifecycle events and
 * normalized audio in/out, nothing else. An adapter that interprets audio is
 * a bug, not a feature (SPEC.md, Design Decisions).
 */
export interface Adapter {
  /** Called once by `new Call(...)`; gives the adapter its session registrar. */
  bind(ctx: AdapterContext): void;
  /** Media plane: the provider dialed our WebSocket; the adapter owns the wire protocol from here. */
  media(socket: MediaSocket): void;
  /** Stable name, used in session ids and as the key hint in `Call` config. */
  readonly name: string;
  /** Optional global cleanup (close pooled connections etc.). */
  shutdown?(): Promise<void>;
  /** Place an outbound call via the provider's REST API. */
  startCall(options: StartCallOptions): Promise<{ callId: string }>;
  /** Control plane: the provider's inbound-call webhook. Fetch-style, host-agnostic. */
  webhook(request: Request, options?: WebhookOptions): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Stage contract
// ---------------------------------------------------------------------------

/** Per-session context handed to `Stage.attach`. */
export interface StageContext {
  /** The session's event bus — subscribe to `consumes`, publish `emits`. */
  readonly bus: EventBus<CallEventMap>;
  /**
   * Surface an upstream failure as a session-level error (never stall
   * silently — SPEC.md, stage contract). `fatal` defaults to true: the call
   * ends gracefully. v1 does no automatic recovery.
   */
  fail(error: Error, opts?: { fatal?: boolean }): void;
  /** Child logger tagged with the stage name. */
  readonly logger: Logger;
  /** Record a telemetry mark attributed to this stage. */
  mark(name: string, detail?: Record<string, unknown>): void;
  readonly sessionId: string;
  /** Aborted when session teardown starts — cancel in-flight upstream work on it. */
  readonly signal: AbortSignal;
}

/** The per-session half of a stage, returned by `attach`. */
export interface StageHandle {
  /**
   * Called at teardown, in reverse attach order. Closes the stage's own
   * upstream connection. Must not throw (errors are logged, not propagated).
   */
  dispose(): void | Promise<void>;
}

/**
 * A pipeline stage: a named, factory-configured unit instantiated once per
 * call. The object returned by `create${Name}Stage(config)` IS the
 * configured factory; core calls `attach` for each new session, so stages
 * never share mutable state across calls.
 */
export interface Stage {
  /**
   * Per-session instantiation. Opens upstream connections, subscribes to
   * `ctx.bus`, returns the disposable per-session handle. Runs in
   * configuration order; awaited before the session goes live.
   */
  attach(ctx: StageContext): StageHandle | Promise<StageHandle>;
  /**
   * Event types this stage requires. Validated at `new Call(...)`: every
   * entry must be produced by core or by another configured stage.
   */
  readonly consumes: readonly CallEventType[];
  /** Event types this stage publishes. */
  readonly emits: readonly CallEventType[];
  readonly name: string;
  /**
   * Event types this stage uses opportunistically when some other stage
   * happens to produce them (e.g. turn detection consuming `stt-endpoint`).
   * Not required by graph validation.
   */
  readonly optionalConsumes?: readonly CallEventType[];
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
