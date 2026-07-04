import type {
  AdapterContext,
  AdapterSessionHandle,
  AudioFrame,
  MediaSocketCloseEvent,
  MediaSocketMessageEvent,
  OutboundAudio,
  SessionInit,
} from "call-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTwilioAdapter, type TwilioAdapter } from "./index";

/** A minimal fake `MediaSocket` — records sent frames, lets the test fire events. */
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
    failed: Error[];
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
        failed: [] as Error[],
      };
      sessions.push(record);
      return {
        sessionId: `twilio:${init.callId}`,
        deliverAudio: (frame) => record.delivered.push(frame),
        answered: () => {
          record.answeredCount += 1;
        },
        end: (reason) => record.ended.push(reason),
        fail: (error) => record.failed.push(error),
        mark: (name) => record.marks.push(name),
      };
    }
  );

  const ctx: AdapterContext = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    createSession,
  };
  return { ctx, sessions };
}

const START_MESSAGE = {
  event: "start",
  sequenceNumber: "1",
  streamSid: "MZ123",
  start: {
    streamSid: "MZ123",
    accountSid: "AC123",
    callSid: "CA123",
    tracks: ["inbound"],
    customParameters: {
      from: "+15551234567",
      to: "+15557654321",
      direction: "inbound",
    },
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
  },
};

describe("TwilioAdapter.media", () => {
  let adapter: TwilioAdapter;
  let ctxBundle: ReturnType<typeof makeFakeCtx>;

  beforeEach(() => {
    adapter = createTwilioAdapter();
    ctxBundle = makeFakeCtx();
    adapter.bind(ctxBundle.ctx);
  });

  it("ignores media/mark before start, then creates a session and answers on start", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);

    socket.emitMessage(
      JSON.stringify({
        event: "media",
        sequenceNumber: "0",
        streamSid: "MZ123",
        media: {
          track: "inbound",
          chunk: "0",
          timestamp: "0",
          payload: "//79",
        },
      })
    );
    socket.emitMessage(
      JSON.stringify({ event: "mark", streamSid: "MZ123", mark: { name: "x" } })
    );
    expect(ctxBundle.sessions).toHaveLength(0);

    socket.emitMessage(JSON.stringify(START_MESSAGE));

    expect(ctxBundle.sessions).toHaveLength(1);
    const session = ctxBundle.sessions[0];
    expect(session.init.callId).toBe("CA123");
    expect(session.init.direction).toBe("inbound");
    expect(session.init.from).toBe("+15551234567");
    expect(session.init.to).toBe("+15557654321");
    expect(session.answeredCount).toBe(1);
  });

  it("decodes inbound media into canonical 16kHz frames and delivers them", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];

    // One 20ms mu-law frame @ 8kHz = 160 bytes -> upsampled to 320 samples @ 16kHz.
    const mulawBytes = new Uint8Array(160).fill(0xff);
    socket.emitMessage(
      JSON.stringify({
        event: "media",
        sequenceNumber: "2",
        streamSid: "MZ123",
        media: {
          track: "inbound",
          chunk: "1",
          timestamp: "20",
          payload: Buffer.from(mulawBytes).toString("base64"),
        },
      })
    );

    expect(session.delivered).toHaveLength(1);
    expect(session.delivered[0].samples).toBeInstanceOf(Int16Array);
    expect(session.delivered[0].samples.length).toBe(320);
  });

  it("forwards mark echoes to the session handle", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];

    socket.emitMessage(
      JSON.stringify({
        event: "mark",
        streamSid: "MZ123",
        mark: { name: "utt_1" },
      })
    );
    expect(session.marks).toEqual(["utt_1"]);
  });

  it("ends the call with 'hangup' on stop", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];

    socket.emitMessage(
      JSON.stringify({
        event: "stop",
        streamSid: "MZ123",
        stop: { accountSid: "AC123", callSid: "CA123" },
      })
    );
    expect(session.ended).toEqual(["hangup"]);
  });

  it("ends the call with 'media-closed' when the socket closes without a stop", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];

    socket.emitClose({ code: 1006 });
    expect(session.ended).toEqual(["media-closed"]);
  });

  it("does not double-end when stop is followed by socket close", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];

    socket.emitMessage(
      JSON.stringify({
        event: "stop",
        streamSid: "MZ123",
        stop: { accountSid: "AC123", callSid: "CA123" },
      })
    );
    socket.emitClose();
    expect(session.ended).toEqual(["hangup"]);
  });

  it("treats a socket error as a dropped media socket (end, not fail)", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];

    socket.emitError(new Error("ECONNRESET"));
    expect(session.ended).toEqual(["media-closed"]);
    expect(session.failed).toEqual([]);
  });

  it("ignores malformed and unrecognized messages without throwing", () => {
    const socket = makeFakeSocket();
    expect(() => {
      adapter.media(socket);
      socket.emitMessage("not json");
      socket.emitMessage(JSON.stringify({ event: "dtmf", digit: "5" }));
      socket.emitMessage(JSON.stringify({ event: "media" })); // malformed: no media payload
    }).not.toThrow();
    expect(ctxBundle.sessions).toHaveLength(0);
  });

  it("de-normalizes outbound writes to base64 mu-law media frames", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];

    const samples = new Int16Array(320); // 20ms @ 16kHz canonical frame
    session.outbound.write({ samples, timestamp: 0 });

    expect(socket.sent).toHaveLength(1);
    const sent = JSON.parse(socket.sent[0]) as {
      event: string;
      streamSid: string;
      media: { payload: string };
    };
    expect(sent.event).toBe("media");
    expect(sent.streamSid).toBe("MZ123");
    const decodedLength = Buffer.from(sent.media.payload, "base64").length;
    expect(decodedLength).toBe(160); // downsampled to 8kHz, 1 byte/sample mu-law
  });

  it("sends mark and clear messages", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];

    session.outbound.mark?.("utt_1");
    session.outbound.clear();

    expect(JSON.parse(socket.sent[0])).toEqual({
      event: "mark",
      streamSid: "MZ123",
      mark: { name: "utt_1" },
    });
    expect(JSON.parse(socket.sent[1])).toEqual({
      event: "clear",
      streamSid: "MZ123",
    });
  });

  it("silently drops outbound writes after the socket has closed", () => {
    const socket = makeFakeSocket();
    adapter.media(socket);
    socket.emitMessage(JSON.stringify(START_MESSAGE));
    const session = ctxBundle.sessions[0];
    socket.emitClose();
    socket.sent.length = 0;

    expect(() => {
      session.outbound.write({ samples: new Int16Array(320), timestamp: 0 });
      session.outbound.mark?.("x");
      session.outbound.clear();
    }).not.toThrow();
    expect(socket.sent).toHaveLength(0);
  });
});
