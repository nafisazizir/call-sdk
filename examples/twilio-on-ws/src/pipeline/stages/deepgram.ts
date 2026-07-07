// The real Deepgram streaming STT stage (M5). Speaks the Deepgram Listen
// websocket protocol directly over the platform's global WHATWG `WebSocket`
// (Node >=22) — no `@deepgram/sdk`, no `ws` package at runtime. Auth rides
// the WebSocket subprotocol handshake per Deepgram's documented pattern:
// `new WebSocket(url, ["token", apiKey])`.
//
// Per SPEC.md's failure model, v1 does no automatic recovery: a socket that
// drops before the stage begins its own graceful shutdown is a fatal
// `ctx.fail`, not a reconnect.

import { int16ToBytes } from "call-sdk";
import {
  type Stage,
  type StageContext,
  StageError,
  type StageHandle,
} from "../stage";

export interface DeepgramStageConfig {
  /** Deepgram API key. Defaults to `process.env.DEEPGRAM_API_KEY`, read lazily at `attach()`. */
  apiKey?: string;
  /**
   * The Deepgram Listen websocket endpoint.
   * Default `"wss://api.deepgram.com/v1/listen"`. Overridable for tests
   * (point at a fake local server).
   */
  baseUrl?: string;
  /** Endpointing sensitivity (ms of silence), sent as `&endpointing=`. Default 300. */
  endpointingMs?: number;
  /** Transcription language. Default `"en"`. */
  language?: string;
  /** Deepgram model. Default `"nova-3"`. */
  model?: string;
  /** Deepgram's `smart_format` post-processing. Default true. */
  smartFormat?: boolean;
  /** `UtteranceEnd` delay (ms), sent as `&utterance_end_ms=`. Default 1000. */
  utteranceEndMs?: number;
}

const DEFAULT_MODEL = "nova-3";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_ENDPOINTING_MS = 300;
const DEFAULT_UTTERANCE_END_MS = 1000;
const DEFAULT_SMART_FORMAT = true;
const DEFAULT_BASE_URL = "wss://api.deepgram.com/v1/listen";

/** ~2s of pre-open audio at the canonical 20ms frame size. */
const MAX_BUFFERED_FRAMES = 100;
/** How long `dispose()` waits for Deepgram to ack `CloseStream` before forcing the socket closed. */
const CLOSE_TIMEOUT_MS = 1000;
const SECONDS_TO_MS = 1000;

interface ResolvedConfig {
  baseUrl: string;
  endpointingMs: number;
  language: string;
  model: string;
  smartFormat: boolean;
  utteranceEndMs: number;
}

interface DeepgramAlternative {
  confidence?: number;
  transcript?: string;
}

interface DeepgramResultsMessage {
  channel?: { alternatives?: DeepgramAlternative[] };
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  type: "Results";
}

interface DeepgramUtteranceEndMessage {
  last_word_end?: number;
  type: "UtteranceEnd";
}

type DeepgramMessage =
  | DeepgramResultsMessage
  | DeepgramUtteranceEndMessage
  | { type: string };

function buildUrl(config: ResolvedConfig): string {
  const url = new URL(config.baseUrl);
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("channels", "1");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("model", config.model);
  url.searchParams.set("language", config.language);
  url.searchParams.set("endpointing", String(config.endpointingMs));
  url.searchParams.set("utterance_end_ms", String(config.utteranceEndMs));
  url.searchParams.set("smart_format", String(config.smartFormat));
  return url.toString();
}

const NO_OP_HANDLE: StageHandle = {
  dispose: () => {
    // nothing was ever opened
  },
};

export class DeepgramStage implements Stage {
  readonly name = "deepgram";
  readonly consumes = ["audio-frame"] as const;
  readonly emits = [
    "transcript-interim",
    "transcript-final",
    "stt-endpoint",
  ] as const;

  readonly #config: DeepgramStageConfig;

  /**
   * Config is captured as-is; API key/base URL resolution happens lazily in
   * `attach()` so the constructor never throws even when no env is set
   * (e.g. under CI, before a real session ever attaches).
   */
  constructor(config: DeepgramStageConfig = {}) {
    this.#config = config;
  }

