// Placeholder — replaced in later milestones

import type { Stage } from "call-sdk";
import type { ElevenLabsStageConfig } from "./types";

export class ElevenLabsStage implements Stage {
  readonly name = "tts-elevenlabs";
}

export function createElevenLabsStage(
  _config?: ElevenLabsStageConfig
): ElevenLabsStage {
  return new ElevenLabsStage();
}

export type { ElevenLabsStageConfig } from "./types";
