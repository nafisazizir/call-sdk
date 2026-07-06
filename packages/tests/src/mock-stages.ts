// Deterministic scripted STT/TTS stages moved to @call-adapter/pipeline
// (packages/pipeline/src/testing/mock-stages.ts). Re-exported here so the
// kit's public surface — `@call-adapter/tests`'s `createMockSttStage` /
// `createMockTtsStage` — stays unchanged for consumers.
export {
  createMockSttStage,
  createMockTtsStage,
  type MockSttScriptEntry,
} from "@call-adapter/pipeline";
