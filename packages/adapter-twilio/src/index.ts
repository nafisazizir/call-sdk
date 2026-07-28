/**
 * The Twilio adapter: normalizes Twilio's raw Media Streams audio to/from
 * the SDK's canonical format and emits call lifecycle events. Built on
 * Twilio's raw audio streaming layer, not its managed voice-AI product —
 * this adapter contains no VAD, transcription, or turn logic; it only moves
 * bytes and facts.
 */

import {
  type Adapter,
  type AdapterContext,
  type AdapterDialOptions,
  AdapterError,
  type AdapterSessionHandle,
  downsampleX2,
  FrameChunker,
  type MediaSocket,
  mediaSocketDataToText,
  mulawDecode,
  mulawEncode,
  type OutboundAudio,
  type RoutingDecision,
  upsampleX2,
  type WebhookOptions,
} from "call-sdk";
import {
  parseTwilioMessage,
  serializeTwilioClear,
  serializeTwilioMark,
  serializeTwilioMedia,
} from "./protocol";
import { startTwilioCall } from "./rest";
import { validateTwilioSignature } from "./signature";
import { connectStreamTwiml, routingDecisionTwiml } from "./twiml";
import type { TwilioAdapterConfig } from "./types";

const DEFAULT_MEDIA_PATH = "/twilio/media";
const DEFAULT_API_BASE_URL = "https://api.twilio.com";
/** Query param the continuation hit (e.g. `<Record action=...>`) arrives with. */
const CALL_SDK_ACTION_PARAM = "call_sdk_action";
const HANGUP_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';

/**
 * True iff `decision` is exactly the default/no-handler `stream()` decision
 * — the one existing case the webhook still handles via `connectStreamTwiml`
 * rather than `routingDecisionTwiml` (a `stream` action has no standalone
 * TwiML form; it IS the `<Connect><Stream>` hand-off).
 */
function isStreamOnlyDecision(decision: RoutingDecision): boolean {
  return (
    decision.actions.length === 1 && decision.actions[0]?.type === "stream"
  );
}

export class TwilioAdapter implements Adapter {
  readonly name = "twilio";

  #ctx?: AdapterContext;
  readonly #config: TwilioAdapterConfig;
  #warnedSignatureDisabled = false;

  constructor(config: TwilioAdapterConfig = {}) {
    this.#config = config;
  }

  bind(ctx: AdapterContext): void {
    this.#ctx = ctx;
  }

  /**
   * Control plane: Twilio's inbound-call webhook. Validates the request
   * signature (unless disabled — this happens first and unconditionally),
   * then either completes a previously-made decision (the `<Record
   * action=...>` continuation hit) or hands the call to core's routing and
   * translates the resulting `RoutingDecision` into TwiML.
   */
  async webhook(
    request: Request,
    _options?: WebhookOptions
  ): Promise<Response> {
    const ctx = this.#requireCtx();
    const bodyText = await request.text();
    const params = Object.fromEntries(new URLSearchParams(bodyText).entries());

    if (this.#shouldValidateSignature()) {
      const authToken = this.#requireAuthToken(
        "signature validation is enabled but no auth token is configured"
      );
      const signature = request.headers.get("X-Twilio-Signature") ?? "";
      const valid = validateTwilioSignature(
        authToken,
        request.url,
        params,
        signature
      );
      if (!valid) {
        ctx.logger.warn("rejected Twilio webhook: invalid X-Twilio-Signature");
        return new Response("Forbidden", { status: 403 });
      }
    } else if (!this.#warnedSignatureDisabled) {
      this.#warnedSignatureDisabled = true;
      ctx.logger.warn(
        "Twilio webhook signature validation is disabled — requests are not authenticated"
      );
    }

