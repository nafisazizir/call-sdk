import type { EventBus, Unsubscribe } from "./bus.js";
import type { CallEventMap } from "./events.js";
import { createLogger, type Logger } from "./logger.js";

export interface TelemetryMark {
  at: number;
  detail?: Record<string, unknown>;
  name: string;
  sessionId: string;
  stage?: string;
  turnIndex?: number;
}

export interface TurnLatencySummary {
  endOfTurnAt?: number;
  firstOutboundWriteAt?: number;
  firstTtsAudioAt?: number;
  /** `firstOutboundWriteAt - endOfTurnAt`: how long the pipeline took to start responding after the caller finished their turn. */
  responseLatencyMs?: number;
  sayCalledAt?: number;
  speechEndAt?: number;
  transcriptFinalAt?: number;
  turnIndex: number;
  /** `firstOutboundWriteAt - speechEndAt` (last speech-end before end-of-turn): the full caller-silence-to-agent-audio gap. */
  voiceToVoiceMs?: number;
}

export type TelemetrySink = (mark: TelemetryMark) => void;

function now(): number {
  return performance.now();
}

/**
 * Finds the last mark named `name` at array position `<= uptoIndex`.
 *
 * Windowing by array index rather than by comparing `at` timestamps is
 * deliberate: marks are pushed in guaranteed arrival order, but
 * `performance.now()` can return equal values for two marks recorded within
 * the same synchronous tick (its resolution isn't unbounded), which would
 * make timestamp-based comparisons flaky. Index comparisons are exact.
 */
function lastMarkAtOrBeforeIndex(
  marks: readonly TelemetryMark[],
  name: string,
  uptoIndex: number
): TelemetryMark | undefined {
  let found: TelemetryMark | undefined;
  for (let i = 0; i <= uptoIndex; i++) {
    if (marks[i].name === name) {
      found = marks[i];
    }
  }
  return found;
}

/** Finds the first mark named `name` at array position `> afterIndex` and `< beforeIndex`. See {@link lastMarkAtOrBeforeIndex}. */
function firstMarkInIndexWindow(
  marks: readonly TelemetryMark[],
  name: string,
  afterIndex: number,
  beforeIndex: number
): TelemetryMark | undefined {
  for (let i = afterIndex + 1; i < beforeIndex && i < marks.length; i++) {
    if (marks[i].name === name) {
      return marks[i];
    }
  }
  return undefined;
}

/**
 * Per-session latency instrumentation (see SPEC.md, "Observability").
 * Records timestamped marks at every pipeline stage boundary and derives
 * per-turn latency summaries from them.
 */
export class SessionTelemetry {
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly sink: TelemetrySink;
  private readonly _marks: TelemetryMark[] = [];

  private observedBus: EventBus<CallEventMap> | undefined;
  private sawFirstAudioFrame = false;
  private interimMarkedForCurrentTurn = false;
  private currentTurnIndex = 0;
  private readonly seenUtteranceAudioOut = new Set<string>();

  private flushed = false;
  private cachedTurns: TurnLatencySummary[] | undefined;

  constructor(
    sessionId: string,
    opts: { sink?: TelemetrySink; logger?: Logger } = {}
  ) {
    this.sessionId = sessionId;
    this.logger = opts.logger ?? createLogger();
    this.sink =
      opts.sink ??
      ((mark) => this.logger.debug(`telemetry: ${mark.name}`, { mark }));
  }

  get marks(): readonly TelemetryMark[] {
    return this._marks;
  }

  get turns(): readonly TurnLatencySummary[] {
    if (this.flushed && this.cachedTurns) {
      return this.cachedTurns;
    }
    return this.computeTurns();
  }

  /**
   * Records a mark, forwards it to the sink, and — if `observe()` has been
   * called — republishes it onto the bus as a `"telemetry"` event.
   */
  mark(
    name: string,
    detail?: Record<string, unknown> & { stage?: string; turnIndex?: number }
  ): TelemetryMark {
    const { stage, turnIndex, ...rest } = detail ?? {};
    const mark: TelemetryMark = {
      sessionId: this.sessionId,
      name,
      at: now(),
      ...(stage === undefined ? {} : { stage }),
      ...(turnIndex === undefined ? {} : { turnIndex }),
      ...(Object.keys(rest).length > 0 ? { detail: rest } : {}),
    };
    this._marks.push(mark);
    this.sink(mark);
    if (this.observedBus && !this.observedBus.closed) {
      this.observedBus.publish("telemetry", { mark });
    }
    return mark;
  }

