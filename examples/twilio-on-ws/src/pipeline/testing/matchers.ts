// Pipeline-aware event recording. `@call-adapter/tests`' `recordEvents`
// subscribes to the core transport/lifecycle taxonomy by default; the voice
// pipeline adds its own semantic events (via declaration merging in
// `../events.ts`), so tests that assert on `end-of-turn`, `interruption`,
// `agent-speech-end`, etc. need a recorder that also subscribes to those.
import {
  type RecordedEvents,
  recordEvents as recordCoreEvents,
} from "@call-adapter/tests";
import {
  type CallEventMap,
  type CallEventType,
  CORE_CALL_EVENT_TYPES,
  type EventBus,
} from "call-sdk";
import { PIPELINE_EVENT_TYPES } from "../events";

/** Every event type in the taxonomy — core transport/lifecycle plus the pipeline's semantic events. */
export const ALL_CALL_EVENT_TYPES: readonly CallEventType[] = [
  ...CORE_CALL_EVENT_TYPES,
  ...PIPELINE_EVENT_TYPES,
];

/**
 * Like the test kit's {@link recordCoreEvents}, but subscribes to the full
 * pipeline taxonomy so recorded output includes the semantic events the voice
 * pipeline publishes on `voice.bus`.
 */
export function recordEvents(bus: EventBus<CallEventMap>): RecordedEvents {
  return recordCoreEvents(bus, ALL_CALL_EVENT_TYPES);
}

export type { RecordedEvents } from "@call-adapter/tests";
