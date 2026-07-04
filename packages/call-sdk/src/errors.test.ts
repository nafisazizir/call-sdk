import { describe, expect, it } from "vitest";
import {
  AdapterError,
  AudioFormatError,
  CallConfigError,
  CallSdkError,
  StageError,
} from "./errors";

describe("CallSdkError", () => {
  it("sets message, code, and name", () => {
    const err = new CallSdkError("something broke", "SOME_CODE");
    expect(err.message).toBe("something broke");
    expect(err.code).toBe("SOME_CODE");
    expect(err.name).toBe("CallSdkError");
  });

  it("is an instanceof Error", () => {
    expect(new CallSdkError("fail", "ERR")).toBeInstanceOf(Error);
  });

  it("propagates cause", () => {
    const cause = new Error("root cause");
    expect(new CallSdkError("wrapped", "WRAP", cause).cause).toBe(cause);
  });

  it("allows an undefined cause", () => {
    expect(new CallSdkError("no cause", "NC").cause).toBeUndefined();
  });
});

describe("CallConfigError", () => {
  it("sets code to CALL_CONFIG_ERROR and name", () => {
    const err = new CallConfigError("bad config");
    expect(err.code).toBe("CALL_CONFIG_ERROR");
    expect(err.name).toBe("CallConfigError");
  });

  it("is an instanceof CallSdkError and Error", () => {
    const err = new CallConfigError("bad config");
    expect(err).toBeInstanceOf(CallSdkError);
    expect(err).toBeInstanceOf(Error);
  });

  it("propagates cause", () => {
    const cause = new Error("underlying");
    expect(new CallConfigError("bad config", cause).cause).toBe(cause);
  });
});

describe("AdapterError", () => {
  it("sets code to ADAPTER_ERROR and name", () => {
    const err = new AdapterError("provider dropped");
    expect(err.code).toBe("ADAPTER_ERROR");
    expect(err.name).toBe("AdapterError");
  });

  it("stores an optional adapterName", () => {
    const err = new AdapterError("dropped", { adapterName: "twilio" });
    expect(err.adapterName).toBe("twilio");
  });

  it("allows an undefined adapterName", () => {
    expect(new AdapterError("dropped").adapterName).toBeUndefined();
  });

  it("propagates cause", () => {
    const cause = new Error("socket closed");
    expect(new AdapterError("dropped", { cause }).cause).toBe(cause);
  });

  it("is an instanceof CallSdkError", () => {
    expect(new AdapterError("dropped")).toBeInstanceOf(CallSdkError);
  });
});

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

describe("AudioFormatError", () => {
  it("sets code to AUDIO_FORMAT_ERROR and name", () => {
    const err = new AudioFormatError("expected pcm-s16le");
    expect(err.code).toBe("AUDIO_FORMAT_ERROR");
    expect(err.name).toBe("AudioFormatError");
  });

  it("propagates cause", () => {
    const cause = new Error("underlying");
    expect(new AudioFormatError("bad format", cause).cause).toBe(cause);
  });

  it("is an instanceof CallSdkError", () => {
    expect(new AudioFormatError("bad format")).toBeInstanceOf(CallSdkError);
  });
});
