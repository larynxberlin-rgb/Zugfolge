import { alphaCanonicalJson, alphaHash } from "../../packages/alpha/dist/index.js";

export const OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA = "operational-infrastructure-v2";

const OPERATIONAL_INFRASTRUCTURE_KEYS = Object.freeze([
  "blockResources",
  "directedEdges",
  "edgeGeometries",
  "id",
  "interlockingRoutes",
  "platformIntervals",
  "regionBoundaries",
  "routeVersions",
  "rzueLayoutId",
  "signals",
  "switches",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(value).sort();
  invariant(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${name} besitzt fehlende, unbekannte oder weltbezogene Felder.`,
  );
}

export function assertOperationalInfrastructureV2(infrastructure) {
  invariant(isRecord(infrastructure), "Operative v2-Infrastruktur ist kein Objekt.");
  exactKeys(infrastructure, OPERATIONAL_INFRASTRUCTURE_KEYS, "Operative v2-Infrastruktur");
  invariant(typeof infrastructure.id === "string" && infrastructure.id !== "", "Operative v2-Infrastruktur besitzt keine Release-ID.");
  invariant(isRecord(infrastructure.directedEdges) && Object.keys(infrastructure.directedEdges).length > 0, "Operative v2-Infrastruktur besitzt keine gerichteten Kanten.");
  invariant(isRecord(infrastructure.edgeGeometries) && Object.keys(infrastructure.edgeGeometries).length > 0, "Operative v2-Infrastruktur besitzt keine Kantengeometrien.");
  invariant(isRecord(infrastructure.routeVersions) && Object.keys(infrastructure.routeVersions).length > 0, "Operative v2-Infrastruktur besitzt keine Laufwegversionen.");
  invariant(isRecord(infrastructure.interlockingRoutes) && Object.keys(infrastructure.interlockingRoutes).length > 0, "Operative v2-Infrastruktur besitzt keine Fahrstrassenvorlagen.");
  invariant(isRecord(infrastructure.platformIntervals), "Operative v2-Infrastruktur besitzt keinen Bahnsteigvertrag.");
  invariant(typeof infrastructure.rzueLayoutId === "string" && infrastructure.rzueLayoutId !== "", "Operative v2-Infrastruktur besitzt keine RZUE-Layoutbindung.");
  for (const key of ["signals", "switches", "blockResources", "regionBoundaries"]) {
    invariant(Array.isArray(infrastructure[key]), `Operative v2-Infrastruktur verletzt ${key}.`);
  }
  invariant(infrastructure.signals.length > 0 && infrastructure.blockResources.length > 0, "Operative v2-Infrastruktur besitzt keine Signale oder Konfliktressourcen.");
}

export function operationalInfrastructureV2StateHash(infrastructure) {
  assertOperationalInfrastructureV2(infrastructure);
  return alphaHash(OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA, infrastructure);
}

export function canonicalOperationalInfrastructureV2Json(infrastructure) {
  assertOperationalInfrastructureV2(infrastructure);
  return alphaCanonicalJson(infrastructure);
}

export function assertOperationalInfrastructureV2ReleaseBinding({
  initialization,
  infraReleaseManifest,
  expectedWorldId,
  expectedRegionId,
}) {
  invariant(isRecord(initialization), "Operative v2-Initialisierung ist kein Objekt.");
  invariant(
    initialization.worldId === expectedWorldId && initialization.regionId === expectedRegionId,
    "Operative v2-Initialisierung verletzt die Welt- oder Regionsbindung.",
  );
  invariant(isRecord(initialization.infraRelease), "Operative v2-Initialisierung besitzt keine statische Infrastruktur.");
  invariant(isRecord(infraReleaseManifest), "Signiertes InfraRelease ist kein Objekt.");
  invariant(!Object.hasOwn(infraReleaseManifest, "worldId"), "Signiertes InfraRelease darf keine Weltbindung enthalten.");
  invariant(
    initialization.infraRelease.id === infraReleaseManifest.releaseId,
    "Operative v2-Infrastruktur verletzt die InfraRelease-ID-Bindung.",
  );
  invariant(Array.isArray(infraReleaseManifest.artifacts), "Signiertes InfraRelease besitzt keine Artefaktliste.");
  const bindings = infraReleaseManifest.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.kind === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
  );
  invariant(bindings.length === 1, "Signiertes InfraRelease muss genau eine operative v2-Infrastruktur binden.");
  exactKeys(
    bindings[0],
    ["bytes", "file", "infraReleaseId", "kind", "sha256", "stateHash"],
    "Operational-v2-Infrastrukturartefakt",
  );
  invariant(
    bindings[0].infraReleaseId === infraReleaseManifest.releaseId,
    "Operational-v2-Infrastrukturartefakt verletzt die InfraRelease-ID-Bindung.",
  );
  invariant(
    bindings[0].file === "operational-infrastructure-v2.json"
      && Number.isSafeInteger(bindings[0].bytes)
      && bindings[0].bytes > 0
      && typeof bindings[0].sha256 === "string"
      && /^[a-f0-9]{64}$/u.test(bindings[0].sha256)
      && bindings[0].sha256 !== bindings[0].stateHash,
    "Operational-v2-Infrastrukturartefakt besitzt keine getrennte kanonische Bytebindung.",
  );
  const expectedStateHash = operationalInfrastructureV2StateHash(initialization.infraRelease);
  invariant(
    typeof bindings[0].stateHash === "string"
      && /^[a-f0-9]{64}$/u.test(bindings[0].stateHash)
      && bindings[0].stateHash === expectedStateHash,
    "Kanonischer Zustandshash der operativen v2-Infrastruktur stimmt nicht mit dem InfraRelease ueberein.",
  );
  return expectedStateHash;
}
