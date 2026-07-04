import type { AdapterContext } from "call-sdk";
import { describe, expect, it, vi } from "vitest";
import { createTwilioAdapter, TwilioAdapter } from "./index";
import { computeTwilioSignature } from "./signature";

function makeCtx(): AdapterContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createSession: vi.fn(),
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
