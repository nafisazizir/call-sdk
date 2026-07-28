import {
  type AudioFrame,
  type CallEventMap,
  type CallEventType,
  type CallSession,
  childLogger,
  createLogger,
  EventBus,
  type EventMeta,
  frameDurationMs,
  type Logger,
  type LogLevel,
  type Unsubscribe,
} from "call-sdk";
import { chunkSentences } from "./audio/sentences";
import { validateStageGraph } from "./graph";
import type { Stage, StageContext, StageHandle } from "./stage";
import { createEnergyVadStage } from "./stages/energy-vad";
import { createSilenceTurnStage } from "./stages/silence-turn";
import {
  computeTurnLatency,
  observeSemanticMarks,
  type TurnLatencySummary,
} from "./telemetry";

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

export interface VoiceOptions {
  interruption?: {
    /**
     * Require this much sustained caller speech before an utterance is
     * interrupted. Default 0 — the VAD's own activation debounce is the
     * primary guard against noise-triggered barge-in.
     */
    minSpeechMs?: number;
  };
  logger?: Logger | LogLevel;
  onEndOfTurn?: (
    turn: CallEventMap["end-of-turn"],
    voice: VoiceSession
  ) => void | Promise<void>;
  onInterruption?: (
    interruption: CallEventMap["interruption"],
    voice: VoiceSession
  ) => void | Promise<void>;
  onTranscript?: (
    transcript: CallEventMap["transcript-final"],
    voice: VoiceSession
  ) => void | Promise<void>;
  /**
   * Pipeline stages, in attach order. Sensible defaults are prepended
   * automatically: an energy VAD unless a configured stage emits
   * `speech-start`, and silence-based turn detection unless a configured
   * stage emits `end-of-turn` (injected only when a transcription stage is
   * present to gate on).
   */
  stages: Stage[];
}

/**
 * The voice/conversation layer attached to one media-plane call: the stage
 * graph, `say()`, the transcript, the conversation state machine, and
 * barge-in policy. Built entirely on `CallSession`'s public surface —
 * `session.bus`, `session.audio`, `session.telemetry` — the same surface any
 * consumer gets.
 */
export interface VoiceSession {
  /**
   * The pipeline's own event bus — the stage graph's spine. Core transport
   * events (`audio-frame`, lifecycle, `audio-mark`, `telemetry`, `error`)
   * are forwarded onto it from attach time onward; semantic events
   * (`transcript-*`, `end-of-turn`, `agent-*`, ...) originate here.
   */
  readonly bus: EventBus<CallEventMap>;
  /**
   * Dispose the stage graph (reverse attach order) without ending the call.
   * Idempotent; runs automatically at call teardown, before the terminal
   * `call-ended` event.
   */
  detach(): Promise<void>;
  on<K extends CallEventType>(
    type: K,
    handler: (payload: CallEventMap[K], meta: EventMeta) => void
  ): Unsubscribe;
  /**
   * Speak on the call. Publishes `agent-say` for the TTS stage; resolves
   * when playback completes or the utterance is interrupted (barge-in,
   * `stopSpeaking()`, a newer `say()`, or teardown). Accepts a plain string
   * or a streaming text source — `streamText().textStream` pipes straight
   * in, sentence-chunked so synthesis starts on the first sentence. Calls
   * made while stages are still attaching are queued and run in order once
   * the graph is live.
   */
  say(text: string | AsyncIterable<string>): Promise<SayResult>;
  /** The underlying media-plane call. */
  readonly session: CallSession;
  readonly state: ConversationState;
  /** Immediately stop agent playback (manual barge-in): abort TTS and flush the provider queue. */
  stopSpeaking(): void;
  /** Conversation history from user turns and agent utterances — ready to map into LLM messages. */
  readonly transcript: readonly TranscriptEntry[];
  /** Per-turn latency summaries derived from the session's telemetry marks. */
  readonly turns: readonly TurnLatencySummary[];
}

/**
 * Prepends the default stages the pipeline ships unless the consumer's own
 * stages already cover the role.
 */
export function resolveStages(stages: readonly Stage[]): Stage[] {
  const userEmits = new Set(stages.flatMap((stage) => [...stage.emits]));
  const defaults: Stage[] = [];
  if (!userEmits.has("speech-start")) {
    defaults.push(createEnergyVadStage());
  }
  if (!userEmits.has("end-of-turn") && userEmits.has("transcript-final")) {
    defaults.push(createSilenceTurnStage());
  }
  return [...defaults, ...stages];
}

