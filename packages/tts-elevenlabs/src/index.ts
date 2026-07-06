// The real ElevenLabs speech synthesis stage (M5). Speaks ElevenLabs' HTTP
// streaming endpoint (`POST /v1/text-to-speech/{voiceId}/stream`) per text
// chunk — not the WebSocket input-streaming API — and requests the
// canonical pcm_16000 output format so no resampling is needed downstream.
//
// Abort semantics are a plain `AbortSignal` on the fetch: the utterance's own
// signal, the session's teardown signal, and an internal "superseded by a
// newer agent-say" signal are all combined via `AbortSignal.any`.

import {
  type Stage,
  type StageContext,
  StageError,
  type StageHandle,
} from "@call-adapter/pipeline";
import { FrameChunker } from "call-sdk";
import type { ElevenLabsStageConfig } from "./types";

const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
const DEFAULT_OPTIMIZE_STREAMING_LATENCY = 3;
const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const BODY_SNIPPET_LENGTH = 300;

interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  modelId: string;
  optimizeStreamingLatency: number;
  voiceId?: string;
}

function buildUrl(config: ResolvedConfig): string {
  const url = new URL(
    `${config.baseUrl}/v1/text-to-speech/${encodeURIComponent(config.voiceId ?? "")}/stream`
  );
  url.searchParams.set("output_format", "pcm_16000");
  url.searchParams.set(
    "optimize_streaming_latency",
    String(config.optimizeStreamingLatency)
  );
  return url.toString();
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "DOMException")
  );
}

async function readBodySnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, BODY_SNIPPET_LENGTH);
  } catch {
    return "<unreadable response body>";
  }
}

/** Merges a possible 1-byte carry with a freshly read chunk, splitting back out any new odd trailing byte. */
function mergeWithCarry(
  carry: Uint8Array | undefined,
  incoming: Uint8Array
): { carry: Uint8Array | undefined; usable: Uint8Array } {
  let bytes = incoming;
  if (carry && carry.length > 0) {
    const merged = new Uint8Array(carry.length + incoming.length);
    merged.set(carry, 0);
    merged.set(incoming, carry.length);
    bytes = merged;
  }
  const usableLength = bytes.length - (bytes.length % 2);
  if (usableLength === bytes.length) {
    return { carry: undefined, usable: bytes };
  }
  return {
    carry: bytes.slice(usableLength),
    usable: bytes.subarray(0, usableLength),
  };
}

function toChunkIterable(
  text: string | AsyncIterable<string>
): Iterable<string> | AsyncIterable<string> {
  return typeof text === "string" ? [text] : text;
}

export class ElevenLabsStage implements Stage {
  readonly name = "elevenlabs";
  readonly consumes = ["agent-say"] as const;
  readonly emits = ["audio-out", "agent-generation-end"] as const;

  readonly #config: ElevenLabsStageConfig;

  /**
   * Config is captured as-is; API key/voice id resolution happens lazily in
   * `attach()` so the constructor never throws even when no env is set.
   */
  constructor(config: ElevenLabsStageConfig = {}) {
    this.#config = config;
  }

