/**
 * TwiML generation.
 *
 * The adapter's only outbound TwiML shape is `<Connect><Stream>`, which
 * hands the call off to a bidirectional Media Stream — the raw-audio layer
 * this adapter is built on. Caller metadata
 * (`from`/`to`/`direction`) rides along as `<Parameter>` children because
 * Twilio's `start` media message does not otherwise carry it; the adapter
 * reads it back from `start.customParameters`.
 *
 * `routingDecisionTwiml` is the second TwiML shape: it translates a
 * provider-agnostic `RoutingDecision` (the call-control verbs a consumer's
 * `onIncomingCall` handler returns) into Twilio's dialect. This is pure
 * translation — adapters translate, they never decide.
 */

import {
  AdapterError,
  type RoutingAction,
  type RoutingDecision,
} from "call-sdk";

const XML_ATTR_ESCAPES_RE = /[&<>"']/g;
const XML_ATTR_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const XML_TEXT_ESCAPES_RE = /[&<>]/g;
const XML_TEXT_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** Escapes the characters that are unsafe inside a double-quoted XML attribute value. */
function escapeXmlAttr(value: string): string {
  return value.replace(XML_ATTR_ESCAPES_RE, (char) => XML_ATTR_ESCAPES[char]);
}

/**
 * Escapes the characters that are unsafe inside XML element text content.
 * Distinct from {@link escapeXmlAttr}: text content never needs quotes
 * escaped, only `&`, `<`, `>`.
 */
export function escapeXmlText(value: string): string {
  return value.replace(XML_TEXT_ESCAPES_RE, (char) => XML_TEXT_ESCAPES[char]);
}

/**
 * Builds the `<Response><Connect><Stream>...</Stream></Connect></Response>`
 * TwiML that hands an inbound (or outbound) call off to the media plane.
 * `parameters` become `<Parameter name="..." value="..."/>` children, in
 * insertion order, with both name and value XML-escaped.
 */
export function connectStreamTwiml(
  mediaUrl: string,
  parameters?: Record<string, string>
): string {
  const paramTags = Object.entries(parameters ?? {})
    .map(
      ([name, value]) =>
        `<Parameter name="${escapeXmlAttr(name)}" value="${escapeXmlAttr(value)}"/>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXmlAttr(
    mediaUrl
  )}">${paramTags}</Stream></Connect></Response>`;
}

/** Context `routingDecisionTwiml` needs to translate actions that require a callback URL. */
export interface RoutingDecisionTwimlContext {
  /**
   * Builds the URL Twilio should hit to report an action's completion (e.g.
   * a `<Record>`'s `action` attribute). `action` is a short verb name (e.g.
   * `"hangup"`) the adapter's webhook recognizes on the next request.
   */
  actionUrl(action: string): string;
}

function forwardActionTwiml(action: {
  to: string;
  callerId?: string;
  timeoutSeconds?: number;
}): string {
  const callerIdAttr =
    action.callerId === undefined
      ? ""
      : ` callerId="${escapeXmlAttr(action.callerId)}"`;
  const timeoutAttr =
    action.timeoutSeconds === undefined
      ? ""
      : ` timeout="${action.timeoutSeconds}"`;
  return `<Dial${callerIdAttr}${timeoutAttr}><Number>${escapeXmlText(action.to)}</Number></Dial>`;
}

function sayActionTwiml(action: {
  text: string;
  voice?: string;
  language?: string;
}): string {
  const voiceAttr =
    action.voice === undefined ? "" : ` voice="${escapeXmlAttr(action.voice)}"`;
  const languageAttr =
    action.language === undefined
      ? ""
      : ` language="${escapeXmlAttr(action.language)}"`;
  return `<Say${voiceAttr}${languageAttr}>${escapeXmlText(action.text)}</Say>`;
}

function recordActionTwiml(
  action: { maxLengthSeconds: number; playBeep: boolean },
  ctx: RoutingDecisionTwimlContext
): string {
  // The `action` URL is mandatory, not cosmetic: without it Twilio re-
  // requests the original webhook once recording ends, which re-runs
  // routing from scratch and produces an infinite voicemail loop instead of
  // hanging up. `actionUrl("hangup")` is the mechanical continuation the
  // webhook recognizes to short-circuit straight to `<Hangup/>`.
  const actionAttr = escapeXmlAttr(ctx.actionUrl("hangup"));
  return `<Record action="${actionAttr}" maxLength="${action.maxLengthSeconds}" playBeep="${action.playBeep}"/>`;
}

function routingActionTwiml(
  action: RoutingAction,
  ctx: RoutingDecisionTwimlContext
): string {
  switch (action.type) {
    case "reject":
      return `<Reject reason="${action.reason}"/>`;
    case "forward":
      return forwardActionTwiml(action);
    case "say":
      return sayActionTwiml(action);
    case "play":
      return `<Play>${escapeXmlText(action.url)}</Play>`;
    case "record":
      return recordActionTwiml(action, ctx);
    case "hangup":
      return "<Hangup/>";
    case "stream":
      // `stream` hands the call to the media plane via `<Connect><Stream>`,
      // which `connectStreamTwiml` builds — the webhook's stream path
      // handles it before ever calling this translator. Reaching here means
      // that invariant broke.
      throw new AdapterError(
        'Twilio adapter: a "stream" routing action must be translated via connectStreamTwiml, not routingDecisionTwiml',
        { adapterName: "twilio" }
      );
    default:
      // Loud failure: an adapter that silently drops a verb it
      // can't express is a bug, not graceful degradation.
      throw new AdapterError(
        `Twilio adapter cannot express routing action "${(action as { type: string }).type}"`,
        { adapterName: "twilio" }
      );
  }
}

/**
 * Translates a provider-agnostic `RoutingDecision` into Twilio's TwiML
 * dialect — one `<Response>` containing each action's TwiML, in order, so
 * composed verbs (voicemail = say + record) execute as a single response.
 */
export function routingDecisionTwiml(
  decision: RoutingDecision,
  ctx: RoutingDecisionTwimlContext
): string {
  const body = decision.actions
    .map((action) => routingActionTwiml(action, ctx))
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}
