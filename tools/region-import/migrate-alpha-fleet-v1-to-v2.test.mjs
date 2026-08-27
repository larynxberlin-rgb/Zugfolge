import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";

import { alphaCanonicalJson } from "../../packages/alpha/dist/index.js";
import { canonicalPlanningJson } from "../../packages/gtfs/dist/index.js";
import {
  createAlphaFleetMigrationContract,
  migrateAlphaFleetV1ToV2,
  publishCreateNewMigrationBundle,
  runBuildAlphaFleetMigrationContract,
  validateAlphaFleetMigrationContract,
  validateAlphaFleetMigrationContractSpecification,
} from "./migrate-alpha-fleet-v1-to-v2.mjs";
import { deriveDailyCirculationPlan } from "./daily-circulation-v2.mjs";

const WORLD = "e2695e40-3e4c-4e8c-9481-98f6223538d0";
const OLD_WORLD = "00000000-0000-4000-8000-000000000014";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const GTFS_RELEASE = `gtfs-de-rv-20260812-${SHA_A.slice(0, 16)}`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildConfiguration(gtfsEnvelopeValue = gtfsEnvelope()) {
  const dailyPlan = deriveDailyCirculationPlan({
    journeyChains: gtfsEnvelopeValue.snapshot.journeyChains.filter((chain) => chain.orderable === true),
    stations: gtfsEnvelopeValue.snapshot.stations,
    gtfsReleaseId: GTFS_RELEASE,
  });
  return {
    schemaVersion: "zugfolge-alpha-world-build-configuration/v3",
    worldId: WORLD,
    regionId: "fixture-region-b",
    regionVariant: "B",
    operatorId: "public",
    seed: "42",
    fleetReleaseId: "fleet-alpha-fixture-2026.3-v2",
    planningAuthority: { accountId: "a2a545d2-74f7-40af-908d-1901ba2220bb", displayName: "Fixture-Aufgabentraeger" },
    operationalInfrastructure: { file: "operational-infrastructure-v2.json", bytes: 42, sha256: SHA_A, stateHash: SHA_B },
    timetableRoutes: { file: "timetable-routes-v2.jsonseq", bytes: 84, sha256: SHA_A },
    timetableTransferDemands: {
      file: "timetable-routes-v2.transfer-demands-v2.json",
      bytes: 126,
      sha256: SHA_A,
      dailyPlanSha256: dailyPlan.planSha256,
      transferSetSha256: SHA_B,
    },
    movementRouteTemplates: {
      file: "operational-infrastructure-v2.movement-route-templates-v2.json",
      bytes: 168,
      sha256: SHA_A,
      stateHash: SHA_A,
      operationalStateHash: SHA_B,
      timetableTransferSetSha256: SHA_B,
    },
  };
}

function asset(id, numericId, classDesignation = "563.0", traction = "battery") {
  return {
    id,
    numericId,
    operatorId: "public",
    vehicleTypeId: classDesignation === "563.0" ? 1101 : 1100,
    classDesignation,
    tradeName: `Stromnetz ${classDesignation}`,
    buildYear: 2024,
    acquisitionYear: 2026,
    procurementChannel: "used",
    approvedLineIds: ["line-1-rb1"],
    maintenanceDeadlines: [{ kind: "release-overhaul-validity", dueAt: 31_622_400 }],
    installedProtection: ["pzb"],
    technical: {
      lengthMm: 46_560,
      massKg: 93_000,
      maximumSpeedKph: 140,
      continuousPowerKw: 1_700,
      startingTractiveEffortKn: 130,
      traction,
      electricSystems: traction === "electric" ? ["ac15kv"] : [],
      role: "powered-unit",
      controlStands: { front: true, rear: true },
    },
    passenger: {
      seats: 100,
      firstClassSeats: 0,
      accessible: true,
      bicyclePlaces: 8,
      wheelchairPlaces: 2,
      equipment: ["passenger-information"],
      operatingCostCentsPerTrainKm: 800,
      replacementPlan: true,
    },
    deliveredAt: 0,
    retiredAt: 31_622_400,
  };
}