  attach(ctx: StageContext): StageHandle {
    const resolved: ResolvedConfig = {
      apiKey: this.#config.apiKey ?? process.env.ELEVENLABS_API_KEY,
      voiceId: this.#config.voiceId ?? process.env.ELEVENLABS_VOICE_ID,
      modelId: this.#config.modelId ?? DEFAULT_MODEL_ID,
      optimizeStreamingLatency:
        this.#config.optimizeStreamingLatency ??
        DEFAULT_OPTIMIZE_STREAMING_LATENCY,
      baseUrl: this.#config.baseUrl ?? DEFAULT_BASE_URL,
    };

    let active:
      | {
          controller: AbortController;
          done: Promise<void>;
          utteranceId: string;
        }
      | undefined;

    const generateOne = async (
      utteranceId: string,
      chunk: string,
      signal: AbortSignal,
      chunker: FrameChunker,
      carryRef: { current: Uint8Array | undefined },
      sawFirstByteRef: { current: boolean }
    ): Promise<"aborted" | "failed" | "ok"> => {
      ctx.mark("tts-request", { utteranceId });

      let response: Response;
      try {
        response = await fetch(buildUrl(resolved), {
          method: "POST",
          headers: {
            "xi-api-key": resolved.apiKey ?? "",
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: chunk, model_id: resolved.modelId }),
          signal,
        });
      } catch (err) {
        if (isAbortError(err) || signal.aborted) {
          return "aborted";
        }
        ctx.fail(
          new StageError(
            `request failed: ${err instanceof Error ? err.message : String(err)}`,
            this.name,
            err
          ),
          { fatal: true }
        );
        return "failed";
      }

      if (!response.ok) {
        const snippet = await readBodySnippet(response);
        ctx.fail(
          new StageError(
            `ElevenLabs returned ${response.status}: ${snippet}`,
            this.name
          ),
          { fatal: true }
        );
        return "failed";
      }

      if (!response.body) {
        ctx.fail(new StageError("ElevenLabs response had no body", this.name), {
          fatal: true,
        });
        return "failed";
      }

      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!sawFirstByteRef.current && value.length > 0) {
            sawFirstByteRef.current = true;
            ctx.mark("tts-first-byte", { utteranceId });
          }
          const { carry, usable } = mergeWithCarry(carryRef.current, value);
          carryRef.current = carry;
          if (usable.length > 0) {
            for (const frame of chunker.push(usable)) {
              ctx.bus.publish("audio-out", { frame, utteranceId });
            }
          }
        }
      } catch (err) {
        if (isAbortError(err) || signal.aborted) {
          try {
            await reader.cancel();
          } catch {
            // best-effort
          }
          return "aborted";
        }
        ctx.fail(
          new StageError(
            `stream read failed: ${err instanceof Error ? err.message : String(err)}`,
            this.name,
            err
          ),
          { fatal: true }
        );
        return "failed";
      }
      return "ok";
    };

    const generate = async (
      utteranceId: string,
      text: string | AsyncIterable<string>,
      signal: AbortSignal
    ): Promise<void> => {
      if (!(resolved.apiKey && resolved.voiceId)) {
        ctx.fail(
          new StageError(
            "no API key/voice id — set ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID or pass { apiKey, voiceId }",
            this.name
          ),
          { fatal: true }
        );
        return;
      }

      const chunker = new FrameChunker();
      const carryRef = { current: undefined as Uint8Array | undefined };
      const sawFirstByteRef = { current: false };

      for await (const chunk of toChunkIterable(text)) {
        if (signal.aborted) {
          return;
        }
        const outcome = await generateOne(
          utteranceId,
          chunk,
          signal,
          chunker,
          carryRef,
          sawFirstByteRef
        );
        if (outcome !== "ok") {
          return;
        }
      }

      if (signal.aborted) {
        return;
      }

      const finalFrame = chunker.flush();
      if (finalFrame) {
        ctx.bus.publish("audio-out", { frame: finalFrame, utteranceId });
      }
      ctx.bus.publish("agent-generation-end", { utteranceId });
    };

    const onAgentSay = (payload: {
      utteranceId: string;
      text: string | AsyncIterable<string>;
      signal: AbortSignal;
    }): void => {
      // Core normally prevents overlap, but be safe: supersede any older
      // in-flight utterance rather than interleaving output.
      active?.controller.abort();

      const controller = new AbortController();
      const combined = AbortSignal.any([
        payload.signal,
        ctx.signal,
        controller.signal,
      ]);
      const { utteranceId } = payload;
      const done = generate(utteranceId, payload.text, combined).catch(
        (err) => {
          // Defensive: generate() already handles its own errors via
          // ctx.fail and never rejects, but never let a bug here crash the
          // bus dispatch.
          ctx.logger.error("elevenlabs: unexpected generate() rejection", {
            error: err,
          });
        }
      );
      active = { controller, done, utteranceId };
    };

    const unsubscribe = ctx.bus.subscribe("agent-say", onAgentSay);

    return {
      dispose: async () => {
        unsubscribe();
        active?.controller.abort();
        await active?.done;
      },
    };
  }
}

/** Creates a configured {@link ElevenLabsStage} factory. */
export function createElevenLabsStage(
  config?: ElevenLabsStageConfig
): ElevenLabsStage {
  return new ElevenLabsStage(config);
}

export type { ElevenLabsStageConfig } from "./types";
