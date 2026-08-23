import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { alphaCanonicalJson, alphaHash } from "../../packages/alpha/dist/index.js";
import { buildEconomyRelease, encodeEconomyValue, parseStartingCapitalPolicy, serializeStartingCapitalPolicy, startEconomyWorld } from "../../packages/economy/dist/index.js";
import { allocatePublicRegionalTrainNumbers, publicRegionalTrainNumber } from "../../packages/livemap/dist/index.js";
import { assertEmbeddedWorldIds, assertNoStarterIdentifiers } from "./alpha-world-variants.mjs";
import {
  assertNormalizedScheduleTimeContract,
  assertRegionalAlphaReleaseContract,
  NORMALIZED_SCHEDULE_REPEAT_EVERY_S,
  NORMALIZED_SCHEDULE_TIME_ZONE,
} from "./regional-release-contract.mjs";
import { assertOperationalInfrastructureV2ReleaseBinding } from "./operational-infrastructure-binding.mjs";
import {
  alphaWorldGenerationSourcesSha256,
  assertVehicleCatalogProofInputs,
  bindVehicleCatalogDeploymentArtifacts,
  compilerFleetFormations,
  selectVehicleCatalogAuthority,
  verifyVehicleCatalogCompilerReplay,
} from "./vehicle-catalog-deployment-binding.mjs";

const [
  gtfsPath,
  networkPath,
  fleetCatalogPath,
  infraReleasePath,
  economySpecPath,
  outputPath,
  publicConfigurationPath,
  operationalV2Path,
  vehicleReceiptPath,
  vehicleInventoryPath,
  vehicleSourceCatalogPath,
  vehicleWorldSeedPath,
  vehicleCompiledCatalogPath,
] = process.argv.slice(2);
if (!gtfsPath || !networkPath || !fleetCatalogPath || !infraReleasePath || !economySpecPath || !outputPath || !publicConfigurationPath || !operationalV2Path) {
  throw new Error("Aufruf: node build-alpha-world.mjs GTFS.json NETWORK.json FLEET-CATALOG.json INFRA-RELEASE.json ECONOMY.json OUTPUT.json PUBLIC-ODOO-CONFIG.json OPERATIONAL-V2.json [VEHICLE-RECEIPT-V4.json VEHICLE-INVENTORY-V2.json VEHICLE-SOURCE-V2.json VEHICLE-WORLD-SEED-V3.json VEHICLE-CATALOG-V3.json]");
}

const WORLD_ID = "00000000-0000-4000-8000-000000000014";
const REGION_ID = "mitteldeutschland-b";
const OPERATOR_ID = "public";
const PUBLIC_WORLD_SEED = 14_2026n;
const PUBLIC_PLANNING_AUTHORITY_ACCOUNT_ID = "00000000-0000-4000-8000-000000000214";
const WORLD_DURATION_S = 365 * 86_400;
const RELEASE_VALID_UNTIL_S = WORLD_DURATION_S + 86_400;

async function loadDeployConfiguration(path, expectedWorldId, expectedKind) {
  if (path === undefined) throw new Error("Produktiver Weltbuild braucht eine explizite Odoo-Signierkonfiguration mit Weltepoche.");
  const configuration = JSON.parse(await readFile(path, "utf8"));
  const definition = configuration?.worldDefinition;
  const epoch = new Date(definition?.epoch);
  if (
    configuration?.schemaVersion !== "zugfolge-alpha-world-deploy-configuration/v1"
    || Object.keys(configuration).length !== 5
    || configuration.worldId !== expectedWorldId
    || !Number.isSafeInteger(configuration.deploymentRevision)
    || configuration.deploymentRevision < 1
    || typeof definition !== "object"
    || definition === null
    || Array.isArray(definition)
    || Object.keys(definition).length !== 5
    || typeof definition.name !== "string"
    || definition.name.trim() === ""
    || definition.kind !== expectedKind
    || definition.rankingStatus !== (expectedKind === "public" ? "ranked" : "unranked")
    || !Number.isSafeInteger(definition.schedulePeriodWeeks)
    || definition.schedulePeriodWeeks < 3
    || definition.schedulePeriodWeeks > 8
    || typeof definition.epoch !== "string"
    || Number.isNaN(epoch.getTime())
    || epoch.getUTCDay() !== 1
    || epoch.getUTCHours() !== 0
    || epoch.getUTCMinutes() !== 0
    || epoch.getUTCSeconds() !== 0
    || epoch.getUTCMilliseconds() !== 0
  ) throw new Error(`Odoo-Signierkonfiguration fuer '${expectedWorldId}' ist ungueltig.`);
  return {
    ...configuration,
    worldDefinition: { ...definition, epoch: epoch.toISOString() },
    startingCapitalPolicy: serializeStartingCapitalPolicy(parseStartingCapitalPolicy(configuration.startingCapitalPolicy)),
  };
}

