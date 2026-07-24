/**
 * Configuration for {@link createTelnyxAdapter}.
 *
 * Every field is optional and resolution is **lazy** — nothing throws at
 * construction time, only when a value is actually needed (e.g. validating a
 * webhook signature, issuing a Call Control command, or placing an outbound
 * call). This matters because CI and local dev often construct an adapter
 * with no Telnyx credentials in the environment at all; the adapter should
 * still type-check and wire into `Call` without a live account.
 */
export interface TelnyxAdapterConfig {
  /**
   * The base URL of Telnyx's REST API. Overridable for tests (a local fake
   * server) — defaults to `"https://api.telnyx.com"`.
   */
  apiBaseUrl?: string;
  /**
   * Defaults to `process.env.TELNYX_API_KEY`. Sent as `Authorization: Bearer
   * ${apiKey}` on every Call Control REST command and on `dial`.
   */
  apiKey?: string;
  /**
   * Defaults to `process.env.TELNYX_CONNECTION_ID`. The Call Control
   * Application (connection) outbound calls are placed through. Required by
   * `dial`.
   */
  connectionId?: string;
  /** Path the media WebSocket is mounted on. Defaults to `"/telnyx/media"`. */
  mediaPath?: string;
  /**
   * The absolute `wss://` URL Telnyx should stream media to. When unset,
   * inbound calls derive it from the webhook request's `Host` header
   * (`wss://{host}{mediaPath}`) — but outbound calls have no inbound request
   * to derive it from, so `mediaUrl` is required for `dial`.
   */
  mediaUrl?: string;
  /** Defaults to `process.env.TELNYX_PHONE_NUMBER`. Used as `dial`'s default `from`. */
  phoneNumber?: string;
  /**
   * Defaults to `process.env.TELNYX_PUBLIC_KEY`. The base64-encoded Ed25519
   * public key used to verify the `telnyx-signature-ed25519` webhook header.
   */
  publicKey?: string;
  /**
   * Whether inbound webhooks validate the Ed25519 signature. Defaults to
   * `true` iff a public key is configured (explicitly or via env) — i.e.
   * validation is on by default whenever it's possible to do it.
   */
  validateSignature?: boolean;
}
