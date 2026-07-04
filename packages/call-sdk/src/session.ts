import { type AudioFrame, frameDurationMs } from "./audio/format.js";
import { chunkSentences } from "./audio/sentences.js";
import { EventBus, type EventMeta, type Unsubscribe } from "./bus.js";
import type { CallEndReason, CallEventMap, CallEventType } from "./events.js";
import { childLogger, type Logger } from "./logger.js";
import { SessionTelemetry, type TelemetrySink } from "./telemetry.js";
import type {
  AdapterSessionHandle,
  OutboundAudio,
  SessionInit,
  Stage,
  StageContext,
  StageHandle,
} from "./types.js";
import { formatSessionId } from "./types.js";

export type ConversationState = "idle" | "user-speaking" | "agent-speaking";

export interface SayResult {
  interrupted: boolean;
  utteranceId: string;
}

export interface TranscriptEntry {
  /** Unix epoch ms. */
  at: number;
  role: "user" | "agent";
  text: string;
}

/** The per-session lifecycle/pipeline handlers, bridged from `CallConfig`. */
export interface SessionHandlers {
  onCallAnswered?: (session: CallSession) => void | Promise<void>;
  onCallEnded?: (
    event: CallEventMap["call-ended"],
    session: CallSession
  ) => void | Promise<void>;
  onCallStarted?: (session: CallSession) => void | Promise<void>;
  onEndOfTurn?: (
    turn: CallEventMap["end-of-turn"],
    session: CallSession
  ) => void | Promise<void>;
  onError?: (
    error: CallEventMap["error"],
    session: CallSession
  ) => void | Promise<void>;
  onInterruption?: (
    interruption: CallEventMap["interruption"],
    session: CallSession
  ) => void | Promise<void>;
  onTranscript?: (
    transcript: CallEventMap["transcript-final"],
    session: CallSession
  ) => void | Promise<void>;
}

export interface CallSessionDeps {
  adapterName: string;
  handlers: SessionHandlers;
  init: SessionInit;
  interruption?: { minSpeechMs?: number };
  logger: Logger;
  /** Invoked at the very end of teardown so the owning `Call` can drop the session. */
  onClosed?: (session: CallSession) => void;
  outbound: OutboundAudio;
  stages: readonly Stage[];
  telemetrySink?: TelemetrySink;
}

type SessionPhase = "starting" | "live" | "ending" | "ended";

interface ActiveUtterance {
  controller: AbortController;
  fallbackTimer?: ReturnType<typeof setTimeout>;
  /** performance.now() at the first audio-out frame. */
  firstFrameAt?: number;
  generationEnded: boolean;
  id: string;
  /** Total duration of audio-out frames written for this utterance. */
  queuedMs: number;
  resolve: (result: SayResult) => void;
  /** True once any audio-out frame was seen (agent-speech-start emitted). */
  spoke: boolean;
  /** Text handed to TTS so far — recorded for the conversation transcript. */
  textParts: string[];
}

/** How long inbound audio is buffered while stages attach (in 20 ms frames). */
const MAX_PENDING_INBOUND_FRAMES = 250;
/** Ceiling on waiting for an in-flight stage attach during teardown. */
const TEARDOWN_START_SETTLE_MS = 5000;
/** Grace added to the duration-based playback fallback timer. */
const PLAYBACK_FALLBACK_SLACK_MS = 60;

async function* recordChunks(
  source: AsyncIterable<string>,
  parts: string[]
): AsyncIterable<string> {
  for await (const chunk of source) {
    parts.push(chunk);
    yield chunk;
  }
}

