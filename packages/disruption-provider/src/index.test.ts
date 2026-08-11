import { describe, expect, it, vi } from "vitest";

import { materializeRestrictions, normalizeProviderPayload, PROVIDER_REFRESH_INTERVAL_MS, PROVIDER_VISIBLE_HORIZON_HOURS, PublicInfrastructureRestrictionsClient } from "./index.js";

const validity = [{ vonDatum: "2026-08-10", bisDatum: "2026-08-12", wochentage: ["MONTAG", "DIENSTAG", "MITTWOCH"], vonUhrzeit: "23:00:00", bisUhrzeit: "01:00:00" }];

function raw() {
  return {
    handshake: {},
    plannedWorks: [
      { baustellenID: "B-1", wirkung: "TOTALSPERRUNG", streckennummern: [6053], ril100Von: "LL", ril100Bis: "UEF", koordinaten: { von: { x: 1.25, y: 2.5 }, bis: { x: 3, y: 4 } }, gueltigkeiten: validity },
      { baustellenID: "B-2", wirkung: "SONSTIGES", streckennummern: [], gueltigkeiten: validity },
    ],
    operationalIncidents: [{ key: "S-1", cause: "Störung am Fahrweg", subcause: "Weichenstörung", text: "", wirkungenMitVerkehrsarten: [{ wirkung: "TEILAUSFALL" }], zeitraum: { beginn: "2026-08-11T10:00:00", ende: "2026-08-11T14:00:00" }, betriebsstellen: [{ ril100: "LL", langname: "Leipzig" }], abschnitte: [], koordinaten: [{ x: 5.5, y: 6.75 }] }],
    scheduledTrafficPauses: [{ streckenruhenId: "R-1", ril100: "UEF", koordinaten: { x: 7, y: 8 }, gueltigkeiten: validity }],
  };
}

describe("realistischer Infrastrukturadapter", () => {
  it("normalisiert nur betriebswirksame Eintraege auf markenfreie 2023-Codes", () => {
    const result = normalizeProviderPayload(raw());
    expect(result.restrictions).toHaveLength(3);
    expect(result.discarded).toEqual([{ sourceRecordId: "B-2", reason: "effectless" }]);
    expect(result.restrictions.find((item) => item.sourceRecordId === "S-1")).toMatchObject({ causeCode: 26, fineCauseId: "switch.drive", effect: "route-deviation" });
    expect(result.restrictions.find((item) => item.sourceRecordId === "B-1")?.location.coordinateMillimetres[0]).toEqual({ x: 1_250, y: 2_500 });
    expect(JSON.stringify(result)).not.toMatch(/Deutsche Bahn|InfraGO/iu);
  });

  it("materialisiert Nachtintervalle in explizite Berliner UTC-Zeitpunkte", () => {
    const normalized = normalizeProviderPayload(raw());
    const intervals = materializeRestrictions(normalized, Date.parse("2026-08-11T00:00:00Z"), Date.parse("2026-08-13T00:00:00Z"));
    const planned = intervals.filter((item) => item.sourceRecordId === "B-1");
    expect(planned).toHaveLength(2);
    expect(new Date(planned[0]!.startsAtMs).toISOString()).toBe("2026-08-11T21:00:00.000Z");
    expect(new Date(planned[0]!.endsAtMs).toISOString()).toBe("2026-08-11T23:00:00.000Z");
  });

  it("holt nach dem Revisionshandshake alle drei Feeds und hasht kanonisch", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      const payload = url.endsWith("/baustellen") ? raw().plannedWorks : url.endsWith("/stoerungen") ? raw().operationalIncidents : raw().scheduledTrafficPauses;
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new PublicInfrastructureRestrictionsClient({
      fetch: fetchMock as typeof fetch,
      readRevision: async () => ({ revision: 7, sourceVersion: "2.28.0", plannedDataTimestamp: "2026-08-07T15:23:59", unplannedDataTimestamp: "2026-08-11T16:34:25", raw: { type: "HANDSHAKE", revision: 7 } }),
    });
    const first = await client.fetchSnapshot(new Date("2026-08-11T15:00:00Z"));
    const second = await client.fetchSnapshot(new Date("2026-08-11T15:30:00Z"));
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.restrictions).toHaveLength(3);
    expect(PROVIDER_REFRESH_INTERVAL_MS).toBe(1_800_000);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { filter: { zeitraum: { stunden: number } } };
    expect(request.filter.zeitraum.stunden).toBe(PROVIDER_VISIBLE_HORIZON_HOURS);
    expect(PROVIDER_VISIBLE_HORIZON_HOURS).toBe(360);
  });
});
