import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildReferenceCorpus,
  compareWithModel,
  sha256,
} from "./reference-corpus.mjs";
import { captureGtfsFeed, normalizeGtfsTables, parseCsv } from "./gtfs.mjs";

function observations(seconds, trainCategory = "RE") {
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
    trainCategory,
    trainNumber: "1",
    plannedDepartureEpochSeconds: 1_000_000 + index * 86_400,
    plannedArrivalEpochSeconds: 1_000_000 + index * 86_400 + duration,
    scheduledDwellSeconds: 10,
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

function modelResults(
  groupId,
  characteristicsId = "regional-electric-v1",
  runningSeconds = 615,
  qualification = "validation",
) {
  return {
    schema: "zugfolge-model-results/v2",
    releaseChecksum: "b".repeat(64),
    modelInputSha256: "c".repeat(64),
    qualification,
    technicalReference: {
      sourceId: "fixture-reference",
      artifactSha256: "a".repeat(64),
      runningSeconds: 600,
    },
    results: [{
      groupId,
      characteristicsId,
      calibrationMethod: "fixture",
      rawRunningSeconds: 500,
      runningSeconds,
      dwellSeconds: 10,
      modeledTimetableSeconds: runningSeconds + 10,
      technicalReferenceSeconds: 600,
    }],
  };
}

test("benennt GTFS-Werte ehrlich als Fahrplanwerte und trennt Zwischenhalte", () => {
  const corpus = buildReferenceCorpus(input);
  const group = corpus.groups[0];
  assert.equal(group.scheduledDurationP20Seconds, 600);
  assert.equal(group.scheduledDurationMedianSeconds, 620);
  assert.equal(group.scheduledDurationMeanSeconds, 672);
  assert.equal(group.scheduledRunningP20Seconds, 590);
  assert.equal(group.scheduledDwellP20Seconds, 10);
});

test("trennt Linienkategorien trotz identischer Strecke und Charakteristik", () => {
  const corpus = buildReferenceCorpus({
    ...input,
    observations: [
      ...observations([600, 600, 600, 600, 600], "S5"),
      ...observations([660, 660, 660, 660, 660], "S5X").map((value) => ({
        ...value,
        tripId: `X-${value.tripId}`,
      })),
    ],
  });
  assert.equal(corpus.groups.length, 2);
  assert.deepEqual(corpus.groups.map((group) => group.trainCategory).sort(), ["S5", "S5X"]);
});

test("Legacy-v2 kann eine Validierung nicht durch ein qualification-Feld behaupten", () => {
  const corpus = buildReferenceCorpus(input);
  const report = compareWithModel(corpus, modelResults(corpus.groups[0].id));
  assert.equal(report.passed, true);
  assert.equal(report.releaseQualified, false);
  assert.match(report.qualificationBlocker, /keinen maschinengeprüften/);
  assert.equal(report.comparisons[0].technicalReferenceSeconds, 600);
  assert.equal(report.comparisons[0].scheduledAllowanceSeconds, -25);
  assert.throws(
    () => compareWithModel(corpus, modelResults(corpus.groups[0].id, "wrong")),
    /Zugcharakteristik/,
  );
});

test("bindet ein versioniertes Modellergebnis eindeutig an Release und Eingabe", () => {
  const corpus = buildReferenceCorpus(input);
  const duplicate = modelResults(corpus.groups[0].id);
  duplicate.results.push({ ...duplicate.results[0] });
  assert.throws(() => compareWithModel(corpus, duplicate), /doppelt/);
  assert.throws(
    () => compareWithModel(corpus, { ...modelResults(corpus.groups[0].id), results: [] }),
    /fehlt/,
  );
  assert.throws(
    () => compareWithModel(corpus, { ...modelResults(corpus.groups[0].id), releaseChecksum: "" }),
    /releaseChecksum/,
  );
  assert.throws(
    () => compareWithModel(corpus, { ...modelResults(corpus.groups[0].id), schema: "alt" }),
    /Schema/,
  );
  assert.throws(
    () => compareWithModel(corpus, {
      ...modelResults(corpus.groups[0].id),
      technicalReference: { sourceId: "fixture", artifactSha256: "", runningSeconds: 600 },
    }),
    /SHA-256/,
  );
  assert.throws(
    () => compareWithModel(corpus, {
      ...modelResults(corpus.groups[0].id),
      results: [{
        ...modelResults(corpus.groups[0].id).results[0],
        modeledTimetableSeconds: 999,
      }],
    }),
    /Lauf- plus Haltezeit/,
  );
});

test("GTFS paart Halte derselben Fahrt und bindet sie an eine geprüfte Charakteristik", () => {
  const result = normalizeGtfsTables({
    stops: [
      { stop_id: "L", stop_name: "Leipzig Hbf", parent_station: "" },
      { stop_id: "M", stop_name: "Leipzig Messe", parent_station: "" },
      { stop_id: "H", stop_name: "Halle (Saale) Hbf", parent_station: "" },
    ],
    routes: [{ route_id: "r", route_short_name: "RE 10", route_long_name: "" }],
    trips: [{ route_id: "r", service_id: "weekday", trip_id: "trip-1", trip_headsign: "Halle", trip_short_name: "10" }],
    stopTimes: [
      { trip_id: "trip-1", stop_id: "L", stop_sequence: "1", arrival_time: "10:00:00", departure_time: "10:00:00" },
      { trip_id: "trip-1", stop_id: "M", stop_sequence: "2", arrival_time: "10:10:00", departure_time: "10:11:00" },
      { trip_id: "trip-1", stop_id: "H", stop_sequence: "3", arrival_time: "10:30:00", departure_time: "10:31:00" },
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
      stopPattern: "Leipzig Hbf|Leipzig Messe|Halle (Saale) Hbf",
      characteristicsId: "regional-electric-v1",
      routeShortNames: ["RE 10"],
    }],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].plannedArrivalEpochSeconds - result[0].plannedDepartureEpochSeconds, 1_800);
  assert.equal(result[0].scheduledDwellSeconds, 60);
  assert.equal(result[0].characteristicsId, "regional-electric-v1");
});

