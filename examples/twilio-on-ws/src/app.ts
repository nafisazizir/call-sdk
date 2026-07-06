import { createServer, type IncomingMessage } from "node:http";
import { createDeepgramStage } from "@call-adapter/stt-deepgram";
import { createElevenLabsStage } from "@call-adapter/tts-elevenlabs";
import {
  createTwilioAdapter,
  type TwilioAdapterConfig,
} from "@call-adapter/twilio";
import {
  Call,
  type CallEventMap,
  type CallSession,
  createEnergyVadStage,
  type Logger,
  type LogLevel,
  type Stage,
  type TelemetrySink,
} from "call-sdk";
import { WebSocketServer } from "ws";
import { defaultAgent } from "./agent.js";

export const WEBHOOK_PATH = "/twilio/voice";
export const MEDIA_PATH = "/twilio/media";

/**
 * Noise-robustness defaults, tuned so background racket (a dish clatter, a
 * brief word, a laugh) doesn't kill the agent's turn. Two layers cooperate:
 *
 *  - the VAD is made less twitchy: a frame must be louder relative to the
 *    room (`thresholdDb`) and voice must persist longer (`activationFrames`)
 *    before `speech-start` fires at all;
 *  - the barge-in gate then requires `minSpeechMs` of *sustained* speech
 *    while the agent is talking before it actually interrupts — a transient
 *    noise burst ends (VAD `speech-end`) before the timer fires and is
 *    ignored.
 *
 * This robustly filters transient / low-level noise. It CANNOT distinguish a
 * bystander's sustained speech from the caller's — an energy gate detects
 * voice energy, not *whose* voice. For that, swap in a neural VAD or gate
 * barge-in on the transcript (see README, "Handling noisy environments").
 */
const NOISE_ROBUST_VAD = { thresholdDb: 16, activationFrames: 5 } as const;
const DEFAULT_MIN_SPEECH_MS = 500;

export interface CallServerOptions {
  /** Per-turn agent logic. Default: GPT-5 nano via the AI SDK + Vercel AI Gateway. */
  agent?: (
    turn: CallEventMap["end-of-turn"],
    session: CallSession
  ) => void | Promise<void>;
  /** Spoken when the call connects. Pass null to disable. */
  greeting?: string | null;
  /**
   * Sustained caller speech (ms) required to interrupt the agent mid-turn.
   * Default 500 — higher rejects more background noise but makes a genuine
   * barge-in feel less snappy; pass 0 for instant, twitchy interruption.
   */
  interruption?: { minSpeechMs?: number };
  logger?: Logger | LogLevel;
  /**
   * Pipeline stages. Default: a noise-robust energy VAD + real Deepgram STT +
   * ElevenLabs TTS (env-configured). Silence-based turn detection is injected
   * automatically since no listed stage emits `end-of-turn`.
   */
  stages?: Stage[];
  telemetrySink?: TelemetrySink;
  twilio?: TwilioAdapterConfig;
}

/**
 * The whole example, spec-scale: a `Call` with the Twilio adapter and a
 * pipeline, mounted on a plain node:http server + `ws` — the SDK dictates no
 * host (SPEC.md, Transport & Runtime).
 */
export function createCallServer(options: CallServerOptions = {}) {
  const greeting =
    options.greeting === undefined
      ? "Hi! How can I help you today?"
      : options.greeting;
  const agent = options.agent ?? defaultAgent;

  const call = new Call({
    adapters: {
      twilio: createTwilioAdapter({
        mediaPath: MEDIA_PATH,
        ...options.twilio,
      }),
    },
    stages: options.stages ?? [
      createEnergyVadStage(NOISE_ROBUST_VAD),
      createDeepgramStage(),
      createElevenLabsStage(),
    ],
    interruption: {
      minSpeechMs: options.interruption?.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS,
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.telemetrySink
      ? { telemetry: { sink: options.telemetrySink } }
      : {}),
    ...(greeting === null
      ? {}
      : {
          onCallStarted: (session: CallSession) => {
            void session.say(greeting);
          },
        }),
    onEndOfTurn: agent,
  });

  async function listen(port = 3000) {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.split("?")[0] === WEBHOOK_PATH) {
        void toFetchRequest(req)
          .then((request) => call.webhooks.twilio(request))
          .then(async (response) => {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers)
            );
            res.end(await response.text());
          })
          .catch(() => {
            res.writeHead(500);
            res.end();
          });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (req.url?.split("?")[0] === MEDIA_PATH) {
        wss.handleUpgrade(req, socket, head, (ws) => {
          call.media.twilio(ws);
        });
        return;
      }
      socket.destroy();
    });

    await new Promise<void>((resolve) => server.listen(port, resolve));
    const address = server.address();
    const boundPort =
      typeof address === "object" && address ? address.port : port;
    return {
      port: boundPort,
      close: async () => {
        await call.shutdown();
        wss.close();
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );
      },
    };
  }

  return { call, listen };
}

/** Adapts a node:http request into a WHATWG Request (honoring proxy scheme headers). */
export async function toFetchRequest(req: IncomingMessage): Promise<Request> {
  const scheme = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers.host ?? "localhost";
  const url = `${scheme}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  return new Request(url, {
    method: req.method ?? "POST",
    headers,
    body: body.length > 0 ? new Uint8Array(body) : null,
  });
}