const publicDeployConfiguration = await loadDeployConfiguration(publicConfigurationPath, WORLD_ID, "public");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function slug(value) {
  return String(value).normalize("NFKD").replaceAll(/\p{Diacritic}/gu, "").replaceAll(/[^a-zA-Z0-9]+/g, "-").replaceAll(/^-|-$/g, "").toLowerCase() || "linie";
}

function startS(chain) {
  const leg = chain.legs[0];
  return leg.kind === "playable" ? leg.stops[0].departureS : leg.scheduledStartS;
}

function endS(chain) {
  const leg = chain.legs.at(-1);
  return leg.kind === "playable" ? leg.stops.at(-1).arrivalS : leg.scheduledEndS;
}

function playableLegs(chain) {
  return chain.legs.filter((leg) => leg.kind === "playable");
}

function startLocation(chain) {
  const leg = chain.legs[0];
  if (leg.kind === "external") return `external-origin:${leg.legId}`;
  return leg.entryPortalId ?? leg.stops[0].stopId;
}

function endLocation(chain) {
  const leg = chain.legs.at(-1);
  if (leg.kind === "external") return `external-destination:${leg.legId}`;
  return leg.exitPortalId ?? leg.stops.at(-1).stopId;
}

function buildCirculations(chains, lotId) {
  const circulations = [];
  const assignment = new Map();
  for (const chain of [...chains].sort((left, right) => startS(left) - startS(right) || left.journeyChainId.localeCompare(right.journeyChainId))) {
    const location = startLocation(chain);
    const available = circulations
      .filter((circulation) => circulation.location === location && circulation.availableAt + 600 <= startS(chain))
      .sort((left, right) => right.availableAt - left.availableAt || left.id.localeCompare(right.id))[0];
    const circulation = available ?? {
      id: `circulation-${lotId}-${String(circulations.length + 1).padStart(3, "0")}`,
      chains: [],
      location,
      availableAt: 0,
    };
    if (available === undefined) circulations.push(circulation);
    circulation.chains.push(chain.journeyChainId);
    circulation.location = endLocation(chain);
    circulation.availableAt = endS(chain);
    assignment.set(chain.journeyChainId, circulation.id);
  }
  return { circulations, assignment };
}

function parseEconomySpec(specification) {
  const bigintKeys = new Set([
    "trackPerTrainKmCents", "stationPerStopCents", "facilityPerHourCents", "energyPerKwhCents",
    "personnelPerHourCents", "administrationPerPeriodCents", "vehiclePerPeriodCents",
    "overnightStablingPerPeriodCents", "protectionEquipmentPerPeriodCents", "contractBonusCentsPerPeriod",
    "punctuality", "cancellation", "seats", "connections",
  ]);
  const convert = (value, key = "") => {
    if (bigintKeys.has(key)) return BigInt(value);
    if (Array.isArray(value)) return value.map((entry) => convert(entry));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, convert(entry, name)]));
    return value;
  };
  return convert(specification);
}

