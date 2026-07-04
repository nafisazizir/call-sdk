import { describe, expect, it } from "vitest";
import { placeholder } from "./index";

describe("@call-adapter/tests placeholder", () => {
  it("exports a defined placeholder", () => {
    expect(placeholder).toBe(true);
  });
});
