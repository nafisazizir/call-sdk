import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AudioFrame,
  type CallEventMap,
  EventBus,
  int16ToBytes,
} from "call-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { StageContext } from "../stage";
import { stageContract } from "../testing/stage-contract";
import { createElevenLabsStage, ElevenLabsStage } from "./elevenlabs";

const MISSING_CREDENTIALS_MESSAGE_RE = /api key|voice/i;
const STATUS_500_MESSAGE_RE = /500/;
const QUOTA_EXCEEDED_MESSAGE_RE = /quota exceeded/;

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
function makeTestStageContext(sessionId = "test:elevenlabs"): {
  bus: EventBus<CallEventMap>;
  controller: AbortController;
  ctx: StageContext;
  fails: RecordedFail[];
  marks: RecordedMark[];
} {
  const bus = new EventBus<CallEventMap>(sessionId);
  const marks: RecordedMark[] = [];
  const fails: RecordedFail[] = [];
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
      warn: () => undefined,
      error: () => undefined,
    },
  };
  return { bus, ctx, fails, marks, controller };
}

interface CapturedRequest {
  body: string;
  headers: IncomingMessage["headers"];
  method: string;
  url: string;
}

interface PendingRequest {
  captured: CapturedRequest;
  res: ServerResponse;
}

interface FakeElevenLabsServer {
  close(): Promise<void>;
  nextRequest(): Promise<PendingRequest>;
  requests: CapturedRequest[];
  url: string;
}

/** A fake ElevenLabs `/v1/text-to-speech/{voiceId}/stream` server with manual response control. */
function startFakeElevenLabsServer(): FakeElevenLabsServer {
  const requests: CapturedRequest[] = [];
  const pendingResolvers: ((value: PendingRequest) => void)[] = [];
  const queue: PendingRequest[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(captured);
      const item: PendingRequest = { captured, res };
      const resolver = pendingResolvers.shift();
      if (resolver) {
        resolver(item);
      } else {
        queue.push(item);
      }
    });
  });
  server.listen(0);

  return {
    requests,
    get url() {
      const address = server.address() as AddressInfo;
      return `http://127.0.0.1:${address.port}`;
    },
    nextRequest: () =>
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
        server.close(() => resolve());
      }),
  };
}

/** A fake server that answers every request immediately with the same fixed PCM payload. */
function startAutoRespondElevenLabsServer(pcmBytes: Uint8Array): {
  close(): Promise<void>;
  url: string;
} {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.from(pcmBytes));
  });
  server.listen(0);
  return {
    get url() {
      const address = server.address() as AddressInfo;
      return `http://127.0.0.1:${address.port}`;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Deterministic pseudo-ramp PCM16 samples, well within range, non-repeating over short windows. */
function rampSamples(count: number): Int16Array {
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = ((i * 37) % 2000) - 1000;
  }
  return samples;
}

/** Splits bytes into a repeating cycle of (deliberately odd) chunk sizes. */
function splitBytes(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = Math.min(sizes[i % sizes.length], bytes.length - offset);
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
    i++;
  }
  return chunks;
}

async function writeDribbled(
  res: ServerResponse,
  chunks: Uint8Array[],
  gapMs = 5
): Promise<void> {
  for (const chunk of chunks) {
    res.write(Buffer.from(chunk));
    await delay(gapMs);
  }
  res.end();
}

function concatFrameSamples(frames: AudioFrame[]): Int16Array {
  const total = frames.reduce((sum, f) => sum + f.samples.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame.samples, offset);
    offset += frame.samples.length;
  }
  return out;
}

let manualServer: FakeElevenLabsServer | undefined;
let autoServer: { close(): Promise<void>; url: string } | undefined;

afterEach(async () => {
  await manualServer?.close();
  manualServer = undefined;
  await autoServer?.close();
  autoServer = undefined;
});

// ---------------------------------------------------------------------------
// Basic factory / config surface
// ---------------------------------------------------------------------------

