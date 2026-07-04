import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus";
import type { CallEventMap } from "./events";

interface TestMap {
  other: { x: string };
  ping: { n: number };
}

const TIMED_OUT_RE = /timed out/;
const ABORTED_RE = /aborted/;
const CLOSED_RE = /closed/;

describe("EventBus.publish/subscribe", () => {
  it("dispatches synchronously, in subscription order", () => {
    const bus = new EventBus<TestMap>("s1");
    const order: string[] = [];
    bus.subscribe("ping", () => order.push("a"));
    bus.subscribe("ping", () => order.push("b"));
    bus.subscribe("ping", () => order.push("c"));
    bus.publish("ping", { n: 1 });
    // No microtask/await needed: dispatch already happened synchronously.
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("passes the payload and meta (sessionId, at) to handlers", () => {
    const bus = new EventBus<TestMap>("session-42");
    let received: unknown;
    let meta: unknown;
    bus.subscribe("ping", (payload, m) => {
      received = payload;
      meta = m;
    });
    bus.publish("ping", { n: 7 });
    expect(received).toEqual({ n: 7 });
    expect(meta).toMatchObject({ sessionId: "session-42" });
    expect(typeof (meta as { at: number }).at).toBe("number");
  });

  it("does not call handlers subscribed to a different event type", () => {
    const bus = new EventBus<TestMap>("s1");
    const pingHandler = vi.fn();
    const otherHandler = vi.fn();
    bus.subscribe("ping", pingHandler);
    bus.subscribe("other", otherHandler);
    bus.publish("ping", { n: 1 });
    expect(pingHandler).toHaveBeenCalledTimes(1);
    expect(otherHandler).not.toHaveBeenCalled();
  });

  it("is a no-op when publishing with no subscribers", () => {
    const bus = new EventBus<TestMap>("s1");
    expect(() => bus.publish("ping", { n: 1 })).not.toThrow();
  });

  it("unsubscribe is safe to call during dispatch of the same event", () => {
    const bus = new EventBus<TestMap>("s1");
    const calls: string[] = [];
    let unsubB: () => void = () => {
      // placeholder
    };
    bus.subscribe("ping", () => {
      calls.push("a");
      unsubB();
    });
    unsubB = bus.subscribe("ping", () => calls.push("b"));
    bus.subscribe("ping", () => calls.push("c"));

    // First publish: "a" unsubscribes "b" mid-dispatch, but the current
    // dispatch snapshot was already taken, so "b" still fires this time.
    bus.publish("ping", { n: 1 });
    expect(calls).toEqual(["a", "b", "c"]);

    // Second publish: "b" should no longer fire.
    calls.length = 0;
    bus.publish("ping", { n: 2 });
    expect(calls).toEqual(["a", "c"]);
  });

  it("unsubscribe is idempotent", () => {
    const bus = new EventBus<TestMap>("s1");
    const handler = vi.fn();
    const unsub = bus.subscribe("ping", handler);
    unsub();
    unsub();
    bus.publish("ping", { n: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("EventBus.once", () => {
  it("invokes the handler exactly once then auto-unsubscribes", () => {
    const bus = new EventBus<TestMap>("s1");
    const handler = vi.fn();
    bus.once("ping", handler);
    bus.publish("ping", { n: 1 });
    bus.publish("ping", { n: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ n: 1 }, expect.anything());
  });

  it("unsubscribes before invoking the handler (re-entrant publish sees it gone)", () => {
    const bus = new EventBus<TestMap>("s1");
    const calls: string[] = [];
    bus.once("ping", () => {
      calls.push("once");
      // Re-entrant publish while "once"'s handler is running.
      bus.publish("ping", { n: 99 });
    });
    bus.publish("ping", { n: 1 });
    expect(calls).toEqual(["once"]);
  });
});

describe("EventBus.waitFor", () => {
  it("resolves on the first matching event", async () => {
    const bus = new EventBus<TestMap>("s1");
    const promise = bus.waitFor("ping");
    bus.publish("ping", { n: 5 });
    await expect(promise).resolves.toEqual({ n: 5 });
  });

  it("resolves only once a predicate matches", async () => {
    const bus = new EventBus<TestMap>("s1");
    const promise = bus.waitFor("ping", { predicate: (p) => p.n === 3 });
    bus.publish("ping", { n: 1 });
    bus.publish("ping", { n: 2 });
    bus.publish("ping", { n: 3 });
    await expect(promise).resolves.toEqual({ n: 3 });
  });

  it("rejects on timeout", async () => {
    const bus = new EventBus<TestMap>("s1");
    await expect(bus.waitFor("ping", { timeoutMs: 5 })).rejects.toThrow(
      TIMED_OUT_RE
    );
  });

  it("rejects when the AbortSignal aborts", async () => {
    const bus = new EventBus<TestMap>("s1");
    const controller = new AbortController();
    const promise = bus.waitFor("ping", { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(ABORTED_RE);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const bus = new EventBus<TestMap>("s1");
    const controller = new AbortController();
    controller.abort();
    await expect(
      bus.waitFor("ping", { signal: controller.signal })
    ).rejects.toThrow(ABORTED_RE);
  });

  it("rejects pending waiters when the bus is closed", async () => {
    const bus = new EventBus<TestMap>("s1");
    const promise = bus.waitFor("ping");
    bus.close();
    await expect(promise).rejects.toThrow(CLOSED_RE);
  });

  it("does not resolve/reject twice when timeout and match race", async () => {
    const bus = new EventBus<TestMap>("s1");
    const promise = bus.waitFor("ping", { timeoutMs: 50 });
    bus.publish("ping", { n: 1 });
    await expect(promise).resolves.toEqual({ n: 1 });
    // Give the timer a chance to fire; if it fired and tried to reject an
    // already-settled promise, vitest would surface an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

describe("EventBus.close", () => {
  it("sets closed to true", () => {
    const bus = new EventBus<TestMap>("s1");
    expect(bus.closed).toBe(false);
    bus.close();
    expect(bus.closed).toBe(true);
  });

  it("is idempotent", () => {
    const bus = new EventBus<TestMap>("s1");
    bus.close();
    expect(() => bus.close()).not.toThrow();
    expect(bus.closed).toBe(true);
  });

  it("makes publish a silent no-op after close", () => {
    const bus = new EventBus<TestMap>("s1");
    const handler = vi.fn();
    bus.subscribe("ping", handler);
    bus.close();
    expect(() => bus.publish("ping", { n: 1 })).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("makes subscribe a silent no-op after close", () => {
    const bus = new EventBus<TestMap>("s1");
    bus.close();
    const handler = vi.fn();
    const unsub = bus.subscribe("ping", handler);
    expect(() => unsub()).not.toThrow();
  });

  it("rejects a waitFor called after close", async () => {
    const bus = new EventBus<TestMap>("s1");
    bus.close();
    await expect(bus.waitFor("ping")).rejects.toThrow(CLOSED_RE);
  });
});

describe("EventBus listener error containment", () => {
  it("catches a throwing handler and does not stop dispatch to other handlers", () => {
    const bus = new EventBus<TestMap>("s1");
    const afterHandler = vi.fn();
    bus.subscribe("ping", () => {
      throw new Error("boom");
    });
    bus.subscribe("ping", afterHandler);
    expect(() => bus.publish("ping", { n: 1 })).not.toThrow();
    expect(afterHandler).toHaveBeenCalledTimes(1);
  });

  it("invokes onListenerError with the error and event type", () => {
    const onListenerError = vi.fn();
    const bus = new EventBus<TestMap>("s1", { onListenerError });
    const err = new Error("boom");
    bus.subscribe("ping", () => {
      throw err;
    });
    bus.publish("ping", { n: 1 });
    expect(onListenerError).toHaveBeenCalledWith(err, "ping");
  });

  it("wraps non-Error throws into an Error", () => {
    const onListenerError = vi.fn();
    const bus = new EventBus<TestMap>("s1", { onListenerError });
    bus.subscribe("ping", () => {
      // biome-ignore lint/style/useThrowOnlyError: exercising non-Error throw handling
      throw "stringy failure";
    });
    bus.publish("ping", { n: 1 });
    expect(onListenerError).toHaveBeenCalledTimes(1);
    const [receivedErr] = onListenerError.mock.calls[0];
    expect(receivedErr).toBeInstanceOf(Error);
    expect(receivedErr.message).toContain("stringy failure");
  });

  it("guards against recursion when onListenerError itself triggers the same failing handler synchronously", () => {
    let throwCount = 0;
    // Simulate the session wiring described in bus.ts's doc comment: a
    // listener error gets republished as an "error" event, whose own
    // subscriber throws again, synchronously re-entering
    // handleListenerError for "error" itself.
    const onListenerError = (err: Error) => {
      bus.publish("error", { error: err, source: "bus", fatal: false });
    };
    const bus = new EventBus<CallEventMap>("s1", { onListenerError });
    bus.subscribe("error", () => {
      throwCount++;
      throw new Error(`error handler failure #${throwCount}`);
    });

    expect(() =>
      bus.publish("error", {
        error: new Error("original"),
        source: "test",
        fatal: false,
      })
    ).not.toThrow();
    // The recursion guard should have stopped it well short of a stack
    // overflow / infinite loop — the guard fires on the second re-entrant
    // call, so exactly 2 throws happen (the original dispatch, then one
    // re-entrant republish before the guard kicks in).
    expect(throwCount).toBe(2);
  });
});
