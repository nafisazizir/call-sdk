import type { AudioFrame } from "./audio/format.js";
import type { TelemetryMark } from "./telemetry.js";

/**
 * The Call SDK event taxonomy.
 *
 * This is the public shape of the typed event bus (see SPEC.md, "The Audio
 * Processing Pipeline" — "The stage interface is event-driven, not
 * stream-transform"). Naming rules, so new event types stay consistent:
 *
 * - **kebab-case** event type names throughout.
 * - **Streams are nouns**: `audio-frame`, `audio-out` — data flowing
 *   continuously, not a thing happening once.
 * - **Signals are `x-start` / `x-end` pairs**: `speech-start`/`speech-end`,
 *   `agent-speech-start`/`agent-speech-end` — a bounded interval of
 *   something being true.
 * - **Lifecycle events are past-tense facts**: `call-started`,
 *   `call-answered`, `call-ended` — something that has already happened,
 *   not a request for something to happen.
 * - **`agent-say` is the sole command event.** Every other event in this
 *   map is a fact being announced (something happened / is happening); only
 *   `agent-say` requests that the SDK *do* something (synthesize and play
 *   this text). Keeping exactly one command event, and naming it as a verb
 *   rather than a fact, makes the fact/command distinction visible at a
 *   glance in consumer code.
 * - **`interruption` is a fact, not a command.** It reports that a barge-in
 *   was detected; core (not the publisher) is responsible for executing the
 *   consequences (stopping TTS generation, flushing the adapter's outbound
 *   queue). Consumers that only want to *observe* interruptions never need
 *   to worry about accidentally causing one by handling the event.
 */

export type CallEndReason = "hangup" | "media-closed" | "local-end" | "error";

export interface TranscriptFinalEvent {
  confidence?: number;
  endMs?: number;
  startMs?: number;
  text: string;
}

export interface CallEventMap {
  "agent-say": {
    utteranceId: string;
    text: string | AsyncIterable<string>;
    signal: AbortSignal;
  };
  "agent-speech-end": { utteranceId: string; interrupted: boolean };
  "agent-speech-start": { utteranceId: string };
  "audio-frame": { frame: AudioFrame };
  "audio-out": { frame: AudioFrame; utteranceId: string };
  "call-answered": { sessionId: string };
  "call-ended": { sessionId: string; reason: CallEndReason; error?: Error };
  "call-started": {
    sessionId: string;
    direction: "inbound" | "outbound";
    from?: string;
    to?: string;
  };
  "end-of-turn": {
    transcript: string;
    turnIndex: number;
    finals: TranscriptFinalEvent[];
  };
  error: { error: Error; source: string; fatal: boolean };
  interruption: { utteranceId: string; timestamp: number };
  "speech-end": { timestamp: number; durationMs: number };
  "speech-start": { timestamp: number };
  "stt-endpoint": { timestamp: number };
  telemetry: { mark: TelemetryMark };
  "transcript-final": TranscriptFinalEvent;
  "transcript-interim": { text: string; timestamp: number };
}

export type CallEventType = keyof CallEventMap;
