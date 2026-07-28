import { AdapterError, CallConfigError } from "./errors";
import type { CallEventMap } from "./events";
import {
  childLogger,
  createLogger,
  type Logger,
  type LogLevel,
} from "./logger";
import {
  createIncomingCall,
  defaultStreamDecision,
  failureRejectDecision,
  type IncomingCallHandler,
  type IncomingCallInit,
  isRoutingDecision,
  type RoutingDecision,
} from "./routing";
import type { SessionLifecycleHandlers } from "./session";
import { CallSession } from "./session";
import type { TelemetrySink } from "./telemetry";
import type {
  Adapter,
  AdapterDialOptions,
  AdapterSessionHandle,
  MediaSocket,
  OutboundAudio,
  SessionInit,
  WebhookOptions,
} from "./types";
import { formatSessionId } from "./types";

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
> {
  /** Map of adapter name → adapter. v1 ships Twilio; the shape is plural by design. */
  adapters: TAdapters;
  logger?: Logger | LogLevel;
  routing?: {
    /**
     * Deadline for the `onIncomingCall` handler. On timeout the call is
     * rejected (logged). Default 5000 ms — providers give a webhook ~15 s,
     * and dead air is the worst outcome for a caller.
     */
    handlerTimeoutMs?: number;
  };
  telemetry?: { sink?: TelemetrySink };
}

/** Options for `Call.dial` — an outbound call on a named adapter. */
export interface DialOptions<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
> {
  adapter: keyof TAdapters & string;
  from?: string;
  /** Provider-specific extras, passed through to the adapter. */
  metadata?: Record<string, string>;
  /** How long to wait for the provider to connect media. Default 30 s. */
  timeoutMs?: number;
  to: string;
}

const DEFAULT_DIAL_TIMEOUT_MS = 30_000;
const DEFAULT_ROUTING_HANDLER_TIMEOUT_MS = 5000;

/**
 * The configured application — constructed once with a map of adapters;
 * behavior is registered with methods (`onIncomingCall`, `onCallStarted`,
 * ...); services many calls over its lifetime. Mount
 * `call.webhooks.<adapter>` on your HTTP route and `call.media.<adapter>`
 * on your WebSocket route, in any host.
 */
