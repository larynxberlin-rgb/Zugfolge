import { describe, expect, it } from "vitest";
import { parseSpfvCatalog, parseSpfvDraft, parseSpfvPreview, spfvPreviewMarkup, spfvReturnDestination, type SpfvCatalog, type SpfvPreview } from "./spfv.js";
import { GameApiClient } from "./api.js";
const catalog: SpfvCatalog = {schemaVersion: "zugfolge-spfv-catalog/v1", worldId: "fixture-world", operatorId: "fixture-own", periodId: "fixture-period", periodStartS: 0, periodEndS: 172_800, asOfS: 0, releaseId: "fixture-release", defaultHeadwayS: 3_600, stops: [{id: "s1", label: "Start"}, {id: "s2", label: "Ziel"}], formations: [{id: "f1", label: "Beispielverband", seats: 200, firstClassSeats: 20}], lines: []};
const fields = {name: "Neue Linie", headwayMinutes: "60", fareEuro: "29,90", formationId: "f1", firstDay: "1", firstTime: "06:00", lastDay: "1", lastTime: "22:00"};
const preview: SpfvPreview = {schemaVersion: "zugfolge-spfv-preview/v1", worldId: catalog.worldId, operatorId: catalog.operatorId, previewId: "preview-1", source: "forecast", asOfS: 0, releaseId: "fixture-release", requestedPassengers: 100, servedPassengers: 80, unservedPassengers: 20, capacity: 200, fareRevenueCents: "239200", costsCents: null, conflicts: ["Begegnung mit RV 7"], connectionEffects: ["Anschluss nach Ziel: 8 Minuten Übergang"], confirmationAllowed: false};
describe("Fernverkehrsplanung", () => {
  it("wandelt Eingaben exakt in Cent und Weltsekunden um", () => {
    expect(parseSpfvDraft(fields, ["s1", "s2"], catalog, "t1")).toEqual({name: "Neue Linie", headwayS: 3_600, fareCents: "2990", formationId: "f1", validFromS: 21_600, validUntilS: 79_200, stopIds: ["s1", "s2"], referenceTrainId: "t1"});
  });
  it("verwirft unbekannte Halte, doppelte Halte, Dezimaltakte und Zeitraumverletzungen", () => {
    for (const [overrides, stops] of [[{}, ["s1", "other"]], [{}, ["s1", "s1"]], [{headwayMinutes: "1.5"}, ["s1", "s2"]], [{lastDay: "4"}, ["s1", "s2"]], [{firstTime: "25:00"}, ["s1", "s2"]], [{fareEuro: "-1"}, ["s1", "s2"]]] as const) expect(() => parseSpfvDraft({...fields, ...overrides}, stops, catalog)).toThrow();
  });
  it("zeigt betroffene Fahrt, Kapazität, Komfort, Anschlusswirkung und fehlende Kosten getrennt", () => {
    const html = spfvPreviewMarkup(parseSpfvPreview(preview, catalog.worldId, catalog.operatorId), parseSpfvDraft(fields, ["s1", "s2"], catalog, "t1"), parseSpfvCatalog(catalog, catalog.worldId, catalog.operatorId));
    expect(html).toContain("Fahrpreis je Abschnitt"); expect(html).toContain("t1"); expect(html).toContain("Komfort & Platzarten"); expect(html).toContain("Anschluss nach Ziel"); expect(html).toContain("Betriebskosten im Zeitraum</dt><dd>nicht verfügbar"); expect(html).toContain('type="button" disabled');
    expect(() => parseSpfvPreview(preview, catalog.worldId, "other-company")).toThrow();
  });
  it("behält Karte und Filter beim Rückweg ohne frei vorgegebenes Rücksprungziel", () => {
    const url = new URL(spfvReturnDestination("https://map.test/", "https://game.test/?world=other&operator=own&train=t1&trainScope=own&trainQuery=FV&demand=1&returnUrl=https://evil.test/&code=secret", catalog.worldId));
    expect(url.origin).toBe("https://map.test"); expect(url.searchParams.get("world")).toBe(catalog.worldId); expect(url.searchParams.get("focus")).toBe("train:t1"); expect(url.searchParams.get("trainQuery")).toBe("FV"); expect(url.searchParams.has("returnUrl")).toBe(false); expect(url.searchParams.has("code")).toBe(false);
  });
  it("bestätigt ausschließlich die geprüfte Vorschau mit wiederverwendbarer Kommandokennung", async () => {
    const bodies: unknown[] = [];
    const api = new GameApiClient("/api", "token", async (input, init) => {
      expect(String(input)).toBe("/api/worlds/fixture-world/operators/fixture-own/spfv/confirm");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({lineId: "line-1", status: "submitted", planningRequestIds: ["request-1"]}));
    });
    await api.confirmSpfv(catalog.worldId, catalog.operatorId, "preview-1", "retained-command");
    await api.confirmSpfv(catalog.worldId, catalog.operatorId, "preview-1", "retained-command");
    expect(bodies).toEqual([{previewId: "preview-1", commandId: "retained-command"}, {previewId: "preview-1", commandId: "retained-command"}]);
  });
});
