/**
 * Telnyx Call Control v2 webhook parsing and the call-control *sequencer* —
 * the pure planning layer the adapter's `webhook` executes.
 *
 * Telnyx, unlike Twilio, is asynchronous: a webhook is parsed and acked with
 * a bare 200, and the actual call control happens through follow-up REST
 * commands whose outcomes arrive as *more* webhooks. A single routing verb
 * therefore can't be executed in one response the way a `<Say>`/`<Record>`
 * TwiML document is — a "say the prompt, then record, then hang up" voicemail
 * is a chain of commands, each fired only once the previous one's completion
 * event arrives.
 *
 * This module holds that chain as an explicit, replayable state machine and
 * carries it *on the call itself* via Telnyx's `client_state` (a base64 blob
 * Telnyx echoes back on every webhook for the call). The adapter never keeps
 * per-call memory in process — every webhook recomputes the next command
 * purely from `(event, decodedClientState)`. That is what makes the adapter
 * horizontally scalable and crash-safe, and it is what lets Telnyx's at-
 * least-once, out-of-order webhook delivery be tolerated for free: see the
 * duplicate-tolerance invariant on {@link advanceSequence}.
 *
 * Like `twiml.ts` in the Twilio adapter, this module only *translates* — it
 * decides nothing. The routing decision was made by the consumer's
 * `onIncomingCall` handler upstream; here we merely render that decision into
 * Telnyx's Call Control dialect, one command at a time.
 */

import type { RoutingAction, RoutingDecision } from "call-sdk";

// ---------------------------------------------------------------------------
// Webhook parsing (Telnyx wire JSON -> normalized event)
// ---------------------------------------------------------------------------

/**
 * A parsed Telnyx webhook. Snake_case wire fields are mapped to camelCase;
 * the entire `data.payload` object is preserved verbatim as `raw` (the
 * escape hatch handed to `IncomingCall.raw`, never interpreted by core).
 */
export interface TelnyxWebhookEvent {
  eventType: string;
  payload: {
    callControlId: string;
    callSessionId?: string;
    clientState?: string;
    direction?: string;
    from?: string;
    raw: unknown;
    state?: string;
    to?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Parses one Telnyx webhook body (`{data: {event_type, payload}}`). Returns
 * `undefined` for invalid JSON or a body missing the minimal shape (an
 * `event_type` string and a `payload.call_control_id` string) — a malformed
 * webhook is acked, never crashed on, so Telnyx isn't made to redeliver
 * garbage.
 */
export function parseTelnyxWebhook(
  rawBody: string
): TelnyxWebhookEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (!(isRecord(parsed) && isRecord(parsed.data))) {
    return undefined;
  }
  const { data } = parsed;
  if (typeof data.event_type !== "string" || !isRecord(data.payload)) {
    return undefined;
  }
  const p = data.payload;
  if (typeof p.call_control_id !== "string") {
    return undefined;
  }
  const callSessionId = optionalString(p.call_session_id);
  const clientState = optionalString(p.client_state);
  const direction = optionalString(p.direction);
  const from = optionalString(p.from);
  const state = optionalString(p.state);
  const to = optionalString(p.to);
  return {
    eventType: data.event_type,
    payload: {
      callControlId: p.call_control_id,
      raw: p,
      ...(callSessionId === undefined ? {} : { callSessionId }),
      ...(clientState === undefined ? {} : { clientState }),
      ...(direction === undefined ? {} : { direction }),
      ...(from === undefined ? {} : { from }),
      ...(state === undefined ? {} : { state }),
      ...(to === undefined ? {} : { to }),
    },
  };
}

// ---------------------------------------------------------------------------
// client_state codec (versioned)
// ---------------------------------------------------------------------------

/**
 * The adapter's private per-call state, carried on the call via Telnyx's
 * echoed `client_state`. Versioned (`v`) so an old encoding surviving on a
 * long-lived call — or a `client_state` set by the consumer's *other*
 * tooling — is recognized as foreign and ignored rather than misread.
 *
 * - `mode: "stream"` — the call was handed to the media plane; every
 *   subsequent control webhook is a no-op (the WS owns the call).
 * - `mode: "sequence"` — a chain of control-plane verbs (`say`/`play`/
 *   `record`/`forward`) is in flight; `q` is the remaining actions, `step`
 *   the monotonically increasing position used to derive idempotent
 *   `command_id`s.
 */
export interface TelnyxCallState {
  direction?: "inbound" | "outbound";
  mode: "sequence" | "stream";
  q: RoutingAction[];
  step: number;
  v: 1;
}

/** Encodes {@link TelnyxCallState} as a base64 JSON string for `client_state`. */
export function encodeClientState(state: TelnyxCallState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64");
}

function isValidMode(value: unknown): value is "sequence" | "stream" {
  return value === "sequence" || value === "stream";
}

function isRoutingActionArray(value: unknown): value is RoutingAction[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && typeof item.type === "string")
  );
}

