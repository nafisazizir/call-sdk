import { describe, expect, it, vi } from "vitest";
import type { AudioFrame } from "./audio/format";
import { EventBus } from "./bus";
import type { CallEventMap } from "./events";
import { createLogger } from "./logger";
import { createSessionAudio } from "./session-audio";
import type { OutboundAudio } from "./types";

function frame(fill = 0): AudioFrame {
  return {
    samples: new Int16Array(320).fill(fill),
    timestamp: fill * 20,
  };
}

function build(opts: { withMark?: boolean; writable?: () => boolean } = {}) {
  const bus = new EventBus<CallEventMap>("test:audio");
  const written: AudioFrame[] = [];
  const marks: string[] = [];
  let clears = 0;
  const outbound: OutboundAudio = {
    write: (f) => void written.push(f),
    clear: () => {
      clears += 1;
    },
    ...(opts.withMark ? { mark: (name: string) => void marks.push(name) } : {}),
  };
  const audio = createSessionAudio({
    bus,
    isWritable: opts.writable ?? (() => true),
    logger: createLogger("silent"),
    outbound,
  });
  return {
    audio,
    bus,
    written,
    marks,
    get clears() {
      return clears;
    },
  };
}

describe("SessionAudio outbound", () => {
  it("forwards writes while writable and drops them after call end", () => {
    let writable = true;
    const { audio, written } = build({ writable: () => writable });
    audio.write(frame(1));
    writable = false;
    audio.write(frame(2));
    expect(written).toHaveLength(1);
    expect(written[0]?.samples[0]).toBe(1);
  });

  it("always forwards clear — the adapter's clear is post-end safe", () => {
    const ctx = build({ writable: () => false });
    ctx.audio.clear();
    expect(ctx.clears).toBe(1);
  });

  it("exposes canMark and forwards mark only when the adapter supports it", () => {
    const withMark = build({ withMark: true });
    expect(withMark.audio.canMark).toBe(true);
    withMark.audio.mark("utt_1");
    expect(withMark.marks).toEqual(["utt_1"]);

    const withoutMark = build();
    expect(withoutMark.audio.canMark).toBe(false);
    expect(() => withoutMark.audio.mark("utt_1")).not.toThrow();
  });
});

describe("SessionAudio.frames()", () => {
  it("yields published inbound frames in order and completes at call end", async () => {
    const { audio, bus } = build();
    const seen: number[] = [];
    const done = (async () => {
      for await (const f of audio.frames()) {
        seen.push(f.samples[0] ?? -1);
      }
    })();
    bus.publish("audio-frame", { frame: frame(1) });
    bus.publish("audio-frame", { frame: frame(2) });
    bus.publish("call-ended", {
      sessionId: "test:audio",
      reason: "hangup",
    });
    await done;
    expect(seen).toEqual([1, 2]);
  });

  it("subscribes at iteration start, not at frames() call time", async () => {
    const { audio, bus } = build();
    const iterable = audio.frames();
    // Published before iteration begins — not replayed to the iterator.
    bus.publish("audio-frame", { frame: frame(7) });
    bus.publish("call-ended", { sessionId: "test:audio", reason: "hangup" });
    bus.close();
    const seen: number[] = [];
    for await (const f of iterable) {
      seen.push(f.samples[0] ?? -1);
    }
    expect(seen).toEqual([]);
  });

  it("gives each call an independent iterator", async () => {
    const { audio, bus } = build();
    const a = audio.frames()[Symbol.asyncIterator]();
    const b = audio.frames()[Symbol.asyncIterator]();
    bus.publish("audio-frame", { frame: frame(3) });
    const [ra, rb] = await Promise.all([a.next(), b.next()]);
    expect(ra.done).toBe(false);
    expect(rb.done).toBe(false);
    expect((ra as IteratorYieldResult<AudioFrame>).value.samples[0]).toBe(3);
    expect((rb as IteratorYieldResult<AudioFrame>).value.samples[0]).toBe(3);
  });

  it("completes immediately when the bus is already closed", async () => {
    const { audio, bus } = build();
    bus.close();
    const seen: AudioFrame[] = [];
    for await (const f of audio.frames()) {
      seen.push(f);
    }
    expect(seen).toHaveLength(0);
  });

  it("stops receiving frames after an early break (return())", async () => {
    const { audio, bus } = build();
    const iterator = audio.frames()[Symbol.asyncIterator]();
    bus.publish("audio-frame", { frame: frame(1) });
    await iterator.next();
    await iterator.return?.();
    // Publishing after return must not throw or grow internal state.
    bus.publish("audio-frame", { frame: frame(2) });
    const after = await iterator.next();
    expect(after.done).toBe(true);
  });

  it("drops the oldest frames when a consumer falls behind", async () => {
    const { audio, bus } = build();
    const iterator = audio.frames()[Symbol.asyncIterator]();
    // Force the subscription to exist before flooding.
    const first = iterator.next();
    bus.publish("audio-frame", { frame: frame(0) });
    await first;
    for (let i = 1; i <= 1100; i += 1) {
      bus.publish("audio-frame", { frame: frame(i) });
    }
    const next = await iterator.next();
    // 1100 published, capacity 1000: frames 1..100 were dropped.
    expect((next as IteratorYieldResult<AudioFrame>).value.samples[0]).toBe(
      101
    );
    await iterator.return?.();
  });
});

describe("audio-mark round trip", () => {
  it("is observable on the bus like any transport event", () => {
    const { bus } = build();
    const handler = vi.fn();
    bus.subscribe("audio-mark", handler);
    bus.publish("audio-mark", { name: "utt_9" });
    expect(handler).toHaveBeenCalledWith(
      { name: "utt_9" },
      expect.objectContaining({ sessionId: "test:audio" })
    );
  });
});
