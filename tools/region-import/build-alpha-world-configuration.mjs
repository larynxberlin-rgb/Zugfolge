import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { operationalInfrastructureV2Binding } from "./operational-infrastructure-binding.mjs";
import { unwrapInfraReleaseManifest, validateAlphaWorldBuildConfiguration } from "./build-alpha-world.mjs";

const IDENTITY_SCHEMA = "zugfolge-alpha-world-identity/v1";
const IDENTITY_FIELDS = ["schemaVersion", "worldId", "regionId", "regionVariant", "operatorId", "seed", "fleetReleaseId", "planningAuthority"];

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

export function deriveAlphaWorldBuildConfiguration(identity, releaseWrapper) {
  exactKeys(identity, IDENTITY_FIELDS, "Alpha-Weltidentitaet");
  invariant(identity.schemaVersion === IDENTITY_SCHEMA, "Alpha-Weltidentitaet besitzt ein unbekanntes Schema.");
  const { release } = unwrapInfraReleaseManifest(releaseWrapper);
  const operationalInfrastructure = operationalInfrastructureV2Binding(release);
  const closure = record(release.quality?.operationalClosure, "InfraRelease.quality.operationalClosure");
  const evidence = record(closure.timetableRouteEvidence, "InfraRelease.quality.operationalClosure.timetableRouteEvidence");
  invariant(
    closure.operationalQualityEligible === true
      && closure.unresolvedRequired === 0
      && Number.isSafeInteger(evidence.routesBytes)
      && evidence.routesBytes > 0
      && /^[a-f0-9]{64}$/u.test(evidence.routesSha256 ?? "")
      && evidence.routesSha256 === evidence.routeSetSha256
      && Number.isSafeInteger(evidence.routeRecordCount)
      && evidence.routeRecordCount > 0
      && evidence.routeRecordCount === evidence.completeRouteCount,
    "InfraRelease besitzt keine geschlossene, bytegebundene Timetable-Route-Evidenz.",
  );
  return validateAlphaWorldBuildConfiguration({
    ...structuredClone(identity),
    schemaVersion: "zugfolge-alpha-world-build-configuration/v2",
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
  console.log(JSON.stringify({ worldId: configuration.worldId, operationalInfrastructure: configuration.operationalInfrastructure, timetableRoutes: configuration.timetableRoutes }));
}

const mainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (mainModule) await runBuildAlphaWorldConfiguration();