/**
 * Decodes a `client_state` back into {@link TelnyxCallState}, returning
 * `undefined` for anything malformed or foreign: invalid base64/JSON, a
 * missing/mismatched version (`v !== 1`), or a wrong shape. A `client_state`
 * this adapter did not write MUST NOT be interpreted as ours — that is what
 * keeps a consumer's own Telnyx tooling from being hijacked by the
 * sequencer.
 */
export function decodeClientState(
  value: string | undefined
): TelnyxCallState | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.v !== 1 ||
    !isValidMode(parsed.mode) ||
    !isRoutingActionArray(parsed.q) ||
    typeof parsed.step !== "number"
  ) {
    return undefined;
  }
  if (
    parsed.direction !== undefined &&
    parsed.direction !== "inbound" &&
    parsed.direction !== "outbound"
  ) {
    return undefined;
  }
  return {
    v: 1,
    mode: parsed.mode,
    q: parsed.q,
    step: parsed.step,
    ...(parsed.direction === undefined
      ? {}
      : { direction: parsed.direction as "inbound" | "outbound" }),
  };
}

// ---------------------------------------------------------------------------
// The sequencer
// ---------------------------------------------------------------------------

/**
 * A single Telnyx Call Control command to execute, fully resolved from the
 * routing decision (or the call's current sequence state) — the adapter's
 * `#execute` renders each to a REST call. `clientState` fields carry the
 * next state to stamp on the call so the following webhook can advance.
 */
export type CommandPlan =
  | { cause: "CALL_REJECTED" | "USER_BUSY"; kind: "reject" }
  | { clientState?: string; kind: "hangup" }
  | { clientState: string; kind: "answer"; stream?: { streamUrl: string } }
  | {
      clientState: string;
      from?: string;
      kind: "transfer";
      timeoutSecs?: number;
      to: string;
    }
  | {
      clientState: string;
      kind: "speak";
      language?: string;
      text: string;
      voice?: string;
    }
  | { clientState: string; kind: "playback"; url: string }
  | {
      clientState: string;
      kind: "record";
      maxLengthSeconds: number;
      playBeep: boolean;
    }
  | { kind: "noop" };

/**
 * A planned command paired with the idempotent `command_id` Telnyx should
 * dedupe it under. Both are pure functions of the inputs, so a duplicate
 * webhook recomputes the identical pair — see {@link advanceSequence}.
 */
export interface TelnyxCommandStep {
  commandId: string;
  plan: CommandPlan;
}

/**
 * Derives the deterministic `command_id` for a call's step. Identical
 * `(callControlId, step)` always yields the identical id, so a command
 * recomputed from a duplicate webhook carries the same id and Telnyx dedupes
 * it (~60s window).
 */
export function telnyxCommandId(callControlId: string, step: number): string {
  return `call-sdk-${callControlId}-${step}`;
}

function translateAction(
  action: RoutingAction,
  clientState: string
): CommandPlan {
  switch (action.type) {
    case "say":
      return {
        kind: "speak",
        text: action.text,
        ...(action.voice === undefined ? {} : { voice: action.voice }),
        ...(action.language === undefined ? {} : { language: action.language }),
        clientState,
      };
    case "play":
      return { kind: "playback", url: action.url, clientState };
    case "record":
      return {
        kind: "record",
        maxLengthSeconds: action.maxLengthSeconds,
        playBeep: action.playBeep,
        clientState,
      };
    case "forward":
      return {
        kind: "transfer",
        to: action.to,
        ...(action.callerId === undefined ? {} : { from: action.callerId }),
        ...(action.timeoutSeconds === undefined
          ? {}
          : { timeoutSecs: action.timeoutSeconds }),
        clientState,
      };
    default:
      // Only say/play/record/forward/hangup ever reach a sequence queue by
      // construction (routing's multi-action decision is voicemail = say +
      // record); `hangup` and any defensive fall-through end the call.
      return { kind: "hangup", clientState };
  }
}

