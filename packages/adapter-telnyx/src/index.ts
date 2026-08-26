/**
 * The Telnyx adapter: a Call Control v2 (async REST commands + webhooks, not
 * TeXML) telephony adapter for Call SDK. It normalizes Telnyx's raw media
 * streaming audio to/from the SDK's canonical format, translates routing
 * decisions into Call Control commands, and emits call lifecycle events.
 *
 * Built on Telnyx's raw audio streaming layer, not its managed voice-AI
 * product — this adapter contains no VAD,
 * transcription, or turn logic; it only moves bytes and facts.
 *
 * Where the Twilio adapter answers each webhook with a synchronous TwiML
 * document, Telnyx is asynchronous: the webhook is acked with a bare 200 and
 * control happens through follow-up REST commands whose outcomes arrive as
 * more webhooks. The multi-step chaining that implies lives in the pure
 * sequencer (`./events`); this file is the I/O shell that executes its plans.
 */

import {
  type Adapter,
  type AdapterContext,
  type AdapterDialOptions,
  AdapterError,
  type AdapterSessionHandle,
  bytesToInt16,
  downsampleX2,
  FrameChunker,
  int16ToBytes,
  type MediaSocket,
  mediaSocketDataToText,
  mulawDecode,
  mulawEncode,
  type OutboundAudio,
  upsampleX2,
  type WebhookOptions,
} from "call-sdk";
import {
  createTelnyxCommandClient,
  type TelnyxCommandClient,
} from "./commands";
import {
  advanceSequence,
  type CommandPlan,
  decodeClientState,
  encodeClientState,
  parseTelnyxWebhook,
  planInitialCommand,
} from "./events";
import {
  parseTelnyxMessage,
  serializeTelnyxClear,
  serializeTelnyxMark,
  serializeTelnyxMedia,
  type TelnyxMediaFormat,
} from "./protocol";
import { verifyTelnyxSignature } from "./signature";
import type { TelnyxAdapterConfig } from "./types";

const DEFAULT_MEDIA_PATH = "/telnyx/media";
const DEFAULT_API_BASE_URL = "https://api.telnyx.com";
/** Canonical inbound stream params for a bidirectional L16/16k media socket. */
const STREAM_PARAMS = {
  stream_track: "inbound_track",
  stream_codec: "L16",
  stream_bidirectional_mode: "rtp",
  stream_bidirectional_codec: "L16",
  stream_bidirectional_sampling_rate: 16_000,
} as const;

/** A codec path: how to normalize one provider media frame in and out. */
interface CodecPath {
  /** base64 provider payload -> canonical PCM16 @ 16kHz samples. */
  decode(payloadBase64: string): Int16Array;
  /** canonical PCM16 @ 16kHz samples -> provider frame bytes. */
  encode(samples: Int16Array): Uint8Array;
}

/**
 * Selects the codec path from the negotiated inbound `media_format` announced
 * on the media socket's `start`. Telnyx can stream μ-law (`PCMU`) or linear
 * PCM (`L16`) at 8k or 16k; the SDK's canonical format is PCM16 @ 16kHz, so:
 * μ-law/8k and L16/8k are resampled ×2, L16/16k passes through. An
 * unrecognized format is a loud failure — no silent fallback; the caller
 * closes the socket.
 */
function selectCodecPath(format: TelnyxMediaFormat): CodecPath | undefined {
  const encoding = format.encoding.toUpperCase();
  const rate = format.sample_rate;
  const isMulaw = encoding === "PCMU" || encoding === "AUDIO/X-MULAW";
  const isLinear = encoding === "L16" || encoding === "AUDIO/L16";

  if (isMulaw && rate === 8000) {
    return {
      decode: (b64) => upsampleX2(mulawDecode(Buffer.from(b64, "base64"))),
      encode: (samples) => mulawEncode(downsampleX2(samples)),
    };
  }
  if (isLinear && rate === 8000) {
    return {
      decode: (b64) => upsampleX2(bytesToInt16(Buffer.from(b64, "base64"))),
      encode: (samples) => int16ToBytes(downsampleX2(samples)),
    };
  }
  if (isLinear && rate === 16_000) {
    return {
      decode: (b64) => bytesToInt16(Buffer.from(b64, "base64")),
      encode: (samples) => int16ToBytes(samples),
    };
  }
  return undefined;
}

