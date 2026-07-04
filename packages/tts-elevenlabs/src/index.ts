// M3 stub — the real ElevenLabs TTS stage lands in M4/M5. This brings the
// class up to the current `Stage` contract (declared event surface) so the
// graph validates against it; `attach()` throws until the real impl lands.

import type { Stage, StageContext, StageHandle } from "call-sdk";
import type { ElevenLabsStageConfig } from "./types";

export class ElevenLabsStage implements Stage {
  readonly name = "elevenlabs";
  readonly consumes = ["agent-say"] as const;
  readonly emits = ["audio-out", "agent-generation-end"] as const;

  attach(_ctx: StageContext): StageHandle {
    throw new Error("ElevenLabsStage is not implemented until M4");
  }
}

export function createElevenLabsStage(
  _config?: ElevenLabsStageConfig
): ElevenLabsStage {
  return new ElevenLabsStage();
}

export type { ElevenLabsStageConfig } from "./types";
