import { describe, expect, it } from "vitest";
import type { AudioFrame } from "./audio/format";
import type { CallEventMap } from "./events";
import { createLogger } from "./logger";
import { CallSession, type SessionLifecycleHandlers } from "./session";
import type { OutboundAudio, SessionInit } from "./types";

const DEFAULT_INIT: SessionInit = { callId: "CA1", direction: "inbound" };

function emptyLifecycle(): SessionLifecycleHandlers {
  return { answered: [], ended: [], error: [], started: [] };
}

function frameAt(timestamp: number): AudioFrame {
  return { samples: new Int16Array(320), timestamp };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  clears: { count: number };
  /** How many times the owning `Call` was told to drop this session. */
  closed: { count: number };
  lifecycle: SessionLifecycleHandlers;
  marks: string[];
  session: CallSession;
  writes: AudioFrame[];
}

function makeSession(
  opts: {
    init?: SessionInit;
    lifecycle?: SessionLifecycleHandlers;
    withMark?: boolean;
  } = {}
): Harness {
  const writes: AudioFrame[] = [];
  const marks: string[] = [];
  const clears = { count: 0 };
  const outbound: OutboundAudio = {
    write: (frame) => {
      writes.push(frame);
    },
    clear: () => {
      clears.count += 1;
    },
    ...(opts.withMark === false
      ? {}
      : {
          mark: (name: string) => {
            marks.push(name);
          },
        }),
  };
  const lifecycle = opts.lifecycle ?? emptyLifecycle();
  const closed = { count: 0 };
  const session = new CallSession({
    adapterName: "mock",
    init: opts.init ?? DEFAULT_INIT,
    lifecycle,
    logger: createLogger("silent"),
    onClosed: () => {
      closed.count += 1;
    },
    outbound,
  });
  return { clears, closed, lifecycle, marks, session, writes };
}

/** Collects every `call-ended` payload the session publishes. */
function recordEndings(session: CallSession): CallEventMap["call-ended"][] {
  const ended: CallEventMap["call-ended"][] = [];
  session.on("call-ended", (payload) => {
    ended.push(payload);
  });
  return ended;
}

describe("startup & pre-live buffering", () => {
  it("publishes call-started on a later microtask, never synchronously", async () => {
    const { session } = makeSession();
    const started: string[] = [];
    session.on("call-started", (payload) => {
      started.push(payload.sessionId);
    });

    expect(started).toEqual([]);
    await settled();
    expect(started).toEqual([session.id]);
  });

  it("buffers inbound audio arriving before the session is live and replays it in order", async () => {
    const { session } = makeSession();
    const received: number[] = [];
    session.on("audio-frame", ({ frame }) => {
      received.push(frame.timestamp);
    });

    // The adapter may deliver audio the instant it holds the handle —
    // before the session has gone live.
    session.handle.deliverAudio(frameAt(0));
    session.handle.deliverAudio(frameAt(20));
    expect(received).toEqual([]);

    await settled();
    expect(received).toEqual([0, 20]);
  });

  it("drops the oldest frames when the pre-live buffer overflows", async () => {
    const { session } = makeSession();
    const received: number[] = [];
    session.on("audio-frame", ({ frame }) => {
      received.push(frame.timestamp);
    });

    // 260 frames against a 250-frame bound: the 10 oldest are dropped.
    for (let i = 0; i < 260; i++) {
      session.handle.deliverAudio(frameAt(i));
    }
    await settled();

    expect(received).toHaveLength(250);
    expect(received[0]).toBe(10);
    expect(received.at(-1)).toBe(259);
  });

  it("defers an early answered() until after call-started", async () => {
    const { session } = makeSession();
    const order: string[] = [];
    session.on("call-started", () => {
      order.push("started");
    });
    session.on("call-answered", () => {
      order.push("answered");
    });

    session.handle.answered();
    await settled();

    expect(order).toEqual(["started", "answered"]);
  });

  it("publishes call-answered immediately once the session is live", async () => {
    const { session } = makeSession();
    await settled();

    const answered: string[] = [];
    session.on("call-answered", (payload) => {
      answered.push(payload.sessionId);
    });
    session.handle.answered();

    expect(answered).toEqual([session.id]);
  });
});