const [
  gtfsBytes,
  networkBytes,
  fleetBytes,
  infraBytes,
  economyBytes,
  operationalV2Bytes,
  generatorBytes,
  vehicleBinderBytes,
  vehicleReceiptBytes,
  vehicleInventoryBytes,
  vehicleSourceCatalogBytes,
  vehicleWorldSeedBytes,
  vehicleCompiledCatalogBytes,
] = await Promise.all([
  readFile(gtfsPath),
  readFile(networkPath),
  readFile(fleetCatalogPath),
  readFile(infraReleasePath),
  readFile(economySpecPath),
  readFile(operationalV2Path),
  readFile(new URL(import.meta.url)),
  readFile(new URL("./vehicle-catalog-deployment-binding.mjs", import.meta.url)),
  vehicleReceiptPath === undefined ? undefined : readFile(vehicleReceiptPath),
  vehicleInventoryPath === undefined ? undefined : readFile(vehicleInventoryPath),
  vehicleSourceCatalogPath === undefined ? undefined : readFile(vehicleSourceCatalogPath),
  vehicleWorldSeedPath === undefined ? undefined : readFile(vehicleWorldSeedPath),
  vehicleCompiledCatalogPath === undefined ? undefined : readFile(vehicleCompiledCatalogPath),
]);
const gtfsEnvelope = JSON.parse(gtfsBytes);
const networkEnvelope = JSON.parse(networkBytes);
const fleetCatalog = JSON.parse(fleetBytes);
const infraRelease = JSON.parse(infraBytes);
const economySpecification = parseEconomySpec(JSON.parse(economyBytes));
const operationalSimulation = JSON.parse(operationalV2Bytes);
const {
  schemaVersion: fleetAuthoritySchema,
  entry: fleetCatalogEntry,
} = selectVehicleCatalogAuthority(fleetCatalog, WORLD_ID);
const vehicleCatalogV2 = assertVehicleCatalogProofInputs(
  fleetAuthoritySchema,
  vehicleReceiptBytes,
  vehicleInventoryBytes,
  vehicleSourceCatalogBytes,
  vehicleWorldSeedBytes,
  vehicleCompiledCatalogBytes,
);
const vehicleReceipt = vehicleReceiptBytes === undefined ? undefined : JSON.parse(vehicleReceiptBytes);
const vehicleInventory = vehicleInventoryBytes === undefined ? undefined : JSON.parse(vehicleInventoryBytes);
const gtfs = gtfsEnvelope.snapshot;
const network = networkEnvelope.network;

const regionalReleaseContract = assertRegionalAlphaReleaseContract({
  gtfsEnvelope,
  gtfsBytesSha256: sha256(gtfsBytes),
  infraRelease,
  worldEpoch: publicDeployConfiguration.worldDefinition.epoch,
});
const scheduleTimeContract = assertNormalizedScheduleTimeContract({
  worldEpoch: publicDeployConfiguration.worldDefinition.epoch,
  serviceDate: regionalReleaseContract.serviceDate,
  timeZone: NORMALIZED_SCHEDULE_TIME_ZONE,
  serviceStartOffsetS: 0,
  repeatEveryS: NORMALIZED_SCHEDULE_REPEAT_EVERY_S,
});
if (network.regionId !== REGION_ID) throw new Error("Betriebsnetz verletzt die Regionsbindung.");
if (gtfs.journeyChains.some((chain) => chain.worldId !== WORLD_ID)) throw new Error("GTFS-Fahrtketten verletzen die UUID-Weltbindung.");
if (networkEnvelope.networkHash !== infraRelease.artifacts.find((artifact) => artifact.kind === "operational-network")?.stateHash) throw new Error("Operational-Network ist nicht im InfraRelease gebunden.");

const qualificationByChain = new Map(network.journeyChainQualifications.map((qualification) => [qualification.journeyChainId, qualification]));
const qualificationBySegment = new Map(network.segmentQualifications.map((qualification) => [qualification.segmentId, qualification]));
const stationMapping = new Map(network.gtfsStationMappings.map((mapping) => [mapping.stopId, mapping]));
const stationById = new Map(network.stations.map((station) => [station.stationId, station]));
const resourceById = new Map(network.resources.map((resource) => [resource.resourceId, resource]));
const chains = gtfs.journeyChains.filter((chain) => qualificationByChain.get(chain.journeyChainId)?.orderable === true);
const publicTrainNumbers = allocatePublicRegionalTrainNumbers(chains.map((chain) => chain.journeyChainId));
if (chains.length !== network.metrics.orderableJourneyChainCount || chains.length === 0) throw new Error("Bestellbarer Fahrplan und Netzqualifikation laufen auseinander.");

const lotsByRoute = new Map();
for (const chain of chains) {
  const key = `${chain.routeId}\u0000${chain.routeShortName}`;
  const values = lotsByRoute.get(key) ?? [];
  values.push(chain);
  lotsByRoute.set(key, values);
}
const lotRecords = [...lotsByRoute].map(([key, values]) => {
  const [routeId, routeShortName] = key.split("\u0000");
  const lotId = `lot-${slug(routeId)}-${slug(routeShortName)}`;
  return { lotId, routeId, routeShortName, serviceLineId: `line-${slug(routeId)}-${slug(routeShortName)}`, chains: values };
}).sort((left, right) => left.lotId.localeCompare(right.lotId));
if (lotRecords.length < 8) throw new Error("Der Vergabekalender braucht mindestens acht getrennte SPNV-Lose.");

const catalogAssets = vehicleCatalogV2
  ? fleetCatalogEntry.authorityRelease.assets
  : fleetCatalog.entries.flatMap((entry) => entry.authorityRelease.assets);
