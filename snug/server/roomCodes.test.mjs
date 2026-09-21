import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The room code is the only thing protecting a room that has no passcode,
// so how many there are, and how fast someone can try them, is a security
// property rather than a cosmetic one. These read the real source instead
// of importing it because index.mjs starts a listening server on import.
// Read from the project root rather than import.meta.url: under vitest's
// transform that isn't a file: URL.
const source = readFileSync(path.join(process.cwd(), "server", "index.mjs"), "utf8");

function wordList() {
  const block = /const WORDS = \[(.*?)\];/s.exec(source);
  return block ? [...block[1].matchAll(/"([A-Z]+)"/g)].map((m) => m[1]) : [];
}

describe("room code space", () => {
  it("draws from a word list big enough to matter", () => {
    expect(wordList().length).toBeGreaterThanOrEqual(40);
  });

  it("has no duplicate words, which would quietly shrink the space", () => {
    const words = wordList();
    expect(new Set(words).size).toBe(words.length);
  });

  // 14 words x 2 digits was 1,260 codes — every one of them reachable in
  // well under a minute. Four digits and a longer list is 360,000.
  it("is large enough that guessing isn't a quick job", () => {
    const digits = /Math\.floor\(1000 \+ Math\.random\(\) \* 9000\)/.test(source);
    expect(digits).toBe(true);
    expect(wordList().length * 9000).toBeGreaterThanOrEqual(300_000);
  });

  it("gives up rather than looping forever when the space is crowded", () => {
    // The original was a do/while that spun until it found a free code.
    expect(/do \{[\s\S]*?\} while \(rooms\.has\(code\)\)/.test(source)).toBe(false);
    expect(/for \(let i = 0; i < \d+; i \+= 1\)/.test(source)).toBe(true);
  });
});

describe("join throttling", () => {
  it("caps failed join attempts per connection", () => {
    expect(/JOIN_FAIL_LIMIT\s*=\s*\d+/.test(source)).toBe(true);
    expect(/JOIN_FAIL_WINDOW_MS\s*=\s*[\d_]+/.test(source)).toBe(true);
  });

  it("counts a wrong code as a failure", () => {
    expect(/if \(!room\) \{\s*\n\s*noteFailedJoin/.test(source)).toBe(true);
  });

  it("counts a wrong passcode as a failure too", () => {
    // Otherwise knowing a room's code buys unlimited passcode guesses.
    expect(/if \(attempt\) noteFailedJoin\(socket\.id\);/.test(source)).toBe(true);
  });

  it("refuses further attempts once over the limit", () => {
    expect(/tooManyFailedJoins\(socket\.id\)/.test(source)).toBe(true);
  });

  it("forgets a connection's failures when it disconnects", () => {
    expect(/joinFailures\.delete\(socket\.id\)/.test(source)).toBe(true);
  });
});
