/**
 * Pure call-control routing: no WebSocket, no media, no AI. This is the
 * headline "route calls in a few lines" use case — every inbound call is
 * decided (rejected, forwarded, or sent to voicemail) entirely at the
 * control-plane webhook. No `CallSession` is ever created, because no
 * decision here calls `incoming.stream()`.
 */

import { createServer, type IncomingMessage } from "node:http";
import {
  createTwilioAdapter,
  type TwilioAdapterConfig,
} from "@call-adapter/twilio";
import { Call, type Logger, type LogLevel } from "call-sdk";

export const WEBHOOK_PATH = "/twilio/voice";

/** Hour (0-23, local server time) business hours start. Office hours are `[START, END)`. */
const DEFAULT_BUSINESS_HOURS_START = 9;
/** Hour (0-23, local server time) business hours end. */
const DEFAULT_BUSINESS_HOURS_END = 18;
const DEFAULT_ON_CALL_NUMBER = "+15550001234";
/** Spoken before recording a voicemail — exported so tests can assert on it. */
export const VOICEMAIL_PROMPT = "We're unavailable — leave a message.";

/** Parses a comma-separated `E.164,E.164,...` env var into a blocklist set. */
function parseBlocklist(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

/**
 * True outside business hours (local server time): `[BUSINESS_HOURS_START,
 * BUSINESS_HOURS_END)` counts as open. Configurable via
 * `CALL_ROUTER_BUSINESS_HOURS_START` / `CALL_ROUTER_BUSINESS_HOURS_END`.
 */
export function defaultIsAfterHours(date: Date): boolean {
  const start = Number(
    process.env.CALL_ROUTER_BUSINESS_HOURS_START ?? DEFAULT_BUSINESS_HOURS_START
  );
  const end = Number(
    process.env.CALL_ROUTER_BUSINESS_HOURS_END ?? DEFAULT_BUSINESS_HOURS_END
  );
  const hour = date.getHours();
  return hour < start || hour >= end;
}

export interface CallRouterServerOptions {
  /**
   * Callers to reject outright, matched against `IncomingCall.from`.
   * Defaults to `CALL_ROUTER_BLOCKLIST` (comma-separated E.164 numbers).
   */
  blocklist?: Set<string>;
  /**
   * Decides whether "now" is outside business hours. Injectable so tests can
   * force each routing branch deterministically without faking the system
   * clock. Defaults to {@link defaultIsAfterHours}.
   */
  isAfterHours?: (date: Date) => boolean;
  logger?: Logger | LogLevel;
  /** Number after-hours calls are forwarded to. Defaults to `CALL_ROUTER_ON_CALL_NUMBER`. */
  onCallNumber?: string;
  twilio?: TwilioAdapterConfig;
}

/**
 * Builds the `Call` + node:http server: three routing branches, no media
 * plane. Swapping providers is the one adapter line in `adapters` below.
 */
export function createRouterServer(options: CallRouterServerOptions = {}) {
  const blocklist =
    options.blocklist ?? parseBlocklist(process.env.CALL_ROUTER_BLOCKLIST);
  const onCallNumber =
    options.onCallNumber ??
    process.env.CALL_ROUTER_ON_CALL_NUMBER ??
    DEFAULT_ON_CALL_NUMBER;
  const isAfterHours = options.isAfterHours ?? defaultIsAfterHours;

  const call = new Call({
    adapters: {
      twilio: createTwilioAdapter({ ...options.twilio }),
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  call.onIncomingCall((incoming) => {
    if (blocklist.has(incoming.from ?? "")) {
      return incoming.reject();
    }
    if (isAfterHours(new Date())) {
      return incoming.forwardTo(onCallNumber);
    }
    return incoming.voicemail({ prompt: VOICEMAIL_PROMPT });
  });

  async function listen(port = 3000) {
    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url?.split("?")[0] === WEBHOOK_PATH) {
        void toFetchRequest(req)
          .then((request) => call.webhooks.twilio(request))
          .then(async (response) => {
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers)
            );
            res.end(await response.text());
          })
          .catch(() => {
            res.writeHead(500);
            res.end();
          });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => server.listen(port, resolve));
    const address = server.address();
    const boundPort =
      typeof address === "object" && address ? address.port : port;
    return {
      port: boundPort,
      close: async () => {
        await call.shutdown();
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );
      },
    };
  }

  return { call, listen };
}

/** Adapts a node:http request into a WHATWG Request (honoring proxy scheme headers). */
export async function toFetchRequest(req: IncomingMessage): Promise<Request> {
  const scheme = req.headers["x-forwarded-proto"] ?? "http";
  const host = req.headers.host ?? "localhost";
  const url = `${scheme}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        headers.append(key, v);
      }
    }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  return new Request(url, {
    method: req.method ?? "POST",
    headers,
    body: body.length > 0 ? new Uint8Array(body) : null,
  });
}
