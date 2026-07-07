// The stage conformance suite. Lives here (not in `@call-adapter/tests`)
// because it exercises the `Stage` contract, which is part of the example's
// voice pipeline rather than the SDK's published surface.
import { createMockLogger } from "@call-adapter/tests";
import { type CallEventMap, type CallEventType, EventBus } from "call-sdk";
import { describe, expect, it } from "vitest";
import type { Stage, StageContext } from "../stage";
import { recordEvents } from "./matchers";

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