function legacyBytes(assets = [asset("legacy-1", 10_001), asset("legacy-2", 10_002)]) {
  return Buffer.from(JSON.stringify({
    deployment: {
      schema: "zugfolge-alpha-world-deployment/v1",
      worldId: OLD_WORLD,
      fleet: {
        schemaVersion: "zugfolge-fleet-world-initialize/v2",
        worldId: OLD_WORLD,
        authorityRelease: {
          schemaVersion: "zugfolge-fleet-authority-release/v1",
          releaseId: "fleet-alpha-fixture-2026.2",
          referenceYear: 2026,
          assets,
          personnelPools: [],
          pathReceipts: [],
        },
        formations: [],
        personnelDuties: [],
        pathReservations: [],
      },
    },
  }), "utf8");
}

function contractSpecification(bytes) {
  const authority = JSON.parse(bytes).deployment.fleet.authorityRelease;
  const authorityReleaseSha256 = sha256(alphaCanonicalJson(authority));
  return {
    schemaVersion: "zugfolge-alpha-fleet-v1-migration-contract-specification/v1",
    legacy: {
      file: "alpha-world-deployment.json",
      bytes: bytes.length,
      sha256: sha256(bytes),
      worldId: OLD_WORLD,
      authorityReleaseId: authority.releaseId,
      authorityReleaseSha256,
      assetCount: authority.assets.length,
    },
    target: {
      sourceCatalogReleaseId: "alpha-vehicle-catalog-fixture-2026.3-v2",
      seedId: "alpha-world-seed-fixture-2026.3-v3",
      authorityReleaseId: "fleet-alpha-fixture-2026.3-v2",
      operationalReleaseId: "operational-fleet-alpha-fixture-2026.3-v2",
      gtfsReleaseId: GTFS_RELEASE,
      worldId: WORLD,
      producedAt: 0,
      referenceYear: 2026,
    },
    source: {
      id: "approved-alpha-fleet-authority-v1-fixture",
      title: "Freigegebener Alpha-Authority-v1-Testbestand",
      url: "https://example.invalid/approved-alpha-fleet-authority-v1-fixture",
      license: "LicenseRef-Zugfolge-Approved-Game-Data",
      retrievedAt: "2026-08-25",
      contentSha256: authorityReleaseSha256,
      rightsDecision: { status: "freigegeben", decidedAt: "2026-08-25", reviewer: "fixture-owner", reference: "fixture-approval" },
    },
  };
}

function gtfsEnvelope(routeId = "1", routeShortName = "RB1") {
  const snapshot = {
    serviceDate: "20260812",
    source: {
      archive: "gtfs-rv-free-fixture.zip",
      archiveSha256: SHA_A,
      sourceLicense: "CC BY 4.0",
    },
    regionId: "fixture-region-b",
    regionVariant: "B",
    metrics: { orderableJourneyChainCount: 1 },
    stations: [
      { stopId: "stop-a", latitudeE7: 510_000_000, longitudeE7: 120_000_000 },
      { stopId: "stop-b", latitudeE7: 511_000_000, longitudeE7: 121_000_000 },
    ],
    segments: [{ id: "segment-fixture", orderable: true, qualityClass: "B" }],
    journeyChains: [{
      worldId: WORLD,
      releaseId: GTFS_RELEASE,
      journeyChainId: "jc-fixture",
      routeId,
      routeShortName,
      orderable: true,
      legs: [{
        kind: "playable",
        legId: "pl-fixture",
        orderable: true,
        qualityClass: "B",
        entryPortalId: null,
        exitPortalId: null,
        stops: [
          { stopId: "stop-a", arrivalS: 10_000, departureS: 10_000 },
          { stopId: "stop-b", arrivalS: 11_000, departureS: 11_060 },
        ],
      }],
    }],
  };
  return { snapshot, snapshotHash: sha256(canonicalPlanningJson(snapshot)) };
}

