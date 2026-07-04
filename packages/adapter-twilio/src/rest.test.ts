import { createServer, type Server } from "node:http";
import { AdapterError } from "call-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTwilioCall } from "./rest";

interface CapturedRequest {
  authorization: string | undefined;
  body: URLSearchParams;
  method: string | undefined;
  url: string | undefined;
}

describe("startTwilioCall", () => {
  let server: Server;
  let baseUrl: string;
  let captured: CapturedRequest | undefined;
  let responseStatus = 201;
  let responseBody = "";

  beforeEach(async () => {
    captured = undefined;
    responseStatus = 201;
    responseBody = JSON.stringify({
      sid: "CAfakefakefakefakefakefakefakefake01",
    });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        captured = {
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body: new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
        };
        res.writeHead(responseStatus, { "content-type": "application/json" });
        res.end(responseBody);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a network address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POSTs form-encoded To/From/Twiml with Basic auth to the Calls endpoint", async () => {
    const result = await startTwilioCall({
      accountSid: "AC123",
      authToken: "secret-token",
      apiBaseUrl: baseUrl,
      to: "+15551234567",
      from: "+15557654321",
      twiml: '<Response><Connect><Stream url="wss://x"/></Connect></Response>',
    });

    expect(result).toEqual({ callId: "CAfakefakefakefakefakefakefakefake01" });
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/2010-04-01/Accounts/AC123/Calls.json");
    expect(captured?.authorization).toBe(
      `Basic ${Buffer.from("AC123:secret-token").toString("base64")}`
    );
    expect(captured?.body.get("To")).toBe("+15551234567");
    expect(captured?.body.get("From")).toBe("+15557654321");
    expect(captured?.body.get("Twiml")).toContain("<Stream");
  });

  it("throws AdapterError with the status and a body snippet on a non-2xx response", async () => {
    responseStatus = 400;
    responseBody = JSON.stringify({ message: "invalid phone number" });

    let caught: unknown;
    try {
      await startTwilioCall({
        accountSid: "AC123",
        authToken: "secret-token",
        apiBaseUrl: baseUrl,
        to: "bad-number",
        from: "+15557654321",
        twiml: "<Response/>",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    const message = (caught as Error).message;
    expect(message).toContain("400");
    expect(message).toContain("invalid phone number");
  });

  it("throws AdapterError when the response is missing a sid", async () => {
    responseBody = JSON.stringify({ ok: true });

    await expect(
      startTwilioCall({
        accountSid: "AC123",
        authToken: "secret-token",
        apiBaseUrl: baseUrl,
        to: "+15551234567",
        from: "+15557654321",
        twiml: "<Response/>",
      })
    ).rejects.toThrow(AdapterError);
  });
});
