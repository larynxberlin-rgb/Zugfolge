import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { alphaHash } from "../../packages/alpha/dist/index.js";
import { buildEconomyRelease, encodeEconomyValue, startEconomyWorld } from "../../packages/economy/dist/index.js";

const [gtfsPath, networkPath, fleetCatalogPath, infraReleasePath, economySpecPath, outputPath] = process.argv.slice(2);
if (!gtfsPath || !networkPath || !fleetCatalogPath || !infraReleasePath || !economySpecPath || !outputPath) {
  throw new Error("Aufruf: node build-alpha-world.mjs GTFS.json NETWORK.json FLEET-CATALOG.json INFRA-RELEASE.json ECONOMY.json OUTPUT.json");
}

const WORLD_ID = "00000000-0000-4000-8000-000000000014";
const REGION_ID = "mitteldeutschland-b";
const OPERATOR_ID = "public";
const WORLD_DURATION_S = 365 * 86_400;
const RELEASE_VALID_UNTIL_S = WORLD_DURATION_S + 86_400;

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

const [gtfsBytes, networkBytes, fleetBytes, infraBytes, economyBytes, generatorBytes] = await Promise.all([
  readFile(gtfsPath), readFile(networkPath), readFile(fleetCatalogPath), readFile(infraReleasePath), readFile(economySpecPath), readFile(new URL(import.meta.url)),
]);
const gtfsEnvelope = JSON.parse(gtfsBytes);
const networkEnvelope = JSON.parse(networkBytes);
const fleetCatalog = JSON.parse(fleetBytes);
const infraRelease = JSON.parse(infraBytes);
const economySpecification = parseEconomySpec(JSON.parse(economyBytes));
const gtfs = gtfsEnvelope.snapshot;
const network = networkEnvelope.network;

if (infraRelease.schema !== "zugfolge-infra-release/v1" || !/^[a-f0-9]{64}$/.test(infraRelease.releaseHash)) throw new Error("Signierter InfraRelease fehlt.");
if (infraRelease.regionId !== REGION_ID || network.regionId !== REGION_ID || gtfs.regionId !== REGION_ID) throw new Error("Releaseartefakte verletzen die Regionsbindung.");
if (gtfs.journeyChains.some((chain) => chain.worldId !== WORLD_ID)) throw new Error("GTFS-Fahrtketten verletzen die UUID-Weltbindung.");
if (networkEnvelope.networkHash !== infraRelease.artifacts.find((artifact) => artifact.kind === "operational-network")?.stateHash) throw new Error("Operational-Network ist nicht im InfraRelease gebunden.");

const qualificationByChain = new Map(network.journeyChainQualifications.map((qualification) => [qualification.journeyChainId, qualification]));
const qualificationBySegment = new Map(network.segmentQualifications.map((qualification) => [qualification.segmentId, qualification]));
const stationMapping = new Map(network.gtfsStationMappings.map((mapping) => [mapping.stopId, mapping]));
const stationById = new Map(network.stations.map((station) => [station.stationId, station]));
const resourceById = new Map(network.resources.map((resource) => [resource.resourceId, resource]));
const chains = gtfs.journeyChains.filter((chain) => qualificationByChain.get(chain.journeyChainId)?.orderable === true);
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

const catalogAssets = fleetCatalog.entries.flatMap((entry) => entry.authorityRelease.assets);
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
const boundaryTransitions = [];
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
      trainNumber: `${chain.routeShortName || "SPNV"}-${chain.sourceTripId}`,
      category: "regional",
      route: initialRoute,
    });

    for (const [legIndex, leg] of chain.legs.entries()) {
      if (leg.kind !== "external") continue;
      const nextPlayable = chain.legs.slice(legIndex + 1).find((candidate) => candidate.kind === "playable") ?? null;
      const nextRoute = nextPlayable === null ? [] : routeForLeg(nextPlayable);
      const entryWindow = nextPlayable?.planningWindows.find((window) => window.direction === "entry") ?? null;
      const reentryAt = nextPlayable === null ? null : Math.max(leg.scheduledEndS, entryWindow?.targetS ?? nextPlayable.stops[0].arrivalS);
      const fromPortalId = leg.fromPortalId ?? `external-origin:${leg.legId}`;
      const enterId = `external-enter-${chain.journeyChainId}-${leg.legId}`;
      boundaryTransitions.push({
        transitionId: enterId,
        worldId: WORLD_ID,
        regionId: REGION_ID,
        atS: leg.scheduledStartS,
        command: {
          type: "enter-external-zone",
          trainRunId: chain.journeyChainId,
          externalLeg: {
            journeyChainId: chain.journeyChainId,
            externalLegId: leg.legId,
            fromPortalId,
            toPortalId: leg.toPortalId,
            scheduledStartS: leg.scheduledStartS,
            scheduledEndS: leg.scheduledEndS,
            reentryEarliestS: nextPlayable === null ? null : Math.max(leg.scheduledEndS, entryWindow?.earliestS ?? nextPlayable.stops[0].arrivalS),
            reentryLatestS: nextPlayable === null ? null : Math.max(reentryAt, entryWindow?.latestS ?? nextPlayable.stops[0].departureS),
            fixedCostCents: leg.fixedCostCents,
            boundVehicleIds: [assetId],
            boundPersonnelDutyIds: [dutyId],
            reentryRoute: nextRoute,
            firstResources: nextPlayable === null ? [] : qualificationBySegment.get(nextPlayable.legId).resourceIds.slice(0, 1),
          },
        },
      });
      if (reentryAt !== null) boundaryTransitions.push({
        transitionId: `external-reenter-${chain.journeyChainId}-${leg.legId}`,
        worldId: WORLD_ID,
        regionId: REGION_ID,
        atS: reentryAt,
        command: { type: "reenter-from-external", trainRunId: chain.journeyChainId },
      });
    }
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

