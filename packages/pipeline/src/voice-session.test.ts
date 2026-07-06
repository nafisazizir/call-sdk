import {
  type AudioFrame,
  type CallEventMap,
  CallSession,
  createLogger,
  type OutboundAudio,
} from "call-sdk";
import { describe, expect, it, vi } from "vitest";
import type { Stage, StageContext, StageHandle } from "./stage";
import { attachVoice } from "./voice-session";

function frame(fill = 0): AudioFrame {
  return { samples: new Int16Array(320).fill(fill), timestamp: fill * 20 };
}

function makeSession() {
  const written: AudioFrame[] = [];
  let clears = 0;
  const outbound: OutboundAudio = {
    write: (f) => void written.push(f),
    clear: () => {
      clears += 1;
    },
  };
  const session = new CallSession({
    adapterName: "mock",
    init: { callId: "c1", direction: "inbound" },
    lifecycle: { answered: [], ended: [], error: [], started: [] },
    logger: createLogger("silent"),
    outbound,
  });
  return {
    session,
    written,
    get clears() {
      return clears;
    },
  };
}

interface FakeStageOptions {
  attachDelayMs?: number;
  onAttach?: (ctx: StageContext) => void;
}

function fakeStage(
  name: string,
  consumes: (keyof CallEventMap)[],
  emits: (keyof CallEventMap)[],
  opts: FakeStageOptions = {}
): Stage & { attached: number; disposed: number; disposeOrder: string[] } {
  const record = {
    attached: 0,
    disposed: 0,
    disposeOrder: [] as string[],
  };
  return Object.assign(record, {
    name,
    consumes,
    emits,
    attach: async (ctx: StageContext): Promise<StageHandle> => {
      if (opts.attachDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.attachDelayMs));
      }
      record.attached += 1;
      opts.onAttach?.(ctx);
      return {
        dispose: () => {
          record.disposed += 1;
          record.disposeOrder.push(name);
        },
      };
    },
  });
}

/** A trivial echoing TTS: agent-say → one audio-out frame + generation-end. */
function fakeTts(): Stage {
  return {
    name: "fake-tts",
    consumes: ["agent-say"],
    emits: ["audio-out", "agent-generation-end"],
    attach: (ctx: StageContext): StageHandle => {
      const unsubscribe = ctx.bus.subscribe("agent-say", (payload) => {
        ctx.bus.publish("audio-out", {
          frame: frame(9),
          utteranceId: payload.utteranceId,
        });
        ctx.bus.publish("agent-generation-end", {
          utteranceId: payload.utteranceId,
        });
      });
      return { dispose: () => unsubscribe() };
    },
  };
}

const MISSING_PRODUCER_RE = /nothing in the configured pipeline emits/;

