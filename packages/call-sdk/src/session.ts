import type { AudioFrame } from "./audio/format";
import { EventBus, type EventMeta, type Unsubscribe } from "./bus";
import type { CallEndReason, CallEventMap, CallEventType } from "./events";
import { childLogger, type Logger } from "./logger";
import { createSessionAudio, type SessionAudio } from "./session-audio";
import { SessionTelemetry, type TelemetrySink } from "./telemetry";
import type { AdapterSessionHandle, OutboundAudio, SessionInit } from "./types";
import { formatSessionId } from "./types";

/**
 * The lifecycle handler registry `Call`'s registration methods append to.
 * Passed by reference: the session reads the arrays at dispatch time, so
 * handlers registered after a session exists still fire for later events.
 */
export interface SessionLifecycleHandlers {
  answered: ((session: CallSession) => void | Promise<void>)[];
  ended: ((
    event: CallEventMap["call-ended"],
    session: CallSession
  ) => void | Promise<void>)[];
  error: ((
    event: CallEventMap["error"],
    session: CallSession
  ) => void | Promise<void>)[];
  started: ((session: CallSession) => void | Promise<void>)[];
}

export interface CallSessionDeps {
  adapterName: string;
  init: SessionInit;
  /** Shared, live registry — see {@link SessionLifecycleHandlers}. */
  lifecycle: SessionLifecycleHandlers;
  logger: Logger;
  /** Invoked at the very end of teardown so the owning `Call` can drop the session. */
  onClosed?: (session: CallSession) => void;
  outbound: OutboundAudio;
  telemetrySink?: TelemetrySink;
}

type SessionPhase = "starting" | "live" | "ending" | "ended";

/** How long inbound audio is buffered before the session goes live (in 20 ms frames). */
const MAX_PENDING_INBOUND_FRAMES = 250;

/**
 * One call in flight on the media plane: the per-call transport runtime.
 * `Call` is the configured application; `CallSession` is a single live
 * call — its typed event bus, its raw audio surface (`session.audio`), its
 * telemetry, and the exactly-once teardown that ends every call with one
 * terminal `call-ended` event.
 *
 * Semantics (speech, turns, transcripts, `say()`) intentionally do not live
 * here — they belong to the consumer layer; see the voice pipeline in
 * `examples/twilio-on-ws/src/pipeline` (`attachVoice(session, ...)`).
 */
export class CallSession {
  readonly id: string;
  readonly adapterName: string;
  readonly callId: string;
  readonly direction: "inbound" | "outbound";
  readonly from?: string;
  readonly to?: string;
  /** Low-level entry point: the session's typed event bus. */
  readonly bus: EventBus<CallEventMap>;
  /** The raw media surface: inbound frames, outbound write/clear/mark. */
  readonly audio: SessionAudio;
  readonly telemetry: SessionTelemetry;
  /** Aborted when teardown starts — cancel in-flight per-call work on it. */
  readonly signal: AbortSignal;
  /** Resolves with the terminal `call-ended` payload. Never rejects. */
  readonly ended: Promise<CallEventMap["call-ended"]>;
  /** The handle the owning adapter pushes provider events/audio through. */
  readonly handle: AdapterSessionHandle;

  #phase: SessionPhase = "starting";
  readonly #logger: Logger;
  readonly #lifecycle: SessionLifecycleHandlers;
  readonly #onClosed?: (session: CallSession) => void;
  readonly #abort = new AbortController();
  readonly #startPromise: Promise<void>;
  readonly #pendingInbound: AudioFrame[] = [];
  readonly #cleanups: (() => void | Promise<void>)[] = [];
  #pendingAnswered = false;
  #droppedPendingWarned = false;
  #teardownPromise?: Promise<void>;
  #endedResolve!: (event: CallEventMap["call-ended"]) => void;

