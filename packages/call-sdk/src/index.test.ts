import { describe, expect, it } from "vitest";
import type { Adapter, Stage } from "./index";

describe("call-sdk placeholder contracts", () => {
  it("exposes an Adapter shape with a readonly name", () => {
    const adapter: Adapter = { name: "placeholder" };
    expect(adapter.name).toBe("placeholder");
  });

  it("exposes a Stage shape with a readonly name", () => {
    const stage: Stage = { name: "placeholder" };
    expect(stage.name).toBe("placeholder");
  });
});
