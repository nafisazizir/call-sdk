import type { AudioFrame } from "./audio/format";
import type { EventBus, Unsubscribe } from "./bus";
import type { CallEventMap } from "./events";
import type { Logger } from "./logger";
import type { OutboundAudio } from "./types";

/**
 * The session's raw media surface — the consumer-facing half of the
 * normalized audio boundary. Inbound caller audio arrives as canonical
 * frames via {@link SessionAudio.frames} (or the `audio-frame` bus event);
 * outbound playback is driven directly with `write`/`clear`/`mark`.
 *
 * Every operation is a safe no-op after the call has ended — racing a
 * hangup is expected, not a bug.
 */
export interface SessionAudio {
  /** True iff the adapter supports provider playback marks (`OutboundAudio.mark`). */
  readonly canMark: boolean;
  /**
   * Flush: immediately discard outbound audio already queued on the
   * provider. This is the barge-in mechanism — stopping generation alone
   * leaves already-buffered audio playing.
   */
  clear(): void;
  /**
   * Normalized inbound frames as an async iterable; completes at call end.
   * Each call returns an independent iterator with its own bounded queue —
   * a consumer that falls behind loses the oldest frames (warned once).
   */
  frames(): AsyncIterable<AudioFrame>;
  /**
   * Request a playback mark: the provider echoes it back as the
   * `audio-mark` bus event when playback reaches it. No-op (debug-logged)
   * when the adapter has no mark support — check {@link canMark}.
   */
  mark(name: string): void;
  /** Enqueue canonical audio for playback on the call. */
  write(frame: AudioFrame): void;
}

export interface SessionAudioDeps {
  bus: EventBus<CallEventMap>;
  /** False once teardown has started — writes are dropped from then on. */
  isWritable(): boolean;
  logger: Logger;
  outbound: OutboundAudio;
}

/** Per-iterator inbound queue bound; beyond it the oldest frames are dropped. */
const MAX_QUEUED_FRAMES = 1000;

export function createSessionAudio(deps: SessionAudioDeps): SessionAudio {
  const { bus, isWritable, logger, outbound } = deps;
  return {
    get canMark(): boolean {
      return typeof outbound.mark === "function";
    },
    clear(): void {
      // Always forwarded: the adapter's clear is itself a safe no-op after
      // call end, and teardown legitimately flushes mid-"ending".
      outbound.clear();
    },
    frames(): AsyncIterable<AudioFrame> {
      return {
        [Symbol.asyncIterator]() {
          const queue: AudioFrame[] = [];
          const unsubscribes: Unsubscribe[] = [];
          let done = bus.closed;
          let warned = false;
          let notify: (() => void) | undefined;
          const finish = () => {
            done = true;
            for (const unsubscribe of unsubscribes.splice(0)) {
              unsubscribe();
            }
            notify?.();
          };
          if (!done) {
            unsubscribes.push(
              bus.subscribe("audio-frame", ({ frame }) => {
                if (queue.length >= MAX_QUEUED_FRAMES) {
                  queue.shift();
                  if (!warned) {
                    warned = true;
                    logger.warn(
                      "audio.frames() consumer fell behind; dropping oldest frames"
                    );
                  }
                }
                queue.push(frame);
                notify?.();
              }),
              bus.subscribe("call-ended", () => finish())
            );
          }
          return {
            async next(): Promise<IteratorResult<AudioFrame>> {
              for (;;) {
                const frame = queue.shift();
                if (frame) {
                  return { value: frame, done: false };
                }
                if (done) {
                  return { value: undefined, done: true };
                }
                await new Promise<void>((resolve) => {
                  notify = resolve;
                });
                notify = undefined;
              }
            },
            async return(): Promise<IteratorResult<AudioFrame>> {
              finish();
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
    mark(name: string): void {
      if (!outbound.mark) {
        logger.debug(`audio.mark("${name}") — adapter has no mark support`);
        return;
      }
      outbound.mark(name);
    },
    write(frame: AudioFrame): void {
      if (!isWritable()) {
        logger.debug("audio.write() after call end — dropped");
        return;
      }
      outbound.write(frame);
    },
  };
}