const electricTemplate = catalogAssets.find((asset) => asset.classDesignation === "463.0");
const batteryTemplate = catalogAssets.find((asset) => asset.classDesignation === "563.0");
if (!electricTemplate || !batteryTemplate) throw new Error("Freigegebene elektrische oder Akkutriebzug-Konfiguration fehlt.");

const assets = [];
const personnelPools = [];
const pathReceipts = [];
const formations = [];
const personnelDuties = [];
const pathReservations = [];
const regionalTrains = [];
const blueprintLots = [];
const publicVehiclePoolByLot = {};
let numericAssetId = 10_000;
let numericPersonnelId = 20_000;
let numericRouteId = 30_000;

function routeForLeg(leg) {
  const qualification = qualificationBySegment.get(leg.legId);
  if (qualification?.orderable !== true || qualification.distanceMm === null) throw new Error(`Spielbares Segment ${leg.legId} ist nicht bestellbar.`);
  return leg.stops.map((stop, index) => {
    const mapping = stationMapping.get(stop.stopId);
    if (mapping?.stationId === null || mapping === undefined) throw new Error(`Haltestelle ${stop.stopId} besitzt keine Betriebsstellenabbildung.`);
    const operatingPoint = index === 0 && leg.entryPortalId !== null
      ? leg.entryPortalId
      : index === leg.stops.length - 1 && leg.exitPortalId !== null
        ? leg.exitPortalId
        : mapping.stationId;
    return {
      operatingPoint,
      positionMm: leg.stops.length === 1 ? 0 : Math.floor(qualification.distanceMm * index / (leg.stops.length - 1)),
      arrivalS: stop.arrivalS,
      minimumDwellSeconds: stop.departureS - stop.arrivalS,
      departureS: stop.departureS,
    };
  });
}

