import type {
  CallEventMap,
  EventBus,
  SessionTelemetry,
  TelemetryMark,
  Unsubscribe,
} from "call-sdk";

/**
 * Per-turn latency summaries derived from telemetry marks. Core records the
 * marks (its `SessionTelemetry` owns the byte-boundary ones); this module
 * owns everything that requires knowing what a *turn* is — which is
 * semantics, and therefore the pipeline's.
 */
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
 * Derives per-turn latency summaries from a session's telemetry marks
 * (`session.telemetry.marks`). Pure — call it any time, typically after
 * `end-of-turn` or at call end.
 */
export function computeTurnLatency(
  marks: readonly TelemetryMark[]
): TurnLatencySummary[] {
  const endOfTurnEntries = marks.reduce<
    { mark: TelemetryMark; index: number }[]
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

/**
 * Auto-marks the pipeline's semantic boundary events onto the session's
 * telemetry (speech, transcripts, turns, TTS-out, interruptions). The
 * byte-boundary marks (`first-audio-frame`, `call-ended`) stay with core's
 * own `SessionTelemetry.observe`. Returns an unsubscribe-all function.
 */
export function observeSemanticMarks(
  bus: EventBus<CallEventMap>,
  telemetry: SessionTelemetry
): () => void {
  const unsubs: Unsubscribe[] = [];
  let interimMarkedForCurrentTurn = false;
  let currentTurnIndex = 0;
  const seenUtteranceAudioOut = new Set<string>();

  unsubs.push(
    bus.subscribe("speech-start", () => {
      telemetry.mark("speech-start");
    }),
    bus.subscribe("speech-end", () => {
      telemetry.mark("speech-end");
    }),
    bus.subscribe("transcript-interim", () => {
      if (!interimMarkedForCurrentTurn) {
        interimMarkedForCurrentTurn = true;
        telemetry.mark("first-transcript-interim", {
          turnIndex: currentTurnIndex,
        });
      }
    }),
    bus.subscribe("transcript-final", () => {
      telemetry.mark("transcript-final");
    }),
    bus.subscribe("end-of-turn", (payload) => {
      telemetry.mark("end-of-turn", { turnIndex: payload.turnIndex });
      currentTurnIndex = payload.turnIndex + 1;
      interimMarkedForCurrentTurn = false;
    }),
    bus.subscribe("audio-out", (payload) => {
      if (!seenUtteranceAudioOut.has(payload.utteranceId)) {
        seenUtteranceAudioOut.add(payload.utteranceId);
        // Same moment in v1 (TTS audio becomes outbound audio directly);
        // kept as two named marks since they answer different questions in
        // the turn summary (TTS latency vs. adapter write latency), and a
        // future stage could split them apart.
        telemetry.mark("tts-first-audio", { utteranceId: payload.utteranceId });
        telemetry.mark("first-outbound-write", {
          utteranceId: payload.utteranceId,
        });
      }
    }),
    bus.subscribe("interruption", () => {
      telemetry.mark("interruption");
    })
  );

  return () => {
    for (const unsubscribe of unsubs) {
      unsubscribe();
    }
  };
}
