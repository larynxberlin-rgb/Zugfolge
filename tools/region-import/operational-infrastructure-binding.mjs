import { createHash } from "node:crypto";

export const OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA = "operational-infrastructure-v2";
export const OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA = "zugfolge-operational-infrastructure-binding/v2";

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

const INTERLOCKING_RESOURCE_FIELDS = Object.freeze([
  Object.freeze(["pathResources", "Fahrweg"]),
  Object.freeze(["overlapResources", "Durchrutschweg"]),
  Object.freeze(["flankResources", "Flankenschutz"]),
]);

const OPERATIONAL_INFRASTRUCTURE_BINDING_KEYS = Object.freeze([
  "bytes",
  "file",
  "infraReleaseId",
  "schemaVersion",
  "sha256",
  "stateHash",
]);

function operationalCanonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Operational-v2-Zustand enthaelt keine sichere Ganzzahl.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(operationalCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${operationalCanonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Operational-v2-Zustand enthaelt einen nicht kanonisierbaren Wert.");
}

function operationalHash(schema, value) {
  return createHash("sha256").update(operationalCanonicalJson({ schema, value }), "utf8").digest("hex");
}

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
  const blockResources = new Set();
  for (const resource of infrastructure.blockResources) {
    invariant(
      typeof resource === "string" && resource !== "",
      "Operative v2-Infrastruktur besitzt eine ungueltige Konfliktressource.",
    );
    blockResources.add(resource);
  }
  for (const [templateId, candidate] of Object.entries(infrastructure.interlockingRoutes)) {
    invariant(isRecord(candidate), `Fahrstrassenvorlage '${templateId}' ist kein Objekt.`);
    for (const [field, label] of INTERLOCKING_RESOURCE_FIELDS) {
      const resources = candidate[field];
      invariant(
        Array.isArray(resources) && resources.length > 0,
        `Fahrstrassenvorlage '${templateId}' besitzt keinen nichtleeren ${label}.`,
      );
      for (const resource of resources) {
        invariant(
          typeof resource === "string" && resource !== "" && blockResources.has(resource),
          `Fahrstrassenvorlage '${templateId}' verweist im ${label} auf keine vorhandene blockResources-Ressource.`,
        );
      }
    }
  }
}

export function operationalInfrastructureV2StateHash(infrastructure) {
  assertOperationalInfrastructureV2(infrastructure);
  return operationalHash(OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA, infrastructure);
}

export function canonicalOperationalInfrastructureV2Json(infrastructure) {
  assertOperationalInfrastructureV2(infrastructure);
  return operationalCanonicalJson(infrastructure);
}

function operationalInfrastructureArtifact(infraReleaseManifest) {
  invariant(isRecord(infraReleaseManifest), "Signiertes InfraRelease ist kein Objekt.");
  invariant(!Object.hasOwn(infraReleaseManifest, "worldId"), "Signiertes InfraRelease darf keine Weltbindung enthalten.");
  invariant(
    typeof infraReleaseManifest.releaseId === "string" && infraReleaseManifest.releaseId !== "",
    "Signiertes InfraRelease besitzt keine Release-ID.",
  );
  invariant(Array.isArray(infraReleaseManifest.artifacts), "Signiertes InfraRelease besitzt keine Artefaktliste.");
  const bindings = infraReleaseManifest.artifacts.filter(
    (artifact) => isRecord(artifact) && artifact.kind === OPERATIONAL_INFRASTRUCTURE_V2_SCHEMA,
  );
  invariant(bindings.length === 1, "Signiertes InfraRelease muss genau eine operative v2-Infrastruktur binden.");
  exactKeys(
    bindings[0],
    ["bytes", "file", "id", "infraReleaseId", "kind", "sha256", "stateHash"],
    "Operational-v2-Infrastrukturartefakt",
  );
  invariant(
    bindings[0].infraReleaseId === infraReleaseManifest.releaseId,
    "Operational-v2-Infrastrukturartefakt verletzt die InfraRelease-ID-Bindung.",
  );
  invariant(
    typeof bindings[0].id === "string"
      && bindings[0].id !== ""
      && bindings[0].file === "operational-infrastructure-v2.json"
      && Number.isSafeInteger(bindings[0].bytes)
      && bindings[0].bytes > 0
      && typeof bindings[0].sha256 === "string"
      && /^[a-f0-9]{64}$/u.test(bindings[0].sha256)
      && typeof bindings[0].stateHash === "string"
      && /^[a-f0-9]{64}$/u.test(bindings[0].stateHash)
      && bindings[0].sha256 !== bindings[0].stateHash,
    "Operational-v2-Infrastrukturartefakt besitzt keine getrennte kanonische Byte- und Zustandsbindung.",
  );
  return bindings[0];
}

/**
 * Erzeugt die einzige in Weltdeployments erlaubte, kompakte Referenz. Die
 * statischen Deutschland-Bytes bleiben im signierten Release und werden nie
 * in den dynamischen Weltvertrag kopiert.
 */
export function operationalInfrastructureV2Binding(infraReleaseManifest) {
  const artifact = operationalInfrastructureArtifact(infraReleaseManifest);
  return Object.freeze({
    schemaVersion: OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
    infraReleaseId: artifact.infraReleaseId,
    file: artifact.file,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    stateHash: artifact.stateHash,
  });
}

export function assertOperationalInfrastructureV2Binding(binding) {
  invariant(isRecord(binding), "Operative v2-Infrastrukturbindung ist kein Objekt.");
  exactKeys(binding, OPERATIONAL_INFRASTRUCTURE_BINDING_KEYS, "Operative v2-Infrastrukturbindung");
  invariant(
    binding.schemaVersion === OPERATIONAL_INFRASTRUCTURE_BINDING_SCHEMA,
    "Operative v2-Infrastrukturbindung besitzt ein unbekanntes Schema.",
  );
  invariant(
    typeof binding.infraReleaseId === "string" && binding.infraReleaseId !== ""
      && binding.file === "operational-infrastructure-v2.json"
      && Number.isSafeInteger(binding.bytes) && binding.bytes > 0
      && typeof binding.sha256 === "string" && /^[a-f0-9]{64}$/u.test(binding.sha256)
      && typeof binding.stateHash === "string" && /^[a-f0-9]{64}$/u.test(binding.stateHash)
      && binding.sha256 !== binding.stateHash,
    "Operative v2-Infrastrukturbindung ist unvollstaendig.",
  );
  return binding;
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
  const binding = assertOperationalInfrastructureV2Binding(initialization.infraRelease);
  const artifact = operationalInfrastructureArtifact(infraReleaseManifest);
  invariant(
    binding.infraReleaseId === infraReleaseManifest.releaseId,
    "Operative v2-Infrastruktur verletzt die InfraRelease-ID-Bindung.",
  );
  invariant(
    binding.file === artifact.file
      && binding.bytes === artifact.bytes
      && binding.sha256 === artifact.sha256
      && binding.stateHash === artifact.stateHash,
    "Kompakte Operational-v2-Infrastrukturbindung stimmt nicht bytegenau mit dem signierten InfraRelease ueberein.",
  );
  return binding.stateHash;
}
