import { sign as edSign, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AdapterContext,
  AdapterSessionHandle,
  AudioFrame,
  MediaSocketCloseEvent,
  MediaSocketMessageEvent,
  OutboundAudio,
  RoutingDecision,
  SessionInit,
} from "call-sdk";
import { AdapterError } from "call-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeClientState } from "./events";
import { createTelnyxAdapter, TelnyxAdapter } from "./index";

// ---------------------------------------------------------------------------
// A capture server standing in for Telnyx's REST API. Records every command
// POST; can be told to fail a specific command once so the adapter's
// fallback-hangup path is exercised.
// ---------------------------------------------------------------------------

interface CapturedCommand {
  body: Record<string, unknown>;
  ccid: string | undefined;
  command: string; // the last path segment, e.g. "reject", or "create" for POST /v2/calls
}

interface CaptureServer {
  baseUrl: string;
  close: () => Promise<void>;
  failCommand: (command: string | undefined) => void;
  requests: CapturedCommand[];
}

const ACTION_PATH_RE = /\/v2\/calls\/([^/]+)\/actions\/([^/?]+)/;

async function startCaptureServer(): Promise<CaptureServer> {
  const requests: CapturedCommand[] = [];
  let commandToFail: string | undefined;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.length > 0 ? JSON.parse(raw) : {};
      const url = req.url ?? "";
      // POST /v2/calls -> createCall; POST /v2/calls/{ccid}/actions/{command}
      const actionMatch = url.match(ACTION_PATH_RE);
      const command = actionMatch ? actionMatch[2] : "create";
      const ccid = actionMatch ? decodeURIComponent(actionMatch[1]) : undefined;
      requests.push({ command, ccid, body });

      if (command === commandToFail) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [{ detail: "command failed" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ data: { call_control_id: "v3:new-outbound-call" } })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    failCommand: (command) => {
      commandToFail = command;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeCtx(
  routeIncomingCall?: AdapterContext["routeIncomingCall"]
): AdapterContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createSession: vi.fn(),
    routeIncomingCall:
      routeIncomingCall ??
      vi.fn(() =>
        Promise.resolve<RoutingDecision>({
          kind: "call-sdk/routing-decision",
          actions: [{ type: "stream" }],
        })
      ),
  };
}

function webhookRequest(
  body: string,
  headers: Record<string, string> = {}
): Request {
  return new Request("https://voice.example.com/telnyx/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "voice.example.com",
      ...headers,
    },
    body,
  });
}

function webhookBody(
  eventType: string,
  payload: Record<string, unknown>
): string {
  return JSON.stringify({ data: { event_type: eventType, payload } });
}

const CCID = "v3:call-control-id";

describe("createTelnyxAdapter", () => {
  it("creates a TelnyxAdapter named 'telnyx'", () => {
    const adapter = createTelnyxAdapter();
    expect(adapter).toBeInstanceOf(TelnyxAdapter);
    expect(adapter.name).toBe("telnyx");
  });

  it("does not throw at construction with no config/env", () => {
    expect(() => createTelnyxAdapter()).not.toThrow();
    expect(() => createTelnyxAdapter({})).not.toThrow();
  });

  it("throws when webhook is called before bind()", async () => {
    const adapter = createTelnyxAdapter({ validateSignature: false });
    await expect(
      adapter.webhook(webhookRequest(webhookBody("call.initiated", {})))
    ).rejects.toBeInstanceOf(AdapterError);
  });
});

