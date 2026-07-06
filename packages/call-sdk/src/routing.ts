/**
 * Call-control routing: the `IncomingCall` handle a consumer receives in
 * `call.onIncomingCall(...)`, and the `RoutingDecision` its verb methods
 * return. The consumer decides a call's fate; the adapter translates the
 * decision into the provider's dialect (TwiML, Call Control, NCCO, ...) and
 * never decides anything itself (SPEC: adapters translate, they never
 * decide).
 *
 * Decisions are internally a list of actions so composed verbs — voicemail
 * is "say the prompt, then record" — translate as one provider response.
 * The v1 public surface exposes only single-verb methods; a public composer
 * can be added later without changing the adapter contract.
 */

export type RoutingAction =
  | { type: "reject"; reason: "rejected" | "busy" }
  | { type: "forward"; to: string; callerId?: string; timeoutSeconds?: number }
  | { type: "say"; text: string; voice?: string; language?: string }
  | { type: "play"; url: string }
  | { type: "record"; maxLengthSeconds: number; playBeep: boolean }
  | { type: "hangup" }
  | { type: "stream" };

/** What a routing verb returns and the adapter executes. */
export interface RoutingDecision {
  /** Executed in order within one provider response. */
  readonly actions: readonly RoutingAction[];
  /** Brand so adapters can cheaply assert they were handed a real decision. */
  readonly kind: "call-sdk/routing-decision";
}

export const ROUTING_DECISION_KIND = "call-sdk/routing-decision" as const;

function decision(...actions: RoutingAction[]): RoutingDecision {
  return { kind: ROUTING_DECISION_KIND, actions };
}

/** Default voicemail recording cap when the consumer sets none. */
const DEFAULT_VOICEMAIL_MAX_LENGTH_SECONDS = 120;

/**
 * An inbound call awaiting the consumer's routing decision. Handed to the
 * `onIncomingCall` handler; each verb method returns the decision to hand
 * back. Calls routed anywhere except `stream()` never enter the media plane
 * and create no `CallSession` — the provider executes the instruction and
 * the SDK's involvement ends with the webhook response.
 */
export interface IncomingCall {
  /** Name of the adapter that received the call (the key in `adapters`). */
  readonly adapter: string;
  /** Provider-native call id (e.g. a Twilio CallSid). */
  readonly callId: string;

  /** Answer and connect the caller to another number (forwarding / transfer at pickup). */
  forwardTo(
    number: string,
    opts?: { callerId?: string; timeoutSeconds?: number }
  ): RoutingDecision;
  readonly from?: string;
  /** End the call. */
  hangup(): RoutingDecision;
  /** Play an audio file, then hang up. */
  play(audioUrl: string): RoutingDecision;
  /** The provider's raw webhook payload — escape hatch, never interpreted by core. */
  readonly raw?: unknown;
  /** Decline the call without answering. `busy: true` signals busy instead. */
  reject(opts?: { busy?: boolean }): RoutingDecision;
  /**
   * Speak `text` with the provider's own TTS, then hang up. One-shot and
   * non-interactive — this is control-plane speech, not the interactive
   * media-plane speech a voice application does over `stream()`; the naming
   * overlap with a media-plane `say()` is deliberate and documented.
   */
  say(
    text: string,
    opts?: { voice?: string; language?: string }
  ): RoutingDecision;
  /** Hand the call to the media plane: raw normalized audio, a live `CallSession`. */
  stream(): RoutingDecision;
  readonly to?: string;
  /** Optionally play a prompt, record a message, hang up. */
  voicemail(opts?: {
    prompt?: string;
    maxLengthSeconds?: number;
  }): RoutingDecision;
}

export type IncomingCallHandler = (
  incoming: IncomingCall
) => RoutingDecision | Promise<RoutingDecision>;

/** The provider-parsed facts an adapter hands core to route an inbound call. */
export interface IncomingCallInit {
  callId: string;
  from?: string;
  /** The provider's raw webhook payload, passed through to `IncomingCall.raw`. */
  raw?: unknown;
  to?: string;
}

/** Builds the `IncomingCall` handle core passes to the consumer's handler. */
export function createIncomingCall(
  adapter: string,
  init: IncomingCallInit
): IncomingCall {
  return {
    adapter,
    callId: init.callId,
    ...(init.from === undefined ? {} : { from: init.from }),
    ...(init.to === undefined ? {} : { to: init.to }),
    ...(init.raw === undefined ? {} : { raw: init.raw }),
    forwardTo: (number, opts) =>
      decision({
        type: "forward",
        to: number,
        ...(opts?.callerId === undefined ? {} : { callerId: opts.callerId }),
        ...(opts?.timeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: opts.timeoutSeconds }),
      }),
    hangup: () => decision({ type: "hangup" }),
    play: (audioUrl) => decision({ type: "play", url: audioUrl }),
    reject: (opts) =>
      decision({ type: "reject", reason: opts?.busy ? "busy" : "rejected" }),
    say: (text, opts) =>
      decision({
        type: "say",
        text,
        ...(opts?.voice === undefined ? {} : { voice: opts.voice }),
        ...(opts?.language === undefined ? {} : { language: opts.language }),
      }),
    stream: () => decision({ type: "stream" }),
    voicemail: (opts) => {
      const actions: RoutingAction[] = [];
      if (opts?.prompt !== undefined) {
        actions.push({ type: "say", text: opts.prompt });
      }
      actions.push({
        type: "record",
        maxLengthSeconds:
          opts?.maxLengthSeconds ?? DEFAULT_VOICEMAIL_MAX_LENGTH_SECONDS,
        playBeep: true,
      });
      return decision(...actions);
    },
  };
}

/** The decision core falls back to when no `onIncomingCall` handler is registered. */
export function defaultStreamDecision(): RoutingDecision {
  return decision({ type: "stream" });
}

/** The decision core falls back to when the consumer's handler throws or times out. */
export function failureRejectDecision(): RoutingDecision {
  return decision({ type: "reject", reason: "rejected" });
}

/** True iff `value` is a branded `RoutingDecision`. */
export function isRoutingDecision(value: unknown): value is RoutingDecision {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === ROUTING_DECISION_KIND &&
    Array.isArray((value as { actions?: unknown }).actions)
  );
}