/**
 * Attaches the voice pipeline to a media-plane call. Validates the stage
 * graph synchronously (throws `CallConfigError` on miswiring) and returns
 * immediately; stages attach in the background while inbound audio is
 * buffered and `say()` calls queue. Typically called from
 * `call.onCallStarted` (after `incoming.stream()`) or on `dial()`'s session
 * — before the handler's first `await`, so no audio is missed.
 */
export function attachVoice(
  session: CallSession,
  options: VoiceOptions
): VoiceSession {
  return new VoiceSessionImpl(session, options);
}

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

interface PendingSay {
  resolve: (result: Promise<SayResult>) => void;
  text: string | AsyncIterable<string>;
}

/** Grace added to the duration-based playback fallback timer. */
const PLAYBACK_FALLBACK_SLACK_MS = 60;
/** How long inbound audio is buffered while stages attach (in 20 ms frames). */
const MAX_PENDING_INBOUND_FRAMES = 250;

/** Core transport events forwarded from the session bus onto the pipeline bus. */
const FORWARDED_EVENTS: readonly CallEventType[] = [
  "call-started",
  "call-answered",
  "audio-mark",
  "error",
  "telemetry",
];

type VoicePhase = "attaching" | "live" | "detached";

class VoiceSessionImpl implements VoiceSession {
  readonly bus: EventBus<CallEventMap>;
  readonly session: CallSession;

  #phase: VoicePhase = "attaching";
  #state: ConversationState = "idle";
  readonly #options: VoiceOptions;
  readonly #stages: readonly Stage[];
  readonly #logger: Logger;
  readonly #abort = new AbortController();
  readonly #unsubscribes: Unsubscribe[] = [];
  readonly #stageHandles: StageHandle[] = [];
  readonly #pendingInbound: AudioFrame[] = [];
  readonly #pendingSays: PendingSay[] = [];
  readonly #transcript: TranscriptEntry[] = [];
  readonly #stopObservingMarks: () => void;
  #droppedPendingWarned = false;
  #detachPromise?: Promise<void>;
  #cachedTurns?: readonly TurnLatencySummary[];
  #active?: ActiveUtterance;
  #utteranceCounter = 0;
  #turnIndex = 0;
  #vadSpeaking = false;
  #interruptTimer?: ReturnType<typeof setTimeout>;