  attach(ctx: StageContext): StageHandle {
    const apiKey = this.#config.apiKey ?? process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      ctx.fail(
        new StageError(
          "no API key — set DEEPGRAM_API_KEY or pass { apiKey }",
          this.name
        ),
        { fatal: true }
      );
      return NO_OP_HANDLE;
    }

    const resolved: ResolvedConfig = {
      model: this.#config.model ?? DEFAULT_MODEL,
      language: this.#config.language ?? DEFAULT_LANGUAGE,
      endpointingMs: this.#config.endpointingMs ?? DEFAULT_ENDPOINTING_MS,
      utteranceEndMs: this.#config.utteranceEndMs ?? DEFAULT_UTTERANCE_END_MS,
      smartFormat: this.#config.smartFormat ?? DEFAULT_SMART_FORMAT,
      baseUrl: this.#config.baseUrl ?? DEFAULT_BASE_URL,
    };

    // `closing` gates both directions once graceful shutdown has begun
    // (dispose or ctx.signal abort): no further sends, no further publishes,
    // and socket close/error stop being treated as a fatal drop.
    let closing = false;
    let failed = false;
    let sawFirstResult = false;
    let warnedDrop = false;
    let malformedReported = false;
    let closingPromise: Promise<void> | undefined;
    const bufferedFrames: Uint8Array[] = [];

    ctx.mark("stt-connect-start");
    const socket = new WebSocket(buildUrl(resolved), ["token", apiKey]);

    const flushBuffer = (): void => {
      for (const bytes of bufferedFrames.splice(0)) {
        socket.send(bytes);
      }
    };

    const sendOrBuffer = (bytes: Uint8Array): void => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(bytes);
        return;
      }
      bufferedFrames.push(bytes);
      if (bufferedFrames.length > MAX_BUFFERED_FRAMES) {
        bufferedFrames.shift();
        if (!warnedDrop) {
          warnedDrop = true;
          ctx.logger.warn(
            "Deepgram: pre-connect audio buffer exceeded 100 frames (~2s); dropping oldest"
          );
        }
      }
    };

    const unsubscribeAudio = ctx.bus.subscribe(
      "audio-frame",
      (payload: { frame: { samples: Int16Array } }) => {
        sendOrBuffer(int16ToBytes(payload.frame.samples));
      }
    );

    const handleResults = (msg: DeepgramResultsMessage): void => {
      if (!sawFirstResult) {
        sawFirstResult = true;
        ctx.mark("stt-first-result");
      }
      const alternative = msg.channel?.alternatives?.[0];
      const text = alternative?.transcript ?? "";
      if (text.trim().length === 0) {
        return;
      }
      const startMs = (msg.start ?? 0) * SECONDS_TO_MS;
      if (!msg.is_final) {
        ctx.bus.publish("transcript-interim", { text, timestamp: startMs });
        return;
      }
      const endMs = ((msg.start ?? 0) + (msg.duration ?? 0)) * SECONDS_TO_MS;
      ctx.bus.publish("transcript-final", {
        text,
        startMs,
        endMs,
        confidence: alternative?.confidence,
      });
      if (msg.speech_final) {
        ctx.bus.publish("stt-endpoint", { timestamp: endMs });
      }
    };

    const handleUtteranceEnd = (msg: DeepgramUtteranceEndMessage): void => {
      ctx.bus.publish("stt-endpoint", {
        timestamp: (msg.last_word_end ?? 0) * SECONDS_TO_MS,
      });
    };

    const onMessage = (event: MessageEvent): void => {
      if (closing || typeof event.data !== "string") {
        return;
      }
      let parsed: DeepgramMessage;
      try {
        parsed = JSON.parse(event.data) as DeepgramMessage;
      } catch (err) {
        if (!malformedReported) {
          malformedReported = true;
          ctx.fail(
            new StageError(
              "received a malformed (non-JSON) message",
              this.name,
              err
            ),
            { fatal: false }
          );
        }
        return;
      }
      switch (parsed.type) {
        case "Results":
          handleResults(parsed as DeepgramResultsMessage);
          return;
        case "UtteranceEnd":
          handleUtteranceEnd(parsed as DeepgramUtteranceEndMessage);
          return;
        default:
          ctx.logger.debug(`Deepgram: ignoring "${parsed.type}" message`);
      }
    };

    const onOpen = (): void => {
      ctx.mark("stt-connected");
      flushBuffer();
    };

    const onErrorOrClose = (): void => {
      if (closing || failed) {
        return;
      }
      failed = true;
      ctx.fail(
        new StageError("connection lost before session teardown", this.name),
        { fatal: true }
      );
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onErrorOrClose);
    socket.addEventListener("close", onErrorOrClose);

    const shutdown = (): Promise<void> => {
      if (closingPromise) {
        return closingPromise;
      }
      closing = true;
      unsubscribeAudio();
      closingPromise = new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, CLOSE_TIMEOUT_MS);
        socket.addEventListener("close", finish, { once: true });
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "CloseStream" }));
          }
          socket.close();
        } catch {
          // dispose must never throw
          finish();
        }
      });
      return closingPromise;
    };

    const onAbort = (): void => {
      void shutdown();
    };
    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener("abort", onAbort);
    }

    return {
      dispose: async () => {
        ctx.signal.removeEventListener("abort", onAbort);
        await shutdown();
      },
    };
  }
}

/** Creates a configured {@link DeepgramStage} factory. */
export function createDeepgramStage(
  config?: DeepgramStageConfig
): DeepgramStage {
  return new DeepgramStage(config);
}
