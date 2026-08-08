import { describe, expect, it } from "vitest";
import { badge, escapeHtml, icon } from "./index.js";

describe("Gestaltungssystem", () => {
  it("liefert Icons ohne alleinige Farbbedeutung", () => {
    expect(icon("alert", "Konflikt")).toContain('aria-label="Konflikt"');
    expect(icon("train")).toContain('aria-hidden="true"');
  });
  it("maskiert dynamische Beschriftungen", () => {
    expect(badge("<Gegenzug>", "danger", "alert")).toContain("&lt;Gegenzug&gt;");
    expect(escapeHtml('A & "B"')).toBe("A &amp; &quot;B&quot;");
  });
});