describe("TelnyxAdapter.webhook — signature", () => {
  function ed25519() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spki = publicKey.export({ format: "der", type: "spki" });
    return {
      publicKeyBase64: Buffer.from(spki.subarray(spki.length - 32)).toString(
        "base64"
      ),
      sign: (msg: string) =>
        edSign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64"),
    };
  }

  let capture: CaptureServer;
  beforeEach(async () => {
    capture = await startCaptureServer();
  });
  afterEach(async () => {
    await capture.close();
  });

  it("rejects an invalid signature with 403 and issues no command", async () => {
    const { publicKeyBase64 } = ed25519();
    const adapter = createTelnyxAdapter({
      apiKey: "key",
      apiBaseUrl: capture.baseUrl,
      publicKey: publicKeyBase64,
    });
    adapter.bind(makeCtx());

    const response = await adapter.webhook(
      webhookRequest(webhookBody("call.initiated", { call_control_id: CCID }), {
        "telnyx-signature-ed25519": "not-a-valid-signature",
        "telnyx-timestamp": Math.floor(Date.now() / 1000).toString(),
      })
    );
    expect(response.status).toBe(403);
    expect(capture.requests).toHaveLength(0);
  });

  it("accepts a validly signed webhook and issues the planned command", async () => {
    const { publicKeyBase64, sign } = ed25519();
    const adapter = createTelnyxAdapter({
      apiKey: "key",
      apiBaseUrl: capture.baseUrl,
      publicKey: publicKeyBase64,
    });
    adapter.bind(
      makeCtx(() =>
        Promise.resolve({
          kind: "call-sdk/routing-decision",
          actions: [{ type: "reject", reason: "busy" }],
        })
      )
    );

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = webhookBody("call.initiated", { call_control_id: CCID });
    const signature = sign(`${timestamp}|${body}`);
    const response = await adapter.webhook(
      webhookRequest(body, {
        "telnyx-signature-ed25519": signature,
        "telnyx-timestamp": timestamp,
      })
    );
    expect(response.status).toBe(200);
    expect(capture.requests[0]?.command).toBe("reject");
  });

  it("warns exactly once when signature validation is disabled", async () => {
    const ctx = makeCtx(() =>
      Promise.resolve({
        kind: "call-sdk/routing-decision",
        actions: [{ type: "hangup" }],
      })
    );
    const adapter = createTelnyxAdapter({
      apiKey: "key",
      apiBaseUrl: capture.baseUrl,
      validateSignature: false,
    });
    adapter.bind(ctx);

    await adapter.webhook(
      webhookRequest(webhookBody("call.initiated", { call_control_id: CCID }))
    );
    await adapter.webhook(
      webhookRequest(webhookBody("call.initiated", { call_control_id: CCID }))
    );

    const warnCalls = (
      ctx.logger.warn as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([msg]) =>
      String(msg).includes("signature validation is disabled")
    );
    expect(warnCalls).toHaveLength(1);
  });
});