export class TelnyxAdapter implements Adapter {
  readonly name = "telnyx";

  #ctx?: AdapterContext;
  readonly #config: TelnyxAdapterConfig;
  #client?: TelnyxCommandClient;
  #warnedSignatureDisabled = false;

  constructor(config: TelnyxAdapterConfig = {}) {
    this.#config = config;
  }

  bind(ctx: AdapterContext): void {
    this.#ctx = ctx;
  }

  /**
   * Control plane: Telnyx's Call Control webhook. Verifies the Ed25519
   * signature over the raw body first (unless disabled), then either advances
   * an in-flight call (a webhook carrying our `client_state`, which must NOT
   * re-route — the `client_state` analog of Twilio's `?call_sdk_action`
   * short-circuit) or, for a fresh `call.initiated`, routes the call and
   * plans its first command. Every command is awaited before the bare 200 ack
   * is returned (conformance depends on it).
   */
  async webhook(
    request: Request,
    _options?: WebhookOptions
  ): Promise<Response> {
    const ctx = this.#requireCtx();
    const rawBody = await request.text();

    if (this.#shouldValidateSignature()) {
      const publicKey = this.#requirePublicKey();
      const signature = request.headers.get("telnyx-signature-ed25519") ?? "";
      const timestamp = request.headers.get("telnyx-timestamp") ?? "";
      const valid = verifyTelnyxSignature({
        publicKey,
        signature,
        timestamp,
        rawBody,
      });
      if (!valid) {
        ctx.logger.warn(
          "rejected Telnyx webhook: invalid telnyx-signature-ed25519"
        );
        return new Response("Forbidden", { status: 403 });
      }
    } else if (!this.#warnedSignatureDisabled) {
      this.#warnedSignatureDisabled = true;
      ctx.logger.warn(
        "Telnyx webhook signature validation is disabled — requests are not authenticated"
      );
    }

    const event = parseTelnyxWebhook(rawBody);
    if (!event) {
      // A bare 200 acks the (unusable) delivery: a non-2xx would make Telnyx
      // redeliver garbage on a retry timer forever.
      ctx.logger.debug("ignoring unparseable Telnyx webhook");
      return ack();
    }

    const ccid = event.payload.callControlId;
    const state = decodeClientState(event.payload.clientState);

    // A continuation: the webhook carries a `client_state` we ourselves
    // stamped on the call. This is the mechanical tail of a decision already
    // made — never a new routing decision — so `routeIncomingCall` is NOT
    // called again (cf. Twilio's `?call_sdk_action` continuation short-
    // circuit). Outbound stream calls also land here (their `call.initiated`
    // echoes the `client_state` set at dial time) and correctly no-op.
    if (state) {
      const { plan, commandId } = advanceSequence(event, state);
      await this.#execute(plan, ccid, commandId);
      return ack();
    }

    if (event.eventType === "call.initiated") {
      const { from, to } = event.payload;
      const decision = await ctx.routeIncomingCall({
        callId: ccid,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        raw: event.payload.raw,
      });
      const { plan, commandId } = planInitialCommand(decision, {
        callControlId: ccid,
        direction: "inbound",
        streamUrl: this.#resolveMediaUrl(request),
      });
      await this.#execute(plan, ccid, commandId);
      return ack();
    }

    // A stateless event that isn't a fresh call (a late completion for a call
    // we've forgotten, a status update we don't act on): ack and move on.
    return ack();
  }

