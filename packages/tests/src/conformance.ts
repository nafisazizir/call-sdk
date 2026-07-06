import type { Stage, StageContext } from "@call-adapter/pipeline";
import {
  type Adapter,
  Call,
  type CallEventMap,
  type CallEventType,
  EventBus,
  formatSessionId,
  type IncomingCall,
  parseSessionId,
  type RoutingDecision,
  type SessionInit,
} from "call-sdk";
import { describe, expect, it } from "vitest";
import { createMockLogger, type MockCallDriver } from "./factories";
import { recordEvents } from "./matchers";

type ConnectableAdapter = Adapter & {
  connectCall?: (init?: Partial<SessionInit>) => MockCallDriver;
};

export interface AdapterContractOptions {
  /**
   * Opens a live session against a `Call` wired to the adapter and returns its
   * id plus a way to end it from the provider side. Defaults to using the
   * adapter's `connectCall` when present.
   */
  openSession?: (
    call: Call,
    adapter: Adapter
  ) => Promise<{ sessionId: string; endFromProvider(): void }>;
}

/**
 * A reusable Vitest suite asserting the behaviors every {@link Adapter} shares:
 * well-formed, round-trippable session ids, and safe post-teardown semantics
 * (handle calls become no-ops; `call-ended` fires exactly once).
 */
export function adapterContract(
  name: string,
  makeAdapter: () => ConnectableAdapter,
  opts?: AdapterContractOptions
): void {
  const openSession =
    opts?.openSession ??
    ((_call: Call, adapter: Adapter) => {
      const connectable = adapter as ConnectableAdapter;
      if (!connectable.connectCall) {
        throw new Error(
          `adapterContract("${name}") needs opts.openSession for adapters without connectCall`
        );
      }
      const driver = connectable.connectCall();
      return Promise.resolve({
        sessionId: driver.sessionId,
        endFromProvider: () => driver.hangup(),
      });
    });

  // This contract only exercises the transport/session surface (ids,
  // teardown, no-op-after-end) — none of it needs a voice pipeline attached,
  // so the stage graph is dropped entirely rather than carried along.
  const build = (adapter: Adapter): Call =>
    new Call({
      adapters: { [adapter.name]: adapter },
      logger: "silent",
    });

  describe(`adapter contract: ${name}`, () => {
    it("creates a session with a well-formed, round-trippable id", async () => {
      const adapter = makeAdapter();
      const call = build(adapter);
      const { sessionId } = await openSession(call, adapter);
      const parsed = parseSessionId(sessionId);
      expect(parsed.adapter).toBe(adapter.name);
      expect(formatSessionId(parsed.adapter, parsed.callId)).toBe(sessionId);
      expect(sessionId.startsWith(`${adapter.name}:`)).toBe(true);
      await call.getSession(sessionId)?.end("local-end");
    });

    it("makes handle calls no-op after end and never doubles call-ended", async () => {
      const adapter = makeAdapter();
      const call = build(adapter);
      const opened = await openSession(call, adapter);
      const session = call.getSession(opened.sessionId);
      expect(session).toBeDefined();
      if (!session) {
        return;
      }
      const recorded = recordEvents(session.bus);
      await session.end("local-end");

      const handle = session.handle;
      expect(() =>
        handle.deliverAudio({ samples: new Int16Array(320), timestamp: 0 })
      ).not.toThrow();
      expect(() => handle.answered()).not.toThrow();
      expect(() => handle.mark("nope")).not.toThrow();

      // A provider-side end after teardown, and a second local end, must not
      // produce a second terminal event.
      opened.endFromProvider();
      await session.end("local-end");
      expect(recorded.of("call-ended").length).toBe(1);
    });
  });
}

export interface StageContractOptions {
  /** Publishes the stage's declared inputs onto the bus. */
  arrange: (bus: EventBus<CallEventMap>) => void | Promise<void>;
  /** Event types the stage must emit given `arrange`'s inputs. */
  expectEmits: CallEventType[];
  /** How long to wait for async stage output before asserting. Default 100ms. */
  timeoutMs?: number;
}

/**
 * A reusable Vitest suite asserting a {@link Stage}'s declared `consumes`/`emits`
 * are truthful: it emits everything it claims, nothing it doesn't, disposes
 * cleanly, and goes silent after dispose.
 */
