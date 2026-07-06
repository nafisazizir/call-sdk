import { createEnergyVadStage } from "@call-adapter/pipeline";
import type { CallEventMap, EventBus } from "call-sdk";
import { silenceFrames, toneFrames } from "./audio";
import { adapterContract, stageContract } from "./conformance";
import { createMockAdapter } from "./factories";
import { createMockSttStage, createMockTtsStage } from "./mock-stages";

adapterContract("mock", () => createMockAdapter());

stageContract("energy-vad", () => createEnergyVadStage({ hangoverMs: 100 }), {
  arrange: (bus: EventBus<CallEventMap>) => {
    for (const frame of toneFrames(200)) {
      bus.publish("audio-frame", { frame });
    }
    for (const frame of silenceFrames(200)) {
      bus.publish("audio-frame", { frame });
    }
  },
  expectEmits: ["speech-start", "speech-end"],
  timeoutMs: 10,
});

stageContract(
  "mock-stt",
  () =>
    createMockSttStage({
      script: [{ interim: ["he", "hel"], final: "hello", emitEndpoint: true }],
    }),
  {
    arrange: (bus: EventBus<CallEventMap>) => {
      bus.publish("speech-start", { timestamp: 0 });
      bus.publish("speech-end", { timestamp: 100, durationMs: 100 });
    },
    expectEmits: ["transcript-interim", "transcript-final", "stt-endpoint"],
    timeoutMs: 10,
  }
);

stageContract("mock-tts", () => createMockTtsStage(), {
  arrange: (bus: EventBus<CallEventMap>) => {
    bus.publish("agent-say", {
      utteranceId: "utt_contract",
      text: "hello world",
      signal: new AbortController().signal,
    });
  },
  expectEmits: ["audio-out", "agent-generation-end"],
  timeoutMs: 300,
});
