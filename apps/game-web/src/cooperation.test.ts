import { describe, expect, it, vi } from "vitest";

import {
  bindCooperationSurface,
  contractSubjectFromFields,
  parseEuroCents,
  renderCooperationSurface,
  type CooperationSurfaceState,
} from "./cooperation.js";

const SELLER = "11111111-1111-4111-8111-111111111111";
const BUYER = "22222222-2222-4222-8222-222222222222";

function state(overrides: Partial<CooperationSurfaceState> = {}): CooperationSurfaceState {
  return {
    worldId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    activeOperatorId: SELLER,
    operators: [
      { id: SELLER, worldId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Saale-Bahn" },
      { id: BUYER, worldId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Elster-Verkehr" },
    ],
    ownOperatorIds: [SELLER],
    contracts: [],
    listings: [],
    ownedVehicles: [],
    contractType: "traction",
    marketQuery: "",
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
      ["disruption-assistance", "Störungskennung"],
    ] as const) {
      const html = renderCooperationSurface(state({ contractType }));
      expect(html).toContain(expectedField);
      expect(html).toContain("Antwortfrist");
      expect(html).toContain("Gültigkeitsende");
      expect(html).toContain("Kündigungsfrist");
    }
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
    expect(html).toContain("8700 / 10000");
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
    expect(html).toContain("Vertrag beenden");
    expect(html).toContain('data-listing-transfer="reserved"');
    expect(html).toContain('data-listing-reverse="transferred"');
    expect(html).toContain("Nicht offengelegten Mangel rückabwickeln");
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
    expect(parseEuroCents("0,01")).toBe("1");
    expect(() => parseEuroCents("1e3")).toThrow(/Geldbetrag/);
    expect(() => parseEuroCents("12,345")).toThrow(/Geldbetrag/);
  });

  it("baut typisierte Leistungsgegenstände statt freiem JSON", () => {
    expect(contractSubjectFromFields("connection", {
      arrivalTrainRunId: "RE-1", onwardTrainRunId: "S-2", maxWaitSeconds: "300",
    })).toEqual({ connections: [{ arrivalTrainRunId: "RE-1", onwardTrainRunId: "S-2", maxWaitSeconds: 300 }] });
    expect(contractSubjectFromFields("disruption-assistance", {
      disruptionId: "disruption-7", trainRunIds: "RE-1, RE-2", vehicleIds: "bus-1",
    })).toEqual({ disruptionId: "disruption-7", trainRunIds: ["RE-1", "RE-2"], vehicleIds: ["bus-1"] });
  });

  it("verdrahtet echte Klickziele mit den autoritativen Aktionen", () => {
    const accept = { dataset: { contractId: "contract-1", contractResponse: "accept" }, addEventListener: vi.fn() };
    const reserve = { dataset: { listingReserve: "listing-1", revision: "1" }, addEventListener: vi.fn() };
    const root = {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn((selector: string) => selector === "[data-contract-response]" ? [accept] : selector === "[data-listing-reserve]" ? [reserve] : []),
    };
    const actions = { respondToContract: vi.fn(), reserveListing: vi.fn() };
    bindCooperationSurface(root as never, actions as never);
    const acceptHandler = accept.addEventListener.mock.calls[0]![1] as () => void;
    const reserveHandler = reserve.addEventListener.mock.calls[0]![1] as () => void;
    acceptHandler();
    reserveHandler();
    expect(actions.respondToContract).toHaveBeenCalledWith("contract-1", "accept");
    expect(actions.reserveListing).toHaveBeenCalledWith("listing-1", 1);
  });
});
