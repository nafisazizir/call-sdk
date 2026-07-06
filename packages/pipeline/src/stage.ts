import {
  type CallEventMap,
  type CallEventType,
  CallSdkError,
  type EventBus,
  type Logger,
} from "call-sdk";

/**
 * The pipeline's stage contract — one `Stage` per processing unit (VAD,
 * STT, turn detection, TTS, or custom), attached per-session by
 * `attachVoice`. Stages are event-driven, not stream transforms: a VAD
 * emits signals, an STT emits many events per utterance, turn detection
 * emits a decision — so they compose over the session's typed bus rather
 * than as a chain of byte pipes.
 */

/** Per-session context handed to `Stage.attach`. */
export interface StageContext {
  /** The pipeline's event bus — subscribe to `consumes`, publish `emits`. */
  readonly bus: EventBus<CallEventMap>;
  /**
   * Surface an upstream failure as a session-level error (never stall
   * silently). `fatal` defaults to true: the call ends gracefully. v1 does
   * no automatic recovery.
   */
  fail(error: Error, opts?: { fatal?: boolean }): void;
  /** Child logger tagged with the stage name. */
  readonly logger: Logger;
  /** Record a telemetry mark attributed to this stage. */
  mark(name: string, detail?: Record<string, unknown>): void;
  readonly sessionId: string;
  /** Aborted when the voice session detaches — cancel in-flight upstream work on it. */
  readonly signal: AbortSignal;
}

/** The per-session half of a stage, returned by `attach`. */
export interface StageHandle {
  /**
   * Called at detach/teardown, in reverse attach order. Closes the stage's
   * own upstream connection. Must not throw (errors are logged, not
   * propagated).
   */
  dispose(): void | Promise<void>;
}

/**
 * A pipeline stage: a named, factory-configured unit instantiated once per
 * call. The object returned by `create${Name}Stage(config)` IS the
 * configured factory; `attachVoice` calls `attach` for each new session, so
 * stages never share mutable state across calls.
 */
export interface Stage {
  /**
   * Per-session instantiation. Opens upstream connections, subscribes to
   * `ctx.bus`, returns the disposable per-session handle. Runs in
   * configuration order; awaited before queued `say()` calls run.
   */
  attach(ctx: StageContext): StageHandle | Promise<StageHandle>;
  /**
   * Event types this stage requires. Validated at `attachVoice(...)`: every
   * entry must be produced by core, the pipeline runtime, or another
   * configured stage.
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

/**
 * A pipeline stage's provider connection failed (a Deepgram socket, an
 * ElevenLabs stream — dropping, timing out, or failing to attach/dispose).
 * Always carries the offending stage's name.
 */
export class StageError extends CallSdkError {
  readonly stageName: string;

  constructor(message: string, stageName: string, cause?: unknown) {
    super(message, "STAGE_ERROR", cause);
    this.name = "StageError";
    this.stageName = stageName;
  }
}
