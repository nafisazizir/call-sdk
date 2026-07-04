/**
 * Twilio Media Streams wire protocol — the JSON messages exchanged over the
 * bidirectional `<Connect><Stream>` WebSocket.
 *
 * This module owns parsing (inbound, provider → adapter) and serialization
 * (outbound, adapter → provider) so `index.ts`'s media state machine never
 * touches raw JSON. Parsing is narrow and defensive: a message that doesn't
 * match one of the known shapes (or an event Twilio doesn't document) comes
 * back as `undefined` rather than throwing — a dropped/malformed frame on the
 * wire is not a reason to crash the call.
 */

export interface TwilioConnectedMessage {
  event: "connected";
  protocol: string;
  version: string;
}

export interface TwilioMediaFormat {
  channels: number;
  encoding: string;
  sampleRate: number;
}

export interface TwilioStartPayload {
  accountSid: string;
  callSid: string;
  customParameters?: Record<string, string>;
  mediaFormat: TwilioMediaFormat;
  streamSid: string;
  tracks: string[];
}

export interface TwilioStartMessage {
  event: "start";
  sequenceNumber: string;
  start: TwilioStartPayload;
  streamSid: string;
}

export interface TwilioMediaPayload {
  chunk: string;
  payload: string;
  timestamp: string;
  track: string;
}

export interface TwilioMediaMessage {
  event: "media";
  media: TwilioMediaPayload;
  sequenceNumber: string;
  streamSid: string;
}

export interface TwilioMarkMessage {
  event: "mark";
  mark: { name: string };
  streamSid: string;
}

export interface TwilioStopPayload {
  accountSid: string;
  callSid: string;
}

export interface TwilioStopMessage {
  event: "stop";
  stop: TwilioStopPayload;
  streamSid: string;
}

export type TwilioInboundMessage =
  | TwilioConnectedMessage
  | TwilioStartMessage
  | TwilioMediaMessage
  | TwilioMarkMessage
  | TwilioStopMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === "string");
}

function isTwilioMediaFormat(value: unknown): value is TwilioMediaFormat {
  return (
    isRecord(value) &&
    typeof value.encoding === "string" &&
    typeof value.sampleRate === "number" &&
    typeof value.channels === "number"
  );
}

// These take `unknown` (rather than `Record<string, unknown>`) purely so the
// `value is TwilioXMessage` predicate type-checks — a predicate's narrowed
// type must be assignable to its parameter's type, and the narrow message
// interfaces (no index signature) aren't assignable to `Record<string,
// unknown>`. Each still starts by re-confirming the value is a record.

function isTwilioConnectedMessage(
  value: unknown
): value is TwilioConnectedMessage {
  return (
    isRecord(value) &&
    typeof value.protocol === "string" &&
    typeof value.version === "string"
  );
}

function isTwilioStartMessage(value: unknown): value is TwilioStartMessage {
  if (!isRecord(value) || typeof value.streamSid !== "string") {
    return false;
  }
  const start = value.start;
  if (!isRecord(start)) {
    return false;
  }
  return (
    typeof start.streamSid === "string" &&
    typeof start.accountSid === "string" &&
    typeof start.callSid === "string" &&
    Array.isArray(start.tracks) &&
    isTwilioMediaFormat(start.mediaFormat) &&
    (start.customParameters === undefined ||
      isStringRecord(start.customParameters))
  );
}

function isTwilioMediaMessage(value: unknown): value is TwilioMediaMessage {
  if (!isRecord(value) || typeof value.streamSid !== "string") {
    return false;
  }
  const media = value.media;
  if (!isRecord(media)) {
    return false;
  }
  return (
    typeof media.track === "string" &&
    typeof media.chunk === "string" &&
    typeof media.timestamp === "string" &&
    typeof media.payload === "string"
  );
}

function isTwilioMarkMessage(value: unknown): value is TwilioMarkMessage {
  if (!isRecord(value) || typeof value.streamSid !== "string") {
    return false;
  }
  const mark = value.mark;
  return isRecord(mark) && typeof mark.name === "string";
}

function isTwilioStopMessage(value: unknown): value is TwilioStopMessage {
  if (!isRecord(value) || typeof value.streamSid !== "string") {
    return false;
  }
  const stop = value.stop;
  return (
    isRecord(stop) &&
    typeof stop.accountSid === "string" &&
    typeof stop.callSid === "string"
  );
}

/**
 * Parses one Media Streams text frame. Returns `undefined` for invalid JSON,
 * an unrecognized `event`, or a recognized event whose payload doesn't match
 * the expected shape — callers should log and ignore, never throw.
 */
export function parseTwilioMessage(
  text: string
): TwilioInboundMessage | undefined {
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
      return isTwilioConnectedMessage(parsed)
        ? (parsed as TwilioConnectedMessage)
        : undefined;
    case "start":
      return isTwilioStartMessage(parsed)
        ? (parsed as TwilioStartMessage)
        : undefined;
    case "media":
      return isTwilioMediaMessage(parsed)
        ? (parsed as TwilioMediaMessage)
        : undefined;
    case "mark":
      return isTwilioMarkMessage(parsed)
        ? (parsed as TwilioMarkMessage)
        : undefined;
    case "stop":
      return isTwilioStopMessage(parsed)
        ? (parsed as TwilioStopMessage)
        : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Outbound (adapter -> Twilio)
// ---------------------------------------------------------------------------

/** Serializes a `media` message carrying base64 mu-law audio for playback. */
export function serializeTwilioMedia(
  streamSid: string,
  payload: string
): string {
  return JSON.stringify({ event: "media", streamSid, media: { payload } });
}

/** Serializes a `mark` message — Twilio echoes it back once playback reaches it. */
export function serializeTwilioMark(streamSid: string, name: string): string {
  return JSON.stringify({ event: "mark", streamSid, mark: { name } });
}

/** Serializes a `clear` message — flushes Twilio's buffered outbound audio. */
export function serializeTwilioClear(streamSid: string): string {
  return JSON.stringify({ event: "clear", streamSid });
}
