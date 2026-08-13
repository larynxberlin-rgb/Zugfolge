import { describe, expect, it } from "vitest";

import { formatGermanStartingCapital, loadJourneySurfaces, renderJourney } from "./journey.js";

describe("Phase-2-Spielerreise", () => {
  it("behaelt die oeffentliche Policy und Heatmap, wenn nur die Tutorialwelt ausfaellt", async () => {
    const loaded = await loadJourneySurfaces(
      async () => ({
        heatmap: [{
          resourceId: "block-1",
          intervalStartS: 0,
          intervalEndS: 3_600,
          usedSeconds: 1_800,
          capacitySeconds: 3_600,
          qualityClass: "B",
          orderable: true,
          utilizationBasisPoints: 5_000,
          stateLabel: "Verfuegbar",
          pattern: "none",
        }],
        startingCapital: { mode: "finite", amountCents: "0" },
      }),
      async () => { throw new Error("Tutorialwelt nicht erreichbar"); },
    );

    expect(loaded.publicSurface).toEqual({
      heatmap: [{
        resourceId: "block-1",
        intervalStartS: 0,
        intervalEndS: 3_600,
        usedSeconds: 1_800,
        capacitySeconds: 3_600,
        qualityClass: "B",
        orderable: true,
        utilizationBasisPoints: 5_000,
        stateLabel: "Verfuegbar",
        pattern: "none",
      }],
      startingCapital: { mode: "finite", amountCents: "0" },
    });
    expect(loaded.tutorialSurface).toBeUndefined();
    expect(loaded.failures).toEqual(["Tutorialwelt nicht erreichbar"]);
  });
  it("zeigt alle fünf Tutorialkapitel, Belegstatus und Reset redundant als Text", () => {
    const html = renderJourney({
      tutorialWorldId: "tutorial-world",
      publicWorldId: "public-world",
      busy: false,
      message: "",
      livemapUrl: "https://map.example/?world=public-world",
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
      tutorialAssistant: undefined,
      tutorialGrant: undefined,
      publicStartingCapital: { mode: "finite", amountCents: "0" },
    });
    expect(html.match(/data-tutorial-chapter=/g)).toHaveLength(5);
    expect(html).toContain("Erledigt");
    expect(html).toContain("Aktiv");
    expect(html).toContain("Tutorial zurücksetzen");
    expect(html).toContain("Beschleunigt nur in der getrennten Tutorialwelt");
    expect(html).toContain("Zur Live-Lage");
    expect(html.match(/id="claim-start-package"/g)).toHaveLength(1);
    expect(html).toContain("Tutorial-Startpaket beanspruchen");
    expect(html).toContain("Kein Startpaket:");
    expect(html).toContain("kein Vertrag, kein Fahrzeug, keine Trasse, kein Personal und kein Betriebsprogramm");
    expect(html).toContain("0,00 €");
  });

  it("kombiniert die öffentliche Heatmap mit dem regulären Einstieg ohne Paket oder Assistent", () => {
    const html = renderJourney({
      tutorialWorldId: "",
      publicWorldId: "public-world",
      busy: false,
      message: "",
      tutorial: undefined,
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
      publicStartingCapital: { mode: "finite", amountCents: "1000000" },
    });
    expect(html).toContain("dense-dots");
    expect(html).toContain("nahezu belegt");
    expect(html).toContain("10.000,00 €");
    expect(html).not.toContain("Startpaket verbindlich beanspruchen");
    expect(html).not.toContain("Betriebsassistent wartet auf den Weltzustand");
  });

  it("zeigt Paketbeleg und Assistentenwarnung ausschließlich in der Tutorialkarte", () => {
    const html = renderJourney({
      tutorialWorldId: "tutorial-world",
      publicWorldId: "public-world",
      busy: false,
      message: "",
      tutorial: {
        chapter: 1,
        chapterState: "in-progress",
        evidence: {},
        explanation: "Das Tutorial läuft.",
        explanationCode: "tutorial.running",
        resetCount: 0,
        chapters: [],
      },
      tutorialGrant: {
        idempotentReplay: false,
        grant: {
          id: "grant-1",
          operatorId: "tutorial-operator",
          emergencyLotId: "tutorial-lot",
          vehicleId: "tutorial-vehicle",
          pathReceiptId: "tutorial-path",
          personnelPoolId: "tutorial-personnel",
          operatingProgramId: "tutorial-program",
          expiresAtS: "5000",
        },
      },
      tutorialAssistant: {
        ready: false,
        facts: { pathConfirmed: false },
        warnings: [{ code: "path-missing", severity: "blocking", message: "Keine bestätigte Tutorialtrasse." }],
      },
      publicStartingCapital: { mode: "unlimited" },
      heatmap: [],
    });
    expect(html).toContain("tutorial-operator");
    expect(html).toContain("Blockierend");
    expect(html).toContain("Keine bestätigte Tutorialtrasse.");
    expect(html).toContain("∞");
    expect(html).not.toContain("id=\"claim-start-package\"");
  });
});

describe("formatGermanStartingCapital", () => {
  it("formatiert Null, einen fünfstelligen Eurobetrag und unbegrenzt ohne Number-Konvertierung", () => {
    expect(formatGermanStartingCapital({ mode: "finite", amountCents: "0" })).toBe("0,00 €");
    expect(formatGermanStartingCapital({ mode: "finite", amountCents: "1000000" })).toBe("10.000,00 €");
    expect(formatGermanStartingCapital({ mode: "unlimited" })).toBe("∞");
  });
});
