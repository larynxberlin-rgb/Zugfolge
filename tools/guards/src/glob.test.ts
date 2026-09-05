import { describe, expect, it } from "vitest";

import { compileGlobs, globToRegExp } from "./glob.js";

describe("globToRegExp", () => {
  it("verankert das Muster an beiden Enden", () => {
    expect(globToRegExp("a/b").test("a/b")).toBe(true);
    expect(globToRegExp("a/b").test("x/a/b")).toBe(false);
    expect(globToRegExp("a/b").test("a/bc")).toBe(false);
  });

  it("lässt * nicht über Verzeichnisgrenzen laufen", () => {
    expect(globToRegExp("crates/*").test("crates/kern")).toBe(true);
    expect(globToRegExp("crates/*").test("crates/kern/src")).toBe(false);
  });

  it("lässt ** über Verzeichnisgrenzen laufen", () => {
    const muster = globToRegExp("crates/zugfolge-sim/**");
    expect(muster.test("crates/zugfolge-sim/src/lib.rs")).toBe(true);
    expect(muster.test("crates/zugfolge-planner/src/lib.rs")).toBe(false);
  });

  it("trifft mit **/ auch die Wurzel", () => {
    const muster = globToRegExp("**/node_modules");
    expect(muster.test("node_modules")).toBe(true);
    expect(muster.test("tools/guards/node_modules")).toBe(true);
    expect(muster.test("tools/node_modules_alt")).toBe(false);
  });

  it("behandelt Punkte als Zeichen, nicht als Platzhalter", () => {
    expect(globToRegExp("Cargo.lock").test("CargoXlock")).toBe(false);
  });

  it("kennt ?", () => {
    expect(globToRegExp("v?.md").test("v1.md")).toBe(true);
    expect(globToRegExp("v?.md").test("v10.md")).toBe(false);
  });
});

describe("compileGlobs", () => {
  it("prüft gegen mehrere Muster", () => {
    const trifft = compileGlobs(["src/**", "docs/*.md"]);
    expect(trifft("docs/glossar.md")).toBe(true);
    expect(trifft("src/main.ts")).toBe(true);
    expect(trifft("other/main.ts")).toBe(false);
    expect(trifft("docs/glossar.md")).toBe(true);
    expect(compileGlobs([])("docs/glossar.md")).toBe(false);
  });

  it("hält die Musterauswahl je Prüfung unabhängig", () => {
    const muster = ["src/**"];
    const ersterLauf = compileGlobs(muster);
    muster.push("docs/**");
    const zweiterLauf = compileGlobs(muster);
    expect(ersterLauf("docs/glossar.md")).toBe(false);
    expect(zweiterLauf("docs/glossar.md")).toBe(true);
  });
});
