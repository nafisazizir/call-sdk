import type { CallEventMap } from "./events.js";
import { createLogger, type Logger } from "./logger.js";

export type Unsubscribe = () => void;

export interface EventMeta {
  readonly at: number;
  readonly sessionId: string;
}

type Handler<T> = (payload: T, meta: EventMeta) => void;

export interface EventBusOptions {
  logger?: Logger;
  /**
   * Called when a subscriber throws. The bus itself never publishes an
   * "error" event on a handler's behalf — it has no opinion on whether
   * `TMap` even has an "error" key. In M3, `CallSession` wires this up to
   * `bus.publish("error", { error, source: "bus", fatal: false })`, which is
   * what actually turns listener exceptions into `CallEventMap["error"]`
   * events. If omitted, listener errors are just logged.
   */
  onListenerError?: (err: Error, type: string) => void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function now(): number {
  return performance.now();
}

/**
 * A small synchronous, typed pub/sub bus — the spine of the audio
 * processing pipeline (see SPEC.md, "The stage interface is event-driven,
 * not stream-transform"). Dispatch is synchronous and in subscription
 * order: this is a hot path (raw audio frames flow through it), so there
 * are no microtask hops or queuing between publish and handler execution.
 */
export class EventBus<TMap extends object = CallEventMap> {
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly onListenerError?: (err: Error, type: string) => void;
  private readonly listeners = new Map<string, Set<Handler<unknown>>>();
  private readonly pendingWaitRejectors = new Set<(err: Error) => void>();
  private readonly errorHandlingInFlight = new Set<string>();
  private isClosed = false;

  constructor(sessionId: string, opts: EventBusOptions = {}) {
    this.sessionId = sessionId;
    this.logger = opts.logger ?? createLogger();
    this.onListenerError = opts.onListenerError;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Publishes `payload` to every current subscriber of `type`, synchronously, in subscription order. */
  publish<K extends keyof TMap & string>(type: K, payload: TMap[K]): void {
    if (this.isClosed) {
      this.logger.debug(`EventBus closed; dropping publish of "${type}"`);
      return;
    }
    const set = this.listeners.get(type);
    if (!set || set.size === 0) {
      return;
    }
    // Snapshot so a handler that unsubscribes (itself or another listener)
    // mid-dispatch can't mutate the set we're iterating.
    const snapshot = Array.from(set);
    const meta: EventMeta = { sessionId: this.sessionId, at: now() };
    for (const handler of snapshot) {
      try {
        handler(payload, meta);
      } catch (err) {
        this.handleListenerError(toError(err), type);
      }
    }
  }

  private handleListenerError(err: Error, type: string): void {
    if (this.errorHandlingInFlight.has(type)) {
      // Recursion guard: this fires when handling a listener error for
      // `type` itself synchronously re-enters listener-error handling for
      // the same `type` (e.g. an "error" event subscriber that itself
      // throws). Log instead of recursing.
      this.logger.error(
        `EventBus: a listener for "${type}" threw while an error for the same type was already being handled; dropping to avoid recursion`,
        { error: err }
      );
      return;
    }
    this.errorHandlingInFlight.add(type);
    try {
      if (this.onListenerError) {
        this.onListenerError(err, type);
      } else {
        this.logger.error(`EventBus listener for "${type}" threw`, {
          error: err,
        });
      }
    } finally {
      this.errorHandlingInFlight.delete(type);
    }
  }

  /** Subscribes `handler` to every future publish of `type`. Returns an idempotent unsubscribe function. */
  subscribe<K extends keyof TMap & string>(
    type: K,
    handler: Handler<TMap[K]>
  ): Unsubscribe {
    if (this.isClosed) {
      this.logger.debug(`EventBus closed; ignoring subscribe to "${type}"`);
      return () => {
        // no-op
      };
    }
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const castHandler = handler as Handler<unknown>;
    set.add(castHandler);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      set?.delete(castHandler);
    };
  }

  /** Subscribes `handler` for exactly one event, auto-unsubscribing before invoking it. */
  once<K extends keyof TMap & string>(
    type: K,
    handler: Handler<TMap[K]>
  ): Unsubscribe {
    const unsubscribe = this.subscribe(type, (payload, meta) => {
      unsubscribe();
      handler(payload, meta);
    });
    return unsubscribe;
  }

  /**
   * Resolves with the payload of the first future `type` event matching
   * `predicate` (if given). Rejects on `timeoutMs` elapsing (no timeout by
   * default), on `signal` aborting, or if the bus is `close()`d while the
   * wait is pending.
   */
  waitFor<K extends keyof TMap & string>(
    type: K,
    opts: {
      predicate?: (payload: TMap[K]) => boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<TMap[K]> {
    if (this.isClosed) {
      return Promise.reject(
        new Error(`EventBus is closed; cannot waitFor "${type}"`)
      );
    }

    return new Promise<TMap[K]>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const rejectForClose = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        settled = true;
        unsubscribe();
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        opts.signal?.removeEventListener("abort", onAbort);
        this.pendingWaitRejectors.delete(rejectForClose);
      };

      const unsubscribe = this.subscribe(type, (payload) => {
        if (settled) {
          return;
        }
        if (opts.predicate && !opts.predicate(payload)) {
          return;
        }
        cleanup();
        resolve(payload);
      });

      function onAbort() {
        if (settled) {
          return;
        }
        cleanup();
        reject(new Error(`EventBus.waitFor("${type}") aborted`));
      }

      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort);
      }

      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (settled) {
            return;
          }
          cleanup();
          reject(
            new Error(
              `EventBus.waitFor("${type}") timed out after ${opts.timeoutMs}ms`
            )
          );
        }, opts.timeoutMs);
      }

      this.pendingWaitRejectors.add(rejectForClose);
    });
  }

  /**
   * Closes the bus: rejects any pending `waitFor`s, drops all subscribers,
   * and makes further `publish`/`subscribe` calls silent no-ops. Idempotent.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    const rejectors = Array.from(this.pendingWaitRejectors);
    this.pendingWaitRejectors.clear();
    for (const reject of rejectors) {
      reject(new Error("EventBus closed while waitFor was pending"));
    }
    this.listeners.clear();
  }
}
