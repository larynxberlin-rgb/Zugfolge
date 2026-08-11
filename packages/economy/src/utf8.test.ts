import { describe, expect, it } from "vitest";

import { compareUtf8 } from "./utf8.js";

describe("compareUtf8", () => {
  it("uses the same byte order as Rust for non-ASCII identifiers", () => {
    expect(["ä", "z"].sort(compareUtf8)).toEqual(["z", "ä"]);
  });
});
