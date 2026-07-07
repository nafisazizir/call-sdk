// Sentence chunking for streaming TTS input

// RMS helpers (energy-gate VAD support)
export { frameRms, rmsToDbfs } from "./audio/rms";
export {
  type ChunkSentencesOptions,
  chunkSentences,
  toSentenceIterable,
} from "./audio/sentences";
// Semantic event taxonomy — importing this package merges these events into
// core's `CallEventMap` (declaration merging via ./events.js)
export {
  PIPELINE_EVENT_TYPES,
  type TranscriptFinalEvent,
} from "./events";
// Stage graph validation
export {
  PIPELINE_PRODUCED_EVENTS,
  type ValidateStageGraphOptions,
  validateStageGraph,
} from "./graph";
// The stage contract
export {
  type Stage,
  type StageContext,
  StageError,
  type StageHandle,
} from "./stage";
// Provider stages (STT / TTS) — example-local, swappable at the edges
export {
  createDeepgramStage,
  DeepgramStage,
  type DeepgramStageConfig,
} from "./stages/deepgram";
export {
  createElevenLabsStage,
  ElevenLabsStage,
  type ElevenLabsStageConfig,
} from "./stages/elevenlabs";
// Built-in stages
export {
  createEnergyVadStage,
  EnergyVadStage,
  type EnergyVadStageConfig,
} from "./stages/energy-vad";
export {
  createSilenceTurnStage,
  SilenceTurnStage,
  type SilenceTurnStageConfig,
} from "./stages/silence-turn";
// Turn latency
export {
  computeTurnLatency,
  type TurnLatencySummary,
} from "./telemetry";
// Deterministic scripted stages for tests
export {
  createMockSttStage,
  createMockTtsStage,
  type MockSttScriptEntry,
} from "./testing/mock-stages";
// The consumer surface: attach the voice pipeline to a media-plane call
export {
  attachVoice,
  type ConversationState,
  resolveStages,
  type SayResult,
  type TranscriptEntry,
  type VoiceOptions,
  type VoiceSession,
} from "./voice-session";