function economySpecification() {
  return {
    version: "fixture-economy-2026.3",
    rates: {
      trackPerTrainKmCents: "100", stationPerStopCents: "200", facilityPerHourCents: "300", energyPerKwhCents: "40",
      personnelPerHourCents: "4000", administrationPerPeriodCents: "50000", vehiclePerPeriodCents: "100000",
      overnightStablingPerPeriodCents: "20000", protectionEquipmentPerPeriodCents: "10000", lateInterestBasisPoints: 500,
    },
    rules: {
      qualityBaselinePunctualityBasisPoints: 8500, pointsPerExtraSeat: 40, pointsPerPunctualityBasisPoint: 1,
      pointsPerAdditionalStop: 300, requirementFocusMaximumPoints: 1500, contractBonusCentsPerPeriod: "100000",
      penaltyRates: { punctuality: "10", cancellation: "10000", seats: "100", connections: "1000" },
      penaltyFocusMultiplierBasisPoints: 20000, publicOperationSurchargeBasisPoints: 2000,
      failedPackageFeeStepBasisPoints: 500, failedPackageReductionStepBasisPoints: 400,
    },
    tenderProfiles: [
      { id: "price", weights: { price: 7000, quality: 3000 }, requirementFocus: "capacity", penaltyFocus: "punctuality", viabilitySurchargeBasisPoints: 1000 },
      { id: "quality", weights: { price: 3000, quality: 7000 }, requirementFocus: "accessibility", penaltyFocus: "connections", viabilitySurchargeBasisPoints: 1500 },
    ],
  };
}

function infraReleaseWrapper(buildConfigurationValue, gtfsBytesValue) {
  const gtfs = JSON.parse(gtfsBytesValue);
  const selectedSegmentCount = gtfs.snapshot.segments.filter((segment) => segment.orderable === true && segment.qualityClass === "B").length;
  const release = {
    schema: "zugfolge-infra-release/v2",
    releaseId: "infra-deutschland-fixture.1",
    timetableYear: 2026,
    sources: [{ id: "gtfs-de-regional-rail", sha256: gtfs.snapshot.source.archiveSha256 }],
    artifacts: [{
      id: "operational-infrastructure-fixture.1",
      kind: "operational-infrastructure-v2",
      infraReleaseId: "infra-deutschland-fixture.1",
      file: "operational-infrastructure-v2.json",
      bytes: buildConfigurationValue.operationalInfrastructure.bytes,
      sha256: buildConfigurationValue.operationalInfrastructure.sha256,
      stateHash: buildConfigurationValue.operationalInfrastructure.stateHash,
    }],
    quality: {
      operationalClosure: {
        operationalQualityEligible: true,
        unresolvedRequired: 0,
        timetableRouteEvidence: {
          archive: gtfs.snapshot.source.archive,
          archiveSha256: gtfs.snapshot.source.archiveSha256,
          sourceLicenseAsPublished: gtfs.snapshot.source.sourceLicense,
          gtfsSnapshotBytes: gtfsBytesValue.length,
          gtfsSnapshotSha256: sha256(gtfsBytesValue),
          snapshotHash: gtfs.snapshotHash,
          routesBytes: buildConfigurationValue.timetableRoutes.bytes,
          routesSha256: buildConfigurationValue.timetableRoutes.sha256,
          routeSetSha256: buildConfigurationValue.timetableRoutes.sha256,
          routeRecordCount: selectedSegmentCount,
          completeRouteCount: selectedSegmentCount,
          selectedSegmentCount,
        },
      },
    },
  };
  return { release, releaseHash: sha256(alphaCanonicalJson(release)) };
}

