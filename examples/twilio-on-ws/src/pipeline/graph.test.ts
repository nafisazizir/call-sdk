import { CallConfigError, type CallEventType, type Logger } from "call-sdk";
import { describe, expect, it } from "vitest";
import { validateStageGraph } from "./graph";
import type { Stage } from "./stage";
import { createEnergyVadStage } from "./stages/energy-vad";
import { createSilenceTurnStage } from "./stages/silence-turn";
import { resolveStages } from "./voice-session";

function fakeStage(
  name: string,
  consumes: CallEventType[],
  emits: CallEventType[],
  optionalConsumes?: CallEventType[]
): Stage {
  return {
    name,
    consumes,
    emits,
    ...(optionalConsumes ? { optionalConsumes } : {}),
    attach: () => ({ dispose: () => undefined }),
  };
}

const sttStage = () =>
  fakeStage(
    "fake-stt",
    ["audio-frame"],
    ["transcript-interim", "transcript-final", "stt-endpoint"]
  );
const ttsStage = (name = "fake-tts") =>
  fakeStage(name, ["agent-say"], ["audio-out", "agent-generation-end"]);

function mockLogger(): Logger & { warns: string[] } {
  const warns: string[] = [];
  return {
    warns,
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => warns.push(message),
    error: () => undefined,
  };
}

describe("validateStageGraph", () => {
  it("accepts a fully-wired pipeline", () => {
    const stages = resolveStages([sttStage(), ttsStage()]);
    expect(() =>
      validateStageGraph(stages, {
        logger: mockLogger(),
        hasEndOfTurnHandler: true,
      })
    ).not.toThrow();
  });

  it("throws with an actionable hint when silence-turn has no transcript producer", () => {
    expect(() =>
      validateStageGraph([createEnergyVadStage(), createSilenceTurnStage()], {
        logger: mockLogger(),
      })
    ).toThrow(CallConfigError);
    expect(() =>
      validateStageGraph([createEnergyVadStage(), createSilenceTurnStage()], {
        logger: mockLogger(),
      })
    ).toThrow("transcription stage");
  });

  it("throws when onEndOfTurn is registered but nothing emits end-of-turn", () => {
    expect(() =>
      validateStageGraph([createEnergyVadStage()], {
        logger: mockLogger(),
        hasEndOfTurnHandler: true,
      })
    ).toThrow(CallConfigError);
  });

  it("warns (not throws) on duplicate audio-out producers", () => {
    const logger = mockLogger();
    expect(() =>
      validateStageGraph([ttsStage("tts-a"), ttsStage("tts-b")], { logger })
    ).not.toThrow();
    expect(
      logger.warns.some((w) => w.includes('Multiple stages emit "audio-out"'))
    ).toBe(true);
  });
});

describe("resolveStages default injection", () => {
  it("auto-injects only the VAD when no stages are configured", () => {
    const resolved = resolveStages([]);
    expect(resolved.map((s) => s.name)).toEqual(["energy-vad"]);
  });

  it("prepends both VAD and silence-turn when an STT stage is present", () => {
    const resolved = resolveStages([sttStage()]);
    expect(resolved.map((s) => s.name)).toEqual([
      "energy-vad",
      "silence-turn",
      "fake-stt",
    ]);
  });

  it("does not inject the VAD when a user stage already emits speech-start", () => {
    const userVad = fakeStage(
      "user-vad",
      ["audio-frame"],
      ["speech-start", "speech-end"]
    );
    const resolved = resolveStages([userVad]);
    expect(resolved.map((s) => s.name)).toEqual(["user-vad"]);
  });

  it("does not inject silence-turn when a user stage already emits end-of-turn", () => {
    const userTurn = fakeStage(
      "user-turn",
      ["transcript-final"],
      ["end-of-turn"]
    );
    const resolved = resolveStages([userTurn, sttStage()]);
    const names = resolved.map((s) => s.name);
    expect(names).toContain("energy-vad");
    expect(names).not.toContain("silence-turn");
  });
});