export function stageContract(
  name: string,
  makeStage: () => Stage,
  opts: StageContractOptions
): void {
  const settleMs = opts.timeoutMs ?? 100;
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, settleMs));

  describe(`stage contract: ${name}`, () => {
    it("honors its declared consumes/emits surface", async () => {
      const stage = makeStage();
      const logger = createMockLogger();
      const bus = new EventBus<CallEventMap>(`stage:${name}`, { logger });
      const controller = new AbortController();
      const ctx: StageContext = {
        sessionId: `stage:${name}`,
        bus,
        logger,
        signal: controller.signal,
        mark: () => {
          // ignored in the contract harness
        },
        fail: () => {
          // ignored in the contract harness
        },
      };

      const handle = await stage.attach(ctx);
      const recorded = recordEvents(bus);

      await opts.arrange(bus);
      await settle();

      for (const type of opts.expectEmits) {
        expect(
          recorded.of(type).length,
          `expected stage "${name}" to emit "${type}"`
        ).toBeGreaterThan(0);
      }

      const allowed = new Set<CallEventType>([
        ...stage.emits,
        ...stage.consumes,
        ...(stage.optionalConsumes ?? []),
      ]);
      for (const entry of recorded.all) {
        expect(
          allowed.has(entry.type),
          `stage "${name}" published undeclared event "${entry.type}"`
        ).toBe(true);
      }

      await handle.dispose();
      const before = new Map(
        stage.emits.map((type) => [type, recorded.of(type).length])
      );
      await opts.arrange(bus);
      await settle();
      for (const type of stage.emits) {
        expect(
          recorded.of(type).length,
          `stage "${name}" emitted "${type}" after dispose`
        ).toBe(before.get(type));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Routing contract
// ---------------------------------------------------------------------------

type RoutingVerbName =
  | "reject"
  | "forward"
  | "say"
  | "play"
  | "voicemail"
  | "hangup"
  | "stream";

export interface RoutingContractOptions {
  /** Assert the adapter translated the action correctly, given the raw response. */
  expectTranslated: Partial<
    Record<
      RoutingVerbName,
      (response: { status: number; body: string }) => void | Promise<void>
    >
  >;
  /** Build a provider-shaped inbound webhook Request for this adapter. */
  makeInboundRequest: () => Request | Promise<Request>;
}

/** Fixed, sensible arguments for each routing verb — the contract only cares that the adapter translated *some* invocation correctly. */
const ROUTING_VERB_INVOCATIONS: Record<
  RoutingVerbName,
  (incoming: IncomingCall) => RoutingDecision
> = {
  reject: (incoming) => incoming.reject(),
  forward: (incoming) => incoming.forwardTo("+15550001111"),
  say: (incoming) => incoming.say("hello"),
  play: (incoming) => incoming.play("https://example.com/a.mp3"),
  voicemail: (incoming) => incoming.voicemail({ prompt: "leave a message" }),
  hangup: (incoming) => incoming.hangup(),
  stream: (incoming) => incoming.stream(),
};

async function readTranslatedResponse(
  response: Response
): Promise<{ status: number; body: string }> {
  return { status: response.status, body: await response.text() };
}

/**
 * A reusable Vitest suite asserting an {@link Adapter}'s call-control webhook
 * translates each `RoutingDecision` verb into the provider's own dialect
 * (TwiML, Call Control, NCCO, ...) — never deciding anything itself (SPEC:
 * adapters translate, they never decide). Also covers the two decisions core
 * makes without a routing handler: default-stream and handler-throws-reject.
 */
export function routingContract(
  name: string,
  makeAdapter: () => Adapter,
  options: RoutingContractOptions
): void {
  describe(`routing contract: ${name}`, () => {
    const verbNames = Object.keys(
      options.expectTranslated
    ) as RoutingVerbName[];

    for (const verb of verbNames) {
      const assertion = options.expectTranslated[verb];
      if (!assertion) {
        continue;
      }
      it(`translates ${verb}`, async () => {
        const call = new Call({
          adapters: { [name]: makeAdapter() },
          logger: "silent",
        });
        call.onIncomingCall((incoming) =>
          ROUTING_VERB_INVOCATIONS[verb](incoming)
        );
        const request = await options.makeInboundRequest();
        const response = await call.webhooks[name](request);
        expect(response.status).toBeLessThan(500);
        await assertion(await readTranslatedResponse(response));
      });
    }

    it("streams by default when no onIncomingCall handler is registered", async () => {
      const call = new Call({
        adapters: { [name]: makeAdapter() },
        logger: "silent",
      });
      const request = await options.makeInboundRequest();
      const response = await call.webhooks[name](request);
      expect(response.status).toBeLessThan(500);
      const streamAssertion = options.expectTranslated.stream;
      if (streamAssertion) {
        await streamAssertion(await readTranslatedResponse(response));
      } else {
        expect(response.status).toBe(200);
      }
    });

    it("rejects when the routing handler throws", async () => {
      const call = new Call({
        adapters: { [name]: makeAdapter() },
        logger: "silent",
      });
      call.onIncomingCall(() => {
        throw new Error("routing handler boom");
      });
      const request = await options.makeInboundRequest();
      const response = await call.webhooks[name](request);
      expect(response.status).toBeLessThan(500);
      const rejectAssertion = options.expectTranslated.reject;
      if (rejectAssertion) {
        await rejectAssertion(await readTranslatedResponse(response));
      } else {
        expect(response.status).toBe(200);
      }
    });
  });
}
