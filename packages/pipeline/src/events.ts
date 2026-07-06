import type { AudioFrame, CallEventType } from "call-sdk";

/**
 * The pipeline's semantic event taxonomy, merged into the core
 * `CallEventMap` by TypeScript declaration merging. Core's map carries only
 * transport/lifecycle events; importing anything from
 * `@call-adapter/pipeline` brings these keys into `CallEventMap` (and thus
 * `CallEventType`) transitively for the whole compilation.
 *
 * Naming rules (same as core): kebab-case; streams are nouns
 * (`audio-out`); signals are `x-start`/`x-end` pairs; facts are past-tense;
 * **`agent-say` is the sole command event** — every other event announces a
 * fact, only `agent-say` requests that the pipeline *do* something
 * (synthesize and play this text). `interruption` is a fact: the pipeline
 * runtime, not the publisher, executes the consequences (abort TTS, flush
 * the adapter queue).
 */

export interface TranscriptFinalEvent {
  confidence?: number;
  endMs?: number;
  startMs?: number;
  text: string;
}

declare module "call-sdk" {
  interface CallEventMap {
    /**
     * A fact from the TTS stage: no further `audio-out` frames will be
     * published for this utterance. The runtime uses it to arm
     * playback-completion detection.
     */
    "agent-generation-end": { utteranceId: string };
    "agent-say": {
      utteranceId: string;
      text: string | AsyncIterable<string>;
      signal: AbortSignal;
    };
    "agent-speech-end": { utteranceId: string; interrupted: boolean };
    "agent-speech-start": { utteranceId: string };
    "audio-out": { frame: AudioFrame; utteranceId: string };
    "end-of-turn": {
      transcript: string;
      turnIndex: number;
      finals: TranscriptFinalEvent[];
    };
    interruption: { utteranceId: string; timestamp: number };
    "speech-end": { timestamp: number; durationMs: number };
    "speech-start": { timestamp: number };
    "stt-endpoint": { timestamp: number };
    "transcript-final": TranscriptFinalEvent;
    "transcript-interim": { text: string; timestamp: number };
  }
}

/** Runtime list of the event types this package adds to `CallEventMap`. */
export const PIPELINE_EVENT_TYPES: readonly CallEventType[] = [
  "agent-generation-end",
  "agent-say",
  "agent-speech-end",
  "agent-speech-start",
  "audio-out",
  "end-of-turn",
  "interruption",
  "speech-end",
  "speech-start",
  "stt-endpoint",
  "transcript-final",
  "transcript-interim",
];
