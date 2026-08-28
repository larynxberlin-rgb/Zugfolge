import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifyEd25519,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { QualifiedInfraPackageCandidate } from "@zugfolge/alpha";

import { canonicalEd25519SpkiPublicKeyPem } from "./trusted-release-keys.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const FINALIZATION_NONCE = /^[a-f0-9]{64}$/;
const PART_BYTES = 100 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const PACKAGE_SCHEMA = "zugfolge-map-package/v2";
const DELIVERY_SCHEMA = "zugfolge-map-delivery-release/v2";
const SOURCES_SCHEMA = "zugfolge-map-delivery-sources/v2";
const MAP_ASSET_NOTICES_SCHEMA = "zugfolge-map-asset-notices/v2";
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const QUALITY_SCHEMA = "zugfolge-operational-infrastructure-quality-report/v1";
const STATIC_MAP_QUALITY_SCHEMA = "zugfolge-static-map-quality/v2";
const STATIC_MAP_SOURCE_QUALITY_SCHEMA = "zugfolge-final-infrastructure-quality-report/v1";
const OPERATIONAL_INFRASTRUCTURE_KIND = "operational-infrastructure-v2";
const MOVEMENT_ROUTE_TEMPLATES_KIND = "movement-route-templates-v2";
const TIMETABLE_TRANSFER_DEMANDS_KIND = "timetable-transfer-demands-v2";
const OPERATIONAL_PROVENANCE_SCHEMA = "zugfolge-germany-operational-v2-provenance/v1";
const OPERATIONAL_EXECUTION_PINS_SCHEMA = "zugfolge-germany-operational-v2-execution-pins/v1";
const OPERATIONAL_EXECUTION_PROOF_SCHEMA = "zugfolge-germany-operational-v2-execution-proof/v1";
const OPERATIONAL_AUTHORITY_SCHEMA = "zugfolge-map-build-operational-authority/v1";
const OPERATIONAL_EXECUTION_AUTHORITY_SCHEMA = "zugfolge-operational-v2-execution-authority/v1";
const OPERATIONAL_REBUILD_ATTESTATION_PREDICATE = "https://slsa.dev/provenance/v1";
const OPERATIONAL_EXECUTION_AUTHORITY_PREDICATE = "https://zugfolge.de/attestations/operational-v2-execution-authority/v1";
const OPERATIONAL_REBUILD_ATTESTATION_WORKFLOW = "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml";
const OPERATIONAL_EXECUTION_AUTHORITY_WORKFLOW = "larynxberlin-rgb/Zugfolge/.github/workflows/operational-v2-execution-authority.yml";
const OPERATIONAL_REBUILD_ATTESTATION_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json";
const OPERATIONAL_EXECUTION_AUTHORITY_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-operational-v2-execution-authority.sigstore.json";
const OPERATIONAL_OUTER_EXECUTION_RECEIPT_FILE = "var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json";
const OPERATIONAL_OUTER_EXECUTION_COMPLETION_FILE = `${OPERATIONAL_OUTER_EXECUTION_RECEIPT_FILE}.zugfolge-complete.json`;
const OPERATIONAL_ANNUAL_PLAN_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json";
const OPERATIONAL_ANNUAL_PLAN_COMPLETION_FILE = `${OPERATIONAL_ANNUAL_PLAN_FILE}.zugfolge-complete.json`;
const OPERATIONAL_ANNUAL_START_EVIDENCE_FILE = "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json";
const OPERATIONAL_ANNUAL_START_COMPLETION_FILE = `${OPERATIONAL_ANNUAL_START_EVIDENCE_FILE}.zugfolge-complete.json`;
const OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE = "tools/region-import/germany/operational-windows-anchor-helper.dll";
const OPERATIONAL_RUNNER_BUNDLE_FILE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs";
const OPERATIONAL_RUNNER_ENTRYPOINT_FILE = "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs";
const OPERATIONAL_RUNNER_INVOCATION_MODE = "system-launcher-held-bundle-stdin-v1";
// FINAL-REPIN 2026.5: Diesen einen Vertrag nach dem letzten attestierten
// Windows-Lauf atomar aus der finalen Execution-Pins-Datei aktualisieren.
export const GERMANY_2026_5_OPERATIONAL_REPIN = Object.freeze({
  executionPins: Object.freeze({
    file: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
    bytes: 4_841,
    sha256: "3dbaa34ef53f9acb2b0e8fa6c90d248215ce7f766d1e1c34cea54853c1e19990",
    schema: OPERATIONAL_EXECUTION_PINS_SCHEMA,
  }),
  runtime: Object.freeze({
    id: "nodejs-24-operational-runner-v1",
    platform: "win32",
    bytes: 92_825_416,
    sha256: "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237",
  }),
  anchorHelper: Object.freeze({
    file: OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
    bytes: 55_808,
    sha256: "0f35d5b7b22c93055011ee603dc1b30e8c94b5cac41c1e6f9edb50fc596027fd",
  }),
  bundle: Object.freeze({
    file: OPERATIONAL_RUNNER_BUNDLE_FILE,
    bytes: 624_565,
    sha256: "10e6ae728c92ad7146bdd8c951a7e529760b9e18a8075c2026eab8cf55480d1f",
  }),
  entrypoint: Object.freeze({
    file: OPERATIONAL_RUNNER_ENTRYPOINT_FILE,
    bytes: 26_551,
    sha256: "266a142f311b85f38c3c68bbff355e7b38216110a9fb3419b9e3841b58901a32",
  }),
  validator: Object.freeze({
    buildCommit: "aba354ec1937452a491087626ec0adea36ef6695",
    preserved: Object.freeze({
      file: "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-aba354ec1937452a491087626ec0adea36ef6695-c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4.exe",
      bytes: 8_382_277,
      sha256: "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4",
    }),
    executedMode: "windows-exclusive-handle-launch-v1",
  }),
  launcher: Object.freeze({
    file: "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1",
    mode: "windows-system-powershell-held-bundle-v1",
    sourceBytes: 17_635,
    sourceSha256: "be26ee6d393a1e769b3d7c27c1a9dacfdac29c4d9ebb477bb26dca25b8a25f2b",
  }),
  importClosure: Object.freeze([
    Object.freeze({ file: "tools/region-import/germany/annual-create-new-artifact.mjs", bytes: 19_192, sha256: "742f388c1df04507a9c6c656faf6f5d3c6195209b373b27385464ff3465a7340" }),
    Object.freeze({ file: "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs", bytes: 2_525, sha256: "4224a650f5673d4c948b4a5d05e84330f975f3f6d0d38a15c353ef960d7930e6" }),
    Object.freeze({ file: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.mjs", bytes: 164_645, sha256: "e0042de4dc8b956d26cd9242f9d0362b3200ba2ce4646e81208e3ea26edab1df" }),
    Object.freeze({ file: "tools/region-import/germany/operational-infrastructure-v2-outer-execution-receipt.mjs", bytes: 23_497, sha256: "19c17314d72359a1114e6c567b91a74fb2b631eddb4f33d3d482bec011855447" }),
    Object.freeze({ file: "tools/region-import/germany/operational-infrastructure-v2-publication.mjs", bytes: 140_209, sha256: "b6f92d0143f9e27b58e49248ee65561122154db0b85ebb689323b1847d7716ac" }),
    Object.freeze({ file: "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1", bytes: 17_635, sha256: "be26ee6d393a1e769b3d7c27c1a9dacfdac29c4d9ebb477bb26dca25b8a25f2b" }),
    Object.freeze({ file: "tools/region-import/germany/operational-infrastructure-v2.mjs", bytes: 93_203, sha256: "a308b29bdece8fbe7e18b0bb513393834cd6e99ccca5121fe7f12b344a24ab43" }),
    Object.freeze({ file: "tools/region-import/germany/operational-validator-rebuild-evidence.mjs", bytes: 244_282, sha256: "7d5aadfef61e2f475c4dd87c1350332831373857f9e14ca76917a8df01ad3abd" }),
    Object.freeze({ file: OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE, bytes: 55_808, sha256: "0f35d5b7b22c93055011ee603dc1b30e8c94b5cac41c1e6f9edb50fc596027fd" }),
    Object.freeze({ file: "tools/region-import/germany/publish-operational-infrastructure-v2.mjs", bytes: 3_180, sha256: "56ca8cb74f2fb3c6147c128116e26a5147866fa507e1d8113273ef81d3ff7aa4" }),
    Object.freeze({ file: "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs", bytes: 26_551, sha256: "266a142f311b85f38c3c68bbff355e7b38216110a9fb3419b9e3841b58901a32" }),
    Object.freeze({ file: "tools/region-import/materialize-operational-infrastructure-v2.mjs", bytes: 22_300, sha256: "fe504130e303c0859bc87bfaa2c370e2d3bd0835b3c25c9a75b0eab02958955e" }),
    Object.freeze({ file: "tools/region-import/operational-infrastructure-binding.mjs", bytes: 9_981, sha256: "a5efe6f0725b9c4ffa82bf42f71f0aa0bf71b8a282802a822dce95ce6b11b16a" }),
    Object.freeze({ file: "tools/tiles/create-new-output.mjs", bytes: 12_485, sha256: "8947e01163310e80fc7b38b1163982e49c376424dcde34df1377e7db8c512d45" }),
  ]),
});
const FINALIZATION_CHALLENGE_SCHEMA = "zugfolge-infra-package-finalization-challenge/v1";
const FINALIZATION_RECEIPT_SCHEMA_V1 = "zugfolge-infra-package-finalization-receipt/v1";
const FINALIZATION_RECEIPT_SCHEMA_V2 = "zugfolge-infra-package-finalization-receipt/v2";
const FINALIZATION_MAX_DURATION_MS = 65 * 60_000;
const LEGACY_DELIVERY_V2_VERSIONS = new Set(["2026.1", "2026.3", "2026.4"]);
const PROVENANCE_DELIVERY_V2_VERSION = "2026.5";
const QUALITY_CLASSES = ["A", "B", "C"] as const;
const OPERATIONAL_COVERAGE_FIELDS = [
  "blockResources", "directedEdges", "edgeGeometries", "interlockingRoutes", "platformIntervals",
  "regionBoundaries", "routeVersions", "rzueLayouts", "signals", "switches",
] as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InfraPackageStagingError(message);
}

export class InfraPackageStagingError extends Error {
  constructor(message: string, readonly code = "invalid_infra_package") {
    super(message);
    this.name = "InfraPackageStagingError";
  }
}

export function germanyOperationalDeliveryV2Generation(version: string): "legacy-v1" | "integrated-provenance-v2" {
  if (version === PROVENANCE_DELIVERY_V2_VERSION) return "integrated-provenance-v2";
  if (LEGACY_DELIVERY_V2_VERSIONS.has(version)) return "legacy-v1";
  throw new InfraPackageStagingError("Paketversion ist nicht als Deutschland-Delivery-v2-Version freigegeben.");
}

function validateGermanyOperationalDeliveryV2Pair(version: string, releaseId: string): "legacy-v1" | "integrated-provenance-v2" {
  const generation = germanyOperationalDeliveryV2Generation(version);
  invariant(releaseId === `infra-deutschland-${version}`, "Delivery-v2 bindet Paketversion und InfraRelease-ID nicht exakt.");
  return generation;
}

function record(value: unknown, label: string): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  const object = record(value, label);
  invariant(
    Object.keys(object).sort().join("\0") === [...expected].sort().join("\0"),
    `${label} besitzt unerwartete oder fehlende Felder.`,
  );
  return object;
}

function qualityClassCounts(value: unknown, label: string): Record<(typeof QUALITY_CLASSES)[number], number> {
  const counts = record(value, label);
  invariant(Object.keys(counts).sort().join(",") === "A,B,C", `${label} muss exakt A, B und C ausweisen.`);
  for (const qualityClass of QUALITY_CLASSES) {
    invariant(Number.isSafeInteger(counts[qualityClass]) && (counts[qualityClass] as number) >= 0, `${label}.${qualityClass} ist keine nichtnegative Ganzzahl.`);
  }
  return counts as Record<(typeof QUALITY_CLASSES)[number], number>;
}

function validateTimetableRouteEvidence(value: unknown): void {
  const evidence = exactKeys(value, [
    "reportSchema", "policyId", "derivationRule", "selectionRule", "reportBytes", "reportSha256",
    "routesBytes", "routesSha256", "gtfsSnapshotBytes", "gtfsSnapshotSha256", "snapshotHash", "archive",
    "archiveSha256", "sourceLicense", "sourceLicenseAsPublished", "selectedSegmentCount", "completeRouteCount",
    "routeRecordCount", "sameStopTransitionCount", "routeSetSha256", "realGeometry",
    "transferDemandsSchema", "transferDemandsBytes", "transferDemandsSha256", "dailyCirculationPlanSha256",
    "transferSetSha256", "transferDemandsProduced", "dailyCirculation", "transferRouteCount",
    "transferRouteLegCount", "transferRouteLengthMm",
    "simulatedOperationalAssignment", "realInterlockingFactsClaimed", "externalOperationalNetworkProvenance",
  ], "Operational-v2.timetableRouteEvidence");
  invariant(
    evidence["reportSchema"] === "zugfolge-germany-timetable-route-report/v4"
      && evidence["policyId"] === "synthetic-operational-b/v2"
      && evidence["derivationRule"] === "all-qualified-gtfs-playable-segments-via-real-osm-stop-anchors/v2"
      && evidence["selectionRule"] === "all-orderable-quality-b-gtfs-playable-segments-with-every-stop-as-anchor/v2"
      && evidence["transferDemandsSchema"] === "zugfolge-timetable-transfer-demands/v2",
    "Operational-v2.timetableRouteEvidence verletzt den freien v4-Fahrweg-/V2-Transfervertrag.",
  );
  invariant(
    [evidence["reportBytes"], evidence["routesBytes"], evidence["gtfsSnapshotBytes"], evidence["transferDemandsBytes"]]
      .every((bytes) => Number.isSafeInteger(bytes) && (bytes as number) > 0)
      && [evidence["reportSha256"], evidence["routesSha256"], evidence["gtfsSnapshotSha256"], evidence["transferDemandsSha256"], evidence["snapshotHash"], evidence["archiveSha256"], evidence["routeSetSha256"], evidence["dailyCirculationPlanSha256"], evidence["transferSetSha256"]]
        .every((hash) => SHA256.test(String(hash)))
      && evidence["routesSha256"] === evidence["routeSetSha256"],
    "Operational-v2.timetableRouteEvidence besitzt keine konsistente Datei-/RouteSet-Bindung.",
  );
  invariant(
    typeof evidence["archive"] === "string" && evidence["archive"] !== ""
      && evidence["sourceLicense"] === "CC-BY-4.0"
      && evidence["sourceLicenseAsPublished"] === "CC BY 4.0",
    "Operational-v2.timetableRouteEvidence besitzt keine freie GTFS-Lizenz- und Archivbindung.",
  );
  invariant(
    Number.isSafeInteger(evidence["selectedSegmentCount"]) && (evidence["selectedSegmentCount"] as number) > 0
      && evidence["selectedSegmentCount"] === evidence["completeRouteCount"]
      && evidence["completeRouteCount"] === evidence["routeRecordCount"]
      && Number.isSafeInteger(evidence["sameStopTransitionCount"]) && (evidence["sameStopTransitionCount"] as number) >= 0,
    "Operational-v2.timetableRouteEvidence schließt die ausgewählten Segmente nicht vollständig 1:1.",
  );
  const daily = exactKeys(evidence["dailyCirculation"], [
    "lotCount", "journeyChainCount", "circulationCount", "rolloverAssignmentCount",
    "plannedTransitionCount", "turnaroundDemandCount", "transferDemandCount", "transferLotCount",
  ], "Operational-v2.timetableRouteEvidence.dailyCirculation");
  invariant(
    ["lotCount", "journeyChainCount", "circulationCount", "rolloverAssignmentCount", "plannedTransitionCount"]
      .every((field) => Number.isSafeInteger(daily[field]) && (daily[field] as number) > 0)
      && ["turnaroundDemandCount", "transferDemandCount", "transferLotCount"]
        .every((field) => Number.isSafeInteger(daily[field]) && (daily[field] as number) >= 0)
      && daily["rolloverAssignmentCount"] === daily["circulationCount"]
      && (daily["turnaroundDemandCount"] as number) + (daily["transferDemandCount"] as number) === daily["plannedTransitionCount"]
      && daily["plannedTransitionCount"] === daily["journeyChainCount"]
      && (daily["transferLotCount"] as number) <= (daily["lotCount"] as number)
      && evidence["transferDemandsProduced"] === true
      && evidence["transferRouteCount"] === daily["transferDemandCount"]
      && Number.isSafeInteger(evidence["transferRouteLegCount"]) && (evidence["transferRouteLegCount"] as number) > 0
      && Number.isSafeInteger(evidence["transferRouteLengthMm"]) && (evidence["transferRouteLengthMm"] as number) > 0,
    "Operational-v2.timetableRouteEvidence besitzt keine vollständige physische Tagesumlauf-/Transferabdeckung.",
  );
  invariant(
    evidence["realGeometry"] === true
      && evidence["simulatedOperationalAssignment"] === true
      && evidence["realInterlockingFactsClaimed"] === false
      && evidence["externalOperationalNetworkProvenance"] === false,
    "Operational-v2.timetableRouteEvidence verletzt die ehrliche Geometrie-/Provenienzgrenze.",
  );
}