const FIXTURE_FILE_NAMES = Object.freeze({
  buildConfiguration: "alpha-world-build-configuration-v3.json",
  gtfs: "gtfs-region-fixture-v2.json",
  economy: "economy-release-fixture.json",
  infraReleaseWrapper: "infra-release.json",
});

function migrationFixture(bytes = legacyBytes(), values = {}) {
  const gtfsEnvelopeValue = values.gtfsEnvelopeValue ?? gtfsEnvelope();
  const buildConfigurationValue = values.buildConfigurationValue ?? buildConfiguration(gtfsEnvelopeValue);
  const economySpecificationValue = values.economySpecificationValue ?? economySpecification();
  const buildConfigurationBytes = jsonBytes(buildConfigurationValue);
  const gtfsBytes = jsonBytes(gtfsEnvelopeValue);
  const economyBytes = jsonBytes(economySpecificationValue);
  const infraReleaseWrapperBytes = jsonBytes(infraReleaseWrapper(buildConfigurationValue, gtfsBytes));
  const contract = createAlphaFleetMigrationContract({
    specification: contractSpecification(bytes),
    buildConfigurationBytes,
    gtfsBytes,
    economyBytes,
    infraReleaseWrapperBytes,
    fileNames: FIXTURE_FILE_NAMES,
  });
  return {
    contract,
    buildConfigurationBytes,
    gtfsBytes,
    legacyBytes: bytes,
    economyBytes,
    infraReleaseWrapperBytes,
    fileNames: FIXTURE_FILE_NAMES,
    timetableRouteBindings: routeBindings(),
  };
}

function routeBindings() {
  return new Map([["pl-fixture", {
    playableLegId: "pl-fixture",
    routeVersionId: "route:gtfs:pl-fixture:v1",
    templateId: "template:gtfs:pl-fixture:v1",
    dispatchInterlockingRouteId: "interlocking:synthetic-segment:fixture",
    routeLengthMm: 1_000,
  }]]);
}

function migrate(bytes = legacyBytes(), values = {}, overrides = {}) {
  return migrateAlphaFleetV1ToV2({ ...migrationFixture(bytes, values), ...overrides });
}

test("Migration erhaelt konkrete Identitaeten, isoliert die Zielwelt und markiert Reserve statt V1 umzubenennen", () => {
  const migrated = migrate();
  assert.equal(migrated.sourceCatalog.schemaVersion, "zugfolge-vehicle-catalog-source/v2");
  assert.equal(migrated.worldSeed.schemaVersion, "zugfolge-vehicle-world-seed/v3");
  assert.equal(migrated.worldSeed.worldId, WORLD);
  assert.equal(migrated.worldSeed.assets.length, 2);
  assert.deepEqual(migrated.worldSeed.assets.map(({ id }) => id), ["legacy-1", "legacy-2"]);
  assert.deepEqual(migrated.worldSeed.assets.find(({ id }) => id === "legacy-2").approvedLineIds, ["reserve-pool"]);
  assert.match(migrated.worldSeed.assets.find(({ id }) => id === "legacy-1").approvedLineIds[0], /^line-rb1-[a-f0-9]{64}$/u);
  assert.notDeepEqual(migrated.worldSeed.assets.find(({ id }) => id === "legacy-1").approvedLineIds, ["line-1-rb1"]);
  assert.equal(migrated.worldSeed.formations.length, 1);
  assert.equal(migrated.worldSeed.pathReceipts.every((receipt) => receipt.plannerStateHash === SHA_B), true);
  assert.equal(JSON.stringify(migrated).includes(OLD_WORLD), false);
  const dailyPlan = deriveDailyCirculationPlan({
    journeyChains: gtfsEnvelope().snapshot.journeyChains,
    stations: gtfsEnvelope().snapshot.stations,
    gtfsReleaseId: GTFS_RELEASE,
  });
  assert.deepEqual(migrated.allocation, {
    legacyAssetCount: 2,
    activeAssetCount: 1,
    reserveAssetCount: 1,
    formationCount: 1,
    minimumTurnaroundS: 300,
    dailyPlanSha256: dailyPlan.planSha256,
    rolloverAssignmentCount: 1,
    transferDemandCount: 1,
  });
  assert.equal(migrated.sourceCatalog.vehicleTypes[0].technical.brakeWeightKg.kind, "game-assumption");
  assert.equal(migrated.sourceCatalog.vehicleTypes[0].technical.massKg.kind, "published-fact");
});