describe("teardown: exactly one call-ended, on every path", () => {
  it("emits exactly one call-ended under concurrent hangup / end / fail", async () => {
    const { session } = makeSession();
    await settled();
    const ended = recordEndings(session);

    session.handle.end("hangup");
    const endPromise = session.end();
    session.handle.fail(new Error("boom"));

    await endPromise;
    await session.ended;

    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe("hangup");
  });

  it("resolves the ended promise with the terminal payload, error included", async () => {
    const { session } = makeSession();
    await settled();
    const failure = new Error("upstream died");

    session.handle.fail(failure);
    const event = await session.ended;

    expect(event.reason).toBe("error");
    expect(event.error).toBe(failure);
    expect(event.sessionId).toBe(session.id);
  });

  it("aborts session.signal when teardown starts", async () => {
    const { session } = makeSession();
    await settled();

    expect(session.signal.aborted).toBe(false);
    await session.end();
    expect(session.signal.aborted).toBe(true);
  });

  it("is idempotent: repeated end() calls share one teardown", async () => {
    const { session } = makeSession();
    await settled();
    const ended = recordEndings(session);

    await Promise.all([session.end(), session.end(), session.end("hangup")]);

    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe("local-end");
  });

  // The single `call-ended` event alone is a weak assertion: a closed bus
  // would swallow duplicates even if teardown ran twice. These pin the
  // teardown *body* to one execution.
  it("runs the teardown body exactly once under concurrent hangup / end / fail", async () => {
    const { closed, session } = makeSession();
    await settled();
    const cleanupRuns: string[] = [];
    session.registerCleanup(() => {
      cleanupRuns.push("ran");
    });

    session.handle.end("hangup");
    const endPromise = session.end();
    session.handle.fail(new Error("boom"));
    await Promise.all([endPromise, session.end(), session.ended]);

    expect(cleanupRuns).toEqual(["ran"]);
    expect(closed.count).toBe(1);
  });

  it("releases the session to its owner exactly once", async () => {
    const { closed, session } = makeSession();
    await settled();

    await Promise.all([session.end(), session.end("hangup"), session.end()]);
    await session.ended;

    expect(closed.count).toBe(1);
  });

  it("never publishes call-started when torn down before going live", async () => {
    const { session } = makeSession();
    const started: string[] = [];
    session.on("call-started", () => {
      started.push("started");
    });
    const ended = recordEndings(session);

    // Teardown races the start microtask and wins.
    await session.end("hangup");
    await settled();

    expect(started).toEqual([]);
    expect(ended).toHaveLength(1);
  });
});

describe("registerCleanup", () => {
  it("runs cleanups in reverse registration order, before the terminal event", async () => {
    const { session } = makeSession();
    await settled();
    const order: string[] = [];
    session.on("call-ended", () => {
      order.push("call-ended");
    });

    session.registerCleanup(() => {
      order.push("first");
    });
    session.registerCleanup(() => {
      order.push("second");
    });

    await session.end();

    expect(order).toEqual(["second", "first", "call-ended"]);
  });

  it("awaits async cleanups before publishing call-ended", async () => {
    const { session } = makeSession();
    await settled();
    const order: string[] = [];
    session.on("call-ended", () => {
      order.push("call-ended");
    });

    session.registerCleanup(async () => {
      await settled();
      order.push("slow cleanup");
    });

    await session.end();

    expect(order).toEqual(["slow cleanup", "call-ended"]);
  });

  it("contains a throwing cleanup: later cleanups and the terminal event still run", async () => {
    const { session } = makeSession();
    await settled();
    const order: string[] = [];
    session.on("call-ended", () => {
      order.push("call-ended");
    });

    session.registerCleanup(() => {
      order.push("survivor");
    });
    session.registerCleanup(() => {
      order.push("thrower");
      throw new Error("cleanup exploded");
    });

    // Reverse order runs the thrower first; the survivor must still run.
    await expect(session.end()).resolves.toBeUndefined();

    expect(order).toEqual(["thrower", "survivor", "call-ended"]);
  });

  it("runs a cleanup registered after the call ended immediately", async () => {
    const { session } = makeSession();
    await settled();
    await session.end();

    const ran: string[] = [];
    session.registerCleanup(() => {
      ran.push("late");
    });
    expect(ran).toEqual([]);

    await settled();
    expect(ran).toEqual(["late"]);
  });

  it("contains a throwing late cleanup rather than rejecting", async () => {
    const { session } = makeSession();
    await settled();
    await session.end();

    session.registerCleanup(() => {
      throw new Error("late cleanup exploded");
    });

    await expect(settled()).resolves.toBeUndefined();
  });
});