  /**
   * Media plane: owns the Telnyx media WebSocket wire protocol for one
   * connection. `connected`/`start` bring the session up (the `start`'s
   * `media_format` selects the codec path), `media` frames flow bidirection-
   * ally through the canonical format, `mark` echoes drive playback-completion
   * detection, and `stop`/close/error all end the call exactly once — a
   * dropped media socket ends the call.
   */
  media(socket: MediaSocket): void {
    const ctx = this.#requireCtx();
    let handle: AdapterSessionHandle | undefined;
    let chunker: FrameChunker | undefined;
    let codec: CodecPath | undefined;
    let started = false;
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
        ctx.logger.debug(`failed to send Telnyx ${label}`, {
          error: String(err),
        });
      }
    };

    const outbound: OutboundAudio = {
      write: (frame) => {
        if (!codec) {
          return;
        }
        const bytes = codec.encode(frame.samples);
        guardedSend(
          "media",
          serializeTelnyxMedia(Buffer.from(bytes).toString("base64"))
        );
      },
      mark: (name) => {
        if (!codec) {
          return;
        }
        guardedSend("mark", serializeTelnyxMark(name));
      },
      clear: () => {
        if (!codec) {
          return;
        }
        guardedSend("clear", serializeTelnyxClear());
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
      const message = parseTelnyxMessage(mediaSocketDataToText(event.data));
      if (!message) {
        ctx.logger.debug("ignoring unrecognized Telnyx media message");
        return;
      }
      switch (message.event) {
        case "connected":
          break;
        case "start": {
          codec = selectCodecPath(message.start.media_format);
          if (!codec) {
            ctx.logger.error(
              "unsupported Telnyx media format — closing socket",
              {
                encoding: message.start.media_format.encoding,
                sampleRate: message.start.media_format.sample_rate,
              }
            );
            socket.close();
            return;
          }
          const decoded = decodeClientState(message.start.client_state);
          const direction = decoded?.direction ?? "inbound";
          const { from, to } = message.start;
          chunker = new FrameChunker();
          started = true;
          handle = ctx.createSession(
            {
              callId: message.start.call_control_id,
              direction,
              ...(from === undefined ? {} : { from }),
              ...(to === undefined ? {} : { to }),
              raw: message,
            },
            outbound
          );
          handle.answered();
          break;
        }
        case "media": {
          if (!(started && handle && chunker && codec)) {
            ctx.logger.debug("media frame before start — dropped");
            return;
          }
          const frames = chunker.push(codec.decode(message.media.payload));
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
      ctx.logger.warn("Telnyx media socket error", { error: String(err) });
      endOnce("media-closed");
    });
  }

  /** Places an outbound call via Telnyx's REST API and connects it to the media plane. */
  async dial(options: AdapterDialOptions): Promise<{ callId: string }> {
    const from =
      options.from ??
      this.#config.phoneNumber ??
      process.env.TELNYX_PHONE_NUMBER;
    if (!from) {
      throw new AdapterError(
        "dial requires a 'from' number: pass options.from, set config.phoneNumber, or set TELNYX_PHONE_NUMBER",
        { adapterName: "telnyx" }
      );
    }
    const connectionId =
      this.#config.connectionId ?? process.env.TELNYX_CONNECTION_ID;
    if (!connectionId) {
      throw new AdapterError(
        "dial requires a connection id: set config.connectionId or TELNYX_CONNECTION_ID",
        { adapterName: "telnyx" }
      );
    }
    const mediaUrl = this.#config.mediaUrl;
    if (!mediaUrl) {
      throw new AdapterError(
        "dial requires config.mediaUrl — an outbound call has no inbound request to derive it from",
        { adapterName: "telnyx" }
      );
    }

    const body: Record<string, unknown> = {
      to: options.to,
      from,
      connection_id: connectionId,
      stream_url: mediaUrl,
      ...STREAM_PARAMS,
      client_state: encodeClientState({
        v: 1,
        mode: "stream",
        direction: "outbound",
        q: [],
        step: 0,
      }),
    };
    if (options.metadata) {
      // Telnyx has no free-form metadata bag on `createCall`, but it forwards
      // SIP `custom_headers` — the closest analog. Namespaced so they don't
      // collide with a consumer's own headers.
      body.custom_headers = Object.entries(options.metadata).map(
        ([name, value]) => ({ name: `X-Call-Sdk-${name}`, value })
      );
    }
    return await this.#commandClient().createCall(body);
  }

  // ---------------------------------------------------------------------
  // Command translation — every CommandPlan becomes an awaited REST call.
  // ---------------------------------------------------------------------

  async #execute(
    plan: CommandPlan,
    callControlId: string,
    commandId: string
  ): Promise<void> {
    if (plan.kind === "noop") {
      return;
    }
    const ctx = this.#requireCtx();
    const client = this.#commandClient();
    try {
      await this.#dispatch(client, plan, callControlId, commandId);
    } catch (err) {
      ctx.logger.error("Telnyx command failed", {
        command: plan.kind,
        error: String(err),
      });
      // A failed non-terminating command would leave the caller in dead air.
      // Best-effort hang up so the call doesn't hang open; swallow its own
      // failure (a teardown path never throws). We still return 200 to the
      // webhook: a non-2xx would make Telnyx redeliver `call.initiated` and
      // double-route the call.
      if (plan.kind !== "hangup" && plan.kind !== "reject") {
        try {
          await client.hangup(callControlId, {});
        } catch (hangupErr) {
          ctx.logger.error("Telnyx fallback hangup failed", {
            error: String(hangupErr),
          });
        }
      }
    }
  }

  /** A flat 1:1 command dispatch: each arm is one awaited REST call. */
  #dispatch(
    client: TelnyxCommandClient,
    plan: CommandPlan,
    ccid: string,
    commandId: string
  ): Promise<void> {
    switch (plan.kind) {
      case "reject":
        return client.reject(ccid, {
          cause: plan.cause,
          command_id: commandId,
        });
      case "hangup":
        return client.hangup(plan.target ?? ccid, {
          command_id: commandId,
          ...(plan.clientState === undefined
            ? {}
            : { client_state: plan.clientState }),
        });
      case "answer":
        return client.answer(ccid, {
          command_id: commandId,
          client_state: plan.clientState,
          ...(plan.stream === undefined
            ? {}
            : { stream_url: plan.stream.streamUrl, ...STREAM_PARAMS }),
        });
      case "dial":
        return this.#dialForwardLegs(client, plan, commandId);
      case "transfer":
        return client.transfer(ccid, {
          to: plan.to,
          ...(plan.from === undefined ? {} : { from: plan.from }),
          ...(plan.timeoutSecs === undefined
            ? {}
            : { timeout_secs: plan.timeoutSecs }),
          client_state: plan.clientState,
          command_id: commandId,
        });
      case "speak":
        return client.speak(ccid, {
          payload: plan.text,
          ...(plan.voice === undefined ? {} : { voice: plan.voice }),
          ...(plan.language === undefined ? {} : { language: plan.language }),
          client_state: plan.clientState,
          command_id: commandId,
        });
      case "playback":
        return client.playbackStart(ccid, {
          audio_url: plan.url,
          client_state: plan.clientState,
          command_id: commandId,
        });
      case "record":
        return client.recordStart(ccid, {
          format: "mp3",
          channels: "single",
          play_beep: plan.playBeep,
          max_length: plan.maxLengthSeconds,
          client_state: plan.clientState,
          command_id: commandId,
        });
      default:
        return Promise.resolve();
    }
  }

  /**
   * Executes a `dial` plan: one `POST /v2/calls` ringing every destination
   * of a multi-number forward simultaneously. `link_to` + bridge-on-answer
   * make Telnyx bridge the first leg to answer to the inbound call and
   * cancel the rest — first answer wins, natively.
   */
  async #dialForwardLegs(
    client: TelnyxCommandClient,
    plan: Extract<CommandPlan, { kind: "dial" }>,
    commandId: string
  ): Promise<void> {
    const from =
      plan.from ?? this.#config.phoneNumber ?? process.env.TELNYX_PHONE_NUMBER;
    if (!from) {
      throw new AdapterError(
        "forwarding to multiple numbers requires a 'from' number: the webhook carried none — set config.phoneNumber or TELNYX_PHONE_NUMBER",
        { adapterName: "telnyx" }
      );
    }
    const connectionId =
      plan.connectionId ??
      this.#config.connectionId ??
      process.env.TELNYX_CONNECTION_ID;
    if (!connectionId) {
      throw new AdapterError(
        "forwarding to multiple numbers requires a connection id: the webhook carried none — set config.connectionId or TELNYX_CONNECTION_ID",
        { adapterName: "telnyx" }
      );
    }
    await client.createCall({
      to: [...plan.targets],
      from,
      connection_id: connectionId,
      link_to: plan.linkTo,
      bridge_intent: true,
      bridge_on_answer: true,
      client_state: plan.clientState,
      command_id: commandId,
      ...(plan.timeoutSecs === undefined
        ? {}
        : { timeout_secs: plan.timeoutSecs }),
    });
  }

  // ---------------------------------------------------------------------
  // Lazy config resolution — nothing here runs (or throws) at construction.
  // ---------------------------------------------------------------------

  #commandClient(): TelnyxCommandClient {
    if (!this.#client) {
      this.#client = createTelnyxCommandClient({
        apiKey: this.#requireApiKey(),
        apiBaseUrl: this.#config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      });
    }
    return this.#client;
  }

  #requireCtx(): AdapterContext {
    if (!this.#ctx) {
      throw new AdapterError(
        "TelnyxAdapter used before bind() — pass it to `new Call({ adapters: { telnyx: ... } })` first",
        { adapterName: "telnyx" }
      );
    }
    return this.#ctx;
  }

  #requireApiKey(): string {
    const apiKey = this.#config.apiKey ?? process.env.TELNYX_API_KEY;
    if (!apiKey) {
      throw new AdapterError(
        "Missing Telnyx API key: set config.apiKey or TELNYX_API_KEY",
        { adapterName: "telnyx" }
      );
    }
    return apiKey;
  }

  #requirePublicKey(): string {
    const publicKey = this.#config.publicKey ?? process.env.TELNYX_PUBLIC_KEY;
    if (!publicKey) {
      throw new AdapterError(
        "signature validation is enabled but no public key is configured: set config.publicKey or TELNYX_PUBLIC_KEY",
        { adapterName: "telnyx" }
      );
    }
    return publicKey;
  }

  #shouldValidateSignature(): boolean {
    if (this.#config.validateSignature !== undefined) {
      return this.#config.validateSignature;
    }
    return Boolean(this.#config.publicKey ?? process.env.TELNYX_PUBLIC_KEY);
  }

  #resolveMediaUrl(request: Request): string {
    if (this.#config.mediaUrl) {
      return this.#config.mediaUrl;
    }
    const host = request.headers.get("host");
    if (!host) {
      throw new AdapterError(
        "Cannot derive the Telnyx media URL: the request has no Host header and config.mediaUrl is unset",
        { adapterName: "telnyx" }
      );
    }
    const mediaPath = this.#config.mediaPath ?? DEFAULT_MEDIA_PATH;
    return `wss://${host}${mediaPath}`;
  }
}

