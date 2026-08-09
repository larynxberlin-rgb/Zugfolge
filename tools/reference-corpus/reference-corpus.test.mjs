import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  buildReferenceCorpus,
  canonicalJson,
  compareWithModel,
  createUnsignedBundle,
  sha256,
  signBundle,
  verifySignedBundle,
} from "./reference-corpus.mjs";
import { normalizeGtfsTables, parseCsv } from "./gtfs.mjs";

function observations(seconds) {
  return seconds.map((duration, index) => ({
    sourceId: "gtfs-de-rv",
    tripId: `RE-1-${index}`,
    serviceDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
    routeId: "lhe-nord",
    fromEva: "8010205",
    toEva: "8010159",
    direction: "Halle",
    stopPattern: "Leipzig Hbf|Halle Hbf",
    characteristicsId: "regional-electric-v1",
    trainCategory: "RE",
    trainNumber: "1",
    plannedDepartureEpochSeconds: 1_000_000 + index * 86_400,
    plannedArrivalEpochSeconds: 1_000_000 + index * 86_400 + duration,
  }));
}

const input = {
  region: "Leipzig–Halle–Erfurt",
  schedulePeriod: "fixture-2026",
  generatedAt: "2026-08-09T00:00:00.000Z",
  minimumSamples: 5,
  source: {
    id: "gtfs-de-rv",
    sourceLicense: "CC BY 4.0",
    attribution: "Datenquelle: DELFI e.V. / GTFS.DE, bearbeitet durch Zugfolge",
    retrievedAt: "2026-08-09T00:00:00.000Z",
    apiVersion: "GTFS static",
  },
  observations: observations([600, 610, 620, 630, 900]),
};

test("trennt technische P20-Referenz von Median und durch Wartezeit verzerrtem Mittel", () => {
  const corpus = buildReferenceCorpus(input);
  const group = corpus.groups[0];
  assert.equal(group.technicalReferenceSeconds, 600);
  assert.equal(group.timetableMedianSeconds, 620);
  assert.equal(group.timetableMeanSeconds, 672);
});

test("verlangt dieselbe Zugcharakteristik und dokumentiert Fahrplanreserve", () => {
  const corpus = buildReferenceCorpus(input);
  const report = compareWithModel(corpus, Object.assign([
    { groupId: corpus.groups[0].id, characteristicsId: "regional-electric-v1", calculatedSeconds: 615 },
  ], { releaseChecksum: "infra-fixture" }));
  assert.equal(report.passed, true);
  assert.equal(report.comparisons[0].scheduledReserveSeconds, 5);
  assert.throws(
    () => compareWithModel(corpus, Object.assign([
      { groupId: corpus.groups[0].id, characteristicsId: "wrong", calculatedSeconds: 615 },
    ], { releaseChecksum: "infra-fixture" })),
    /Zugcharakteristik/,
  );
});

test("Ed25519-Signatur bindet Korpus, Report und Release-Hash", () => {
  const corpus = buildReferenceCorpus(input);
  const report = compareWithModel(corpus, Object.assign([
    { groupId: corpus.groups[0].id, characteristicsId: "regional-electric-v1", calculatedSeconds: 615 },
  ], { releaseChecksum: "infra-fixture" }));
  const bundle = createUnsignedBundle({
    corpus,
    report,
    releasePath: "pilot.infrarelease",
    releaseSha256: sha256("release"),
    createdAt: "2026-08-09T00:00:00.000Z",
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signBundle(bundle, privateKey);
  assert.deepEqual(verifySignedBundle(signed, publicKey), bundle);
  const tampered = JSON.parse(canonicalJson(signed));
  tampered.bundle.releaseChecksum = "manipuliert";
  assert.throws(() => verifySignedBundle(tampered, publicKey), /ungültig/);
});

test("GTFS paart Halte derselben Fahrt und bindet sie an eine geprüfte Charakteristik", () => {
  const result = normalizeGtfsTables({
    stops: [
      { stop_id: "L", stop_name: "Leipzig Hbf", parent_station: "" },
      { stop_id: "H", stop_name: "Halle (Saale) Hbf", parent_station: "" },
    ],
    routes: [{ route_id: "r", route_short_name: "RE 10", route_long_name: "" }],
    trips: [{ route_id: "r", service_id: "weekday", trip_id: "trip-1", trip_headsign: "Halle", trip_short_name: "10" }],
    stopTimes: [
      { trip_id: "trip-1", stop_id: "L", stop_sequence: "1", arrival_time: "10:00:00", departure_time: "10:00:00" },
      { trip_id: "trip-1", stop_id: "H", stop_sequence: "2", arrival_time: "10:30:00", departure_time: "10:31:00" },
    ],
    calendar: [{ service_id: "weekday", monday: "1", tuesday: "1", wednesday: "1", thursday: "1", friday: "1", saturday: "0", sunday: "0", start_date: "20260801", end_date: "20260831" }],
    calendarDates: [],
  }, {
    timeZone: "Europe/Berlin",
    serviceDates: ["20260810"],
    comparisons: [{
      routeId: "lhe-nord",
      fromStopNames: ["Leipzig Hbf"],
      toStopNames: ["Halle (Saale) Hbf"],
      direction: "Halle",
      stopPattern: "Leipzig Hbf|Halle (Saale) Hbf",
      characteristicsId: "regional-electric-v1",
      routeShortNames: ["RE 10"],
    }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].plannedArrivalEpochSeconds - result[0].plannedDepartureEpochSeconds, 1_800);
  assert.equal(result[0].characteristicsId, "regional-electric-v1");
});

test("GTFS-CSV verarbeitet Anführungszeichen, Kommas und CRLF deterministisch", () => {
  assert.deepEqual(parseCsv('stop_id,stop_name\r\n1,"Halle, Hbf"\r\n2,"Leipzig ""tief"""\r\n'), [
    { stop_id: "1", stop_name: "Halle, Hbf" },
    { stop_id: "2", stop_name: 'Leipzig "tief"' },
  ]);
});