function scheduleReentries(transitions) {
  const enterByReentryId = new Map();
  for (const transition of transitions) {
    if (transition.command.type !== "enter-external-zone" || transition.command.externalLeg.reentryEarliestS === null) continue;
    enterByReentryId.set(
      `external-reenter-${transition.command.trainRunId}-${transition.command.externalLeg.externalLegId}`,
      transition,
    );
  }
  const occupiedUntilByResource = new Map();
  for (const transition of transitions
    .filter((entry) => entry.command.type === "reenter-from-external")
    .sort((left, right) => left.atS - right.atS || left.transitionId.localeCompare(right.transitionId))) {
    const enter = enterByReentryId.get(transition.transitionId);
    if (enter === undefined) throw new Error(`Eintrittsvertrag fuer ${transition.transitionId} fehlt.`);
    const contract = enter.command.externalLeg;
    const resource = contract.firstResources[0] ?? null;
    const firstPoint = contract.reentryRoute[0];
    const dwellS = Math.max(1, firstPoint.departureS - firstPoint.arrivalS);
    const earliest = Math.max(transition.atS, resource === null ? 0 : occupiedUntilByResource.get(resource) ?? 0);
    if (earliest > contract.reentryLatestS) throw new Error(`Kein konfliktfreies Grenzfenster fuer ${transition.transitionId}.`);
    transition.atS = earliest;
    if (resource !== null) occupiedUntilByResource.set(resource, earliest + dwellS);
  }
}

scheduleReentries(boundaryTransitions);

// Phase 2: genau ein vorbereitetes, bis zur Beanspruchung inaktives Paket fuer
// den externen Abnahmefall. Es wird Teil desselben gehashten M5-Releases; der
// Game-Writer akzeptiert spaeter weder andere IDs noch clientseitige Fakten.
const STARTER_OPERATOR_ID = "00000000-0000-4000-8000-000000000101";
const starterLot = blueprintLots[0];
if (!starterLot || starterLot.circulationIds.length === 0) throw new Error("Vorbereitetes Phase-2-Startlos fehlt.");
const starterSourceFormation = formations.find((formation) => formation.id === `formation-${starterLot.circulationIds[0].slice("circulation-".length)}`);
const starterSourceAsset = assets.find((asset) => starterSourceFormation?.vehicleIds.includes(asset.id));
const starterSourceReceipt = pathReceipts.find((receipt) => receipt.id === starterSourceFormation?.pathReceiptId);
if (!starterSourceFormation || !starterSourceAsset || !starterSourceReceipt) throw new Error("Vorbereiteter Phase-2-Startpaket-Slot kann nicht aus dem Weltbestand abgeleitet werden.");
numericAssetId += 1;
numericPersonnelId += 1;
numericRouteId += 1;
const starterVehicleId = "starter-vehicle-001";
const starterFormationId = "starter-formation-001";
const starterDutyId = "starter-duty-001";
const starterPoolId = "starter-pool-001";
const starterReceiptId = "starter-receipt-001";
const starterReservationId = "starter-path-001";
assets.push({
  ...starterSourceAsset,
  id: starterVehicleId,
  numericId: numericAssetId,
  operatorId: STARTER_OPERATOR_ID,
  procurementChannel: "leasing",
});
pathReceipts.push({
  ...starterSourceReceipt,
  id: starterReceiptId,
  numericRouteId,
  operatorId: STARTER_OPERATOR_ID,
});
personnelPools.push({
  id: starterPoolId,
  numericId: numericPersonnelId,
  operatorId: STARTER_OPERATOR_ID,
  capacitySeconds: WORLD_DURATION_S,
  minimumRestSeconds: 39_600,
  classDesignations: [starterSourceAsset.classDesignation],
  pathReceiptIds: [starterReceiptId],
  qualificationHash: sha256(`${starterSourceAsset.classDesignation}\u0000${starterReceiptId}\u0000${networkEnvelope.networkHash}`),
});
formations.push({ id: starterFormationId, vehicleIds: [starterVehicleId], pathReceiptId: starterReceiptId, dynamics: { accelerationMmPerS2: 900, decelerationMmPerS2: 900 } });
personnelDuties.push({ id: starterDutyId, personnelPoolId: starterPoolId, formationIds: [starterFormationId], pathReceiptId: starterReceiptId, validFrom: 0, validUntil: WORLD_DURATION_S });
pathReservations.push({ id: starterReservationId, pathReceiptId: starterReceiptId });
const phase2Configuration = {
  authority: {
    tutorialOperatorNamePrefix: "Tutorialbahn",
    startPackageSlots: [{
      worldId: WORLD_ID,
      operatorId: STARTER_OPERATOR_ID,
      operatorName: "Alpha Startbahn 1",
      vehicleId: starterVehicleId,
      formationId: starterFormationId,
      personnelDutyId: starterDutyId,
      pathReservationId: starterReservationId,
      vehicleLeaseReceiptId: "starter-lease-001",
      trainRunIds: starterLot.trainRunIds,
    }],
  },
  startPackage: {
    schemaVersion: "zugfolge-start-package/v1",
    version: "alpha-2026-08",
    emergencyLotId: starterLot.lotId,
    maximumTrainKmPerPeriod: 1_000,
    vehicleClass: starterSourceAsset.classDesignation,
    maximumVehicleValueCents: "900000000",
    durationS: 21 * 86_400,
    pathWindowId: starterReservationId,
    personnelPoolId: starterPoolId,
    operatingProgramTemplateId: "balanced",
  },
};

