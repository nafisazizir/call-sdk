import { createPublicKey, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildSignedTelnyxWebhook,
  createFakeTelnyxKeys,
  decodeTelnyxClientState,
  type FakeTelnyxApi,
  startFakeTelnyxApi,
  startFakeTelnyxCall,
  type TelnyxWebhookEvent,
} from "./fake-telnyx";

// Wrap the raw 32-byte Ed25519 public key back into SPKI DER so node:crypto's
// verify() can consume it — the reverse of createFakeTelnyxKeys's extraction.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const FAKE_CCID_RE = /^fake-ccid-\d+$/;
function publicKeyFromBase64(b64: string) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(b64, "base64")]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

describe("createFakeTelnyxKeys", () => {
  it("produces signatures that verify against the SPKI-wrapped public key", () => {
    const keys = createFakeTelnyxKeys();
    const timestamp = "1720000000";
    const body = '{"data":{"event_type":"call.initiated"}}';
    const signature = keys.sign(timestamp, body);
    const ok = verify(
      null,
      Buffer.from(`${timestamp}|${body}`),
      publicKeyFromBase64(keys.publicKey),
      Buffer.from(signature, "base64")
    );
    expect(ok).toBe(true);
  });

  it("rejects a tampered message", () => {
    const keys = createFakeTelnyxKeys();
    const ts = "1720000000";
    const signature = keys.sign(ts, "original");
    const ok = verify(
      null,
      Buffer.from(`${ts}|tampered`),
      publicKeyFromBase64(keys.publicKey),
      Buffer.from(signature, "base64")
    );
    expect(ok).toBe(false);
  });
});

describe("buildSignedTelnyxWebhook", () => {
  it("builds a JSON body + signature headers the scheme validates", async () => {
    const keys = createFakeTelnyxKeys();
    const req = buildSignedTelnyxWebhook(keys, {
      event_type: "call.initiated",
      payload: { call_control_id: "ccid-1", from: "+100" },
    });
    expect(req.headers.get("content-type")).toBe("application/json");
    const signature = req.headers.get("telnyx-signature-ed25519");
    const timestamp = req.headers.get("telnyx-timestamp");
    expect(signature).toBeTruthy();
    expect(timestamp).toBeTruthy();

    const body = await req.text();
    const parsed = JSON.parse(body);
    expect(parsed.data.event_type).toBe("call.initiated");
    expect(parsed.data.record_type).toBe("event");
    expect(parsed.data.payload.call_control_id).toBe("ccid-1");

    const ok = verify(
      null,
      Buffer.from(`${timestamp}|${body}`),
      publicKeyFromBase64(keys.publicKey),
      Buffer.from(signature as string, "base64")
    );
    expect(ok).toBe(true);
  });

  it("honors an explicit timestamp", () => {
    const keys = createFakeTelnyxKeys();
    const req = buildSignedTelnyxWebhook(
      keys,
      { event_type: "call.answered", payload: {} },
      { timestamp: "42" }
    );
    expect(req.headers.get("telnyx-timestamp")).toBe("42");
  });
});

describe("startFakeTelnyxApi", () => {
  let api: FakeTelnyxApi | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  it("records commands and emits consequence webhooks with echoed client_state", async () => {
    const emitted: TelnyxWebhookEvent[] = [];
    api = await startFakeTelnyxApi({
      webhookSink: (event) => {
        emitted.push(event);
      },
    });

    const res = await fetch(`${api.baseUrl}/v2/calls/ccid-7/actions/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "hi", client_state: "state-abc" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.result).toBe("ok");

    const command = await api.waitForCommand((c) => c.command === "speak");
    expect(command.ccid).toBe("ccid-7");
    expect(command.body.payload).toBe("hi");

    // speak → call.speak.ended, one macrotask later, echoing client_state.
    await api.waitForCommand(() => emitted.length > 0);
    // give the setTimeout(0) consequence a beat
    await new Promise((r) => setTimeout(r, 20));
    const ended = emitted.find((e) => e.event_type === "call.speak.ended");
    expect(ended).toBeDefined();
    expect(ended?.payload.call_control_id).toBe("ccid-7");
    expect(ended?.payload.client_state).toBe("state-abc");
  });

  it("creates a call with a synthesized call_control_id", async () => {
    api = await startFakeTelnyxApi();
    const res = await fetch(`${api.baseUrl}/v2/calls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "+1999", from: "+1888" }),
    });
    const json = await res.json();
    expect(json.data.call_control_id).toMatch(FAKE_CCID_RE);
    const created = await api.waitForCommand((c) => c.command === "create");
    expect(created.body.to).toBe("+1999");
  });
});

