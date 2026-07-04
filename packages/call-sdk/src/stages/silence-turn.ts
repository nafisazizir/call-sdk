import type { TranscriptFinalEvent } from "../events.js";
import type { Stage, StageContext, StageHandle } from "../types.js";

/**
 * Configuration for the built-in silence-based turn-detection stage.
 */
export interface SilenceTurnStageConfig {
  /** Extra wait (ms) for a lagging `transcript-final` when none has arrived yet. Default 1500. */
  finalGraceMs?: number;
  /** Silence (ms) after `speech-end` before an end-of-turn is declared. Default 800. */
  silenceMs?: number;
}

const DEFAULT_SILENCE_MS = 800;
const DEFAULT_FINAL_GRACE_MS = 1500;

/**
 * Silence-hangover turn detection: the caller has *finished their turn* once
 * their speech has ended AND stayed quiet for `silenceMs`. This is a distinct,
 * replaceable stage from VAD — "the audio went quiet" is not the same as "the
 * caller is done" (SPEC.md, "Turn detection is not silence detection").
 *
 * It gates on transcripts, not raw silence: a turn is only emitted once at
 * least one `transcript-final` has accumulated. If the silence timer fires
 * before STT has caught up, it waits out a short `finalGraceMs` window for the
 * lagging final rather than emitting an empty turn. An `stt-endpoint` signal,
 * when available, short-circuits the silence wait.
 */
export class SilenceTurnStage implements Stage {
  readonly name = "silence-turn";
  readonly consumes = [
    "speech-start",
    "speech-end",
    "transcript-final",
  ] as const;
  readonly optionalConsumes = ["stt-endpoint"] as const;
  readonly emits = ["end-of-turn"] as const;

  readonly #silenceMs: number;
  readonly #finalGraceMs: number;

  constructor(config: SilenceTurnStageConfig = {}) {
    this.#silenceMs = config.silenceMs ?? DEFAULT_SILENCE_MS;
    this.#finalGraceMs = config.finalGraceMs ?? DEFAULT_FINAL_GRACE_MS;
  }

  attach(ctx: StageContext): StageHandle {
    const finals: TranscriptFinalEvent[] = [];
    let turnIndex = 0;
    let inSilence = false;
    let disposed = false;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTurnTimer = (): void => {
      if (turnTimer !== undefined) {
        clearTimeout(turnTimer);
        turnTimer = undefined;
      }
    };
    const clearGraceTimer = (): void => {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };

    const emitTurn = (): void => {
      if (disposed || finals.length === 0) {
        return;
      }
      clearTurnTimer();
      clearGraceTimer();
      inSilence = false;
      turnIndex += 1;
      const swept = finals.splice(0);
      ctx.bus.publish("end-of-turn", {
        transcript: swept.map((final) => final.text).join(" "),
        turnIndex,
        finals: swept,
      });
    };

    const onTurnTimerFired = (): void => {
      turnTimer = undefined;
      if (disposed) {
        return;
      }
      if (finals.length > 0) {
        emitTurn();
        return;
      }
      // STT hasn't produced a final yet — wait out a grace window for it.
      graceTimer = setTimeout(onGraceExpired, this.#finalGraceMs);
    };

    const onGraceExpired = (): void => {
      graceTimer = undefined;
      if (disposed) {
        return;
      }
      if (finals.length > 0) {
        emitTurn();
        return;
      }
      // Nothing ever accumulated: a turn is not the same as silence — drop it.
      inSilence = false;
    };

    const onSpeechStart = (): void => {
      // The caller resumed talking; cancel the pending turn decision.
      clearTurnTimer();
      clearGraceTimer();
      inSilence = false;
    };

    const onSpeechEnd = (): void => {
      inSilence = true;
      clearTurnTimer();
      turnTimer = setTimeout(onTurnTimerFired, this.#silenceMs);
    };

    const onTranscriptFinal = (payload: TranscriptFinalEvent): void => {
      finals.push(payload);
      // A final that lands while we're waiting out the grace window resolves
      // the turn immediately.
      if (inSilence && graceTimer !== undefined) {
        emitTurn();
      }
    };

    const onSttEndpoint = (): void => {
      // A provider endpoint signal short-circuits the silence wait, but only
      // once speech has actually ended and we have something to emit.
      if (inSilence && finals.length > 0) {
        emitTurn();
      }
    };

    const unsubscribes = [
      ctx.bus.subscribe("speech-start", onSpeechStart),
      ctx.bus.subscribe("speech-end", onSpeechEnd),
      ctx.bus.subscribe("transcript-final", onTranscriptFinal),
      ctx.bus.subscribe("stt-endpoint", onSttEndpoint),
    ];

    return {
      dispose: () => {
        disposed = true;
        clearTurnTimer();
        clearGraceTimer();
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
      },
    };
  }
}

/** Creates a configured {@link SilenceTurnStage} factory. */
export function createSilenceTurnStage(
  config?: SilenceTurnStageConfig
): SilenceTurnStage {
  return new SilenceTurnStage(config);
}
