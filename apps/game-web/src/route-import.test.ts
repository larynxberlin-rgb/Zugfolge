import { describe, expect, it, vi } from "vitest";
import { GameApiClient } from "./api.js";
import { parseRouteCatalog, parseTrassenfinderCsv, routeImportMarkup, RouteImportSession, routeMatchesEndpoints, routeViaStationIds, type RouteCatalog } from "./route-import.js";

// Ausschließlich synthetische Betriebsstellen und Exporte.
const catalog: RouteCatalog = {
  worldId: "fixture-world", releaseId: "fixture-release",
  stations: [{ id: "a", code: "AA", name: "Ährenfeld" }, { id: "b", code: "BB X", name: "Bogen; West" }, { id: "c", code: "CC", name: "Zielstadt" }],
  segments: [{ fromStationId: "a", toStationId: "b" }, { fromStationId: "b", toStationId: "c" }],
};
const csv = '"Lfd. km";"Betriebsstelle";"Betriebsstelle (kurz)";"Ankunftszeit";"Haltart"\r\n"0";"Ährenfeld";" aa ";"08:00";"Verkehrshalt"\r\n"10,2";"Bogen; West";"BB X";"08:20";"Verkehrshalt"\r\n"20,5";"Zielstadt";"CC";"08:50";"Verkehrshalt"\r\n';
const encode = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
const file = (text = csv) => ({ size: encode(text).byteLength, arrayBuffer: async () => encode(text) });