describe("decodeTelnyxClientState", () => {
  it("round-trips base64 JSON and returns undefined on garbage", () => {
    const encoded = Buffer.from(JSON.stringify({ n: 1 })).toString("base64");
    expect(decodeTelnyxClientState(encoded)).toEqual({ n: 1 });
    expect(decodeTelnyxClientState("!!!not-base64-json")).toBeUndefined();
  });
});

describe("startFakeTelnyxCall", () => {
  let api: FakeTelnyxApi | undefined;
  let wss: WebSocketServer | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
    await new Promise<void>((resolve) => {
      if (wss) {
        wss.close(() => resolve());
      } else {
        resolve();
      }
    });
    wss = undefined;
  });

  it("drives a full media-plane call against a stub adapter", async () => {
    // Stand in for the adapter's media WS handler: on `start`, send one media
    // frame + a mark, so the fake records inbound media and echoes the mark.
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) =>
      wss?.once("listening", () => resolve())
    );
    const streamUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const echoedMarks: string[] = [];
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "start") {
          socket.send(
            JSON.stringify({
              event: "media",
              media: { payload: Buffer.alloc(640).toString("base64") },
            })
          );
          socket.send(
            JSON.stringify({ event: "mark", mark: { name: "greeting" } })
          );
        }
        // Record the fake's mark echo (Telnyx → adapter).
        if (msg.event === "mark" && msg.stream_id) {
          echoedMarks.push(msg.mark.name);
        }
      });
    });

    api = await startFakeTelnyxApi();
    const apiBaseUrl = api.baseUrl;
    const clientState = Buffer.from(JSON.stringify({ v: 1 })).toString(
      "base64"
    );

    // Minimal fake adapter: ack the webhook, and (fire-and-forget) issue an
    // answer command with inline stream params — as the real adapter would.
    const webhook = (req: Request): Promise<Response> => {
      void (async () => {
        const parsed = JSON.parse(await req.text());
        const ccid = parsed.data.payload.call_control_id;
        await fetch(`${apiBaseUrl}/v2/calls/${ccid}/actions/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stream_url: streamUrl,
            stream_track: "both_tracks",
            client_state: clientState,
          }),
        });
      })();
      return Promise.resolve(new Response("", { status: 200 }));
    };

    const call = await startFakeTelnyxCall({ api, webhook });
    expect(call.connected).toBe(true);
    expect(call.webhookResponse.status).toBe(200);

    // The adapter's answer command threaded our client_state through.
    const answer = api
      .commandsFor(call.callControlId)
      .find((c) => c.command === "answer");
    expect(
      decodeTelnyxClientState(answer?.body.client_state as string)
    ).toEqual({ v: 1 });

    // Inbound media from the stub adapter was accounted (640 bytes / 32 = 20ms).
    await call.waitFor((r) => r.mediaMs >= 20 && r.marks.includes("greeting"));
    expect(call.received.payloads.length).toBeGreaterThan(0);

    // Speak paced outbound-from-caller audio, then confirm the mark echoed.
    await call.speak({ kind: "tone", ms: 40, hz: 440 });
    await new Promise((r) => setTimeout(r, 30));
    expect(echoedMarks).toContain("greeting");

    await call.hangup();
    await call.closed;
  });

  it("returns a control-plane-only stub when the adapter rejects", async () => {
    api = await startFakeTelnyxApi();
    const apiBaseUrl = api.baseUrl;
    const webhook = (req: Request): Promise<Response> => {
      void (async () => {
        const parsed = JSON.parse(await req.text());
        const ccid = parsed.data.payload.call_control_id;
        await fetch(`${apiBaseUrl}/v2/calls/${ccid}/actions/reject`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cause: "CALL_REJECTED" }),
        });
      })();
      return Promise.resolve(new Response("", { status: 200 }));
    };

    const call = await startFakeTelnyxCall({ api, webhook });
    expect(call.connected).toBe(false);
    expect(call.webhookResponse.status).toBe(200);
    // Media methods are safe no-ops.
    await call.speak({ kind: "tone", ms: 20 });
    await call.hangup();
    await call.closed;
    const reject = api
      .commandsFor(call.callControlId)
      .find((c) => c.command === "reject");
    expect(reject?.body.cause).toBe("CALL_REJECTED");
  });
});