    // The continuation hit from a `<Record action=...>` (or any other
    // action's callback): Twilio re-requests this URL when the action
    // completes. This is the mechanical tail of a decision core already
    // made, not a new routing decision, so it never calls
    // `routeIncomingCall` again.
    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.get(CALL_SDK_ACTION_PARAM) === "hangup") {
      return new Response(HANGUP_TWIML, {
        status: 200,
        headers: { "content-type": "text/xml" },
      });
    }

    const from = params.From;
    const to = params.To;
    const decision = await ctx.routeIncomingCall({
      callId: params.CallSid ?? "",
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      raw: params,
    });

    if (isStreamOnlyDecision(decision)) {
      const direction = (params.Direction ?? "inbound").startsWith("outbound")
        ? "outbound"
        : "inbound";
      const mediaUrl = this.#resolveInboundMediaUrl(request);
      const twiml = connectStreamTwiml(mediaUrl, {
        from: from ?? "",
        to: to ?? "",
        direction,
      });
      return new Response(twiml, {
        status: 200,
        headers: { "content-type": "text/xml" },
      });
    }

    try {
      const twiml = routingDecisionTwiml(decision, {
        actionUrl: (action) => {
          const url = new URL(request.url);
          url.searchParams.set(CALL_SDK_ACTION_PARAM, action);
          return url.toString();
        },
      });
      return new Response(twiml, {
        status: 200,
        headers: { "content-type": "text/xml" },
      });
    } catch (err) {
      // `routeIncomingCall` never rejects (core converts every failure into
      // a decision) — only the translation step can throw, e.g. an
      // `AdapterError` for a verb this adapter can't express.
      ctx.logger.error("failed to translate routing decision to TwiML", {
        error: String(err),
      });
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  /**
   * Media plane: owns the Media Streams wire protocol for one connection —
   * `connected`/`start` bring the session up, `media` frames flow bidirec-
   * tionally through the canonical format, `mark` echoes drive playback-
   * completion detection, and `stop`/close/error all end the call exactly
   * once — a dropped media socket ends the call.
   */
  media(socket: MediaSocket): void {
    const ctx = this.#requireCtx();
    let handle: AdapterSessionHandle | undefined;
    let streamSid: string | undefined;
    let chunker: FrameChunker | undefined;
    let socketOpen = true;
    let stopSeen = false;

    const guardedSend = (label: string, data: string): void => {
      if (!socketOpen) {
        ctx.logger.debug(`dropping ${label}: media socket is closed`);
        return;
      }
      try {
        socket.send(data);
      } catch (err) {
        ctx.logger.debug(`failed to send Twilio ${label}`, {
          error: String(err),
        });
      }
    };

    const outbound: OutboundAudio = {
      write: (frame) => {
        if (!streamSid) {
          return;
        }
        const mulaw = mulawEncode(downsampleX2(frame.samples));
        guardedSend(
          "media",
          serializeTwilioMedia(streamSid, Buffer.from(mulaw).toString("base64"))
        );
      },
      mark: (name) => {
        if (!streamSid) {
          return;
        }
        guardedSend("mark", serializeTwilioMark(streamSid, name));
      },
      clear: () => {
        if (!streamSid) {
          return;
        }
        guardedSend("clear", serializeTwilioClear(streamSid));
      },
    };

    const endOnce = (reason: "hangup" | "media-closed"): void => {
      if (stopSeen) {
        return;
      }
      stopSeen = true;
      handle?.end(reason);
    };

    socket.addEventListener("message", (event) => {
      const message = parseTwilioMessage(mediaSocketDataToText(event.data));
      if (!message) {
        ctx.logger.debug("ignoring unrecognized Twilio media message");
        return;
      }
      switch (message.event) {
        case "connected":
          break;
        case "start": {
          streamSid = message.streamSid;
          const custom = message.start.customParameters ?? {};
          const direction =
            custom.direction === "outbound" ? "outbound" : "inbound";
          chunker = new FrameChunker();
          handle = ctx.createSession(
            {
              callId: message.start.callSid,
              direction,
              ...(custom.from === undefined ? {} : { from: custom.from }),
              ...(custom.to === undefined ? {} : { to: custom.to }),
              raw: message,
            },
            outbound
          );
          handle.answered();
          break;
        }
        case "media": {
          if (!(handle && chunker)) {
            ctx.logger.debug("media frame before start — dropped");
            return;
          }
          const decoded = mulawDecode(
            Buffer.from(message.media.payload, "base64")
          );
          const frames = chunker.push(upsampleX2(decoded));
          for (const frame of frames) {
            handle.deliverAudio(frame);
          }
          break;
        }
        case "mark":
          handle?.mark(message.mark.name);
          break;
        case "stop":
          endOnce("hangup");
          break;
        default:
          break;
      }
    });

    socket.addEventListener("close", () => {
      socketOpen = false;
      endOnce("media-closed");
    });

    socket.addEventListener("error", (err) => {
      // A mere socket error races the close event and is not a semantic
      // adapter failure — treat it the same as a dropped media socket, not
      // `handle.fail`.
      ctx.logger.warn("Twilio media socket error", { error: String(err) });
      endOnce("media-closed");
    });
  }

  /** Places an outbound call via Twilio's REST API and connects it to the media plane. */
  async dial(options: AdapterDialOptions): Promise<{ callId: string }> {
    const from =
      options.from ??
      this.#config.phoneNumber ??
      process.env.TWILIO_PHONE_NUMBER;
    if (!from) {
      throw new AdapterError(
        "dial requires a 'from' number: pass options.from, set config.phoneNumber, or set TWILIO_PHONE_NUMBER",
        { adapterName: "twilio" }
      );
    }
    const mediaUrl = this.#config.mediaUrl;
    if (!mediaUrl) {
      throw new AdapterError(
        "dial requires config.mediaUrl — an outbound call has no inbound request to derive it from",
        { adapterName: "twilio" }
      );
    }
    const twiml = connectStreamTwiml(mediaUrl, {
      ...options.metadata,
      direction: "outbound",
      from,
      to: options.to,
    });
    return await startTwilioCall({
      accountSid: this.#requireAccountSid(),
      authToken: this.#requireAuthToken("dial requires an auth token"),
      apiBaseUrl: this.#config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      to: options.to,
      from,
      twiml,
    });
  }

  // ---------------------------------------------------------------------
  // Lazy config resolution — nothing here runs (or throws) at construction.
  // ---------------------------------------------------------------------

  #requireCtx(): AdapterContext {
    if (!this.#ctx) {
      throw new AdapterError(
        "TwilioAdapter used before bind() — pass it to `new Call({ adapters: { twilio: ... } })` first",
        { adapterName: "twilio" }
      );
    }
    return this.#ctx;
  }

  #requireAccountSid(): string {
    const sid = this.#config.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    if (!sid) {
      throw new AdapterError(
        "Missing Twilio account SID: set config.accountSid or TWILIO_ACCOUNT_SID",
        { adapterName: "twilio" }
      );
    }
    return sid;
  }

  #requireAuthToken(context: string): string {
    const token = this.#config.authToken ?? process.env.TWILIO_AUTH_TOKEN;
    if (!token) {
      throw new AdapterError(
        `Missing Twilio auth token (${context}): set config.authToken or TWILIO_AUTH_TOKEN`,
        { adapterName: "twilio" }
      );
    }
    return token;
  }

  #shouldValidateSignature(): boolean {
    if (this.#config.validateSignature !== undefined) {
      return this.#config.validateSignature;
    }
    return Boolean(this.#config.authToken ?? process.env.TWILIO_AUTH_TOKEN);
  }

  #resolveInboundMediaUrl(request: Request): string {
    if (this.#config.mediaUrl) {
      return this.#config.mediaUrl;
    }
    const host = request.headers.get("host");
    if (!host) {
      throw new AdapterError(
        "Cannot derive the Twilio media URL: the request has no Host header and config.mediaUrl is unset",
        { adapterName: "twilio" }
      );
    }
    const mediaPath = this.#config.mediaPath ?? DEFAULT_MEDIA_PATH;
    return `wss://${host}${mediaPath}`;
  }
}

/** Creates a Twilio adapter. See {@link TwilioAdapterConfig} for lazy config resolution. */
export function createTwilioAdapter(
  config?: TwilioAdapterConfig
): TwilioAdapter {
  return new TwilioAdapter(config);
}

export type {
  TwilioConnectedMessage,
  TwilioInboundMessage,
  TwilioMarkMessage,
  TwilioMediaMessage,
  TwilioStartMessage,
  TwilioStopMessage,
} from "./protocol";
export { parseTwilioMessage } from "./protocol";
export { startTwilioCall } from "./rest";
export { computeTwilioSignature, validateTwilioSignature } from "./signature";
// Re-exported so consumers building custom media hosts or tests can reuse
// the adapter's own building blocks without reimplementing them.
export { connectStreamTwiml } from "./twiml";
export type { TwilioAdapterConfig } from "./types";
