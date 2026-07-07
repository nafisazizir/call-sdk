import { type AudioFrame, CANONICAL_FORMAT } from "call-sdk";
import type { Stage, StageContext, StageHandle } from "../stage";

const FRAME_MS = CANONICAL_FORMAT.frameMs;
const SAMPLES_PER_FRAME = CANONICAL_FORMAT.samplesPerFrame;
const SAMPLE_RATE = CANONICAL_FORMAT.sampleRate;
const INT16_MAX = 32_767;

export interface MockSttScriptEntry {
  emitEndpoint?: boolean;
  final: string;
  interim?: string[];
}

/**
 * A deterministic mock STT stage. On each `speech-end` it plays the next entry
 * of `script` synchronously: interims, then a final, then an optional endpoint.
 * Keying off `speech-end` (not a timer) keeps it deterministic when driven by
 * the real VAD.
 */
export function createMockSttStage(config: {
  script: MockSttScriptEntry[];
}): Stage {
  return {
    name: "mock-stt",
    consumes: ["speech-start", "speech-end"] as const,
    emits: ["transcript-interim", "transcript-final", "stt-endpoint"] as const,
    attach(ctx: StageContext): StageHandle {
      let index = 0;
      const unsubscribe = ctx.bus.subscribe(
        "speech-end",
        (payload: { timestamp: number }) => {
          const entry = config.script[index];
          if (!entry) {
            return;
          }
          index += 1;
          for (const text of entry.interim ?? []) {
            ctx.bus.publish("transcript-interim", {
              text,
              timestamp: payload.timestamp,
            });
          }
          ctx.bus.publish("transcript-final", { text: entry.final });
          if (entry.emitEndpoint) {
            ctx.bus.publish("stt-endpoint", { timestamp: payload.timestamp });
          }
        }
      );
      return { dispose: () => unsubscribe() };
    },
  };
}

function toneFrame(timestamp: number, phaseOffset: number): AudioFrame {
  const samples = new Int16Array(SAMPLES_PER_FRAME);
  for (let k = 0; k < SAMPLES_PER_FRAME; k++) {
    const n = phaseOffset + k;
    const value = 0.5 * Math.sin((2 * Math.PI * 440 * n) / SAMPLE_RATE);
    samples[k] = Math.round(value * INT16_MAX);
  }
  return { samples, timestamp };
}

/**
 * A mock TTS stage. On `agent-say` it resolves the text (string or streaming),
 * synthesizes tone audio proportional to the text length, and publishes
 * `audio-out` frames asynchronously in small batches — checking `signal.aborted`
 * between batches so barge-in mid-utterance stops it immediately. Publishes
 * `agent-generation-end` on normal completion (never after an abort).
 */
export function createMockTtsStage(config?: {
  msPerChar?: number;
  chunkMs?: number;
}): Stage {
  const msPerChar = config?.msPerChar ?? 15;
  const chunkMs = config?.chunkMs ?? 60;
  const framesPerBatch = Math.max(1, Math.round(chunkMs / FRAME_MS));

  return {
    name: "mock-tts",
    consumes: ["agent-say"] as const,
    emits: ["audio-out", "agent-generation-end"] as const,
    attach(ctx: StageContext): StageHandle {
      let disposed = false;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const tick = (): Promise<void> =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            resolve();
          }, 0);
          timers.add(timer);
        });

      const generate = async (payload: {
        utteranceId: string;
        text: string | AsyncIterable<string>;
        signal: AbortSignal;
      }): Promise<void> => {
        const { utteranceId, text, signal } = payload;
        let full = "";
        if (typeof text === "string") {
          full = text;
        } else {
          for await (const chunk of text) {
            if (signal.aborted || disposed) {
              return;
            }
            full += chunk;
          }
        }

        const numFrames =
          full.length === 0
            ? 0
            : Math.max(1, Math.ceil((full.length * msPerChar) / FRAME_MS));

        let emitted = 0;
        let phase = 0;
        while (emitted < numFrames) {
          await tick();
          if (signal.aborted || disposed || ctx.bus.closed) {
            return;
          }
          const batchEnd = Math.min(numFrames, emitted + framesPerBatch);
          for (; emitted < batchEnd; emitted++) {
            ctx.bus.publish("audio-out", {
              frame: toneFrame(emitted * FRAME_MS, phase),
              utteranceId,
            });
            phase += SAMPLES_PER_FRAME;
          }
        }

        if (signal.aborted || disposed || ctx.bus.closed) {
          return;
        }
        ctx.bus.publish("agent-generation-end", { utteranceId });
      };

      const unsubscribe = ctx.bus.subscribe("agent-say", (payload) => {
        void generate(payload);
      });

      return {
        dispose: () => {
          disposed = true;
          for (const timer of timers) {
            clearTimeout(timer);
          }
          timers.clear();
          unsubscribe();
        },
      };
    },
  };
}
