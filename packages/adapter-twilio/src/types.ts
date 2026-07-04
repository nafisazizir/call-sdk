/**
 * Configuration for {@link createTwilioAdapter}.
 *
 * Every field is optional and resolution is **lazy** — nothing throws at
 * construction time, only when a value is actually needed (e.g. validating a
 * signature, or placing an outbound call). This matters because CI and local
 * dev often construct an adapter with no Twilio credentials in the
 * environment at all; the adapter should still type-check and wire into
 * `Call` without a live account.
 */
export interface TwilioAdapterConfig {
  /** Defaults to `process.env.TWILIO_ACCOUNT_SID`. Required by `startCall`. */
  accountSid?: string;
  /**
   * The base URL of Twilio's REST API. Overridable for tests (a local fake
   * server) — defaults to `"https://api.twilio.com"`.
   */
  apiBaseUrl?: string;
  /** Defaults to `process.env.TWILIO_AUTH_TOKEN`. Required for signature validation and `startCall`. */
  authToken?: string;
  /** Path the media WebSocket is mounted on. Defaults to `"/twilio/media"`. */
  mediaPath?: string;
  /**
   * The absolute `wss://` URL Twilio should dial for the media stream. When
   * unset, inbound webhooks derive it from the request's `Host` header
   * (`wss://{host}{mediaPath}`) — but outbound calls have no inbound request
   * to derive it from, so `mediaUrl` is required for `startCall`.
   */
  mediaUrl?: string;
  /** Defaults to `process.env.TWILIO_PHONE_NUMBER`. Used as `startCall`'s default `from`. */
  phoneNumber?: string;
  /**
   * Whether inbound webhooks validate `X-Twilio-Signature`. Defaults to
   * `true` iff an auth token is configured (explicitly or via env) — i.e.
   * validation is on by default whenever it's possible to do it.
   */
  validateSignature?: boolean;
}
