import { describe, expect, it } from "vitest";
import { createDeepgramStage, DeepgramStage } from "./index";

describe("createDeepgramStage", () => {
  it("creates a DeepgramStage instance named 'stt-deepgram'", () => {
    const stage = createDeepgramStage();
    expect(stage).toBeInstanceOf(DeepgramStage);
    expect(stage.name).toBe("stt-deepgram");
  });
});
