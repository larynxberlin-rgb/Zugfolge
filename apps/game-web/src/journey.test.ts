import { describe, expect, it } from "vitest";

import { renderJourney } from "./journey.js";

describe("Phase-2-Spielerreise", () => {
  it("zeigt alle fünf Tutorialkapitel, Belegstatus und Reset redundant als Text", () => {
    const html = renderJourney({
      tutorialWorldId: "tutorial-world",
      publicWorldId: "public-world",
      busy: false,
      message: "",
      tutorial: {
        chapter: 3,
        chapterState: "in-progress",
        evidence: {
          "1": { completed: true, references: ["tender-1"] },
          "2": { completed: true, references: ["lease-1"] },
          "3": { completed: false, references: [] },
        },
        explanation: "Trassenbeleg fehlt.",
        explanationCode: "tutorial.path.missing",
        resetCount: 1,
        chapters: [
          { chapter: 1, code: "first-tender", title: "Erste Ausschreibung", goal: "Gebot" },
          { chapter: 2, code: "lease-vehicle", title: "Fahrzeug leasen", goal: "Miete" },
          { chapter: 3, code: "request-path", title: "Trasse beantragen", goal: "Trasse" },
          { chapter: 4, code: "operating-program", title: "Betriebsprogramm erstellen", goal: "Programm" },
          { chapter: 5, code: "handle-disruption", title: "Erste Störung bewältigen", goal: "Dispo" },
        ],
      },
      heatmap: [],
      assistant: undefined,
      grant: undefined,
    });
    expect(html.match(/data-tutorial-chapter=/g)).toHaveLength(5);
    expect(html).toContain("Erledigt");
    expect(html).toContain("Aktiv");
    expect(html).toContain("Tutorial zurücksetzen");
    expect(html).toContain("Beschleunigt nur in der getrennten Tutorialwelt");
  });

  it("kombiniert Heatmapmuster, Zustandswort und blockierende Assistentenwarnung", () => {
    const html = renderJourney({
      tutorialWorldId: "",
      publicWorldId: "public-world",
      busy: false,
      message: "",
      tutorial: undefined,
      grant: undefined,
      heatmap: [{
        resourceId: "block-a",
        intervalStartS: 0,
        intervalEndS: 100,
        usedSeconds: 95,
        capacitySeconds: 100,
        qualityClass: "A",
        orderable: true,
        utilizationBasisPoints: 9_500,
        stateLabel: "nahezu belegt",
        pattern: "dense-dots",
      }],
      assistant: {
        ready: false,
        facts: { pathConfirmed: false },
        warnings: [{ code: "path-missing", severity: "blocking", message: "Keine bestätigte Trasse." }],
      },
    });
    expect(html).toContain("dense-dots");
    expect(html).toContain("nahezu belegt");
    expect(html).toContain("Blockierend");
    expect(html).toContain("Keine bestätigte Trasse.");
  });
});
