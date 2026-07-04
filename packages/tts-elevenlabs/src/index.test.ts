import { describe, expect, it } from "vitest";
import { createElevenLabsStage, ElevenLabsStage } from "./index";

describe("createElevenLabsStage", () => {
  it("creates an ElevenLabsStage instance named 'elevenlabs'", () => {
    const stage = createElevenLabsStage();
    expect(stage).toBeInstanceOf(ElevenLabsStage);
    expect(stage.name).toBe("elevenlabs");
  });

  it("declares the TTS event surface", () => {
    const stage = createElevenLabsStage();
    expect(stage.consumes).toEqual(["agent-say"]);
    expect(stage.emits).toEqual(["audio-out", "agent-generation-end"]);
  });
});
