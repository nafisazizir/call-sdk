import type { AddressInfo } from "node:net";
import type { StageContext, StageHandle } from "@call-adapter/pipeline";
import { stageContract } from "@call-adapter/tests";
import { type CallEventMap, EventBus } from "call-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createDeepgramStage, DeepgramStage } from "./index";

const API_KEY_MESSAGE_RE = /API key/i;
const CONNECTION_LOST_MESSAGE_RE = /connection lost/i;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await delay(5);
  }
}

interface RecordedMark {
  detail?: Record<string, unknown>;
  name: string;
}

interface RecordedFail {
  error: Error;
  fatal: boolean;
}

/** A bare `EventBus` + recorded `fail`/`mark` `StageContext`, for direct stage-level tests. */
function makeTestStageContext(sessionId = "test:deepgram"): {
  bus: EventBus<CallEventMap>;
  controller: AbortController;
  ctx: StageContext;
  fails: RecordedFail[];
  marks: RecordedMark[];
  warnLogs: string[];
} {
  const bus = new EventBus<CallEventMap>(sessionId);
  const marks: RecordedMark[] = [];
  const fails: RecordedFail[] = [];
  const warnLogs: string[] = [];
  const controller = new AbortController();
  const ctx: StageContext = {
    sessionId,
    bus,
    signal: controller.signal,
    mark: (name, detail) => marks.push({ name, detail }),
    fail: (error, opts) => fails.push({ error, fatal: opts?.fatal ?? true }),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => warnLogs.push(message),
      error: () => undefined,
    },
  };
  return { bus, ctx, fails, marks, warnLogs, controller };
}

interface FakeDeepgramConnection {
  close(code?: number): void;
  receivedBytes: Uint8Array[];
  receivedTexts: string[];
  send(message: unknown): void;
  sendText(text: string): void;
  terminate(): void;
}

interface FakeDeepgramServer {
  close(): Promise<void>;
  nextConnection(): Promise<FakeDeepgramConnection>;
  protocolsSeen: string[][];
  url: string;
}

/** A fake Deepgram Listen server backed by the (test-only) `ws` package. */
function startFakeDeepgramServer(
  opts: { verifyDelayMs?: number } = {}
): FakeDeepgramServer {
  const protocolsSeen: string[][] = [];
  const pendingResolvers: ((conn: FakeDeepgramConnection) => void)[] = [];
  const queue: FakeDeepgramConnection[] = [];

  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols: Set<string>) => {
      protocolsSeen.push(Array.from(protocols));
      return protocols.has("token") ? "token" : false;
    },
    ...(opts.verifyDelayMs
      ? {
          verifyClient: (
            _info: unknown,
            callback: (verified: boolean) => void
          ) => {
            setTimeout(() => callback(true), opts.verifyDelayMs);
          },
        }
      : {}),
  });

  wss.on("connection", (socket: WsSocket) => {
    const receivedBytes: Uint8Array[] = [];
    const receivedTexts: string[] = [];
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        receivedBytes.push(new Uint8Array(data));
      } else {
        receivedTexts.push(data.toString("utf8"));
      }
    });
    const conn: FakeDeepgramConnection = {
      receivedBytes,
      receivedTexts,
      send: (message) => socket.send(JSON.stringify(message)),
      sendText: (text) => socket.send(text),
      close: (code) => socket.close(code),
      terminate: () => socket.terminate(),
    };
    const resolver = pendingResolvers.shift();
    if (resolver) {
      resolver(conn);
    } else {
      queue.push(conn);
    }
  });

  return {
    protocolsSeen,
    get url() {
      const address = wss.address() as AddressInfo;
      return `ws://127.0.0.1:${address.port}`;
    },
    nextConnection: () =>
      new Promise((resolve) => {
        const existing = queue.shift();
        if (existing) {
          resolve(existing);
          return;
        }
        pendingResolvers.push(resolve);
      }),
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}

let server: FakeDeepgramServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

// ---------------------------------------------------------------------------
// Basic factory / config surface
// ---------------------------------------------------------------------------

