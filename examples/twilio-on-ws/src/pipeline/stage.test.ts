import { CallSdkError } from "call-sdk";
import { describe, expect, it } from "vitest";
import { StageError } from "./stage";

describe("StageError", () => {
  it("sets code to STAGE_ERROR, name, and the stage name", () => {
    const err = new StageError("connection dropped", "stt-deepgram");
    expect(err.code).toBe("STAGE_ERROR");
    expect(err.name).toBe("StageError");
    expect(err.stageName).toBe("stt-deepgram");
  });

  it("propagates cause", () => {
    const cause = new Error("underlying");
    const err = new StageError("dropped", "tts-elevenlabs", cause);
    expect(err.cause).toBe(cause);
  });

  it("is an instanceof CallSdkError", () => {
    expect(new StageError("dropped", "vad")).toBeInstanceOf(CallSdkError);
  });
});