for (const [lotIndex, lot] of lotRecords.entries()) {
  const { circulations, assignment } = buildCirculations(lot.chains, lot.lotId);
  const allResources = [...new Set(lot.chains.flatMap((chain) => playableLegs(chain).flatMap((leg) => qualificationBySegment.get(leg.legId).resourceIds)))].sort();
  const fullyElectrified = allResources.length > 0 && allResources.every((resourceId) => {
    const resource = resourceById.get(resourceId);
    return stationById.get(resource.originStationId)?.electrified === true && stationById.get(resource.destinationStationId)?.electrified === true;
  });
  const template = fullyElectrified ? electricTemplate : batteryTemplate;
  const electrifications = fullyElectrified ? ["overhead-ac15kv"] : ["overhead-ac15kv", "unelectrified"];
  const vehicleIds = [];
  const dutyIds = [];
  const circulationIds = [];
  const formationByCirculation = new Map();
  const dutyByCirculation = new Map();

  for (const circulation of circulations) {
    numericAssetId += 1;
    numericPersonnelId += 1;
    numericRouteId += 1;
    const suffix = circulation.id.slice("circulation-".length);
    const assetId = `public-vehicle-${suffix}`;
    const formationId = `formation-${suffix}`;
    const dutyId = `personnel-allocation-${suffix}`;
    const poolId = `personnel-pool-${suffix}`;
    const receiptId = `path-circulation-${suffix}`;
    const asset = {
      ...template,
      id: assetId,
      numericId: numericAssetId,
      operatorId: OPERATOR_ID,
      approvedLineIds: [lot.serviceLineId],
      maintenanceDeadlines: [{ kind: "release-overhaul-validity", dueAt: RELEASE_VALID_UNTIL_S }],
      deliveredAt: 0,
      retiredAt: RELEASE_VALID_UNTIL_S,
    };
    assets.push(asset);
    pathReceipts.push({
      id: receiptId,
      numericRouteId,
      operatorId: OPERATOR_ID,
      serviceLineIds: [lot.serviceLineId],
      decision: "confirmed",
      validFrom: 0,
      validUntil: RELEASE_VALID_UNTIL_S,
      platformLengthsMm: [120_000],
      electrifications,
      requiredProtection: ["pzb"],
      approvedClasses: [template.classDesignation],
      plannerStateHash: networkEnvelope.networkHash,
      conflictCheckHash: sha256(allResources.join("\u0000")),
    });
    personnelPools.push({
      id: poolId,
      numericId: numericPersonnelId,
      operatorId: OPERATOR_ID,
      capacitySeconds: WORLD_DURATION_S,
      minimumRestSeconds: 39_600,
      classDesignations: [template.classDesignation],
      pathReceiptIds: [receiptId],
      qualificationHash: sha256(`${template.classDesignation}\u0000${receiptId}\u0000${networkEnvelope.networkHash}`),
    });
    formations.push({ id: formationId, vehicleIds: [assetId], pathReceiptId: receiptId, dynamics: { accelerationMmPerS2: 900, decelerationMmPerS2: 900 } });
    personnelDuties.push({ id: dutyId, personnelPoolId: poolId, formationIds: [formationId], pathReceiptId: receiptId, validFrom: 0, validUntil: WORLD_DURATION_S });
    formationByCirculation.set(circulation.id, formationId);
    dutyByCirculation.set(circulation.id, dutyId);
    vehicleIds.push(assetId);
    dutyIds.push(dutyId);
    circulationIds.push(circulation.id);
  }

  const pathReceiptIds = [];
  for (const chain of [...lot.chains].sort((left, right) => left.journeyChainId.localeCompare(right.journeyChainId))) {
    numericRouteId += 1;
    const circulationId = assignment.get(chain.journeyChainId);
    const formationId = formationByCirculation.get(circulationId);
    const dutyId = dutyByCirculation.get(circulationId);
    const assetId = assets.find((asset) => formations.find((formation) => formation.id === formationId)?.vehicleIds.includes(asset.id))?.id;
    if (!formationId || !dutyId || !assetId) throw new Error(`Umlaufbindung fuer ${chain.journeyChainId} fehlt.`);
    const receiptId = `path-${chain.journeyChainId}`;
    const chainResources = [...new Set(playableLegs(chain).flatMap((leg) => qualificationBySegment.get(leg.legId).resourceIds))].sort();
    pathReceipts.push({
      id: receiptId,
      numericRouteId,
      operatorId: OPERATOR_ID,
      serviceLineIds: [lot.serviceLineId],
      decision: "confirmed",
      validFrom: 0,
      validUntil: RELEASE_VALID_UNTIL_S,
      platformLengthsMm: [120_000],
      electrifications,
      requiredProtection: ["pzb"],
      approvedClasses: [fullyElectrified ? electricTemplate.classDesignation : batteryTemplate.classDesignation],
      plannerStateHash: networkEnvelope.networkHash,
      conflictCheckHash: sha256(chainResources.join("\u0000")),
    });
    pathReservations.push({ id: `reservation-${chain.journeyChainId}`, pathReceiptId: receiptId });
    pathReceiptIds.push(receiptId);

    const firstLeg = chain.legs[0];
    const initialRoute = firstLeg.kind === "playable"
      ? routeForLeg(firstLeg)
      : [{ operatingPoint: `external-origin:${firstLeg.legId}`, positionMm: 0, arrivalS: firstLeg.scheduledStartS, minimumDwellSeconds: 0, departureS: firstLeg.scheduledStartS }];
    regionalTrains.push({
      trainRunId: chain.journeyChainId,
      operator: OPERATOR_ID,
      trainNumber: publicRegionalTrainNumber(chain.routeShortName, chain.journeyChainId, publicTrainNumbers),
      category: "regional",
      route: initialRoute,
    });

  }
  publicVehiclePoolByLot[lot.lotId] = vehicleIds;
  blueprintLots.push({
    lotId: lot.lotId,
    contractEndsAtPeriod: 2 + (lotIndex % 9),
    trainRunIds: lot.chains.map((chain) => chain.journeyChainId).sort(),
    pathReceiptIds: pathReceiptIds.sort(),
    vehicleIds: vehicleIds.sort(),
    personnelDutyIds: dutyIds.sort(),
    circulationIds: circulationIds.sort(),
    operatingProgramIds: [`operating-program-${lot.lotId}-daily`],
  });
}