describe("createDeepgramStage", () => {
  it("creates a DeepgramStage instance named 'deepgram'", () => {
    const stage = createDeepgramStage();
    expect(stage).toBeInstanceOf(DeepgramStage);
    expect(stage.name).toBe("deepgram");
  });

  it("declares the STT event surface", () => {
    const stage = createDeepgramStage();
    expect(stage.consumes).toEqual(["audio-frame"]);
    expect(stage.emits).toEqual([
      "transcript-interim",
      "transcript-final",
      "stt-endpoint",
    ]);
  });

  it("never throws in the constructor, even with no API key configured", () => {
    expect(() => createDeepgramStage()).not.toThrow();
    expect(() => createDeepgramStage({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// attach() without an API key
// ---------------------------------------------------------------------------

describe("DeepgramStage.attach — missing API key", () => {
  it("fails fatally at attach() rather than throwing, when no key is configured", () => {
    const original = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    try {
      const { ctx, fails } = makeTestStageContext();
      const stage = createDeepgramStage({});
      expect(() => stage.attach(ctx)).not.toThrow();
      expect(fails).toHaveLength(1);
      expect(fails[0].fatal).toBe(true);
      expect(fails[0].error.message).toMatch(API_KEY_MESSAGE_RE);
    } finally {
      if (original === undefined) {
        delete process.env.DEEPGRAM_API_KEY;
      } else {
        process.env.DEEPGRAM_API_KEY = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Connection / handshake
// ---------------------------------------------------------------------------

describe("DeepgramStage — connection handshake", () => {
  it("authenticates via the WebSocket subprotocol handshake", async () => {
    server = startFakeDeepgramServer();
    const { ctx, marks } = makeTestStageContext();
    const stage = createDeepgramStage({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const handle = await stage.attach(ctx);

    await server.nextConnection();
    await waitUntil(() => marks.some((m) => m.name === "stt-connected"));

    expect(server.protocolsSeen).toHaveLength(1);
    expect(server.protocolsSeen[0]).toEqual(["token", "test-key"]);
    expect(marks.some((m) => m.name === "stt-connect-start")).toBe(true);

    await handle.dispose();
  });

  it("streams inbound audio frames as raw PCM16 bytes matching sent byte counts", async () => {
    server = startFakeDeepgramServer();
    const { ctx, bus, marks } = makeTestStageContext();
    const stage = createDeepgramStage({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const handle = await stage.attach(ctx);
    const conn = await server.nextConnection();
    await waitUntil(() => marks.some((m) => m.name === "stt-connected"));

    const frameCount = 5;
    for (let i = 0; i < frameCount; i++) {
      bus.publish("audio-frame", {
        frame: { samples: new Int16Array(320), timestamp: i * 20 },
      });
    }

    await waitUntil(() => conn.receivedBytes.length === frameCount);
    for (const bytes of conn.receivedBytes) {
      expect(bytes.byteLength).toBe(640); // 320 samples * 2 bytes
    }

    await handle.dispose();
  });

  it("buffers audio frames sent before the connection opens, then flushes in order", async () => {
    server = startFakeDeepgramServer({ verifyDelayMs: 150 });
    const { ctx, bus, marks } = makeTestStageContext();
    const stage = createDeepgramStage({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const handle = await stage.attach(ctx);

    // Published immediately: the socket cannot possibly be open yet because
    // the fake server delays its handshake response.
    const frameCount = 10;
    for (let i = 0; i < frameCount; i++) {
      bus.publish("audio-frame", {
        frame: { samples: new Int16Array(320), timestamp: i * 20 },
      });
    }
    expect(marks.some((m) => m.name === "stt-connected")).toBe(false);

    const conn = await server.nextConnection();
    await waitUntil(() => conn.receivedBytes.length === frameCount, 2000);
    expect(marks.some((m) => m.name === "stt-connected")).toBe(true);
    for (const bytes of conn.receivedBytes) {
      expect(bytes.byteLength).toBe(640);
    }

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// Message → event mapping
// ---------------------------------------------------------------------------

describe("DeepgramStage — server message mapping", () => {
  async function attachConnected(): Promise<{
    bus: EventBus<CallEventMap>;
    conn: FakeDeepgramConnection;
    handle: StageHandle;
    marks: RecordedMark[];
  }> {
    server = startFakeDeepgramServer();
    const { ctx, bus, marks } = makeTestStageContext();
    const stage = createDeepgramStage({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const handle = await stage.attach(ctx);
    const conn = await server.nextConnection();
    await waitUntil(() => marks.some((m) => m.name === "stt-connected"));
    return { bus, conn, handle, marks };
  }

  it("maps an interim Results message to transcript-interim", async () => {
    const { bus, conn, handle } = await attachConnected();
    const interims: CallEventMap["transcript-interim"][] = [];
    bus.subscribe("transcript-interim", (p) => interims.push(p));

    conn.send({
      type: "Results",
      is_final: false,
      start: 0.2,
      duration: 0.1,
      channel: { alternatives: [{ transcript: "book me a" }] },
    });

    await waitUntil(() => interims.length === 1);
    expect(interims[0]).toEqual({ text: "book me a", timestamp: 200 });

    await handle.dispose();
  });

  it("maps a final Results message with exact startMs/endMs math", async () => {
    const { bus, conn, handle } = await attachConnected();
    const finals: CallEventMap["transcript-final"][] = [];
    bus.subscribe("transcript-final", (p) => finals.push(p));

    conn.send({
      type: "Results",
      is_final: true,
      speech_final: false,
      start: 1.5,
      duration: 0.9,
      channel: {
        alternatives: [{ transcript: "book a flight", confidence: 0.87 }],
      },
    });

    await waitUntil(() => finals.length === 1);
    expect(finals[0]).toEqual({
      text: "book a flight",
      startMs: 1500,
      endMs: 2400,
      confidence: 0.87,
    });

    await handle.dispose();
  });

  it("also publishes stt-endpoint when a final carries speech_final", async () => {
    const { bus, conn, handle } = await attachConnected();
    const endpoints: CallEventMap["stt-endpoint"][] = [];
    bus.subscribe("stt-endpoint", (p) => endpoints.push(p));

    conn.send({
      type: "Results",
      is_final: true,
      speech_final: true,
      start: 1.5,
      duration: 0.9,
      channel: { alternatives: [{ transcript: "book a flight" }] },
    });

    await waitUntil(() => endpoints.length === 1);
    expect(endpoints[0]).toEqual({ timestamp: 2400 });

    await handle.dispose();
  });

  it("maps UtteranceEnd to stt-endpoint using last_word_end", async () => {
    const { bus, conn, handle } = await attachConnected();
    const endpoints: CallEventMap["stt-endpoint"][] = [];
    bus.subscribe("stt-endpoint", (p) => endpoints.push(p));

    conn.send({ type: "UtteranceEnd", last_word_end: 3.25 });

    await waitUntil(() => endpoints.length === 1);
    expect(endpoints[0]).toEqual({ timestamp: 3250 });

    await handle.dispose();
  });

  it("ignores empty or whitespace-only transcripts", async () => {
    const { bus, conn, handle } = await attachConnected();
    const interims: unknown[] = [];
    const finals: unknown[] = [];
    bus.subscribe("transcript-interim", (p) => interims.push(p));
    bus.subscribe("transcript-final", (p) => finals.push(p));

    conn.send({
      type: "Results",
      is_final: false,
      start: 0,
      channel: { alternatives: [{ transcript: "" }] },
    });
    conn.send({
      type: "Results",
      is_final: true,
      start: 0,
      duration: 0,
      channel: { alternatives: [{ transcript: "   " }] },
    });
    // Give both messages time to arrive and be (not) processed.
    await delay(50);

    expect(interims).toHaveLength(0);
    expect(finals).toHaveLength(0);

    await handle.dispose();
  });

  it("ignores unknown message types without failing", async () => {
    const { conn, handle } = await attachConnected();

    conn.send({ type: "Metadata", request_id: "abc" });
    conn.send({ type: "SpeechStarted" });
    await delay(30);

    await handle.dispose();
  });

  it("reports malformed (non-JSON) messages via a non-fatal ctx.fail, once", async () => {
    server = startFakeDeepgramServer();
    const { ctx, fails, marks } = makeTestStageContext();
    const stage = createDeepgramStage({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const handle = await stage.attach(ctx);
    const conn = await server.nextConnection();
    await waitUntil(() => marks.some((m) => m.name === "stt-connected"));

    conn.sendText("not valid json {{{");
    conn.sendText("still not valid json {{{");
    await waitUntil(() => fails.length > 0);
    await delay(30);

    expect(fails).toHaveLength(1);
    expect(fails[0].fatal).toBe(false);

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// Failure / teardown
// ---------------------------------------------------------------------------

describe("DeepgramStage — failure and teardown", () => {
  it("fails fatally when the connection drops before dispose", async () => {
    server = startFakeDeepgramServer();
    const { ctx, fails, marks } = makeTestStageContext();
    const stage = createDeepgramStage({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const handle = await stage.attach(ctx);
    const conn = await server.nextConnection();
    await waitUntil(() => marks.some((m) => m.name === "stt-connected"));

    conn.terminate();

    await waitUntil(() => fails.length > 0);
    expect(fails[0].fatal).toBe(true);
    expect(fails[0].error.message).toMatch(CONNECTION_LOST_MESSAGE_RE);

    await handle.dispose();
  });

  it("dispose() sends CloseStream and resolves in well under a second, even if the server never closes", async () => {
    // A server that deliberately never closes its side of the connection.
    server = startFakeDeepgramServer();
    const { ctx, marks } = makeTestStageContext();
    const stage = createDeepgramStage({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const handle = await stage.attach(ctx);
    const conn = await server.nextConnection();
    await waitUntil(() => marks.some((m) => m.name === "stt-connected"));

    const start = Date.now();
    await handle.dispose();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1300);
    expect(
      conn.receivedTexts.some((text) => {
        try {
          return JSON.parse(text)?.type === "CloseStream";
        } catch {
          return false;
        }
      })
    ).toBe(true);
  });

  it("stops publishing after dispose, even if the server keeps sending messages", async () => {
    server = startFakeDeepgramServer();
    const { ctx, bus, marks } = makeTestStageContext();
    const stage = createDeepgramStage({
      apiKey: "test-key",
      baseUrl: server.url,
    });
    const handle = await stage.attach(ctx);
    const conn = await server.nextConnection();
    await waitUntil(() => marks.some((m) => m.name === "stt-connected"));

    const finals: unknown[] = [];
    bus.subscribe("transcript-final", (p) => finals.push(p));

    await handle.dispose();

    try {
      conn.send({
        type: "Results",
        is_final: true,
        speech_final: true,
        start: 0,
        duration: 1,
        channel: { alternatives: [{ transcript: "late arrival" }] },
      });
    } catch {
      // connection may already be torn down; that's fine
    }
    await delay(50);

    expect(finals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shared stage conformance suite
// ---------------------------------------------------------------------------

describe("DeepgramStage conformance", () => {
  let conformanceServer: FakeDeepgramServer | undefined;
  let capturedConn: FakeDeepgramConnection | undefined;

  afterEach(async () => {
    await conformanceServer?.close();
    conformanceServer = undefined;
    capturedConn = undefined;
  });

  const makeStage = () => {
    conformanceServer = startFakeDeepgramServer();
    return createDeepgramStage({
      apiKey: "test-key",
      baseUrl: conformanceServer.url,
    });
  };

  const arrange = async (bus: EventBus<CallEventMap>): Promise<void> => {
    if (!conformanceServer) {
      return;
    }
    if (!capturedConn) {
      capturedConn = await conformanceServer.nextConnection();
    }
    bus.publish("audio-frame", {
      frame: { samples: new Int16Array(320), timestamp: 0 },
    });
    try {
      capturedConn.send({
        type: "Results",
        is_final: false,
        start: 0,
        channel: { alternatives: [{ transcript: "hi" }] },
      });
      capturedConn.send({
        type: "Results",
        is_final: true,
        speech_final: true,
        start: 0,
        duration: 0.5,
        channel: { alternatives: [{ transcript: "hi there" }] },
      });
    } catch {
      // second arrange() call after dispose: connection already closed
    }
    await delay(100);
  };

  stageContract("deepgram", makeStage, {
    timeoutMs: 500,
    arrange,
    expectEmits: ["transcript-interim", "transcript-final", "stt-endpoint"],
  });
});
