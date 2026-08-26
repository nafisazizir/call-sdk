import { describe, expect, it, vi } from "vitest";
import { Call } from "./call";
import { AdapterError, CallConfigError } from "./errors";
import type { CallSession } from "./session";
import type {
  Adapter,
  AdapterContext,
  AdapterSessionHandle,
  OutboundAudio,
} from "./types";

interface TestAdapter {
  adapter: Adapter;
  /** Simulate the provider opening a media session for a call id. */
  connect(callId: string): AdapterSessionHandle;
  /** The AdapterContext captured at bind time. */
  ctx(): AdapterContext;
}

function makeAdapter(name = "mock"): TestAdapter {
  let bound: AdapterContext | undefined;
  const outbound: OutboundAudio = {
    write: () => {
      // discard
    },
    clear: () => {
      // discard
    },
  };
  const adapter: Adapter = {
    name,
    bind: (ctx) => {
      bound = ctx;
    },
    dial: (options) => Promise.resolve({ callId: `out-${options.to}` }),
    media: () => {
      // not exercised here
    },
    webhook: () => Promise.resolve(new Response("ok")),
  };
  const ctx = () => {
    if (!bound) {
      throw new Error("adapter not bound");
    }
    return bound;
  };
  return {
    adapter,
    ctx,
    connect: (callId) =>
      ctx().createSession({ callId, direction: "inbound" }, outbound),
  };
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("lifecycle handler registration", () => {
  it("runs multiple handlers in registration order", async () => {
    const { adapter, connect } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    const order: string[] = [];
    call.onCallStarted(() => void order.push("first"));
    call.onCallStarted(() => void order.push("second"));
    connect("c1");
    await vi.waitFor(() => {
      expect(order).toEqual(["first", "second"]);
    });
  });

  it("fires handlers registered after a session already exists", async () => {
    const { adapter, connect } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    const handle = connect("c1");
    await settled();
    const ended = vi.fn();
    call.onCallEnded(ended);
    handle.end("hangup");
    await vi.waitFor(() => {
      expect(ended).toHaveBeenCalledOnce();
    });
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ reason: "hangup" });
  });

  it("a throwing handler does not starve later handlers", async () => {
    const { adapter, connect } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    const seen: string[] = [];
    call.onCallStarted(() => {
      throw new Error("boom");
    });
    call.onCallStarted(() => void seen.push("still-ran"));
    const errors: string[] = [];
    call.onError((event) => void errors.push(event.error.message));
    connect("c1");
    await vi.waitFor(() => {
      expect(seen).toEqual(["still-ran"]);
    });
    await vi.waitFor(() => {
      expect(errors).toContain("boom");
    });
  });

  it("rejects a second onIncomingCall registration", () => {
    const { adapter } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    call.onIncomingCall((incoming) => incoming.stream());
    expect(() => call.onIncomingCall((incoming) => incoming.reject())).toThrow(
      CallConfigError
    );
  });
});

describe("routeIncomingCall", () => {
  const INIT = { callId: "CA9", from: "+15550001111" };

  it("defaults to stream when no handler is registered", async () => {
    const { adapter, ctx } = makeAdapter();
    void new Call({ adapters: { mock: adapter }, logger: "silent" });
    const decision = await ctx().routeIncomingCall(INIT);
    expect(decision.actions).toEqual([{ type: "stream" }]);
  });

  it("returns the handler's decision and exposes the call facts", async () => {
    const { adapter, ctx } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    call.onIncomingCall((incoming) => {
      expect(incoming.adapter).toBe("mock");
      expect(incoming.callId).toBe("CA9");
      expect(incoming.from).toBe("+15550001111");
      return incoming.forwardTo("+15550002222");
    });
    const decision = await ctx().routeIncomingCall(INIT);
    expect(decision.actions).toEqual([
      { type: "forward", to: ["+15550002222"] },
    ]);
  });

  it("supports async handlers", async () => {
    const { adapter, ctx } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    call.onIncomingCall(async (incoming) => {
      await settled();
      return incoming.voicemail({ prompt: "beep" });
    });
    const decision = await ctx().routeIncomingCall(INIT);
    expect(decision.actions).toHaveLength(2);
  });

  it("converts a throwing handler into reject, never a rejection", async () => {
    const { adapter, ctx } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    call.onIncomingCall(() => {
      throw new Error("router exploded");
    });
    const decision = await ctx().routeIncomingCall(INIT);
    expect(decision.actions).toEqual([{ type: "reject", reason: "rejected" }]);
  });

  it("converts a handler timeout into reject", async () => {
    const { adapter, ctx } = makeAdapter();
    const call = new Call({
      adapters: { mock: adapter },
      logger: "silent",
      routing: { handlerTimeoutMs: 20 },
    });
    call.onIncomingCall(
      () =>
        new Promise(() => {
          // never resolves
        })
    );
    const decision = await ctx().routeIncomingCall(INIT);
    expect(decision.actions).toEqual([{ type: "reject", reason: "rejected" }]);
  });

  it("converts a non-decision return value into reject", async () => {
    const { adapter, ctx } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    // @ts-expect-error — deliberately returning garbage
    call.onIncomingCall(() => "stream");
    const decision = await ctx().routeIncomingCall(INIT);
    expect(decision.actions).toEqual([{ type: "reject", reason: "rejected" }]);
  });
});

describe("dial", () => {
  it("resolves with the live session once media connects", async () => {
    const { adapter, connect } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    const pending = call.dial({ adapter: "mock", to: "+15550005555" });
    // adapter.dial resolved with callId `out-+15550005555`; simulate media.
    await settled();
    connect("out-+15550005555");
    const session: CallSession = await pending;
    expect(session.callId).toBe("out-+15550005555");
    expect(call.getSession(session.id)).toBe(session);
    await session.end();
  });

  it("times out when media never connects", async () => {
    const { adapter } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    await expect(
      call.dial({ adapter: "mock", to: "+15550005555", timeoutMs: 20 })
    ).rejects.toThrow(AdapterError);
  });

  it("throws on an unknown adapter name", async () => {
    const { adapter } = makeAdapter();
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    await expect(
      call.dial({ adapter: "nope", to: "+15550005555" })
    ).rejects.toThrow(CallConfigError);
  });
});
