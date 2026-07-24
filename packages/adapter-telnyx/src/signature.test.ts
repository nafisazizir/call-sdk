import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { telnyxPublicKeyObject, verifyTelnyxSignature } from "./signature";

function generateEd25519KeyPair(): {
  publicKeyBase64: string;
  sign: (message: Buffer) => Buffer;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // The raw 32-byte Ed25519 public key is the last 32 bytes of the DER SPKI
  // encoding — the same layout `telnyxPublicKeyObject` reconstructs from.
  const spkiDer = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = spkiDer.subarray(spkiDer.length - 32);
  return {
    publicKeyBase64: rawPublicKey.toString("base64"),
    sign: (message: Buffer) => sign(null, message, privateKey),
  };
}

describe("telnyxPublicKeyObject", () => {
  it("reconstructs a usable key object from a raw base64 public key", () => {
    const { publicKeyBase64 } = generateEd25519KeyPair();
    const keyObject = telnyxPublicKeyObject(publicKeyBase64);
    expect(keyObject.asymmetricKeyType).toBe("ed25519");
  });
});

describe("verifyTelnyxSignature", () => {
  it("accepts a validly signed webhook", () => {
    const { publicKeyBase64, sign: signMessage } = generateEd25519KeyPair();
    const timestamp = "1700000000";
    const rawBody = '{"data":{"event_type":"call.initiated"}}';
    const signature = signMessage(
      Buffer.from(`${timestamp}|${rawBody}`, "utf8")
    ).toString("base64");

    expect(
      verifyTelnyxSignature({
        publicKey: publicKeyBase64,
        timestamp,
        rawBody,
        signature,
        now: Number(timestamp),
      })
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { publicKeyBase64, sign: signMessage } = generateEd25519KeyPair();
    const timestamp = "1700000000";
    const rawBody = '{"data":{"event_type":"call.initiated"}}';
    const signature = signMessage(
      Buffer.from(`${timestamp}|${rawBody}`, "utf8")
    ).toString("base64");

    expect(
      verifyTelnyxSignature({
        publicKey: publicKeyBase64,
        timestamp,
        rawBody: '{"data":{"event_type":"call.hangup"}}',
        signature,
        now: Number(timestamp),
      })
    ).toBe(false);
  });

  it("rejects a signature made with the wrong key", () => {
    const { sign: signMessage } = generateEd25519KeyPair();
    const { publicKeyBase64: otherPublicKey } = generateEd25519KeyPair();
    const timestamp = "1700000000";
    const rawBody = '{"data":{"event_type":"call.initiated"}}';
    const signature = signMessage(
      Buffer.from(`${timestamp}|${rawBody}`, "utf8")
    ).toString("base64");

    expect(
      verifyTelnyxSignature({
        publicKey: otherPublicKey,
        timestamp,
        rawBody,
        signature,
        now: Number(timestamp),
      })
    ).toBe(false);
  });

  it("rejects a timestamp outside the tolerance window", () => {
    const { publicKeyBase64, sign: signMessage } = generateEd25519KeyPair();
    const timestamp = "1700000000";
    const rawBody = '{"data":{"event_type":"call.initiated"}}';
    const signature = signMessage(
      Buffer.from(`${timestamp}|${rawBody}`, "utf8")
    ).toString("base64");

    // `now` is injected 400s after `timestamp`, beyond the default 300s
    // tolerance — this exercises staleness without sleeping.
    expect(
      verifyTelnyxSignature({
        publicKey: publicKeyBase64,
        timestamp,
        rawBody,
        signature,
        now: Number(timestamp) + 400,
      })
    ).toBe(false);
  });

  it("accepts a timestamp within a custom tolerance window", () => {
    const { publicKeyBase64, sign: signMessage } = generateEd25519KeyPair();
    const timestamp = "1700000000";
    const rawBody = '{"data":{"event_type":"call.initiated"}}';
    const signature = signMessage(
      Buffer.from(`${timestamp}|${rawBody}`, "utf8")
    ).toString("base64");

    expect(
      verifyTelnyxSignature({
        publicKey: publicKeyBase64,
        timestamp,
        rawBody,
        signature,
        now: Number(timestamp) + 400,
        toleranceSeconds: 600,
      })
    ).toBe(true);
  });

  it("returns false, not throws, for a garbage base64 public key", () => {
    const timestamp = "1700000000";
    const rawBody = "{}";
    expect(
      verifyTelnyxSignature({
        publicKey: "not-a-valid-key!!",
        timestamp,
        rawBody,
        signature: Buffer.alloc(64).toString("base64"),
        now: Number(timestamp),
      })
    ).toBe(false);
  });

  it("returns false, not throws, for a garbage base64 signature", () => {
    const { publicKeyBase64 } = generateEd25519KeyPair();
    const timestamp = "1700000000";
    const rawBody = "{}";
    expect(
      verifyTelnyxSignature({
        publicKey: publicKeyBase64,
        timestamp,
        rawBody,
        signature: "not-a-valid-signature!!",
        now: Number(timestamp),
      })
    ).toBe(false);
  });

  it("returns false for a non-numeric timestamp", () => {
    const { publicKeyBase64 } = generateEd25519KeyPair();
    expect(
      verifyTelnyxSignature({
        publicKey: publicKeyBase64,
        timestamp: "not-a-number",
        rawBody: "{}",
        signature: Buffer.alloc(64).toString("base64"),
      })
    ).toBe(false);
  });
});
