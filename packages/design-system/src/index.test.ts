import { describe, expect, it } from "vitest";
import { badge, emptyState, escapeHtml, field, icon, type IconName } from "./index.js";
const luminance = (hex: string): number => {
  const channel = (value: string): number => {
    const x = Number.parseInt(value, 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(hex.slice(1, 3)) +
    0.7152 * channel(hex.slice(3, 5)) +
    0.0722 * channel(hex.slice(5, 7))
  );
};
const contrast = (a: string, b: string): number => {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright! + 0.05) / (dark! + 0.05);
};

describe("Gestaltungssystem", () => {
  it("liefert Icons ohne alleinige Farbbedeutung", () => {
    expect(icon("alert", "Konflikt")).toContain('aria-label="Konflikt"');
    expect(icon("alert", "Konflikt")).toContain("<title>Konflikt</title>");
    expect(icon("train")).toContain('aria-hidden="true"');
    expect(icon("train")).not.toContain("<title>");
  });

  it("stellt das gemeinsame achromatische RailIcon-Set vollstaendig bereit", () => {
    const railIcons = [
      "station",
      "platform",
      "workshop",
      "train-suburban",
      "train-regional",
      "train-long-distance",
      "connection",
      "accessible",
      "bicycle",
      "dining",
      "information",
      "disruption",
    ] satisfies readonly IconName[];

    for (const name of railIcons) {
      const markup = icon(name);
      expect(markup).toContain("<svg");
      expect(markup).toContain('stroke');
      expect(markup).not.toMatch(/#[0-9a-f]{3,8}|rgb\(|fill="(?!none)/i);
    }
  });

  it("escaped den zugaenglichen Titel eines RailIcons", () => {
    const markup = icon("information", 'Info <Gleis 7> & "mehr"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Info &lt;Gleis 7&gt; &amp; &quot;mehr&quot;"');
    expect(markup).toContain("<title>Info &lt;Gleis 7&gt; &amp; &quot;mehr&quot;</title>");
  });
  it("maskiert dynamische Beschriftungen", () => {
    expect(badge("<Gegenzug>", "danger", "alert")).toContain(
      "&lt;Gegenzug&gt;",
    );
    expect(escapeHtml('A & "B"')).toBe("A &amp; &quot;B&quot;");
  });
  it("liefert beschriftete Formulare und Leerzustände", () => {
    expect(field("train", "Zug", "<R>", "Nummer")).toContain(
      'aria-describedby="train-help"',
    );
    expect(field("train", "Zug", "<R>")).toContain("&lt;R&gt;");
    expect(emptyState("Keine Konflikte", "Die Trasse ist frei.")).toContain(
      'role="status"',
    );
  });
  it("erfüllt AA für die verbindlichen Textpaare", () => {
    expect(contrast("#f1f3f7", "#090b10")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#b5bdca", "#11141b")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ff8070", "#371d1d")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#78dfcc", "#16302e")).toBeGreaterThanOrEqual(4.5);
  });
});
