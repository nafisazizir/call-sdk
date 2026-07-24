/**
 * Telnyx media WebSocket wire protocol — the JSON messages exchanged over
 * the bidirectional media streaming socket Telnyx dials once a call's
 * `stream_url` is set (via `answer`/`dial`'s `stream_url` or a Call Control
 * `streaming_start` command).
 *
 * This module owns parsing (inbound, provider → adapter) and serialization
 * (outbound, adapter → provider) so the adapter's media state machine never
 * touches raw JSON. Parsing is narrow and defensive: a message that doesn't
 * match one of the known shapes (or an event Telnyx doesn't document) comes
 * back as `undefined` rather than throwing — a dropped/malformed frame on
 * the wire is not a reason to crash the call.
 *
 * Unlike Twilio's Media Streams, Telnyx's outbound frames carry no stream
 * id — the socket itself is the addressing, so `serializeTelnyx*` never
 * includes one.
 */

export interface TelnyxConnectedMessage {
  event: "connected";
}

export interface TelnyxMediaFormat {
  channels: number;
  encoding: string;
  sample_rate: number;
}

export interface TelnyxStartPayload {
  call_control_id: string;
  client_state?: string;
  from?: string;
  media_format: TelnyxMediaFormat;
  to?: string;
}

export interface TelnyxStartMessage {
  event: "start";
  start: TelnyxStartPayload;
  stream_id: string;
}

export interface TelnyxMediaPayload {
  payload: string;
  track?: string;
}

export interface TelnyxMediaMessage {
  event: "media";
  media: TelnyxMediaPayload;
}

export interface TelnyxMarkMessage {
  event: "mark";
  mark: { name: string };
}

export interface TelnyxStopMessage {
  event: "stop";
}

export type TelnyxInboundMessage =
  | TelnyxConnectedMessage
  | TelnyxStartMessage
  | TelnyxMediaMessage
  | TelnyxMarkMessage
  | TelnyxStopMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTelnyxMediaFormat(value: unknown): value is TelnyxMediaFormat {
  return (
    isRecord(value) &&
    typeof value.encoding === "string" &&
    typeof value.sample_rate === "number" &&
    typeof value.channels === "number"
  );
}

// These take `unknown` (rather than `Record<string, unknown>`) purely so the
// `value is TelnyxXMessage` predicate type-checks — a predicate's narrowed
// type must be assignable to its parameter's type, and the narrow message
// interfaces (no index signature) aren't assignable to `Record<string,
// unknown>`. Each still starts by re-confirming the value is a record.

function isTelnyxConnectedMessage(
  value: unknown
): value is TelnyxConnectedMessage {
  return isRecord(value);
}

function isTelnyxStartMessage(value: unknown): value is TelnyxStartMessage {
  if (!isRecord(value) || typeof value.stream_id !== "string") {
    return false;
  }
  const start = value.start;
  if (!isRecord(start)) {
    return false;
  }
  return (
    typeof start.call_control_id === "string" &&
    isTelnyxMediaFormat(start.media_format) &&
    (start.client_state === undefined ||
      typeof start.client_state === "string") &&
    (start.from === undefined || typeof start.from === "string") &&
    (start.to === undefined || typeof start.to === "string")
  );
}

function isTelnyxMediaMessage(value: unknown): value is TelnyxMediaMessage {
  if (!isRecord(value)) {
    return false;
  }
  const media = value.media;
  if (!isRecord(media)) {
    return false;
  }
  return (
    typeof media.payload === "string" &&
    (media.track === undefined || typeof media.track === "string")
  );
}

function isTelnyxMarkMessage(value: unknown): value is TelnyxMarkMessage {
  if (!isRecord(value)) {
    return false;
  }
  const mark = value.mark;
  return isRecord(mark) && typeof mark.name === "string";
}

function isTelnyxStopMessage(value: unknown): value is TelnyxStopMessage {
  return isRecord(value);
}

/**
 * Parses one media WebSocket text frame. Returns `undefined` for invalid
 * JSON, an unrecognized `event`, or a recognized event whose payload
 * doesn't match the expected shape — callers should log and ignore, never
 * throw.
 */
export function parseTelnyxMessage(
  text: string
): TelnyxInboundMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.event !== "string") {
    return undefined;
  }
  switch (parsed.event) {
    case "connected":
      return isTelnyxConnectedMessage(parsed)
        ? (parsed as TelnyxConnectedMessage)
        : undefined;
    case "start":
      return isTelnyxStartMessage(parsed)
        ? (parsed as TelnyxStartMessage)
        : undefined;
    case "media":
      return isTelnyxMediaMessage(parsed)
        ? (parsed as TelnyxMediaMessage)
        : undefined;
    case "mark":
      return isTelnyxMarkMessage(parsed)
        ? (parsed as TelnyxMarkMessage)
        : undefined;
    case "stop":
      return isTelnyxStopMessage(parsed)
        ? (parsed as TelnyxStopMessage)
        : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Outbound (adapter -> Telnyx)
//
// Unlike Twilio, outbound frames carry no stream id — the socket connection
// itself is the addressing.
// ---------------------------------------------------------------------------

/** Serializes a `media` message carrying base64 audio for playback. */
export function serializeTelnyxMedia(payloadBase64: string): string {
  return JSON.stringify({ event: "media", media: { payload: payloadBase64 } });
}

/** Serializes a `mark` message — Telnyx echoes it back once playback reaches it. */
export function serializeTelnyxMark(name: string): string {
  return JSON.stringify({ event: "mark", mark: { name } });
}

/** Serializes a `clear` message — flushes Telnyx's buffered outbound audio. */
export function serializeTelnyxClear(): string {
  return JSON.stringify({ event: "clear" });
}