async function settled(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("attachVoice basics", () => {
  it("attaches stages, replays buffered audio, and runs queued say()", async () => {
    const { session, written } = makeSession();
    const seenFrames: AudioFrame[] = [];
    const vad = fakeStage(
      "slow-vad",
      ["audio-frame"],
      ["speech-start", "speech-end"],
      {
        attachDelayMs: 20,
        onAttach: (ctx) => {
          ctx.bus.subscribe("audio-frame", ({ frame: f }) =>
            seenFrames.push(f)
          );
        },
      }
    );
    const voice = attachVoice(session, {
      logger: "silent",
      stages: [vad, fakeTts()],
    });

    // Audio arrives while the graph is still attaching — must be buffered.
    session.handle.deliverAudio(frame(1));
    session.handle.deliverAudio(frame(2));
    // say() before attach completes — must queue, not vanish.
    const sayPromise = voice.say("hello caller");

    await vi.waitFor(() => {
      expect(vad.attached).toBe(1);
    });
    await settled(30);

    expect(seenFrames.map((f) => f.samples[0])).toContain(1);
    expect(seenFrames.map((f) => f.samples[0])).toContain(2);
    // The fake TTS answered the queued say; playback wrote to the adapter.
    const result = await sayPromise;
    expect(result.interrupted).toBe(false);
    expect(written.length).toBeGreaterThan(0);
    expect(voice.transcript.at(-1)).toMatchObject({
      role: "agent",
      text: "hello caller",
    });
    await session.end();
  });

  it("throws synchronously on a miswired stage graph", () => {
    const { session } = makeSession();
    const orphan = fakeStage("orphan", ["transcript-final"], []);
    expect(() =>
      attachVoice(session, { logger: "silent", stages: [orphan] })
    ).toThrow(MISSING_PRODUCER_RE);
  });
});

describe("teardown and detach", () => {
  it("disposes stages before the terminal call-ended and forwards it to the voice bus", async () => {
    const { session } = makeSession();
    const order: string[] = [];
    const stage = fakeStage(
      "s1",
      ["audio-frame"],
      ["speech-start", "speech-end"]
    );
    const voice = attachVoice(session, { logger: "silent", stages: [stage] });
    voice.on("call-ended", () => order.push("call-ended"));
    const origDispose = stage.disposeOrder;
    await vi.waitFor(() => {
      expect(stage.attached).toBe(1);
    });

    await session.end("hangup");
    order.unshift(...origDispose.map(() => "dispose"));
    expect(order).toEqual(["dispose", "call-ended"]);
    expect(voice.bus.closed).toBe(true);
  });

  it("disposes in reverse attach order", async () => {
    const { session } = makeSession();
    const orderLog: string[] = [];
    const a = fakeStage("a", ["audio-frame"], ["speech-start", "speech-end"]);
    const b = fakeStage(
      "b",
      ["speech-start"],
      ["transcript-final", "transcript-interim", "stt-endpoint"]
    );
    // Share one order log.
    a.disposeOrder = orderLog;
    b.disposeOrder = orderLog;
    attachVoice(session, { logger: "silent", stages: [a, b] });
    await vi.waitFor(() => {
      expect(b.attached).toBe(1);
    });
    await session.end();
    expect(orderLog).toEqual(["b", "a"]);
  });

  it("detach() is idempotent and does not end the call", async () => {
    const { session } = makeSession();
    const stage = fakeStage(
      "s1",
      ["audio-frame"],
      ["speech-start", "speech-end"]
    );
    const voice = attachVoice(session, { logger: "silent", stages: [stage] });
    await vi.waitFor(() => {
      expect(stage.attached).toBe(1);
    });
    await voice.detach();
    await voice.detach();
    expect(stage.disposed).toBe(1);
    expect(voice.bus.closed).toBe(true);
    // The call itself is still alive.
    let ended = false;
    session.ended.then(() => {
      ended = true;
    });
    await settled();
    expect(ended).toBe(false);
    await session.end();
  });

  it("stops attaching and disposes nothing extra when torn down mid-attach", async () => {
    const { session } = makeSession();
    const first = fakeStage(
      "first",
      ["audio-frame"],
      ["speech-start", "speech-end"],
      {
        attachDelayMs: 30,
      }
    );
    const second = fakeStage("second", ["speech-start"], []);
    const voice = attachVoice(session, {
      logger: "silent",
      stages: [first, second],
    });
    const sayPromise = voice.say("never spoken");
    await session.end("hangup");
    const result = await sayPromise;
    expect(result.interrupted).toBe(true);
    await settled(50);
    expect(second.attached).toBe(0);
  });
});

describe("barge-in policy", () => {
  it("interrupts immediately when minSpeechMs is 0", async () => {
    const ctx = makeSession();
    const voice = attachVoice(ctx.session, {
      logger: "silent",
      stages: [
        // A VAD placeholder so validation passes; events published manually.
        fakeStage("vad", ["audio-frame"], ["speech-start", "speech-end"]),
        fakeTtsHold(),
      ],
    });
    await settled(10);
    const sayPromise = voice.say("long agent monologue");
    await settled(10);
    expect(voice.state).toBe("agent-speaking");

    voice.bus.publish("speech-start", { timestamp: 123 });
    const result = await sayPromise;
    expect(result.interrupted).toBe(true);
    expect(ctx.clears).toBe(1);
    expect(voice.state).toBe("user-speaking");
    await ctx.session.end();
  });

  it("debounces barge-in with minSpeechMs and cancels on speech-end", async () => {
    const ctx = makeSession();
    const voice = attachVoice(ctx.session, {
      logger: "silent",
      interruption: { minSpeechMs: 40 },
      stages: [
        fakeStage("vad", ["audio-frame"], ["speech-start", "speech-end"]),
        fakeTtsHold(),
      ],
    });
    await settled(10);
    void voice.say("agent talking");
    await settled(10);
    expect(voice.state).toBe("agent-speaking");

    // A blip shorter than the debounce must NOT interrupt.
    voice.bus.publish("speech-start", { timestamp: 0 });
    await settled(15);
    voice.bus.publish("speech-end", { timestamp: 15, durationMs: 15 });
    await settled(50);
    expect(voice.state).toBe("agent-speaking");
    expect(ctx.clears).toBe(0);

    // Sustained speech past the debounce interrupts.
    voice.bus.publish("speech-start", { timestamp: 100 });
    await settled(50);
    expect(ctx.clears).toBe(1);
    await ctx.session.end();
  });
});

/** A TTS that emits one frame but never generation-end — playback "hangs" until interrupted. */
function fakeTtsHold(): Stage {
  return {
    name: "fake-tts-hold",
    consumes: ["agent-say"],
    emits: ["audio-out", "agent-generation-end"],
    attach: (ctx: StageContext): StageHandle => {
      const unsubscribe = ctx.bus.subscribe("agent-say", (payload) => {
        ctx.bus.publish("audio-out", {
          frame: frame(5),
          utteranceId: payload.utteranceId,
        });
      });
      return { dispose: () => unsubscribe() };
    },
  };
}
