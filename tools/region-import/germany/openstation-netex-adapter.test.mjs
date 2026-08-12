import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { normalizeStopPlace, writeOpenStationOutputs } from "./openstation-netex-adapter.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./run-openstation-netex-adapter.mjs", import.meta.url));
const publication = { version: "42", timestamp: "2026-08-12T02:38:37.532Z", participant: "DB" };

function stopPlace({
  id,
  name,
  ril,
  eva,
  longitude = null,
  latitude = null,
  parentSiteRef = null,
  quays = [],
}) {
  const centroid = longitude === null ? "" : `<Centroid><Location><Longitude>${longitude}</Longitude><Latitude>${latitude}</Latitude></Location></Centroid>`;
  return `
    <StopPlace version="0" id="${id}">
      <keyList>
        <KeyValue><Key>NORMALIZED_ID_URI</Key><Value>https://example.test/${encodeURIComponent(id)}</Value></KeyValue>
        ${ril.map((value) => `<KeyValue><Key>RIL</Key><Value>${value}</Value></KeyValue>`).join("")}
        ${eva.map((value) => `<KeyValue><Key>EVA</Key><Value>${value}</Value></KeyValue>`).join("")}
        <KeyValue><Key>DBINFRAGO_STATION_CATEGORY</Key><Value>3</Value></KeyValue>
      </keyList>
      <privateCodes><PrivateCode type="https://daten.bahnhof.de/namespace/stada/">1234</PrivateCode></privateCodes>
      <Name lang="de">${name}<Text lang="de">${name}</Text></Name>
      <PostalAddress><Town>Teststadt</Town><PostCode>01234</PostCode></PostalAddress>
      <AccessibilityAssessment><MobilityImpairedAccess>unknown</MobilityImpairedAccess></AccessibilityAssessment>
      <TopographicPlaceRef ref="ags:12345678"/>
      ${parentSiteRef === null ? "" : `<ParentSiteRef ref="${parentSiteRef}"/>`}
      ${centroid}
      <TransportMode>rail</TransportMode>
      <StopPlaceType>railStation</StopPlaceType>
      <quays>${quays.join("")}</quays>
    </StopPlace>`;
}

function quay({ id, name, plateCode, longitude = null, latitude = null, length = null, height = null }) {
  const centroid = longitude === null ? "" : `<Centroid><Location><Longitude>${longitude}</Longitude><Latitude>${latitude}</Latitude></Location></Centroid>`;
  return `
    <Quay version="0" id="${id}">
      <keyList><KeyValue><Key>TP-ID</Key><Value>TP-${plateCode}</Value></KeyValue></keyList>
      <Name>${name}</Name>
      <PlateCode>${plateCode}</PlateCode>
      <SiteRef ref="dhid:site"/>
      ${centroid}
      ${length === null ? "" : `<Length>${length}</Length>`}
      ${height === null ? "" : `<PlatformHeight>${height}</PlatformHeight>`}
      <QuayType>railPlatform</QuayType>
      <BoardingUse>true</BoardingUse>
      <AlightingUse>true</AlightingUse>
    </Quay>`;
}

