import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import { GLOSSARY_ENTRIES } from "@zugfolge/glossary";

import type { TutorialSessionView } from "./api.js";
import { renderJourney } from "./journey.js";

const chapters = [
  { chapter: 1, code: "first-tender", title: "Erste Ausschreibung", goal: "Gebot" },
  { chapter: 2, code: "lease-vehicle", title: "Fahrzeug leasen", goal: "Miete" },
  { chapter: 3, code: "request-path", title: "Trasse beantragen", goal: "Trasse" },
  { chapter: 4, code: "operating-program", title: "Betriebsprogramm aktivieren", goal: "Programm" },
  { chapter: 5, code: "handle-disruption", title: "Erste Störung", goal: "Dispo" },
] as const;

function session(chapter = 3): TutorialSessionView {
  return {
    schemaVersion: "zugfolge-tutorial-session/v1",
    reference: "tut_abcdefghijklmnopqrstuvwxyz",
    tutorialWorldId: "7a8d576f-144e-4592-8464-85f7701469c7",
    publicWorldId: "3a25998b-43e3-42bc-8100-5afc9f8f0960",
    lifecycle: "running",
    templateVersion: "tutorial-minimal-2026.1",
    templateHash: "abc",
    currentChapter: chapter,
    progressLabel: `Kapitel ${chapter} von 5`,
    evidence: Object.fromEntries(chapters.map((entry) => [String(entry.chapter), { completed: entry.chapter < chapter, references: entry.chapter < chapter ? [`proof-${entry.chapter}`] : [] }])),
    chapters,
    dialogue: { id: "lutz-path", templateVersion: "tutorial-minimal-2026.1", chapter, trigger: `chapter.${chapter}.started`, speaker: "lutz", text: "Die Gleise sind leider nicht exklusiv reserviert. Bestätigen Sie eine Alternative.", why: "Puffer reduziert Konfliktrisiko.", actionLabel: "Alternativen vergleichen", target: "tutorial-path-options", canDismiss: true },
    presentation: {
      schemaVersion: "zugfolge-tutorial-presentation/v1",
      tender: {
        id: "tutorial-tender",
        priceWeightBasisPoints: 5_000,
        qualityWeightBasisPoints: 5_000,
        penaltyFocus: "punctuality",
        viabilityThresholdCentsPerTrainKm: "1739",
        limits: {
          minimumOrderingFeeCentsPerTrainKm: "100", maximumOrderingFeeCentsPerTrainKm: "1520", defaultOrderingFeeCentsPerTrainKm: "1450",
          minimumPunctualityBasisPoints: 8800, maximumPunctualityBasisPoints: 9800, defaultPunctualityBasisPoints: 9200,
          minimumExtraSeats: 0, maximumExtraSeats: 40, defaultExtraSeats: 12,
        },
      },
      leases: [],
      paths: [
        { id: "path-tight", receiptId: "receipt-tight", label: "Knapp und günstig", desiredDepartureS: 240, bufferSeconds: 45, costCents: "78000", selected: false },
        { id: "path-robust", receiptId: "receipt-robust", label: "Robust mit Puffer", desiredDepartureS: 300, bufferSeconds: 180, costCents: "112000", selected: false },
      ],
      programmes: [{
        id: "connections", label: "Anschlüsse sichern", baseThresholdSeconds: 240,
        selected: chapter >= 5,
        ...(chapter >= 5 ? { effect: { costCents: "55000", qualityBasisPoints: 400, penaltyRiskBasisPoints: -450 } } : {}),
      }],
      programmeRuleEffects: [
        { rule: "hold-connections", label: "Anschlüsse abwarten", effect: { costCents: "55000", qualityBasisPoints: 400, penaltyRiskBasisPoints: -450 } },
        { rule: "prioritize-punctuality", label: "Pünktlichkeit priorisieren", effect: { costCents: "25000", qualityBasisPoints: 250, penaltyRiskBasisPoints: -300 } },
        { rule: "activate-reserve", label: "Reserve aktivieren", effect: { costCents: "55000", qualityBasisPoints: 400, penaltyRiskBasisPoints: -450 } },
      ],
      disruptionOptions: [],
    },
    idleExpiresAt: "2026-08-13T12:30:00.000Z",
    maximumExpiresAt: "2026-08-13T13:00:00.000Z",
    publicWorldUrl: "?world=3a25998b-43e3-42bc-8100-5afc9f8f0960",
  };
}

