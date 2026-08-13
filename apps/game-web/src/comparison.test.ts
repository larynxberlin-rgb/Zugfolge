import { describe, expect, it } from "vitest";

import { renderComparisonWorkbench } from "./comparison.js";

describe("mehrdimensionale Vergleichswerkbank", () => {
  it("hält Dimensionen getrennt und verwendet keinen Gesamtscore", () => {
    const html = renderComparisonWorkbench("Fahrzeugvergleich", { cost: "Kosten", robustness: "Robustheit" }, [
      { id: "a", label: "A", dimensions: { cost: "100 €", robustness: "hoch" } },
      { id: "b", label: "B", dimensions: { cost: "80 €", robustness: "mittel" } },
    ]);
    expect(html).toContain("Vergleich ohne Gesamtscore");
    expect(html).toContain("Robustheit");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toContain("mit den Pfeiltasten horizontal bewegen");
    expect(html).toContain("Fahrzeugvergleich · kein Gesamtscore");
    expect(html).not.toContain("beste Alternative");
  });
});