describe("TelnyxAdapter.webhook — routing & sequencing", () => {
  let capture: CaptureServer;
  beforeEach(async () => {
    capture = await startCaptureServer();
  });
  afterEach(async () => {
    await capture.close();
  });

  function adapterFor(ctx: AdapterContext): TelnyxAdapter {
    const adapter = createTelnyxAdapter({
      apiKey: "key",
      apiBaseUrl: capture.baseUrl,
      validateSignature: false,
      mediaUrl: "wss://media.example.com/telnyx/media",
    });
    adapter.bind(ctx);
    return adapter;
  }

  it("routes a fresh call.initiated and POSTs the reject command before returning 200", async () => {
    const adapter = adapterFor(
      makeCtx(() =>
        Promise.resolve({
          kind: "call-sdk/routing-decision",
          actions: [{ type: "reject", reason: "rejected" }],
        })
      )
    );
    const response = await adapter.webhook(
      webhookRequest(webhookBody("call.initiated", { call_control_id: CCID }))
    );
    expect(response.status).toBe(200);
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].command).toBe("reject");
    expect(capture.requests[0].ccid).toBe(CCID);
    expect(capture.requests[0].body.cause).toBe("CALL_REJECTED");
  });

  it("answers a stream decision with inline bidirectional stream params", async () => {
    const adapter = adapterFor(makeCtx()); // default = stream
    await adapter.webhook(
      webhookRequest(webhookBody("call.initiated", { call_control_id: CCID }))
    );
    const answer = capture.requests[0];
    expect(answer.command).toBe("answer");
    expect(answer.body.stream_url).toBe("wss://media.example.com/telnyx/media");
    expect(answer.body.stream_track).toBe("inbound_track");
    expect(answer.body.stream_bidirectional_sampling_rate).toBe(16_000);
  });

  it("advances a continuation (our client_state) WITHOUT re-routing", async () => {
    const routeIncomingCall = vi.fn(() =>
      Promise.resolve<RoutingDecision>({
        kind: "call-sdk/routing-decision",
        actions: [{ type: "stream" }],
      })
    );
    const adapter = adapterFor(makeCtx(routeIncomingCall));

    const clientState = encodeClientState({
      v: 1,
      mode: "sequence",
      direction: "inbound",
      q: [{ type: "say", text: "hello" }, { type: "hangup" }],
      step: 1,
    });
    const response = await adapter.webhook(
      webhookRequest(
        webhookBody("call.answered", {
          call_control_id: CCID,
          client_state: clientState,
        })
      )
    );

    expect(response.status).toBe(200);
    expect(routeIncomingCall).not.toHaveBeenCalled();
    expect(capture.requests[0].command).toBe("speak");
    expect(capture.requests[0].body.payload).toBe("hello");
  });

  it("acks a malformed body with 200 and issues no command", async () => {
    const adapter = adapterFor(makeCtx());
    const response = await adapter.webhook(webhookRequest("}{not json"));
    expect(response.status).toBe(200);
    expect(capture.requests).toHaveLength(0);
  });

  it("acks a stateless non-initiated event with 200 and no command", async () => {
    const adapter = adapterFor(makeCtx());
    const response = await adapter.webhook(
      webhookRequest(webhookBody("call.hangup", { call_control_id: CCID }))
    );
    expect(response.status).toBe(200);
    expect(capture.requests).toHaveLength(0);
  });

  it("issues a fallback hangup and still returns 200 when a command fails", async () => {
    capture.failCommand("answer");
    const adapter = adapterFor(makeCtx()); // stream -> answer (which will fail)
    const response = await adapter.webhook(
      webhookRequest(webhookBody("call.initiated", { call_control_id: CCID }))
    );
    expect(response.status).toBe(200);
    expect(capture.requests.map((r) => r.command)).toEqual([
      "answer",
      "hangup",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Media plane
// ---------------------------------------------------------------------------

function makeFakeSocket() {
  const listeners: {
    close: ((e: MediaSocketCloseEvent) => void)[];
    error: ((e: unknown) => void)[];
    message: ((e: MediaSocketMessageEvent) => void)[];
  } = { message: [], close: [], error: [] };
  const sent: string[] = [];
  return {
    sent,
    addEventListener: vi.fn(
      (type: "message" | "close" | "error", listener: (e: never) => void) => {
        listeners[type].push(listener as never);
      }
    ),
    send: vi.fn((data: string | Uint8Array) => {
      sent.push(
        typeof data === "string" ? data : Buffer.from(data).toString("utf8")
      );
    }),
    close: vi.fn(),
    emitMessage(data: unknown) {
      for (const l of listeners.message) {
        l({ data });
      }
    },
    emitClose(e: MediaSocketCloseEvent = {}) {
      for (const l of listeners.close) {
        l(e);
      }
    },
    emitError(err: unknown) {
      for (const l of listeners.error) {
        l(err);
      }
    },
  };
}

function makeFakeCtx() {
  const sessions: {
    init: SessionInit;
    outbound: OutboundAudio;
    delivered: AudioFrame[];
    marks: string[];
    ended: string[];
    answeredCount: number;
  }[] = [];
  const createSession = vi.fn(
    (init: SessionInit, outbound: OutboundAudio): AdapterSessionHandle => {
      const record = {
        init,
        outbound,
        delivered: [] as AudioFrame[],
        marks: [] as string[],
        ended: [] as string[],
        answeredCount: 0,
      };
      sessions.push(record);
      return {
        sessionId: `telnyx:${init.callId}`,
        deliverAudio: (frame) => record.delivered.push(frame),
        answered: () => {
          record.answeredCount += 1;
        },
        end: (reason) => record.ended.push(reason),
        fail: () => {
          // unused by these tests
        },
        mark: (name) => record.marks.push(name),
      };
    }
  );
  const ctx: AdapterContext = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createSession,
    routeIncomingCall: vi.fn(),
  };
  return { ctx, sessions };
}

function l16StartMessage(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: "start",
    stream_id: "stream-1",
    start: {
      call_control_id: CCID,
      from: "+15551110000",
      to: "+15552220000",
      media_format: { encoding: "L16", sample_rate: 16_000, channels: 1 },
      ...overrides,
    },
  });
}

describe("TelnyxAdapter.media", () => {
  let adapter: TelnyxAdapter;
  let bundle: ReturnType<typeof makeFakeCtx>;

  beforeEach(() => {
    adapter = createTelnyxAdapter();
    bundle = makeFakeCtx();
    adapter.bind(bundle.ctx);
  });

  it("creates a session and answers on start (L16/16k)", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(l16StartMessage());

    expect(bundle.sessions).toHaveLength(1);
    const session = bundle.sessions[0];
    expect(session.init.callId).toBe(CCID);
    expect(session.init.direction).toBe("inbound");
    expect(session.init.from).toBe("+15551110000");
    expect(session.init.to).toBe("+15552220000");
    expect(session.answeredCount).toBe(1);
  });

  it("reads outbound direction from the start client_state", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(
      l16StartMessage({
        client_state: encodeClientState({
          v: 1,
          mode: "stream",
          direction: "outbound",
          q: [],
          step: 0,
        }),
      })
    );
    expect(bundle.sessions[0].init.direction).toBe("outbound");
  });

  it("delivers inbound L16/16k media as canonical 320-sample frames", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(l16StartMessage());

    // 320 canonical samples = 640 bytes of L16 @ 16kHz (one 20ms frame).
    const bytes = new Uint8Array(640);
    socket.emitMessage(
      JSON.stringify({
        event: "media",
        media: { payload: Buffer.from(bytes).toString("base64") },
      })
    );
    const session = bundle.sessions[0];
    expect(session.delivered).toHaveLength(1);
    expect(session.delivered[0].samples).toBeInstanceOf(Int16Array);
    expect(session.delivered[0].samples.length).toBe(320);
  });

  it("drops media frames arriving before start", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(
      JSON.stringify({ event: "media", media: { payload: "AAAA" } })
    );
    expect(bundle.sessions).toHaveLength(0);
  });

  it("forwards mark echoes to the session handle", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(l16StartMessage());
    socket.emitMessage(
      JSON.stringify({ event: "mark", mark: { name: "utt_1" } })
    );
    expect(bundle.sessions[0].marks).toEqual(["utt_1"]);
  });

  it("ends the call once on stop and does not double-end on a following close", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(l16StartMessage());
    socket.emitMessage(JSON.stringify({ event: "stop" }));
    socket.emitClose();
    expect(bundle.sessions[0].ended).toEqual(["hangup"]);
  });

  it("ends the call with 'media-closed' on a socket close without stop", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(l16StartMessage());
    socket.emitClose({ code: 1006 });
    expect(bundle.sessions[0].ended).toEqual(["media-closed"]);
  });

  it("de-normalizes outbound writes and sends mark/clear", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(l16StartMessage());
    const session = bundle.sessions[0];

    session.outbound.write({ samples: new Int16Array(320), timestamp: 0 });
    session.outbound.mark?.("utt_1");
    session.outbound.clear();

    expect(JSON.parse(socket.sent[0]).event).toBe("media");
    // L16/16k passes through: 320 samples -> 640 bytes.
    expect(
      Buffer.from(JSON.parse(socket.sent[0]).media.payload, "base64").length
    ).toBe(640);
    expect(JSON.parse(socket.sent[1])).toEqual({
      event: "mark",
      mark: { name: "utt_1" },
    });
    expect(JSON.parse(socket.sent[2])).toEqual({ event: "clear" });
  });

  it("closes the socket on an unsupported media format", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(
      l16StartMessage({
        media_format: { encoding: "OPUS", sample_rate: 48_000, channels: 2 },
      })
    );
    expect(socket.close).toHaveBeenCalled();
    expect(bundle.sessions).toHaveLength(0);
  });

  it("normalizes PCMU/8k inbound to 320-sample frames", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(
      l16StartMessage({
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      })
    );
    // 160 μ-law bytes @ 8kHz -> upsampled to 320 samples @ 16kHz.
    const mulaw = new Uint8Array(160).fill(0xff);
    socket.emitMessage(
      JSON.stringify({
        event: "media",
        media: { payload: Buffer.from(mulaw).toString("base64") },
      })
    );
    expect(bundle.sessions[0].delivered[0].samples.length).toBe(320);
  });
});

