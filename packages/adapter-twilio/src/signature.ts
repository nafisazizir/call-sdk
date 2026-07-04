/**
 * Twilio request signing (`X-Twilio-Signature`).
 *
 * Twilio signs every webhook request with HMAC-SHA1 over the full request
 * URL followed by every POST parameter, sorted by key and concatenated as
 * `key + value` (no separators), keyed with the account's auth token and
 * base64-encoded. This is Twilio's documented algorithm — see
 * https://www.twilio.com/docs/usage/security#validating-requests — and is
 * reproduced here (not imported) so `@call-adapter/tests`' `FakeTwilioCall`
 * can compute the exact same signature without depending on this package.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Computes the `X-Twilio-Signature` value for `url` + `params` under `authToken`. */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/**
 * Validates a received `X-Twilio-Signature` against the expected value,
 * using a timing-safe comparison to avoid leaking signature bytes through
 * response-time side channels. A length mismatch is treated as invalid
 * without a comparison (`timingSafeEqual` requires equal-length buffers).
 */
export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  const expected = Buffer.from(
    computeTwilioSignature(authToken, url, params),
    "utf8"
  );
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}