const fleet = {
  schemaVersion: "zugfolge-fleet-world-initialize/v2",
  worldId: WORLD_ID,
  producedAt: 0,
  authorityRelease: {
    schemaVersion: "zugfolge-fleet-authority-release/v1",
    releaseId: "fleet-alpha-mitteldeutschland-b-2026.1",
    referenceYear: 2026,
    assets: assets.sort((left, right) => left.id.localeCompare(right.id)),
    personnelPools: personnelPools.sort((left, right) => left.id.localeCompare(right.id)),
    pathReceipts: pathReceipts.sort((left, right) => left.id.localeCompare(right.id)),
  },
  formations: formations.sort((left, right) => left.id.localeCompare(right.id)),
  personnelDuties: personnelDuties.sort((left, right) => left.id.localeCompare(right.id)),
  pathReservations: pathReservations.sort((left, right) => left.id.localeCompare(right.id)),
};
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
  seed: 14_2026n,
  durationMonths: 12,
  release: economyRelease,
  lots: economyLots,
  authorityBudgets: [],
  accounts: [],
  publicVehiclePoolByLot,
});
const tenderCalendarHash = alphaHash("zugfolge-alpha-tender-calendar/v1", economyStarted.state.calendar);
const deployment = {
  schema: "zugfolge-alpha-world-deployment/v1",
  worldId: WORLD_ID,
  infraReleaseHash: infraRelease.releaseHash,
  blueprint: {
    schemaVersion: "zugfolge-alpha-world-blueprint/v1",
    regionId: REGION_ID,
    regionVariant: "B",
    seed: 14_2026n,
    profileKind: "public",
    accelerationFactor: 1,
    periodCount: 10,
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
  regionalSimulation: {
    schemaVersion: "zugfolge-regional-simulation-initialize/v1",
    worldId: WORLD_ID,
    regionId: REGION_ID,
    materializationWindowHours: 48,
    nowS: 0,
    trains: regionalTrains.sort((left, right) => left.trainRunId.localeCompare(right.trainRunId)),
  },
  repeatEveryS: 86_400,
  boundaryTransitions: boundaryTransitions.sort((left, right) => left.atS - right.atS || left.transitionId.localeCompare(right.transitionId)),
  provenance: {
    infraReleaseId: infraRelease.releaseId,
    operationalNetworkHash: networkEnvelope.networkHash,
    gtfsSnapshotHash: gtfsEnvelope.snapshotHash,
    fleetSourceSha256: sha256(fleetBytes),
    generationScriptSha256: sha256(generatorBytes),
  },
};
await writeFile(outputPath, `${JSON.stringify({ deployment: encodeEconomyValue(deployment) }, null, 2)}\n`);
await writeFile(`${resolve(outputPath)}.phase2.json`, `${JSON.stringify(phase2Configuration, null, 2)}\n`);
console.log(JSON.stringify({
  worldId: WORLD_ID,
  lotCount: blueprintLots.length,
  trainRunCount: regionalTrains.length,
  circulationCount: circulationsCount(blueprintLots),
  vehicleCount: assets.length,
  personnelDutyCount: personnelDuties.length,
  pathReservationCount: pathReservations.length,
  boundaryTransitionCount: boundaryTransitions.length,
  fleetReleaseHash: fleetEvidence.authorityReleaseHash,
  economyReleaseHash: economyRelease.checksum,
  timetableReleaseHash: gtfsEnvelope.snapshotHash,
  tenderCalendarHash,
  phase2ConfigurationPath: `${resolve(outputPath)}.phase2.json`,
}));

function circulationsCount(lots) {
  return lots.reduce((sum, lot) => sum + lot.circulationIds.length, 0);
}
