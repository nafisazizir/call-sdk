import { describe, expect, it } from "vitest";
import { placeholder } from "./index";

describe("example-twilio-on-ws placeholder", () => {
  it("exports a defined placeholder", () => {
    expect(placeholder).toBe(true);
  });
});
