// Placeholder — replaced in later milestones

import type { Adapter } from "call-sdk";
import type { TwilioAdapterConfig } from "./types";

export class TwilioAdapter implements Adapter {
  readonly name = "twilio";
}

export function createTwilioAdapter(
  _config?: TwilioAdapterConfig
): TwilioAdapter {
  return new TwilioAdapter();
}

export type { TwilioAdapterConfig } from "./types";