export class Call<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
> {
  /** Fetch-style control-plane handlers, keyed by adapter name. */
  readonly webhooks: Webhooks<TAdapters>;
  /** Media-plane WebSocket handlers, keyed by adapter name. */
  readonly media: MediaHandlers<TAdapters>;

  readonly #adapters: TAdapters;
  readonly #logger: Logger;
  readonly #config: CallConfig<TAdapters>;
  readonly #sessions = new Map<string, CallSession>();
  readonly #pendingOutbound = new Map<string, (session: CallSession) => void>();
  readonly #lifecycle: SessionLifecycleHandlers = {
    answered: [],
    ended: [],
    error: [],
    started: [],
  };
  #incomingHandler?: IncomingCallHandler;

  constructor(config: CallConfig<TAdapters>) {
    this.#config = config;
    this.#adapters = config.adapters;
    this.#logger = createLogger(config.logger);

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
        routeIncomingCall: (init) => this.#routeIncomingCall(name, init),
      });
      webhooks[name] = (request, options) => adapter.webhook(request, options);
      media[name] = (socket) => adapter.media(socket);
    }
    this.webhooks = webhooks as Webhooks<TAdapters>;
    this.media = media as MediaHandlers<TAdapters>;
  }

  // ---------------------------------------------------------------------
  // Behavior registration (methods)
  // ---------------------------------------------------------------------

  /**
   * Register the routing handler for inbound calls: it receives an
   * `IncomingCall` and returns a decision from one of its verb methods
   * (`reject`, `forwardTo`, `voicemail`, `stream`, ...). Exactly one may be
   * registered; without one, every inbound call streams. A handler error
   * or timeout rejects the call (logged, never dead air).
   */
  onIncomingCall(handler: IncomingCallHandler): void {
    if (this.#incomingHandler) {
      throw new CallConfigError(
        "onIncomingCall is already registered — register exactly one routing handler"
      );
    }
    this.#incomingHandler = handler;
  }

  /** Runs when a call's media session has started. Multiple handlers run in registration order. */
  onCallStarted(handler: (session: CallSession) => void | Promise<void>): void {
    this.#lifecycle.started.push(handler);
  }

  /** Runs when the provider reports the call answered / media flowing. */
  onCallAnswered(
    handler: (session: CallSession) => void | Promise<void>
  ): void {
    this.#lifecycle.answered.push(handler);
  }

  /** Runs on the exactly-once terminal `call-ended` event of every media-plane call. */
  onCallEnded(
    handler: (
      event: CallEventMap["call-ended"],
      session: CallSession
    ) => void | Promise<void>
  ): void {
    this.#lifecycle.ended.push(handler);
  }

  /** Runs on session-level errors (stage failures, handler throws, provider faults). */
  onError(
    handler: (
      event: CallEventMap["error"],
      session: CallSession
    ) => void | Promise<void>
  ): void {
    this.#lifecycle.error.push(handler);
  }

  // ---------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------

  /** Live sessions, keyed by `${adapter}:{callId}`. */
  get sessions(): ReadonlyMap<string, CallSession> {
    return this.#sessions;
  }

  getSession(sessionId: string): CallSession | undefined {
    return this.#sessions.get(sessionId);
  }

  /**
   * Places an outbound call. Resolves with the live `CallSession` once the
   * provider dials back into the media plane (i.e. audio can actually
   * flow), or rejects after `timeoutMs` (default 30 s). Outbound calls
   * always enter the media plane in v1.
   */
  async dial(options: DialOptions<TAdapters>): Promise<CallSession> {
    const { adapter: adapterName, timeoutMs, ...rest } = options;
    const adapter = this.#adapters[adapterName];
    if (!adapter) {
      throw new CallConfigError(
        `Unknown adapter "${adapterName}" — configured adapters: ${Object.keys(this.#adapters).join(", ")}`
      );
    }
    const dialOptions: AdapterDialOptions = {
      to: rest.to,
      ...(rest.from === undefined ? {} : { from: rest.from }),
      ...(rest.metadata === undefined ? {} : { metadata: rest.metadata }),
    };
    const { callId } = await adapter.dial(dialOptions);
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
            `Timed out after ${timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS}ms waiting for the media stream of outbound call ${sessionId}`
          )
        );
      }, timeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS);
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

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * The adapter-facing routing channel. Never rejects: no handler →
   * `stream` (preserves the pre-routing behavior); handler error, timeout,
   * or a non-decision return → `reject`, logged at error level.
   */
  async #routeIncomingCall(
    adapterName: string,
    init: IncomingCallInit
  ): Promise<RoutingDecision> {
    const handler = this.#incomingHandler;
    if (!handler) {
      return defaultStreamDecision();
    }
    const incoming = createIncomingCall(adapterName, init);
    const timeoutMs =
      this.#config.routing?.handlerTimeoutMs ??
      DEFAULT_ROUTING_HANDLER_TIMEOUT_MS;
    try {
      const result = await withTimeout(
        Promise.resolve(handler(incoming)),
        timeoutMs
      );
      if (!isRoutingDecision(result)) {
        this.#logger.error(
          `onIncomingCall for ${adapterName}:${init.callId} returned a value that is not a RoutingDecision — rejecting the call`
        );
        return failureRejectDecision();
      }
      return result;
    } catch (err) {
      this.#logger.error(
        `onIncomingCall for ${adapterName}:${init.callId} failed — rejecting the call`,
        { error: err instanceof Error ? err : new Error(String(err)) }
      );
      return failureRejectDecision();
    }
  }

  #createSession(
    adapterName: string,
    init: SessionInit,
    outbound: OutboundAudio
  ): AdapterSessionHandle {
    const session = new CallSession({
      adapterName,
      init,
      outbound,
      logger: this.#logger,
      ...(this.#config.telemetry?.sink
        ? { telemetrySink: this.#config.telemetry.sink }
        : {}),
      lifecycle: this.#lifecycle,
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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`onIncomingCall timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