// ---------------------------------------------------------------------------
// dial
// ---------------------------------------------------------------------------

describe("TelnyxAdapter.dial", () => {
  let capture: CaptureServer;
  beforeEach(async () => {
    capture = await startCaptureServer();
  });
  afterEach(async () => {
    await capture.close();
  });

  it("creates a call with stream params, outbound client_state, and custom headers", async () => {
    const adapter = createTelnyxAdapter({
      apiKey: "key",
      apiBaseUrl: capture.baseUrl,
      connectionId: "conn-1",
      mediaUrl: "wss://media.example.com/telnyx/media",
    });
    adapter.bind(makeCtx());

    const result = await adapter.dial({
      to: "+15559990000",
      from: "+15551110000",
      metadata: { Ticket: "42" },
    });
    expect(result).toEqual({ callId: "v3:new-outbound-call" });

    const req = capture.requests[0];
    expect(req.command).toBe("create");
    expect(req.body.to).toBe("+15559990000");
    expect(req.body.from).toBe("+15551110000");
    expect(req.body.connection_id).toBe("conn-1");
    expect(req.body.stream_url).toBe("wss://media.example.com/telnyx/media");
    expect(req.body.stream_bidirectional_codec).toBe("L16");
    expect(req.body.custom_headers).toEqual([
      { name: "X-Call-Sdk-Ticket", value: "42" },
    ]);
    expect(
      encodeClientState({
        v: 1,
        mode: "stream",
        direction: "outbound",
        q: [],
        step: 0,
      })
    ).toBe(req.body.client_state);
  });

  it("throws AdapterError when no 'from' is resolvable", async () => {
    const adapter = createTelnyxAdapter({
      apiKey: "key",
      connectionId: "conn-1",
      mediaUrl: "wss://x",
    });
    adapter.bind(makeCtx());
    await expect(adapter.dial({ to: "+1" })).rejects.toBeInstanceOf(
      AdapterError
    );
  });

  it("throws AdapterError when no connectionId is resolvable", async () => {
    const adapter = createTelnyxAdapter({
      apiKey: "key",
      phoneNumber: "+15551110000",
      mediaUrl: "wss://x",
    });
    adapter.bind(makeCtx());
    await expect(adapter.dial({ to: "+1" })).rejects.toBeInstanceOf(
      AdapterError
    );
  });

  it("throws AdapterError when mediaUrl is unset", async () => {
    const adapter = createTelnyxAdapter({
      apiKey: "key",
      phoneNumber: "+15551110000",
      connectionId: "conn-1",
    });
    adapter.bind(makeCtx());
    await expect(adapter.dial({ to: "+1" })).rejects.toBeInstanceOf(
      AdapterError
    );
  });
});