  constructor(deps: CallSessionDeps) {
    this.adapterName = deps.adapterName;
    this.callId = deps.init.callId;
    this.id = formatSessionId(deps.adapterName, deps.init.callId);
    this.direction = deps.init.direction;
    if (deps.init.from !== undefined) {
      this.from = deps.init.from;
    }
    if (deps.init.to !== undefined) {
      this.to = deps.init.to;
    }
    this.#logger = childLogger(deps.logger, { sessionId: this.id });
    this.#lifecycle = deps.lifecycle;
    if (deps.onClosed) {
      this.#onClosed = deps.onClosed;
    }
    this.signal = this.#abort.signal;

    this.bus = new EventBus(this.id, {
      logger: this.#logger,
      onListenerError: (error, type) =>
        this.#publishError(error, `listener:${type}`, false),
    });
    this.telemetry = new SessionTelemetry(this.id, {
      ...(deps.telemetrySink ? { sink: deps.telemetrySink } : {}),
      logger: this.#logger,
    });
    this.telemetry.observe(this.bus);
    this.ended = new Promise((resolve) => {
      this.#endedResolve = resolve;
    });

    this.audio = createSessionAudio({
      bus: this.bus,
      isWritable: () => this.#phase !== "ending" && this.#phase !== "ended",
      logger: this.#logger,
      outbound: deps.outbound,
    });

    this.#subscribeCore();
    this.handle = this.#makeAdapterHandle();
    this.#startPromise = this.#start();
  }

  /** Sugar for `bus.subscribe`. */
  on<K extends CallEventType>(
    type: K,
    handler: (payload: CallEventMap[K], meta: EventMeta) => void
  ): Unsubscribe {
    return this.bus.subscribe(type, handler);
  }

  /**
   * Register consumer cleanup to run during teardown — after inbound audio
   * stops, before the terminal `call-ended` event (consumer-attached media
   * resources are disposed in reverse attach order). Functions
   * run in reverse registration order; a throwing cleanup is logged, never
   * propagated. Registering after the call has ended runs the cleanup
   * immediately.
   */
  registerCleanup(cleanup: () => void | Promise<void>): void {
    if (this.#phase === "ending" || this.#phase === "ended") {
      this.#logger.debug("registerCleanup after call end — running now");
      void Promise.resolve()
        .then(cleanup)
        .catch((err: unknown) => {
          this.#logger.error("late cleanup threw", { error: toError(err) });
        });
      return;
    }
    this.#cleanups.push(cleanup);
  }

