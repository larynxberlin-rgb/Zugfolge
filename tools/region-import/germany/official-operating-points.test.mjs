import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeOfficialOperatingPoints } from "./official-operating-points.mjs";

function specification() {
  return {
    schema: "zugfolge-official-operating-points/v1",
    releaseId: "infra-deutschland-test.1",
    sourceFile: "input/operating-points.geojsonseq",
    outputDirectory: "output/official",
    allowedSourceId: "db-infrago-infrastructure-open-data",
    forbiddenSourceIds: ["annual-infrastructure-master", "trassenfinder-infrastruktur-api"],
  };
}

function place(rl100, extra = {}) {
  return {
    schema: "zugfolge-infrago-operating-place/v1",
    operatingPlaceId: `db-infrago:rl100:${encodeURIComponent(rl100)}`,
    rl100,
    name: `Betriebsstelle ${rl100}`,
    names: [`Betriebsstelle ${rl100}`],
    coordinateE7: { longitude: 123_000_000, latitude: 513_000_000 },
    coordinateCandidatesE7: [{ longitude: 123_000_000, latitude: 513_000_000 }],
    types: [{ code: "Bf", name: "Bahnhof" }],
    operatingStates: [{ kind: "active", sourceValue: "in Betrieb" }],
    routeBindings: [{ routeNumber: 6363 }],
    sourceRecordIds: [1],
    ...extra,
  };
}

async function fixture(lines) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-official-op-"));
  await mkdir(join(root, "input"));
  await writeFile(join(root, "input", "operating-points.geojsonseq"), lines.map((value) => `\x1e${JSON.stringify(value)}\n`).join(""));
  return root;
}

test("materialisiert ausschliesslich DB-InfraGO-Open-Data create-new und stabil sortiert", async () => {
  const root = await fixture([place("ZZ"), place("AA H")]);
  const result = await writeOfficialOperatingPoints({ specification: specification(), repositoryRoot: root });
  assert.equal(result.report.features, 2);
  assert.equal(result.report.forbiddenFallbackFeatures, 0);
  const output = await readFile(join(root, "output", "official", "operating-points.geojsonseq"), "utf8");
  assert.ok(output.indexOf("operating-point:rl100:AA H") < output.indexOf("operating-point:rl100:ZZ"));
  assert.doesNotMatch(output, /trassenfinder|tf_|corroborat/iu);
  await assert.rejects(
    writeOfficialOperatingPoints({ specification: specification(), repositoryRoot: root }),
    /existiert bereits/u,
  );
});

test("weist jede Trassenfinder-Corroboration oder Fallback-Anreicherung fail-closed zurueck", async () => {
  const fallbackRoot = await fixture([place("TF", { trassenfinderCorroboration: { distanceMm: 1 } })]);
  await assert.rejects(
    writeOfficialOperatingPoints({ specification: specification(), repositoryRoot: fallbackRoot }),
    /unerwartete oder fehlende Felder/u,
  );

  const derivedRoot = await fixture([place("TF2", { sourceId: "trassenfinder-infrastruktur-api" })]);
  await assert.rejects(
    writeOfficialOperatingPoints({ specification: specification(), repositoryRoot: derivedRoot }),
    /unerwartete oder fehlende Felder/u,
  );
});

test("weist unbekannte oder unvollstaendige InfraGO-Adapterobjekte fail-closed zurueck", async () => {
  const root = await fixture([place("BAD", { coordinateCandidatesE7: [] })]);
  await assert.rejects(
    writeOfficialOperatingPoints({ specification: specification(), repositoryRoot: root }),
    /keine offiziellen Koordinatenkandidaten/u,
  );
});
