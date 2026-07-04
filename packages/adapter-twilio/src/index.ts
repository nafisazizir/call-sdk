// M3 stub — the real Twilio adapter lands in M4. This brings the class up to
// the current `Adapter` contract so the graph and conformance kit type-check
// against it; every I/O method throws until M4.

import type {
  Adapter,
  AdapterContext,
  MediaSocket,
  StartCallOptions,
  WebhookOptions,
} from "call-sdk";
import type { TwilioAdapterConfig } from "./types";

export class TwilioAdapter implements Adapter {
  readonly name = "twilio";
  #ctx?: AdapterContext;

  bind(ctx: AdapterContext): void {
    this.#ctx = ctx;
  }

  webhook(_request: Request, _options?: WebhookOptions): Promise<Response> {
    return this.#notImplemented();
  }

  media(_socket: MediaSocket): void {
    this.#notImplemented();
  }

  startCall(_options: StartCallOptions): Promise<{ callId: string }> {
    return this.#notImplemented();
  }

  #notImplemented(): never {
    // `#ctx` is captured at bind time and consumed by the real M4 impl.
    void this.#ctx;
    throw new Error("TwilioAdapter is not implemented until M4");
  }
}

export function createTwilioAdapter(
  _config?: TwilioAdapterConfig
): TwilioAdapter {
  return new TwilioAdapter();
}

export type { TwilioAdapterConfig } from "./types";