  /** Ends the call. Idempotent; resolves when teardown completes. */
  end(reason: CallEndReason = "local-end"): Promise<void> {
    return this.#teardown(reason);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  #subscribeCore(): void {
    // Lifecycle arrays are read at dispatch time so late `call.onX(...)`
    // registrations still fire, and each handler is invoked separately so
    // one throwing never starves the next.
    this.bus.subscribe("error", (payload) => {
      this.#logger.error(`session error from ${payload.source}`, {
        error: payload.error,
        fatal: payload.fatal,
      });
      for (const handler of this.#lifecycle.error) {
        this.#invokeHandler("onError", () => handler(payload, this));
      }
      if (payload.fatal) {
        void this.#teardown("error", payload.error);
      }
    });
    this.bus.subscribe("call-started", () => {
      for (const handler of this.#lifecycle.started) {
        this.#invokeHandler("onCallStarted", () => handler(this));
      }
    });
    this.bus.subscribe("call-answered", () => {
      for (const handler of this.#lifecycle.answered) {
        this.#invokeHandler("onCallAnswered", () => handler(this));
      }
    });
    this.bus.subscribe("call-ended", (payload) => {
      for (const handler of this.#lifecycle.ended) {
        this.#invokeHandler("onCallEnded", () => handler(payload, this));
      }
    });
  }

  /** Runs a user handler, containing sync and async exceptions as session errors. */
  #invokeHandler(name: string, fn: () => void | Promise<void>): void {
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        result.then(undefined, (err: unknown) => {
          this.#publishError(toError(err), `handler:${name}`, false);
        });
      }
    } catch (err) {
      this.#publishError(toError(err), `handler:${name}`, false);
    }
  }

  #publishError(error: Error, source: string, fatal: boolean): void {
    if (this.bus.closed) {
      this.#logger.error(`error after bus close from ${source}`, { error });
      if (fatal) {
        void this.#teardown("error", error);
      }
      return;
    }
    this.bus.publish("error", { error, source, fatal });
  }

  async #start(): Promise<void> {
    // Yield one microtask so the adapter holds its handle before any events
    // fire — `createSession` is synchronous and may deliver audio
    // immediately (buffered until we go live).
    await Promise.resolve();
    if (this.#phase !== "starting") {
      return; // torn down before going live
    }
    this.#phase = "live";
    this.bus.publish("call-started", {
      sessionId: this.id,
      direction: this.direction,
      ...(this.from === undefined ? {} : { from: this.from }),
      ...(this.to === undefined ? {} : { to: this.to }),
    });
    if (this.#pendingAnswered) {
      this.#pendingAnswered = false;
      this.bus.publish("call-answered", { sessionId: this.id });
    }
    const buffered = this.#pendingInbound.splice(0);
    for (const frame of buffered) {
      this.bus.publish("audio-frame", { frame });
    }
  }

  // -------------------------------------------------------------------------
  // Adapter handle
  // -------------------------------------------------------------------------

  #makeAdapterHandle(): AdapterSessionHandle {
    return {
      sessionId: this.id,
      deliverAudio: (frame) => this.#deliverAudio(frame),
      answered: () => this.#answered(),
      end: (reason) => void this.#teardown(reason),
      fail: (error) =>
        this.#publishError(error, `adapter:${this.adapterName}`, true),
      mark: (name) => this.#onProviderMark(name),
    };
  }

  #deliverAudio(frame: AudioFrame): void {
    if (this.#phase === "ending" || this.#phase === "ended") {
      this.#logger.debug("inbound audio after call end — dropped");
      return;
    }
    if (this.#phase === "starting") {
      if (this.#pendingInbound.length >= MAX_PENDING_INBOUND_FRAMES) {
        this.#pendingInbound.shift();
        if (!this.#droppedPendingWarned) {
          this.#droppedPendingWarned = true;
          this.#logger.warn(
            "inbound audio buffer overflowed before the session went live; dropping oldest frames"
          );
        }
      }
      this.#pendingInbound.push(frame);
      return;
    }
    this.bus.publish("audio-frame", { frame });
  }

  #answered(): void {
    if (this.#phase === "ending" || this.#phase === "ended") {
      return;
    }
    if (this.#phase === "starting") {
      this.#pendingAnswered = true;
      return;
    }
    this.bus.publish("call-answered", { sessionId: this.id });
  }

  #onProviderMark(name: string): void {
    if (this.bus.closed) {
      this.#logger.debug(`provider mark "${name}" after call end — dropped`);
      return;
    }
    this.bus.publish("audio-mark", { name });
  }

  // -------------------------------------------------------------------------
  // Teardown — the ONLY code path that emits `call-ended` (exactly once)
  // -------------------------------------------------------------------------

  #teardown(reason: CallEndReason, error?: Error): Promise<void> {
    if (!this.#teardownPromise) {
      this.#teardownPromise = this.#runTeardown(reason, error).catch(
        (err: unknown) => {
          this.#logger.error("teardown failed", { error: toError(err) });
        }
      );
    }
    return this.#teardownPromise;
  }

  async #runTeardown(reason: CallEndReason, error?: Error): Promise<void> {
    this.#phase = "ending";
    // 1. Stop accepting inbound audio.
    this.#pendingInbound.length = 0;
    // 2. Abort in-flight work.
    this.#abort.abort();
    // Let the start microtask settle so "live" can't race the teardown.
    await this.#startPromise;
    // 3. Dispose consumer-attached resources in reverse registration order
    //    (e.g. the pipeline's stage graph — provider sockets close here,
    //    before the terminal event).
    for (const cleanup of [...this.#cleanups].reverse()) {
      try {
        await cleanup();
      } catch (err) {
        this.#logger.error("cleanup threw during teardown", {
          error: toError(err),
        });
      }
    }
    this.#cleanups.length = 0;
    // 4. Flush telemetry.
    this.telemetry.flush();
    // 5. Exactly one terminal event, on every path.
    const event: CallEventMap["call-ended"] = {
      sessionId: this.id,
      reason,
      ...(error === undefined ? {} : { error }),
    };
    this.bus.publish("call-ended", event);
    this.#endedResolve(event);
    // 6. Close the bus and release the session.
    this.bus.close();
    this.#phase = "ended";
    this.#onClosed?.(this);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