const sortedAssets = assets.sort((left, right) => left.id.localeCompare(right.id));
const sortedPersonnelPools = personnelPools.sort((left, right) => left.id.localeCompare(right.id));
const sortedPathReceipts = pathReceipts.sort((left, right) => left.id.localeCompare(right.id));
const sortedFormations = formations.sort((left, right) => left.id.localeCompare(right.id));
const sortedPersonnelDuties = personnelDuties.sort((left, right) => left.id.localeCompare(right.id));
const sortedPathReservations = pathReservations.sort((left, right) => left.id.localeCompare(right.id));
let fleet;
if (vehicleCatalogV2) {
  if (
    alphaCanonicalJson(sortedAssets) !== alphaCanonicalJson(fleetCatalogEntry.authorityRelease.assets)
    || alphaCanonicalJson(sortedPersonnelPools) !== alphaCanonicalJson(fleetCatalogEntry.authorityRelease.personnelPools)
    || alphaCanonicalJson(sortedPathReceipts) !== alphaCanonicalJson(fleetCatalogEntry.authorityRelease.pathReceipts)
  ) {
    throw new Error("Authority-v2 stammt nicht aus demselben Welt-Seed wie der deterministische Alpha-Build.");
  }
  const compiledFormations = compilerFleetFormations(vehicleInventory);
  const generatedFormationBindings = sortedFormations.map(({ id, vehicleIds, pathReceiptId }) => ({ id, vehicleIds, pathReceiptId }));
  const compiledFormationBindings = compiledFormations.map(({ id, vehicleIds, pathReceiptId }) => ({ id, vehicleIds, pathReceiptId }));
  if (alphaCanonicalJson(generatedFormationBindings) !== alphaCanonicalJson(compiledFormationBindings)) {
    throw new Error("Authority-v2 und Alpha-Build besitzen verschiedene initiale Formationen.");
  }
  fleet = {
    schemaVersion: "zugfolge-fleet-world-initialize/v2",
    worldId: WORLD_ID,
    producedAt: fleetCatalogEntry.producedAt,
    authorityRelease: fleetCatalogEntry.authorityRelease,
    formations: compiledFormations,
    personnelDuties: sortedPersonnelDuties,
    pathReservations: sortedPathReservations,
  };
} else {
  fleet = {
    schemaVersion: "zugfolge-fleet-world-initialize/v2",
    worldId: WORLD_ID,
    producedAt: 0,
    authorityRelease: {
      schemaVersion: "zugfolge-fleet-authority-release/v1",
      releaseId: regionalReleaseContract.fleetReleaseId,
      referenceYear: regionalReleaseContract.timetableYear,
      assets: sortedAssets,
      personnelPools: sortedPersonnelPools,
      pathReceipts: sortedPathReceipts,
    },
    formations: sortedFormations,
    personnelDuties: sortedPersonnelDuties,
    pathReservations: sortedPathReservations,
  };
}
const fleetPath = `${resolve(outputPath)}.fleet.json`;
await writeFile(fleetPath, `${JSON.stringify(fleet, null, 2)}\n`);
const fleetProbe = spawnSync("cargo", ["run", "-q", "-p", "zugfolge-runtime", "--example", "fleet_release_hash", "--", fleetPath], { encoding: "utf8" });
if (fleetProbe.status !== 0) throw new Error(`Rust-Fleet-Validierung fehlgeschlagen:\n${fleetProbe.stderr}\n${fleetProbe.stdout}`);
const fleetEvidence = JSON.parse(fleetProbe.stdout.trim().split(/\r?\n/).at(-1));

const economyRelease = buildEconomyRelease({
  version: economySpecification.version,
  rates: economySpecification.rates,
  rules: economySpecification.rules,
  tenderProfiles: economySpecification.tenderProfiles,
});
const economyLots = lotRecords.map((lot) => ({
  id: lot.lotId,
  size: lot.chains.length,
  attractiveness: new Set(lot.chains.flatMap((chain) => playableLegs(chain).flatMap((leg) => leg.stops.map((stop) => stop.stopId)))).size,
}));
const economyStarted = startEconomyWorld({
  worldId: WORLD_ID,
  seed: PUBLIC_WORLD_SEED,
  durationMonths: 12,
  release: economyRelease,
  lots: economyLots,
  authorityBudgets: [],
  accounts: [],
  publicVehiclePoolByLot,
});
const tenderCalendarHash = alphaHash("zugfolge-alpha-tender-calendar/v1", economyStarted.state.calendar);
const planningRoute = regionalTrains
  .map((train) => train.route.filter((waypoint) => {
    const station = stationById.get(waypoint.operatingPoint);
    return station?.latitudeE7 !== null
      && station?.latitudeE7 !== undefined
      && station.longitudeE7 !== null
      && station.longitudeE7 !== undefined;
  }))
  .find((route) => route.length >= 2 && route.every((waypoint, index) => (
    index === 0 || route[index - 1].positionMm < waypoint.positionMm
  )));