test("GTFS-CSV verarbeitet Anführungszeichen, Kommas und CRLF deterministisch", () => {
  assert.deepEqual(parseCsv('stop_id,stop_name\r\n1,"Halle, Hbf"\r\n2,"Leipzig ""tief"""\r\n'), [
    { stop_id: "1", stop_name: "Halle, Hbf" },
    { stop_id: "2", stop_name: 'Leipzig "tief"' },
  ]);
});

test("Capture-v2 bindet die exakten Konfigurationsbytes sowie Archiv- und Tabellenhashes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zugfolge-gtfs-capture-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const files = new Map([
    ["agency.txt", "agency_id,agency_name\na,Fixture\n"],
    ["stops.txt", "stop_id,stop_name\nL,Leipzig\n"],
    ["routes.txt", "route_id,route_short_name\nr,SYN\n"],
    ["trips.txt", "route_id,service_id,trip_id\nr,s,t\n"],
    ["stop_times.txt", "trip_id,stop_id,stop_sequence\nt,L,1\n"],
  ]);
  const config = {
    schema: "zugfolge-gtfs-capture/v2",
    feedUrl: "https://invalid.example.test/feed.zip",
    source: { retrievedAt: "2026-08-10T00:00:00.000Z" },
  };
  const configArtifactSha256 = "d".repeat(64);
  const archive = Buffer.from("synthetic archive");
  const result = await captureGtfsFeed(config, {
    outputDirectory: root,
    configArtifactSha256,
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => archive }),
    listEntries: async () => [...files.keys()],
    extract: async (_archivePath, directory) => {
      for (const [name, content] of files) await writeFile(path.join(directory, name), content);
    },
  });
  assert.equal(result.manifest.configArtifactSha256, configArtifactSha256);
  assert.equal(result.manifest.archiveSha256, sha256(archive));
  assert.deepEqual(
    result.manifest.files.map(({ path: file, sha256: hash }) => [file, hash]),
    [...files].map(([file, content]) => [file, sha256(content)]),
  );
  await assert.rejects(
    () => captureGtfsFeed(config, {
      outputDirectory: root,
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => archive }),
    }),
    /configArtifactSha256/,
  );
});

test("der versionierte Pilotvergleich trennt bestandene Kalibrierung von Release-Freigabe", async () => {
  const pilot = new URL("pilot/2026-08/", import.meta.url);
  const readPilotJson = async (name) => JSON.parse(await readFile(new URL(name, pilot), "utf8"));
  const [config, corpus, model, storedReport, release, technicalReference, modelConfig] = await Promise.all([
    readPilotJson("config.json"),
    readPilotJson("reference-corpus.json"),
    readPilotJson("model-results.json"),
    readPilotJson("deviation-report.json"),
    readPilotJson("pilot.infrarelease.json"),
    readPilotJson("trassenfinder-reference.json"),
    readPilotJson("model-config.json"),
  ]);
  const report = compareWithModel(corpus, model, config.tolerance);

  assert.deepEqual(report, storedReport);
  assert.equal(report.passed, true);
  assert.equal(report.releaseQualified, false);
  assert.equal(report.qualification, "calibration-only");
  assert.equal(report.comparisons[0].calculatedTechnicalSeconds, 1_263);
  assert.equal(report.comparisons[0].technicalReferenceSeconds, 1_260);
  assert.equal(report.comparisons[0].technicalDeviationSeconds, 3);
  assert.equal(report.comparisons[0].toleranceSeconds, 63);
  assert.equal(report.comparisons[0].scheduledDurationP20Seconds, 1_380);
  assert.equal(report.comparisons[0].scheduledAllowanceSeconds, 57);
  assert.equal(technicalReference.result.technicalRunningSeconds, 1_260);
  assert.equal(
    model.technicalReference.artifactSha256,
    sha256(await readFile(new URL("trassenfinder-reference.json", pilot))),
  );
  assert.equal(release.releaseChecksum, model.releaseChecksum);
  assert.equal(release.modelInputSha256, model.modelInputSha256);
  assert.deepEqual(release.modelConfig, modelConfig);
  assert.equal(
    model.modelInputSha256,
    sha256(await readFile(new URL("model-config.json", pilot))),
  );
  assert.match(report.qualificationBlocker, /Legacy-v2/);
});
