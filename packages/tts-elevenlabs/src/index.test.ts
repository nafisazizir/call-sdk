import { describe, expect, it } from "vitest";
import { createElevenLabsStage, ElevenLabsStage } from "./index";

describe("createElevenLabsStage", () => {
  it("creates an ElevenLabsStage instance named 'tts-elevenlabs'", () => {
    const stage = createElevenLabsStage();
    expect(stage).toBeInstanceOf(ElevenLabsStage);
    expect(stage.name).toBe("tts-elevenlabs");
  });
});