/**
 * One call in flight: the per-call runtime carrying the duplex conversation
 * state. `Call` is the configured application; `CallSession` is a single
 * live call (SPEC.md, "Two Entry Points, One Graph").
 *
 * High-level consumers use the `Call` config handlers plus `say()`;
 * low-level consumers subscribe to `session.bus` directly. Both drive the
 * same pipeline graph.
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
  readonly telemetry: SessionTelemetry;
  /** Resolves with the terminal `call-ended` payload. Never rejects. */
  readonly ended: Promise<CallEventMap["call-ended"]>;
  /** The handle the owning adapter pushes provider events/audio through. */
  readonly handle: AdapterSessionHandle;

  #phase: SessionPhase = "starting";
  #state: ConversationState = "idle";
  readonly #logger: Logger;
  readonly #outbound: OutboundAudio;
  readonly #stages: readonly Stage[];
  readonly #handlers: SessionHandlers;
  readonly #onClosed?: (session: CallSession) => void;
  readonly #abort = new AbortController();
  readonly #minSpeechMs: number;
  readonly #startPromise: Promise<void>;
  readonly #stageHandles: StageHandle[] = [];
  readonly #pendingInbound: AudioFrame[] = [];
  readonly #transcript: TranscriptEntry[] = [];
  #pendingAnswered = false;
  #droppedPendingWarned = false;
  #teardownPromise?: Promise<void>;
  #endedResolve!: (event: CallEventMap["call-ended"]) => void;
  #active?: ActiveUtterance;
  #utteranceCounter = 0;
  #turnIndex = 0;
  #vadSpeaking = false;
  #interruptTimer?: ReturnType<typeof setTimeout>;

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
    this.#outbound = deps.outbound;
    this.#stages = deps.stages;
    this.#handlers = deps.handlers;
    if (deps.onClosed) {
      this.#onClosed = deps.onClosed;
    }
    this.#minSpeechMs = deps.interruption?.minSpeechMs ?? 0;

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

    this.#subscribeCore();
    this.handle = this.#makeAdapterHandle();
    this.#startPromise = this.#start();
  }

  get state(): ConversationState {
    return this.#state;
  }

  /**
   * Conversation history accumulated from user turns (`end-of-turn`) and
   * agent utterances — ready to map into LLM messages.
   */
  get transcript(): readonly TranscriptEntry[] {
    return this.#transcript;
  }

  /** Sugar for `bus.subscribe`. */
  on<K extends CallEventType>(
    type: K,
    handler: (payload: CallEventMap[K], meta: EventMeta) => void
  ): Unsubscribe {
    return this.bus.subscribe(type, handler);
  }

  /**
   * Speak on the call. Publishes `agent-say` for the TTS stage; resolves
   * when playback completes or the utterance is interrupted (barge-in,
   * `stopSpeaking()`, a newer `say()`, or teardown). Accepts a plain string
   * or a streaming text source — `streamText().textStream` pipes straight
   * in, sentence-chunked so synthesis starts on the first sentence.
   */
  say(text: string | AsyncIterable<string>): Promise<SayResult> {
    this.#utteranceCounter += 1;
    const utteranceId = `utt_${this.#utteranceCounter}`;
    if (this.#phase === "ending" || this.#phase === "ended") {
      this.#logger.warn("say() after call end — dropped");
      return Promise.resolve({ interrupted: true, utteranceId });
    }
    const previous = this.#active;
    if (previous) {
      this.#logger.debug(
        `say() superseding active utterance ${previous.id}; interrupting it`
      );
      this.#finishUtterance(previous, true);
    }

    const controller = new AbortController();
    const utterance: ActiveUtterance = {
      id: utteranceId,
      controller,
      textParts: [],
      queuedMs: 0,
      spoke: false,
      generationEnded: false,
      resolve: () => {
        // replaced synchronously below by the returned promise's resolver
      },
    };
    const result = new Promise<SayResult>((resolve) => {
      utterance.resolve = resolve;
    });
    this.#active = utterance;

    let outgoing: string | AsyncIterable<string>;
    if (typeof text === "string") {
      utterance.textParts.push(text);
      outgoing = text;
    } else {
      outgoing = recordChunks(chunkSentences(text), utterance.textParts);
    }

    this.telemetry.mark("say-called", { turnIndex: this.#turnIndex });
    this.bus.publish("agent-say", {
      utteranceId,
      text: outgoing,
      signal: controller.signal,
    });
    return result;
  }

  /** Immediately stop agent playback (manual barge-in): abort TTS and flush the provider queue. */
  stopSpeaking(): void {
    const active = this.#active;
    if (active) {
      this.#finishUtterance(active, true);
    }
  }

  /** Ends the call. Idempotent; resolves when teardown completes. */
  end(reason: CallEndReason = "local-end"): Promise<void> {
    return this.#teardown(reason);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  #subscribeCore(): void {
    // Core subscriptions first, then handler bridges: subscription order is
    // dispatch order, so e.g. `transcript` already contains the latest user
    // turn when `onEndOfTurn` fires.
    this.bus.subscribe("audio-out", (payload) => this.#onAudioOut(payload));
    this.bus.subscribe("agent-generation-end", (payload) =>
      this.#onGenerationEnd(payload)
    );
    this.bus.subscribe("speech-start", (payload) =>
      this.#onSpeechStart(payload)
    );
    this.bus.subscribe("speech-end", () => this.#onSpeechEnd());
    this.bus.subscribe("end-of-turn", (payload) => {
      this.#turnIndex = payload.turnIndex;
      if (payload.transcript.trim().length > 0) {
        this.#transcript.push({
          role: "user",
          text: payload.transcript,
          at: Date.now(),
        });
      }
    });
    this.bus.subscribe("error", (payload) => {
      this.#logger.error(`session error from ${payload.source}`, {
        error: payload.error,
        fatal: payload.fatal,
      });
      if (this.#handlers.onError) {
        this.#invokeHandler("onError", () =>
          this.#handlers.onError?.(payload, this)
        );
      }
      if (payload.fatal) {
        void this.#teardown("error", payload.error);
      }
    });

    this.#bridge("call-started", this.#handlers.onCallStarted, "onCallStarted");
    this.#bridge(
      "call-answered",
      this.#handlers.onCallAnswered,
      "onCallAnswered"
    );
    this.#bridge("call-ended", this.#handlers.onCallEnded, "onCallEnded", {
      withPayload: true,
    });
    this.#bridgeWithPayload(
      "transcript-final",
      this.#handlers.onTranscript,
      "onTranscript"
    );
    this.#bridgeWithPayload(
      "end-of-turn",
      this.#handlers.onEndOfTurn,
      "onEndOfTurn"
    );
    this.#bridgeWithPayload(
      "interruption",
      this.#handlers.onInterruption,
      "onInterruption"
    );
  }

  #bridge<K extends CallEventType>(
    type: K,
    handler:
      | ((session: CallSession) => void | Promise<void>)
      | ((
          payload: CallEventMap[K],
          session: CallSession
        ) => void | Promise<void>)
      | undefined,
    name: string,
    opts: { withPayload?: boolean } = {}
  ): void {
    if (!handler) {
      return;
    }
    this.bus.subscribe(type, (payload) => {
      this.#invokeHandler(name, () =>
        opts.withPayload
          ? (
              handler as (
                p: CallEventMap[K],
                s: CallSession
              ) => void | Promise<void>
            )(payload, this)
          : (handler as (s: CallSession) => void | Promise<void>)(this)
      );
    });
  }

  #bridgeWithPayload<K extends CallEventType>(
    type: K,
    handler:
      | ((
          payload: CallEventMap[K],
          session: CallSession
        ) => void | Promise<void>)
      | undefined,
    name: string
  ): void {
    this.#bridge(type, handler, name, { withPayload: true });
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

  #makeStageContext(stage: Stage): StageContext {
    return {
      sessionId: this.id,
      bus: this.bus,
      logger: childLogger(this.#logger, { stage: stage.name }),
      signal: this.#abort.signal,
      mark: (name, detail) =>
        void this.telemetry.mark(name, { ...detail, stage: stage.name }),
      fail: (error, opts) =>
        this.#publishError(error, `stage:${stage.name}`, opts?.fatal ?? true),
    };
  }

  async #start(): Promise<void> {
    for (const stage of this.#stages) {
      if (this.#phase !== "starting") {
        return; // torn down while attaching
      }
      try {
        const handle = await stage.attach(this.#makeStageContext(stage));
        this.#stageHandles.push(handle);
      } catch (err) {
        this.#publishError(
          toError(err),
          `stage-attach:${stage.name}`,
          true // fatal: the session cannot start with a broken pipeline
        );
        return;
      }
    }
    if (this.#phase !== "starting") {
      return;
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
            "inbound audio buffer overflowed while stages were attaching; dropping oldest frames"
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
    const active = this.#active;
    if (active && name === active.id) {
      this.#finishUtterance(active, false);
      return;
    }
    this.#logger.debug(`provider mark "${name}" for inactive utterance`);
  }

  // -------------------------------------------------------------------------
  // Agent speech lifecycle
  // -------------------------------------------------------------------------

  #onAudioOut(payload: CallEventMap["audio-out"]): void {
    if (this.#phase === "ending" || this.#phase === "ended") {
      return;
    }
    const active = this.#active;
    if (!active || payload.utteranceId !== active.id) {
      this.#logger.debug(
        `audio-out for stale utterance ${payload.utteranceId} — dropped`
      );
      return;
    }
    if (!active.spoke) {
      active.spoke = true;
      active.firstFrameAt = performance.now();
      this.#setState("agent-speaking");
      this.bus.publish("agent-speech-start", { utteranceId: active.id });
    }
    active.queuedMs += frameDurationMs(payload.frame);
    this.#outbound.write(payload.frame);
  }

  #onGenerationEnd(payload: CallEventMap["agent-generation-end"]): void {
    const active = this.#active;
    if (!active || payload.utteranceId !== active.id) {
      return;
    }
    active.generationEnded = true;
    if (!active.spoke) {
      // Zero audio produced (e.g. empty text): complete immediately.
      this.#finishUtterance(active, false);
      return;
    }
    if (this.#outbound.mark) {
      this.#outbound.mark(active.id);
      return;
    }
    // No provider marks: fall back to a duration-based playback timer.
    const elapsed = performance.now() - (active.firstFrameAt ?? 0);
    const remaining = Math.max(0, active.queuedMs - elapsed);
    active.fallbackTimer = setTimeout(() => {
      this.#finishUtterance(active, false);
    }, remaining + PLAYBACK_FALLBACK_SLACK_MS);
  }

  /**
   * Terminates the active utterance exactly once. `interrupted: true` also
   * aborts TTS generation and flushes the provider's outbound queue —
   * stopping generation alone would leave already-buffered audio playing
   * (SPEC.md, The Adapter Contract).
   */
  #finishUtterance(utterance: ActiveUtterance, interrupted: boolean): void {
    if (this.#active !== utterance) {
      return;
    }
    this.#active = undefined;
    if (utterance.fallbackTimer !== undefined) {
      clearTimeout(utterance.fallbackTimer);
    }
    if (interrupted) {
      utterance.controller.abort();
      this.#outbound.clear();
    }
    if (utterance.spoke && !this.bus.closed) {
      this.bus.publish("agent-speech-end", {
        utteranceId: utterance.id,
        interrupted,
      });
    }
    const text = utterance.textParts.join("").trim();
    if (text.length > 0) {
      this.#transcript.push({ role: "agent", text, at: Date.now() });
    }
    if (this.#state === "agent-speaking") {
      this.#setState(this.#vadSpeaking ? "user-speaking" : "idle");
    }
    utterance.resolve({ interrupted, utteranceId: utterance.id });
  }

  // -------------------------------------------------------------------------
  // Conversation state machine
  // -------------------------------------------------------------------------

  #onSpeechStart(payload: CallEventMap["speech-start"]): void {
    this.#vadSpeaking = true;
    if (this.#state === "agent-speaking" && this.#active?.spoke) {
      if (this.#minSpeechMs > 0) {
        this.#clearInterruptTimer();
        this.#interruptTimer = setTimeout(() => {
          if (
            this.#vadSpeaking &&
            this.#state === "agent-speaking" &&
            this.#active
          ) {
            this.#interrupt(payload.timestamp);
          }
        }, this.#minSpeechMs);
      } else {
        this.#interrupt(payload.timestamp);
      }
      return;
    }
    if (this.#state === "idle") {
      this.#setState("user-speaking");
    }
  }

  #onSpeechEnd(): void {
    this.#vadSpeaking = false;
    this.#clearInterruptTimer();
    if (this.#state === "user-speaking") {
      this.#setState("idle");
    }
  }

  #interrupt(timestamp: number): void {
    const active = this.#active;
    if (!active) {
      return;
    }
    this.bus.publish("interruption", { utteranceId: active.id, timestamp });
    this.#finishUtterance(active, true);
    this.#setState("user-speaking");
  }

  #clearInterruptTimer(): void {
    if (this.#interruptTimer !== undefined) {
      clearTimeout(this.#interruptTimer);
      this.#interruptTimer = undefined;
    }
  }

  #setState(state: ConversationState): void {
    if (this.#state === state) {
      return;
    }
    this.#logger.debug(`conversation state: ${this.#state} -> ${state}`);
    this.#state = state;
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
    const wasStarting = this.#phase === "starting";
    this.#phase = "ending";
    // 1. Stop accepting inbound audio.
    this.#pendingInbound.length = 0;
    this.#clearInterruptTimer();
    // 2. Abort in-flight work; resolve a pending say() as interrupted.
    this.#abort.abort();
    const active = this.#active;
    if (active) {
      this.#finishUtterance(active, true);
    }
    // Let an in-flight stage attach settle (it observes phase/signal).
    if (wasStarting || this.#stageHandles.length < this.#stages.length) {
      await this.#awaitStartSettled();
    }
    // 3. Dispose stages in reverse attach order; each closes its upstream.
    for (const handle of [...this.#stageHandles].reverse()) {
      try {
        await handle.dispose();
      } catch (err) {
        this.#logger.error("stage dispose threw", { error: toError(err) });
      }
    }
    this.#stageHandles.length = 0;
    // 4. (Session state is dropped with the bus below.)
    // 5. Flush telemetry.
    this.telemetry.flush();
    // 6. Exactly one terminal event, on every path.
    const event: CallEventMap["call-ended"] = {
      sessionId: this.id,
      reason,
      ...(error === undefined ? {} : { error }),
    };
    this.bus.publish("call-ended", event);
    this.#endedResolve(event);
    // 7. Close the bus and release the session.
    this.bus.close();
    this.#phase = "ended";
    this.#onClosed?.(this);
  }

  async #awaitStartSettled(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), TEARDOWN_START_SETTLE_MS);
    });
    const outcome = await Promise.race([
      this.#startPromise.then(() => "settled" as const),
      timeout,
    ]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      this.#logger.warn(
        "stage attach did not settle within teardown deadline; disposing what attached"
      );
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
