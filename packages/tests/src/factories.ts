import {
  type Adapter,
  type AdapterContext,
  type AdapterDialOptions,
  type AdapterSessionHandle,
  type AudioFrame,
  frameDurationMs,
  type LogFields,
  type Logger,
  type MediaSocket,
  type OutboundAudio,
  type SessionInit,
  type WebhookOptions,
} from "call-sdk";

interface LogEntry {
  fields?: LogFields;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** A {@link Logger} that captures every call into an inspectable `entries` array. */
export function createMockLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry["level"]) => (message: string, fields?: LogFields) => {
      entries.push(
        fields === undefined ? { level, message } : { level, message, fields }
      );
    };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/**
 * Drives a single mock call: pushes provider events/audio into the SDK through
 * the {@link AdapterSessionHandle}, and records everything the SDK writes back
 * out through the outbound sink.
 */
export interface MockCallDriver {
  /** Number of `outbound.clear()` calls. */
  readonly clears: number;
  /** Echo every mark not yet echoed. */
  echoAllMarks(): void;
  /** Simulate the provider echoing a single playback mark back to the SDK. */
  echoMark(name: string): void;
  /** Simulate a provider-level failure. */
  fail(error: Error): void;
  readonly handle: AdapterSessionHandle;
  /** Simulate a provider hangup. */
  hangup(): void;
  /** Names passed to `outbound.mark(name)`. */
  readonly marks: string[];
  /** Deliver inbound audio (one `deliverAudio` per frame). */
  sendAudio(frames: AudioFrame[]): void;
  readonly sessionId: string;
  /** Frames the SDK wrote via `outbound.write`. */
  readonly written: AudioFrame[];
  /** Total duration (ms) of all written frames. */
  readonly writtenMs: number;
}

export interface MockAdapter extends Adapter {
  /** Simulate the provider connecting media for a call; returns its driver. */
  connectCall(init?: Partial<SessionInit>): MockCallDriver;
}

export interface CreateMockAdapterOptions {
  /**
   * Whether the outbound sink exposes `mark()`. When false, the sink omits it
   * entirely, forcing core's duration-timer playback-completion fallback.
   */
  supportsMarks?: boolean;
}

/**
 * Creates a fully in-memory {@link MockAdapter}. `dial` mints a call id but
 * does NOT create a session — call {@link MockAdapter.connectCall} afterward to
 * simulate the provider dialing back and connecting media.
 */
export function createMockAdapter(
  name = "mock",
  options: CreateMockAdapterOptions = {}
): MockAdapter {
  const supportsMarks = options.supportsMarks ?? true;
  let ctx: AdapterContext | undefined;
  let callCounter = 0;

  const connectCall = (init: Partial<SessionInit> = {}): MockCallDriver => {
    if (!ctx) {
      throw new Error(
        "MockAdapter.connectCall called before the adapter was bound to a Call"
      );
    }
    const written: AudioFrame[] = [];
    const marks: string[] = [];
    const echoed = new Set<number>();
    let clears = 0;

    const outbound: OutboundAudio = {
      write: (frame) => {
        written.push(frame);
      },
      clear: () => {
        clears += 1;
      },
      ...(supportsMarks
        ? {
            mark: (markName: string) => {
              marks.push(markName);
            },
          }
        : {}),
    };

    const callId = init.callId ?? `mock-call-${++callCounter}`;
    const sessionInit: SessionInit = {
      callId,
      direction: init.direction ?? "inbound",
      ...(init.from === undefined ? {} : { from: init.from }),
      ...(init.to === undefined ? {} : { to: init.to }),
      ...(init.raw === undefined ? {} : { raw: init.raw }),
    };
    const handle = ctx.createSession(sessionInit, outbound);

    let ended = false;
    const driver: MockCallDriver = {
      sessionId: handle.sessionId,
      handle,
      sendAudio: (frames) => {
        if (ended) {
          return;
        }
        for (const frame of frames) {
          handle.deliverAudio(frame);
        }
      },
      hangup: () => {
        ended = true;
        handle.end("hangup");
      },
      fail: (error) => {
        ended = true;
        handle.fail(error);
      },
      echoMark: (markName) => {
        if (ended) {
          return;
        }
        handle.mark(markName);
      },
      echoAllMarks: () => {
        if (ended) {
          return;
        }
        for (let i = 0; i < marks.length; i++) {
          if (!echoed.has(i)) {
            echoed.add(i);
            handle.mark(marks[i]);
          }
        }
      },
      get written() {
        return written;
      },
      get writtenMs() {
        return written.reduce((sum, frame) => sum + frameDurationMs(frame), 0);
      },
      get clears() {
        return clears;
      },
      get marks() {
        return marks;
      },
    };
    return driver;
  };

  return {
    name,
    bind: (boundCtx) => {
      ctx = boundCtx;
    },
    // Exercises the adapter's third duty (call-control): parse the inbound
    // webhook just enough to hand core a `CallSid`/`From`/`To`-shaped init,
    // then respond with the raw `RoutingDecision` JSON so conformance tests
    // can assert provider-agnostic verb pass-through without a real
    // provider's dialect in the way.
    webhook: async (request: Request, _options?: WebhookOptions) => {
      if (!ctx) {
        throw new Error(
          "MockAdapter.webhook called before the adapter was bound to a Call"
        );
      }
      const body = await request.text();
      const form = new URLSearchParams(body);
      const raw = Object.fromEntries(form.entries());
      const callId = form.get("CallSid") ?? `mock-call-${++callCounter}`;
      const from = form.get("From");
      const to = form.get("To");
      const decision = await ctx.routeIncomingCall({
        callId,
        ...(from === null ? {} : { from }),
        ...(to === null ? {} : { to }),
        raw,
      });
      return new Response(JSON.stringify(decision), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    media: (_socket: MediaSocket) => {
      // no-op: the mock delivers media via connectCall/sendAudio instead.
    },
    dial: (_options: AdapterDialOptions) =>
      Promise.resolve({ callId: `mock-call-${++callCounter}` }),
    connectCall,
  };
}