/**
 * Plans the *first* command for a freshly routed inbound call
 * (`call.initiated`), translating the consumer's `RoutingDecision`:
 *
 * - single `reject` -> `reject` (busy -> `USER_BUSY`, rejected ->
 *   `CALL_REJECTED`); no answer.
 * - single `hangup` -> `hangup`; no answer.
 * - single `stream` -> `answer` carrying the inline bidirectional stream
 *   params; `client_state` enters `stream` mode (the media plane takes over).
 * - anything else (`say`/`play`/`record`/`forward`, and voicemail's say +
 *   record) -> `answer` *without* a stream; `client_state` enters `sequence`
 *   mode with the full action list as its queue. A trailing `hangup` is
 *   appended UNLESS the list ends in `forward` — Telnyx (unlike TwiML) does
 *   not auto-hang-up after a verb, so the adapter appends the "…then hang up"
 *   that the `say`/`play`/`voicemail` verbs document; `forward` gets none
 *   because the transfer takes the call over.
 */
export function planInitialCommand(
  decision: RoutingDecision,
  opts: { callControlId: string; direction: "inbound"; streamUrl: string }
): TelnyxCommandStep {
  const actions = decision.actions;
  const commandId = telnyxCommandId(opts.callControlId, 1);
  const only = actions.length === 1 ? actions[0] : undefined;

  if (only?.type === "reject") {
    return {
      plan: {
        kind: "reject",
        cause: only.reason === "busy" ? "USER_BUSY" : "CALL_REJECTED",
      },
      commandId,
    };
  }
  if (only?.type === "hangup") {
    return { plan: { kind: "hangup" }, commandId };
  }
  if (only?.type === "stream") {
    return {
      plan: {
        kind: "answer",
        clientState: encodeClientState({
          v: 1,
          mode: "stream",
          direction: opts.direction,
          q: [],
          step: 1,
        }),
        stream: { streamUrl: opts.streamUrl },
      },
      commandId,
    };
  }

  const q: RoutingAction[] = [...actions];
  if (q.at(-1)?.type !== "forward") {
    q.push({ type: "hangup" });
  }
  return {
    plan: {
      kind: "answer",
      clientState: encodeClientState({
        v: 1,
        mode: "sequence",
        direction: opts.direction,
        q,
        step: 1,
      }),
    },
    commandId,
  };
}

/** Telnyx completion events that advance a sequence by one action. */
const ADVANCING_EVENTS = new Set([
  "call.answered",
  "call.speak.ended",
  "call.playback.ended",
  "call.recording.saved",
]);

/**
 * Plans the next command for an in-flight call, given a webhook carrying OUR
 * decoded `client_state`.
 *
 * - `stream` mode -> always `noop` (the media plane owns the call).
 * - `sequence` mode: an advancing completion event (`call.answered` /
 *   `call.speak.ended` / `call.playback.ended` / `call.recording.saved`)
 *   pops `q[0]` and translates it (`say`->`speak`, `play`->`playback`,
 *   `record`->`record`, `forward`->`transfer`, `hangup`->`hangup`), stamping
 *   the remaining queue at `step + 1`. An empty queue, a `call.hangup`, or
 *   any unknown event -> `noop`.
 *
 * Duplicate / out-of-order tolerance (INVARIANT): the queue *is* the state.
 * The sequencer never validates that the event type matches the action last
 * put in flight — any advancing event simply pops the next action. A
 * duplicate advancing event therefore recomputes the identical plan at the
 * identical `step`, hence the identical `command_id`, and Telnyx dedupes the
 * REST command. This is why the adapter needs no per-call memory and
 * tolerates Telnyx's at-least-once, unordered webhook delivery.
 */
export function advanceSequence(
  event: TelnyxWebhookEvent,
  state: TelnyxCallState
): TelnyxCommandStep {
  const ccid = event.payload.callControlId;

  if (state.mode === "stream" || !ADVANCING_EVENTS.has(event.eventType)) {
    return {
      plan: { kind: "noop" },
      commandId: telnyxCommandId(ccid, state.step),
    };
  }

  const [head, ...rest] = state.q;
  if (head === undefined) {
    return {
      plan: { kind: "noop" },
      commandId: telnyxCommandId(ccid, state.step),
    };
  }

  const nextStep = state.step + 1;
  const clientState = encodeClientState({
    v: 1,
    mode: "sequence",
    ...(state.direction === undefined ? {} : { direction: state.direction }),
    q: rest,
    step: nextStep,
  });
  return {
    plan: translateAction(head, clientState),
    commandId: telnyxCommandId(ccid, nextStep),
  };
}