describe("spielergebundene Tutorialreise", () => {
  it("rendert nach dem Einstieg eine viewportfüllende Shell mit EVU und verfügbarer Liquidität", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      coachDismissed: false,
      whyOpen: false,
      activeSection: "company",
      activeOperatorId: "operator-1",
      livemapUrl: "https://spiel.example/live/?world=public-world",
      operationsCenterUrl: "https://spiel.example/operations/",
      operatorContext: {
        schemaVersion: "zugfolge-operator-context/v1",
        worldId: "public-world",
        operators: [{
          id: "operator-1",
          name: "Saale-Sprinter",
          finance: { mode: "finite", ledgerBalanceCents: "10000", pendingDebitCents: "2500", availableCents: "7500" },
        }],
      },
    });
    expect(html).toContain('class="journey-shell player-shell"');
    expect(html).toContain('class="workspace-scroll" data-scroll-region');
    expect(html).toContain("Saale-Sprinter");
    expect(html).toContain("75,00 €");
    expect(html).toContain("Vorgemerkte Belastungen");
    expect(html).toContain("https://spiel.example/live/?world=public-world&amp;operator=operator-1");
    expect(html).toContain("https://spiel.example/operations/?world=public-world&amp;operator=operator-1&amp;panel=operations");
    expect(html).not.toContain("Geschlossene Alpha · Spielerreise");
  });

  it("zeigt unbegrenzte Liquidität ausdrücklich und nie als Nullsaldo", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      coachDismissed: false,
      whyOpen: false,
      activeSection: "company",
      activeOperatorId: "operator-1",
      operatorContext: {
        schemaVersion: "zugfolge-operator-context/v1",
        worldId: "public-world",
        operators: [{ id: "operator-1", name: "Testbahn", finance: { mode: "unlimited" } }],
      },
    });
    expect(html.match(/Unbegrenzt/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("0,00");
  });

  it("zeigt genau eine Hauptaufgabe, fünf textliche Fortschrittszustände und Lutz zugänglich", () => {
    const html = renderJourney({ publicWorldId: session().publicWorldId, busy: false, message: "", tutorial: session(), coachDismissed: false, whyOpen: false });
    expect(html.match(/class="tutorial-task/g)).toHaveLength(1);
    expect(html.match(/<li aria-current=/g)).toHaveLength(5);
    expect(html).toContain("Erledigt");
    expect(html).toContain("Aktiv");
    expect(html).toContain('alt="Lutz, fiktiver und sichtbar genervter Tutorialbegleiter"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="lutz-name" tabindex="-1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Später erneut anzeigen");
    expect(html).not.toContain("Belege neu prüfen");
    expect(html).not.toContain("tutorial-chapter-1\"");
  });

  it("hält das Coach-Panel wiederöffnbar, ohne die fachliche Hauptaktion zu entfernen", () => {
    const html = renderJourney({ publicWorldId: session().publicWorldId, busy: false, message: "", tutorial: session(), coachDismissed: true, whyOpen: false });
    expect(html).toContain("Lutz wieder anzeigen");
    expect(html).toContain("Trasse verbindlich bestätigen");
    expect(html).toContain("Vergleich ohne Gesamtscore");
    expect(html).toContain("Betrieblicher Puffer");
    expect(html).not.toContain('class="tutorial-coach');
  });

  it("startet ohne statische Tutorialwelt und beschreibt die strikte öffentliche Grenze", () => {
    const html = renderJourney({ publicWorldId: "public-world", busy: false, message: "", tutorial: undefined, coachDismissed: false, whyOpen: false });
    expect(html).toContain("Tutorial mit Lutz starten");
    expect(html).toContain("Nichts davon gelangt in die öffentliche Welt oder in das Verwaltungssystem");
    expect(html).toContain("Keine Startausstattung");
    expect(html).not.toContain("tutorialWorld");
    const knownCodes = new Set(GLOSSARY_ENTRIES.map((entry) => entry.code));
    for (const code of html.matchAll(/data-glossary-code="([^"]+)"/g)) {
      expect(knownCodes.has(code[1]!)).toBe(true);
    }
  });

  it("zeigt signierte Weltverträge vergleichbar und verlangt eine ausdrückliche Bestätigung", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      coachDismissed: false,
      whyOpen: false,
      worldContracts: [{
        schemaVersion: "zugfolge-public-world-contract/v1", contractHash: "a".repeat(64), worldId: "public-world", name: "Mitteldeutschland",
        region: { id: "mitteldeutschland-b", name: "Leipzig–Halle–Erfurt", variant: "B" }, noWipe: true, schedulePeriodWeeks: 4,
        duration: { kind: "periods", periodCount: 10 }, timeBasis: { mode: "realtime", accelerationFactor: 1, epoch: "2026-01-01T00:00:00Z", timeZone: "Europe/Berlin" },
        entry: { status: "open", requiresContractConfirmation: true, opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-11-05T00:00:00Z" }, startingCapitalPolicy: { kind: "finite", amountCents: "0" },
        releases: { infra: "b".repeat(64), timetable: "c".repeat(64), fleet: "d".repeat(64), economy: "e".repeat(64) },
      }],
    });
    expect(html).toContain("Öffentliche Welten vergleichen");
    expect(html).toContain("Leipzig–Halle–Erfurt");
    expect(html).toContain("Dauerhaft, keine Wipes");
    expect(html).toContain("0,00 €");
    expect(html).toContain('name="confirmed" type="checkbox"');
    expect(html).toContain("Weltvertrags-Hash");
    expect(html).toContain("Eintrittsfenster");
    expect(html).toContain("Europe/Berlin");
    expect(html).toContain('aria-label="Mitteldeutschland beitreten"');
  });

  it("zeigt fuer ein bestehendes EVU den bestaetigten Weltvertrag ohne erneuten Beitritt", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      coachDismissed: false,
      whyOpen: false,
      hasActiveOperator: true,
      worldContracts: [{
        schemaVersion: "zugfolge-public-world-contract/v1", contractHash: "a".repeat(64), worldId: "public-world", name: "Mitteldeutschland",
        region: { id: "mitteldeutschland-b", name: "Leipzig–Halle–Erfurt", variant: "B" }, noWipe: true, schedulePeriodWeeks: 4,
        duration: { kind: "periods", periodCount: 10 }, timeBasis: { mode: "realtime", accelerationFactor: 1, epoch: "2026-01-01T00:00:00Z", timeZone: "Europe/Berlin" },
        entry: { status: "open", requiresContractConfirmation: true, opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-11-05T00:00:00Z" }, startingCapitalPolicy: { kind: "finite", amountCents: "0" },
        releases: { infra: "b".repeat(64), timetable: "c".repeat(64), fleet: "d".repeat(64), economy: "e".repeat(64) },
      }],
    });
    expect(html).toContain("Weltvertrag bestätigt");
    expect(html).toContain("Ihr EVU ist in dieser Welt aktiv");
    expect(html).toContain("Weltstatus");
    expect(html).toContain('id="world-contract-title">Aktive Welt');
    expect(html).toContain("1 Weltvertrag");
    expect(html).not.toContain("1 Weltverträge");
    expect(html).not.toContain("Vor dem Eintritt");
    expect(html).not.toContain("Öffentliche Welten vergleichen");
    expect(html).not.toContain("data-world-contract-form");
    expect(html).not.toContain('name="displayName"');
    expect(html).not.toContain('name="confirmed"');
  });

  it("deaktiviert den Eintritt in eine geplante Welt und nennt ihren Startzeitpunkt", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      coachDismissed: false,
      whyOpen: false,
      worldContracts: [{
        schemaVersion: "zugfolge-public-world-contract/v1", contractHash: "a".repeat(64), worldId: "public-world", name: "Geplante Welt",
        region: { id: "mitteldeutschland-b", name: "Leipzig–Halle–Erfurt", variant: "B" }, noWipe: true, schedulePeriodWeeks: 4,
        duration: { kind: "periods", periodCount: 10 }, timeBasis: { mode: "realtime", accelerationFactor: 1, epoch: "2026-08-17T00:00:00Z", timeZone: "Europe/Berlin" },
        entry: { status: "scheduled", requiresContractConfirmation: true, opensAt: "2026-08-17T00:00:00Z", closesAt: null }, startingCapitalPolicy: { kind: "finite", amountCents: "0" },
        releases: { infra: "b".repeat(64), timetable: "c".repeat(64), fleet: "d".repeat(64), economy: "e".repeat(64) },
      }],
    });
    expect(html).toContain("öffnet am");
    expect(html).toContain('type="submit" disabled');
  });

  it("ordnet offene Postfachmeldungen als weltgebundene Aufmerksamkeitsschiene an", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      coachDismissed: false,
      whyOpen: false,
      mailbox: [{
        id: "message-1",
        worldId: "public-world",
        messageType: "cooperation.contract-offer",
        payload: { title: "Antwort auf Fahrzeugmiete erforderlich" },
        sentAt: "2026-08-13T10:00:00.000Z",
        deadlineAt: "2026-08-13T12:00:00.000Z",
        acknowledgedAt: null,
        priority: "due-soon",
        overdue: false,
      }],
    });
    expect(html).toContain('id="postfach"');
    expect(html).toContain("Antwort auf Fahrzeugmiete erforderlich");
    expect(html).toContain('href="?view=journey&amp;world=public-world&amp;contractView=actionable#cooperation-contracts"');
    expect(html).toContain('data-mailbox-ack="message-1"');
    expect(html).toContain("1 offen");
  });

  it("uebernimmt serverautoritative Prioritaet und benennt eine verstrichene Frist als ueberfaellig", () => {
    const html = renderJourney({
      publicWorldId: "public-world", busy: false, message: "", coachDismissed: false, whyOpen: false,
      mailbox: [{
        id: "message-overdue", worldId: "public-world", messageType: "cooperation.contract-offer", payload: {},
        sentAt: "2026-08-11T10:00:00.000Z", deadlineAt: "2026-08-13T10:00:00.000Z", acknowledgedAt: null,
        priority: "overdue", overdue: true,
      }],
    });
    expect(html).toContain('data-priority="overdue"');
    expect(html).toContain('<span class="state-word">Überfällig</span>');
    expect(html).toContain("Überfällig seit");
  });

  it("benennt reale Kooperationsmails und verlinkt terminale Belege ins konkrete Archiv", () => {
    const cases = [
      ["cooperation.contract-offer", "Neues Kooperationsangebot", "contractView=actionable", "contract-vertrag-7"],
      ["cooperation.contract-accepted", "Kooperationsangebot angenommen", "contractView=actionable", "contract-vertrag-7"],
      ["cooperation.contract-rejected", "Kooperationsangebot abgelehnt", "contractView=archive", "contract-vertrag-7"],
      ["cooperation.contract-terminated", "Kooperationsvertrag beendet", "contractView=archive", "contract-vertrag-7"],
      ["cooperation.contract-non-performance", "Nichterfüllung gemeldet", "contractView=archive", "contract-vertrag-7"],
      ["vehicle-market.transferred", "Fahrzeug übergeben", "listingView=archive", "listing-angebot-2"],
      ["vehicle-market.reversed", "Fahrzeugübertragung rückabgewickelt", "listingView=archive", "listing-angebot-2"],
    ] as const;
    for (const [messageType, label, view, hash] of cases) {
      const payload = messageType.startsWith("vehicle") ? { listingId: "angebot-2" } : { contractId: "vertrag-7" };
      const html = renderJourney({
        publicWorldId: "public-world", busy: false, message: "", coachDismissed: false, whyOpen: false,
        mailbox: [{
          id: `mail-${messageType}`, worldId: "public-world", messageType, payload,
          sentAt: "2026-08-13T10:00:00.000Z", deadlineAt: null, acknowledgedAt: null,
          priority: "information", overdue: false,
        }],
      });
      expect(html, messageType).toContain(`<strong>${label}</strong>`);
      expect(html, messageType).toContain(`world=public-world&amp;${view}#${hash}`);
    }
  });

  it("rendert einen zugänglichen Prüfschritt für verbindliche Entscheidungen", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      coachDismissed: false,
      whyOpen: false,
      confirmation: { title: "Vertrag annehmen?", detail: "Welt public-world, Entgelt 1.234,56 Euro." },
    });
    expect(html).toContain('id="journey-confirmation"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="confirmation-title"');
    expect(html).toContain('id="confirmation-cancel" value="cancel" class="secondary" type="submit" autofocus');
    expect(html).toContain("Verbindlich bestätigen");
    expect(html).toContain("Abbrechen");
    expect(html).toContain("Welt public-world");
  });

  it("gibt den Start erst nach abgeschlossener Sitzungspruefung frei", () => {
    const loading = renderJourney({ publicWorldId: "public-world", busy: true, message: "", tutorial: undefined, coachDismissed: false, whyOpen: false });
    const ready = renderJourney({ publicWorldId: "public-world", busy: false, message: "", tutorial: undefined, coachDismissed: false, whyOpen: false });
    expect(loading).toContain('<button disabled aria-disabled="true" id="tutorial-start" class="primary-action" type="button">');
    expect(ready).toContain('id="tutorial-start" class="primary-action" type="button">');
  });

  it("deaktiviert hektische Bewegung und ordnet das Coach-Panel mobil unter die Aufgabe", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/prefers-reduced-motion:reduce/);
    expect(css).toMatch(/\.tutorial-task\{order:1/);
    expect(css).toMatch(/\.tutorial-coach,.coach-reopen\{[^}]*order:2/);
    expect(css).toMatch(/\.tutorial-task,.tutorial-coach,.world-contract-card\{[^}]*overflow-wrap:anywhere;hyphens:auto/);
  });

  it("liefert genau den ausgewaehlten RGBA-PNG-Avatar mit transparenten oberen Ecken", () => {
    const png = readFileSync(new URL("../public/assets/tutorial/lutz-avatar-comic-v2.png", import.meta.url));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const bitDepth = png[24];
    const colourType = png[25];
    expect({ width, height, bitDepth, colourType }).toEqual({ width: 1254, height: 1254, bitDepth: 8, colourType: 6 });
    const chunks: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const kind = png.subarray(offset + 4, offset + 8).toString("ascii");
      if (kind === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    const decoded = inflateSync(Buffer.concat(chunks));
    expect(decoded[0]).toBe(0);
    expect(decoded[4]).toBe(0);
    expect(decoded[width * 4]).toBe(0);
  });

  it("meldet einen Bootfehler als Alarm und bietet keine funktionslose Tutorialaktion an", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "Tutorial konnte nicht geladen werden.",
      messageTone: "error",
      tutorial: undefined,
      coachDismissed: false,
      whyOpen: false,
      tutorialStartAvailable: false,
      bootRecovery: "retry",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('id="tutorial-start"');
    expect(html).toContain("Tutorial mit Lutz starten");
    expect(html).toContain('disabled aria-disabled="true"');
    expect(html).toContain('id="journey-retry"');
    expect(html).toContain("Erneut versuchen");
  });

  it("zeigt im Tutorial verständliche Euro- und Prozentwerte statt Implementierungseinheiten", () => {
    const chapterOne = session(1);
    const html = renderJourney({
      publicWorldId: chapterOne.publicWorldId,
      busy: false,
      message: "",
      tutorial: chapterOne,
      coachDismissed: false,
      whyOpen: false,
    });
    expect(html).toContain('name="orderingFeeEuro"');
    expect(html).toContain('value="14,50"');
    expect(html).toContain('name="punctualityPercent"');
    expect(html).toContain('value="92,00"');
    expect(html).not.toContain('name="punctualityBasisPoints"');
    expect(html).toContain("mindestens 1,00 €");
    expect(html).toContain("höchstens 15,20 €");
    expect(html).toContain("88,00 bis 98,00 Prozent");
    expect(html).toContain("vom Spiel berechnet");
    expect(html).toContain("ohne Gesamtscore");
    expect(html).not.toContain("Das Entgelt bleibt unter");
  });

  it("rendert den mehrdimensionalen Vergleich in der Ergebnisansicht", () => {
    const completed = {
      ...session(5),
      lifecycle: "summary" as const,
      summary: {
        startLiquidityCents: "2000000",
        leasingCostCents: "210000",
        pathAndOperatingCostCents: "768000",
        orderingRevenueCents: "1560000",
        disruptionCostCents: "95000",
        resultCents: "487000",
        punctualityBasisPoints: 9180,
        qualityTargetsMet: ["Pünktlichkeit"],
        comparison: {
          bidOrderingFeeCentsPerTrainKm: "1450", bidPunctualityBasisPoints: 9200, bidExtraSeats: 12,
          leaseLabel: "T442", leaseCostCents: "210000", leaseSeats: 138, leaseReliabilityBasisPoints: 8900,
          pathLabel: "Robust mit Puffer", pathCostCents: "112000", pathBufferSeconds: 180,
          programmeLabel: "Anschlüsse sichern", programmeRuleLabel: "Anschlüsse abwarten", programmeThresholdSeconds: 240,
          programmeCostCents: "55000", programmeQualityBasisPoints: 400, programmePenaltyRiskBasisPoints: -450,
          disruptionLabel: "Umleitung anfordern", disruptionCostCents: "95000", disruptionPunctualityBasisPoints: 9180,
          disruptionCancellations: 0,
        },
      },
    };
    const html = renderJourney({ publicWorldId: completed.publicWorldId, busy: false, message: "", tutorial: completed, coachDismissed: false, whyOpen: false });
    expect(html).toContain("Wirkung Ihrer Entscheidungen");
    expect(html.match(/data-decision=/g)).toHaveLength(5);
    expect(html).toContain("Umleitung anfordern");
    expect(html).toContain("Qualität +4,00 Prozentpunkte");
    expect(html).toContain("Pönalerisiko −4,50 Prozentpunkte");
    expect(html).toContain("Kapazität prüfen");
  });

  it("zeigt die vom Spiel berechnete Programmwirkung statt einer Clientbehauptung", () => {
    const html = renderJourney({ publicWorldId: session(5).publicWorldId, busy: false, message: "", tutorial: session(5), coachDismissed: false, whyOpen: false });
    expect(html).toContain("Wirkung des aktivierten Betriebsprogramms");
    expect(html).toContain("Anschlüsse sichern: 550,00 € Kosten");
    expect(html).toContain("Qualität +4,00 Prozentpunkte");
    expect(html).toContain("Pönalerisiko −4,50 Prozentpunkte");
  });

  it("hält sichtbare Copy frei von ASCII-Umlauten, Milestone-Codes und internen Referenzen", () => {
    const visibleText = (html: string): string => html
      .replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const rendered = [1, 2, 3, 4, 5].map((chapter) => renderJourney({
      publicWorldId: session(chapter).publicWorldId,
      busy: false,
      message: "",
      tutorial: session(chapter),
      coachDismissed: false,
      whyOpen: false,
    })).join(" ");
    const copy = visibleText(rendered);
    expect(copy).not.toMatch(/\b(?:Fuer|Ueberlappung|Aussenlauf|ausgewaehlt|Puenktlichkeit|Kapazitaet|Barrierefreiheit|ausloesen)\b/);
    expect(copy).not.toMatch(/\bM[0-9]+(?:\.[0-9]+)?\b/);
    expect(copy).not.toMatch(/\b(?:Du|Dein|Deine|Deinen|Dir|Dich)\b/);
    expect(copy).not.toContain(session().reference);
  });

  it("deaktiviert alle Aktionen waehrend eines autoritativen Requests", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: true,
      message: "",
      tutorial: session(),
      coachDismissed: false,
      whyOpen: false,
    });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    expect(buttons.every((button) => button.includes('disabled aria-disabled="true"'))).toBe(true);
  });

  it("sperrt bei einer Postfachaktion nur die betroffene Oberfläche", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: true,
      busyScope: "mailbox",
      message: "",
      coachDismissed: false,
      whyOpen: false,
      mailbox: [{ id: "mail-1", worldId: "public-world", messageType: "contract", payload: {}, sentAt: "2026-01-01T00:00:00Z", deadlineAt: null, acknowledgedAt: null, priority: "action-required", overdue: false }],
    });
    expect(html).toContain('<button disabled aria-disabled="true" type="button" class="secondary" data-mailbox-ack="mail-1">');
    expect(html).toContain('<button id="tutorial-start" class="primary-action" type="button">');
  });
});