function validateOperationalQuality(
  value: unknown,
  releaseId: string,
  deliveredOperationalArtifact: { readonly bytes: number; readonly sha256: string; readonly stateHash?: string },
  deliveredMovementRouteTemplatesArtifact: { readonly bytes: number; readonly sha256: string },
  deliveredTransferDemandsArtifact: { readonly bytes: number; readonly sha256: string },
): { readonly visibleLayers: number; readonly visibleFeatures: number; readonly visibleMapClassCFeatureCount: number } {
  const quality = exactKeys(value, [
    "schema", "releaseId", "timetableYear", "scopeId", "deterministic", "separation", "mapEvidence",
    "operationalModel", "summary", "qualityGate",
  ], "Operational-v2-Qualitätsbericht");
  const yearMatch = /^infra-deutschland-(\d{4})(?:\.|$)/.exec(releaseId);
  invariant(
    quality["schema"] === QUALITY_SCHEMA
      && quality["releaseId"] === releaseId
      && yearMatch !== null
      && quality["timetableYear"] === Number(yearMatch[1])
      && quality["scopeId"] === "deutschland-ebo-operational-v2"
      && quality["deterministic"] === true,
    "Operational-v2-Qualitätsbericht verletzt Schema, Release, Jahr oder Scope.",
  );

  const separation = exactKeys(quality["separation"], [
    "mapEvidencePurpose", "operationalEvidencePurpose", "mapClassCReclassified",
    "mapClassCBlocksOperationalQualityGate", "mapObjectsRemoved",
  ], "Operational-v2.separation");
  invariant(
    separation["mapEvidencePurpose"] === "visible-map-quality-evidence"
      && separation["operationalEvidencePurpose"] === "closed-operational-v2-model"
      && separation["mapClassCReclassified"] === false
      && separation["mapClassCBlocksOperationalQualityGate"] === false
      && separation["mapObjectsRemoved"] === false,
    "Operational-v2-Qualitätsbericht deklariert sichtbare Karten-C um oder entfernt Kartenobjekte.",
  );

  const map = exactKeys(quality["mapEvidence"], [
    "schema", "mapReleaseId", "infrastructureCorpusId", "bytes", "sha256", "sourceReport", "visibleFeatures",
    "visibleLayers", "qualityClassFeatureCount", "trackLengthMm", "trackQualityClassLengthMm",
  ], "Operational-v2.mapEvidence");
  const mapClasses = qualityClassCounts(map["qualityClassFeatureCount"], "Operational-v2.mapEvidence.qualityClassFeatureCount");
  const trackClasses = qualityClassCounts(map["trackQualityClassLengthMm"], "Operational-v2.mapEvidence.trackQualityClassLengthMm");
  const sourceReport = exactKeys(map["sourceReport"], ["schema", "bytes", "sha256", "shipped"], "Operational-v2.mapEvidence.sourceReport");
  invariant(
    map["schema"] === STATIC_MAP_QUALITY_SCHEMA
      && typeof map["mapReleaseId"] === "string" && map["mapReleaseId"] !== ""
      && map["infrastructureCorpusId"] === releaseId
      && Number.isSafeInteger(map["bytes"]) && (map["bytes"] as number) > 0 && SHA256.test(String(map["sha256"]))
      && map["visibleLayers"] === 10
      && Number.isSafeInteger(map["visibleFeatures"]) && (map["visibleFeatures"] as number) > 0
      && QUALITY_CLASSES.reduce((sum, qualityClass) => sum + mapClasses[qualityClass], 0) === map["visibleFeatures"]
      && Number.isSafeInteger(map["trackLengthMm"]) && (map["trackLengthMm"] as number) > 0
      && QUALITY_CLASSES.reduce((sum, qualityClass) => sum + trackClasses[qualityClass], 0) === map["trackLengthMm"]
      && sourceReport["schema"] === STATIC_MAP_SOURCE_QUALITY_SCHEMA
      && Number.isSafeInteger(sourceReport["bytes"]) && (sourceReport["bytes"] as number) > 0
      && SHA256.test(String(sourceReport["sha256"])) && sourceReport["shipped"] === false,
    "Operational-v2.mapEvidence besitzt keine ehrliche sichtbare Static-Map-v2-Bindung.",
  );

  const model = exactKeys(quality["operationalModel"], [
    "policyId", "policySha256", "closureReceiptSha256", "qualityClass", "provenance", "realGeometry",
    "simulatedOperationalAssignment", "realInterlockingFactsClaimed", "syntheticOperationalDetailsShipped",
    "objectLevelProvenanceShipped", "observedAndSyntheticObjectsShareRuntimeCollections", "movementRouteTemplates", "timetableRouteEvidence",
    "operationalArtifact", "coverage",
  ], "Operational-v2.operationalModel");
  invariant(
    model["policyId"] === "synthetic-operational-b/v2"
      && SHA256.test(String(model["policySha256"])) && SHA256.test(String(model["closureReceiptSha256"]))
      && model["qualityClass"] === "B" && model["provenance"] === "derived"
      && model["realGeometry"] === true && model["simulatedOperationalAssignment"] === true
      && model["realInterlockingFactsClaimed"] === false
      && model["syntheticOperationalDetailsShipped"] === true
      && model["objectLevelProvenanceShipped"] === false
      && model["observedAndSyntheticObjectsShareRuntimeCollections"] === true,
    "Operational-v2.operationalModel besitzt keine ehrliche geschlossene Derived/B-Provenienz.",
  );
  validateTimetableRouteEvidence(model["timetableRouteEvidence"]);
  const timetableRouteEvidence = record(model["timetableRouteEvidence"], "Operational-v2.timetableRouteEvidence");
  invariant(
    timetableRouteEvidence["policyId"] === model["policyId"],
    "Operational-v2-Fahrwegbeleg und Betriebsmodell binden verschiedene Policies.",
  );
  invariant(
    timetableRouteEvidence["transferDemandsBytes"] === deliveredTransferDemandsArtifact.bytes
      && timetableRouteEvidence["transferDemandsSha256"] === deliveredTransferDemandsArtifact.sha256,
    "Operational-v2-Fahrwegbeleg bindet nicht bytegenau das ausgelieferte Timetable-Transfer-Demands-v2-Artefakt.",
  );
  const movementRouteTemplates = exactKeys(model["movementRouteTemplates"], [
    "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256",
  ], "Operational-v2.movementRouteTemplates");
  invariant(
    Number.isSafeInteger(movementRouteTemplates["bytes"]) && (movementRouteTemplates["bytes"] as number) > 0
      && [movementRouteTemplates["sha256"], movementRouteTemplates["stateHash"], movementRouteTemplates["operationalStateHash"], movementRouteTemplates["timetableTransferSetSha256"]]
        .every((hash) => SHA256.test(String(hash)))
      && movementRouteTemplates["sha256"] !== movementRouteTemplates["stateHash"]
      && movementRouteTemplates["bytes"] === deliveredMovementRouteTemplatesArtifact.bytes
      && movementRouteTemplates["sha256"] === deliveredMovementRouteTemplatesArtifact.sha256
      && movementRouteTemplates["timetableTransferSetSha256"] === timetableRouteEvidence["transferSetSha256"],
    "Operational-v2-Movement-Beleg bindet nicht bytegenau das ausgelieferte Movement-Route-Templates-v2-Artefakt und Transfer-Set.",
  );
  const operationalArtifact = exactKeys(model["operationalArtifact"], ["bytes", "sha256", "stateHash"], "Operational-v2.operationalArtifact");
  invariant(
    Number.isSafeInteger(operationalArtifact["bytes"]) && (operationalArtifact["bytes"] as number) > 0
      && SHA256.test(String(operationalArtifact["sha256"])) && SHA256.test(String(operationalArtifact["stateHash"]))
      && operationalArtifact["sha256"] !== operationalArtifact["stateHash"]
      && operationalArtifact["bytes"] === deliveredOperationalArtifact.bytes
      && operationalArtifact["sha256"] === deliveredOperationalArtifact.sha256
      && operationalArtifact["stateHash"] === deliveredOperationalArtifact.stateHash,
    "Operational-v2-Qualität bindet nicht exakt das ausgelieferte Betriebsartefakt und seinen Zustand.",
  );
  invariant(
    movementRouteTemplates["operationalStateHash"] === operationalArtifact["stateHash"],
    "Operational-v2-Movement-Beleg bindet einen anderen Operational-v2-Zustand.",
  );
  const coverage = exactKeys(model["coverage"], OPERATIONAL_COVERAGE_FIELDS, "Operational-v2.coverage");
  invariant(
    OPERATIONAL_COVERAGE_FIELDS.every((field) => Number.isSafeInteger(coverage[field]) && (coverage[field] as number) > 0)
      && coverage["directedEdges"] === coverage["edgeGeometries"]
      && coverage["rzueLayouts"] === 1,
    "Operational-v2.coverage ist nicht vollständig geschlossen.",
  );

  const summary = exactKeys(quality["summary"], [
    "operationalQualityClassArtifactCount", "unresolvedRequired", "visibleMapClassCFeatureCount",
  ], "Operational-v2.summary");
  const operationalClasses = qualityClassCounts(summary["operationalQualityClassArtifactCount"], "Operational-v2.summary.operationalQualityClassArtifactCount");
  invariant(
    operationalClasses.A === 0 && operationalClasses.B === 1 && operationalClasses.C === 0
      && summary["unresolvedRequired"] === 0
      && summary["visibleMapClassCFeatureCount"] === mapClasses.C,
    "Operational-v2-Qualität besitzt keine getrennte geschlossene B=1/C=0-Bilanz oder verschweigt sichtbare Karten-C.",
  );
  const qualityGate = exactKeys(quality["qualityGate"], [
    "closureReceiptVerified", "nativeOperationalValidationVerified", "operationalClassCZero",
    "ordinaryAssumptionsPromoted", "mapClassCReclassified", "operationalQualityEligible", "signatureImplied",
    "activationImplied",
  ], "Operational-v2.qualityGate");
  invariant(
    qualityGate["closureReceiptVerified"] === true
      && qualityGate["nativeOperationalValidationVerified"] === true
      && qualityGate["operationalClassCZero"] === true
      && qualityGate["ordinaryAssumptionsPromoted"] === false
      && qualityGate["mapClassCReclassified"] === false
      && qualityGate["operationalQualityEligible"] === true
      && qualityGate["signatureImplied"] === false
      && qualityGate["activationImplied"] === false,
    "Operational-v2-Qualitätsgate ist offen, umklassifiziert Karten-C oder behauptet Signatur/Aktivierung.",
  );
  return {
    visibleLayers: map["visibleLayers"] as number,
    visibleFeatures: map["visibleFeatures"] as number,
    visibleMapClassCFeatureCount: mapClasses.C,
  };
}

function safeId(value: unknown, label: string): string {
  invariant(typeof value === "string" && SAFE_ID.test(value), `${label} ist keine sichere ID.`);
  return value;
}