test("echter Rust-Compiler akzeptiert den migrierten Source-v2/Seed-v3-Satz", async () => {
  const migrated = migrate();
  const root = await mkdtemp(join(tmpdir(), "zugfolge-alpha-fleet-migration-"));
  try {
    const source = join(root, "vehicle-catalog-source-v2.json");
    const seed = join(root, "vehicle-world-seed-v3.json");
    const output = join(root, "compiled");
    await writeFile(source, `${JSON.stringify(migrated.sourceCatalog, null, 2)}\n`, "utf8");
    await writeFile(seed, `${JSON.stringify(migrated.worldSeed, null, 2)}\n`, "utf8");
    const compiled = spawnSync("cargo", ["run", "--quiet", "--locked", "-p", "zugfolge-fleet", "--bin", "zugfolge-vehicle-catalog", "--", source, seed, output], { encoding: "utf8" });
    assert.equal(compiled.status, 0, `${compiled.stderr}\n${compiled.stdout}`);
    const receipt = JSON.parse(await readFile(join(output, "vehicle-catalog-compile-receipt-v4.json"), "utf8"));
    const authority = JSON.parse(await readFile(join(output, "fleet-authority-release-v2.json"), "utf8"));
    assert.equal(receipt.worldId, WORLD);
    assert.equal(receipt.sourceCatalogSha256, sha256(await readFile(source)));
    assert.equal(receipt.worldSeedSha256, sha256(await readFile(seed)));
    assert.equal(authority.schemaVersion, "zugfolge-fleet-authority-release/v2");
    assert.equal(authority.assets.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Migration faellt bei fremden Bytes, fremder Zielwelt und ungedeckter BEMU-Flotte geschlossen aus", () => {
  const bytes = legacyBytes();
  const fixture = migrationFixture(bytes);
  assert.throws(() => migrateAlphaFleetV1ToV2({
    ...fixture,
    legacyBytes: Buffer.concat([bytes, Buffer.from(" ")]),
  }), /Byte- oder SHA-256/u);

  const foreignContract = structuredClone(fixture.contract);
  foreignContract.target.worldId = "00000000-0000-4000-8000-000000000999";
  assert.throws(() => migrateAlphaFleetV1ToV2({
    ...fixture,
    contract: foreignContract,
  }), /verschiedene Zielwelten/u);

  const foreignGtfs = gtfsEnvelope();
  foreignGtfs.snapshot.journeyChains[0].releaseId = "gtfs-de-rv-20260812-bbbbbbbbbbbbbbbb";
  foreignGtfs.snapshotHash = sha256(canonicalPlanningJson(foreignGtfs.snapshot));
  assert.throws(() => migrationFixture(bytes, {
    gtfsEnvelopeValue: foreignGtfs,
    buildConfigurationValue: buildConfiguration(),
  }), /identisch signiert gebunden/u);

  const collidingAssets = [asset("legacy-collision-1", 10_101), asset("legacy-collision-2", 10_102)];
  for (const candidate of collidingAssets) candidate.approvedLineIds = ["line-a-b-rb1"];
  const collidingBytes = legacyBytes(collidingAssets);
  const collidingGtfs = gtfsEnvelope("A+B", "RB1");
  const secondChain = structuredClone(collidingGtfs.snapshot.journeyChains[0]);
  secondChain.journeyChainId = "jc-collision-second";
  secondChain.routeId = "A B";
  secondChain.legs[0].legId = "pl-collision-second";
  collidingGtfs.snapshot.journeyChains.push(secondChain);
  collidingGtfs.snapshot.segments.push({ id: "segment-collision-second", orderable: true, qualityClass: "B" });
  collidingGtfs.snapshot.metrics.orderableJourneyChainCount = 2;
  collidingGtfs.snapshotHash = sha256(canonicalPlanningJson(collidingGtfs.snapshot));
  const collidingRoutes = routeBindings();
  collidingRoutes.set("pl-collision-second", {
    ...collidingRoutes.get("pl-fixture"),
    playableLegId: "pl-collision-second",
    routeVersionId: "route:gtfs:pl-collision-second:v1",
    templateId: "template:gtfs:pl-collision-second:v1",
  });
  assert.throws(() => migrateAlphaFleetV1ToV2({
    ...migrationFixture(collidingBytes, { gtfsEnvelopeValue: collidingGtfs }),
    timetableRouteBindings: collidingRoutes,
  }), /mehrdeutige Legacy-Linienkennung/u);

  const electricBytes = legacyBytes([asset("electric-1", 10_001, "463.0", "electric")]);
  assert.throws(() => migrate(electricBytes, { gtfsEnvelopeValue: gtfsEnvelope("new", "NEW") }), /deckt Los.*563\.0/u);
});

test("unveraenderter Vertrag blockiert mutierte JourneyChain, Betreiber-, Operational- und Economy-Werte ohne Ziel", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-alpha-fleet-input-pins-"));
  try {
    const fixture = migrationFixture();
    const mutations = [
      ["journey-chain", () => {
        const value = JSON.parse(fixture.gtfsBytes);
        value.snapshot.journeyChains[0].routeId = "mutated-route";
        value.snapshotHash = sha256(canonicalPlanningJson(value.snapshot));
        return { gtfsBytes: jsonBytes(value) };
      }],
      ["operator", () => {
        const value = JSON.parse(fixture.buildConfigurationBytes);
        value.operatorId = "mutated-operator";
        return { buildConfigurationBytes: jsonBytes(value) };
      }],
      ["operational-state", () => {
        const value = JSON.parse(fixture.buildConfigurationBytes);
        value.operationalInfrastructure.stateHash = "c".repeat(64);
        return { buildConfigurationBytes: jsonBytes(value) };
      }],
      ["economy-rate", () => {
        const value = JSON.parse(fixture.economyBytes);
        value.rates.trackPerTrainKmCents = "101";
        return { economyBytes: jsonBytes(value) };
      }],
    ];
    for (const [name, mutate] of mutations) {
      const output = join(root, name);
      await assert.rejects(
        publishCreateNewMigrationBundle(output, async () => {
          migrateAlphaFleetV1ToV2({ ...fixture, ...mutate() });
        }),
        /Byte-SHA-256|kanonische SHA-256-Bindung/u,
      );
      await assert.rejects(readdir(output), { code: "ENOENT" });
    }
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".staging-") || name.endsWith(".publish.lock")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Migrationsbundle bleibt bei Fehler unsichtbar und ist anschliessend retry-faehig", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-alpha-fleet-publish-"));
  try {
    const output = join(root, "fleet-migration-v2");
    await assert.rejects(
      publishCreateNewMigrationBundle(output, async (stagingDirectory) => {
        await writeFile(join(stagingDirectory, "vehicle-catalog-source-v2.json"), "partial\n", { encoding: "utf8", flag: "wx" });
        throw new Error("injected-rust-compiler-failure");
      }),
      /injected-rust-compiler-failure/u,
    );
    await assert.rejects(readdir(output), { code: "ENOENT" });
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".staging-")), []);

    await publishCreateNewMigrationBundle(output, async (stagingDirectory) => {
      await writeFile(join(stagingDirectory, "vehicle-catalog-source-v2.json"), "complete\n", { encoding: "utf8", flag: "wx" });
      await writeFile(join(stagingDirectory, "alpha-fleet-v1-migration-receipt-v2.json"), "receipt\n", { encoding: "utf8", flag: "wx" });
    });
    assert.deepEqual((await readdir(output)).sort(), ["alpha-fleet-v1-migration-receipt-v2.json", "vehicle-catalog-source-v2.json"]);
    await assert.rejects(publishCreateNewMigrationBundle(output, async () => undefined), /existiert bereits/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Migrationsbundle ersetzt kein waehrend Populate angelegtes leeres Zielverzeichnis", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-alpha-fleet-publish-race-"));
  try {
    const output = join(root, "fleet-migration-v2");
    await assert.rejects(
      publishCreateNewMigrationBundle(output, async (stagingDirectory) => {
        await writeFile(join(stagingDirectory, "staged.json"), "staged\n", { encoding: "utf8", flag: "wx" });
        await mkdir(output);
      }),
      /existiert bereits/u,
    );
    assert.deepEqual(await readdir(output), []);
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".staging-") || name.endsWith(".publish.lock")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zweiter paralleler Bundle-Publisher scheitert vor Populate und laesst den Gewinner bytekorrekt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-alpha-fleet-parallel-publisher-"));
  let releaseFirst;
  try {
    const output = join(root, "fleet-migration-v2");
    let signalFirstPopulate;
    const firstPopulateEntered = new Promise((resolve) => { signalFirstPopulate = resolve; });
    const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
    const first = publishCreateNewMigrationBundle(output, async (stagingDirectory) => {
      await writeFile(join(stagingDirectory, "vehicle-catalog-source-v2.json"), "winner-source\n", { encoding: "utf8", flag: "wx" });
      signalFirstPopulate();
      await firstMayFinish;
      await writeFile(join(stagingDirectory, "alpha-fleet-v1-migration-receipt-v2.json"), "winner-receipt\n", { encoding: "utf8", flag: "wx" });
    });
    await firstPopulateEntered;

    let rejectedPopulateCalled = false;
    await assert.rejects(
      publishCreateNewMigrationBundle(output, async () => { rejectedPopulateCalled = true; }),
      /parallele Migration.*Publikationssperre/u,
    );
    assert.equal(rejectedPopulateCalled, false, "Verlierer darf Populate nicht erreichen");

    releaseFirst();
    await first;
    assert.equal(await readFile(join(output, "vehicle-catalog-source-v2.json"), "utf8"), "winner-source\n");
    assert.equal(await readFile(join(output, "alpha-fleet-v1-migration-receipt-v2.json"), "utf8"), "winner-receipt\n");
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".staging-") || name.endsWith(".publish.lock")), []);
  } finally {
    releaseFirst?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("Migrationsvertrag akzeptiert keine unfreigegebene oder hashfremde Quelle", () => {
  const value = migrationFixture().contract;
  assert.equal(validateAlphaFleetMigrationContract(value).source.rightsDecision.status, "freigegeben");
  const blocked = structuredClone(value);
  blocked.source.rightsDecision.status = "pruefung";
  assert.throws(() => validateAlphaFleetMigrationContract(blocked), /nicht ausdruecklich freigegeben/u);
  const foreign = structuredClone(value);
  foreign.source.contentSha256 = "f".repeat(64);
  assert.throws(() => validateAlphaFleetMigrationContract(foreign), /bindet nicht/u);
});

test("Vertragscompiler erzeugt Byte-, kanonische, GTFS- und Operational-Pins aus den real gelesenen Fixture-Bytes", () => {
  const fixture = migrationFixture();
  const validated = validateAlphaFleetMigrationContract(fixture.contract);
  assert.equal(validated.schemaVersion, "zugfolge-alpha-fleet-v1-migration-contract/v2");
  assert.equal(validated.inputs.buildConfiguration.sha256, sha256(fixture.buildConfigurationBytes));
  assert.equal(validated.inputs.buildConfiguration.canonicalSha256, sha256(alphaCanonicalJson(JSON.parse(fixture.buildConfigurationBytes))));
  assert.equal(validated.inputs.gtfs.snapshotHash, JSON.parse(fixture.gtfsBytes).snapshotHash);
  assert.equal(validated.inputs.gtfs.sourceArchiveSha256, SHA_A);
  assert.equal(validated.inputs.infraReleaseWrapper.releaseHash, JSON.parse(fixture.infraReleaseWrapperBytes).releaseHash);
  assert.deepEqual(validated.inputs.operationalInfrastructure, {
    infraReleaseId: "infra-deutschland-fixture.1",
    file: "operational-infrastructure-v2.json",
    bytes: 42,
    sha256: SHA_A,
    stateHash: SHA_B,
  });
});

test("Vertragscompiler-CLI schreibt den aus realen Dateien gepinnten Vertrag ausschliesslich create-new", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-alpha-fleet-contract-"));
  try {
    const fixture = migrationFixture();
    const paths = {
      specification: join(root, "migration-specification.json"),
      buildConfiguration: join(root, FIXTURE_FILE_NAMES.buildConfiguration),
      gtfs: join(root, FIXTURE_FILE_NAMES.gtfs),
      legacy: join(root, "alpha-world-deployment.json"),
      economy: join(root, FIXTURE_FILE_NAMES.economy),
      infraReleaseWrapper: join(root, FIXTURE_FILE_NAMES.infraReleaseWrapper),
      output: join(root, "alpha-fleet-v1-migration-contract-v2.json"),
    };
    await Promise.all([
      writeFile(paths.specification, jsonBytes(contractSpecification(fixture.legacyBytes))),
      writeFile(paths.buildConfiguration, fixture.buildConfigurationBytes),
      writeFile(paths.gtfs, fixture.gtfsBytes),
      writeFile(paths.legacy, fixture.legacyBytes),
      writeFile(paths.economy, fixture.economyBytes),
      writeFile(paths.infraReleaseWrapper, fixture.infraReleaseWrapperBytes),
    ]);
    const argv = [paths.specification, paths.buildConfiguration, paths.gtfs, paths.legacy, paths.economy, paths.infraReleaseWrapper, paths.output];
    await runBuildAlphaFleetMigrationContract(argv);
    const generated = validateAlphaFleetMigrationContract(JSON.parse(await readFile(paths.output)));
    assert.equal(generated.inputs.gtfs.sha256, sha256(fixture.gtfsBytes));
    await assert.rejects(runBuildAlphaFleetMigrationContract(argv), /existiert bereits/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Jahresspezifikation bindet den freigegebenen 490er-Bestand ohne manuell eingetragene Input-Hashes", async () => {
  const [annual, identity] = await Promise.all([
    readFile(new URL("./specifications/alpha-fleet-v1-migration.annual-2026.3.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("./specifications/alpha-world-germany-2026.3.identity.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const validated = validateAlphaFleetMigrationContractSpecification(annual);
  assert.equal(validated.schemaVersion, "zugfolge-alpha-fleet-v1-migration-contract-specification/v1");
  assert.equal(Object.hasOwn(validated, "inputs"), false);
  assert.equal(validated.legacy.assetCount, 490);
  assert.equal(validated.legacy.worldId, OLD_WORLD);
  assert.equal(validated.target.worldId, identity.worldId);
  assert.equal(validated.target.authorityReleaseId, identity.fleetReleaseId);
  assert.equal(validated.target.gtfsReleaseId, "gtfs-de-rv-20260810-c0cba1cfdbf6179b");
  assert.equal(validated.source.contentSha256, validated.legacy.authorityReleaseSha256);
});