describe("post-end operations are no-ops, not throws", () => {
  it("drops inbound audio delivered after the call ended", async () => {
    const { session } = makeSession();
    await settled();
    const received: number[] = [];
    session.on("audio-frame", ({ frame }) => {
      received.push(frame.timestamp);
    });

    session.handle.deliverAudio(frameAt(0));
    await session.end();
    session.handle.deliverAudio(frameAt(20));

    expect(received).toEqual([0]);
  });

  it("drops provider marks echoed after the bus closed", async () => {
    const { session } = makeSession();
    await settled();
    const echoed: string[] = [];
    session.on("audio-mark", ({ name }) => {
      echoed.push(name);
    });

    session.handle.mark("before");
    await session.end();
    session.handle.mark("after");

    expect(echoed).toEqual(["before"]);
  });

  it("drops outbound writes after teardown but still forwards clear()", async () => {
    const { clears, session, writes } = makeSession();
    await settled();

    session.audio.write(frameAt(0));
    await session.end();
    session.audio.write(frameAt(20));

    expect(writes).toHaveLength(1);

    // clear() stays forwarded: the adapter's own clear is post-end safe and
    // teardown legitimately flushes while "ending".
    const before = clears.count;
    session.audio.clear();
    expect(clears.count).toBe(before + 1);
  });

  it("ignores a late answered() after the call ended", async () => {
    const { session } = makeSession();
    await settled();
    const answered: string[] = [];
    session.on("call-answered", (payload) => {
      answered.push(payload.sessionId);
    });

    await session.end();
    session.handle.answered();

    expect(answered).toEqual([]);
  });
});

describe("error propagation", () => {
  it("tears the call down with reason 'error' on a fatal adapter failure", async () => {
    const { session } = makeSession();
    await settled();
    const ended = recordEndings(session);

    session.handle.fail(new Error("socket died"));
    await session.ended;

    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason).toBe("error");
  });

  it("reports a throwing lifecycle handler as a non-fatal error without ending the call", async () => {
    const lifecycle = emptyLifecycle();
    const seen: CallEventMap["error"][] = [];
    lifecycle.started.push(() => {
      throw new Error("handler exploded");
    });
    lifecycle.error.push((payload) => {
      seen.push(payload);
    });

    const { session } = makeSession({ lifecycle });
    const ended = recordEndings(session);
    await settled();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.fatal).toBe(false);
    expect(seen[0]?.source).toBe("handler:onCallStarted");
    expect(ended).toEqual([]);
  });

  it("reports a rejected async lifecycle handler as a non-fatal error", async () => {
    const lifecycle = emptyLifecycle();
    const seen: CallEventMap["error"][] = [];
    lifecycle.started.push(() => Promise.reject(new Error("async boom")));
    lifecycle.error.push((payload) => {
      seen.push(payload);
    });

    makeSession({ lifecycle });
    await settled();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.fatal).toBe(false);
    expect(seen[0]?.error.message).toBe("async boom");
  });

  it("does not let one throwing lifecycle handler starve the next", async () => {
    const lifecycle = emptyLifecycle();
    const ran: string[] = [];
    lifecycle.ended.push(() => {
      ran.push("first");
      throw new Error("ended handler exploded");
    });
    lifecycle.ended.push(() => {
      ran.push("second");
    });

    const { session } = makeSession({ lifecycle });
    await settled();
    await session.end();

    expect(ran).toEqual(["first", "second"]);
  });
});