function portablePath(value: unknown, label: string): string {
  invariant(typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") && !value.includes("://") && !value.startsWith("/") && !/^[a-z]:/i.test(value), `${label} ist kein sicherer relativer Pfad.`);
  invariant(value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthält ein unsicheres Segment.`);
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalManifest(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value: unknown, label: string): number {
  invariant(Number.isSafeInteger(value) && (value as number) > 0, `${label} muss eine positive sichere Ganzzahl sein.`);
  return value as number;
}

function operationalSha256(value: unknown, label: string): string {
  invariant(typeof value === "string" && SHA256.test(value), `${label} ist kein SHA-256.`);
  return value;
}

function operationalFileProof(value: unknown, label: string, withSchema = false): Record<string, unknown> {
  const proof = exactKeys(value, withSchema ? ["file", "bytes", "sha256", "schema"] : ["file", "bytes", "sha256"], label);
  const file = portablePath(proof["file"], `${label}.file`);
  invariant(file.length <= 512, `${label}.file ist zu lang.`);
  positiveInteger(proof["bytes"], `${label}.bytes`);
  operationalSha256(proof["sha256"], `${label}.sha256`);
  if (withSchema) invariant(typeof proof["schema"] === "string" && proof["schema"] !== "", `${label}.schema fehlt.`);
  return proof;
}

function operationalStringList(value: unknown, label: string): readonly string[] {
  invariant(Array.isArray(value), `${label} muss eine Liste sein.`);
  for (const [index, entry] of value.entries()) {
    invariant(
      typeof entry === "string" && entry.length > 0 && entry.length <= 1024 && !entry.includes("\0"),
      `${label}[${index}] ist ungueltig.`,
    );
  }
  return value as string[];
}

function validateOperationalProvenance(value: unknown): {
  readonly value: Record<string, unknown>;
  readonly sha256: string;
  readonly executionProofSha256: string;
  readonly validatorSha256: string;
} {
  const provenance = exactKeys(value, [
    "schema", "producerKind", "releaseEvidenceEligible", "productionActivationEligible", "executionPins", "executionProof",
  ], "Delivery Operational-v2-Provenienz");
  invariant(
    provenance["schema"] === OPERATIONAL_PROVENANCE_SCHEMA
      && provenance["producerKind"] === "integrated-runner-v1"
      && provenance["releaseEvidenceEligible"] === true
      && provenance["productionActivationEligible"] === true,
    "Delivery-v2 akzeptiert nur integrierte, evidence- und aktivierungsgeeignete Operational-v2-Provenienz.",
  );
  const pins = operationalFileProof(provenance["executionPins"], "Delivery Operational-v2-Provenienz.executionPins", true);
  invariant(
    pins["file"] === GERMANY_2026_5_OPERATIONAL_REPIN.executionPins.file
      && pins["bytes"] === GERMANY_2026_5_OPERATIONAL_REPIN.executionPins.bytes
      && pins["sha256"] === GERMANY_2026_5_OPERATIONAL_REPIN.executionPins.sha256
      && pins["schema"] === GERMANY_2026_5_OPERATIONAL_REPIN.executionPins.schema,
    "Delivery Operational-v2-Provenienz bindet nicht die bytegenaue Execution-Pins-Datei des aktuellen Deutschland-Release.",
  );
  const proof = exactKeys(provenance["executionProof"], [
    "schema", "executionPinsSha256", "runner", "validator", "rebuild", "invocation", "stdout", "exit",
  ], "Delivery Operational-v2-Provenienz.executionProof");
  invariant(
    proof["schema"] === OPERATIONAL_EXECUTION_PROOF_SCHEMA
      && proof["executionPinsSha256"] === pins["sha256"],
    "Delivery Operational-v2-Provenienz bindet Execution-Pins und Execution-Proof verschieden.",
  );
  const runner = exactKeys(proof["runner"], ["anchorHelper", "bundle", "entrypoint", "importClosure", "invocation", "launcher", "runtime"], "Delivery Operational-v2-Provenienz.runner");
  const bundle = operationalFileProof(runner["bundle"], "Delivery Operational-v2-Provenienz.runner.bundle");
  const entrypoint = operationalFileProof(runner["entrypoint"], "Delivery Operational-v2-Provenienz.runner.entrypoint");
  invariant(
    bundle["file"] === GERMANY_2026_5_OPERATIONAL_REPIN.bundle.file
      && bundle["bytes"] === GERMANY_2026_5_OPERATIONAL_REPIN.bundle.bytes
      && bundle["sha256"] === GERMANY_2026_5_OPERATIONAL_REPIN.bundle.sha256,
    "Delivery Operational-v2-Provenienz bindet nicht das bytegenaue gehaltene Runner-Bundle.",
  );
  invariant(
    entrypoint["file"] === GERMANY_2026_5_OPERATIONAL_REPIN.entrypoint.file
      && entrypoint["bytes"] === GERMANY_2026_5_OPERATIONAL_REPIN.entrypoint.bytes
      && entrypoint["sha256"] === GERMANY_2026_5_OPERATIONAL_REPIN.entrypoint.sha256,
    "Delivery Operational-v2-Provenienz bindet nicht den bytegenauen Runner-Entrypoint.",
  );
  const runnerInvocation = exactKeys(runner["invocation"], ["mode", "nodeArguments", "nodeOptions"], "Delivery Operational-v2-Provenienz.runner.invocation");
  const runnerNodeArguments = operationalStringList(runnerInvocation["nodeArguments"], "Delivery Operational-v2-Provenienz.runner.invocation.nodeArguments");
  invariant(
    runnerInvocation["mode"] === OPERATIONAL_RUNNER_INVOCATION_MODE
      && JSON.stringify(runnerNodeArguments) === JSON.stringify(["--input-type=module", "-"])
      && runnerInvocation["nodeOptions"] === null,
    "Delivery Operational-v2-Provenienz.runner.invocation startet nicht exakt das gehaltene ESM-stdin-Bundle.",
  );
  const runtime = exactKeys(runner["runtime"], ["id", "platform", "bytes", "sha256"], "Delivery Operational-v2-Provenienz.runner.runtime");
  positiveInteger(runtime["bytes"], "Delivery Operational-v2-Provenienz.runner.runtime.bytes");
  operationalSha256(runtime["sha256"], "Delivery Operational-v2-Provenienz.runner.runtime.sha256");
  invariant(
    runtime["id"] === GERMANY_2026_5_OPERATIONAL_REPIN.runtime.id
      && runtime["platform"] === GERMANY_2026_5_OPERATIONAL_REPIN.runtime.platform
      && runtime["bytes"] === GERMANY_2026_5_OPERATIONAL_REPIN.runtime.bytes
      && runtime["sha256"] === GERMANY_2026_5_OPERATIONAL_REPIN.runtime.sha256,
    "Delivery Operational-v2-Provenienz.runner.runtime bindet nicht die bytegenaue Runtime des aktuellen Deutschland-Release.",
  );
  const anchorHelper = operationalFileProof(runner["anchorHelper"], "Delivery Operational-v2-Provenienz.runner.anchorHelper");
  invariant(
    runtime["platform"] === "win32"
      && anchorHelper["file"] === GERMANY_2026_5_OPERATIONAL_REPIN.anchorHelper.file
      && anchorHelper["bytes"] === GERMANY_2026_5_OPERATIONAL_REPIN.anchorHelper.bytes
      && anchorHelper["sha256"] === GERMANY_2026_5_OPERATIONAL_REPIN.anchorHelper.sha256,
    "Delivery Operational-v2-Provenienz.runner.anchorHelper bindet nicht die bytegenaue Windows-Anchor-Helper-Assembly.",
  );
  const launcher = exactKeys(runner["launcher"], ["mode", "sourceBytes", "sourceSha256"], "Delivery Operational-v2-Provenienz.runner.launcher");
  const expectedLauncher = GERMANY_2026_5_OPERATIONAL_REPIN.launcher;
  positiveInteger(launcher["sourceBytes"], "Delivery Operational-v2-Provenienz.runner.launcher.sourceBytes");
  operationalSha256(launcher["sourceSha256"], "Delivery Operational-v2-Provenienz.runner.launcher.sourceSha256");
  invariant(
    launcher["mode"] === expectedLauncher.mode
      && launcher["sourceBytes"] === expectedLauncher.sourceBytes
      && launcher["sourceSha256"] === expectedLauncher.sourceSha256,
    "Delivery Operational-v2-Provenienz.runner.launcher bindet nicht exakt den kanonischen win32-Systemlauncher des aktuellen Deutschland-Release.",
  );
  invariant(Array.isArray(runner["importClosure"]) && runner["importClosure"].length > 0, "Delivery Operational-v2-Provenienz besitzt keine Runner-Importclosure.");
  const closure: Record<string, unknown>[] = [];
  let previous: string | undefined;
  let entrypointFound = false;
  let launcherSourceCount = 0;
  let anchorHelperCount = 0;
  for (const [index, entry] of (runner["importClosure"] as unknown[]).entries()) {
    const item = operationalFileProof(entry, `Delivery Operational-v2-Provenienz.runner.importClosure[${index}]`);
    const file = String(item["file"]);
    if (previous !== undefined) invariant(file.localeCompare(previous, "en") > 0, "Delivery Operational-v2-Provenienz.runner.importClosure ist nicht eindeutig sortiert.");
    previous = file;
    closure.push(item);
    if (file === entrypoint["file"] && item["bytes"] === entrypoint["bytes"] && item["sha256"] === entrypoint["sha256"]) entrypointFound = true;
    if (file === expectedLauncher.file) {
      launcherSourceCount += 1;
      invariant(
        item["bytes"] === expectedLauncher.sourceBytes && item["sha256"] === expectedLauncher.sourceSha256,
        "Delivery Operational-v2-Provenienz bindet Launcher-Proof und Launcher-Quelldatei verschieden.",
      );
    }
    if (file === anchorHelper["file"]) {
      anchorHelperCount += 1;
      invariant(
        item["bytes"] === anchorHelper["bytes"] && item["sha256"] === anchorHelper["sha256"],
        "Delivery Operational-v2-Provenienz bindet Anchor-Helper-Proof und Importclosure verschieden.",
      );
    }
  }
  invariant(entrypointFound, "Delivery Operational-v2-Provenienz bindet den Runner-Entrypoint nicht in seiner Importclosure.");
  invariant(launcherSourceCount === 1, "Delivery Operational-v2-Provenienz bindet die kanonische Launcher-Quelldatei nicht exakt einmal in der Importclosure.");
  invariant(anchorHelperCount === 1, "Delivery Operational-v2-Provenienz bindet die Windows-Anchor-Helper-Assembly nicht exakt einmal in der Importclosure.");
  invariant(
    closure.length === GERMANY_2026_5_OPERATIONAL_REPIN.importClosure.length
      && closure.every((item, index) => {
        const expected = GERMANY_2026_5_OPERATIONAL_REPIN.importClosure[index]!;
        return item["file"] === expected.file && item["bytes"] === expected.bytes && item["sha256"] === expected.sha256;
      }),
    "Delivery Operational-v2-Provenienz bindet nicht die bytegenaue streng sortierte Importclosure des aktuellen Deutschland-Release.",
  );
  const validator = exactKeys(proof["validator"], ["buildCommit", "preserved", "executed"], "Delivery Operational-v2-Provenienz.validator");
  invariant(
    validator["buildCommit"] === GERMANY_2026_5_OPERATIONAL_REPIN.validator.buildCommit,
    "Delivery Operational-v2-Provenienz bindet nicht den Build-Commit des aktuellen preserved Validators.",
  );
  const preserved = operationalFileProof(validator["preserved"], "Delivery Operational-v2-Provenienz.validator.preserved");
  invariant(
    preserved["file"] === GERMANY_2026_5_OPERATIONAL_REPIN.validator.preserved.file
      && preserved["bytes"] === GERMANY_2026_5_OPERATIONAL_REPIN.validator.preserved.bytes
      && preserved["sha256"] === GERMANY_2026_5_OPERATIONAL_REPIN.validator.preserved.sha256,
    "Delivery Operational-v2-Provenienz bindet nicht den bytegenauen preserved Validator des aktuellen Deutschland-Release.",
  );
  const executed = exactKeys(validator["executed"], ["mode", "bytes", "sha256"], "Delivery Operational-v2-Provenienz.validator.executed");
  const executedBytes = positiveInteger(executed["bytes"], "Delivery Operational-v2-Provenienz.validator.executed.bytes");
  const executedSha256 = operationalSha256(executed["sha256"], "Delivery Operational-v2-Provenienz.validator.executed.sha256");
  invariant(
    executed["mode"] === GERMANY_2026_5_OPERATIONAL_REPIN.validator.executedMode
      && executedBytes === preserved["bytes"]
      && executedSha256 === preserved["sha256"],
    "Delivery Operational-v2-Provenienz bindet nicht dieselben preserved und ausgefuehrten Validator-Bytes.",
  );
  const rebuild = exactKeys(proof["rebuild"], ["specification", "evidence", "sourceCommit"], "Delivery Operational-v2-Provenienz.rebuild");
  operationalFileProof(rebuild["specification"], "Delivery Operational-v2-Provenienz.rebuild.specification");
  operationalFileProof(rebuild["evidence"], "Delivery Operational-v2-Provenienz.rebuild.evidence", true);
  invariant(typeof rebuild["sourceCommit"] === "string" && rebuild["sourceCommit"] === validator["buildCommit"] && GIT_COMMIT.test(rebuild["sourceCommit"]), "Delivery Operational-v2-Provenienz bindet Rebuild und Validator an verschiedene Commits.");
  const invocation = exactKeys(proof["invocation"], ["command", "argumentPrefix", "argumentFiles", "arguments"], "Delivery Operational-v2-Provenienz.invocation");
  invariant(invocation["command"] === "derive-germany-operational-v2", "Delivery Operational-v2-Provenienz bindet einen falschen nativen Befehl.");
  const argumentPrefix = operationalStringList(invocation["argumentPrefix"], "Delivery Operational-v2-Provenienz.invocation.argumentPrefix");
  invariant(Array.isArray(invocation["argumentFiles"]), "Delivery Operational-v2-Provenienz.invocation.argumentFiles fehlt.");
  invariant(argumentPrefix.length === 0 && invocation["argumentFiles"].length === 0, "Delivery Operational-v2-Provenienz-v1 erlaubt keinen Argumentpraefix und keine Argumentdateien.");
  for (const [index, entry] of (invocation["argumentFiles"] as unknown[]).entries()) operationalFileProof(entry, `Delivery Operational-v2-Provenienz.invocation.argumentFiles[${index}]`);
  const arguments_ = operationalStringList(invocation["arguments"], "Delivery Operational-v2-Provenienz.invocation.arguments");
  invariant(arguments_.length === 5 && arguments_[0] === invocation["command"], "Delivery Operational-v2-Provenienz.invocation.arguments ist unvollstaendig.");
  for (let index = 1; index < arguments_.length; index += 1) {
    portablePath(arguments_[index], `Delivery Operational-v2-Provenienz.invocation.arguments[${index}]`);
  }
  const stdout = exactKeys(proof["stdout"], ["bytes", "sha256", "recordCount", "structuredReceiptSha256"], "Delivery Operational-v2-Provenienz.stdout");
  positiveInteger(stdout["bytes"], "Delivery Operational-v2-Provenienz.stdout.bytes");
  operationalSha256(stdout["sha256"], "Delivery Operational-v2-Provenienz.stdout.sha256");
  operationalSha256(stdout["structuredReceiptSha256"], "Delivery Operational-v2-Provenienz.stdout.structuredReceiptSha256");
  invariant(
    stdout["recordCount"] === 1,
    "Delivery Operational-v2-Provenienz.stdout ist kein einzelner strukturierter Validatorbeleg.",
  );
  const exit = exactKeys(proof["exit"], ["code", "signal"], "Delivery Operational-v2-Provenienz.exit");
  invariant(exit["code"] === 0 && exit["signal"] === null, "Delivery Operational-v2-Provenienz bindet keinen erfolgreichen signal-freien Validatorabschluss.");
  return {
    value: provenance,
    sha256: sha256(`${JSON.stringify(canonicalValue(provenance))}\n`),
    executionProofSha256: sha256(`${JSON.stringify(canonicalValue(proof))}\n`),
    validatorSha256: executedSha256,
  };
}

export function validateInfraPackageOperationalProvenance(value: unknown): Readonly<{
  readonly sha256: string;
  readonly executionProofSha256: string;
  readonly validatorSha256: string;
}> {
  const validated = validateOperationalProvenance(value);
  return Object.freeze({
    sha256: validated.sha256,
    executionProofSha256: validated.executionProofSha256,
    validatorSha256: validated.validatorSha256,
  });
}

interface OperationalAuthorityProof {
  readonly sha256: string;
  readonly rebuildAttestationSha256: string;
  readonly executionAuthorityAttestationSha256: string;
  readonly outerExecutionReceiptSha256: string;
  readonly outerExecutionCompletionSha256: string;
  readonly sourceCommit: string;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function validateAuthoritySubjects(value: unknown, label: string): readonly Record<string, unknown>[] {
  invariant(Array.isArray(value) && value.length > 0, `${label} besitzt keine Subjects.`);
  const subjects = value.map((subject, index) => operationalFileProof(subject, `${label}[${index}]`));
  const files = subjects.map((subject) => String(subject["file"]));
  invariant(
    new Set(files).size === files.length
      && files.every((file, index) => index === 0 || file.localeCompare(files[index - 1]!, "en") > 0),
    `${label} ist nicht eindeutig und kanonisch sortiert.`,
  );
  return subjects;
}

function validateAuthorityToolBinding(
  value: unknown,
  expected: { readonly id: string; readonly file: string; readonly bytes: number; readonly sha256: string },
  label: string,
): void {
  const binding = exactKeys(value, ["bytes", "file", "id", "kind", "sha256", "version"], label);
  operationalFileProof({ file: binding["file"], bytes: binding["bytes"], sha256: binding["sha256"] }, label);
  invariant(
    binding["id"] === expected.id
      && binding["kind"] === "derived-input"
      && binding["version"] === "infra-deutschland-2026.5"
      && binding["file"] === expected.file
      && binding["bytes"] === expected.bytes
      && binding["sha256"] === expected.sha256,
    `${label} driftet vom gepinnten aktuellen Authority-Werkzeugvertrag.`,
  );
}

function validateAuthorityBlock(
  value: unknown,
  expected: {
    readonly bundleFile: string;
    readonly predicateType: string;
    readonly signerWorkflow: string;
  },
  label: string,
): { readonly value: Record<string, unknown>; readonly bundle: Record<string, unknown>; readonly subjects: readonly Record<string, unknown>[]; readonly sourceDigest: string } {
  const block = exactKeys(value, [
    "bundle", "denySelfHostedRunners", "predicateType", "repository", "signerWorkflow",
    "sourceDigest", "sourceRef", "subjects",
  ], label);
  const bundle = operationalFileProof(block["bundle"], `${label}.bundle`);
  const sourceDigest = String(block["sourceDigest"] ?? "");
  invariant(
    bundle["file"] === expected.bundleFile
      && block["denySelfHostedRunners"] === true
      && block["predicateType"] === expected.predicateType
      && block["repository"] === "larynxberlin-rgb/Zugfolge"
      && block["signerWorkflow"] === expected.signerWorkflow
      && block["sourceRef"] === "refs/heads/main"
      && GIT_COMMIT.test(sourceDigest),
    `${label} driftet von der geschuetzten GitHub-Sigstore-Authority.`,
  );
  return { value: block, bundle, subjects: validateAuthoritySubjects(block["subjects"], `${label}.subjects`), sourceDigest };
}

function validateOperationalAuthority(value: unknown): OperationalAuthorityProof & { readonly value: Record<string, unknown> } {
  const authority = exactKeys(value, ["execution", "rebuild", "schema", "trustedRoot", "verifier"], "Delivery Operational-v2-Build-Authority");
  invariant(authority["schema"] === OPERATIONAL_AUTHORITY_SCHEMA, "Delivery Operational-v2-Build-Authority besitzt ein unbekanntes Schema.");
  validateAuthorityToolBinding(authority["verifier"], {
    id: "operational-attestation-verifier",
    file: "var/derived/germany-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
    bytes: 40_998_712,
    sha256: "91ed1eff1819a96b34bc2ca3adc01822c807ae1bb883c01ad9fdf335bf242b38",
  }, "Delivery Operational-v2-Build-Authority.verifier");
  validateAuthorityToolBinding(authority["trustedRoot"], {
    id: "operational-attestation-trusted-root",
    file: "var/derived/germany-2026.5/toolchain/github-attestation-trusted-root.jsonl",
    bytes: 34_634,
    sha256: "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
  }, "Delivery Operational-v2-Build-Authority.trustedRoot");
  const rebuild = validateAuthorityBlock(authority["rebuild"], {
    bundleFile: OPERATIONAL_REBUILD_ATTESTATION_FILE,
    predicateType: OPERATIONAL_REBUILD_ATTESTATION_PREDICATE,
    signerWorkflow: OPERATIONAL_REBUILD_ATTESTATION_WORKFLOW,
  }, "Delivery Operational-v2-Build-Authority.rebuild");
  const executionValue = exactKeys(authority["execution"], [
    "bundle", "denySelfHostedRunners", "predicate", "predicateSha256", "predicateType", "repository",
    "signerWorkflow", "sourceDigest", "sourceRef", "subjects",
  ], "Delivery Operational-v2-Build-Authority.execution");
  const execution = validateAuthorityBlock(
    Object.fromEntries(Object.entries(executionValue).filter(([key]) => !["predicate", "predicateSha256"].includes(key))),
    {
      bundleFile: OPERATIONAL_EXECUTION_AUTHORITY_FILE,
      predicateType: OPERATIONAL_EXECUTION_AUTHORITY_PREDICATE,
      signerWorkflow: OPERATIONAL_EXECUTION_AUTHORITY_WORKFLOW,
    },
    "Delivery Operational-v2-Build-Authority.execution",
  );
  const predicate = exactKeys(executionValue["predicate"], [
    "executionJob", "origin", "outerExecutionCompletion", "outerExecutionReceipt", "planAuthority",
    "protectedEnvironment", "releaseId", "requiredPhases", "schema", "source", "verificationScope",
  ], "Delivery Operational-v2-Build-Authority.execution.predicate");
  invariant(
    predicate["schema"] === OPERATIONAL_EXECUTION_AUTHORITY_SCHEMA
      && predicate["releaseId"] === "infra-deutschland-2026.5"
      && predicate["origin"] === "local-held-runner"
      && predicate["verificationScope"] === "operator-approved-hash-binding-not-source-reexecution-v1"
      && predicate["protectedEnvironment"] === "operational-release-approval"
      && sameCanonicalValue(predicate["requiredPhases"], [
        "materialize-annual-plan-evidence-v1",
        "execute-annual-operational-v2-v1",
        "derive-and-capture-v1",
      ]),
    "Delivery Operational-v2-Build-Authority.execution.predicate besitzt keinen exakten geschuetzten Authority-Kontext.",
  );
  const source = exactKeys(predicate["source"], ["commit", "ref", "repository"], "Delivery Operational-v2-Build-Authority.execution.predicate.source");
  invariant(
    source["repository"] === "larynxberlin-rgb/Zugfolge"
      && source["ref"] === "refs/heads/main"
      && source["commit"] === execution.sourceDigest
      && rebuild.sourceDigest === execution.sourceDigest,
    "Delivery Operational-v2-Build-Authority bindet Rebuild, Execution und Predicate nicht an denselben protected-main-Commit.",
  );
  const executionJob = exactKeys(predicate["executionJob"], ["mode", "timeoutMilliseconds"], "Delivery Operational-v2-Build-Authority.execution.predicate.executionJob");
  invariant(
    executionJob["mode"] === "windows-kill-on-job-close-root-exit-bounded-io-v1"
      && executionJob["timeoutMilliseconds"] === 21_600_000,
    "Delivery Operational-v2-Build-Authority.execution.predicate besitzt keinen exakten Prozessbaumvertrag.",
  );
  const planAuthority = exactKeys(predicate["planAuthority"], [
    "artifact", "bundle", "plan", "planCompletion", "startEvidence", "startEvidenceCompletion",
  ], "Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority");
  const artifact = exactKeys(planAuthority["artifact"], ["digest", "id", "workflowRunId"], "Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority.artifact");
  invariant(
    Number.isSafeInteger(artifact["id"]) && (artifact["id"] as number) > 0
      && Number.isSafeInteger(artifact["workflowRunId"]) && (artifact["workflowRunId"] as number) > 0
      && typeof artifact["digest"] === "string" && /^sha256:[a-f0-9]{64}$/u.test(artifact["digest"]),
    "Delivery Operational-v2-Build-Authority.execution.predicate besitzt keine eindeutigen GitHub-Artefaktmetadaten.",
  );
  const planBundle = operationalFileProof(planAuthority["bundle"], "Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority.bundle");
  invariant(sameCanonicalValue(planBundle, rebuild.bundle), "Delivery Operational-v2-Build-Authority.execution.predicate bindet ein anderes Rebuild-Bundle.");
  const causalProofs = [
    ["plan", OPERATIONAL_ANNUAL_PLAN_FILE],
    ["planCompletion", OPERATIONAL_ANNUAL_PLAN_COMPLETION_FILE],
    ["startEvidence", OPERATIONAL_ANNUAL_START_EVIDENCE_FILE],
    ["startEvidenceCompletion", OPERATIONAL_ANNUAL_START_COMPLETION_FILE],
  ].map(([key, file]) => {
    const proof = operationalFileProof(planAuthority[key!], `Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority.${key}`);
    invariant(proof["file"] === file, `Delivery Operational-v2-Build-Authority.execution.predicate.planAuthority.${key} besitzt den falschen Kausalpfad.`);
    invariant(rebuild.subjects.some((subject) => sameCanonicalValue(subject, proof)), `Delivery Operational-v2-Build-Authority.rebuild bindet Phase-1-Subject ${file} nicht.`);
    return proof;
  });
  invariant(causalProofs.length === 4, "Delivery Operational-v2-Build-Authority besitzt keine vollstaendige Phase-1-Kausalkette.");
  const outerReceipt = operationalFileProof(predicate["outerExecutionReceipt"], "Delivery Operational-v2-Build-Authority.execution.predicate.outerExecutionReceipt");
  const outerCompletion = operationalFileProof(predicate["outerExecutionCompletion"], "Delivery Operational-v2-Build-Authority.execution.predicate.outerExecutionCompletion");
  invariant(
    outerReceipt["file"] === OPERATIONAL_OUTER_EXECUTION_RECEIPT_FILE
      && outerCompletion["file"] === OPERATIONAL_OUTER_EXECUTION_COMPLETION_FILE,
    "Delivery Operational-v2-Build-Authority.execution.predicate bindet nicht Outer-Receipt und Completion.",
  );
  const expectedExecutionSubjects = [outerReceipt, outerCompletion]
    .sort((left, right) => String(left["file"]).localeCompare(String(right["file"]), "en"));
  invariant(
    sameCanonicalValue(execution.subjects, expectedExecutionSubjects),
    "Delivery Operational-v2-Build-Authority.execution besitzt nicht exakt Outer-Receipt und Completion als Subjects.",
  );
  invariant(
    executionValue["predicateSha256"] === sha256(JSON.stringify(canonicalValue(predicate))),
    "Delivery Operational-v2-Build-Authority.execution.predicateSha256 bindet das Predicate nicht kanonisch.",
  );
  return {
    value: authority,
    sha256: sha256(JSON.stringify(canonicalValue(authority))),
    rebuildAttestationSha256: String(rebuild.bundle["sha256"]),
    executionAuthorityAttestationSha256: String(execution.bundle["sha256"]),
    outerExecutionReceiptSha256: String(outerReceipt["sha256"]),
    outerExecutionCompletionSha256: String(outerCompletion["sha256"]),
    sourceCommit: execution.sourceDigest,
  };
}

export function validateInfraPackageOperationalAuthority(value: unknown): Readonly<OperationalAuthorityProof> {
  const validated = validateOperationalAuthority(value);
  return Object.freeze({
    sha256: validated.sha256,
    rebuildAttestationSha256: validated.rebuildAttestationSha256,
    executionAuthorityAttestationSha256: validated.executionAuthorityAttestationSha256,
    outerExecutionReceiptSha256: validated.outerExecutionReceiptSha256,
    outerExecutionCompletionSha256: validated.outerExecutionCompletionSha256,
    sourceCommit: validated.sourceCommit,
  });
}

interface PackagePart {
  readonly partId: string;
  readonly packagePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface PackageFile {
  readonly id: string;
  readonly kind: string;
  readonly installPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly infraReleaseId?: string;
  readonly stateHash?: string;
  readonly parts: readonly PackagePart[];
}

interface ParsedPackageManifest {
  readonly manifest: Record<string, unknown>;
  readonly packageId: string;
  readonly version: string;
  readonly files: readonly PackageFile[];
  readonly parts: readonly PackagePart[];
}

function validateMapAssetNotices(value: unknown, files: readonly PackageFile[]): { readonly assetGroups: number; readonly assetFiles: number } {
  const notices = exactKeys(value, ["schema", "assets"], "Öffentliche Asset-Notices");
  invariant(notices["schema"] === MAP_ASSET_NOTICES_SCHEMA && Array.isArray(notices["assets"]), "sources.json besitzt keinen gültigen Asset-Notice-Vertrag.");
  const assets = notices["assets"] as unknown[];
  invariant(assets.length === 2, "Asset-Notices müssen genau Noto-Glyphen und Protomaps-Sprites enthalten.");
  let coveredFiles = 0;
  let previousId = "";
  for (const [index, entry] of assets.entries()) {
    const asset = exactKeys(entry, [
      "id", "rightsSourceId", "kind", "license", "copyright", "modifications", "source", "derivedFrom", "notice", "tree",
    ], `Asset-Notice[${index}]`);
    const id = safeId(asset["id"], `Asset-Notice[${index}].id`);
    invariant(id.localeCompare(previousId, "en") > 0, "Asset-Notices sind nicht stabil nach ID sortiert.");
    previousId = id;
    const kind = asset["kind"];
    invariant(kind === "glyph" || kind === "sprite", `${id}.kind ist ungültig.`);
    invariant(
      id === (kind === "glyph" ? "noto-glyphs" : "protomaps-sprites")
        && asset["rightsSourceId"] === id
        && asset["license"] === (kind === "glyph" ? "OFL-1.1" : "MIT")
        && typeof asset["copyright"] === "string" && asset["copyright"].length > 10
        && typeof asset["modifications"] === "string" && asset["modifications"].length > 10,
      `${id} besitzt keine eindeutige Rechte- und Lizenzbindung.`,
    );
    const source = exactKeys(asset["source"], ["repository", "commit", "path"], `${id}.source`);
    invariant(
      GITHUB_REPOSITORY.test(String(source["repository"]))
        && GIT_COMMIT.test(String(source["commit"]))
        && portablePath(source["path"], `${id}.source.path`) !== "",
      `${id}.source ist nicht unveränderlich gepinnt.`,
    );
    if (kind === "glyph") {
      invariant(asset["derivedFrom"] === null, "Noto-Glyphen dürfen keine fremde Ableitungsquelle behaupten.");
    } else {
      const derived = exactKeys(asset["derivedFrom"], ["repository", "commit", "license"], `${id}.derivedFrom`);
      invariant(
        derived["repository"] === "https://github.com/tangrams/icons"
          && GIT_COMMIT.test(String(derived["commit"])) && derived["license"] === "MIT",
        "Protomaps-Sprites binden die Tangrams-MIT-Ableitung nicht unveränderlich.",
      );
    }
    const notice = exactKeys(asset["notice"], ["url", "bytes", "sha256", "text"], `${id}.notice`);
    invariant(
      typeof notice["url"] === "string" && notice["url"].startsWith("https://raw.githubusercontent.com/")
        && Number.isSafeInteger(notice["bytes"]) && (notice["bytes"] as number) > 0
        && SHA256.test(String(notice["sha256"])) && typeof notice["text"] === "string"
        && Buffer.byteLength(notice["text"], "utf8") === notice["bytes"]
        && sha256(notice["text"] as string) === notice["sha256"]
        && notice["text"].includes(asset["copyright"] as string)
        && notice["text"].includes(kind === "glyph" ? "SIL OPEN FONT LICENSE Version 1.1" : "The MIT License (MIT)"),
      `${id}.notice bindet nicht den vollständigen Lizenztext.`,
    );
    const tree = exactKeys(asset["tree"], ["installDirectory", "files", "bytes", "sha256"], `${id}.tree`);
    const installDirectory = portablePath(tree["installDirectory"], `${id}.tree.installDirectory`);
    const prefix = `${installDirectory}/`;
    const rows = files
      .filter((file) => file.kind === kind && file.installPath.startsWith(prefix))
      .map((file) => ({ path: portablePath(file.installPath.slice(prefix.length), `${id}.installPath`), bytes: file.bytes, sha256: file.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path, "en"));
    invariant(rows.length > 0 && new Set(rows.map(({ path }) => path.toLowerCase())).size === rows.length, `${id}.tree ist leer oder enthält kollidierende Pfade.`);
    const canonicalTree = `${rows.map(({ path, bytes, sha256: fileSha256 }) => `${path}\0${bytes}\0${fileSha256}`).join("\n")}\n`;
    invariant(
      tree["files"] === rows.length
        && tree["bytes"] === rows.reduce((sum, row) => sum + row.bytes, 0)
        && tree["sha256"] === sha256(canonicalTree),
      `${id} weicht vom ausgelieferten Assetbaum ab.`,
    );
    coveredFiles += rows.length;
  }
  const packagedAssetFiles = files.filter(({ kind }) => kind === "glyph" || kind === "sprite").length;
  invariant(coveredFiles === packagedAssetFiles, "Glyphen- oder Sprite-Dateien liegen außerhalb der lizenzierten Assetbäume.");
  return { assetGroups: assets.length, assetFiles: coveredFiles };
}

function parsePackageManifest(bytes: Buffer): ParsedPackageManifest {
  invariant(bytes.length > 0 && bytes.length <= MAX_MANIFEST_BYTES, "Paketmanifest hat eine unzulässige Größe.");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new InfraPackageStagingError("Paketmanifest ist kein gültiges JSON."); }
  const manifest = record(value, "Paketmanifest");
  invariant(manifest["schema"] === PACKAGE_SCHEMA && manifest["format"] === "directory-parts", "Paketmanifest hat ein unbekanntes Schema oder Format.");
  invariant(bytes.toString("utf8") === canonicalManifest(manifest), "Paketmanifest ist nicht kanonisch serialisiert.");
  const packageId = safeId(manifest["packageId"], "packageId");
  const version = safeId(manifest["version"], "version");
  germanyOperationalDeliveryV2Generation(version);
  invariant(manifest["partBytes"] === PART_BYTES, "Jahrespaket muss das 100-MiB-Transportprofil verwenden.");
  const artifacts = manifest["artifacts"];
  const auxiliaryFiles = manifest["auxiliaryFiles"];
  invariant(Array.isArray(artifacts) && artifacts.length === 2 && Array.isArray(auxiliaryFiles) && auxiliaryFiles.length >= 6, "Paketinventar ist unvollständig.");
  invariant(artifacts.filter((entry) => record(entry, "Artefakt")["kind"] === "basemap").length === 1, "Paket braucht genau eine Basemap.");
  invariant(artifacts.filter((entry) => record(entry, "Artefakt")["kind"] === "infrastructure").length === 1, "Paket braucht genau eine Infrastrukturdatei.");
  const readModels = auxiliaryFiles.filter((entry) => record(entry, "Hilfsdatei")["kind"] === "read-model");
  const operationalInfrastructure = auxiliaryFiles.filter((entry) => record(entry, "Hilfsdatei")["kind"] === OPERATIONAL_INFRASTRUCTURE_KIND);
  const movementRouteTemplates = auxiliaryFiles.filter((entry) => record(entry, "Hilfsdatei")["kind"] === MOVEMENT_ROUTE_TEMPLATES_KIND);
  const timetableTransferDemands = auxiliaryFiles.filter((entry) => record(entry, "Hilfsdatei")["kind"] === TIMETABLE_TRANSFER_DEMANDS_KIND);
  const trainProjections = auxiliaryFiles.filter((entry) => record(entry, "Hilfsdatei")["kind"] === "train-map-projection");
  invariant(readModels.length === 1 && record(readModels[0], "ReadModel")["installPath"] === "read-model.sqlite", "Paket braucht genau ein öffentliches read-model.sqlite in der Releasewurzel.");
  invariant(operationalInfrastructure.length === 1 && record(operationalInfrastructure[0], "Operational-v2-Infrastruktur")["installPath"] === "operational-infrastructure-v2.json", "Paket braucht genau eine statische operational-infrastructure-v2.json in der Releasewurzel.");
  invariant(movementRouteTemplates.length === 1 && record(movementRouteTemplates[0], "Movement-Route-Templates-v2")["installPath"] === "operational-infrastructure-v2.movement-route-templates-v2.json", "Paket braucht genau eine operational-infrastructure-v2.movement-route-templates-v2.json in der Releasewurzel.");
  invariant(timetableTransferDemands.length === 1 && record(timetableTransferDemands[0], "Timetable-Transfer-Demands-v2")["installPath"] === "timetable-routes-v2.transfer-demands-v2.json", "Paket braucht genau eine timetable-routes-v2.transfer-demands-v2.json in der Releasewurzel.");
  invariant(trainProjections.length === 0, "Operational-v2-Paket darf keine weltgebundene Zugpositionsprojektion als Paketvoraussetzung enthalten.");

  const ids = new Set<string>();
  const paths = new Set<string>();
  const partIds = new Set<string>();
  const files: PackageFile[] = [];
  for (const raw of [...artifacts, ...auxiliaryFiles]) {
    const entry = record(raw, "Paketdatei");
    const id = safeId(entry["id"], "Paketdatei-ID");
    invariant(!ids.has(id), `Paketdatei-ID ${id} ist doppelt.`);
    ids.add(id);
    const installPath = portablePath(entry["installPath"], `${id}.installPath`);
    invariant(!paths.has(installPath.toLowerCase()), `Installationspfad ${installPath} ist doppelt.`);
    paths.add(installPath.toLowerCase());
    const fileBytes = entry["bytes"];
    invariant(Number.isSafeInteger(fileBytes) && (fileBytes as number) > 0 && SHA256.test(String(entry["sha256"])), `${id} hat keine gültige Bytezahl oder Prüfsumme.`);
    invariant(Array.isArray(entry["parts"]) && entry["parts"].length > 0, `${id} besitzt keine Paketteile.`);
    let sum = 0;
    const parts: PackagePart[] = [];
    for (const [index, rawPart] of (entry["parts"] as unknown[]).entries()) {
      const part = record(rawPart, `${id}.parts[${index}]`);
      const packagePath = portablePath(part["path"], `${id}.parts[${index}].path`);
      const partBytes = part["bytes"];
      const partSha = String(part["sha256"]);
      invariant(Number.isSafeInteger(partBytes) && (partBytes as number) > 0 && (partBytes as number) <= PART_BYTES && SHA256.test(partSha), `${packagePath} hat keine gültige Bytezahl oder Prüfsumme.`);
      invariant(!paths.has(packagePath.toLowerCase()), `Paketpfad ${packagePath} ist doppelt.`);
      paths.add(packagePath.toLowerCase());
      const partId = sha256(`${id}\0${index}\0${partSha}`).slice(0, 32);
      invariant(!partIds.has(partId), "Paketteilkennung kollidiert.");
      partIds.add(partId);
      parts.push({ partId, packagePath, bytes: partBytes as number, sha256: partSha });
      sum += partBytes as number;
      invariant(Number.isSafeInteger(sum), `${id} ist zu groß.`);
    }
    invariant(sum === fileBytes, `${id}: Summe der Teile stimmt nicht.`);
    const kind = String(entry["kind"]);
    let operationalBinding: { readonly infraReleaseId: string; readonly stateHash: string } | undefined;
    if (kind === OPERATIONAL_INFRASTRUCTURE_KIND) {
      const infraReleaseId = safeId(entry["infraReleaseId"], `${id}.infraReleaseId`);
      const stateHash = String(entry["stateHash"] ?? "");
      invariant(SHA256.test(stateHash) && stateHash !== entry["sha256"], `${id} besitzt keine getrennte kanonische Operational-v2-Zustandsbindung.`);
      operationalBinding = { infraReleaseId, stateHash };
    }
    files.push({ id, kind, installPath, bytes: fileBytes as number, sha256: String(entry["sha256"]), ...operationalBinding, parts });
  }
  return { manifest, packageId, version, files, parts: files.flatMap(({ parts }) => parts) };
}

async function hashFile(path: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function writeStream(path: string, source: AsyncIterable<Buffer | string>, maximumBytes: number): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const handle = await open(path, "wx");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      invariant(bytes <= maximumBytes, "Upload überschreitet die erwartete Bytezahl.");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        invariant(result.bytesWritten > 0, "Upload konnte nicht vollständig geschrieben werden.");
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

type InfraPackageRename = (source: string, destination: string) => Promise<void>;

async function renameAtomic(source: string, destination: string, renamePackage: InfraPackageRename): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await renamePackage(source, destination); return; } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!["EACCES", "EBUSY", "EPERM"].includes(code) || attempt >= 5) throw error;
      await delay(25 * (2 ** attempt));
    }
  }
}

interface Session {
  readonly schema: "zugfolge-infra-package-upload-session/v1";
  readonly importId: string;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly packageId?: string;
  readonly version?: string;
  readonly parts?: readonly PackagePart[];
}

interface ManifestState {
  readonly schema: "zugfolge-infra-package-upload-manifest/v1";
  readonly packageId: string;
  readonly version: string;
  readonly parts: readonly PackagePart[];
}

interface FinalizationReceipt {
  readonly schema: "zugfolge-infra-package-upload-receipt/v1";
  readonly uploadStatus: "closed";
  readonly importId: string;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly packageId: string;
  readonly version: string;
  readonly parts: readonly PackagePart[];
  readonly stageName: string;
  readonly qualification: InfraPackageQualification;
}

interface OdooFinalizationBinding {
  readonly schema: "zugfolge-infra-package-finalization-binding/v1";
  readonly importId: string;
  readonly challenge: InfraPackageFinalizationChallenge;
  readonly finalizedAt: string;
  readonly qualification: InfraPackageQualification;
}

export type InfraPackageBeginResult =
  | { readonly status: "created" | "reused" | "closed" }
  | {
      readonly status: "finalized";
      readonly finalizationChallenge: InfraPackageFinalizationChallenge;
      readonly finalizedAt: string;
      readonly qualification: InfraPackageQualification;
    };

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
}

async function ensureRegularDirectory(path: string): Promise<void> {
  try { await mkdir(path); } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${path} muss ein regulaeres Verzeichnis sein.`);
}

async function readRegularJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${path} muss eine regulaere JSON-Datei sein.`);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export interface InfraUploadContentProof {
  readonly bytes: number;
  readonly sha256: string;
}

export interface InfraPackageQualification {
  readonly packageId: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly deliveryReleaseId: string;
  readonly signatureStatus: "missing" | "verified";
  readonly nativeOperationalValidationStatus: "missing" | "verified";
  readonly operationalStateHash: string | null;
  readonly operationalProvenanceStatus: "missing" | "verified";
  readonly operationalProvenanceSha256: string | null;
  readonly operationalExecutionProofSha256: string | null;
  readonly operationalValidatorSha256: string | null;
  readonly operationalAuthorityStatus: "missing" | "verified";
  readonly operationalAuthoritySha256: string | null;
  readonly operationalRebuildAttestationSha256: string | null;
  readonly operationalExecutionAuthorityAttestationSha256: string | null;
  readonly operationalOuterExecutionReceiptSha256: string | null;
  readonly operationalOuterExecutionCompletionSha256: string | null;
  readonly operationalAuthoritySourceCommit: string | null;
  readonly activationBlocker: "delivery-signature-missing" | "operational-v2-native-validation-missing" | null;
  readonly activationEligible: boolean;
}

export type InfraPackageActivationCandidate = QualifiedInfraPackageCandidate;

export interface InfraPackageFinalizationChallenge {
  readonly schema: "zugfolge-infra-package-finalization-challenge/v1";
  readonly nonce: string;
  readonly requestedAt: string;
}

export interface InfraPackageFinalizationReceipt {
  readonly schema: "zugfolge-infra-package-finalization-receipt/v1" | "zugfolge-infra-package-finalization-receipt/v2";
  readonly signatureAlgorithm: "HMAC-SHA256";
  readonly keyId: string;
  readonly nonce: string;
  readonly requestedAt: string;
  readonly finalizedAt: string;
  readonly importId: string;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly manifestSha256: string;
  readonly deliveryReleaseId: string;
  readonly operationalStateHash: string | null;
  readonly operationalProvenanceStatus?: "missing" | "verified";
  readonly operationalProvenanceSha256?: string | null;
  readonly operationalExecutionProofSha256?: string | null;
  readonly operationalValidatorSha256?: string | null;
  readonly operationalAuthorityStatus?: "missing" | "verified";
  readonly operationalAuthoritySha256?: string | null;
  readonly operationalRebuildAttestationSha256?: string | null;
  readonly operationalExecutionAuthorityAttestationSha256?: string | null;
  readonly operationalOuterExecutionReceiptSha256?: string | null;
  readonly operationalOuterExecutionCompletionSha256?: string | null;
  readonly operationalAuthoritySourceCommit?: string | null;
  readonly signatureStatus: "missing" | "verified";
  readonly nativeOperationalValidationStatus: "missing" | "verified";
  readonly activationBlocker: "delivery-signature-missing" | "operational-v2-native-validation-missing" | null;
  readonly activationEligible: boolean;
}

export interface InfraPackageVerifierResult {
  readonly packageId: string;
  readonly version: string;
  readonly manifestSha256: string;
}

export type InfraPackageVerifier = (packageRoot: string) => Promise<InfraPackageVerifierResult>;

export { createLocalMapPackageVerifier } from "./infra-package-transport-worker.js";

export interface InfraOperationalV2NativeValidationInput {
  readonly packageRoot: string;
  readonly expectedInfraReleaseId: string;
  readonly artifact: {
    readonly id: string;
    readonly installPath: "operational-infrastructure-v2.json";
    readonly bytes: number;
    readonly sha256: string;
    readonly parts: readonly PackagePart[];
  };
}

export interface InfraOperationalV2NativeValidationReceipt {
  readonly schema: "operational-infrastructure-v2";
  readonly infraReleaseId: string;
  readonly stateHash: string;
}

/**
 * Vertrauensgrenze zur nativen Rust-Validierung. Die Implementierung muss die
 * gelieferten Paketteile selbst zusammensetzen und den Zustandshash aus dem
 * typisierten Operational-v2-Vertrag berechnen; ein Manifestwert darf nicht
 * lediglich zurueckgegeben werden.
 */
export type InfraOperationalV2NativeVerifier = (
  input: InfraOperationalV2NativeValidationInput,
) => Promise<InfraOperationalV2NativeValidationReceipt>;

function canonicalTimestamp(value: unknown, label: string): string {
  invariant(typeof value === "string", `${label} fehlt.`);
  const parsed = new Date(value);
  invariant(!Number.isNaN(parsed.getTime()) && parsed.toISOString() === value, `${label} ist kein kanonischer UTC-Zeitstempel.`);
  return value;
}

function validateFinalizationChallenge(
  value: InfraPackageFinalizationChallenge,
  now: Date,
  requireFreshness: boolean,
): void {
  invariant(
    value !== null
      && typeof value === "object"
      && Object.keys(value).sort().join(",") === "nonce,requestedAt,schema"
      && value.schema === FINALIZATION_CHALLENGE_SCHEMA
      && FINALIZATION_NONCE.test(value.nonce),
    "Game-Finalisierungschallenge ist ungültig.",
  );
  const requestedAt = canonicalTimestamp(value.requestedAt, "Game-Finalisierungschallenge requestedAt");
  if (requireFreshness) {
    invariant(Math.abs(now.getTime() - new Date(requestedAt).getTime()) <= 5 * 60_000, "Game-Finalisierungschallenge ist abgelaufen.");
  }
}

function validateFinalizationDuration(challenge: InfraPackageFinalizationChallenge, finalizedAt: string): void {
  const finalizationDuration = new Date(finalizedAt).getTime() - new Date(challenge.requestedAt).getTime();
  invariant(
    finalizationDuration >= -5 * 60_000 && finalizationDuration <= FINALIZATION_MAX_DURATION_MS,
    "Odoo-Finalisierung verletzt das zulässige Zeitfenster.",
  );
}

function qualificationIsConsistent(qualification: InfraPackageQualification): boolean {
  if (
    qualification === null
      || typeof qualification !== "object"
      || Object.keys(qualification).sort().join(",") !== "activationBlocker,activationEligible,deliveryReleaseId,manifestSha256,nativeOperationalValidationStatus,operationalAuthoritySha256,operationalAuthoritySourceCommit,operationalAuthorityStatus,operationalExecutionAuthorityAttestationSha256,operationalExecutionProofSha256,operationalOuterExecutionCompletionSha256,operationalOuterExecutionReceiptSha256,operationalProvenanceSha256,operationalProvenanceStatus,operationalRebuildAttestationSha256,operationalStateHash,operationalValidatorSha256,packageId,signatureStatus,version"
      || !SAFE_ID.test(qualification.packageId)
      || !SAFE_ID.test(qualification.version)
      || !SHA256.test(qualification.manifestSha256)
      || !SAFE_ID.test(qualification.deliveryReleaseId)
  ) return false;
  let currentOperationalProvenance: boolean;
  try {
    currentOperationalProvenance = germanyOperationalDeliveryV2Generation(qualification.version) === "integrated-provenance-v2";
    validateGermanyOperationalDeliveryV2Pair(qualification.version, qualification.deliveryReleaseId);
  } catch {
    return false;
  }
  if (qualification.signatureStatus === "missing") {
    return qualification.nativeOperationalValidationStatus === "missing"
      && qualification.operationalStateHash === null
      && qualification.operationalProvenanceStatus === "missing"
      && qualification.operationalProvenanceSha256 === null
      && qualification.operationalExecutionProofSha256 === null
      && qualification.operationalValidatorSha256 === null
      && qualification.operationalAuthorityStatus === "missing"
      && qualification.operationalAuthoritySha256 === null
      && qualification.operationalRebuildAttestationSha256 === null
      && qualification.operationalExecutionAuthorityAttestationSha256 === null
      && qualification.operationalOuterExecutionReceiptSha256 === null
      && qualification.operationalOuterExecutionCompletionSha256 === null
      && qualification.operationalAuthoritySourceCommit === null
      && qualification.activationEligible === false
      && qualification.activationBlocker === "delivery-signature-missing";
  }
  if (qualification.signatureStatus !== "verified") return false;
  if (currentOperationalProvenance) {
    if (qualification.operationalProvenanceStatus !== "verified"
      || !SHA256.test(String(qualification.operationalProvenanceSha256))
      || !SHA256.test(String(qualification.operationalExecutionProofSha256))
      || !SHA256.test(String(qualification.operationalValidatorSha256))
      || qualification.operationalAuthorityStatus !== "verified"
      || !SHA256.test(String(qualification.operationalAuthoritySha256))
      || !SHA256.test(String(qualification.operationalRebuildAttestationSha256))
      || !SHA256.test(String(qualification.operationalExecutionAuthorityAttestationSha256))
      || !SHA256.test(String(qualification.operationalOuterExecutionReceiptSha256))
      || !SHA256.test(String(qualification.operationalOuterExecutionCompletionSha256))
      || !GIT_COMMIT.test(String(qualification.operationalAuthoritySourceCommit))) return false;
  } else if (qualification.operationalProvenanceStatus !== "missing"
    || qualification.operationalProvenanceSha256 !== null
    || qualification.operationalExecutionProofSha256 !== null
    || qualification.operationalValidatorSha256 !== null
    || qualification.operationalAuthorityStatus !== "missing"
    || qualification.operationalAuthoritySha256 !== null
    || qualification.operationalRebuildAttestationSha256 !== null
    || qualification.operationalExecutionAuthorityAttestationSha256 !== null
    || qualification.operationalOuterExecutionReceiptSha256 !== null
    || qualification.operationalOuterExecutionCompletionSha256 !== null
    || qualification.operationalAuthoritySourceCommit !== null) return false;
  if (qualification.nativeOperationalValidationStatus === "missing") {
    return qualification.operationalStateHash === null
      && qualification.activationEligible === false
      && qualification.activationBlocker === "operational-v2-native-validation-missing";
  }
  return qualification.nativeOperationalValidationStatus === "verified"
    && typeof qualification.operationalStateHash === "string"
    && SHA256.test(qualification.operationalStateHash)
    && qualification.activationEligible === true
    && qualification.activationBlocker === null;
}

export class InfraPackageStaging {
  readonly #root: string;
  readonly #trustedReleaseKeys: Readonly<Record<string, string>>;
  readonly #packageVerifier: InfraPackageVerifier;
  readonly #nativeOperationalVerifier: InfraOperationalV2NativeVerifier | undefined;
  readonly #renamePackage: InfraPackageRename;
  readonly #now: () => Date;
  readonly #importLocks = new Map<string, Promise<void>>();

  constructor(root: string, options: {
    readonly packageVerifier: InfraPackageVerifier;
    readonly trustedReleaseKeys?: Readonly<Record<string, string>>;
    readonly nativeOperationalVerifier?: InfraOperationalV2NativeVerifier;
    /** Ausschliesslich fuer fokussierte Dateisystem-Fehlersimulationen. */
    readonly renamePackage?: InfraPackageRename;
    /** Kontrollierbare Uhr fuer deterministische Finalisierungsgrenzen. */
    readonly now?: () => Date;
  }) {
    this.#root = resolve(root);
    this.#packageVerifier = options.packageVerifier;
    this.#trustedReleaseKeys = options.trustedReleaseKeys ?? {};
    this.#nativeOperationalVerifier = options.nativeOperationalVerifier;
    this.#renamePackage = options.renamePackage ?? rename;
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const metadata = await lstat(this.#root);
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Stagingwurzel muss ein reguläres Verzeichnis sein.");
    await ensureRegularDirectory(join(this.#root, ".receiving"));
    await ensureRegularDirectory(join(this.#root, ".receipts"));
    await ensureRegularDirectory(join(this.#root, ".finalizations"));
    await ensureRegularDirectory(join(this.#root, "staged"));
  }

  async #withImportLock<T>(importId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#importLocks.get(importId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.then(() => gate);
    this.#importLocks.set(importId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#importLocks.get(importId) === tail) this.#importLocks.delete(importId);
    }
  }

  async expectedManifest(importId: string): Promise<InfraUploadContentProof> {
    const receipt = await this.#readReceipt(importId);
    const session = receipt ?? await this.#readSession(importId);
    return { bytes: session.manifestBytes, sha256: session.manifestSha256 };
  }

  async expectedPart(importId: string, partId: string): Promise<InfraUploadContentProof> {
    const receipt = await this.#readReceipt(importId);
    const session = receipt ?? await this.#readSession(importId);
    invariant(Array.isArray(session.parts), "Paketmanifest wurde noch nicht hochgeladen.");
    const part = session.parts.find((candidate) => candidate.partId === partId);
    invariant(part !== undefined, "Unbekannte serverseitige Paketteilkennung.");
    return { bytes: part.bytes, sha256: part.sha256 };
  }

  #sessionRoot(importId: string): string {
    return join(this.#root, ".receiving", safeId(importId, "importId"));
  }

  #receiptPath(importId: string): string {
    return join(this.#root, ".receipts", `${safeId(importId, "importId")}.json`);
  }

  #odooFinalizationPath(importId: string): string {
    return join(this.#root, ".finalizations", `${safeId(importId, "importId")}.json`);
  }

  async #readReceipt(importId: string): Promise<FinalizationReceipt | undefined> {
    let value: unknown;
    try { value = await readRegularJson(this.#receiptPath(importId)); } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    const receipt = record(value, "Finalisierungsbeleg") as unknown as FinalizationReceipt;
    invariant(
      receipt.schema === "zugfolge-infra-package-upload-receipt/v1" && receipt.uploadStatus === "closed" &&
      receipt.importId === importId && Number.isSafeInteger(receipt.manifestBytes) && receipt.manifestBytes > 0 &&
      SHA256.test(receipt.manifestSha256) && SAFE_ID.test(receipt.packageId) && SAFE_ID.test(receipt.version) &&
      Array.isArray(receipt.parts),
      "Persistierter Finalisierungsbeleg ist ungültig.",
    );
    const expectedStageName = `${receipt.packageId}-${receipt.version}-${receipt.manifestSha256.slice(0, 16)}`;
    invariant(receipt.stageName === expectedStageName, "Finalisierungsbeleg besitzt ein abweichendes Stagingziel.");
    invariant(
      receipt.qualification.packageId === receipt.packageId && receipt.qualification.version === receipt.version &&
      receipt.qualification.manifestSha256 === receipt.manifestSha256 &&
      qualificationIsConsistent(receipt.qualification),
      "Finalisierungsbeleg besitzt eine unzulässige Qualifikation.",
    );
    return receipt;
  }

  async #readOdooFinalization(importId: string): Promise<OdooFinalizationBinding | undefined> {
    let value: unknown;
    try { value = await readRegularJson(this.#odooFinalizationPath(importId)); } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    const binding = record(value, "Odoo-Finalisierungsbindung") as unknown as OdooFinalizationBinding;
    invariant(
      Object.keys(binding).sort().join(",") === "challenge,finalizedAt,importId,qualification,schema"
        && binding.schema === "zugfolge-infra-package-finalization-binding/v1"
        && binding.importId === importId
        && qualificationIsConsistent(binding.qualification),
      "Persistierte Odoo-Finalisierungsbindung ist ungültig.",
    );
    validateFinalizationChallenge(binding.challenge, this.#now(), false);
    const finalizedAt = canonicalTimestamp(binding.finalizedAt, "Odoo-Finalisierungsbindung finalizedAt");
    validateFinalizationDuration(binding.challenge, finalizedAt);
    return binding;
  }

  async #persistReceipt(receipt: FinalizationReceipt): Promise<FinalizationReceipt> {
    const path = this.#receiptPath(receipt.importId);
    const temporaryPath = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "wx", flush: true });
      try {
        await link(temporaryPath, path);
        return receipt;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = await this.#readReceipt(receipt.importId);
        invariant(existing !== undefined && JSON.stringify(existing) === JSON.stringify(receipt), "Parallel persistierter Finalisierungsbeleg weicht ab.");
        return existing;
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async #persistOdooFinalization(binding: OdooFinalizationBinding): Promise<OdooFinalizationBinding> {
    validateFinalizationChallenge(binding.challenge, this.#now(), false);
    canonicalTimestamp(binding.finalizedAt, "Odoo-Finalisierungsbindung finalizedAt");
    validateFinalizationDuration(binding.challenge, binding.finalizedAt);
    const path = this.#odooFinalizationPath(binding.importId);
    const temporaryPath = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(binding)}\n`, { encoding: "utf8", flag: "wx", flush: true });
      try {
        await link(temporaryPath, path);
        return binding;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = await this.#readOdooFinalization(binding.importId);
        invariant(existing !== undefined, "Parallel persistierte Odoo-Finalisierungsbindung fehlt.");
        invariant(
          existing.challenge.nonce === binding.challenge.nonce,
          "Finalisierungsnonce wurde bereits fuer einen anderen Abschluss verwendet.",
        );
        invariant(
          JSON.stringify(existing.qualification) === JSON.stringify(binding.qualification),
          "Parallel persistierte Odoo-Finalisierungsbindung weicht vom Stagingzustand ab.",
        );
        return existing;
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async #ensureActiveSessionDirectories(importId: string): Promise<void> {
    const sessionRoot = this.#sessionRoot(importId);
    await ensureRegularDirectory(sessionRoot);
    await ensureRegularDirectory(join(sessionRoot, "package"));
    await ensureRegularDirectory(join(sessionRoot, "package", "parts"));
  }

  async #ensurePackageParent(importId: string, packagePath: string): Promise<string> {
    let parent = join(this.#sessionRoot(importId), "package");
    const rootMetadata = await lstat(parent);
    invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Paketwurzel muss ein reguläres Verzeichnis sein.");
    const segments = packagePath.split("/");
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      await ensureRegularDirectory(parent);
    }
    return join(parent, segments.at(-1)!);
  }

  async #readSession(importId: string): Promise<Session> {
    const root = this.#sessionRoot(importId);
    const rootMetadata = await lstat(root);
    invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Uploadsitzung muss ein reguläres Verzeichnis sein.");
    const session = await readRegularJson(join(root, "session.json")) as Session;
    try {
      const state = await readRegularJson(join(root, "manifest-state.json")) as ManifestState;
      invariant(state.schema === "zugfolge-infra-package-upload-manifest/v1", "Persistierter Manifestzustand hat ein unbekanntes Schema.");
      return { ...session, packageId: state.packageId, version: state.version, parts: state.parts };
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return session;
      throw error;
    }
  }

  async #persistManifestState(importId: string, parsed: ParsedPackageManifest): Promise<void> {
    const path = join(this.#sessionRoot(importId), "manifest-state.json");
    const state: ManifestState = {
      schema: "zugfolge-infra-package-upload-manifest/v1",
      packageId: parsed.packageId,
      version: parsed.version,
      parts: parsed.parts,
    };
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as ManifestState;
      invariant(JSON.stringify(existing) === JSON.stringify(state), "Import-ID besitzt einen abweichenden Manifestzustand.");
      return;
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const temporaryPath = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", flush: true });
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const existing = JSON.parse(await readFile(path, "utf8")) as ManifestState;
        invariant(JSON.stringify(existing) === JSON.stringify(state), "Parallel persistierter Manifestzustand weicht ab.");
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async begin(importId: string, manifest: { readonly bytes: number; readonly sha256: string }): Promise<InfraPackageBeginResult> {
    return this.beginForOdoo(importId, manifest);
  }

  async beginForOdoo(importId: string, manifest: { readonly bytes: number; readonly sha256: string }): Promise<InfraPackageBeginResult> {
    await this.initialize();
    safeId(importId, "importId");
    invariant(Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MAX_MANIFEST_BYTES && SHA256.test(manifest.sha256), "Manifest-Metadaten sind ungültig.");
    return this.#withImportLock(importId, async () => {
      const receipt = await this.#readReceipt(importId);
      if (receipt) {
        invariant(receipt.manifestBytes === manifest.bytes && receipt.manifestSha256 === manifest.sha256, "Abgeschlossene Import-ID gehört zu einem anderen Manifest.");
        const completed = await this.#completeReceipt(receipt);
        const { stagePath: _stagePath, ...currentQualification } = completed;
        const finalization = await this.#readOdooFinalization(importId);
        if (finalization === undefined) return { status: "closed" };
        invariant(
          JSON.stringify(finalization.qualification) === JSON.stringify(currentQualification),
          "Odoo-Finalisierungsbindung weicht von der aktuell requalifizierten Stagingversion ab.",
        );
        return {
          status: "finalized",
          finalizationChallenge: finalization.challenge,
          finalizedAt: finalization.finalizedAt,
          qualification: currentQualification,
        };
      }
      const sessionRoot = this.#sessionRoot(importId);
      try {
        const existing = await this.#readSession(importId);
        invariant(existing.manifestBytes === manifest.bytes && existing.manifestSha256 === manifest.sha256, "Import-ID gehört zu einem anderen Manifest.");
        return { status: "reused" };
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await this.#ensureActiveSessionDirectories(importId);
      const session: Session = { schema: "zugfolge-infra-package-upload-session/v1", importId, manifestBytes: manifest.bytes, manifestSha256: manifest.sha256 };
      const temporarySessionPath = join(sessionRoot, `.session-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
      try {
        await writeFile(temporarySessionPath, `${JSON.stringify(session)}\n`, { encoding: "utf8", flag: "wx", flush: true });
        try {
          await link(temporarySessionPath, join(sessionRoot, "session.json"));
          return { status: "created" };
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          const existing = await this.#readSession(importId);
          invariant(existing.manifestBytes === manifest.bytes && existing.manifestSha256 === manifest.sha256, "Parallel verwendete Import-ID gehört zu einem anderen Manifest.");
          return { status: "reused" };
        }
      } finally {
        await rm(temporarySessionPath, { force: true });
      }
    });
  }

  async uploadManifest(importId: string, proof: InfraUploadContentProof, source: AsyncIterable<Buffer | string>): Promise<{ readonly status: "stored" | "reused"; readonly parts: readonly PackagePart[] }> {
    return this.#withImportLock(importId, async () => {
    invariant((await this.#readReceipt(importId)) === undefined, "Uploadsitzung ist bereits endgültig abgeschlossen.");
    const session = await this.#readSession(importId);
    invariant(proof.bytes === session.manifestBytes && proof.sha256 === session.manifestSha256, "Signierter Manifestbeleg stimmt nicht mit der Uploadsitzung überein.");
    const packageRoot = join(this.#sessionRoot(importId), "package");
    const packageMetadata = await lstat(packageRoot);
    invariant(packageMetadata.isDirectory() && !packageMetadata.isSymbolicLink(), "Paketwurzel muss ein reguläres Verzeichnis sein.");
    const finalPath = join(packageRoot, "manifest.json");
    try {
      const observed = await hashFile(finalPath);
      invariant(observed.bytes === session.manifestBytes && observed.sha256 === session.manifestSha256, "Bereits gespeichertes Manifest ist beschädigt.");
      const parsed = parsePackageManifest(await readFile(finalPath));
      await this.#persistManifestState(importId, parsed);
      return { status: "reused", parts: parsed.parts };
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const temporaryPath = join(this.#sessionRoot(importId), `.manifest-uploading-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const observed = await writeStream(temporaryPath, source, session.manifestBytes);
      invariant(observed.bytes === session.manifestBytes && observed.sha256 === session.manifestSha256, "Manifest-Upload stimmt nicht mit Bytezahl oder SHA-256 überein.");
      const bytes = await readFile(temporaryPath);
      const parsed = parsePackageManifest(bytes);
      let status: "stored" | "reused" = "stored";
      try {
        await link(temporaryPath, finalPath);
      } catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const existing = await hashFile(finalPath);
        invariant(existing.bytes === session.manifestBytes && existing.sha256 === session.manifestSha256, "Parallel gespeichertes Manifest ist beschädigt.");
        status = "reused";
      }
      const checksumPath = join(packageRoot, "manifest.sha256");
      const checksumBytes = Buffer.from(`${session.manifestSha256}  manifest.json\n`, "ascii");
      const temporaryChecksumPath = `${checksumPath}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(temporaryChecksumPath, checksumBytes, { flag: "wx", flush: true });
        try {
          await link(temporaryChecksumPath, checksumPath);
        } catch (error) {
          if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
          invariant((await readFile(checksumPath)).equals(checksumBytes), "Persistierte Manifestprüfsumme weicht ab.");
        }
      } finally {
        await rm(temporaryChecksumPath, { force: true });
      }
      await this.#persistManifestState(importId, parsed);
      return { status, parts: parsed.parts };
    } finally {
      await rm(temporaryPath, { force: true });
    }
    });
  }

  async uploadPart(importId: string, partId: string, proof: InfraUploadContentProof, source: AsyncIterable<Buffer | string>): Promise<{ readonly status: "stored" | "reused" }> {
    return this.#withImportLock(importId, async () => {
    invariant((await this.#readReceipt(importId)) === undefined, "Uploadsitzung ist bereits endgültig abgeschlossen.");
    const session = await this.#readSession(importId);
    invariant(Array.isArray(session.parts), "Paketmanifest wurde noch nicht hochgeladen.");
    const part = session.parts.find((candidate) => candidate.partId === partId);
    invariant(part !== undefined, "Unbekannte serverseitige Paketteilkennung.");
    invariant(proof.bytes === part.bytes && proof.sha256 === part.sha256, "Signierter Paketteilbeleg stimmt nicht mit dem serverseitigen Inventar überein.");
    const finalPath = await this.#ensurePackageParent(importId, part.packagePath);
    const temporaryPath = join(this.#sessionRoot(importId), `.part-${part.partId}-uploading-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const observed = await writeStream(temporaryPath, source, part.bytes);
      invariant(observed.bytes === part.bytes && observed.sha256 === part.sha256, "Paketteil stimmt nicht mit Bytezahl oder SHA-256 überein.");
      invariant((await this.#readReceipt(importId)) === undefined, "Uploadsitzung wurde während des Paketteil-Uploads endgültig abgeschlossen.");
      try {
        await link(temporaryPath, finalPath);
        return { status: "stored" };
      } catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const existing = await hashFile(finalPath);
        invariant(existing.bytes === part.bytes && existing.sha256 === part.sha256, "Parallel gespeichertes Paketteil ist beschädigt.");
        return { status: "reused" };
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
    });
  }

  async #cleanupSession(importId: string): Promise<void> {
    const sessionRoot = this.#sessionRoot(importId);
    try {
      const metadata = await lstat(sessionRoot);
      invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Uploadsitzung kann nicht sicher bereinigt werden.");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await rm(sessionRoot, { recursive: true, force: true });
  }

  async #completeReceipt(receipt: FinalizationReceipt): Promise<InfraPackageQualification & { readonly stagePath: string }> {
    const session: Session = {
      schema: "zugfolge-infra-package-upload-session/v1",
      importId: receipt.importId,
      manifestBytes: receipt.manifestBytes,
      manifestSha256: receipt.manifestSha256,
      packageId: receipt.packageId,
      version: receipt.version,
      parts: receipt.parts,
    };
    const stagePath = join(this.#root, "staged", receipt.stageName);
    let qualification: InfraPackageQualification;
    try {
      qualification = await verifyStagedPackage(stagePath, session, this.#packageVerifier, this.#trustedReleaseKeys, this.#nativeOperationalVerifier);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const packageRoot = join(this.#sessionRoot(receipt.importId), "package");
      const packageMetadata = await lstat(packageRoot);
      invariant(packageMetadata.isDirectory() && !packageMetadata.isSymbolicLink(), "Paketwurzel muss ein reguläres Verzeichnis sein.");
      const parsed = parsePackageManifest(await readFile(join(packageRoot, "manifest.json")));
      invariant(parsed.packageId === session.packageId && parsed.version === session.version, "Finalisierungsbeleg und Paketmanifest weichen ab.");
      const verified = await this.#packageVerifier(packageRoot);
      invariant(verified.packageId === parsed.packageId && verified.version === parsed.version && verified.manifestSha256 === session.manifestSha256, "Game-Paketprüfung und Finalisierungsbeleg weichen voneinander ab.");
      qualification = await qualifyDeliveryPackage(packageRoot, parsed, this.#trustedReleaseKeys, session.manifestSha256, this.#nativeOperationalVerifier);
      invariant(JSON.stringify(qualification) === JSON.stringify(receipt.qualification), "Erneute Paketqualifikation weicht vom Finalisierungsbeleg ab.");
      try {
        await renameAtomic(packageRoot, stagePath, this.#renamePackage);
      } catch (renameError) {
        await reuseExistingStageAfterRenameCollision(renameError, stagePath, session, this.#packageVerifier);
      }
    }
    invariant(JSON.stringify(qualification) === JSON.stringify(receipt.qualification), "Geprüftes Stagingziel weicht vom Finalisierungsbeleg ab.");
    await this.#cleanupSession(receipt.importId);
    return { ...qualification, stagePath };
  }

  async #finalizeLocked(importId: string): Promise<InfraPackageQualification & { readonly stagePath: string }> {
      const existingReceipt = await this.#readReceipt(importId);
      if (existingReceipt) return this.#completeReceipt(existingReceipt);

      const sessionRoot = this.#sessionRoot(importId);
      const session = await this.#readSession(importId);
      invariant(session.packageId !== undefined && session.version !== undefined && Array.isArray(session.parts), "Paketmanifest wurde noch nicht vollständig angenommen.");
      const packageRoot = join(sessionRoot, "package");
      const packageMetadata = await lstat(packageRoot);
      invariant(packageMetadata.isDirectory() && !packageMetadata.isSymbolicLink(), "Paketwurzel muss ein reguläres Verzeichnis sein.");
      const parsed = parsePackageManifest(await readFile(join(packageRoot, "manifest.json")));
      invariant(parsed.packageId === session.packageId && parsed.version === session.version, "Persistierte Sitzung und Paketmanifest weichen ab.");
      const verified = await this.#packageVerifier(packageRoot);
      invariant(verified.packageId === parsed.packageId && verified.version === parsed.version && verified.manifestSha256 === session.manifestSha256, "Game-Paketprüfung und Uploadsitzung weichen voneinander ab.");
      const qualification = await qualifyDeliveryPackage(packageRoot, parsed, this.#trustedReleaseKeys, session.manifestSha256, this.#nativeOperationalVerifier);
      const stageName = `${session.packageId}-${session.version}-${session.manifestSha256.slice(0, 16)}`;
      const receipt = await this.#persistReceipt({
        schema: "zugfolge-infra-package-upload-receipt/v1",
        uploadStatus: "closed",
        importId,
        manifestBytes: session.manifestBytes,
        manifestSha256: session.manifestSha256,
        packageId: session.packageId,
        version: session.version,
        parts: session.parts,
        stageName,
        qualification,
      });
      const stagePath = join(this.#root, "staged", stageName);
      try {
        await renameAtomic(packageRoot, stagePath, this.#renamePackage);
      } catch (error) {
        await reuseExistingStageAfterRenameCollision(error, stagePath, session, this.#packageVerifier);
      }
      invariant(JSON.stringify(qualification) === JSON.stringify(receipt.qualification), "Stagingziel weicht vom terminalen Finalisierungsbeleg ab.");
      await this.#cleanupSession(importId);
      return { ...qualification, stagePath };
  }

  async finalize(importId: string): Promise<InfraPackageQualification & { readonly stagePath: string }> {
    await this.initialize();
    safeId(importId, "importId");
    return this.#withImportLock(importId, () => this.#finalizeLocked(importId));
  }

  async finalizeForOdoo(
    importId: string,
    challenge: InfraPackageFinalizationChallenge,
  ): Promise<InfraPackageQualification & {
    readonly stagePath: string;
    readonly finalizationChallenge: InfraPackageFinalizationChallenge;
    readonly finalizedAt: string;
  }> {
    await this.initialize();
    safeId(importId, "importId");
    validateFinalizationChallenge(challenge, this.#now(), true);
    const pinnedChallenge: InfraPackageFinalizationChallenge = {
      schema: challenge.schema,
      nonce: challenge.nonce,
      requestedAt: challenge.requestedAt,
    };
    return this.#withImportLock(importId, async () => {
      const existing = await this.#readOdooFinalization(importId);
      if (existing !== undefined) {
        validateFinalizationChallenge(pinnedChallenge, this.#now(), true);
        invariant(pinnedChallenge.nonce === existing.challenge.nonce, "Finalisierungsnonce wurde bereits für einen anderen Import verwendet.");
        const result = await this.#finalizeLocked(importId);
        const { stagePath: _stagePath, ...qualification } = result;
        invariant(JSON.stringify(existing.qualification) === JSON.stringify(qualification), "Persistierte Odoo-Finalisierungsbindung weicht vom Stagingzustand ab.");
        return { ...result, finalizationChallenge: existing.challenge, finalizedAt: existing.finalizedAt };
      }

      validateFinalizationChallenge(pinnedChallenge, this.#now(), true);
      const result = await this.#finalizeLocked(importId);
      const { stagePath: _stagePath, ...qualification } = result;
      const finalizedAtNow = this.#now();
      const finalizedAt = finalizedAtNow.toISOString();
      validateFinalizationChallenge(pinnedChallenge, finalizedAtNow, false);
      validateFinalizationDuration(pinnedChallenge, finalizedAt);
      const binding = await this.#persistOdooFinalization({
        schema: "zugfolge-infra-package-finalization-binding/v1",
        importId,
        challenge: pinnedChallenge,
        finalizedAt,
        qualification,
      });
      return { ...result, finalizationChallenge: binding.challenge, finalizedAt: binding.finalizedAt };
    });
  }

  async activationCandidate(importId: string): Promise<InfraPackageActivationCandidate> {
    await this.initialize();
    safeId(importId, "importId");
    return this.#withImportLock(importId, async () => {
      const finalization = await this.#readOdooFinalization(importId);
      invariant(finalization !== undefined, "InfraRelease-Paket besitzt keine persistierte Odoo-Finalisierungsbindung.");
      const result = await this.#finalizeLocked(importId);
      const { stagePath, ...qualification } = result;
      const currentOperationalProvenance = validateGermanyOperationalDeliveryV2Pair(
        qualification.version,
        qualification.deliveryReleaseId,
      ) === "integrated-provenance-v2";
      invariant(JSON.stringify(finalization.qualification) === JSON.stringify(qualification), "Odoo-Finalisierungsbindung weicht vom erneut qualifizierten Paket ab.");
      invariant(
        qualification.signatureStatus === "verified"
          && qualification.nativeOperationalValidationStatus === "verified"
          && qualification.operationalStateHash !== null
          && (!currentOperationalProvenance || (
            qualification.operationalProvenanceStatus === "verified"
            && qualification.operationalProvenanceSha256 !== null
            && qualification.operationalExecutionProofSha256 !== null
            && qualification.operationalValidatorSha256 !== null
            && qualification.operationalAuthorityStatus === "verified"
            && qualification.operationalAuthoritySha256 !== null
            && qualification.operationalRebuildAttestationSha256 !== null
            && qualification.operationalExecutionAuthorityAttestationSha256 !== null
            && qualification.operationalOuterExecutionReceiptSha256 !== null
            && qualification.operationalOuterExecutionCompletionSha256 !== null
            && qualification.operationalAuthoritySourceCommit !== null
          ))
          && qualification.activationBlocker === null
          && qualification.activationEligible === true,
        "Nur ein signiertes und nativ validiertes Delivery-v2-Paket darf einen Weltkandidaten speisen.",
      );

      const manifestBytes = await readFile(join(stagePath, "manifest.json"));
      const parsed = parsePackageManifest(manifestBytes);
      invariant(sha256(manifestBytes) === qualification.manifestSha256, "Aktivierungskandidat gehoert zu einem anderen Paketmanifest.");
      const deliveryFile = parsed.files.find(({ kind }) => kind === "release-manifest");
      const sourcesFile = parsed.files.find(({ kind }) => kind === "source-manifest");
      const qualityFile = parsed.files.find(({ kind }) => kind === "quality-manifest");
      const operationalFile = parsed.files.find(({ kind }) => kind === OPERATIONAL_INFRASTRUCTURE_KIND);
      invariant(
        deliveryFile !== undefined
          && sourcesFile !== undefined
          && qualityFile !== undefined
          && operationalFile !== undefined
          && operationalFile.installPath === "operational-infrastructure-v2.json"
          && operationalFile.infraReleaseId !== undefined
          && operationalFile.stateHash !== undefined,
        "Aktivierungskandidat besitzt keinen vollstaendigen Delivery-v2-Vertrag.",
      );
      const [delivery, sources, quality] = await Promise.all([
        readPackagedJson(stagePath, deliveryFile),
        readPackagedJson(stagePath, sourcesFile),
        readPackagedJson(stagePath, qualityFile),
      ]);
      const bindings = record(delivery.value["bindings"], "Delivery-Aktivierungsbindungen");
      const signature = record(delivery.value["signature"], "Delivery-Aktivierungssignatur");
      const infraReleaseHash = String(bindings["infraReleaseHash"] ?? "");
      const deliveryReleaseHash = String(delivery.value["releaseHash"] ?? "");
      const timetableYear = delivery.value["timetableYear"];
      invariant(
        delivery.value["releaseId"] === qualification.deliveryReleaseId
          && SHA256.test(infraReleaseHash)
          && SHA256.test(deliveryReleaseHash)
          && Number.isSafeInteger(timetableYear)
          && (timetableYear as number) >= 2026
          && signature["algorithm"] === "Ed25519"
          && typeof signature["keyId"] === "string"
          && typeof signature["valueBase64"] === "string",
        "Delivery-v2-Aktivierungsbindung ist unvollstaendig.",
      );
      const sourceContract = record(sources.value, "Delivery-Aktivierungsquellen");
      const sourceEntries = sourceContract["sources"];
      invariant(Array.isArray(sourceEntries) && sourceEntries.length > 0, "Delivery-v2-Aktivierung besitzt keine Rechtequellen.");
      const sourceIds = sourceEntries.map((entry) => {
        const source = record(entry, "Delivery-Aktivierungsquelle");
        invariant(source["approved"] === true, "Delivery-v2-Aktivierung enthaelt eine nicht freigegebene Quelle.");
        return safeId(source["id"], "Delivery-Aktivierungsquellen-ID");
      }).sort((left, right) => left.localeCompare(right, "en"));
      invariant(new Set(sourceIds).size === sourceIds.length, "Delivery-v2-Aktivierung enthaelt doppelte Quellen.");

      const operationalModel = record(quality.value["operationalModel"], "Operational-v2-Aktivierungsmodell");
      const operationalCoverage = record(operationalModel["coverage"], "Operational-v2-Aktivierungsabdeckung");
      const summary = record(quality.value["summary"], "Operational-v2-Aktivierungszusammenfassung");
      const classCounts = qualityClassCounts(summary["operationalQualityClassArtifactCount"], "Operational-v2-Aktivierungsqualitaetsklassen");
      const coverageReport = {
        schema: "zugfolge-infra-package-coverage/v1",
        ...operationalCoverage,
        classASections: classCounts.A,
        classBSections: classCounts.B,
        classCSections: classCounts.C,
        orderableClassCSections: 0 as const,
      };
      const signatureProof: QualifiedInfraPackageCandidate["signatureProof"] = {
        schema: currentOperationalProvenance
          ? "zugfolge-infra-package-activation-proof/v2"
          : "zugfolge-infra-package-activation-proof/v1",
        deliveryReleaseId: qualification.deliveryReleaseId,
        timetableYear: timetableYear as number,
        packageManifestSha256: qualification.manifestSha256,
        deliveryReleaseHash,
        infraReleaseHash,
        deliveryReleaseBase64: delivery.bytes.toString("base64"),
        algorithm: "Ed25519",
        keyId: signature["keyId"],
        valueBase64: signature["valueBase64"],
        signatureStatus: qualification.signatureStatus,
        nativeOperationalValidationStatus: qualification.nativeOperationalValidationStatus,
        operationalStateHash: qualification.operationalStateHash,
        ...(currentOperationalProvenance ? {
          operationalProvenanceStatus: "verified" as const,
          operationalProvenanceSha256: qualification.operationalProvenanceSha256!,
          operationalExecutionProofSha256: qualification.operationalExecutionProofSha256!,
          operationalValidatorSha256: qualification.operationalValidatorSha256!,
          operationalAuthorityStatus: "verified" as const,
          operationalAuthoritySha256: qualification.operationalAuthoritySha256!,
          operationalRebuildAttestationSha256: qualification.operationalRebuildAttestationSha256!,
          operationalExecutionAuthorityAttestationSha256: qualification.operationalExecutionAuthorityAttestationSha256!,
          operationalOuterExecutionReceiptSha256: qualification.operationalOuterExecutionReceiptSha256!,
          operationalOuterExecutionCompletionSha256: qualification.operationalOuterExecutionCompletionSha256!,
          operationalAuthoritySourceCommit: qualification.operationalAuthoritySourceCommit!,
        } : {}),
      };
      return Object.freeze({
        releaseId: qualification.deliveryReleaseId,
        releaseHash: infraReleaseHash,
        timetableYear: timetableYear as number,
        packageManifestSha256: qualification.manifestSha256,
        signatureProof: Object.freeze(signatureProof),
        coverageReport: Object.freeze(coverageReport),
        rightsReport: Object.freeze({
          schema: "zugfolge-infra-package-rights/v1",
          approved: true as const,
          sourceIds: Object.freeze(sourceIds),
        }),
        deviationReport: Object.freeze({
          schema: "zugfolge-infra-package-deviation/v1",
          packageManifestSha256: qualification.manifestSha256,
          deliveryReleaseHash,
          operationalStateHash: qualification.operationalStateHash,
          visibleMapClassCFeatureCount: summary["visibleMapClassCFeatureCount"],
          unresolvedRequired: summary["unresolvedRequired"],
        }),
        impactPreview: Object.freeze({
          schema: "zugfolge-infra-package-impact-preview/v1",
          releaseId: qualification.deliveryReleaseId,
          releaseHash: infraReleaseHash,
          packageManifestSha256: qualification.manifestSha256,
          operationalStateHash: qualification.operationalStateHash,
          sourceIds: Object.freeze(sourceIds),
          coverage: Object.freeze({ ...operationalCoverage }),
        }),
        operationalInfrastructure: Object.freeze({
          schemaVersion: "zugfolge-operational-infrastructure-binding/v2" as const,
          infraReleaseId: operationalFile.infraReleaseId,
          file: "operational-infrastructure-v2.json" as const,
          bytes: operationalFile.bytes,
          sha256: operationalFile.sha256,
          stateHash: operationalFile.stateHash,
        }),
      });
    });
  }
}

async function verifyStagedPackage(
  stagePath: string,
  session: Session,
  packageVerifier: InfraPackageVerifier,
  trustedReleaseKeys: Readonly<Record<string, string>>,
  nativeOperationalVerifier: InfraOperationalV2NativeVerifier | undefined,
): Promise<InfraPackageQualification> {
  const metadata = await lstat(stagePath);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Stagingziel ist kein reguläres Paketverzeichnis.");
  const manifestBytes = await readFile(join(stagePath, "manifest.json"));
  invariant(manifestBytes.length === session.manifestBytes && sha256(manifestBytes) === session.manifestSha256, "Stagingziel gehört zu einem anderen Paketmanifest.");
  const parsed = parsePackageManifest(manifestBytes);
  invariant(parsed.packageId === session.packageId && parsed.version === session.version, "Stagingziel gehört zu einem anderen Paket.");
  const verified = await packageVerifier(stagePath);
  invariant(verified.packageId === parsed.packageId && verified.version === parsed.version && verified.manifestSha256 === session.manifestSha256, "Wiederverwendetes Stagingziel besteht die Game-Paketprüfung nicht.");
  return qualifyDeliveryPackage(stagePath, parsed, trustedReleaseKeys, session.manifestSha256, nativeOperationalVerifier);
}

async function verifyReusableStageIdentity(
  stagePath: string,
  session: Session,
  packageVerifier: InfraPackageVerifier,
): Promise<void> {
  const metadata = await lstat(stagePath);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Vorhandenes Stagingziel ist kein regulaeres Paketverzeichnis.");
  const manifestBytes = await readFile(join(stagePath, "manifest.json"));
  invariant(
    manifestBytes.length === session.manifestBytes && sha256(manifestBytes) === session.manifestSha256,
    "Vorhandenes Stagingziel gehoert zu einem anderen Paketmanifest.",
  );
  const parsed = parsePackageManifest(manifestBytes);
  invariant(
    parsed.packageId === session.packageId && parsed.version === session.version,
    "Vorhandenes Stagingziel gehoert zu einem anderen Paket.",
  );
  const verified = await packageVerifier(stagePath);
  invariant(
    verified.packageId === parsed.packageId
      && verified.version === parsed.version
      && verified.manifestSha256 === session.manifestSha256,
    "Vorhandenes Stagingziel besteht die vollstaendige Game-Paketpruefung nicht.",
  );
}

async function reuseExistingStageAfterRenameCollision(
  renameError: unknown,
  stagePath: string,
  session: Session,
  packageVerifier: InfraPackageVerifier,
): Promise<void> {
  if (!["EEXIST", "ENOENT", "ENOTEMPTY", "EPERM"].includes(errorCode(renameError))) throw renameError;
  try {
    await verifyReusableStageIdentity(stagePath, session, packageVerifier);
  } catch (targetError) {
    if (errorCode(targetError) === "ENOENT") throw renameError;
    throw targetError;
  }
}

async function readPackagedJson(packageRoot: string, file: PackageFile): Promise<{ readonly value: Record<string, unknown>; readonly bytes: Buffer }> {
  invariant(file.bytes <= MAX_MANIFEST_BYTES, `${file.kind} ist für ein öffentliches JSON-Manifest zu groß.`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (const part of file.parts) {
    const chunk = await readFile(join(packageRoot, ...part.packagePath.split("/")));
    chunks.push(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === file.bytes, `${file.kind} ist unvollständig.`);
  const buffer = Buffer.concat(chunks, bytes);
  let value: unknown;
  try { value = JSON.parse(buffer.toString("utf8")); } catch { throw new InfraPackageStagingError(`${file.kind} ist kein gültiges JSON.`); }
  return { value: record(value, file.kind), bytes: buffer };
}

async function qualifyDeliveryPackage(
  packageRoot: string,
  parsed: ParsedPackageManifest,
  trustedKeys: Readonly<Record<string, string>>,
  manifestSha256: string,
  nativeOperationalVerifier: InfraOperationalV2NativeVerifier | undefined,
): Promise<InfraPackageQualification> {
  const deliveryFile = parsed.files.find(({ kind }) => kind === "release-manifest");
  const sourcesFile = parsed.files.find(({ kind }) => kind === "source-manifest");
  const qualityFile = parsed.files.find(({ kind }) => kind === "quality-manifest");
  invariant(deliveryFile !== undefined && sourcesFile !== undefined && qualityFile !== undefined, "Öffentliche Delivery-, Quellen- oder Qualitätsdatei fehlt.");
  const [delivery, sources, quality] = await Promise.all([
    readPackagedJson(packageRoot, deliveryFile), readPackagedJson(packageRoot, sourcesFile), readPackagedJson(packageRoot, qualityFile),
  ]);
  const currentOperationalProvenance = germanyOperationalDeliveryV2Generation(parsed.version) === "integrated-provenance-v2";
  const deliveryContract = exactKeys(delivery.value, [
    "schema", "releaseId", "timetableYear", "packageId", "packageVersion", "scope", "artifacts", "bindings",
    "approvalGates", "releaseHash", "signature", ...(currentOperationalProvenance ? ["operationalAuthority", "operationalProvenance"] : []),
  ], "Delivery-Release");
  invariant(delivery.bytes.equals(Buffer.from(canonicalManifest(deliveryContract), "utf8")), "release.json ist nicht kanonisch serialisiert.");
  invariant(deliveryContract["schema"] === DELIVERY_SCHEMA, "release.json ist kein vollständiger öffentlicher Delivery-Release.");
  const releaseId = safeId(deliveryContract["releaseId"], "Delivery releaseId");
  validateGermanyOperationalDeliveryV2Pair(parsed.version, releaseId);
  const yearMatch = /^infra-deutschland-(\d{4})(?:\.|$)/.exec(releaseId);
  invariant(
    yearMatch !== null
      && Number.isSafeInteger(deliveryContract["timetableYear"])
      && (deliveryContract["timetableYear"] as number) >= 2026
      && deliveryContract["timetableYear"] === Number(yearMatch[1]),
    "Delivery-Release bindet kein konsistentes Fahrplanjahr.",
  );
  const scope = exactKeys(deliveryContract["scope"], ["basemap", "infrastructure", "playableArea"], "Delivery-Scope");
  invariant(
    scope["basemap"] === "world-z0-10-and-germany-z11-15"
      && scope["infrastructure"] === "germany-ebo-complete-visible-corpus"
      && scope["playableArea"] === "configured-separately-by-world",
    "Delivery-Release besitzt keinen Operational-v2-Auslieferungsscope.",
  );
  invariant(deliveryContract["packageId"] === parsed.packageId && deliveryContract["packageVersion"] === parsed.version, "Delivery-Release ist nicht an dieses Paket gebunden.");
  const operationalProvenance = currentOperationalProvenance
    ? validateOperationalProvenance(deliveryContract["operationalProvenance"])
    : undefined;
  const operationalAuthority = currentOperationalProvenance
    ? validateOperationalAuthority(deliveryContract["operationalAuthority"])
    : undefined;
  const bindings = exactKeys(delivery.value["bindings"], [
    "packageManifestSchema", "infraReleaseSchema", "mapReleaseSchema", "infraReleaseHash", "mapReleaseHash",
    "sourcesSha256", "qualitySha256", ...(currentOperationalProvenance ? ["operationalAuthoritySha256", "operationalProvenanceSha256"] : []),
  ], "Delivery bindings");
  invariant(
    bindings["packageManifestSchema"] === PACKAGE_SCHEMA
      && bindings["infraReleaseSchema"] === "zugfolge-infra-release/v2"
      && bindings["mapReleaseSchema"] === "zugfolge-map-release/v1"
      && SHA256.test(String(bindings["infraReleaseHash"]))
      && SHA256.test(String(bindings["mapReleaseHash"]))
      && bindings["sourcesSha256"] === sha256(sources.bytes)
      && bindings["qualitySha256"] === sha256(quality.bytes),
    "Delivery-Release bindet Paketvertrag, Infra-/Map-Release-Hüllen, Quellen oder Qualität nicht bytegenau.",
  );
  if (operationalProvenance !== undefined) {
    invariant(
      bindings["operationalProvenanceSha256"] === operationalProvenance.sha256
        && bindings["operationalAuthoritySha256"] === operationalAuthority?.sha256,
      "Delivery-v2 bindet die integrierte Operational-v2-Provenienz oder Build-Authority nicht kanonisch.",
    );
  }
  invariant(Array.isArray(deliveryContract["artifacts"]), "Delivery-Release besitzt kein vollständiges Artefaktinventar.");
  const deliveredArtifacts = [...(deliveryContract["artifacts"] as unknown[])].map((entry) => {
    const artifact = record(entry, "Delivery-Artefakt");
    const id = safeId(artifact["id"], "Delivery-Artefakt-ID");
    const kind = String(artifact["kind"]);
    const installPath = portablePath(artifact["installPath"], `${id}.installPath`);
    invariant(Number.isSafeInteger(artifact["bytes"]) && (artifact["bytes"] as number) > 0 && SHA256.test(String(artifact["sha256"])), `Delivery-Artefakt ${id} hat keinen Byte-SHA-Vertrag.`);
    const expectedKeys = kind === OPERATIONAL_INFRASTRUCTURE_KIND
      ? "bytes,id,infraReleaseId,installPath,kind,sha256,stateHash"
      : "bytes,id,installPath,kind,sha256";
    invariant(Object.keys(artifact).sort().join(",") === expectedKeys, `Delivery-Artefakt ${id} besitzt unerwartete Felder.`);
    const operationalBinding = kind === OPERATIONAL_INFRASTRUCTURE_KIND
      ? { infraReleaseId: safeId(artifact["infraReleaseId"], `${id}.infraReleaseId`), stateHash: String(artifact["stateHash"] ?? "") }
      : {};
    if (kind === OPERATIONAL_INFRASTRUCTURE_KIND) invariant(SHA256.test(operationalBinding.stateHash!) && operationalBinding.stateHash !== artifact["sha256"], `Delivery-Artefakt ${id} besitzt keine getrennte Operational-v2-Zustandsbindung.`);
    return { id, kind, installPath, ...operationalBinding, bytes: artifact["bytes"] as number, sha256: String(artifact["sha256"]) };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));
  const expectedArtifacts = parsed.files
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))
    .map(({ id, kind, installPath, infraReleaseId, stateHash, bytes, sha256: fileSha256 }) => ({
      id, kind, installPath,
      ...(kind === OPERATIONAL_INFRASTRUCTURE_KIND ? { infraReleaseId, stateHash } : {}),
      bytes, sha256: fileSha256,
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(JSON.stringify(deliveredArtifacts) === JSON.stringify(expectedArtifacts), "Delivery-Release bindet nicht exakt alle ausgelieferten Artefakte.");
  const deliveredOperational = deliveredArtifacts.filter(({ kind }) => kind === OPERATIONAL_INFRASTRUCTURE_KIND);
  const deliveredMovementRoutes = deliveredArtifacts.filter(({ kind }) => kind === MOVEMENT_ROUTE_TEMPLATES_KIND);
  const deliveredTransferDemands = deliveredArtifacts.filter(({ kind }) => kind === TIMETABLE_TRANSFER_DEMANDS_KIND);
  invariant(deliveredOperational.length === 1 && deliveredOperational[0]?.infraReleaseId === releaseId, "Operational-v2-Artefakt ist nicht an die Delivery-InfraRelease-ID gebunden.");
  invariant(
    deliveredMovementRoutes.length === 1
      && deliveredMovementRoutes[0]?.installPath === "operational-infrastructure-v2.movement-route-templates-v2.json"
      && deliveredTransferDemands.length === 1
      && deliveredTransferDemands[0]?.installPath === "timetable-routes-v2.transfer-demands-v2.json",
    "Delivery-v2 bindet die beiden betrieblichen Sidecars nicht genau einmal an ihre kanonischen Paketpfade.",
  );
  const sourceContract = exactKeys(sources.value, [
    "schema", "releaseId", "sources", "assetInventoryPlanSha256", "assetNotices",
  ], "Delivery-Quellenvertrag");
  invariant(
    sourceContract["schema"] === SOURCES_SCHEMA
      && sourceContract["releaseId"] === releaseId
      && Array.isArray(sourceContract["sources"])
      && SHA256.test(String(sourceContract["assetInventoryPlanSha256"])),
    "sources.json hat keinen gebundenen öffentlichen Quellen- und Asset-Inventarvertrag.",
  );
  const sourceEntries = sourceContract["sources"] as unknown[];
  invariant(sourceEntries.length > 0 && sourceEntries.every((entry) => {
    const source = record(entry, "Quelle");
    return source["approved"] === true && typeof source["license"] === "string" && typeof source["attribution"] === "string" && source["attribution"].trim() !== "";
  }), "Öffentliche Quellenfreigabe ist unvollständig.");
  invariant(sourceEntries.some((entry) => /openstreetmap/i.test(String(record(entry, "Quelle")["attribution"]))) && sourceEntries.some((entry) => /protomaps/i.test(String(record(entry, "Quelle")["attribution"]))), "Basemap-Attributionen für OpenStreetMap und Protomaps fehlen.");
  const assetNoticeSummary = validateMapAssetNotices(sourceContract["assetNotices"], parsed.files);
  const qualitySummary = validateOperationalQuality(
    quality.value,
    releaseId,
    deliveredOperational[0]!,
    deliveredMovementRoutes[0]!,
    deliveredTransferDemands[0]!,
  );
  const gates = record(deliveryContract["approvalGates"], "Delivery approvalGates");
  const deliveryQualityGate = exactKeys(gates["quality"], [
    "status", "reportSchema", "visibleLayers", "visibleFeatures", "visibleMapClassCFeatureCount",
    "operationalClassCArtifactCount", "classCOrderable",
  ], "Delivery Qualitäts-Gate");
  const deliveryRightsGate = exactKeys(gates["rights"], [
    "status", "sourceManifestSchema", "sourceCount", "assetGroupCount", "assetFileCount",
  ], "Delivery Rechte-Gate");
  invariant(
    deliveryRightsGate["status"] === "passed"
      && deliveryRightsGate["sourceManifestSchema"] === SOURCES_SCHEMA
      && deliveryRightsGate["sourceCount"] === sourceEntries.length
      && deliveryRightsGate["assetGroupCount"] === assetNoticeSummary.assetGroups
      && deliveryRightsGate["assetFileCount"] === assetNoticeSummary.assetFiles
      && deliveryQualityGate["status"] === "passed"
      && deliveryQualityGate["reportSchema"] === QUALITY_SCHEMA
      && deliveryQualityGate["visibleLayers"] === qualitySummary.visibleLayers
      && deliveryQualityGate["visibleFeatures"] === qualitySummary.visibleFeatures
      && deliveryQualityGate["visibleMapClassCFeatureCount"] === qualitySummary.visibleMapClassCFeatureCount
      && deliveryQualityGate["operationalClassCArtifactCount"] === 0
      && deliveryQualityGate["classCOrderable"] === false,
    "Rechte- oder Qualitätsgate ist nicht bestanden oder weicht vom Operational-v2-Qualitätsbericht ab.",
  );
  const signatureGate = record(gates["signature"], "Signatur-Gate");
  if (signatureGate["status"] === "missing") {
    const unsignedSignatureGate = exactKeys(signatureGate, ["status", "reason"], "Unsigniertes Delivery-Signaturgate");
    invariant(
      typeof unsignedSignatureGate["reason"] === "string"
        && unsignedSignatureGate["reason"].trim() !== ""
        && deliveryContract["signature"] === null
        && deliveryContract["releaseHash"] === null,
      "Unsignierter Delivery-Release muss Grund, null-Signatur und null-Releasehash explizit ausweisen.",
    );
    return {
      packageId: parsed.packageId,
      version: parsed.version,
      manifestSha256,
      deliveryReleaseId: releaseId,
      signatureStatus: "missing",
      nativeOperationalValidationStatus: "missing",
      operationalStateHash: null,
      operationalProvenanceStatus: "missing",
      operationalProvenanceSha256: null,
      operationalExecutionProofSha256: null,
      operationalValidatorSha256: null,
      operationalAuthorityStatus: "missing",
      operationalAuthoritySha256: null,
      operationalRebuildAttestationSha256: null,
      operationalExecutionAuthorityAttestationSha256: null,
      operationalOuterExecutionReceiptSha256: null,
      operationalOuterExecutionCompletionSha256: null,
      operationalAuthoritySourceCommit: null,
      activationBlocker: "delivery-signature-missing",
      activationEligible: false,
    };
  }
  invariant(signatureGate["status"] === "passed", "Delivery-Signaturgate ist weder bestanden noch explizit fehlend.");
  const signature = record(deliveryContract["signature"], "Delivery-Signatur");
  const keyId = safeId(signature["keyId"], "Delivery-Signaturschlüssel");
  invariant(
    signature["algorithm"] === "Ed25519"
      && signatureGate["algorithm"] === "Ed25519"
      && signatureGate["keyId"] === keyId,
    "Delivery-Signatur und Freigabegate besitzen keine gemeinsame Ed25519-Bindung.",
  );
  invariant(
    Object.keys(signature).sort().join(",") === "algorithm,keyId,valueBase64"
      && Object.keys(signatureGate).sort().join(",") === "algorithm,keyId,status",
    "Delivery-Signaturvertrag besitzt unerwartete Felder.",
  );
  const releaseHash = String(deliveryContract["releaseHash"] ?? "");
  invariant(SHA256.test(releaseHash), "Delivery-Release besitzt keinen gültigen Releasehash.");
  const signingPayload = { ...deliveryContract };
  delete signingPayload["releaseHash"];
  delete signingPayload["signature"];
  invariant(releaseHash === sha256(canonicalManifest(signingPayload)), "Delivery-Releasehash bindet nicht den kanonischen Inhalt.");
  const signatureBase64 = String(signature["valueBase64"] ?? "");
  invariant(/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64), "Delivery-Signatur besitzt keine kanonische Ed25519-Kodierung.");
  const signatureBytes = Buffer.from(signatureBase64, "base64");
  const trustedKeyPem = trustedKeys[keyId];
  invariant(typeof trustedKeyPem === "string" && trustedKeyPem.trim() !== "", `Delivery-Signaturschlüssel '${keyId}' ist nicht vertrauenswürdig.`);
  let publicKey;
  try {
    publicKey = createPublicKey(canonicalEd25519SpkiPublicKeyPem(trustedKeyPem, keyId));
  } catch {
    throw new InfraPackageStagingError(`Delivery-Signaturschlüssel '${keyId}' ist ungültig.`);
  }
  invariant(
    publicKey.asymmetricKeyType === "ed25519"
      && signatureBytes.length === 64
      && verifyEd25519(null, Buffer.from(releaseHash, "hex"), publicKey, signatureBytes),
    "Delivery-Release besitzt keine gültige vertrauenswürdige Ed25519-Signatur.",
  );
  if (nativeOperationalVerifier === undefined) {
    return {
      packageId: parsed.packageId,
      version: parsed.version,
      manifestSha256,
      deliveryReleaseId: releaseId,
      signatureStatus: "verified",
      nativeOperationalValidationStatus: "missing",
      operationalStateHash: null,
      operationalProvenanceStatus: operationalProvenance === undefined ? "missing" : "verified",
      operationalProvenanceSha256: operationalProvenance?.sha256 ?? null,
      operationalExecutionProofSha256: operationalProvenance?.executionProofSha256 ?? null,
      operationalValidatorSha256: operationalProvenance?.validatorSha256 ?? null,
      operationalAuthorityStatus: operationalAuthority === undefined ? "missing" : "verified",
      operationalAuthoritySha256: operationalAuthority?.sha256 ?? null,
      operationalRebuildAttestationSha256: operationalAuthority?.rebuildAttestationSha256 ?? null,
      operationalExecutionAuthorityAttestationSha256: operationalAuthority?.executionAuthorityAttestationSha256 ?? null,
      operationalOuterExecutionReceiptSha256: operationalAuthority?.outerExecutionReceiptSha256 ?? null,
      operationalOuterExecutionCompletionSha256: operationalAuthority?.outerExecutionCompletionSha256 ?? null,
      operationalAuthoritySourceCommit: operationalAuthority?.sourceCommit ?? null,
      activationBlocker: "operational-v2-native-validation-missing",
      activationEligible: false,
    };
  }
  const operationalFile = parsed.files.find(({ kind }) => kind === OPERATIONAL_INFRASTRUCTURE_KIND);
  invariant(
    operationalFile !== undefined
      && operationalFile.installPath === "operational-infrastructure-v2.json"
      && operationalFile.infraReleaseId === releaseId
      && operationalFile.stateHash !== undefined,
    "Operational-v2-Artefakt ist für die native Validierung nicht eindeutig gebunden.",
  );
  const nativeReceipt = await nativeOperationalVerifier({
    packageRoot,
    expectedInfraReleaseId: releaseId,
    artifact: {
      id: operationalFile.id,
      installPath: "operational-infrastructure-v2.json",
      bytes: operationalFile.bytes,
      sha256: operationalFile.sha256,
      parts: operationalFile.parts,
    },
  });
  invariant(
    nativeReceipt.schema === "operational-infrastructure-v2"
      && nativeReceipt.infraReleaseId === releaseId
      && SHA256.test(nativeReceipt.stateHash)
      && nativeReceipt.stateHash === operationalFile.stateHash,
    "Native Operational-v2-Semantikvalidierung stimmt nicht mit der signierten Releasebindung überein.",
  );
  return {
    packageId: parsed.packageId,
    version: parsed.version,
    manifestSha256,
    deliveryReleaseId: releaseId,
    signatureStatus: "verified",
    nativeOperationalValidationStatus: "verified",
    operationalStateHash: nativeReceipt.stateHash,
    operationalProvenanceStatus: operationalProvenance === undefined ? "missing" : "verified",
    operationalProvenanceSha256: operationalProvenance?.sha256 ?? null,
    operationalExecutionProofSha256: operationalProvenance?.executionProofSha256 ?? null,
    operationalValidatorSha256: operationalProvenance?.validatorSha256 ?? null,
    operationalAuthorityStatus: operationalAuthority === undefined ? "missing" : "verified",
    operationalAuthoritySha256: operationalAuthority?.sha256 ?? null,
    operationalRebuildAttestationSha256: operationalAuthority?.rebuildAttestationSha256 ?? null,
    operationalExecutionAuthorityAttestationSha256: operationalAuthority?.executionAuthorityAttestationSha256 ?? null,
    operationalOuterExecutionReceiptSha256: operationalAuthority?.outerExecutionReceiptSha256 ?? null,
    operationalOuterExecutionCompletionSha256: operationalAuthority?.outerExecutionCompletionSha256 ?? null,
    operationalAuthoritySourceCommit: operationalAuthority?.sourceCommit ?? null,
    activationBlocker: null,
    activationEligible: true,
  };
}

export interface InfraUploadSigningKey {
  readonly id: string;
  readonly secret: string;
}

export function infraFinalizationReceiptSignature(input: {
  readonly key: InfraUploadSigningKey;
  readonly receipt: InfraPackageFinalizationReceipt;
}): string {
  const currentOperationalProvenance = validateGermanyOperationalDeliveryV2Pair(
    input.receipt.packageVersion,
    input.receipt.deliveryReleaseId,
  ) === "integrated-provenance-v2";
  const expectedReceiptKeys = [
    "schema", "signatureAlgorithm", "keyId", "nonce", "requestedAt", "finalizedAt", "importId",
    "packageId", "packageVersion", "manifestSha256", "deliveryReleaseId", "operationalStateHash",
    "signatureStatus", "nativeOperationalValidationStatus", "activationBlocker", "activationEligible",
    ...(currentOperationalProvenance ? [
      "operationalProvenanceStatus", "operationalProvenanceSha256", "operationalExecutionProofSha256", "operationalValidatorSha256",
      "operationalAuthorityStatus", "operationalAuthoritySha256", "operationalRebuildAttestationSha256",
      "operationalExecutionAuthorityAttestationSha256", "operationalOuterExecutionReceiptSha256",
      "operationalOuterExecutionCompletionSha256", "operationalAuthoritySourceCommit",
    ] : []),
  ];
  invariant(
    Object.keys(input.receipt).sort().join("\0") === expectedReceiptKeys.sort().join("\0"),
    "Game-Finalisierungsbeleg besitzt unerwartete oder fehlende Felder.",
  );
  invariant(
    input.receipt.schema === (currentOperationalProvenance ? FINALIZATION_RECEIPT_SCHEMA_V2 : FINALIZATION_RECEIPT_SCHEMA_V1),
    "Game-Finalisierungsbeleg besitzt fuer seine Paketversion ein unbekanntes Schema.",
  );
  if (currentOperationalProvenance) {
    const unsigned = input.receipt.signatureStatus === "missing";
    invariant(unsigned
      ? input.receipt.operationalProvenanceStatus === "missing"
        && input.receipt.operationalProvenanceSha256 === null
        && input.receipt.operationalExecutionProofSha256 === null
        && input.receipt.operationalValidatorSha256 === null
        && input.receipt.operationalAuthorityStatus === "missing"
        && input.receipt.operationalAuthoritySha256 === null
        && input.receipt.operationalRebuildAttestationSha256 === null
        && input.receipt.operationalExecutionAuthorityAttestationSha256 === null
        && input.receipt.operationalOuterExecutionReceiptSha256 === null
        && input.receipt.operationalOuterExecutionCompletionSha256 === null
        && input.receipt.operationalAuthoritySourceCommit === null
        && input.receipt.activationBlocker === "delivery-signature-missing"
        && input.receipt.activationEligible === false
      : input.receipt.operationalProvenanceStatus === "verified"
        && SHA256.test(input.receipt.operationalProvenanceSha256 ?? "")
        && SHA256.test(input.receipt.operationalExecutionProofSha256 ?? "")
        && SHA256.test(input.receipt.operationalValidatorSha256 ?? "")
        && input.receipt.operationalAuthorityStatus === "verified"
        && SHA256.test(input.receipt.operationalAuthoritySha256 ?? "")
        && SHA256.test(input.receipt.operationalRebuildAttestationSha256 ?? "")
        && SHA256.test(input.receipt.operationalExecutionAuthorityAttestationSha256 ?? "")
        && SHA256.test(input.receipt.operationalOuterExecutionReceiptSha256 ?? "")
        && SHA256.test(input.receipt.operationalOuterExecutionCompletionSha256 ?? "")
        && GIT_COMMIT.test(input.receipt.operationalAuthoritySourceCommit ?? ""),
    "Aktueller Game-Finalisierungsbeleg bindet keinen konsistenten Operational-v2-Ausfuehrungsprovenienz-/Authority-Status.");
  } else {
    invariant(
      input.receipt.operationalProvenanceStatus === undefined
        && input.receipt.operationalProvenanceSha256 === undefined
        && input.receipt.operationalExecutionProofSha256 === undefined
        && input.receipt.operationalValidatorSha256 === undefined
        && input.receipt.operationalAuthorityStatus === undefined
        && input.receipt.operationalAuthoritySha256 === undefined
        && input.receipt.operationalRebuildAttestationSha256 === undefined
        && input.receipt.operationalExecutionAuthorityAttestationSha256 === undefined
        && input.receipt.operationalOuterExecutionReceiptSha256 === undefined
        && input.receipt.operationalOuterExecutionCompletionSha256 === undefined
        && input.receipt.operationalAuthoritySourceCommit === undefined,
      "Legacy-Game-Finalisierungsbeleg darf keine aktuelle Operational-v2-Ausfuehrungsprovenienz oder Build-Authority tragen.",
    );
  }
  invariant(SAFE_ID.test(input.key.id) && input.receipt.keyId === input.key.id, "Game-Finalisierungsbeleg und Signaturschlüssel weichen ab.");
  return createHmac("sha256", input.key.secret)
    .update(JSON.stringify(canonicalValue(input.receipt)), "utf8")
    .digest("hex");
}

export function infraUploadSignature(input: {
  readonly key: InfraUploadSigningKey;
  readonly timestamp: string;
  readonly method: string;
  readonly pathname: string;
  readonly contentBytes: number;
  readonly contentSha256: string;
}): string {
  invariant(Number.isSafeInteger(input.contentBytes) && input.contentBytes >= 0 && SHA256.test(input.contentSha256), "Upload-Signaturmetadaten sind ungültig.");
  return createHmac("sha256", input.key.secret)
    .update(`${input.timestamp}\n${input.method.toUpperCase()}\n${input.pathname}\n${input.contentBytes}\n${input.contentSha256}`, "utf8")
    .digest("hex");
}

export function verifyInfraUploadSignature(input: {
  readonly keyId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly method: string;
  readonly pathname: string;
  readonly contentBytes: number;
  readonly contentSha256: string;
  readonly keys: readonly InfraUploadSigningKey[];
  readonly now?: Date;
}): void {
  const key = input.keys.find(({ id }) => id === input.keyId);
  invariant(key !== undefined, "Unbekannter Infra-Upload-Schlüssel.");
  const issued = new Date(input.timestamp);
  const now = input.now ?? new Date();
  invariant(!Number.isNaN(issued.getTime()) && Math.abs(now.getTime() - issued.getTime()) <= 5 * 60_000, "Infra-Upload-Signatur ist abgelaufen.");
  const expected = Buffer.from(infraUploadSignature({ ...input, key }), "hex");
  const supplied = Buffer.from(input.signature, "hex");
  invariant(expected.length === supplied.length && timingSafeEqual(expected, supplied), "Infra-Upload-Signatur ist ungültig.");
}

export const INFRA_PACKAGE_PART_BYTES = PART_BYTES;
