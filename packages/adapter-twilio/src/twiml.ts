/**
 * TwiML generation.
 *
 * The adapter's only outbound TwiML shape is `<Connect><Stream>`, which
 * hands the call off to a bidirectional Media Stream — the raw-audio layer
 * this adapter is built on (SPEC.md, Design Decisions). Caller metadata
 * (`from`/`to`/`direction`) rides along as `<Parameter>` children because
 * Twilio's `start` media message does not otherwise carry it; the adapter
 * reads it back from `start.customParameters`.
 */

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escapes the characters that are unsafe inside a double-quoted XML attribute value. */
function escapeXmlAttr(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

/**
 * Builds the `<Response><Connect><Stream>...</Stream></Connect></Response>`
 * TwiML that hands an inbound (or outbound) call off to the media plane.
 * `parameters` become `<Parameter name="..." value="..."/>` children, in
 * insertion order, with both name and value XML-escaped.
 */
export function connectStreamTwiml(
  mediaUrl: string,
  parameters?: Record<string, string>
): string {
  const paramTags = Object.entries(parameters ?? {})
    .map(
      ([name, value]) =>
        `<Parameter name="${escapeXmlAttr(name)}" value="${escapeXmlAttr(value)}"/>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXmlAttr(
    mediaUrl
  )}">${paramTags}</Stream></Connect></Response>`;
}
