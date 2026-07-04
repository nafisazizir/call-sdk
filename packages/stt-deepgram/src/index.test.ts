import { describe, expect, it } from "vitest";
import { createDeepgramStage, DeepgramStage } from "./index";

describe("createDeepgramStage", () => {
  it("creates a DeepgramStage instance named 'deepgram'", () => {
    const stage = createDeepgramStage();
    expect(stage).toBeInstanceOf(DeepgramStage);
    expect(stage.name).toBe("deepgram");
  });

  it("declares the STT event surface", () => {
    const stage = createDeepgramStage();
    expect(stage.consumes).toEqual(["audio-frame"]);
    expect(stage.emits).toEqual([
      "transcript-interim",
      "transcript-final",
      "stt-endpoint",
    ]);
  });
});
