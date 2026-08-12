import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { adaptInfraGoGeoPackage, writeInfraGoOutputs } from "./infrago-gpkg-adapter.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./run-infrago-gpkg-adapter.mjs", import.meta.url));

function createFixture(path, { omitTrackDistrict = false } = {}) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL,
      column_name TEXT NOT NULL,
      geometry_type_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL
    );
    CREATE TABLE "M1 Streckennetz" (
      id INTEGER PRIMARY KEY NOT NULL,
      geom MULTICURVE,
      Streckennummer MEDIUMINT,
      Richtung TEXT(200),
      km_von_l TEXT(20),
      km_bis_l TEXT(20),
      km_von_i INTEGER,
      km_bis_i INTEGER,
      km_von_km REAL,
      km_von_m REAL,
      km_bis_km REAL,
      km_bis_m REAL,
      "Länge" REAL,
      Streckenkurzname TEXT(255),
      Bauzustand TEXT(255),
      "DB Betrieb" TEXT(255),
      Elektrifizierung TEXT(255),
      Gleisanzahl TEXT(255),
      Geschwindigkeit TEXT(255),
      Bundesland TEXT(200)
      ${omitTrackDistrict ? "" : ", Kreis TEXT(200)"}
    );
    CREATE TABLE "M1 Betriebsstellen" (
      id INTEGER PRIMARY KEY NOT NULL,
      geom POINT,
      Streckennummer TEXT(16),
      Richtung TEXT(200),
      km_von_l TEXT(12),
      km_bis_l TEXT(12),
      km_von_i REAL,
      km_bis_i REAL,
      km_von_km REAL,
      km_von_m REAL,
      km_bis_km REAL,
      km_bis_m REAL,
      km_lage_l TEXT(12),
      km_lage_i REAL,
      km_lage_km REAL,
      km_lage_m REAL,
      Streckenkurzname TEXT(120),
      Art TEXT(50),
      "Art lang" TEXT,
      Bezeichnung TEXT(255),
      "Kürzel" TEXT(10),
      Betriebszustand TEXT(50),
      Bundesland TEXT(200),
      Kreis TEXT(200),
      "GK Rechtswert (EPSG 31467)" REAL,
      "GK Hochwert (EPSG 31467)" REAL,
      "Geographische Länge (EPSG 4326)" REAL,
      "Geographische Breite (EPSG 4326)" REAL,
      "UTM Rechtswert (EPSG 25832)" REAL,
      "UTM Hochwert (EPSG 25832)" REAL
    );
    INSERT INTO gpkg_geometry_columns VALUES
      ('M1 Streckennetz', 'geom', 'MULTICURVE', 25832),
      ('M1 Betriebsstellen', 'geom', 'POINT', 25832);
  `);
  if (!omitTrackDistrict) {
    database.exec(`
      INSERT INTO "M1 Streckennetz" VALUES
        (2, X'02', 1000, 'Richtungsgleis', '171,0 + 0', '172,0 + 0', 117100000, 117200000, 171.0, 0, 172.0, 0, 1.0, 'Flensburg - Grenze', 'Merkmal ist im Streckenabschnitt nicht enthalten', 'In DB Netz Betrieb', 'Oberleitung', 'zweigleisig', '160 km/h', 'Schleswig-Holstein', 'Kreis Flensburg'),
        (1, X'01', 1000, 'Gegenrichtungsgleis', '170,9 + 58', '171,0 + 94', 117090058, 117100094, 170.9, 58, 171.0, 94, 0.136, 'Flensburg - Grenze', 'Merkmal ist im Streckenabschnitt nicht enthalten', 'In DB Netz Betrieb', 'Oberleitung', 'eingleisig', 'SKVerb', 'Schleswig-Holstein', 'Kreis Flensburg'),
        (3, X'03', 1005, 'Streckenachse', '0,0 + 0', '0,5 + 73', 100000000, 100050073, 0.0, 0, 0.5, 73, 0.573, 'Flensburg - Abzw Friedensweg', NULL, 'Nicht in DB Netz Betrieb', 'nicht elektrifiziert', NULL, NULL, 'Schleswig-Holstein', NULL);
      INSERT INTO "M1 Betriebsstellen" VALUES
        (3, X'13', '6170', 'Streckenachse', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0,3 + 30', 160030030, 0.3, 30, 'Berlin - Hamburg', 'Bf', 'Bahnhof', 'Berlin-Moabit', 'BMOA', 'in Betrieb', 'Berlin', 'Berlin', NULL, NULL, 13.3393998249, 52.5353737244, NULL, NULL),
        (1, X'11', '6020', 'Streckenachse', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0,0 + 0', 160000000, 0.0, 0, 'Berlin Lehrter Bf - Berlin-Moabit', 'Bf', 'Bahnhof', 'Berlin-Moabit', 'BMOA', 'in Betrieb', 'Berlin', 'Berlin', NULL, NULL, 13.3345404085, 52.5350219868, NULL, NULL),
        (2, X'12', '6020', 'Streckenachse', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '0,0 + 0', 160000000, 0.0, 0, 'Berlin Lehrter Bf - Berlin-Moabit', 'Bf', 'Bahnhof', 'Berlin-Moabit', 'BMOA', 'in Betrieb', 'Berlin', 'Berlin', NULL, NULL, 13.3345404085, 52.5350219868, NULL, NULL),
        (4, X'14', '1120', 'Streckenachse', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'Lübeck - Lüneburg', 'Bft', 'Bahnhofsteil', 'Lübeck-Niemark (Anst)', 'ALD A', 'Planung', 'Schleswig-Holstein', NULL, NULL, NULL, 10.70000001, 53.80000001, NULL, NULL);
    `);
  }
  database.close();
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-infrago-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "Infrastrukturdaten.gpkg");
  createFixture(path, options);
  return { root, path };
}

test("normalisiert reale InfraGO-Sonderwerte ohne Geschwindigkeit zu erfinden", async (t) => {
  const { path } = await fixture(t);
  const result = adaptInfraGoGeoPackage(path);

  assert.deepEqual(result.trackSegments.map(({ sourceRecordId }) => sourceRecordId), [1, 2, 3]);
  assert.deepEqual(result.trackSegments[0].speed, {
    status: "unknown",
    reason: "source-code-skverb",
    sourceValue: "SKVerb",
  });
  assert.deepEqual(result.trackSegments[2].speed, { status: "unknown", reason: "missing", sourceValue: null });
  assert.equal(result.trackSegments[0].fromKilometre.millimetres, 170_958_000);
  assert.deepEqual(result.trackSegments[0].geometry, {
    status: "omitted",
    reason: "official-layer-is-attribute-and-validation-source",
  });
});

test("dedupliziert RL100 und erhält verschiedene Streckenbindungen und E7-Koordinaten", async (t) => {
  const { path } = await fixture(t);
  const result = adaptInfraGoGeoPackage(path);

  assert.deepEqual(result.operatingPlaces.map(({ rl100 }) => rl100), ["ALD A", "BMOA"]);
  const bmoa = result.operatingPlaces[1];
  assert.equal(bmoa.routeBindings.length, 2);
  assert.deepEqual(bmoa.routeBindings[0].sourceRecordIds, [1, 2]);
  assert.deepEqual(bmoa.routeBindings.map(({ routeNumber }) => routeNumber), [6020, 6170]);
  assert.deepEqual(bmoa.coordinateE7, { longitude: 133_345_404, latitude: 525_350_220 });
  assert.equal(result.normalizedCounts.operatingPlaceBindings, 3);
  assert.equal(result.unknownValues.operatingPlaceBindings.kilometre, 1);
});

test("CLI schreibt bei gleichem GeoPackage byteidentische JSON-Sequenzen", async (t) => {
  const { root, path } = await fixture(t);
  const first = join(root, "first");
  const second = join(root, "second");
  const renamedInput = join(root, "anderer-dateiname.gpkg");
  await copyFile(path, renamedInput);
  const direct = await writeInfraGoOutputs(path, first);
  const { stdout } = await execFileAsync(process.execPath, [cli, renamedInput, second, direct.report.source.sha256]);
  const summary = JSON.parse(stdout);

  assert.equal(summary.trackSegments, 3);
  assert.equal(summary.operatingPlaces, 2);
  for (const name of ["db-infrago-track-segments.jsonseq", "db-infrago-operating-places.jsonseq", "db-infrago-adapter-report.json"]) {
    assert.equal(await readFile(join(first, name), "utf8"), await readFile(join(second, name), "utf8"));
  }
  const shipped = await readFile(join(first, "db-infrago-track-segments.jsonseq"), "utf8");
  assert.equal(shipped.includes("SKVerb"), true);
  assert.equal(shipped.includes("maximumKmh\":20"), false);
  assert.equal(shipped.includes("Blob"), false);
});

test("Schemaabweichung stoppt den Adapter vor dem Lesen von Nutzdaten", async (t) => {
  const { path } = await fixture(t, { omitTrackDistrict: true });
  assert.throws(() => adaptInfraGoGeoPackage(path), /20 statt 21 Spalten/);
});

test("unbekannte Quellcodes werden nicht stillschweigend übernommen", async (t) => {
  const { path } = await fixture(t);
  const database = new DatabaseSync(path);
  database.exec(`UPDATE "M1 Streckennetz" SET Geschwindigkeit = 'freie Fahrt' WHERE id = 1`);
  database.close();
  assert.throws(() => adaptInfraGoGeoPackage(path), /unbekannten Wert: freie Fahrt/);
});
