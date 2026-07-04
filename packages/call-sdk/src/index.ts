// Placeholder — replaced in later milestones

/**
 * A provider adapter. Emits call lifecycle events and moves normalized audio
 * bidirectionally; contains no transcription, VAD, or turn-detection logic.
 */
export interface Adapter {
  readonly name: string;
}

/**
 * A swappable pipeline stage (VAD, transcription, turn detection, TTS, ...).
 * Configured once, instantiated per call session.
 */
export interface Stage {
  readonly name: string;
}