describe("Lokaler Trassenfinder-Laufwegimport", () => {
  it("ordnet UTF-8 mit BOM und Semikolon in Feldern vollständig zu, ohne Halte oder Zeiten zu übernehmen", () => {
    const route = parseTrassenfinderCsv(encode(`\uFEFF${csv}`), catalog);
    expect(route).toEqual({ worldId: catalog.worldId, releaseId: catalog.releaseId, stations: catalog.stations });
    expect(routeViaStationIds(route)).toEqual(["b"]);
    expect(JSON.stringify(route)).not.toContain("08:20");
    expect(JSON.stringify(route)).not.toContain("Verkehrshalt");
    expect(routeMatchesEndpoints(route, "a", "c")).toBe(true);
    expect(routeMatchesEndpoints(route, "c", "a")).toBe(false);
  });
  it("liest Windows-1252 einschließlich Umlauten", () => {
    const windows1252 = Uint8Array.from([...csv].map((char) => char.charCodeAt(0))).buffer;
    expect(parseTrassenfinderCsv(windows1252, catalog).stations[0]?.name).toBe("Ährenfeld");
  });
  it("verarbeitet maskierte Anführungszeichen und mehrzeilige Namen", () => {
    const input = csv.replace('"Bogen; West"', '"Bogen ""West""\r\nAbzweig"');
    expect(parseTrassenfinderCsv(encode(input), catalog).stations.map((station) => station.id)).toEqual(["a", "b", "c"]);
  });
  it("erlaubt die Gegenrichtung derselben Spielverbindung", () => {
    const rows = csv.trim().split("\r\n");
    const reverse = [rows[0], ...rows.slice(1).reverse()].join("\n");
    expect(parseTrassenfinderCsv(encode(reverse), catalog).stations.map((station) => station.id)).toEqual(["c", "b", "a"]);
  });
  it.each([
    ["unbekanntes Kürzel", csv.replace('"BB X"', '"UNBEKANNT"'), "nicht eindeutig zugeordnet"],
    ["fehlendes Kürzel", csv.replace('"BB X"', '""'), "fehlen Name oder Kürzel"],
    ["fehlender Name", csv.replace('"Bogen; West"', '""'), "fehlen Name oder Kürzel"],
    ["andere innere Leerzeichen", csv.replace('"BB X"', '"BBX"'), "nicht eindeutig zugeordnet"],
    ["wiederholte Betriebsstelle", csv.replace('"CC"', '"AA"'), "mehrfach"],
    ["falscher Export", csv.replace("Betriebsstelle (kurz)", "Code"), "CSV-Export des Laufwegs"],
    ["offenes Textfeld", `${csv}\"Fehler`, "Textfeld"],
    ["falsche Spaltenzahl", `${csv}\"Fehler\";\"AA\"`, "Spaltenzahl"],
  ])("verwirft %s ohne stilles Auslassen", (_label, input, expected) => {
    expect(() => parseTrassenfinderCsv(encode(input!), catalog)).toThrow(expected);
  });
  it("verwirft Zeichen nach geschlossenen Feldern und doppelte Pflichtspalten", () => {
    expect(() => parseTrassenfinderCsv(encode(csv.replace('" aa "', '"AA"x')), catalog)).toThrow("Anführungszeichen");
    expect(() => parseTrassenfinderCsv(encode(csv.replace('"Ankunftszeit"', '"Betriebsstelle"')), catalog)).toThrow("CSV-Export");
  });
  it("verwirft mehrdeutige Kürzel und unterbrochene Routen", () => {
    expect(() => parseTrassenfinderCsv(encode(csv), { ...catalog, stations: [...catalog.stations, { id: "b2", code: "BB X", name: "Zweiter Bogen" }] })).toThrow("mehrdeutig");
    expect(() => parseTrassenfinderCsv(encode(csv), { ...catalog, segments: catalog.segments.slice(0, 1) })).toThrow("direkte Verbindung");
  });
  it("begrenzt die Dateigröße und Anzahl der Betriebsstellen", () => {
    expect(() => parseTrassenfinderCsv(new ArrayBuffer(1_048_577), catalog)).toThrow("1 MiB");
    expect(() => parseTrassenfinderCsv(new ArrayBuffer(0), catalog)).toThrow("1 MiB");
    const rows = '"Lfd. km";"Betriebsstelle";"Betriebsstelle (kurz)"\n' + Array.from({ length: 513 }, (_, index) => `${index};Punkt ${index};P${index}`).join("\n");
    expect(() => parseTrassenfinderCsv(encode(rows), catalog)).toThrow("512");
  });
  it("prüft Weltbindung, IDs und Verbindungen des Katalogs", () => {
    expect(parseRouteCatalog(catalog, catalog.worldId)).toEqual(catalog);
    expect(() => parseRouteCatalog(catalog, "other-world")).toThrow("Spielwelt");
    expect(() => parseRouteCatalog({ ...catalog, stations: [...catalog.stations, catalog.stations[0]] }, catalog.worldId)).toThrow("Betriebsstellen");
    expect(() => parseRouteCatalog({ ...catalog, segments: [{ fromStationId: "a", toStationId: "missing" }] }, catalog.worldId)).toThrow("Streckenpunkte");
  });
  it("zeigt Vorschau und sichere externe Verlinkung vor der Übernahme", async () => {
    const session = new RouteImportSession("world/operator");
    await session.read(file(), async () => catalog);
    expect(session.applied).toBeUndefined();
    expect(() => session.assertReady()).toThrow("vorgemerkten Fahrweg");
    const markup = routeImportMarkup(session);
    expect(markup).toContain('href="https://trassenfinder.de/" target="_blank" rel="noopener noreferrer"');
    expect(markup).toContain("noch nicht übernommen");
    expect(markup).toContain("3 Betriebsstellen");
    expect(markup).toContain("Fahrweg übernehmen");
    session.apply();
    expect(session.applied?.stations).toEqual(catalog.stations);
    expect(() => session.assertReady()).not.toThrow();
    expect(routeImportMarkup(session)).toContain("Übernommener Fahrweg");
    session.clear("Start wurde geändert");
    expect(session.applied).toBeUndefined();
    expect(session.candidate).toBeUndefined();
  });
  it("übernimmt nach Entfernen oder Kontextwechsel keine verspätete Dateilesung", async () => {
    let resolve!: (value: RouteCatalog) => void;
    const pendingCatalog = new Promise<RouteCatalog>((done) => { resolve = done; });
    const session = new RouteImportSession("world/operator");
    const pending = session.read(file(), () => pendingCatalog);
    session.clear(); resolve(catalog); await pending;
    expect(session.candidate).toBeUndefined();
    expect(session.applied).toBeUndefined();
    expect(session.busy).toBe(false);
  });
  it("verwirft die vorherige Route bei einer neuen ungültigen Datei und liest Übergrößen gar nicht", async () => {
    const session = new RouteImportSession("world/operator");
    await session.read(file(), async () => catalog); session.apply();
    const read = vi.fn(async () => encode(csv)); const load = vi.fn(async () => catalog);
    await session.read({ size: 1_048_577, arrayBuffer: read }, load);
    expect(session.applied).toBeUndefined(); expect(session.error).toContain("1 MiB");
    expect(read).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    expect(() => session.assertReady()).toThrow("Importfehler");
    expect(routeImportMarkup(session)).toContain("Ohne Fahrwegvorgabe fortfahren");
    session.clear("Die Trassenplanung bestimmt den Fahrweg wieder automatisch.");
    expect(() => session.assertReady()).not.toThrow();
  });
  it("bezieht nur den Weltkatalog vom Server und sendet nur Spielkennungen zur Planung", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const api = new GameApiClient("/api", "token", async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(String(url).endsWith("route-catalog") ? catalog : { payload: { trainNumber: 123 } }));
    });
    const imported = parseTrassenfinderCsv(encode(csv), await api.loadRouteCatalog(catalog.worldId));
    await api.submitPlanningPathRequest(catalog.worldId, { schemaVersion: "planning.player-path-request/v2", requestId: "test", formationId: "f", trainCategory: "supplementary", originStationId: "a", destinationStationId: "c", viaStationIds: routeViaStationIds(imported), desiredDepartureS: 300, operatingDays: "daily", stops: [], earlierS: 120, laterS: 300, stepS: 60, extraRunningTimeS: 60, maxOperationalStops: 4 });
    expect(requests[0]).toEqual({ url: "/api/worlds/fixture-world/planning/route-catalog", body: undefined });
    expect(requests[1]?.body).toMatchObject({ viaStationIds: ["b"], stops: [] });
    expect(JSON.stringify(requests)).not.toContain("Bogen");
    expect(JSON.stringify(requests)).not.toContain("Verkehrshalt");
  });
});
