import type { TelemetryMark } from "call-sdk";
import type { TurnLatencySummary, VoiceSession } from "./pipeline/index.js";

/**
 * Per-turn latency waterfall. Turns "the call feels slow" into a labeled
 * breakdown of where the milliseconds actually go, using the marks the SDK
 * already records (SessionTelemetry). Call it right after `voice.say(...)`
 * resolves — by then every mark for the turn has landed.
 *
 * The segments, caller-silence to first agent audio:
 *   turn-detect  speech-end -> end-of-turn      (silenceMs / finalGraceMs)
 *   stt-final    end-of-turn -> transcript-final (Deepgram; <=0 = STT wasn't the blocker)
 *   llm-first    say-called  -> tts-request      (LLM time to first sentence)
 *   tts-ttfb     tts-request -> tts-first-byte   (ElevenLabs time to first byte)
 */
export function printTurnLatency(voice: VoiceSession): void {
  const turn = voice.turns.at(-1);
  if (!turn) {
    return;
  }
  const line = formatTurnLatency(turn, voice.session.telemetry.marks);
  // eslint-disable-next-line no-console
  console.log(line);
}

interface Segment {
  /** Segments the operator can actually tune; the bottleneck banner ranks these. */
  actionable: boolean;
  label: string;
  ms: number | undefined;
}

export function formatTurnLatency(
  turn: TurnLatencySummary,
  marks: readonly TelemetryMark[]
): string {
  // LLM vs TTS split needs the stage-level marks the summary doesn't carry.
  const ttsRequestAt = firstMarkAtOrAfter(
    marks,
    "tts-request",
    turn.endOfTurnAt
  );
  const ttsFirstByteAt = firstMarkAtOrAfter(
    marks,
    "tts-first-byte",
    ttsRequestAt
  );

  const segments: Segment[] = [
    {
      label: "turn-detect (silence wait)",
      ms: delta(turn.speechEndAt, turn.endOfTurnAt),
      actionable: true,
    },
    {
      label: "stt-final",
      ms: delta(turn.endOfTurnAt, turn.transcriptFinalAt),
      actionable: true,
    },
    {
      label: "llm-first-sentence",
      ms: delta(turn.sayCalledAt, ttsRequestAt),
      actionable: true,
    },
    {
      label: "tts-first-byte",
      ms: delta(ttsRequestAt, ttsFirstByteAt),
      actionable: true,
    },
    {
      // Fallback span when the stage marks are missing, so the total still reconciles.
      label: "tts-audio-out",
      ms: delta(ttsFirstByteAt ?? turn.sayCalledAt, turn.firstTtsAudioAt),
      actionable: false,
    },
  ];

  const bottleneck = segments
    .filter((s) => s.actionable && s.ms !== undefined && s.ms > 0)
    .sort((a, b) => (b.ms as number) - (a.ms as number))[0];

  const rows = segments
    .map((s) => {
      const val =
        s.ms === undefined ? "  —  " : `${Math.round(s.ms)}ms`.padStart(7);
      const flag =
        bottleneck && s.label === bottleneck.label ? "  <-- bottleneck" : "";
      return `    ${s.label.padEnd(28)} ${val}${flag}`;
    })
    .join("\n");

  const v2v =
    turn.voiceToVoiceMs === undefined
      ? "?"
      : `${Math.round(turn.voiceToVoiceMs)}ms`;
  const resp =
    turn.responseLatencyMs === undefined
      ? "?"
      : `${Math.round(turn.responseLatencyMs)}ms`;

  return (
    `[latency] turn ${turn.turnIndex}  voice->voice ${v2v}  (response ${resp})\n` +
    rows
  );
}

function delta(
  from: number | undefined,
  to: number | undefined
): number | undefined {
  if (from === undefined || to === undefined) {
    return undefined;
  }
  return to - from;
}

function firstMarkAtOrAfter(
  marks: readonly TelemetryMark[],
  name: string,
  at: number | undefined
): number | undefined {
  if (at === undefined) {
    return undefined;
  }
  for (const mark of marks) {
    if (mark.name === name && mark.at >= at) {
      return mark.at;
    }
  }
  return undefined;
}