function ack(): Response {
  return new Response("", { status: 200 });
}

/** Creates a Telnyx adapter. See {@link TelnyxAdapterConfig} for lazy config resolution. */
export function createTelnyxAdapter(
  config?: TelnyxAdapterConfig
): TelnyxAdapter {
  return new TelnyxAdapter(config);
}

// ---------------------------------------------------------------------------
// Public re-exports — the package's building blocks, reusable by consumers
// building custom media hosts or tests without reimplementing them.
// ---------------------------------------------------------------------------

export type {
  TelnyxAnswerBody,
  TelnyxCommandClient,
  TelnyxCommandClientOptions,
  TelnyxHangupBody,
  TelnyxPlaybackStartBody,
  TelnyxRecordStartBody,
  TelnyxRejectBody,
  TelnyxSpeakBody,
  TelnyxTransferBody,
} from "./commands";
export { createTelnyxCommandClient } from "./commands";
export type {
  CommandPlan,
  TelnyxCallState,
  TelnyxCommandStep,
  TelnyxWebhookEvent,
} from "./events";
export {
  advanceSequence,
  decodeClientState,
  encodeClientState,
  parseTelnyxWebhook,
  planInitialCommand,
  telnyxCommandId,
} from "./events";
export type {
  TelnyxConnectedMessage,
  TelnyxInboundMessage,
  TelnyxMarkMessage,
  TelnyxMediaFormat,
  TelnyxMediaMessage,
  TelnyxMediaPayload,
  TelnyxStartMessage,
  TelnyxStartPayload,
  TelnyxStopMessage,
} from "./protocol";
export {
  parseTelnyxMessage,
  serializeTelnyxClear,
  serializeTelnyxMark,
  serializeTelnyxMedia,
} from "./protocol";
export type { VerifyTelnyxSignatureOptions } from "./signature";
export { telnyxPublicKeyObject, verifyTelnyxSignature } from "./signature";
export type { TelnyxAdapterConfig } from "./types";
