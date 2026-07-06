import type { AdapterContext, RoutingDecision } from "call-sdk";
import { describe, expect, it, vi } from "vitest";
import { createTwilioAdapter, TwilioAdapter } from "./index";
import { computeTwilioSignature } from "./signature";

const STREAM_DECISION: RoutingDecision = {
  kind: "call-sdk/routing-decision",
  actions: [{ type: "stream" }],
};
const RECORD_ACTION_URL_RE = /action="[^"]*call_sdk_action=hangup[^"]*"/;
const ACTION_ATTR_RE = /action="([^"]*)"/;

function makeCtx(
  routeIncomingCall?: AdapterContext["routeIncomingCall"]
): AdapterContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createSession: vi.fn(),
    routeIncomingCall:
      routeIncomingCall ?? vi.fn(() => Promise.resolve(STREAM_DECISION)),
  };
}

function formRequest(
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("createTwilioAdapter", () => {
  it("creates a TwilioAdapter instance named 'twilio'", () => {
    const adapter = createTwilioAdapter();
    expect(adapter).toBeInstanceOf(TwilioAdapter);
    expect(adapter.name).toBe("twilio");
  });

  it("does not throw at construction time with no config/env at all", () => {
    expect(() => createTwilioAdapter()).not.toThrow();
    expect(() => createTwilioAdapter({})).not.toThrow();
  });
});

describe("TwilioAdapter.webhook", () => {
  it("returns 200 + Connect/Stream TwiML on a validly signed request", async () => {
    const adapter = createTwilioAdapter({
      authToken: "test-token",
      mediaUrl: "wss://media.example.com/twilio/media",
    });
    adapter.bind(makeCtx());

    const url = "https://voice.example.com/twilio/voice";
    const fields = {
      CallSid: "CA123",
      From: "+15551234567",
      To: "+15557654321",
      Direction: "inbound",
    };
    const signature = computeTwilioSignature("test-token", url, fields);
    const response = await adapter.webhook(
      formRequest(url, fields, { "X-Twilio-Signature": signature })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/xml");
    const body = await response.text();
    expect(body).toContain(
      '<Stream url="wss://media.example.com/twilio/media">'
    );
    expect(body).toContain('<Parameter name="from" value="+15551234567"/>');
    expect(body).toContain('<Parameter name="to" value="+15557654321"/>');
    expect(body).toContain('<Parameter name="direction" value="inbound"/>');
  });

  it("returns 403 when the signature is invalid", async () => {
    const adapter = createTwilioAdapter({
      authToken: "test-token",
      mediaUrl: "wss://media.example.com/twilio/media",
    });
    adapter.bind(makeCtx());

    const url = "https://voice.example.com/twilio/voice";
    const fields = {
      CallSid: "CA123",
      From: "+15551234567",
      To: "+15557654321",
    };
    const response = await adapter.webhook(
      formRequest(url, fields, {
        "X-Twilio-Signature": "not-the-right-signature",
      })
    );

    expect(response.status).toBe(403);
  });

  it("does not validate signatures when explicitly disabled", async () => {
    const ctx = makeCtx();
    const adapter = createTwilioAdapter({
      authToken: "test-token",
      mediaUrl: "wss://media.example.com/twilio/media",
      validateSignature: false,
    });
    adapter.bind(ctx);

    const response = await adapter.webhook(
      formRequest("https://voice.example.com/twilio/voice", {
        CallSid: "CA123",
        From: "+15551234567",
        To: "+15557654321",
      })
    );

    expect(response.status).toBe(200);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("signature validation is disabled")
    );
  });

  it("derives the media URL from the request's Host header when config.mediaUrl is unset", async () => {
    const adapter = createTwilioAdapter({ validateSignature: false });
    adapter.bind(makeCtx());

    const response = await adapter.webhook(
      formRequest(
        "https://voice.example.com/twilio/voice",
        { CallSid: "CA123", From: "+15551234567", To: "+15557654321" },
        // A constructed `Request` doesn't auto-populate `Host` the way a real
        // inbound HTTP request would — set it explicitly, as any real host
        // (Express, Fastify, a raw Node server) would when forwarding.
        { host: "voice.example.com" }
      )
    );
    const body = await response.text();
    expect(body).toContain(
      '<Stream url="wss://voice.example.com/twilio/media">'
    );
  });

  it("marks outbound-* directions as 'outbound'", async () => {
    const adapter = createTwilioAdapter({
      validateSignature: false,
      mediaUrl: "wss://media.example.com/twilio/media",
    });
    adapter.bind(makeCtx());

    const response = await adapter.webhook(
      formRequest("https://voice.example.com/twilio/voice", {
        CallSid: "CA123",
        From: "+15551234567",
        To: "+15557654321",
        Direction: "outbound-api",
      })
    );
    const body = await response.text();
    expect(body).toContain('<Parameter name="direction" value="outbound"/>');
  });
});

describe("TwilioAdapter.webhook — routing decision translation", () => {
  const AUTH_TOKEN = "test-token";
  const WEBHOOK_URL = "https://voice.example.com/twilio/voice";
  const FIELDS = {
    CallSid: "CA123",
    From: "+15551234567",
    To: "+15557654321",
  };

  function signedRequest(url: string): Request {
    const signature = computeTwilioSignature(AUTH_TOKEN, url, FIELDS);
    return formRequest(url, FIELDS, { "X-Twilio-Signature": signature });
  }

  it("translates a reject decision to <Reject/> with no <Connect>", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        kind: "call-sdk/routing-decision",
        actions: [{ type: "reject", reason: "rejected" }],
      })
    );
    const adapter = createTwilioAdapter({ authToken: AUTH_TOKEN });
    adapter.bind(ctx);

    const response = await adapter.webhook(signedRequest(WEBHOOK_URL));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<Reject reason="rejected"/>');
    expect(body).not.toContain("<Connect>");
  });

  it("translates a voicemail decision (say + record) with an action URL back to this webhook", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        kind: "call-sdk/routing-decision",
        actions: [
          { type: "say", text: "Leave a message" },
          { type: "record", maxLengthSeconds: 60, playBeep: true },
        ],
      })
    );
    const adapter = createTwilioAdapter({ authToken: AUTH_TOKEN });
    adapter.bind(ctx);

    const response = await adapter.webhook(signedRequest(WEBHOOK_URL));

    expect(response.status).toBe(200);
    const body = await response.text();
    const sayIndex = body.indexOf("<Say");
    const recordIndex = body.indexOf("<Record");
    expect(sayIndex).toBeGreaterThanOrEqual(0);
    expect(recordIndex).toBeGreaterThan(sayIndex);
    expect(body).toContain(">Leave a message</Say>");
    expect(body).toContain('maxLength="60"');
    expect(body).toContain('playBeep="true"');
    expect(body).toMatch(RECORD_ACTION_URL_RE);
    const actionUrlMatch = body.match(ACTION_ATTR_RE);
    expect(actionUrlMatch?.[1]).toContain(
      "https://voice.example.com/twilio/voice?"
    );
  });

  it("completes the <Record> continuation hit with <Hangup/> without re-running routing", async () => {
    const routeIncomingCall = vi.fn(() => Promise.resolve(STREAM_DECISION));
    const ctx = makeCtx(routeIncomingCall);
    const adapter = createTwilioAdapter({ authToken: AUTH_TOKEN });
    adapter.bind(ctx);

    const continuationUrl = `${WEBHOOK_URL}?call_sdk_action=hangup`;
    const response = await adapter.webhook(signedRequest(continuationUrl));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
    );
    expect(routeIncomingCall).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature on the continuation URL with 403", async () => {
    const adapter = createTwilioAdapter({ authToken: AUTH_TOKEN });
    adapter.bind(makeCtx());

    const continuationUrl = `${WEBHOOK_URL}?call_sdk_action=hangup`;
    const response = await adapter.webhook(
      formRequest(continuationUrl, FIELDS, {
        "X-Twilio-Signature": "not-the-right-signature",
      })
    );

    expect(response.status).toBe(403);
  });

  it("returns 500 when the decision contains an action this adapter cannot translate", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        kind: "call-sdk/routing-decision",
        actions: [
          { type: "teleport" } as unknown as RoutingDecision["actions"][number],
        ],
      })
    );
    const adapter = createTwilioAdapter({ authToken: AUTH_TOKEN });
    adapter.bind(ctx);

    const response = await adapter.webhook(signedRequest(WEBHOOK_URL));

    expect(response.status).toBe(500);
  });
});
