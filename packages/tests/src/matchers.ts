// Importing anything from the pipeline package merges its semantic event
// types into `CallEventMap` via declaration merging — required so
// `ALL_CALL_EVENT_TYPES`/`recordEvents` below can see the full taxonomy.
import { PIPELINE_EVENT_TYPES } from "@call-adapter/pipeline";
import {
  type AudioFrame,
  type CallEventMap,
  type CallEventType,
  CORE_CALL_EVENT_TYPES,
  type EventBus,
} from "call-sdk";

interface MatcherResult {
  message: () => string;
  pass: boolean;
}

/** Every event type in the Call SDK taxonomy — core transport/lifecycle plus the pipeline's semantic events. */
export const ALL_CALL_EVENT_TYPES: readonly CallEventType[] = [
  ...CORE_CALL_EVENT_TYPES,
  ...PIPELINE_EVENT_TYPES,
];

/** A recorded log of everything published on a bus, queryable by event type. */
export interface RecordedEvents {
  all: { type: CallEventType; payload: unknown }[];
  of<K extends CallEventType>(type: K): CallEventMap[K][];
}

/**
 * Subscribes to every {@link CallEventType} on `bus` up front and records each
 * published payload, so tests can assert on what a pipeline emitted.
 */
export function recordEvents(bus: EventBus<CallEventMap>): RecordedEvents {
  const all: { type: CallEventType; payload: unknown }[] = [];
  for (const type of ALL_CALL_EVENT_TYPES) {
    bus.subscribe(type, (payload) => {
      all.push({ type, payload });
    });
  }
  return {
    all,
    of<K extends CallEventType>(type: K): CallEventMap[K][] {
      return all
        .filter((entry) => entry.type === type)
        .map((entry) => entry.payload as CallEventMap[K]);
    },
  };
}

function isAudioFrame(value: unknown): value is AudioFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    "samples" in value &&
    "timestamp" in value
  );
}

/** Asserts the value is a canonical {@link AudioFrame}: Int16Array of 320 with a finite timestamp. */
export function toBeCanonicalFrame(received: unknown): MatcherResult {
  const ok =
    isAudioFrame(received) &&
    received.samples instanceof Int16Array &&
    received.samples.length === 320 &&
    Number.isFinite(received.timestamp);
  return {
    pass: ok,
    message: () =>
      ok
        ? "expected value not to be a canonical audio frame"
        : `expected a canonical audio frame (Int16Array[320] + finite timestamp), got ${JSON.stringify(
            isAudioFrame(received)
              ? {
                  length: received.samples?.length,
                  timestamp: received.timestamp,
                }
              : received
          )}`,
  };
}

/** Asserts a {@link RecordedEvents} recorded exactly one `call-ended` event. */
export function toHaveEndedOnce(received: RecordedEvents): MatcherResult {
  const count = received.of("call-ended").length;
  return {
    pass: count === 1,
    message: () =>
      count === 1
        ? "expected NOT exactly one call-ended event"
        : `expected exactly one call-ended event, got ${count}`,
  };
}

/** Asserts a {@link RecordedEvents} recorded at least one event of `type` (optionally matching `predicate`). */
export function toHaveEmitted<K extends CallEventType>(
  received: RecordedEvents,
  type: K,
  predicate?: (payload: CallEventMap[K]) => boolean
): MatcherResult {
  const matches = received
    .of(type)
    .filter((payload) => (predicate ? predicate(payload) : true));
  return {
    pass: matches.length > 0,
    message: () =>
      matches.length > 0
        ? `expected NOT to have emitted "${type}"`
        : `expected to have emitted "${type}"${
            predicate ? " matching predicate" : ""
          }, but ${received.of(type).length === 0 ? "it was never emitted" : "no recorded event matched"}`,
  };
}

export const matchers = {
  toBeCanonicalFrame,
  toHaveEndedOnce,
  toHaveEmitted,
};

interface CallMatchers<R = unknown> {
  toBeCanonicalFrame(): R;
  toHaveEmitted<K extends CallEventType>(
    type: K,
    predicate?: (payload: CallEventMap[K]) => boolean
  ): R;
  toHaveEndedOnce(): R;
}

declare module "vitest" {
  // biome-ignore lint/suspicious/noExplicitAny: matches Vitest's own augmentation pattern
  interface Assertion<T = any> extends CallMatchers<T> {}
  interface AsymmetricMatchersContaining extends CallMatchers {}
}
