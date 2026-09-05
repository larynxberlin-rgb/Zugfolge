
import { describe, expect, it } from "vitest";

import { renderJourney } from "./journey.js";



describe("Spieloberfläche", () => {
  it("rendert nach dem Einstieg eine viewportfüllende Shell mit EVU und verfügbarer Liquidität", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
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

  it("zeigt signierte Weltverträge vergleichbar und verlangt eine ausdrückliche Bestätigung", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      worldContracts: [{
        schemaVersion: "zugfolge-public-world-contract/v1", contractHash: "a".repeat(64), worldId: "public-world", name: "Mitteldeutschland",
        region: { id: "mitteldeutschland-b", name: "Leipzig–Halle–Erfurt", variant: "B" }, noWipe: true, schedulePeriodWeeks: 4,
        duration: { kind: "periods", periodCount: 10 }, timeBasis: { mode: "realtime", accelerationFactor: 1, epoch: "2026-01-01T00:00:00Z", timeZone: "Europe/Berlin" },
        entry: { status: "open", requiresContractConfirmation: true, opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-11-05T00:00:00Z" }, startingCapitalPolicy: { kind: "finite", amountCents: "0" },
        releases: { infra: "b".repeat(64), timetable: "c".repeat(64), fleet: "d".repeat(64), economy: "e".repeat(64) },
      }],
    });
    expect(html).toContain("Dein Einstieg");
    expect(html).not.toContain("Öffentliche Welten vergleichen");
    expect(html).toContain("Leipzig–Halle–Erfurt");
    expect(html).toContain("Bleibt erhalten – keine Neustarts der Welt");
    expect(html).toContain("0,00 €");
    expect(html).toContain('name="confirmed" type="checkbox"');
    expect(html).toContain("Spielstand-Kennung");
    expect(html).toContain("Einstieg");
    expect(html).toContain("Europe/Berlin");
    expect(html).toContain('aria-label="Mitteldeutschland beitreten"');
  });

  it("zeigt fuer ein bestehendes EVU den bestaetigten Weltvertrag ohne erneuten Beitritt", () => {
    const html = renderJourney({
      publicWorldId: "public-world",
      busy: false,
      message: "",
      hasActiveOperator: true,
      worldContracts: [{
        schemaVersion: "zugfolge-public-world-contract/v1", contractHash: "a".repeat(64), worldId: "public-world", name: "Mitteldeutschland",
        region: { id: "mitteldeutschland-b", name: "Leipzig–Halle–Erfurt", variant: "B" }, noWipe: true, schedulePeriodWeeks: 4,
        duration: { kind: "periods", periodCount: 10 }, timeBasis: { mode: "realtime", accelerationFactor: 1, epoch: "2026-01-01T00:00:00Z", timeZone: "Europe/Berlin" },
        entry: { status: "open", requiresContractConfirmation: true, opensAt: "2026-01-01T00:00:00Z", closesAt: "2026-11-05T00:00:00Z" }, startingCapitalPolicy: { kind: "finite", amountCents: "0" },
        releases: { infra: "b".repeat(64), timetable: "c".repeat(64), fleet: "d".repeat(64), economy: "e".repeat(64) },
      }],
    });
    expect(html).toContain("Dein Unternehmen ist in dieser Welt aktiv");
    expect(html).toContain("Dein Unternehmen ist in dieser Welt aktiv");
    expect(html).toContain("DEINE SPIELWELT");
    expect(html).toContain('id="world-contract-title">Deine Welt');
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
      publicWorldId: "public-world", busy: false, message: "",
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
        publicWorldId: "public-world", busy: false, message: "",
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
      confirmation: { title: "Vertrag annehmen?", detail: "Welt public-world, Entgelt 1.234,56 Euro." },
    });
    expect(html).toContain('id="journey-confirmation"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="confirmation-title"');
    expect(html).toContain('id="confirmation-cancel" value="cancel" class="secondary" type="submit" autofocus');
    expect(html).toContain("Bestätigen");
    expect(html).toContain("Abbrechen");
    expect(html).toContain("Welt public-world");
  });

});
