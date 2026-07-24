import { createServer, type Server } from "node:http";
import { AdapterError } from "call-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTelnyxCommandClient,
  type TelnyxCommandClient,
} from "./commands";

interface CapturedRequest {
  authorization: string | undefined;
  body: unknown;
  contentType: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

describe("createTelnyxCommandClient", () => {
  let server: Server;
  let baseUrl: string;
  let client: TelnyxCommandClient;
  let captured: CapturedRequest | undefined;
  let responseStatus = 200;
  let responseBody = "";

  beforeEach(async () => {
    captured = undefined;
    responseStatus = 200;
    responseBody = JSON.stringify({ data: {} });
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        captured = {
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          contentType: req.headers["content-type"],
          body: raw.length > 0 ? JSON.parse(raw) : undefined,
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
    client = createTelnyxCommandClient({
      apiKey: "test-api-key",
      apiBaseUrl: baseUrl,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("POSTs answer to the actions/answer endpoint with Bearer auth and a JSON body", async () => {
    await client.answer("v3:call-control-id", {
      client_state: "state-1",
      stream_url: "wss://example.com/telnyx/media",
    });

    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/v2/calls/v3%3Acall-control-id/actions/answer");
    expect(captured?.authorization).toBe("Bearer test-api-key");
    expect(captured?.contentType).toBe("application/json");
    expect(captured?.body).toEqual({
      client_state: "state-1",
      stream_url: "wss://example.com/telnyx/media",
    });
  });

  it("POSTs reject to the actions/reject endpoint", async () => {
    await client.reject("v3:call-control-id", { cause: "CALL_REJECTED" });

    expect(captured?.url).toBe("/v2/calls/v3%3Acall-control-id/actions/reject");
    expect(captured?.body).toEqual({ cause: "CALL_REJECTED" });
  });

  it("POSTs speak to the actions/speak endpoint", async () => {
    await client.speak("v3:call-control-id", {
      payload: "hello",
      voice: "female",
    });

    expect(captured?.url).toBe("/v2/calls/v3%3Acall-control-id/actions/speak");
    expect(captured?.body).toEqual({ payload: "hello", voice: "female" });
  });

  it("POSTs hangup to the actions/hangup endpoint with a default empty body", async () => {
    await client.hangup("v3:call-control-id");

    expect(captured?.url).toBe("/v2/calls/v3%3Acall-control-id/actions/hangup");
    expect(captured?.body).toEqual({});
  });

  it("createCall POSTs to /v2/calls and returns the call_control_id", async () => {
    responseBody = JSON.stringify({
      data: { call_control_id: "v3:new-call-control-id" },
    });

    const result = await client.createCall({
      connection_id: "conn-1",
      to: "+15551234567",
      from: "+15557654321",
    });

    expect(captured?.method).toBe("POST");
    expect(captured?.url).toBe("/v2/calls");
    expect(captured?.authorization).toBe("Bearer test-api-key");
    expect(captured?.body).toEqual({
      connection_id: "conn-1",
      to: "+15551234567",
      from: "+15557654321",
    });
    expect(result).toEqual({ callId: "v3:new-call-control-id" });
  });

  it("throws AdapterError with the status and a body snippet on a non-2xx action response", async () => {
    responseStatus = 422;
    responseBody = JSON.stringify({ errors: [{ detail: "invalid cause" }] });

    let caught: unknown;
    try {
      await client.reject("v3:call-control-id", { cause: "CALL_REJECTED" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    const message = (caught as Error).message;
    expect(message).toContain("422");
    expect(message).toContain("invalid cause");
  });

  it("throws AdapterError when createCall's response is missing call_control_id", async () => {
    responseBody = JSON.stringify({ data: {} });

    await expect(
      client.createCall({ connection_id: "conn-1", to: "+15551234567" })
    ).rejects.toThrow(AdapterError);
  });
});