function document(stopPlaces) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <PublicationDelivery xmlns="http://www.netex.org.uk/netex" version="42">
      <PublicationTimestamp>2026-08-12T02:38:37.532Z</PublicationTimestamp>
      <ParticipantRef>DB</ParticipantRef>
      <dataObjects><CompositeFrame><frames><SiteFrame><stopPlaces>
        ${stopPlaces.join("\n")}
      </stopPlaces></SiteFrame></frames></CompositeFrame></dataObjects>
    </PublicationDelivery>`;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-openstation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const xml = document([
    stopPlace({
      id: "dhid:de:00002:2:EdB",
      name: "Zeta &amp; Sohn",
      ril: ["BETA", "ALFA"],
      eva: ["8000002"],
      parentSiteRef: "dhid:de:00002:2",
      quays: [
        quay({ id: "dhid:de:00002:2:1", name: "2", plateCode: "2", longitude: "13.2000000", latitude: "52.2000000" }),
        quay({ id: "dbinfrago-temporary:platform-a", name: "1", plateCode: "1", longitude: "13.0000000", latitude: "52.0000000", length: "255.00", height: "0.760" }),
      ],
    }),
    stopPlace({
      id: "dhid:de:00001:1:EdB",
      name: "Alpha",
      ril: ["ALFA"],
      eva: ["8000001"],
      longitude: "11.1234567",
      latitude: "51.7654321",
      quays: [quay({ id: "dhid:de:00001:1:1", name: "1", plateCode: "1" })],
    }),
  ]);
  const path = join(root, "openstation.xml");
  await writeFile(path, xml, "utf8");
  return { root, path, xml, sha256: createHash("sha256").update(xml).digest("hex") };
}

function sequence(text) {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line.replace(/^\x1e/u, "")));
}

test("normalisiert Identitäten und feste E7-/Millimeterwerte ohne erfundene Stationskoordinate", () => {
  const xml = stopPlace({
    id: "dhid:de:00002:2:EdB",
    name: "Zeta &amp; Sohn",
    ril: ["BETA", "ALFA"],
    eva: ["8000002"],
    quays: [
      quay({ id: "dhid:de:00002:2:2", name: "2", plateCode: "2", longitude: "13.2000000", latitude: "52.2000000" }),
      quay({ id: "dbinfrago-temporary:platform-a", name: "1", plateCode: "1", longitude: "13.0000000", latitude: "52.0000000", length: "255.00", height: "0.760" }),
    ],
  });
  const station = normalizeStopPlace(xml, publication);

  assert.equal(station.name, "Zeta & Sohn");
  assert.deepEqual(station.identity.rl100Codes, ["ALFA", "BETA"]);
  assert.equal(station.coordinateE7.method, "representative-source-quay-centroid");
  assert.deepEqual(
    { longitude: station.coordinateE7.longitude, latitude: station.coordinateE7.latitude },
    { longitude: 130_000_000, latitude: 520_000_000 },
  );
  const temporary = station.quays.find(({ sourceIdStability }) => sourceIdStability === "source-temporary");
  assert.equal(temporary.dimensionsMm.length, 255_000);
  assert.equal(temporary.dimensionsMm.platformHeight, 760);
  assert.equal(temporary.idStability, "derived-from-station-and-tp-id");
});

test("ersetzt eine temporäre StopPlace-Quellkennung durch RL100/EVA als release-stabile Projekt-ID", () => {
  const xml = stopPlace({ id: "dbinfrago-temporary:station", name: "X", ril: ["XX"], eva: ["8000007"] });
  const station = normalizeStopPlace(xml, publication);
  assert.equal(station.stationId, "station:openstation:rl100:XX:eva:8000007");
  assert.equal(station.identity.idStability, "derived-from-rl100-eva");
  assert.equal(station.identity.sourceIdStability, "source-temporary");
});

test("bindet eine temporäre Quay-Kennung an den innerhalb der Station eindeutigen PlateCode", () => {
  const platformXml = quay({ id: "dbinfrago-temporary:q", name: "7", plateCode: "7" })
    .replace("<keyList><KeyValue><Key>TP-ID</Key><Value>TP-7</Value></KeyValue></keyList>", "");
  const xml = stopPlace({ id: "dhid:de:8", name: "X", ril: ["XX"], eva: ["8000008"], quays: [platformXml] });
  const platform = normalizeStopPlace(xml, publication).quays[0];
  assert.equal(platform.idStability, "derived-from-station-and-plate-code");
  assert.match(platform.platformId, /:plate:7$/u);
});

test("bindet doppelte PlateCodes über den bereits stabilisierten ParentQuay", () => {
  const parent = quay({ id: "dbinfrago-temporary:parent", name: "Bahnsteig", plateCode: "1" });
  const child = quay({ id: "dbinfrago-temporary:child", name: "1", plateCode: "1" })
    .replace("<keyList><KeyValue><Key>TP-ID</Key><Value>TP-1</Value></KeyValue></keyList>", "")
    .replace("<SiteRef ref=\"dhid:site\"/>", "<ParentQuayRef ref=\"dbinfrago-temporary:parent\"/>");
  const xml = stopPlace({ id: "dhid:de:9", name: "X", ril: ["XX"], eva: ["8000009"], quays: [parent, child] });
  const platform = normalizeStopPlace(xml, publication).quays.find(({ sourceQuayRef }) => sourceQuayRef.endsWith(":child"));
  assert.equal(platform.idStability, "derived-from-parent-platform-and-plate-code");
  assert.match(platform.platformId, /:parent:.+:plate:1$/u);
});

test("CLI streamt, sortiert byteidentisch und meldet Referenzduplikate", async (t) => {
  const { root, path, sha256 } = await fixture(t);
  const renamed = join(root, "renamed.xml");
  await copyFile(path, renamed);
  const first = join(root, "first");
  const second = join(root, "second");
  const direct = await writeOpenStationOutputs(path, first, sha256);
  const { stdout } = await execFileAsync(process.execPath, [cli, renamed, second, sha256]);
  const summary = JSON.parse(stdout);

  assert.deepEqual(summary, {
    sourceSha256: sha256,
    stations: 2,
    stationFeatures: 2,
    platformPointFeatures: 2,
  });
  for (const name of Object.values(direct.files)) {
    assert.equal(await readFile(join(first, name), "utf8"), await readFile(join(second, name), "utf8"));
  }
  const stations = sequence(await readFile(join(first, direct.files.stations), "utf8"));
  assert.deepEqual(stations.map(({ stationId }) => stationId), [...stations.map(({ stationId }) => stationId)].sort());
  const report = JSON.parse(await readFile(join(first, direct.files.report), "utf8"));
  assert.equal(report.counts.sourceStopPlaces, 2);
  assert.equal(report.counts.sourceQuays, 3);
  assert.equal(report.counts.platformsWithoutCoordinate, 1);
  assert.equal(report.counts.sourceTemporaryPlatformIds, 1);
  assert.equal(report.quality.gameQualityPromotedByAdapter, false);
  assert.deepEqual(report.quality.duplicateReferences.rl100.map(({ value }) => value), ["ALFA"]);
  assert.ok(report.source.maximumBufferedStopPlaceBytes < report.source.bytes);
  const points = sequence(await readFile(join(first, direct.files.operatingPoints), "utf8"));
  assert.equal(points.every(({ properties }) => properties.feature_id.startsWith("station:") && properties.feature_type === "station" && properties.orderable === false), true);
  assert.deepEqual(points.map(({ properties }) => properties.quality_class), ["B", "C"]);
  assert.deepEqual(points.map(({ properties }) => properties.feature_id), [...points.map(({ properties }) => properties.feature_id)].sort());
  const platforms = sequence(await readFile(join(first, direct.files.platforms), "utf8"));
  assert.deepEqual(platforms.map(({ properties }) => properties.feature_id), [...platforms.map(({ properties }) => properties.feature_id)].sort());
});

test("unbekannte RIL-Kennung stoppt; feinere Quellkoordinaten werden nachvollziehbar auf E7 quantisiert", () => {
  const badRil = stopPlace({ id: "dhid:de:1", name: "X", ril: ["x?"], eva: ["8000001"] });
  assert.throws(() => normalizeStopPlace(badRil, publication), /ungültige RIL-Kennung/);
  const badCoordinate = stopPlace({ id: "dhid:de:2", name: "X", ril: ["XX"], eva: ["8000002"], longitude: "13.12345678", latitude: "52.0" });
  const coordinate = normalizeStopPlace(badCoordinate, publication).coordinateE7;
  assert.equal(coordinate.longitude, 131_234_568);
  assert.equal(coordinate.quantizedFromSource, true);
  assert.deepEqual(coordinate.sourceCoordinates, [{ longitude: "13.12345678", latitude: "52.0" }]);
});

test("erhält den belegten NeTEx-Zustand partial bei eingeschränkter Barrierefreiheit", () => {
  const xml = stopPlace({ id: "dhid:de:3", name: "X", ril: ["XX"], eva: ["8000003"] })
    .replace("<MobilityImpairedAccess>unknown</MobilityImpairedAccess>", "<MobilityImpairedAccess>partial</MobilityImpairedAccess>");
  assert.equal(normalizeStopPlace(xml, publication).accessibility.mobilityImpairedAccess, "partial");
});

test("kennzeichnet negative Quellabmessungen als Datenfehler statt sie als Länge zu verwenden", () => {
  const xml = stopPlace({
    id: "dhid:de:4",
    name: "X",
    ril: ["XX"],
    eva: ["8000004"],
    quays: [quay({ id: "dhid:de:4:1", name: "1", plateCode: "1", length: "-34.00" })],
  });
  const platform = normalizeStopPlace(xml, publication).quays[0];
  assert.equal(platform.dimensionsMm.length, null);
  assert.deepEqual(platform.dimensionEvidence.length, {
    status: "invalid-negative-source-value",
    millimetres: null,
    sourceValue: "-34.00",
  });
});

test("nutzt bei fehlendem Quay-Mittelpunkt exakt einen belegten Kindobjektpunkt", () => {
  const childCentroid = "<equipmentPlaces><EquipmentPlace id=\"diid:lift-1\"><Centroid><Location><Longitude>10.1000000</Longitude><Latitude>50.2000000</Latitude></Location></Centroid></EquipmentPlace></equipmentPlaces>";
  const platformXml = quay({ id: "dhid:de:5:1", name: "1", plateCode: "1" }).replace("<QuayType>", `${childCentroid}<QuayType>`);
  const xml = stopPlace({ id: "dhid:de:5", name: "X", ril: ["XX"], eva: ["8000005"], quays: [platformXml] });
  const station = normalizeStopPlace(xml, publication);
  assert.equal(station.quays[0].coordinateE7.method, "representative-source-quay-child-centroid");
  assert.deepEqual(station.quays[0].coordinateE7.sourceObjectRefs, ["diid:lift-1"]);
  assert.equal(station.coordinateE7.method, "representative-source-quay-centroid");
});

test("falscher Quellenhash hinterlässt kein Ausgabeziel", async (t) => {
  const { root, path } = await fixture(t);
  const output = join(root, "wrong-hash");
  await assert.rejects(() => writeOpenStationOutputs(path, output, "0".repeat(64)), /gepinnten SHA-256/);
  await assert.rejects(() => readFile(join(output, "openstation-adapter-report.json")), /ENOENT/);
});

test("verliert keinen StopPlace-Starttag an einer 64-KiB-Streamgrenze", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-openstation-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const station = stopPlace({
    id: "dhid:de:boundary",
    name: "Grenze",
    ril: ["XX"],
    eva: ["8000006"],
    longitude: "10.0",
    latitude: "50.0",
    quays: [quay({ id: "dhid:de:boundary:1", name: "1", plateCode: "1", longitude: "10.0", latitude: "50.0" })],
  });
  const beforePadding = `<?xml version="1.0"?><PublicationDelivery version="42"><PublicationTimestamp>2026-08-12T02:38:37.532Z</PublicationTimestamp><ParticipantRef>DB</ParticipantRef>`;
  const prefixTarget = 65_536 - 5;
  const prefix = `${beforePadding}${" ".repeat(prefixTarget - Buffer.byteLength(beforePadding))}`;
  const xml = `${prefix}${station}</PublicationDelivery>`;
  const input = join(root, "boundary.xml");
  const output = join(root, "output");
  await writeFile(input, xml, "utf8");
  const result = await writeOpenStationOutputs(input, output);
  assert.equal(result.report.counts.sourceStopPlaces, 1);
  assert.equal(result.report.counts.normalizedStations, 1);
});
