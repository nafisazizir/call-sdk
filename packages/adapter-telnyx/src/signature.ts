/**
 * Telnyx webhook signing (`telnyx-signature-ed25519` / `telnyx-timestamp`).
 *
 * Telnyx signs every webhook request with Ed25519 over the string
 * `${timestamp}|${rawBody}` (the raw request body bytes, exactly as
 * received — signature verification must happen before any JSON parsing
 * that could normalize whitespace). The public key is distributed as
 * base64 of the raw 32-byte Ed25519 key, which is not itself a valid input
 * to Node's `crypto.createPublicKey` — it must first be wrapped in a
 * minimal SPKI DER envelope. See
 * https://developers.telnyx.com/docs/change-management/webhooks/verifying-webhooks
 * for Telnyx's documented algorithm.
 */

import { createPublicKey, type KeyObject, verify } from "node:crypto";

/** Default tolerance, in seconds, for how stale a `telnyx-timestamp` may be. */
const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * The fixed 12-byte ASN.1 prefix for an Ed25519 SubjectPublicKeyInfo, taken
 * verbatim ahead of the 32 raw public key bytes: it encodes the SPKI
 * `AlgorithmIdentifier` for Ed25519 (OID 1.3.101.112) plus the outer/inner
 * DER length headers for a 32-byte `BIT STRING` payload. Every Ed25519 SPKI
 * key shares this exact prefix — only the trailing 32 bytes vary.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Wraps a raw 32-byte Ed25519 public key (as distributed by Telnyx, base64
 * encoded) in a minimal SPKI DER envelope and returns a `KeyObject` usable
 * with `crypto.verify`. Throws if `base64PublicKey` doesn't decode to
 * exactly 32 bytes or isn't a valid key.
 */
export function telnyxPublicKeyObject(base64PublicKey: string): KeyObject {
  const raw = Buffer.from(base64PublicKey, "base64");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export interface VerifyTelnyxSignatureOptions {
  /** Current time in unix seconds, injectable for tests. Defaults to `Date.now() / 1000`. */
  now?: number;
  /** Base64-encoded raw 32-byte Ed25519 public key (see {@link telnyxPublicKeyObject}). */
  publicKey: string;
  /** The raw request body, exactly as received (before any JSON parsing). */
  rawBody: string;
  /** Base64-encoded Ed25519 signature from the `telnyx-signature-ed25519` header. */
  signature: string;
  /** Unix seconds from the `telnyx-timestamp` header. */
  timestamp: string;
  /** How many seconds `timestamp` may drift from `now` before being rejected. Defaults to 300. */
  toleranceSeconds?: number;
}

/**
 * Verifies a Telnyx webhook's Ed25519 signature and timestamp freshness.
 * Never throws — a malformed key, malformed signature, stale timestamp, or
 * failed cryptographic verification all simply return `false`, since a
 * webhook signature check must be safe to run on arbitrary/attacker-
 * controlled input.
 */
export function verifyTelnyxSignature(
  opts: VerifyTelnyxSignatureOptions
): boolean {
  const toleranceSeconds = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.now ?? Date.now() / 1000;

  const timestamp = Number(opts.timestamp);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  try {
    const key = telnyxPublicKeyObject(opts.publicKey);
    const message = Buffer.from(`${opts.timestamp}|${opts.rawBody}`, "utf8");
    const signature = Buffer.from(opts.signature, "base64");
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
