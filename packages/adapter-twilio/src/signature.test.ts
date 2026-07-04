import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeTwilioSignature, validateTwilioSignature } from "./signature";

const AUTH_TOKEN = "test-auth-token-golden";
const URL = "https://example.com/twilio/voice";
const PARAMS = {
  CallSid: "CA1234567890abcdef1234567890abcdef",
  From: "+15551234567",
  To: "+15557654321",
  Direction: "inbound",
};
// Pinned by computing the HMAC-SHA1-over-(url + sorted key+value concatenation)
// independently below and hardcoding the result, so a regression in
// `computeTwilioSignature`'s algorithm (wrong sort order, wrong hash, wrong
// encoding) is caught even if the test's own "independent" computation were
// accidentally kept in sync with a broken implementation.
const GOLDEN_SIGNATURE = "vPYps0NpKtyi7jX1fvLfvR/mX7o=";

function independentlyComputedSignature(): string {
  const data = Object.keys(PARAMS)
    .sort()
    .reduce(
      (acc, key) => acc + key + (PARAMS as Record<string, string>)[key],
      URL
    );
  return createHmac("sha1", AUTH_TOKEN).update(data, "utf8").digest("base64");
}

describe("computeTwilioSignature", () => {
  it("matches an independently computed HMAC-SHA1 golden vector", () => {
    const expected = independentlyComputedSignature();
    expect(expected).toBe(GOLDEN_SIGNATURE);
    expect(computeTwilioSignature(AUTH_TOKEN, URL, PARAMS)).toBe(expected);
  });

  it("is sensitive to the URL", () => {
    const withUrl = computeTwilioSignature(AUTH_TOKEN, URL, PARAMS);
    const withOtherUrl = computeTwilioSignature(
      AUTH_TOKEN,
      `${URL}?extra=1`,
      PARAMS
    );
    expect(withOtherUrl).not.toBe(withUrl);
  });
});

describe("validateTwilioSignature", () => {
  it("accepts the golden signature", () => {
    expect(
      validateTwilioSignature(AUTH_TOKEN, URL, PARAMS, GOLDEN_SIGNATURE)
    ).toBe(true);
  });

  it("rejects a tampered parameter", () => {
    const tampered = { ...PARAMS, From: "+15559999999" };
    expect(
      validateTwilioSignature(AUTH_TOKEN, URL, tampered, GOLDEN_SIGNATURE)
    ).toBe(false);
  });

  it("rejects a tampered signature of the same length", () => {
    const flipped = `${GOLDEN_SIGNATURE.slice(0, -1)}${
      GOLDEN_SIGNATURE.at(-1) === "A" ? "B" : "A"
    }`;
    expect(validateTwilioSignature(AUTH_TOKEN, URL, PARAMS, flipped)).toBe(
      false
    );
  });

  it("rejects a signature of a different length", () => {
    expect(validateTwilioSignature(AUTH_TOKEN, URL, PARAMS, "short")).toBe(
      false
    );
  });
});
