import { AdapterError, CallConfigError } from "./errors.js";
import { validateStageGraph } from "./graph.js";
import {
  childLogger,
  createLogger,
  type Logger,
  type LogLevel,
} from "./logger.js";
import type { SessionHandlers } from "./session.js";
import { CallSession } from "./session.js";
import { createEnergyVadStage } from "./stages/energy-vad.js";
import { createSilenceTurnStage } from "./stages/silence-turn.js";
import type { TelemetrySink } from "./telemetry.js";
import type {
  Adapter,
  AdapterSessionHandle,
  MediaSocket,
  OutboundAudio,
  SessionInit,
  Stage,
  StartCallOptions,
  WebhookOptions,
} from "./types.js";
import { formatSessionId } from "./types.js";

export type Webhooks<TAdapters> = {
  [K in keyof TAdapters]: (
    request: Request,
    options?: WebhookOptions
  ) => Promise<Response>;
};

export type MediaHandlers<TAdapters> = {
  [K in keyof TAdapters]: (socket: MediaSocket) => void;
};

export interface CallConfig<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
> extends SessionHandlers {
  /** Map of adapter name → adapter. v1 ships Twilio; the shape is plural by design. */
  adapters: TAdapters;
  interruption?: {
    /**
     * Require this much sustained caller speech before an utterance is
     * interrupted. Default 0 — the VAD's own activation debounce is the
     * primary guard against noise-triggered barge-in.
     */
    minSpeechMs?: number;
  };
  logger?: Logger | LogLevel;
  /**
   * Pipeline stages, in attach order. Sensible defaults are prepended
   * automatically: an energy VAD unless a configured stage emits
   * `speech-start`, and silence-based turn detection unless a configured
   * stage emits `end-of-turn` (injected only when a transcription stage is
   * present to gate on).
   */
  stages?: Stage[];
  telemetry?: { sink?: TelemetrySink };
}

const DEFAULT_START_CALL_TIMEOUT_MS = 30_000;

/**
 * The configured application — set up once with adapters, a pipeline, and
 * handlers; services many calls over its lifetime. Mount
 * `call.webhooks.<adapter>` on your HTTP route and `call.media.<adapter>`
 * on your WebSocket route, in any host (SPEC.md, Transport & Runtime).
 */
export class Call<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
> {
  /** Fetch-style control-plane handlers, keyed by adapter name. */
  readonly webhooks: Webhooks<TAdapters>;
  /** Media-plane WebSocket handlers, keyed by adapter name. */
  readonly media: MediaHandlers<TAdapters>;

  readonly #adapters: TAdapters;
  readonly #stages: readonly Stage[];
  readonly #logger: Logger;
  readonly #config: CallConfig<TAdapters>;
  readonly #sessions = new Map<string, CallSession>();
  readonly #pendingOutbound = new Map<string, (session: CallSession) => void>();

  constructor(config: CallConfig<TAdapters>) {
    this.#config = config;
    this.#adapters = config.adapters;
    this.#logger = createLogger(config.logger);
    this.#stages = resolveStages(config.stages ?? []);
    validateStageGraph(this.#stages, {
      logger: this.#logger,
      hasEndOfTurnHandler: Boolean(config.onEndOfTurn),
      hasTranscriptHandler: Boolean(config.onTranscript),
    });

    const webhooks = {} as Record<
      string,
      (request: Request, options?: WebhookOptions) => Promise<Response>
    >;
    const media = {} as Record<string, (socket: MediaSocket) => void>;
    for (const [name, adapter] of Object.entries(config.adapters)) {
      adapter.bind({
        logger: childLogger(this.#logger, { adapter: name }),
        createSession: (init, outbound) =>
          this.#createSession(name, init, outbound),
      });
      webhooks[name] = (request, options) => adapter.webhook(request, options);
      media[name] = (socket) => adapter.media(socket);
    }
    this.webhooks = webhooks as Webhooks<TAdapters>;
    this.media = media as MediaHandlers<TAdapters>;
  }

  /** Live sessions, keyed by `${adapter}:${callId}`. */
  get sessions(): ReadonlyMap<string, CallSession> {
    return this.#sessions;
  }

  getSession(sessionId: string): CallSession | undefined {
    return this.#sessions.get(sessionId);
  }

  /**
   * Places an outbound call. Resolves with the live `CallSession` once the
   * provider dials back into the media plane (i.e. audio can actually flow),
   * or rejects after `timeoutMs` (default 30 s).
   */
  async startCall(
    adapterName: keyof TAdapters & string,
    options: StartCallOptions & { timeoutMs?: number }
  ): Promise<CallSession> {
    const adapter = this.#adapters[adapterName];
    if (!adapter) {
      throw new CallConfigError(
        `Unknown adapter "${adapterName}" — configured adapters: ${Object.keys(this.#adapters).join(", ")}`
      );
    }
    const { timeoutMs, ...startOptions } = options;
    const { callId } = await adapter.startCall(startOptions);
    const sessionId = formatSessionId(adapterName, callId);
    const existing = this.#sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    return await new Promise<CallSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingOutbound.delete(sessionId);
        reject(
          new AdapterError(
            `Timed out after ${timeoutMs ?? DEFAULT_START_CALL_TIMEOUT_MS}ms waiting for the media stream of outbound call ${sessionId}`
          )
        );
      }, timeoutMs ?? DEFAULT_START_CALL_TIMEOUT_MS);
      this.#pendingOutbound.set(sessionId, (session) => {
        clearTimeout(timer);
        resolve(session);
      });
    });
  }

  /** Ends all live sessions and shuts adapters down. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.end("local-end"))
    );
    for (const adapter of Object.values(this.#adapters)) {
      await adapter.shutdown?.();
    }
  }

  #createSession(
    adapterName: string,
    init: SessionInit,
    outbound: OutboundAudio
  ): AdapterSessionHandle {
    const handlers: SessionHandlers = this.#config;
    const session = new CallSession({
      adapterName,
      init,
      outbound,
      stages: this.#stages,
      logger: this.#logger,
      ...(this.#config.telemetry?.sink
        ? { telemetrySink: this.#config.telemetry.sink }
        : {}),
      ...(this.#config.interruption
        ? { interruption: this.#config.interruption }
        : {}),
      handlers,
      onClosed: (closed) => this.#sessions.delete(closed.id),
    });
    this.#sessions.set(session.id, session);
    const waiter = this.#pendingOutbound.get(session.id);
    if (waiter) {
      this.#pendingOutbound.delete(session.id);
      waiter(session);
    }
    return session.handle;
  }
}

/**
 * Prepends the default stages the SDK ships (SPEC.md: "the opinionated
 * defaults") unless the developer's own stages already cover the role.
 */
export function resolveStages(stages: readonly Stage[]): Stage[] {
  const userEmits = new Set(stages.flatMap((stage) => [...stage.emits]));
  const defaults: Stage[] = [];
  if (!userEmits.has("speech-start")) {
    defaults.push(createEnergyVadStage());
  }
  if (!userEmits.has("end-of-turn") && userEmits.has("transcript-final")) {
    defaults.push(createSilenceTurnStage());
  }
  return [...defaults, ...stages];
}
