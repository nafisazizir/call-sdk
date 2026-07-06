/**
 * Isolates the `llm-first-sentence` bottleneck: measures time-to-first-token
 * (TTFT) and time-to-first-complete-sentence for the agent's model under
 * different reasoning-effort settings, so we can pick the fastest config
 * WITHOUT placing a phone call. Run: pnpm tsx --env-file-if-exists=.env src/llm-probe.ts
 */
import { type ModelMessage, streamText } from "ai";

const MODEL = "openai/gpt-5-nano";
const SYSTEM =
  "You are a friendly phone agent. You are on a live voice call, so keep " +
  "answers short, conversational, and speakable — no lists, no markdown.";
const MESSAGES: ModelMessage[] = [
  { role: "user", content: "Hey, what's the weather like where you are today?" },
];

// `undefined` = provider default (reasoning on); the rest force it down.
const EFFORTS: Array<string | undefined> = [undefined, "minimal", "low"];

const SENTENCE_END = /[.!?]\s|[.!?]$/;

async function probe(effort: string | undefined): Promise<void> {
  const start = performance.now();
  let firstTokenAt: number | undefined;
  let firstSentenceAt: number | undefined;
  let acc = "";

  const { textStream } = streamText({
    model: MODEL,
    system: SYSTEM,
    messages: MESSAGES,
    ...(effort
      ? { providerOptions: { openai: { reasoningEffort: effort } } }
      : {}),
  });

  for await (const delta of textStream) {
    if (firstTokenAt === undefined) firstTokenAt = performance.now() - start;
    acc += delta;
    if (firstSentenceAt === undefined && SENTENCE_END.test(acc)) {
      firstSentenceAt = performance.now() - start;
    }
  }

  const label = (effort ?? "default").padEnd(8);
  const ttft = firstTokenAt === undefined ? "—" : `${Math.round(firstTokenAt)}ms`;
  const sent =
    firstSentenceAt === undefined ? "—" : `${Math.round(firstSentenceAt)}ms`;
  console.log(
    `  reasoning=${label}  ttft=${ttft.padStart(7)}  first-sentence=${sent.padStart(7)}  | "${firstSentence(acc)}"`
  );
}

function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?]/);
  return (m ? m[0] : text).slice(0, 60);
}

console.log(`LLM probe: ${MODEL}`);
for (const effort of EFFORTS) {
  // Two runs each — the first call to a route pays cold-start; the second is
  // closer to steady-state (matches the decreasing trend across call turns).
  for (let i = 0; i < 2; i++) {
    try {
      await probe(effort);
    } catch (err) {
      console.log(
        `  reasoning=${(effort ?? "default").padEnd(8)}  ERROR: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      break;
    }
  }
}
