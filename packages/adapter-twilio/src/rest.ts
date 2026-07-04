/**
 * Twilio REST API — placing outbound calls.
 *
 * `POST /2010-04-01/Accounts/{accountSid}/Calls.json` with inline TwiML
 * (`Twiml=`) rather than a `Url=` callback: the outbound call connects
 * straight to the media stream without a second round trip through a
 * webhook, since we already know the destination media URL up front.
 */

import { AdapterError } from "call-sdk";

export interface StartTwilioCallOptions {
  accountSid: string;
  apiBaseUrl: string;
  authToken: string;
  from: string;
  to: string;
  /** The full `<Response>...</Response>` TwiML body (see `connectStreamTwiml`). */
  twiml: string;
}

/** Response snippet length kept in a REST error message — enough to debug, not enough to be noisy. */
const ERROR_BODY_SNIPPET_LENGTH = 500;

/**
 * Places an outbound call via Twilio's REST API. Resolves with the
 * provider-native call id (`sid`), which becomes the adapter's `callId`.
 */
export async function startTwilioCall(
  opts: StartTwilioCallOptions
): Promise<{ callId: string }> {
  const body = new URLSearchParams({
    To: opts.to,
    From: opts.from,
    Twiml: opts.twiml,
  });
  const credentials = Buffer.from(
    `${opts.accountSid}:${opts.authToken}`
  ).toString("base64");

  const response = await fetch(
    `${opts.apiBaseUrl}/2010-04-01/Accounts/${opts.accountSid}/Calls.json`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new AdapterError(
      `Twilio REST call creation failed (${response.status}): ${text.slice(0, ERROR_BODY_SNIPPET_LENGTH)}`,
      { adapterName: "twilio" }
    );
  }

  const json = (await response.json()) as { sid?: unknown };
  if (typeof json.sid !== "string") {
    throw new AdapterError(
      "Twilio REST call creation response is missing a string 'sid'",
      { adapterName: "twilio" }
    );
  }
  return { callId: json.sid };
}
