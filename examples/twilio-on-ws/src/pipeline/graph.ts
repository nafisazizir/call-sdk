import {
  CallConfigError,
  type CallEventType,
  CORE_CALL_EVENT_TYPES,
  type Logger,
} from "call-sdk";
import type { Stage } from "./stage";

/**
 * Events available to every stage without any producer stage being
 * configured: everything the core session publishes (transport/lifecycle,
 * forwarded onto the pipeline bus) plus what the voice runtime itself
 * publishes (`agent-say` from `say()`, the agent-speech signals, and
 * `interruption`).
 */
export const PIPELINE_PRODUCED_EVENTS: readonly CallEventType[] = [
  ...CORE_CALL_EVENT_TYPES,
  "agent-say",
  "agent-speech-start",
  "agent-speech-end",
  "interruption",
];

/** Actionable hints for the most common missing-producer mistakes. */
const MISSING_PRODUCER_HINTS: Partial<Record<CallEventType, string>> = {
  "transcript-final":
    "add a transcription stage such as createDeepgramStage()",
  "transcript-interim":
    "add a transcription stage such as createDeepgramStage()",
  "speech-start": "add a VAD stage such as createEnergyVadStage()",
  "speech-end": "add a VAD stage such as createEnergyVadStage()",
  "end-of-turn": "add a turn-detection stage such as createSilenceTurnStage()",
  "audio-out": "add a TTS stage such as createElevenLabsStage()",
};

/** Events where two producers is almost certainly a misconfiguration. */
const SINGLE_PRODUCER_EVENTS: readonly CallEventType[] = [
  "end-of-turn",
  "audio-out",
];

export interface ValidateStageGraphOptions {
  /** Set when the developer registered `onEndOfTurn` — it must be reachable. */
  hasEndOfTurnHandler?: boolean;
  /** Set when the developer registered `onTranscript`. */
  hasTranscriptHandler?: boolean;
  logger: Logger;
}

/**
 * Validates the stage graph at `new Call(...)` time so miswiring fails at
 * setup, not mid-call (SPEC.md, stage contract). Every stage's required
 * `consumes` must be produced by core or by some configured stage's `emits`.
 */
export function validateStageGraph(
  stages: readonly Stage[],
  options: ValidateStageGraphOptions
): void {
  const producers = new Map<CallEventType, string[]>();
  for (const type of PIPELINE_PRODUCED_EVENTS) {
    producers.set(type, ["core"]);
  }
  for (const stage of stages) {
    for (const type of stage.emits) {
      const list = producers.get(type) ?? [];
      list.push(stage.name);
      producers.set(type, list);
    }
  }

  for (const stage of stages) {
    for (const type of stage.consumes) {
      if (producers.has(type)) {
        continue;
      }
      const hint = MISSING_PRODUCER_HINTS[type];
      throw new CallConfigError(
        `Stage "${stage.name}" consumes "${type}" but nothing in the configured pipeline emits it${hint ? ` — ${hint}` : ""}`
      );
    }
  }

  for (const type of SINGLE_PRODUCER_EVENTS) {
    const list = producers.get(type);
    if (list && list.length > 1) {
      options.logger.warn(
        `Multiple stages emit "${type}" (${list.join(", ")}) — this is almost certainly a misconfiguration`
      );
    }
  }

  if (options.hasEndOfTurnHandler && !producers.has("end-of-turn")) {
    throw new CallConfigError(
      `onEndOfTurn is registered but nothing in the configured pipeline emits "end-of-turn" — ${MISSING_PRODUCER_HINTS["transcript-final"]} (the default turn-detection stage needs transcripts to gate on)`
    );
  }
  if (options.hasTranscriptHandler && !producers.has("transcript-final")) {
    options.logger.warn(
      `onTranscript is registered but nothing in the configured pipeline emits "transcript-final" — the handler will never fire; ${MISSING_PRODUCER_HINTS["transcript-final"]}`
    );
  }
}
