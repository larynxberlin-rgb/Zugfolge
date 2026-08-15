import { describe, expect, it, vi } from "vitest";

import {
  bindCooperationSurface,
  contractSubjectFromFields,
  formatCents,
  MAX_RENDERED_COOPERATION_ITEMS,
  mergeBoundedItems,
  parseContractOfferFields,
  parseEuroCents,
  renderCooperationSurface,
  type CooperationSurfaceState,
} from "./cooperation.js";

const SELLER = "11111111-1111-4111-8111-111111111111";
const BUYER = "22222222-2222-4222-8222-222222222222";

function state(overrides: Partial<CooperationSurfaceState> = {}): CooperationSurfaceState {
  return {
    worldId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    worldName: "Mitteldeutschland",
    activeOperatorId: SELLER,
    operators: [
      { id: SELLER, worldId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Saale-Bahn" },
      { id: BUYER, worldId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Elster-Verkehr" },
    ],
    ownOperatorIds: [SELLER],
    contracts: [],
    listings: [],
    ownedVehicles: [],
    resources: {
      schemaVersion: "zugfolge-cooperation-resource-catalog/v1",
      worldId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operatorId: SELLER,
      fleetRevision: 7,
      fleetSnapshotHash: "f".repeat(64),
      trainRuns: [{ id: "run-internal", label: "RE 12 nach Halle Hbf", detail: "Regionalzug · geplant · Saale-Bahn" }],
      connectionTrainRuns: [{ id: "connection-internal", label: "S 5 nach Leipzig Hbf", detail: "Regionalzug · fährt · Elster-Verkehr" }],
      formations: [{ id: "formation-internal", label: "Formation für RE 12", detail: "2 Fahrzeuge · Trasse bestätigt" }],
      personnelDuties: [{ id: "duty-internal", label: "Personaldienst für 1 Formation", detail: "für 1 Betriebstag gültig" }],
      pathReceipts: [{ id: "path-internal", label: "Trasse RE 12", detail: "bestätigt · für 1 Betriebstag gültig" }],
      disruptions: [{ id: "disruption-internal", label: "Weichenstörung", detail: "Sperrung · Leipzig Hbf" }],
      rentableVehicles: [{ id: "rental-internal", label: "Baureihe 442", detail: "92 % Zustand · unbelastetes Eigentum" }],
      assistanceVehicles: [{ id: "assistance-internal", label: "Baureihe 463", detail: "88 % Zustand · im Besitz" }],
    },
    contractType: "traction",
    marketQuery: "",
    contractPageView: "actionable",
    listingPageView: "actionable",
    contractNextCursor: null,
    listingNextCursor: null,
    atS: 100,
    busy: false,
    ...overrides,
  };
}

describe("M12-Spieleroberfläche", () => {
  it("rendert alle vier EVU-Vertragstypen mit Fristen und textlichen Zuständen", () => {
    for (const [contractType, expectedField] of [
      ["traction", "Traktionszugfahrten"],
      ["vehicle-rental", "Mietfahrzeuge"],
      ["connection", "Verbindliche Wartezeit"],
      ["disruption-assistance", "Betroffene Störung"],
    ] as const) {
      const html = renderCooperationSurface(state({ contractType }));
      expect(html).toContain(expectedField);
      expect(html).toContain("Antwort innerhalb");
      expect(html).toContain("Laufzeit");
      expect(html).toContain("Kündigungsfrist");
    }
  });

  it("zeigt Fachlabels in zugänglichen Auswahlen statt Eingabefeldern für interne Kennungen", () => {
    const traction = renderCooperationSurface(state({ contractType: "traction" }));
    expect(traction).toContain("RE 12 nach Halle Hbf");
    expect(traction).toContain("Formation für RE 12");
    expect(traction).toContain("bestätigten Weltstand");
    expect(traction).toContain("für 1 Betriebstag gültig");
    expect(traction).not.toMatch(/T\+\d/);
    expect(traction).not.toContain("Simulationssekunde");
    expect(traction).toContain("Technische Details");
    expect(traction).toContain("Flottenrevision 7");
    expect(traction).toContain('type="checkbox" name="trainRunIds" value="run-internal"');
    expect(traction).not.toContain("komma-separiert");
    expect(traction).not.toContain('type="text" value="run-internal"');

    const connection = renderCooperationSurface(state({ contractType: "connection" }));
    expect(connection).toContain('select name="arrivalTrainRunId"');
    expect(connection).toContain("S 5 nach Leipzig Hbf");
    const assistance = renderCooperationSurface(state({ contractType: "disruption-assistance" }));
    expect(assistance).toContain("Weichenstörung");
    expect(assistance).toContain("Baureihe 463");
    expect(assistance).not.toContain("rental-internal");
    const rental = renderCooperationSurface(state({ contractType: "vehicle-rental" }));
    expect(rental).toContain("Unbelastete eigene Mietfahrzeuge");
    expect(rental).toContain("Baureihe 442");
    expect(rental).not.toContain("assistance-internal");
  });

  it("bietet Annahme, Ablehnung und Vertragsende nur passend zur Rolle und zum Zustand an", () => {
    const html = renderCooperationSurface(state({
      activeOperatorId: BUYER,
      ownOperatorIds: [BUYER],
      contracts: [{
        id: "contract-1", worldId: "world", offerorOperatorId: SELLER, offereeOperatorId: BUYER,
        contractType: "traction", subject: {}, terms: {}, termsHash: "a".repeat(64), priceCents: "125000",
        validFromS: 300, validUntilS: 900, responseDeadlineS: 200, terminationNoticeS: 60,
        status: "offered", offeredAtS: 100, revision: 1,
      }],
    }));
    expect(html).toContain("Angeboten");
    expect(html).toContain('data-contract-response="accept"');
    expect(html).toContain('data-contract-response="reject"');
    expect(html).toContain('id="contract-contract-1" tabindex="-1"');
    expect(html).not.toContain("Vertrag beenden");
  });

  it("rendert Suche, Reservierung, Übergabe, Rückabwicklung und unveränderlichen Lebenslauf", () => {
    const html = renderCooperationSurface(state({
      activeOperatorId: BUYER,
      ownOperatorIds: [BUYER],
      marketQuery: "442",
      listings: [{
        id: "listing-1", worldId: "world", vehicleId: "asset-442-1", offeringOperatorId: SELLER,
        listingType: "sale", priceCents: "90000000", disclosure: {
          classDesignation: "442", conditionBasisPoints: 8700, odometerMetres: "1200000",
          damages: [{ code: "door-2" }], maintenanceDeadlines: [{ kind: "IS-600", dueAtS: 5000 }],
          historyHash: "b".repeat(64),
        }, disclosureHash: "c".repeat(64), listedAtS: 100, expiresAtS: 1000,
        status: "open", revision: 1,
      }],
      selectedVehicleHistory: [{
        id: "history-1", worldId: "world", vehicleId: "asset-442-1", eventType: "registered",
        atS: 0, priorHistoryHash: null, resultingHistoryHash: "b".repeat(64), details: {},
      }],
    }));
    expect(html).toContain("Fahrzeugmarkt durchsuchen");
    expect(html).toContain("87 %");
    expect(html).toContain("door-2");
    expect(html).toContain('data-listing-reserve="listing-1"');
    expect(html).toContain("Unveränderlicher Fahrzeuglebenslauf");
    expect(html).toContain("Registriert");
  });

  it("zeigt Übergabe, Rückabwicklung, Rückzug und reguläres Vertragsende nur als explizite Aktionen", () => {
    const baseListing = {
      worldId: "world", vehicleId: "asset-1", listingType: "sale" as const, priceCents: "100",
      disclosure: { classDesignation: "442" }, disclosureHash: "c".repeat(64), listedAtS: 1,
      expiresAtS: 1000, revision: 2,
    };
    const html = renderCooperationSurface(state({
      activeOperatorId: BUYER,
      ownOperatorIds: [BUYER],
      contracts: [{
        id: "active-contract", worldId: "world", offerorOperatorId: SELLER, offereeOperatorId: BUYER,
        contractType: "connection", subject: {}, terms: {}, termsHash: "a".repeat(64), priceCents: "0",
        validFromS: 1, validUntilS: 1000, responseDeadlineS: 1, terminationNoticeS: 10,
        status: "active", offeredAtS: 0, revision: 2,
      }],
      listings: [
        { ...baseListing, id: "reserved", offeringOperatorId: SELLER, status: "reserved", reservedByOperatorId: BUYER },
        { ...baseListing, id: "transferred", offeringOperatorId: SELLER, status: "transferred", reservedByOperatorId: BUYER },
        { ...baseListing, id: "own", offeringOperatorId: BUYER, status: "open" },
      ],
    }));
    expect(html).toContain("Ordentlich kündigen");
    expect(html).toContain("Betriebstag des belegten Verstoßes");
    expect(html).toContain("Nichterfüllung mit Beleg melden");
    expect(html).toContain('data-listing-transfer="reserved"');
    expect(html).toContain('data-listing-reversal="transferred"');
    expect(html).toContain('id="listing-transferred" tabindex="-1"');
    expect(html).toContain('name="reasonCode"');
    expect(html).toContain("Ausführung nur mit einem zeitlich und fachlich passenden Mangelbeleg");
    expect(html).toContain('data-listing-cancel="own"');
  });

  it("bleibt mit fünfzig Marktangeboten such- und bedienbar", () => {
    const listings = Array.from({ length: 50 }, (_, index) => ({
      id: `listing-${index}`, worldId: "world", vehicleId: `asset-${index}`,
      offeringOperatorId: SELLER, listingType: "sale" as const, priceCents: String(10_000 + index),
      disclosure: { classDesignation: index % 2 === 0 ? "442" : "463", conditionBasisPoints: 8_000 + index },
      disclosureHash: "d".repeat(64), listedAtS: index, expiresAtS: 10_000, status: "open" as const, revision: 1,
    }));
    const html = renderCooperationSurface(state({ activeOperatorId: BUYER, ownOperatorIds: [BUYER], listings, marketQuery: "442" }));
    expect(html).toContain("25 Treffer");
    expect((html.match(/data-listing-reserve=/g) ?? [])).toHaveLength(25);
    expect(html).not.toContain("asset-1</strong>");
  });

  it("verarbeitet Geld ausschließlich als kanonischen Integer-Centstring", () => {
    expect(parseEuroCents("1.250,50")).toBe("125050");
    expect(parseEuroCents("1234,56")).toBe("123456");
    expect(parseEuroCents("1,23")).toBe("123");
    expect(parseEuroCents("0,01")).toBe("1");
    for (const ambiguous of ["1e3", "1.23", "1.2.3,45", "12.34,56", "12,345"]) {
      expect(() => parseEuroCents(ambiguous)).toThrow(/Geldbetrag/);
    }
    for (const input of ["0,00", "1,23", "1234,56", "1.234,56", "9.999.999,99"]) {
      expect(parseEuroCents(formatCents(parseEuroCents(input)).replace(" €", ""))).toBe(parseEuroCents(input));
    }
  });

  it("behält jeden zulässigen Integer-Centbetrag beim deutschen Format-Roundtrip exakt bei", () => {
    const maximum = 9_223_372_036_854_775_807n;
    let generated = 0x9e3779b97f4a7c15n;
    for (let index = 0; index < 10_000; index += 1) {
      generated = (generated * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) & maximum;
      const cents = index === 0 ? 0n : index === 1 ? maximum : generated;
      const displayedEuros = formatCents(cents.toString()).replace(/\s*€$/, "");
      expect(parseEuroCents(displayedEuros)).toBe(cents.toString());
    }
  });

  it("begrenzt den No-Wipe-DOM auch bei 100.000 Historieneinträgen", () => {
    const historical = Array.from({ length: 100_000 }, (_, index) => ({ id: `listing-${index}` }));
    const merged = mergeBoundedItems([], historical);
    expect(merged.items).toHaveLength(MAX_RENDERED_COOPERATION_ITEMS);
    expect(merged.limitReached).toBe(true);
    expect(mergeBoundedItems(merged.items, [{ id: "listing-199" }, { id: "neu" }]).items).toHaveLength(MAX_RENDERED_COOPERATION_ITEMS);
  });

  it("vergleicht Fahrzeuge, Leasing und Trassen ohne Gesamtscore und erklärt Inkompatibilität", () => {
    const base = {
      worldId: "world", offeringOperatorId: SELLER, priceCents: "100", disclosureHash: "c".repeat(64), listedAtS: 1,
      expiresAtS: 1000, status: "open" as const, revision: 2,
    };
    const html = renderCooperationSurface(state({
      activeOperatorId: BUYER, ownOperatorIds: [BUYER],
      listings: [
        { ...base, id: "sale", vehicleId: "asset-1", listingType: "sale", disclosure: { classDesignation: "442", incompatibilities: ["fehlende Streckenzulassung"] } },
        { ...base, id: "lease", vehicleId: "asset-2", listingType: "rental", disclosure: { classDesignation: "463", approvals: ["Strecke LHE"] } },
      ],
      pathAlternatives: [{ id: "path", label: "Trassenlage RE 12", shift: "+2:00 min", compatibility: "Konfliktfrei", provenance: "Serverbestätigter Planungsstand" }],
    }));
    expect(html).toContain("Fahrzeuge, Leasing und Trassen in dieser Welt");
    expect(html).toContain("Nicht kompatibel: fehlende Streckenzulassung");
    expect(html).toContain("Trassenalternative");
    expect(html).toContain("Robustheit");
    expect(html).toContain("Pönalerisiko");
    expect(html).toContain("noch kein Einsatzvertrag gebunden");
    expect(html).toContain("Reserve nicht separat ausgewiesen");
    expect(html).not.toContain("beste Alternative");
  });

  it("zeigt Ausschreibung, Fahrplan, Leerfahrt und Werkstatt als echte Formulare", () => {
    const html = renderCooperationSurface(state({
      tenders: [{ id: "tender-1", lotId: "S5", phase: "open", bidCount: 0, ownBidCount: 0, closesAt: 1_000 }],
      stationOptions: [{ id: "LL", label: "Leipzig Hbf" }, { id: "LH", label: "Halle (Saale) Hbf" }],
    }));
    expect(html).toContain("tender-bid-form");
    expect(html).toContain('data-path-request="schedule"');
    expect(html).toContain('data-path-request="empty-run"');
    expect(html).toContain("Zugnummer wird bei der Planung automatisch und eindeutig vergeben");
    expect(html).not.toContain('name="trainNumber"');
    expect(html).toContain('id="maintenance-form"');
    expect(html).toContain("Leipzig Hbf");
    expect(html).not.toContain("Bald verfügbar");
  });

  it("baut typisierte Leistungsgegenstände statt freiem JSON", () => {
    expect(contractSubjectFromFields("connection", {
      arrivalTrainRunId: "RE-1", onwardTrainRunId: "S-2", maxWaitMinutes: "5",
    })).toEqual({ connections: [{ arrivalTrainRunId: "RE-1", onwardTrainRunId: "S-2", maxWaitSeconds: 300 }] });
    expect(contractSubjectFromFields("disruption-assistance", {
      disruptionId: "disruption-7", trainRunIds: "RE-1, RE-2", vehicleIds: "bus-1",
    })).toEqual({ disruptionId: "disruption-7", trainRunIds: ["RE-1", "RE-2"], vehicleIds: ["bus-1"] });
  });

  it("wandelt sichtbare Dauern deterministisch in serverseitige Weltfenster um", () => {
    expect(parseContractOfferFields("vehicle-rental", {
      offereeOperatorId: BUYER,
      vehicleIds: "asset-1",
      termsSummary: "Miete",
      priceEuros: "1.234,56",
      responseHours: "1",
      startsInHours: "2",
      durationDays: "7",
      terminationMinutes: "60",
    }, 10_000)).toMatchObject({
      responseDeadlineS: 13_600,
      validFromS: 17_200,
      validUntilS: 622_000,
      terminationNoticeS: 3_600,
      priceCents: "123456",
    });
  });

  it("verdrahtet echte Klickziele mit den autoritativen Aktionen", () => {
    const accept = { dataset: { contractId: "contract-1", contractResponse: "accept" }, addEventListener: vi.fn() };
    const reserve = { dataset: { listingReserve: "listing-1", revision: "1" }, addEventListener: vi.fn() };
    const reason = { preventDefault: vi.fn() };
    const reversal = { dataset: { listingReversal: "listing-2" }, addEventListener: vi.fn() };
    const root = {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn((selector: string) => selector === "[data-contract-response]" ? [accept] : selector === "[data-listing-reserve]" ? [reserve] : selector === "[data-listing-reversal]" ? [reversal] : []),
    };
    const actions = { respondToContract: vi.fn(), reserveListing: vi.fn(), reverseListing: vi.fn() };
    bindCooperationSurface(root as never, actions as never);
    const acceptHandler = accept.addEventListener.mock.calls[0]![1] as () => void;
    const reserveHandler = reserve.addEventListener.mock.calls[0]![1] as () => void;
    acceptHandler();
    reserveHandler();
    const reversalHandler = reversal.addEventListener.mock.calls[0]![1] as (event: unknown) => void;
    const originalFormData = globalThis.FormData;
    vi.stubGlobal("FormData", class { get(): string { return "undisclosed-brake-damage"; } });
    reversalHandler(reason);
    vi.stubGlobal("FormData", originalFormData);
    expect(actions.respondToContract).toHaveBeenCalledWith("contract-1", "accept");
    expect(actions.reserveListing).toHaveBeenCalledWith("listing-1", 1);
    expect(actions.reverseListing).toHaveBeenCalledWith("listing-2", "undisclosed-brake-damage");
  });

  it("bindet eine Nichterfüllungsmeldung an den ausgewählten serverseitigen Betriebstag", () => {
    const button = { dataset: { contractNonPerformance: "contract-1" }, addEventListener: vi.fn() };
    const root = {
      querySelector: vi.fn((selector: string) => selector.includes("data-contract-evidence-day") ? { value: "2026-12-13" } : null),
      querySelectorAll: vi.fn((selector: string) => selector === "[data-contract-non-performance]" ? [button] : []),
    };
    const actions = { endContract: vi.fn() };
    bindCooperationSurface(root as never, actions);
    const handler = button.addEventListener.mock.calls[0]![1] as () => void;
    handler();
    expect(actions.endContract).toHaveBeenCalledWith(
      "contract-1",
      true,
      "daily-operation-report/v1:2026-12-13",
    );
  });
});
