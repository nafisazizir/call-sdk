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

// Audio DSP primitives
export {
  type AudioFrame,
  bytesToInt16,
  CANONICAL_FORMAT,
  FrameChunker,
  type FrameChunkerOptions,
  frameDurationMs,
  int16ToBytes,
} from "./audio/format.js";
export { mulawDecode, mulawEncode } from "./audio/mulaw.js";
export { downsampleX2, upsampleX2 } from "./audio/resample.js";
export { frameRms, rmsToDbfs } from "./audio/rms.js";
export {
  type ChunkSentencesOptions,
  chunkSentences,
  toSentenceIterable,
} from "./audio/sentences.js";
export {
  EventBus,
  type EventBusOptions,
  type EventMeta,
  type Unsubscribe,
} from "./bus.js";
// Errors
export {
  AdapterError,
  AudioFormatError,
  CallConfigError,
  CallSdkError,
  StageError,
} from "./errors.js";
// Event taxonomy + bus
export type {
  CallEndReason,
  CallEventMap,
  CallEventType,
  TranscriptFinalEvent,
} from "./events.js";
// Logging
export {
  type ChildLoggerBindings,
  ConsoleLogger,
  childLogger,
  createLogger,
  type LogFields,
  type Logger,
  type LogLevel,
} from "./logger.js";

// Telemetry
export {
  SessionTelemetry,
  type TelemetryMark,
  type TelemetrySink,
  type TurnLatencySummary,
} from "./telemetry.js";