if (planningRoute === undefined) throw new Error("Signiertes Planning-Release braucht einen linearen Alpha-Korridor mit Koordinaten.");
const planningInfrastructureRelease = {
  schemaVersion: "planning.infrastructure-release/v1",
  worldId: WORLD_ID,
  releaseId: infraRelease.releaseId,
  sourceId: infraRelease.releaseHash,
  corridorId: `${REGION_ID}-alpha-corridor`,
  corridorName: "Mitteldeutschland Alpha-Korridor",
  stations: planningRoute.map((waypoint, index) => {
    const station = stationById.get(waypoint.operatingPoint);
    if (
      station?.latitudeE7 === null
      || station?.latitudeE7 === undefined
      || station.longitudeE7 === null
      || station.longitudeE7 === undefined
    ) {
      throw new Error(`Planning-Betriebsstelle '${waypoint.operatingPoint}' besitzt keine Koordinaten.`);
    }
    return {
      numericId: index + 1,
      id: station.stationId,
      code: station.stationId,
      name: station.name,
      distanceMm: waypoint.positionMm,
      latitudeE7: station.latitudeE7,
      longitudeE7: station.longitudeE7,
      stationTrackNumericId: 1_000_000 + index,
      stationTrackLengthMm: 400_000,
      stationMaximumSpeedKph: 80,
    };
  }),
  segments: planningRoute.slice(1).map((waypoint, index) => {
    const previous = planningRoute[index];
    const lengthMm = waypoint.positionMm - previous.positionMm;
    return {
      edgeNumericId: 2_000_000 + index,
      trackNumericId: 3_000_000 + index,
      id: `planning-${previous.operatingPoint}-${waypoint.operatingPoint}-${index + 1}`,
      label: `${previous.operatingPoint}–${waypoint.operatingPoint}`,
      fromStationId: previous.operatingPoint,
      toStationId: waypoint.operatingPoint,
      lengthMm,
      maximumSpeedKph: 160,
      mainSignalPositionsMm: [],
      maximumVirtualBlockLengthMm: Math.min(lengthMm, 10_000_000),
    };
  }),
};

function assertOperationalV2Initialization(value) {
  const infra = value?.infraRelease;
  const expectedTrains = new Map(regionalTrains.map((train) => [train.trainRunId, train]));
  if (
    value?.schemaVersion !== "zugfolge-operational-simulation-initialize/v2"
    || value.worldId !== WORLD_ID
    || value.regionId !== REGION_ID
    || value.nowMs !== 0
    || typeof infra !== "object"
    || infra === null
    || Array.isArray(infra)
    || infra.id !== infraRelease.releaseId
    || typeof infra.routeVersions !== "object"
    || infra.routeVersions === null
    || typeof infra.interlockingRoutes !== "object"
    || infra.interlockingRoutes === null
    || !Array.isArray(infra.blockResources)
    || !Array.isArray(value.vehicleTypes)
    || value.vehicleTypes.length === 0
    || !Array.isArray(value.vehicles)
    || value.vehicles.length === 0
    || !Array.isArray(value.formations)
    || value.formations.length === 0
    || !Array.isArray(value.trains)
    || value.trains.length !== expectedTrains.size
  ) throw new Error("Operatives v2-Initialisierungsartefakt ist unvollstaendig oder nicht releasegebunden.");
  const resources = new Set(infra.blockResources);
  const routeTemplates = new Set(Object.values(infra.routeVersions).map((route) => route?.templateId));
  for (const template of Object.values(infra.interlockingRoutes)) {
    const declared = [
      ...(template?.pathResources ?? []),
      ...(template?.overlapResources ?? []),
      ...(template?.flankResources ?? []),
    ];
    if (
      typeof template?.routeTemplateId !== "string"
      || !routeTemplates.has(template.routeTemplateId)
      || declared.length === 0
      || declared.some((resourceId) => !resources.has(resourceId))
    ) throw new Error("Operatives v2-Artefakt besitzt eine fremde Laufweg- oder Ressourcenbindung.");
  }
  const seen = new Set();
  for (const train of value.trains) {
    const expected = expectedTrains.get(train?.id);
    if (
      expected === undefined
      || seen.has(train.id)
      || train.operatorId !== OPERATOR_ID
      || train.trainNumber !== expected.trainNumber
      || train.movementKind !== "train"
      || !Object.hasOwn(infra.routeVersions, train.routeVersionId)
    ) throw new Error("Operatives v2-Artefakt verletzt Fahrt-, Betreiber- oder Laufwegbindung.");
    seen.add(train.id);
  }
  assertOperationalInfrastructureV2ReleaseBinding({
    initialization: value,
    infraReleaseManifest: infraRelease,
    expectedWorldId: WORLD_ID,
    expectedRegionId: REGION_ID,
  });
}

