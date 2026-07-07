import type { AudioFrame } from "./audio/format";
import type { TelemetryMark } from "./telemetry";

/**
 * The core event taxonomy: transport and lifecycle facts only.
 *
 * The core stops at the media boundary — call lifecycle, normalized audio
 * frames, provider playback marks, errors, telemetry. Everything semantic
 * (speech, transcripts, turns, agent speech) belongs to the consumer's
 * pipeline: a consumer merges its event types into this map via TypeScript
 * declaration merging (`declare module "call-sdk"`), so `CallEventMap`
 * widens automatically — see `examples/twilio-on-ws/src/pipeline/events.ts`.
 *
 * Naming rules, so new event types stay consistent:
 *
 * - **kebab-case** event type names throughout.
 * - **Streams are nouns**: `audio-frame` — data flowing continuously, not a
 *   thing happening once.
 * - **Lifecycle events are past-tense facts**: `call-started`,
 *   `call-answered`, `call-ended` — something that has already happened,
 *   not a request for something to happen.
 * - **Every core event is a fact.** Command events (requests that the SDK
 *   take an action) are a pipeline concept, and there is exactly one
 *   (`agent-say`).
 */

export type CallEndReason = "hangup" | "media-closed" | "local-end" | "error";

export interface CallEventMap {
  "audio-frame": { frame: AudioFrame };
  /**
   * The provider echoed a playback mark previously requested via
   * `SessionAudio.mark()` — playback has reached that point in the outbound
   * queue. A byte-plane fact from the adapter, not a semantic event.
   */
  "audio-mark": { name: string };
  "call-answered": { sessionId: string };
  "call-ended": { sessionId: string; reason: CallEndReason; error?: Error };
  "call-started": {
    sessionId: string;
    direction: "inbound" | "outbound";
    from?: string;
    to?: string;
  };
  error: { error: Error; source: string; fatal: boolean };
  telemetry: { mark: TelemetryMark };
}

export type CallEventType = keyof CallEventMap;

/**
 * Runtime list of the core-owned event types. Note this is intentionally
 * NOT `keyof CallEventMap` materialized — declaration merging widens the
 * type, but the core only ever publishes these.
 */
export const CORE_CALL_EVENT_TYPES: readonly CallEventType[] = [
  "audio-frame",
  "audio-mark",
  "call-answered",
  "call-ended",
  "call-started",
  "error",
  "telemetry",
];