  /**
   * Subscribes to `bus` and auto-marks the pipeline's boundary events (see
   * class docs). Never subscribes to `"telemetry"` itself — that's what
   * keeps `mark()`'s auto-republish from looping back into `observe()`.
   * Returns an unsubscribe-all function.
   */
  observe(bus: EventBus<CallEventMap>): () => void {
    this.observedBus = bus;
    const unsubs: Unsubscribe[] = [];

    unsubs.push(
      bus.subscribe("audio-frame", () => {
        if (!this.sawFirstAudioFrame) {
          this.sawFirstAudioFrame = true;
          this.mark("first-audio-frame");
        }
      })
    );
    unsubs.push(
      bus.subscribe("speech-start", () => {
        this.mark("speech-start");
      })
    );
    unsubs.push(
      bus.subscribe("speech-end", () => {
        this.mark("speech-end");
      })
    );
    unsubs.push(
      bus.subscribe("transcript-interim", () => {
        if (!this.interimMarkedForCurrentTurn) {
          this.interimMarkedForCurrentTurn = true;
          this.mark("first-transcript-interim", {
            turnIndex: this.currentTurnIndex,
          });
        }
      })
    );
    unsubs.push(
      bus.subscribe("transcript-final", () => {
        this.mark("transcript-final");
      })
    );
    unsubs.push(
      bus.subscribe("end-of-turn", (payload) => {
        this.mark("end-of-turn", { turnIndex: payload.turnIndex });
        this.currentTurnIndex = payload.turnIndex + 1;
        this.interimMarkedForCurrentTurn = false;
      })
    );
    unsubs.push(
      bus.subscribe("audio-out", (payload) => {
        if (!this.seenUtteranceAudioOut.has(payload.utteranceId)) {
          this.seenUtteranceAudioOut.add(payload.utteranceId);
          // Same moment in v1 (TTS audio becomes outbound audio directly);
          // kept as two named marks since they answer different questions
          // in the turn summary (TTS latency vs. adapter write latency),
          // and a future stage could split them apart.
          this.mark("tts-first-audio", { utteranceId: payload.utteranceId });
          this.mark("first-outbound-write", {
            utteranceId: payload.utteranceId,
          });
        }
      })
    );
    unsubs.push(
      bus.subscribe("interruption", () => {
        this.mark("interruption");
      })
    );
    unsubs.push(
      bus.subscribe("call-ended", () => {
        this.mark("call-ended");
      })
    );

    return () => {
      for (const unsubscribe of unsubs) {
        unsubscribe();
      }
      if (this.observedBus === bus) {
        this.observedBus = undefined;
      }
    };
  }

  private computeTurns(): TurnLatencySummary[] {
    const marks = this._marks;
    const endOfTurnEntries = marks.reduce<
      Array<{ mark: TelemetryMark; index: number }>
    >((acc, mark, index) => {
      if (mark.name === "end-of-turn" && mark.turnIndex !== undefined) {
        acc.push({ mark, index });
      }
      return acc;
    }, []);
    const summaries: TurnLatencySummary[] = [];

    for (let i = 0; i < endOfTurnEntries.length; i++) {
      const { mark: eot, index: eotIndex } = endOfTurnEntries[i];
      const turnIndex = eot.turnIndex as number;
      const nextEotIndex = endOfTurnEntries[i + 1]?.index ?? marks.length;

      const speechEndAt = lastMarkAtOrBeforeIndex(
        marks,
        "speech-end",
        eotIndex
      )?.at;
      const transcriptFinalAt = lastMarkAtOrBeforeIndex(
        marks,
        "transcript-final",
        eotIndex
      )?.at;
      const sayCalledAt = marks.find(
        (mark) => mark.name === "say-called" && mark.turnIndex === turnIndex
      )?.at;
      const firstTtsAudioAt = firstMarkInIndexWindow(
        marks,
        "tts-first-audio",
        eotIndex,
        nextEotIndex
      )?.at;
      const firstOutboundWriteAt = firstMarkInIndexWindow(
        marks,
        "first-outbound-write",
        eotIndex,
        nextEotIndex
      )?.at;

      let responseLatencyMs: number | undefined;
      let voiceToVoiceMs: number | undefined;
      if (firstOutboundWriteAt !== undefined) {
        responseLatencyMs = firstOutboundWriteAt - eot.at;
        if (speechEndAt !== undefined) {
          voiceToVoiceMs = firstOutboundWriteAt - speechEndAt;
        }
      }

      summaries.push({
        turnIndex,
        speechEndAt,
        transcriptFinalAt,
        endOfTurnAt: eot.at,
        sayCalledAt,
        firstTtsAudioAt,
        firstOutboundWriteAt,
        responseLatencyMs,
        voiceToVoiceMs,
      });
    }

    return summaries;
  }

  /** Computes and caches the final turn summaries. Idempotent — subsequent calls are no-ops. */
  flush(): void {
    if (this.flushed) {
      return;
    }
    this.cachedTurns = this.computeTurns();
    this.flushed = true;
  }
}
