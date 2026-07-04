// Placeholder — replaced in later milestones

import type { Stage } from "call-sdk";
import type { DeepgramStageConfig } from "./types";

export class DeepgramStage implements Stage {
  readonly name = "stt-deepgram";
}

export function createDeepgramStage(
  _config?: DeepgramStageConfig
): DeepgramStage {
  return new DeepgramStage();
}

export type { DeepgramStageConfig } from "./types";
