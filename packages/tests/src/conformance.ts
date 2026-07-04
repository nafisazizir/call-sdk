import {
  type Adapter,
  Call,
  type CallEventMap,
  type CallEventType,
  EventBus,
  formatSessionId,
  parseSessionId,
  type SessionInit,
  type Stage,
  type StageContext,
} from "call-sdk";
import { describe, expect, it } from "vitest";
import { createMockLogger, type MockCallDriver } from "./factories";
import { recordEvents } from "./matchers";
import { createMockSttStage, createMockTtsStage } from "./mock-stages";

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

  const build = (adapter: Adapter): Call =>
    new Call({
      adapters: { [adapter.name]: adapter },
      stages: [
        createMockSttStage({ script: [{ final: "hi" }] }),
        createMockTtsStage(),
      ],
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