describe("createElevenLabsStage", () => {
  it("creates an ElevenLabsStage instance named 'elevenlabs'", () => {
    const stage = createElevenLabsStage();
    expect(stage).toBeInstanceOf(ElevenLabsStage);
    expect(stage.name).toBe("elevenlabs");
  });

  it("declares the TTS event surface", () => {
    const stage = createElevenLabsStage();
    expect(stage.consumes).toEqual(["agent-say"]);
    expect(stage.emits).toEqual(["audio-out", "agent-generation-end"]);
  });

  it("never throws in the constructor, even with no API key/voice configured", () => {
    expect(() => createElevenLabsStage()).not.toThrow();
    expect(() => createElevenLabsStage({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Missing credentials
// ---------------------------------------------------------------------------

describe("ElevenLabsStage — missing credentials", () => {
  it("fails informatively (not by throwing) on first use when no key/voice is configured", async () => {
    const originalKey = process.env.ELEVENLABS_API_KEY;
    const originalVoice = process.env.ELEVENLABS_VOICE_ID;
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    try {
      const { ctx, bus, fails } = makeTestStageContext();
      const stage = createElevenLabsStage({});
      const handle = await stage.attach(ctx);

      const controller = new AbortController();
      bus.publish("agent-say", {
        utteranceId: "u1",
        text: "hello",
        signal: controller.signal,
      });

      await waitUntil(() => fails.length > 0);
      expect(fails[0].fatal).toBe(true);
      expect(fails[0].error.message).toMatch(MISSING_CREDENTIALS_MESSAGE_RE);

      await handle.dispose();
    } finally {
      if (originalKey === undefined) {
        delete process.env.ELEVENLABS_API_KEY;
      } else {
        process.env.ELEVENLABS_API_KEY = originalKey;
      }
      if (originalVoice === undefined) {
        delete process.env.ELEVENLABS_VOICE_ID;
      } else {
        process.env.ELEVENLABS_VOICE_ID = originalVoice;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe("ElevenLabsStage — request shape", () => {
  it("POSTs the expected path, query params, headers, and body", async () => {
    manualServer = startFakeElevenLabsServer();
    const { ctx, bus } = makeTestStageContext();
    const stage = createElevenLabsStage({
      apiKey: "test-api-key",
      voiceId: "voice-123",
      baseUrl: manualServer.url,
    });
    const handle = await stage.attach(ctx);

    const controller = new AbortController();
    bus.publish("agent-say", {
      utteranceId: "u1",
      text: "hello there",
      signal: controller.signal,
    });

    const { captured, res } = await manualServer.nextRequest();
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end();

    expect(captured.method).toBe("POST");
    const url = new URL(captured.url, "http://localhost");
    expect(url.pathname).toBe("/v1/text-to-speech/voice-123/stream");
    expect(url.searchParams.get("output_format")).toBe("pcm_16000");
    expect(url.searchParams.get("optimize_streaming_latency")).toBe("3");
    expect(captured.headers["xi-api-key"]).toBe("test-api-key");
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(captured.body)).toEqual({
      text: "hello there",
      model_id: "eleven_turbo_v2_5",
    });

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// Frame reassembly
// ---------------------------------------------------------------------------

describe("ElevenLabsStage — audio reassembly", () => {
  it("re-chunks streamed PCM into canonical 320-sample frames, byte-exact across odd write boundaries", async () => {
    manualServer = startFakeElevenLabsServer();
    const { ctx, bus, marks } = makeTestStageContext();
    const stage = createElevenLabsStage({
      apiKey: "k",
      voiceId: "v",
      baseUrl: manualServer.url,
    });
    const handle = await stage.attach(ctx);

    const frames: AudioFrame[] = [];
    let generationEnded = false;
    bus.subscribe("audio-out", (p) => frames.push(p.frame));
    bus.subscribe("agent-generation-end", () => {
      generationEnded = true;
    });

    const totalSamples = 3000; // not a multiple of 320 — exercises flush() padding
    const samples = rampSamples(totalSamples);
    const bytes = int16ToBytes(samples);
    const chunks = splitBytes(bytes, [7, 13, 5, 11, 9]);

    const controller = new AbortController();
    bus.publish("agent-say", {
      utteranceId: "u1",
      text: "the ramp",
      signal: controller.signal,
    });

    const { res } = await manualServer.nextRequest();
    res.writeHead(200, { "content-type": "application/octet-stream" });
    await writeDribbled(res, chunks, 2);

    await waitUntil(() => generationEnded, 5000);

    expect(marks.some((m) => m.name === "tts-first-byte")).toBe(true);
    for (const frame of frames) {
      expect(frame.samples).toBeInstanceOf(Int16Array);
      expect(frame.samples.length).toBe(320);
    }

    const reassembled = concatFrameSamples(frames);
    expect(reassembled.length).toBe(3200); // ceil(3000/320) * 320
    expect(reassembled.subarray(0, totalSamples)).toEqual(samples);
    // The last frame is silence-padded past the real sample count.
    for (let i = totalSamples; i < reassembled.length; i++) {
      expect(reassembled[i]).toBe(0);
    }

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

describe("ElevenLabsStage — text normalization", () => {
  it("issues two sequential POSTs for an AsyncIterable<string>, second starting after the first response ends", async () => {
    manualServer = startFakeElevenLabsServer();
    const { ctx, bus } = makeTestStageContext();
    const stage = createElevenLabsStage({
      apiKey: "k",
      voiceId: "v",
      baseUrl: manualServer.url,
    });
    const handle = await stage.attach(ctx);

    async function* textChunks(): AsyncIterable<string> {
      yield "Hello.";
      yield "World.";
    }

    const controller = new AbortController();
    bus.publish("agent-say", {
      utteranceId: "u1",
      text: textChunks(),
      signal: controller.signal,
    });

    const first = await manualServer.nextRequest();
    expect(JSON.parse(first.captured.body).text).toBe("Hello.");
    first.res.writeHead(200, { "content-type": "application/octet-stream" });
    await delay(80);
    let firstResponseEndedAt = 0;
    first.res.end(() => {
      firstResponseEndedAt = Date.now();
    });
    // Ensure the "ended" callback above actually ran before we measure.
    await delay(20);
    firstResponseEndedAt ||= Date.now();

    const second = await manualServer.nextRequest();
    const secondRequestArrivedAt = Date.now();
    expect(JSON.parse(second.captured.body).text).toBe("World.");
    second.res.writeHead(200, { "content-type": "application/octet-stream" });
    second.res.end();

    expect(manualServer.requests).toHaveLength(2);
    expect(secondRequestArrivedAt).toBeGreaterThanOrEqual(
      firstResponseEndedAt - 5
    );

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// Abort semantics
// ---------------------------------------------------------------------------

describe("ElevenLabsStage — abort", () => {
  it("stops cleanly on mid-stream abort: no further audio-out, no generation-end, no fail", async () => {
    manualServer = startFakeElevenLabsServer();
    const { ctx, bus, fails } = makeTestStageContext();
    const stage = createElevenLabsStage({
      apiKey: "k",
      voiceId: "v",
      baseUrl: manualServer.url,
    });
    const handle = await stage.attach(ctx);

    const frames: AudioFrame[] = [];
    let generationEnded = false;
    bus.subscribe("audio-out", (p) => frames.push(p.frame));
    bus.subscribe("agent-generation-end", () => {
      generationEnded = true;
    });

    const controller = new AbortController();
    bus.publish("agent-say", {
      utteranceId: "u1",
      text: "a longer utterance",
      signal: controller.signal,
    });

    const { res } = await manualServer.nextRequest();
    res.writeHead(200, { "content-type": "application/octet-stream" });
    // Write at least one full frame's worth of bytes up front.
    res.write(Buffer.from(int16ToBytes(rampSamples(320))));

    await waitUntil(() => frames.length >= 1);
    const framesAtAbort = frames.length;
    controller.abort();

    // The server keeps "streaming" — the client must not process any of it.
    await delay(20);
    res.write(Buffer.from(int16ToBytes(rampSamples(320))));
    await delay(50);
    res.end();
    await delay(50);

    expect(frames.length).toBe(framesAtAbort);
    expect(generationEnded).toBe(false);
    expect(fails).toHaveLength(0);

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// HTTP failure
// ---------------------------------------------------------------------------

describe("ElevenLabsStage — HTTP failure", () => {
  it("fails fatally on a non-2xx response", async () => {
    manualServer = startFakeElevenLabsServer();
    const { ctx, bus, fails } = makeTestStageContext();
    const stage = createElevenLabsStage({
      apiKey: "k",
      voiceId: "v",
      baseUrl: manualServer.url,
    });
    const handle = await stage.attach(ctx);

    const controller = new AbortController();
    bus.publish("agent-say", {
      utteranceId: "u1",
      text: "hello",
      signal: controller.signal,
    });

    const { res } = await manualServer.nextRequest();
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error: quota exceeded");

    await waitUntil(() => fails.length > 0);
    expect(fails[0].fatal).toBe(true);
    expect(fails[0].error.message).toMatch(STATUS_500_MESSAGE_RE);
    expect(fails[0].error.message).toMatch(QUOTA_EXCEEDED_MESSAGE_RE);

    await handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// Shared stage conformance suite
// ---------------------------------------------------------------------------

describe("ElevenLabsStage conformance", () => {
  const pcm = int16ToBytes(rampSamples(320));

  stageContract(
    "elevenlabs",
    () => {
      autoServer = startAutoRespondElevenLabsServer(pcm);
      return createElevenLabsStage({
        apiKey: "k",
        voiceId: "v",
        baseUrl: autoServer.url,
      });
    },
    {
      timeoutMs: 500,
      arrange: (bus) => {
        const controller = new AbortController();
        bus.publish("agent-say", {
          utteranceId: `u-${Date.now()}`,
          text: "hi",
          signal: controller.signal,
        });
        return delay(150);
      },
      expectEmits: ["audio-out", "agent-generation-end"],
    }
  );
});
