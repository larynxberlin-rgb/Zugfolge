import { describe, expect, it } from "vitest";
import { demandGeoJson, demandOverviewMarkup, demandStationTone, parseDemandOverview, parsePassengerManifest, parseTrainDemand, passengerManifestMarkup, trainDemandMarkup, type DemandOverview, type PassengerManifest, type TrainDemand } from "./demand.js";
import { demandPlanningDestination } from "./navigation.js";
import { LivemapApiClient } from "./api.js";

// Explicit synthetic release fixture, never imported by production boot.
const period = { worldId: "fixture-world", periodId: "fixture-period", periodStartS: 0, periodEndS: 86_400, asOfS: 3_600, source: "forecast" as const, releaseId: "fixture-demand-release" };
const overview: DemandOverview = { ...period, schemaVersion: "zugfolge-demand-overview/v1", items: [{ stationId: "s1", label: "<Station>", requestedPassengers: null, servedPassengers: 0, unservedPassengers: null, latitudeE7: 520_000_000, longitudeE7: 130_000_000 }, { stationId: "s2", label: "Missing", requestedPassengers: null, servedPassengers: null, unservedPassengers: null }], zones: [{zoneId: "z1", label: "Gebiet 1", requestedPassengers: 20, servedPassengers: 0, alternativePassengers: 4, unservedPassengers: 16}], nextCursor: "page:2" };

