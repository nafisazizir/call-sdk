/**
 * Splits streamed LLM response text into sentence-ish chunks suitable for
 * feeding a TTS stage incrementally, instead of waiting for the entire
 * response before synthesizing anything.
 *
 * A chunk is only yielded once it has BOTH hit a sentence terminator
 * (`.`, `!`, `?`, optionally followed by a closing quote/paren, followed by
 * whitespace or end-of-stream) AND reached `minChunkLength` characters —
 * this avoids TTS-ing a fragment like "Hi." in isolation when more text is
 * already on its way. If a terminator is reached before the minimum, the
 * chunker keeps buffering and looks for the *next* terminator, folding
 * multiple short sentences together. A newline is treated as an additional
 * terminator type alongside `.`/`!`/`?` (useful for e.g. list items) —
 * unlike punctuation it doesn't require trailing whitespace to count as a
 * boundary, but it's still subject to the same minimum-length gate as any
 * other terminator. The remaining buffer is always flushed once the source
 * ends, regardless of length.
 *
 * Explicitly out of scope for v1: abbreviation handling (e.g. "Dr.", "e.g.",
 * "3.5"). This is a terminator + minimum-length heuristic, not an NLP
 * sentence splitter — a period followed by whitespace is always treated as
 * a sentence end. Decimals like "3.5" are unaffected only because there's
 * no whitespace between the digits.
 */

const DEFAULT_MIN_CHUNK_LENGTH = 20;
const CLOSING_CHARS = new Set(['"', "'", ")"]);
const WHITESPACE_RE = /\s/;

export interface ChunkSentencesOptions {
  /** Minimum chunk length (chars, after trimming) before a chunk is emitted. Defaults to 20. */
  minChunkLength?: number;
}

interface TerminatorMatch {
  /** End index (exclusive) of what should be consumed from the buffer, including trailing whitespace. */
  consumedEnd: number;
  /** End index (exclusive) of the sentence content, i.e. including the terminator. */
  contentEnd: number;
}

function findTerminator(text: string, from: number): TerminatorMatch | null {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      return { contentEnd: i, consumedEnd: i + 1 };
    }
    if (ch === "." || ch === "!" || ch === "?") {
      let j = i + 1;
      if (j < text.length && CLOSING_CHARS.has(text[j])) {
        j++;
      }
      if (j >= text.length) {
        // Could be mid-stream truncation ("...more text incoming"); we
        // can't yet tell whether this is really the end of the sentence,
        // so don't match — wait for more input (or the final flush).
        continue;
      }
      if (WHITESPACE_RE.test(text[j])) {
        return { contentEnd: j, consumedEnd: j + 1 };
      }
    }
  }
  return null;
}

/**
 * Accumulates a streamed source of text fragments and yields sentence-sized
 * chunks. See module docs for the exact buffering rule.
 */
export async function* chunkSentences(
  source: AsyncIterable<string>,
  opts: ChunkSentencesOptions = {}
): AsyncIterable<string> {
  const minChunkLength = opts.minChunkLength ?? DEFAULT_MIN_CHUNK_LENGTH;
  let buffer = "";

  for await (const piece of source) {
    buffer += piece;
    let searchFrom = 0;
    let match = findTerminator(buffer, searchFrom);
    while (match) {
      const candidate = buffer.slice(0, match.contentEnd).trim();
      if (candidate.length >= minChunkLength) {
        yield candidate;
        buffer = buffer.slice(match.consumedEnd);
        searchFrom = 0;
      } else {
        searchFrom = match.consumedEnd;
      }
      match = findTerminator(buffer, searchFrom);
    }
  }

  const remainder = buffer.trim();
  if (remainder.length > 0) {
    yield remainder;
  }
}

async function* singleValueIterable(value: string): AsyncIterable<string> {
  yield value;
}

/**
 * Convenience overload of {@link chunkSentences} that also accepts a plain
 * `string` (treated as a single, already-complete fragment).
 */
export function toSentenceIterable(
  text: string | AsyncIterable<string>,
  opts: ChunkSentencesOptions = {}
): AsyncIterable<string> {
  const source = typeof text === "string" ? singleValueIterable(text) : text;
  return chunkSentences(source, opts);
}