  constructor(session: CallSession, options: VoiceOptions) {
    this.session = session;
    this.#options = options;
    this.#logger = childLogger(createLogger(options.logger), {
      sessionId: session.id,
      layer: "voice",
    });
    this.#stages = resolveStages(options.stages);
    validateStageGraph(this.#stages, {
      logger: this.#logger,
      hasEndOfTurnHandler: Boolean(options.onEndOfTurn),
      hasTranscriptHandler: Boolean(options.onTranscript),
    });

    this.bus = new EventBus(session.id, {
      logger: this.#logger,
      onListenerError: (error, type) =>
        this.#publishError(error, `listener:${type}`, false),
    });

    // Runtime subscriptions first, then telemetry, then the consumer
    // bridges — subscription order is dispatch order, so `transcript`
    // already contains the latest user turn when `onEndOfTurn` fires.
    this.#subscribeRuntime();
    this.#stopObservingMarks = observeSemanticMarks(
      this.bus,
      session.telemetry
    );
    this.#bridge("end-of-turn", options.onEndOfTurn, "onEndOfTurn");
    this.#bridge("transcript-final", options.onTranscript, "onTranscript");
    this.#bridge("interruption", options.onInterruption, "onInterruption");

    this.#subscribeForwarding();

    // Dispose the stage graph during call teardown, BEFORE the terminal
    // call-ended event: consumer-attached media resources go first.
    session.registerCleanup(() => this.#disposeGraph());

    void this.#attach();
  }

  get state(): ConversationState {
    return this.#state;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.#transcript;
  }

  get turns(): readonly TurnLatencySummary[] {
    return (
      this.#cachedTurns ?? computeTurnLatency(this.session.telemetry.marks)
    );
  }

  on<K extends CallEventType>(
    type: K,
    handler: (payload: CallEventMap[K], meta: EventMeta) => void
  ): Unsubscribe {
    return this.bus.subscribe(type, handler);
  }

  say(text: string | AsyncIterable<string>): Promise<SayResult> {
    if (this.#phase === "attaching") {
      return new Promise<SayResult>((resolveOuter) => {
        this.#pendingSays.push({
          text,
          resolve: (result) => resolveOuter(result),
        });
      });
    }
    return this.#say(text);
  }

  stopSpeaking(): void {
    const active = this.#active;
    if (active) {
      this.#finishUtterance(active, true);
    }
  }

  detach(): Promise<void> {
    if (!this.#detachPromise) {
      this.#detachPromise = this.#runDetach();
    }
    return this.#detachPromise;
  }

  // -------------------------------------------------------------------------
  // Attach / detach
  // -------------------------------------------------------------------------

  async #attach(): Promise<void> {
    for (const stage of this.#stages) {
      if (this.#phase !== "attaching") {
        return; // detached while attaching
      }
      try {
        const handle = await stage.attach(this.#makeStageContext(stage));
        this.#stageHandles.push(handle);
      } catch (err) {
        this.#publishError(
          toError(err),
          `stage-attach:${stage.name}`,
          true // fatal: the session cannot run with a broken pipeline
        );
        return;
      }
    }
    if (this.#phase !== "attaching") {
      return;
    }
    this.#phase = "live";
    const buffered = this.#pendingInbound.splice(0);
    for (const frame of buffered) {
      this.bus.publish("audio-frame", { frame });
    }
    const sayQueue = this.#pendingSays.splice(0);
    for (const pending of sayQueue) {
      pending.resolve(this.#say(pending.text));
    }
  }

  /**
   * Stage-graph teardown half of detach: dispose handles in reverse attach
   * order and resolve any active utterance as interrupted. Runs during call
   * teardown (via `session.registerCleanup`) so provider connections close
   * before `call-ended`; the bus itself stays open until the terminal event
   * has been forwarded.
   */
  async #disposeGraph(): Promise<void> {
    if (this.#phase === "detached") {
      return;
    }
    this.#phase = "detached";
    this.#clearInterruptTimer();
    this.#abort.abort();
    const active = this.#active;
    if (active) {
      this.#finishUtterance(active, true);
    }
    for (const pending of this.#pendingSays.splice(0)) {
      pending.resolve(
        Promise.resolve({ interrupted: true, utteranceId: "utt_queued" })
      );
    }
    this.#pendingInbound.length = 0;
    for (const handle of [...this.#stageHandles].reverse()) {
      try {
        await handle.dispose();
      } catch (err) {
        this.#logger.error("stage dispose threw", { error: toError(err) });
      }
    }
    this.#stageHandles.length = 0;
  }

  async #runDetach(): Promise<void> {
    await this.#disposeGraph();
    this.#finishBus();
  }

  /** Unsubscribes forwarding and closes the pipeline bus. */
  #finishBus(): void {
    this.#cachedTurns = computeTurnLatency(this.session.telemetry.marks);
    this.#stopObservingMarks();
    for (const unsubscribe of this.#unsubscribes.splice(0)) {
      unsubscribe();
    }
    if (!this.bus.closed) {
      this.bus.close();
    }
  }

  // -------------------------------------------------------------------------
  // Session-bus → pipeline-bus forwarding
  // -------------------------------------------------------------------------

  #subscribeForwarding(): void {
    const sessionBus = this.session.bus;
    this.#unsubscribes.push(
      sessionBus.subscribe("audio-frame", (payload) => {
        if (this.#phase === "detached" || this.bus.closed) {
          return;
        }
        if (this.#phase === "attaching") {
          if (this.#pendingInbound.length >= MAX_PENDING_INBOUND_FRAMES) {
            this.#pendingInbound.shift();
            if (!this.#droppedPendingWarned) {
              this.#droppedPendingWarned = true;
              this.#logger.warn(
                "inbound audio buffer overflowed while stages were attaching; dropping oldest frames"
              );
            }
          }
          this.#pendingInbound.push(payload.frame);
          return;
        }
        this.bus.publish("audio-frame", payload);
      })
    );
    for (const type of FORWARDED_EVENTS) {
      this.#unsubscribes.push(
        sessionBus.subscribe(type, (payload) => {
          if (!this.bus.closed) {
            this.bus.publish(type, payload as never);
          }
        })
      );
    }
    // The terminal event: forward it, then wind the pipeline bus down —
    // graph disposal already ran via the session's cleanup hook.
    this.#unsubscribes.push(
      sessionBus.subscribe("call-ended", (payload) => {
        if (!this.bus.closed) {
          this.bus.publish("call-ended", payload);
        }
        this.#finishBus();
      })
    );
  }

  // -------------------------------------------------------------------------
  // Stage plumbing
  // -------------------------------------------------------------------------

  #makeStageContext(stage: Stage): StageContext {
    return {
      sessionId: this.session.id,
      bus: this.bus,
      logger: childLogger(this.#logger, { stage: stage.name }),
      signal: this.#abort.signal,
      mark: (name, detail) =>
        void this.session.telemetry.mark(name, {
          ...detail,
          stage: stage.name,
        }),
      fail: (error, opts) =>
        this.#publishError(error, `stage:${stage.name}`, opts?.fatal ?? true),
    };
  }

  /**
   * Surfaces an error at the session level: the core session owns fatality
   * (a fatal error ends the call), and the error event is forwarded back
   * onto the pipeline bus for observers here.
   */
  #publishError(error: Error, source: string, fatal: boolean): void {
    const sessionBus = this.session.bus;
    if (sessionBus.closed) {
      this.#logger.error(`error after call end from ${source}`, { error });
      return;
    }
    sessionBus.publish("error", { error, source, fatal });
  }

  #bridge<K extends CallEventType>(
    type: K,
    handler:
      | ((
          payload: CallEventMap[K],
          voice: VoiceSession
        ) => void | Promise<void>)
      | undefined,
    name: string
  ): void {
    if (!handler) {
      return;
    }
    this.bus.subscribe(type, (payload) => {
      try {
        const result = handler(payload, this);
        if (result && typeof result.then === "function") {
          result.then(undefined, (err: unknown) => {
            this.#publishError(toError(err), `handler:${name}`, false);
          });
        }
      } catch (err) {
        this.#publishError(toError(err), `handler:${name}`, false);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Utterance lifecycle + conversation state machine (the voice runtime)
  // -------------------------------------------------------------------------

  #subscribeRuntime(): void {
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
    this.bus.subscribe("audio-mark", (payload) =>
      this.#onAudioMark(payload.name)
    );
  }

  #say(text: string | AsyncIterable<string>): Promise<SayResult> {
    this.#utteranceCounter += 1;
    const utteranceId = `utt_${this.#utteranceCounter}`;
    if (this.#phase === "detached") {
      this.#logger.warn("say() after detach — dropped");
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

    this.session.telemetry.mark("say-called", { turnIndex: this.#turnIndex });
    this.bus.publish("agent-say", {
      utteranceId,
      text: outgoing,
      signal: controller.signal,
    });
    return result;
  }

  #onAudioOut(payload: CallEventMap["audio-out"]): void {
    if (this.#phase === "detached") {
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
    this.session.audio.write(payload.frame);
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
    if (this.session.audio.canMark) {
      this.session.audio.mark(active.id);
      return;
    }
    // No provider marks: fall back to a duration-based playback timer.
    const elapsed = performance.now() - (active.firstFrameAt ?? 0);
    const remaining = Math.max(0, active.queuedMs - elapsed);
    active.fallbackTimer = setTimeout(() => {
      this.#finishUtterance(active, false);
    }, remaining + PLAYBACK_FALLBACK_SLACK_MS);
  }

  #onAudioMark(name: string): void {
    const active = this.#active;
    if (active && name === active.id) {
      this.#finishUtterance(active, false);
      return;
    }
    this.#logger.debug(`provider mark "${name}" for inactive utterance`);
  }

  /**
   * Terminates the active utterance exactly once. `interrupted: true` also
   * aborts TTS generation and flushes the provider's outbound queue —
   * stopping generation alone would leave already-buffered audio playing.
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
      this.session.audio.clear();
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

  #onSpeechStart(payload: CallEventMap["speech-start"]): void {
    this.#vadSpeaking = true;
    if (this.#state === "agent-speaking" && this.#active?.spoke) {
      const minSpeechMs = this.#options.interruption?.minSpeechMs ?? 0;
      if (minSpeechMs > 0) {
        this.#clearInterruptTimer();
        this.#interruptTimer = setTimeout(() => {
          if (
            this.#vadSpeaking &&
            this.#state === "agent-speaking" &&
            this.#active
          ) {
            this.#interrupt(payload.timestamp);
          }
        }, minSpeechMs);
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
}

async function* recordChunks(
  source: AsyncIterable<string>,
  parts: string[]
): AsyncIterable<string> {
  for await (const chunk of source) {
    parts.push(chunk);
    yield chunk;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