describe("Nachfrageansichten mit belegten Zeitfenstern", () => {
  it("zeigt geschätzte Stationsklassen und begrenzte Wunschziele auch ohne Einsteiger", () => {
    const model: DemandOverview = { ...overview, source: "assumption", populationBasis: {
      referenceStartDate: "2026-09-07", referenceEndDate: "2026-09-13",
      sources: [{ label: "Freie Quelle", url: "https://example.org/population", license: "CC BY 4.0" }],
    }, items: [{ ...overview.items[0]!, populationDemand: { demandClass: 5, catchmentPopulation: 12000,
      requestedPassengers: 60, topDestinations: [{ stationId: "s2", label: "<Wunschziel>", passengers: 50, referenceConnections: 7 }] } }] };
    const html = demandOverviewMarkup(parseDemandOverview(model, period.worldId));
    expect(html).toContain("Klasse 5/10"); expect(html).toContain("12.000 zugeteilte Einwohner");
    expect(html).toContain("ca. 50"); expect(html).toContain("&lt;Wunschziel&gt;");
    expect(html).toContain("7 Direktfahrten in der Referenzwoche"); expect(html).toContain("Modellannahme");
    expect(() => parseDemandOverview({ ...model, source: "observed" }, period.worldId)).toThrow();
    for (const populationDemand of [
      { ...model.items[0]!.populationDemand, demandClass: 11 },
      { ...model.items[0]!.populationDemand, catchmentPopulation: null },
      { ...model.items[0]!.populationDemand, requestedPassengers: 1 },
      { ...model.items[0]!.populationDemand, topDestinations: Array(6).fill(model.items[0]!.populationDemand!.topDestinations[0]) },
    ]) expect(() => parseDemandOverview({ ...model, items: [{ ...model.items[0], populationDemand }] }, period.worldId)).toThrow();
    expect(() => parseDemandOverview({ ...model, populationBasis: { ...model.populationBasis,
      sources: [{ label: "Unsafe", url: "javascript:alert(1)", license: "CC0" }] } }, period.worldId)).toThrow();
  });
  it("unterscheidet Null, fehlende Stationsdaten und gebietsbezogene offene Reisen", () => {
    const result = parseDemandOverview(overview, period.worldId);
    const html = demandOverviewMarkup(result);
    expect(html).toContain("Prognose"); expect(html).toContain("keine Zeitreihe");
    expect(html).toContain("&lt;Station&gt;"); expect(html).not.toContain("<Station>");
    expect(html).toContain("<td>0</td>"); expect(html).toContain("nicht verfügbar");
    expect(html).toContain("Gebiet 1"); expect(html).toContain("<td>16</td>");
    expect(demandStationTone(result.items[0]!)).toBe("unserved");
    expect(demandStationTone(result.items[1]!)).toBe("unknown");
  });
  it("erfindet keine Geometrie für fehlende Stationen und begrenzt jede Seite", () => {
    expect(demandGeoJson(overview.items).features).toHaveLength(1);
    expect(demandGeoJson(overview.items).features[0]?.geometry.coordinates).toEqual([13, 52]);
    expect(() => parseDemandOverview({...overview, items: Array.from({length: 51}, () => overview.items[0])}, period.worldId)).toThrow();
    expect(() => parseDemandOverview(overview, "another-world")).toThrow();
    expect(() => parseDemandOverview({...overview, periodEndS: 0}, period.worldId)).toThrow();
    expect(() => parseDemandOverview({...overview, items: [{...overview.items[0], servedPassengers: -1}]}, period.worldId)).toThrow();
  });
  it("zeigt nur autoritative Haltzeiten und keine Auslastungsanzeige bei fehlenden Zahlen", () => {
    const data: TrainDemand = {...period, schemaVersion: "zugfolge-train-demand/v1", trainId: "t1", segments: [{fromStationId: "s1", fromStationLabel: "Start", toStationId: "s2", toStationLabel: "Ziel", onboard: null, capacity: 200}], stops: [{stationId: "s1", label: "Start", arrivalS: null, departureS: 3_900}]};
    const html = trainDemandMarkup(parseTrainDemand(data, period.worldId, "t1"));
    expect(html).toContain("Auslastung nicht verfügbar"); expect(html).not.toContain("<meter");
    expect(html).toContain("Ankunft nicht verfügbar"); expect(html).toContain("01:05");
    expect(() => parseTrainDemand(data, period.worldId, "other-train")).toThrow();
  });
  it("hält private Manifestkennungen am exakten Welt-, Unternehmens- und Fahrtkontext", () => {
    const manifest: PassengerManifest = {...period, schemaVersion: "zugfolge-passenger-manifest-view/v1", operatorId: "own", trainId: "t1", items: [{passengerId: "p1", originLabel: "Start", destinationLabel: "Ziel", seatClass: "second", spaceNeeds: ["bicycle"]}], nextCursor: null};
    const html = passengerManifestMarkup(parsePassengerManifest({...manifest, fareFact: "secret", items: [{...manifest.items[0], ticketStatus: "invalid"}]}, period.worldId, "own", "t1"));
    expect(html).toContain("Fahrrad"); expect(html).not.toMatch(/ticketStatus|invalid|secret|fareFact/);
    expect(() => parsePassengerManifest(manifest, period.worldId, "other", "t1")).toThrow();
    const confirmed = passengerManifestMarkup(parsePassengerManifest({ ...manifest, source: "confirmed" }, period.worldId, "own", "t1"));
    expect(confirmed).toContain("Bestätigter Fahrgastbestand");
    expect(confirmed).not.toContain("Prognostizierte Fahrgastkennungen");
  });
  it("trägt Karte, Auswahl und Filter zur Planung weiter, ohne Loginparameter mitzunehmen", () => {
    const url = new URL(demandPlanningDestination("https://game.test/", "https://map.test/?operator=own&focus=train%3At1&trainScope=own&trainQuery=FV&demand=1&code=secret", period.worldId, "t1"));
    expect(url.searchParams.get("view")).toBe("spfv"); expect(url.searchParams.get("trainScope")).toBe("own"); expect(url.searchParams.get("focus")).toBe("train:t1"); expect(url.searchParams.get("code")).toBeNull();
  });
  it("fordert nur eine begrenzte authentifizierte Seite an und validiert die Antwortwelt", async () => {
    const client = new LivemapApiClient("/api", "test-token", (async (input, init) => {
      expect(String(input)).toBe("/api/worlds/fixture-world/demand/overview?limit=50&cursor=page%3A2");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      return new Response(JSON.stringify(overview));
    }) as typeof fetch);
    expect(await client.demandOverview(period.worldId, "page:2")).toEqual(overview);
  });
});
