import type { EventBus, Unsubscribe } from "./bus.js";
import type { CallEventMap } from "./events.js";
import { createLogger, type Logger } from "./logger.js";

export interface TelemetryMark {
  at: number;
  detail?: Record<string, unknown>;
  name: string;
  sessionId: string;
  stage?: string;
  turnIndex?: number;
}

export type TelemetrySink = (mark: TelemetryMark) => void;

function now(): number {
  return performance.now();
}

/**
 * Per-session latency instrumentation (see SPEC.md, "Observability").
 * Records timestamped marks at every pipeline stage boundary and derives
 * per-turn latency summaries from them.
 */
export class SessionTelemetry {
  private readonly sessionId: string;
  private readonly logger: Logger;
  private readonly sink: TelemetrySink;
  private readonly _marks: TelemetryMark[] = [];

  private observedBus: EventBus<CallEventMap> | undefined;
  private sawFirstAudioFrame = false;
  private flushed = false;

  constructor(
    sessionId: string,
    opts: { sink?: TelemetrySink; logger?: Logger } = {}
  ) {
    this.sessionId = sessionId;
    this.logger = opts.logger ?? createLogger();
    this.sink =
      opts.sink ??
      ((mark) => this.logger.debug(`telemetry: ${mark.name}`, { mark }));
  }

  get marks(): readonly TelemetryMark[] {
    return this._marks;
  }

  /**
   * Records a mark, forwards it to the sink, and — if `observe()` has been
   * called — republishes it onto the bus as a `"telemetry"` event.
   */
  mark(
    name: string,
    detail?: Record<string, unknown> & { stage?: string; turnIndex?: number }
  ): TelemetryMark {
    const { stage, turnIndex, ...rest } = detail ?? {};
    const mark: TelemetryMark = {
      sessionId: this.sessionId,
      name,
      at: now(),
      ...(stage === undefined ? {} : { stage }),
      ...(turnIndex === undefined ? {} : { turnIndex }),
      ...(Object.keys(rest).length > 0 ? { detail: rest } : {}),
    };
    this._marks.push(mark);
    this.sink(mark);
    if (this.observedBus && !this.observedBus.closed) {
      this.observedBus.publish("telemetry", { mark });
    }
    return mark;
  }

  /**
   * Subscribes to `bus` and auto-marks the pipeline's boundary events (see
   * class docs). Never subscribes to `"telemetry"` itself — that's what
   * keeps `mark()`'s auto-republish from looping back into `observe()`.
   * Returns an unsubscribe-all function.
   */
  observe(bus: EventBus<CallEventMap>): () => void {
    this.observedBus = bus;
    const unsubs: Unsubscribe[] = [];

    unsubs.push(
      bus.subscribe("audio-frame", () => {
        if (!this.sawFirstAudioFrame) {
          this.sawFirstAudioFrame = true;
          this.mark("first-audio-frame");
        }
      })
    );
    unsubs.push(
      bus.subscribe("call-ended", () => {
        this.mark("call-ended");
      })
    );

    return () => {
      for (const unsubscribe of unsubs) {
        unsubscribe();
      }
      if (this.observedBus === bus) {
        this.observedBus = undefined;
      }
    };
  }

  /**
   * Finalizes the session's telemetry. Marks are forwarded to the sink
   * live, so this is the teardown ordering point rather than a buffer
   * drain; derived summaries (e.g. turn latency) are computed by their
   * owners from `marks`. Idempotent.
   */
  flush(): void {
    if (this.flushed) {
      return;
    }
    this.flushed = true;
  }
}
