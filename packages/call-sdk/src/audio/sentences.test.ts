import { describe, expect, it } from "vitest";
import { chunkSentences, toSentenceIterable } from "./sentences";

async function* fragments(...parts: string[]): AsyncIterable<string> {
  for (const part of parts) {
    yield part;
  }
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of source) {
    out.push(chunk);
  }
  return out;
}

describe("chunkSentences", () => {
  it("yields nothing for an empty stream", async () => {
    const out = await collect(chunkSentences(fragments()));
    expect(out).toEqual([]);
  });

  it("flushes a single complete sentence from one string", async () => {
    const out = await collect(
      chunkSentences(fragments("This is a long enough sentence."))
    );
    expect(out).toEqual(["This is a long enough sentence."]);
  });

  it("splits text arriving as fragments across a terminator", async () => {
    const out = await collect(
      chunkSentences(
        fragments(
          "This is the first sentence, ",
          "definitely long enough. And here",
          " is a second one that is also long enough."
        )
      )
    );
    expect(out).toEqual([
      "This is the first sentence, definitely long enough.",
      "And here is a second one that is also long enough.",
    ]);
  });

  it("buffers short sentences below minChunkLength until enough text accumulates", async () => {
    const out = await collect(
      chunkSentences(fragments("Hi. ", "There. ", "This one is long enough."), {
        minChunkLength: 20,
      })
    );
    // "Hi." (3 chars) and "Hi. There." (10 chars) are both below the
    // minimum, so they fold together with the next sentence until the
    // combined chunk clears 20 chars.
    expect(out).toEqual(["Hi. There. This one is long enough."]);
  });

  it("always flushes the remainder at stream end even if below minChunkLength", async () => {
    const out = await collect(
      chunkSentences(fragments("Hi."), { minChunkLength: 20 })
    );
    expect(out).toEqual(["Hi."]);
  });

  it("always flushes trailing text with no terminator at stream end", async () => {
    const out = await collect(
      chunkSentences(fragments("This sentence never terminates"))
    );
    expect(out).toEqual(["This sentence never terminates"]);
  });

  it("treats a newline as a terminator boundary (no trailing whitespace required)", async () => {
    const out = await collect(
      chunkSentences(
        fragments(
          "First paragraph is long enough right here\nSecond paragraph continues on for a while."
        )
      )
    );
    expect(out).toEqual([
      "First paragraph is long enough right here",
      "Second paragraph continues on for a while.",
    ]);
  });

  it("subjects a newline boundary to the same minChunkLength gate as other terminators", async () => {
    const out = await collect(
      chunkSentences(fragments("Hi\nThere, this continues."))
    );
    // "Hi" (2 chars) is below the default 20-char minimum, so it folds
    // together with what follows rather than being yielded on its own.
    expect(out).toEqual(["Hi\nThere, this continues."]);
  });

  it("does not split on a terminator with no following whitespace (e.g. mid-fragment truncation)", async () => {
    const out = await collect(
      chunkSentences(fragments("The price is 3.5", " dollars, which is a lot."))
    );
    expect(out).toEqual(["The price is 3.5 dollars, which is a lot."]);
  });

  it("handles a terminator immediately followed by a closing quote", async () => {
    const out = await collect(
      chunkSentences(
        fragments('She said "this is long enough to count." Then left.')
      )
    );
    expect(out).toEqual([
      'She said "this is long enough to count."',
      "Then left.",
    ]);
  });

  it("respects a custom minChunkLength", async () => {
    const out = await collect(
      chunkSentences(fragments("Hi. There."), { minChunkLength: 2 })
    );
    expect(out).toEqual(["Hi.", "There."]);
  });
});

describe("toSentenceIterable", () => {
  it("accepts a plain string", async () => {
    const out = await collect(toSentenceIterable("Just one sentence here."));
    expect(out).toEqual(["Just one sentence here."]);
  });

  it("accepts an AsyncIterable<string>", async () => {
    const out = await collect(
      toSentenceIterable(fragments("A long enough single sentence."))
    );
    expect(out).toEqual(["A long enough single sentence."]);
  });

  it("forwards options through to chunkSentences", async () => {
    const out = await collect(
      toSentenceIterable("Hi. There.", { minChunkLength: 2 })
    );
    expect(out).toEqual(["Hi.", "There."]);
  });
});
