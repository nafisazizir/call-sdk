import { type ModelMessage, streamText } from "ai";
import type { CallEventMap, CallSession, TranscriptEntry } from "call-sdk";
import { printTurnLatency } from "./latency.js";

/**
 * Routed through the Vercel AI Gateway: a plain `provider/model` string tells
 * the AI SDK to resolve the model via the gateway (auth with
 * `AI_GATEWAY_API_KEY`, or Vercel OIDC when deployed), so no provider package
 * is needed.
 */
const MODEL = "openai/gpt-5-nano";

const SYSTEM_PROMPT =
  "You are a friendly phone agent. You are on a live voice call, so keep " +
  "answers short, conversational, and speakable — no lists, no markdown.";

export function toModelMessages(
  transcript: readonly TranscriptEntry[]
): ModelMessage[] {
  return transcript.map((entry) => ({
    role: entry.role === "user" ? ("user" as const) : ("assistant" as const),
    content: entry.text,
  }));
}

/**
 * The default agent: one LLM round-trip per caller turn, streamed straight
 * into TTS. `session.transcript` already contains the turn that triggered
 * this handler, so no extra message assembly is needed.
 */
export async function defaultAgent(
  _turn: CallEventMap["end-of-turn"],
  session: CallSession
): Promise<void> {
  const { textStream } = streamText({
    model: MODEL,
    system: SYSTEM_PROMPT,
    messages: toModelMessages(session.transcript),
    // GPT-5 is a reasoning model; with reasoning left on it "thinks" for
    // 5–6s before the first token — dead air on a live call. `minimal`
    // collapses time-to-first-token to ~860ms with no quality loss for
    // short spoken replies. See src/llm-probe.ts for the measurement.
    providerOptions: { openai: { reasoningEffort: "minimal" } },
  });
  await session.say(textStream);
  // Per-turn latency breakdown — shows which segment is slow. Remove or gate
  // behind an env flag once you've tuned things.
  printTurnLatency(session);
}
