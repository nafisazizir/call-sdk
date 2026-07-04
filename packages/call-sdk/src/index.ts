// Contracts: Adapter, Stage, MediaSocket, session ids

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
// The configured application + one call in flight
export {
  Call,
  type CallConfig,
  type MediaHandlers,
  resolveStages,
  type Webhooks,
} from "./call.js";
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
export {
  CORE_PRODUCED_EVENTS,
  type ValidateStageGraphOptions,
  validateStageGraph,
} from "./graph.js";
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
export {
  CallSession,
  type CallSessionDeps,
  type ConversationState,
  type SayResult,
  type SessionHandlers,
  type TranscriptEntry,
} from "./session.js";
// Default in-core stages
export {
  createEnergyVadStage,
  EnergyVadStage,
  type EnergyVadStageConfig,
} from "./stages/energy-vad.js";
export {
  createSilenceTurnStage,
  SilenceTurnStage,
  type SilenceTurnStageConfig,
} from "./stages/silence-turn.js";
// Telemetry
export {
  SessionTelemetry,
  type TelemetryMark,
  type TelemetrySink,
  type TurnLatencySummary,
} from "./telemetry.js";
export {
  type Adapter,
  type AdapterContext,
  type AdapterSessionHandle,
  formatSessionId,
  type MediaSocket,
  type MediaSocketCloseEvent,
  type MediaSocketMessageEvent,
  mediaSocketDataToText,
  type OutboundAudio,
  parseSessionId,
  type SessionInit,
  type Stage,
  type StageContext,
  type StageHandle,
  type StartCallOptions,
  type WebhookOptions,
} from "./types.js";
