import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSingleByteRange } from "./static-range.mjs";

describe("static artifact byte ranges", () => {
  it("parses PMTiles header, open and suffix ranges", () => {
    assert.deepEqual(parseSingleByteRange("bytes=0-126", 1_000), { start: 0, end: 126 });
    assert.deepEqual(parseSingleByteRange("bytes=900-", 1_000), { start: 900, end: 999 });
    assert.deepEqual(parseSingleByteRange("bytes=-100", 1_000), { start: 900, end: 999 });
  });

  it("rejects multiple, inverted and out-of-bounds ranges", () => {
    assert.equal(parseSingleByteRange("bytes=0-1,4-5", 1_000), null);
    assert.equal(parseSingleByteRange("bytes=20-10", 1_000), null);
    assert.equal(parseSingleByteRange("bytes=1000-", 1_000), null);
  });
});
