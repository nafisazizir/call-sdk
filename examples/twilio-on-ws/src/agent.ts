import { anthropic } from "@ai-sdk/anthropic";
import { type ModelMessage, streamText } from "ai";
import type { CallEventMap, CallSession, TranscriptEntry } from "call-sdk";

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
export async function claudeAgent(
  _turn: CallEventMap["end-of-turn"],
  session: CallSession
): Promise<void> {
  const { textStream } = streamText({
    model: anthropic("claude-opus-4-8"),
    system: SYSTEM_PROMPT,
    messages: toModelMessages(session.transcript),
  });
  await session.say(textStream);
}
