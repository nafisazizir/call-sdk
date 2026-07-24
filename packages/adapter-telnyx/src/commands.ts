/**
 * Telnyx Call Control v2 REST client — the async command layer Telnyx
 * webhooks are paired with (unlike Twilio's synchronous TwiML response,
 * every Call Control action is a `POST .../actions/{command}` that Telnyx
 * acknowledges immediately and then reports the outcome of via a follow-up
 * webhook event).
 */

import { AdapterError } from "call-sdk";

export interface TelnyxCommandClientOptions {
  apiBaseUrl: string;
  apiKey: string;
}

export interface TelnyxAnswerBody {
  client_state?: string;
  command_id?: string;
  stream_bidirectional_codec?: string;
  stream_bidirectional_mode?: string;
  stream_bidirectional_sampling_rate?: number;
  stream_codec?: string;
  stream_track?: string;
  stream_url?: string;
}

export interface TelnyxRejectBody {
  cause: "USER_BUSY" | "CALL_REJECTED";
  command_id?: string;
}

export interface TelnyxTransferBody {
  client_state?: string;
  command_id?: string;
  from?: string;
  timeout_secs?: number;
  to: string;
}

export interface TelnyxSpeakBody {
  client_state?: string;
  command_id?: string;
  language?: string;
  payload: string;
  voice?: string;
}

export interface TelnyxPlaybackStartBody {
  audio_url: string;
  client_state?: string;
  command_id?: string;
}

export interface TelnyxRecordStartBody {
  channels: "single" | "dual";
  client_state?: string;
  command_id?: string;
  format: "mp3" | "wav";
  max_length?: number;
  play_beep?: boolean;
}

export interface TelnyxHangupBody {
  client_state?: string;
  command_id?: string;
}

export interface TelnyxCommandClient {
  answer(callControlId: string, body: TelnyxAnswerBody): Promise<void>;
  createCall(body: Record<string, unknown>): Promise<{ callId: string }>;
  hangup(callControlId: string, body?: TelnyxHangupBody): Promise<void>;
  playbackStart(
    callControlId: string,
    body: TelnyxPlaybackStartBody
  ): Promise<void>;
  recordStart(
    callControlId: string,
    body: TelnyxRecordStartBody
  ): Promise<void>;
  reject(callControlId: string, body: TelnyxRejectBody): Promise<void>;
  speak(callControlId: string, body: TelnyxSpeakBody): Promise<void>;
  transfer(callControlId: string, body: TelnyxTransferBody): Promise<void>;
}

/** Response snippet length kept in a REST error message — enough to debug, not enough to be noisy. */
const ERROR_BODY_SNIPPET_LENGTH = 500;

async function postAction<T extends object>(
  options: TelnyxCommandClientOptions,
  callControlId: string,
  command: string,
  body: T
): Promise<void> {
  const url = `${options.apiBaseUrl}/v2/calls/${encodeURIComponent(callControlId)}/actions/${command}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwForFailedResponse(response, `Telnyx ${command} command`);
  }
}

async function throwForFailedResponse(
  response: Response,
  context: string
): Promise<never> {
  const text = await response.text();
  throw new AdapterError(
    `${context} failed (${response.status}): ${text.slice(0, ERROR_BODY_SNIPPET_LENGTH)}`,
    { adapterName: "telnyx" }
  );
}

/**
 * Creates a Telnyx Call Control REST client. Every action method `POST`s
 * `${apiBaseUrl}/v2/calls/{callControlId}/actions/{command}` with a Bearer
 * token and JSON body; `createCall` places a brand new outbound call via
 * `POST ${apiBaseUrl}/v2/calls`. A non-2xx response anywhere throws
 * `AdapterError` with the status and a truncated body snippet.
 */
export function createTelnyxCommandClient(
  options: TelnyxCommandClientOptions
): TelnyxCommandClient {
  return {
    answer: (callControlId, body) =>
      postAction(options, callControlId, "answer", body),
    reject: (callControlId, body) =>
      postAction(options, callControlId, "reject", body),
    transfer: (callControlId, body) =>
      postAction(options, callControlId, "transfer", body),
    speak: (callControlId, body) =>
      postAction(options, callControlId, "speak", body),
    playbackStart: (callControlId, body) =>
      postAction(options, callControlId, "playback_start", body),
    recordStart: (callControlId, body) =>
      postAction(options, callControlId, "record_start", body),
    hangup: (callControlId, body = {}) =>
      postAction(options, callControlId, "hangup", body),
    createCall: async (body) => {
      const response = await fetch(`${options.apiBaseUrl}/v2/calls`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await throwForFailedResponse(response, "Telnyx call creation");
      }
      const json = (await response.json()) as {
        data?: { call_control_id?: unknown };
      };
      const callControlId = json.data?.call_control_id;
      if (typeof callControlId !== "string") {
        throw new AdapterError(
          "Telnyx call creation response is missing a string 'data.call_control_id'",
          { adapterName: "telnyx" }
        );
      }
      return { callId: callControlId };
    },
  };
}