assertOperationalV2Initialization(operationalSimulation);
const operationalSimulationSourceSha256 = sha256(operationalV2Bytes);
const vehicleCompilerEvidence = vehicleCatalogV2
  ? await verifyVehicleCatalogCompilerReplay({
      sourceCatalogPath: vehicleSourceCatalogPath,
      worldSeedPath: vehicleWorldSeedPath,
      compiledCatalogPath: vehicleCompiledCatalogPath,
      fleetCatalogPath,
      operationalInventoryPath: vehicleInventoryPath,
      receiptPath: vehicleReceiptPath,
      fleetAuthority: fleet.authorityRelease,
    })
  : undefined;
const vehicleCatalogBinding = vehicleCatalogV2
  ? bindVehicleCatalogDeploymentArtifacts({
      fleetCatalog,
      receipt: vehicleReceipt,
      operationalInventory: vehicleInventory,
      fleet,
      regionalSimulation: operationalSimulation,
      economyRelease,
      blueprintFleetHash: fleetEvidence.authorityReleaseHash,
      compilerEvidence: vehicleCompilerEvidence,
    })
  : undefined;
const deployment = {
  schema: "zugfolge-alpha-world-deployment/v2",
  worldId: WORLD_ID,
  deploymentRevision: publicDeployConfiguration.deploymentRevision,
  worldDefinition: publicDeployConfiguration.worldDefinition,
  infraReleaseHash: infraRelease.releaseHash,
  blueprint: {
    schemaVersion: "zugfolge-alpha-world-blueprint/v2",
    regionId: REGION_ID,
    regionVariant: "B",
    seed: PUBLIC_WORLD_SEED,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 10,
    startingCapitalPolicy: publicDeployConfiguration.startingCapitalPolicy,
    entryFacilityPolicy: {
      schemaVersion: "zugfolge-public-entry-facility/v1",
      mode: "award-contingent-wet-lease",
      providerOperatorId: OPERATOR_ID,
      costBasis: "formation-operating-cost",
    },
    releases: { infra: infraRelease.releaseHash, timetable: gtfsEnvelope.snapshotHash, fleet: fleetEvidence.authorityReleaseHash, economy: economyRelease.checksum },
    lots: blueprintLots,
    conflictCheckHash: networkEnvelope.networkHash,
    tenderCalendarHash,
  },
  economy: {
    durationMonths: 12,
    release: { schema: economyRelease.schema, version: economyRelease.version, rates: economyRelease.rates, rules: economyRelease.rules, tenderProfiles: economyRelease.tenderProfiles },
    lots: economyLots,
    authorityBudgets: [],
    accounts: [],
    publicVehiclePoolByLot,
  },
  fleet,
  ...(vehicleCatalogBinding === undefined ? {} : { vehicleCatalogBinding }),
  regionalSimulation: operationalSimulation,
  repeatEveryS: scheduleTimeContract.repeatEveryS,
  planning: {
    authority: {
      accountId: PUBLIC_PLANNING_AUTHORITY_ACCOUNT_ID,
      keycloakSubject: `system:planning-authority:${WORLD_ID}`,
      displayName: "Aufgabentraeger Mitteldeutschland Alpha 2026",
    },
    infrastructureRelease: planningInfrastructureRelease,
  },
  provenance: {
    infraReleaseId: infraRelease.releaseId,
    operationalNetworkHash: networkEnvelope.networkHash,
    gtfsSnapshotHash: gtfsEnvelope.snapshotHash,
    fleetSourceSha256: sha256(fleetBytes),
    operationalSimulationSourceSha256,
    generationScriptSha256: alphaWorldGenerationSourcesSha256(generatorBytes, vehicleBinderBytes),
  },
};
assertEmbeddedWorldIds(deployment, WORLD_ID);
assertNoStarterIdentifiers(deployment);

await writeFile(outputPath, `${JSON.stringify({ deployment: encodeEconomyValue(deployment) }, null, 2)}\n`);
console.log(JSON.stringify({
  worldId: WORLD_ID,
  lotCount: blueprintLots.length,
  trainRunCount: regionalTrains.length,
  circulationCount: circulationsCount(blueprintLots),
  vehicleCount: fleet.authorityRelease.assets.length,
  personnelDutyCount: fleet.personnelDuties.length,
  pathReservationCount: fleet.pathReservations.length,
  operationalTrainCount: operationalSimulation.trains.length,
  fleetReleaseHash: fleetEvidence.authorityReleaseHash,
  economyReleaseHash: economyRelease.checksum,
  timetableReleaseHash: gtfsEnvelope.snapshotHash,
  tenderCalendarHash,
}));

function circulationsCount(lots) {
  return lots.reduce((sum, lot) => sum + lot.circulationIds.length, 0);
}
