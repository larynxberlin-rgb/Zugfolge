import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { operationalInfrastructureV2Binding } from "./operational-infrastructure-binding.mjs";
import { unwrapInfraReleaseManifest, validateAlphaWorldBuildConfiguration } from "./build-alpha-world.mjs";

const IDENTITY_SCHEMA = "zugfolge-alpha-world-identity/v1";
const IDENTITY_FIELDS = ["schemaVersion", "worldId", "regionId", "regionVariant", "operatorId", "seed", "fleetReleaseId", "planningAuthority"];
const SHA256 = /^[a-f0-9]{64}$/u;
const MOVEMENT_ROUTE_TEMPLATES_KIND = "movement-route-templates-v2";
const TIMETABLE_TRANSFER_DEMANDS_KIND = "timetable-transfer-demands-v2";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, name) {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${name} ist kein Objekt.`);
  return value;
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(record(value, name)).sort();
  const wanted = [...expected].sort();
  invariant(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${name} besitzt fehlende oder unbekannte Felder.`);
}

function signedArtifact(release, kind) {
  const matches = Array.isArray(release.artifacts)
    ? release.artifacts.filter((artifact) => artifact?.kind === kind)
    : [];
  invariant(matches.length === 1, `InfraRelease muss genau ein ${kind}-Artefakt binden.`);
  const artifact = matches[0];
  exactKeys(artifact, ["id", "kind", "file", "bytes", "sha256"], `InfraRelease.${kind}`);
  invariant(
    typeof artifact.id === "string"
      && artifact.id !== ""
      && Number.isSafeInteger(artifact.bytes)
      && artifact.bytes > 0
      && SHA256.test(artifact.sha256),
    `InfraRelease.${kind} besitzt keine unveraenderliche Dateibindung.`,
  );
  return artifact;
}

export function deriveAlphaWorldBuildConfiguration(identity, releaseWrapper) {
  exactKeys(identity, IDENTITY_FIELDS, "Alpha-Weltidentitaet");
  invariant(identity.schemaVersion === IDENTITY_SCHEMA, "Alpha-Weltidentitaet besitzt ein unbekanntes Schema.");
  const { release } = unwrapInfraReleaseManifest(releaseWrapper);
  const operationalInfrastructure = operationalInfrastructureV2Binding(release);
  const timetableTransferDemands = signedArtifact(release, TIMETABLE_TRANSFER_DEMANDS_KIND);
  const movementRouteTemplates = signedArtifact(release, MOVEMENT_ROUTE_TEMPLATES_KIND);
  const closure = record(release.quality?.operationalClosure, "InfraRelease.quality.operationalClosure");
  const evidence = record(closure.timetableRouteEvidence, "InfraRelease.quality.operationalClosure.timetableRouteEvidence");
  const movementEvidence = record(closure.movementRouteTemplates, "InfraRelease.quality.operationalClosure.movementRouteTemplates");
  exactKeys(
    movementEvidence,
    ["bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256"],
    "InfraRelease.quality.operationalClosure.movementRouteTemplates",
  );
  invariant(
    closure.operationalQualityEligible === true
      && closure.unresolvedRequired === 0
      && Number.isSafeInteger(evidence.routesBytes)
      && evidence.routesBytes > 0
      && /^[a-f0-9]{64}$/u.test(evidence.routesSha256 ?? "")
      && evidence.routesSha256 === evidence.routeSetSha256
      && Number.isSafeInteger(evidence.routeRecordCount)
      && evidence.routeRecordCount > 0
      && evidence.routeRecordCount === evidence.completeRouteCount
      && timetableTransferDemands.file === "timetable-routes-v2.transfer-demands-v2.json"
      && timetableTransferDemands.bytes === evidence.transferDemandsBytes
      && timetableTransferDemands.sha256 === evidence.transferDemandsSha256
      && SHA256.test(evidence.dailyCirculationPlanSha256)
      && SHA256.test(evidence.transferSetSha256)
      && movementRouteTemplates.file === "operational-infrastructure-v2.movement-route-templates-v2.json"
      && movementRouteTemplates.bytes === movementEvidence.bytes
      && movementRouteTemplates.sha256 === movementEvidence.sha256
      && SHA256.test(movementEvidence.stateHash)
      && movementEvidence.operationalStateHash === operationalInfrastructure.stateHash
      && movementEvidence.timetableTransferSetSha256 === evidence.transferSetSha256,
    "InfraRelease besitzt keine geschlossene, bytegebundene Timetable-Route-Evidenz.",
  );
  return validateAlphaWorldBuildConfiguration({
    ...structuredClone(identity),
    schemaVersion: "zugfolge-alpha-world-build-configuration/v3",
    operationalInfrastructure: {
      file: operationalInfrastructure.file,
      bytes: operationalInfrastructure.bytes,
      sha256: operationalInfrastructure.sha256,
      stateHash: operationalInfrastructure.stateHash,
    },
    timetableRoutes: {
      file: "timetable-routes-v2.jsonseq",
      bytes: evidence.routesBytes,
      sha256: evidence.routesSha256,
    },
    timetableTransferDemands: {
      file: timetableTransferDemands.file,
      bytes: timetableTransferDemands.bytes,
      sha256: timetableTransferDemands.sha256,
      dailyPlanSha256: evidence.dailyCirculationPlanSha256,
      transferSetSha256: evidence.transferSetSha256,
    },
    movementRouteTemplates: {
      file: movementRouteTemplates.file,
      bytes: movementRouteTemplates.bytes,
      sha256: movementRouteTemplates.sha256,
      stateHash: movementEvidence.stateHash,
      operationalStateHash: movementEvidence.operationalStateHash,
      timetableTransferSetSha256: movementEvidence.timetableTransferSetSha256,
    },
  });
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Alpha-Weltbuildkonfiguration existiert bereits; create-new verweigert die Ueberschreibung.");
}

export async function runBuildAlphaWorldConfiguration(argv = process.argv.slice(2)) {
  const [identityPath, releaseWrapperPath, outputPath] = argv;
  if (!outputPath) throw new Error("Aufruf: node build-alpha-world-configuration.mjs ALPHA-WORLD-IDENTITY.json INFRA-RELEASE-WRAPPER.json OUTPUT.json");
  const [identity, releaseWrapper] = await Promise.all([
    readFile(identityPath, "utf8").then(JSON.parse),
    readFile(releaseWrapperPath, "utf8").then(JSON.parse),
  ]);
  const output = resolve(outputPath);
  await assertMissing(output);
  const configuration = deriveAlphaWorldBuildConfiguration(identity, releaseWrapper);
  await writeFile(output, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({
    worldId: configuration.worldId,
    operationalInfrastructure: configuration.operationalInfrastructure,
    timetableRoutes: configuration.timetableRoutes,
    timetableTransferDemands: configuration.timetableTransferDemands,
    movementRouteTemplates: configuration.movementRouteTemplates,
  }));
}

const mainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (mainModule) await runBuildAlphaWorldConfiguration();
