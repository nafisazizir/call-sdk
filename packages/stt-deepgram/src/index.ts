// M3 stub — the real Deepgram STT stage lands in M4/M5. This brings the class
// up to the current `Stage` contract (declared event surface) so the graph
// validates against it; `attach()` throws until the real implementation lands.

import type { Stage, StageContext, StageHandle } from "call-sdk";
import type { DeepgramStageConfig } from "./types";

export class DeepgramStage implements Stage {
  readonly name = "deepgram";
  readonly consumes = ["audio-frame"] as const;
  readonly emits = [
    "transcript-interim",
    "transcript-final",
    "stt-endpoint",
  ] as const;

  attach(_ctx: StageContext): StageHandle {
    throw new Error("DeepgramStage is not implemented until M4");
  }
}

export function createDeepgramStage(
  _config?: DeepgramStageConfig
): DeepgramStage {
  return new DeepgramStage();
}

export type { DeepgramStageConfig } from "./types";
