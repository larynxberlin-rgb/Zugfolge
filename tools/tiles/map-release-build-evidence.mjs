import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { verifyGermanyOperationalInfrastructureV2PublicationReceipt } from "../region-import/germany/operational-infrastructure-v2-publication.mjs";
import {
  GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX,
} from "../region-import/germany/annual-create-new-artifact.mjs";
import {
  materializeCurrentAnnualOperationalAuthority,
  materializeOperationalBuildAuthorityFromBuildEvidenceSpec,
  operationalBuildAuthoritySha256,
  validateCurrentAnnualOperationalAuthority,
  validateOperationalBuildAuthority,
  verifyCurrentAnnualOperationalAuthorityLocal,
  verifyGithubAttestationSubject,
} from "../region-import/germany/operational-build-authority.mjs";
import {
  GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND,
  germanyOperationalProvenanceSha256,
  validateGermanyOperationalProvenance,
} from "../region-import/germany/operational-infrastructure-v2-execution-pins.mjs";
import { verifyOperationalValidatorRebuildEvidence } from "../region-import/germany/operational-validator-rebuild-evidence.mjs";
import { inspectPublicReadModel } from "./livemap-read-model.mjs";
import {
  CREATE_NEW_DIRECTORY_COMPLETION_FILE,
  verifyCreateNewDirectoryCompletion,
} from "./create-new-output.mjs";
import { validateMapAssetNoticeBindings, validateMapAssetNotices } from "./map-asset-notices.mjs";
import { validateMapBuildCacheInventoryPlan } from "./map-build-cache-inventory.mjs";
import {
  deliveryReleaseHash,
  serializeDeliveryJson,
  validateMapDeliveryQualityReport,
  verifyMapDeliveryReleaseSignature,
} from "./map-delivery-release.mjs";
import {
  expandMapPackagePlan,
  validateGermanyOperationalDeliveryV2Pair,
  serializeMapPackageManifest,
  validateMapPackageManifest,
  validateMapPackageSpec,
} from "./map-package.mjs";
import {
  deriveSignedReleaseSourceFile,
  serializeSignedMapPackagePlan,
} from "./signed-map-package-plan.mjs";
import {
  gdalRuntimeBundleBinding,
  loadAndVerifyGdalRuntimeBundle,
  PINNED_GDAL_RUNTIME_MANIFEST,
  PINNED_GDAL_RUNTIME_MANIFEST_CACHE,
  validateGdalRuntimeBundleBinding,
  validateGdalRuntimeBundleCacheInventory,
} from "./gdal-runtime-bundle.mjs";
import { inspectTrainMapProjection } from "./train-map-projection.mjs";
import {
  assertOperationalInfrastructureV2,
  operationalInfrastructureV2StateHash,
} from "../region-import/operational-infrastructure-binding.mjs";
import {
  validateOperationalInfrastructureV2Native,
  validateOperationalInfrastructureV2NativeReceipt,
} from "../region-import/materialize-operational-infrastructure-v2.mjs";
import { validateMovementRouteTemplatesV2 } from "../region-import/movement-route-templates-v2.mjs";
import {
  syntheticOperationalTimetableRoutesProof,
  validateSyntheticOperationalTimetableTransferDemands,
} from "../region-import/germany/synthetic-operational-quality.mjs";
import {
  databaseAuthoritativeCatalog,
  DATABASE_CUTOVER_CONSTRAINTS,
  databaseCutoverGuards,
} from "../alpha-ops/database-cutover-schema-contract.mjs";
import { validateKeycloakIdentityHead } from "../alpha-ops/keycloak-public-to-schema.mjs";

export {
  materializeCurrentAnnualOperationalAuthority,
  materializeOperationalBuildAuthorityFromBuildEvidenceSpec,
  operationalBuildAuthoritySha256,
  validateCurrentAnnualOperationalAuthority,
  validateOperationalBuildAuthority,
  verifyCurrentAnnualOperationalAuthorityLocal,
  verifyGithubAttestationSubject,
};

const SPEC_SCHEMA_V1 = "zugfolge-map-release-build-evidence-spec/v1";
const SPEC_SCHEMA_V2 = "zugfolge-map-release-build-evidence-spec/v2";
const SPEC_SCHEMA_V3 = "zugfolge-map-release-build-evidence-spec/v3";
const EVIDENCE_SCHEMA_V1 = "zugfolge-map-release-build-evidence/v1";
const EVIDENCE_SCHEMA_V2 = "zugfolge-map-release-build-evidence/v2";
const EVIDENCE_SCHEMA_V3 = "zugfolge-map-release-build-evidence/v3";
const DELIVERY_SCHEMA_V1 = "zugfolge-map-delivery-release/v1";
const DELIVERY_SCHEMA_V2 = "zugfolge-map-delivery-release/v2";
const DELIVERY_SOURCES_SCHEMA_V2 = "zugfolge-map-delivery-sources/v2";
const MAP_PACKAGE_PLAN_V2 = "zugfolge-map-package-plan/v2";
const MAP_PACKAGE_SPEC_V2 = "zugfolge-map-package-spec/v2";
const MAP_RUNTIME_V2 = "zugfolge-map-runtime/v2";
const CACHE_INVENTORY_SCHEMA = "zugfolge-map-build-cache-inventory/v1";
const RESTORE_MARKER_SCHEMA = "zugfolge-map-build-cache-empty-root/v1";
const RESTORE_PROOF_SCHEMA = "zugfolge-map-build-cache-restore-proof/v1";
const ROLLBACK_ATTESTATION_SCHEMA = "zugfolge-map-rollback-attestation/v1";
const RUNTIME_ROLLBACK_ATTESTATION_SCHEMA = "zugfolge-map-rollback-attestation/v3";
const RUNTIME_ROLLBACK_TUPLE_SCHEMA = "zugfolge-runtime-rollback-tuple/v3";
const DATABASE_ROLLBACK_PROOF_SCHEMA = "zugfolge-database-rollback-proof/v3";
const DATABASE_ROLLBACK_PROOF_SCHEMA_34 = "zugfolge-database-rollback-proof/v4";
const DATABASE_ROLLBACK_PROOF_SCHEMA_35 = "zugfolge-database-rollback-proof/v5";
const DATABASE_ROLLBACK_PROOF_SCHEMA_36 = "zugfolge-database-rollback-proof/v6";
const DATABASE_AUTHORITATIVE_HEAD_SCHEMA = "zugfolge-database-authoritative-head/v1";
const DATABASE_BACKUP_MANIFEST_SCHEMA = "zugfolge-database-backup-manifest/v1";
const DATABASE_RESTORE_PROOF_SCHEMA = "zugfolge-database-restore-proof/v1";
const DATABASE_RESTORE_SEPARATION_SCHEMA = "zugfolge-database-restore-separation/v1";
const DATABASE_ROLLBACK_WINDOW = "pre-activation-only";
const DATABASE_ROLLBACK_SCHEMA_MIGRATIONS = 33;
const REQUIRED_DATABASE_CONSTRAINTS = new Map(DATABASE_CUTOVER_CONSTRAINTS.map((entry) => [entry.name, entry.definitionSha256]));
const RESTORE_MARKER = ".zugfolge-empty-restore-root.json";
const INSTALLED_PACKAGE_MANIFEST = ".zugfolge-map-package.json";
const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MUTABLE_TOKEN = /(?:^|[./_:@-])(latest|unversioned|main|master|head)(?:$|[./_:@-])/i;
const RELEASE_ID = /^(?<family>[a-z0-9][a-z0-9._-]*-)(?<year>20\d{2})\.(?<patch>[1-9]\d*)$/;
const SPECIFICATION_RELEASE_TOKEN = /(?:infra-deutschland|germany)-(?<year>20\d{2})\.(?<patch>[1-9]\d*)/g;
const SPECIFICATION_ANNUAL_PATH_TOKEN = /(?:^|[/.])annual-(?<year>20\d{2})\.(?<patch>[1-9]\d*)(?:[/.]|$)/g;
const SPECIFICATION_REUSE_MODE = "byte-identical-cross-release";
const ACTIVATION_POINTER_KEYS = Object.freeze([
  "MAP_BASEMAP_STYLE_URL",
  "MAP_GERMANY_PMTILES_URL",
  "MAP_RELEASE_HOST_DIR",
  "MAP_RELEASE_ID",
]);
const INPUT_KINDS = new Set([
  "source-archive",
  "capture-manifest",
  "specification",
  "repo-contract",
  "derived-input",
  "build-cache-inventory",
]);
const REQUIRED_INPUT_KINDS = Object.freeze([
  "source-archive",
  "capture-manifest",
  "specification",
  "build-cache-inventory",
]);
const OUTPUT_KINDS_V1 = Object.freeze([
  "basemap-pmtiles",
  "semantic-pmtiles",
  "read-model",
  "train-map-projection",
  "style",
  "delivery-manifest",
  "quality-report",
]);
const OUTPUT_KINDS_V2 = Object.freeze([
  "basemap-pmtiles",
  "semantic-pmtiles",
  "read-model",
  "operational-infrastructure-v2",
  "style",
  "delivery-manifest",
  "quality-report",
]);
const OUTPUT_KINDS_V3 = Object.freeze([
  "basemap-pmtiles",
  "semantic-pmtiles",
  "read-model",
  "operational-infrastructure-v2",
  "movement-route-templates-v2",
  "timetable-transfer-demands-v2",
  "style",
  "delivery-manifest",
  "quality-report",
]);
const OUTPUT_TO_DELIVERY_KIND = Object.freeze({
  "basemap-pmtiles": "basemap",
  "semantic-pmtiles": "infrastructure",
  "read-model": "read-model",
  "train-map-projection": "train-map-projection",
  "operational-infrastructure-v2": "operational-infrastructure-v2",
  "movement-route-templates-v2": "movement-route-templates-v2",
  "timetable-transfer-demands-v2": "timetable-transfer-demands-v2",
  style: "style",
  "quality-report": "quality-manifest",
});
const MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES = 64 * 1024 * 1024;
const ENCRYPTION_SCHEMES = new Set(["age-x25519", "gpg-aes256", "restic-repository-v2"]);
const SEMANTIC_LAYERS = Object.freeze([
  "rail_corridors",
  "operating_points",
  "stations",
  "tracks",
  "platforms",
  "switches",
  "signals",
  "blocks",
  "conflict_resources",
  "rail_context",
]);
const CURRENT_ANNUAL_V3_RELEASE_ID = "infra-deutschland-2026.5";
const BUILD_EVIDENCE_RELEASE_IDS_BY_VERSION = Object.freeze({
  1: Object.freeze(["infra-deutschland-2026.2"]),
  2: Object.freeze(["infra-deutschland-2026.3", "infra-deutschland-2026.4"]),
  3: Object.freeze([CURRENT_ANNUAL_V3_RELEASE_ID]),
});
const CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BUILD_COMMIT = "b76edcae260541de66e3b2e84869d66dd224ca80";
const CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_SHA256 = "6c652c15b2eda1c2bd29cc29377e1bbd2bdff9a6f48c7200bd7fd300d19151b1";
const CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BYTES = 8_559_757;
const CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_NORMALIZED_PE_SHA256 = "7dc19bc4c7a34492a0c45d3c67872a2226644f2e414e069999eb2e4a0b20eefe";
const OPERATIONAL_VALIDATOR_BUILD_COMMIT_VERSION = "operational-validator-build-commit";
const CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_PREDICATE = "https://slsa.dev/provenance/v1";
const CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_PREDICATE =
  "https://zugfolge.de/attestations/operational-v2-execution-authority/v1";
const CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_SCHEMA =
  "zugfolge-operational-v2-execution-authority/v1";
const CURRENT_ANNUAL_V3_OPERATIONAL_AUTHORITY_SCHEMA =
  "zugfolge-map-build-operational-authority/v1";
const CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_WORKFLOW =
  "larynxberlin-rgb/Zugfolge/.github/workflows/operational-v2-execution-authority.yml";
const CURRENT_ANNUAL_V3_REBUILD_ATTESTATION_WORKFLOW =
  "larynxberlin-rgb/Zugfolge/.github/workflows/operational-validator-rebuild-evidence.yml";
const CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_BUNDLE =
  "var/derived/germany-2026.5/toolchain/zugfolge-operational-v2-execution-authority.sigstore.json";
const CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER = Object.freeze({
  bytes: 40_998_712,
  cacheFile: "derived/infra-deutschland-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
  file: "var/derived/germany-2026.5/toolchain/gh-2.94.0-windows-amd64.exe",
  sha256: "91ed1eff1819a96b34bc2ca3adc01822c807ae1bb883c01ad9fdf335bf242b38",
  version: "2.94.0-windows-amd64",
});
const CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT = Object.freeze({
  bytes: 34_634,
  cacheFile: "derived/infra-deutschland-2026.5/toolchain/github-attestation-trusted-root.jsonl",
  file: "var/derived/germany-2026.5/toolchain/github-attestation-trusted-root.jsonl",
  sha256: "65ca537f6ed8a47fd0e560c421baa1f6c1efb8b25fc200d8c5c02c0e92eb2b9c",
});
const GH_ATTESTATION_MAX_TRUSTED_ROOT_BYTES = 16 * 1024 * 1024;
const GH_ATTESTATION_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GH_ATTESTATION_TIMEOUT_MILLISECONDS = 120_000;
const CURRENT_ANNUAL_V3_INPUTS = Object.freeze([
  ["germany-release-spec", "specification", "tools/region-import/germany/release.annual-2026.5.config.json"],
  ["synthetic-operational-policy", "specification", "tools/region-import/germany/synthetic-operational-b.2026.5.policy.json"],
  ["synthetic-operational-closure-spec", "specification", "tools/region-import/germany/synthetic-operational-closure.annual-2026.5.json"],
  ["operational-quality-spec", "specification", "tools/region-import/germany/operational-quality.annual-2026.5.json"],
  ["static-map-sources-spec", "specification", "tools/tiles/static-map-sources.annual-2026.5.json"],
  ["static-map-quality-spec", "specification", "tools/tiles/static-map-quality.annual-2026.5.json"],
  ["static-map-release-spec", "specification", "tools/tiles/static-map-release.annual-2026.5.json"],
  ["map-build-cache-inventory-plan", "specification", "tools/tiles/map-build-cache-inventory.annual-2026.5.plan.json"],
  ["map-asset-notices-spec", "specification", "tools/tiles/map-asset-notices.annual-2026.5.json"],
  ["operational-native-receipt", "derived-input", "var/derived/germany-2026.5/operational-infrastructure-v2.native-receipt.json"],
  ["operational-outer-execution-receipt", "derived-input", "var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json"],
  ["operational-outer-execution-receipt-completion", "derived-input", `var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`],
  ["operational-publication-receipt", "derived-input", "var/derived/germany-2026.5/operational-infrastructure-v2.publication-receipt.json"],
  ["operational-annual-plan", "derived-input", "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json"],
  ["operational-annual-plan-completion", "derived-input", `var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-plan.json${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`],
  ["operational-annual-executor-start-evidence", "derived-input", "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json"],
  ["operational-annual-executor-start-evidence-completion", "derived-input", `var/derived/germany-2026.5/toolchain/zugfolge-infra-release-annual-executor-start-evidence.json${GERMANY_ANNUAL_CREATE_NEW_COMPLETION_SUFFIX}`],
  ["operational-validator-rebuild-evidence", "derived-input", "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-evidence.json"],
  ["operational-validator-rebuild-attestation", "derived-input", "var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-attestation.sigstore.json"],
  ["operational-execution-authority-attestation", "derived-input", CURRENT_ANNUAL_V3_EXECUTION_AUTHORITY_BUNDLE],
  ["operational-attestation-verifier", "derived-input", CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.file],
  ["operational-attestation-trusted-root", "derived-input", CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.file],
  ["operational-native-receipt-capture", "repo-contract", "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs"],
  ["operational-recovery-publisher", "repo-contract", "tools/region-import/germany/publish-operational-infrastructure-v2.mjs"],
  ["operational-recovery-publisher-implementation", "repo-contract", "tools/region-import/germany/operational-infrastructure-v2-publication.mjs"],
  ["operational-v2-deriver", "repo-contract", "tools/region-import/germany/operational-infrastructure-v2.mjs"],
  ["operational-v2-materializer", "repo-contract", "tools/region-import/materialize-operational-infrastructure-v2.mjs"],
  ["create-new-output-contract", "repo-contract", "tools/tiles/create-new-output.mjs"],
  ["operational-v2-binding", "repo-contract", "tools/region-import/operational-infrastructure-binding.mjs"],
  ["operational-validator-rebuild-spec", "repo-contract", "tools/region-import/germany/operational-validator-rebuild.annual-2026.5.json"],
  ["operational-validator-rebuild-verifier", "repo-contract", "tools/region-import/germany/operational-validator-rebuild-evidence.mjs"],
  ["operational-validator-rebuild-bootstrap", "repo-contract", "tools/region-import/germany/operational-validator-rebuild-bootstrap.mjs"],
  ["operational-validator-rebuild-cli", "repo-contract", "tools/region-import/germany/operational-validator-rebuild-evidence-cli.mjs"],
  ["germany-source-catalog", "repo-contract", "tools/region-import/germany/source-catalog.json"],
  ["rights-registry", "repo-contract", "tools/guards/quellenregister.json"],
  ["map-source-catalog", "repo-contract", "tools/tiles/map-source-catalog.json"],
]);
const CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL = Object.freeze({
  id: "operational-v2-validator",
  kind: "binary",
  version: OPERATIONAL_VALIDATOR_BUILD_COMMIT_VERSION,
  file: `var/derived/germany-2026.5/toolchain/zugfolge-infra-release-${CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BUILD_COMMIT}-${CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_SHA256}.exe`,
  cacheFile: `tools/zugfolge-infra-release/infra-deutschland-2026.5/${CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BUILD_COMMIT}/${CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_SHA256}/zugfolge-infra-release.exe`,
  expectedBytes: CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BYTES,
  expectedSha256: CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_SHA256,
});
const CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL = Object.freeze({
  id: "operational-v2-validator-rebuild",
  kind: "binary",
  version: "operational-validator-rebuild-proof",
  file: `var/derived/germany-2026.5/toolchain/zugfolge-infra-release-rebuild-${CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BUILD_COMMIT}-official.exe`,
  cacheFile: `tools/zugfolge-infra-release/infra-deutschland-2026.5/${CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BUILD_COMMIT}/official/zugfolge-infra-release.exe`,
});
const CURRENT_ANNUAL_V3_OPERATIONAL_EXECUTION_INPUTS = Object.freeze({
  wrapper: "operational-recovery-publisher",
  implementation: "operational-recovery-publisher-implementation",
  operationalDeriver: "operational-v2-deriver",
  materializer: "operational-v2-materializer",
  createNewOutput: "create-new-output-contract",
  operationalBinding: "operational-v2-binding",
  validatorRebuildBootstrap: "operational-validator-rebuild-bootstrap",
  validatorRebuildVerifier: "operational-validator-rebuild-verifier",
});
const CURRENT_ANNUAL_V3_OPERATIONAL_REBUILD_PRODUCER_INPUTS = Object.freeze({
  bootstrap: "operational-validator-rebuild-bootstrap",
  entrypoint: "operational-validator-rebuild-cli",
  implementation: "operational-validator-rebuild-verifier",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function specVersion(schema) {
  if (schema === SPEC_SCHEMA_V1) return 1;
  if (schema === SPEC_SCHEMA_V2) return 2;
  if (schema === SPEC_SCHEMA_V3) return 3;
  throw new Error("Unbekanntes Build-Evidence-Spezifikationsschema.");
}

function evidenceVersion(schema) {
  if (schema === EVIDENCE_SCHEMA_V1) return 1;
  if (schema === EVIDENCE_SCHEMA_V2) return 2;
  if (schema === EVIDENCE_SCHEMA_V3) return 3;
  throw new Error("Unbekanntes Build-Evidence-Manifest.");
}

function validateBuildEvidenceReleaseGeneration(version, releaseId) {
  invariant(
    BUILD_EVIDENCE_RELEASE_IDS_BY_VERSION[version]?.includes(releaseId) === true,
    `Build-Evidence-v${version} ist nicht fuer den Release ${releaseId} zugelassen.`,
  );
}

function outputKindsForVersion(version) {
  if (version === 3) return OUTPUT_KINDS_V3;
  return version === 2 ? OUTPUT_KINDS_V2 : OUTPUT_KINDS_V1;
}

function evidenceSchemaForVersion(version) {
  if (version === 3) return EVIDENCE_SCHEMA_V3;
  return version === 2 ? EVIDENCE_SCHEMA_V2 : EVIDENCE_SCHEMA_V1;
}

function specSchemaForEvidence(evidence) {
  const version = evidenceVersion(evidence?.schema);
  if (version === 3) return SPEC_SCHEMA_V3;
  return version === 2 ? SPEC_SCHEMA_V2 : SPEC_SCHEMA_V1;
}

function operationalEvidenceVersion(version) {
  return version >= 2;
}

function firstClassOperationalSidecarsVersion(version) {
  return version >= 3;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

export function serializeMapReleaseBuildEvidence(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValueSha256(value) {
  return sha256Bytes(Buffer.from(JSON.stringify(sortedValue(value)), "utf8"));
}

function exactObjectKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} besitzt fremde oder fehlende Felder.`,
  );
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeAlphaValue(value) {
  if (Array.isArray(value)) return value.map(decodeAlphaValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (
      entries.length === 2
      && value.$zugfolgeType === "bigint"
      && typeof value.value === "string"
      && /^(?:0|-?[1-9][0-9]*)$/.test(value.value)
    ) {
      return BigInt(value.value);
    }
    if (entries.length === 1 && entries[0][0] === "$bigint" && typeof entries[0][1] === "string" && /^(?:0|-?[1-9][0-9]*)$/.test(entries[0][1])) {
      return BigInt(entries[0][1]);
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, decodeAlphaValue(item)]));
  }
  return value;
}

function alphaCanonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() });
  if (typeof value === "number") {
    invariant(Number.isSafeInteger(value), "Alpha-Deployment enthaelt keine sichere Ganzzahl.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(alphaCanonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${alphaCanonical(item)}`).join(",")}}`;
  }
  throw new Error("Alpha-Deployment enthaelt einen nicht kanonisierbaren Wert.");
}

function alphaHash(schema, value) {
  return sha256Bytes(Buffer.from(alphaCanonical({ schema, value }), "utf8"));
}

function stableId(value, label) {
  invariant(typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(value), `${label} ist keine stabile ID.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert sein.`);
  return value;
}

function pinnedVersion(value, label) {
  invariant(typeof value === "string" && value.trim() === value && value.length > 0, `${label} besitzt keine gepinnte Version.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert sein.`);
  return value;
}

function encryptionScheme(value) {
  pinnedVersion(value, "buildCache.encryptionScheme");
  invariant(ENCRYPTION_SCHEMES.has(value), "Buildcache verwendet kein freigegebenes Verschlüsselungsverfahren.");
  return value;
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0 && !isAbsolute(value), `${label} muss ein relativer Pfad sein.`);
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} ist nicht portabel.`);
  const parts = value.split("/");
  invariant(parts.every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthält einen unsicheren Pfadabschnitt.`);
  invariant(!MUTABLE_TOKEN.test(value), `${label} darf weder latest noch unversioniert enthalten.`);
  return value;
}

function validateSpecificationDescriptorReleaseBinding(descriptor, releaseId, label, { materialized = false } = {}) {
  const target = RELEASE_ID.exec(releaseId);
  const declared = RELEASE_ID.exec(descriptor.version);
  invariant(
    target !== null
      && declared !== null
      && target.groups.family === declared.groups.family
      && target.groups.year === declared.groups.year,
    `${label} muss eine konkrete Version aus der Jahresfamilie des Buildrelease deklarieren.`,
  );
  const reused = descriptor.version !== releaseId;
  if (!reused) {
    invariant(descriptor.reuse === undefined, `${label} darf fuer den aktuellen Buildrelease keine Wiederverwendung behaupten.`);
    return undefined;
  }
  invariant(
    Number(declared.groups.patch) < Number(target.groups.patch),
    `${label} darf nur eine aeltere Spezifikation derselben Jahresfamilie wiederverwenden.`,
  );
  invariant(
    descriptor.reuse !== null && typeof descriptor.reuse === "object" && !Array.isArray(descriptor.reuse),
    `${label} besitzt keine eindeutige Cross-Release-Wiederverwendungsattestation.`,
  );
  exactObjectKeys(descriptor.reuse, ["mode", "sourceReleaseId", "targetReleaseId", "artifacts"], `${label}.reuse`);
  invariant(
    descriptor.reuse.mode === SPECIFICATION_REUSE_MODE
      && descriptor.reuse.sourceReleaseId === descriptor.version
      && descriptor.reuse.targetReleaseId === releaseId,
    `${label} besitzt keine eindeutige Cross-Release-Wiederverwendungsattestation.`,
  );
  const bytes = materialized ? descriptor.bytes : descriptor.expectedBytes;
  const sha256 = materialized ? descriptor.sha256 : descriptor.expectedSha256;
  invariant(
    Number.isSafeInteger(bytes) && bytes > 0 && SHA256.test(sha256),
    `${label} muss fuer Cross-Release-Wiederverwendung Bytezahl und SHA-256 pinnen.`,
  );
  invariant(Array.isArray(descriptor.reuse.artifacts) && descriptor.reuse.artifacts.length > 0, `${label}.reuse besitzt kein Artefaktinventar.`);
  const artifacts = descriptor.reuse.artifacts.map((artifact, index) => {
    exactObjectKeys(artifact, ["sourceFile", "targetFile", "bytes", "sha256"], `${label}.reuse.artifacts[${index}]`);
    const sourceFile = portablePath(artifact.sourceFile, `${label}.reuse.artifacts[${index}].sourceFile`);
    const targetFile = portablePath(artifact.targetFile, `${label}.reuse.artifacts[${index}].targetFile`);
    invariant(sourceFile !== targetFile, `${label}.reuse.artifacts[${index}] muss getrennte Quell- und Zieldateien binden.`);
    invariant(
      Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && SHA256.test(artifact.sha256),
      `${label}.reuse.artifacts[${index}] besitzt keinen Byte-SHA-Beleg.`,
    );
    return { sourceFile, targetFile, bytes: artifact.bytes, sha256: artifact.sha256 };
  });
  invariant(
    JSON.stringify(artifacts.map(({ sourceFile }) => sourceFile))
      === JSON.stringify(artifacts.map(({ sourceFile }) => sourceFile).sort()),
    `${label}.reuse.artifacts muss kanonisch nach sourceFile sortiert sein.`,
  );
  invariant(
    new Set(artifacts.map(({ sourceFile }) => sourceFile)).size === artifacts.length
      && new Set(artifacts.map(({ targetFile }) => targetFile)).size === artifacts.length,
    `${label}.reuse.artifacts besitzt doppelte Quell- oder Zieldateien.`,
  );
  return {
    mode: descriptor.reuse.mode,
    sourceReleaseId: descriptor.reuse.sourceReleaseId,
    targetReleaseId: descriptor.reuse.targetReleaseId,
    artifacts,
  };
}

function parseReleasePair(releaseId, previousReleaseId) {
  const candidate = RELEASE_ID.exec(releaseId);
  const previous = RELEASE_ID.exec(previousReleaseId);
  invariant(candidate !== null, "releaseId muss ein unveränderlicher Jahres-Patchrelease sein.");
  invariant(previous !== null, "previousReleaseId muss ein unveränderlicher Jahres-Patchrelease sein.");
  invariant(candidate.groups.family === previous.groups.family && candidate.groups.year === previous.groups.year, "Patch- und Vorgängerrelease gehören nicht zur selben Jahresfamilie.");
  invariant(Number(candidate.groups.patch) > Number(previous.groups.patch), "Patchrelease muss neuer als der Vorgänger sein.");
}

function validateDatabaseMigrationLedger(value, label, migrationCount = DATABASE_ROLLBACK_SCHEMA_MIGRATIONS) {
  invariant(
    Array.isArray(value) && value.length === migrationCount,
    `${label} besitzt nicht exakt das Cutover-Migrationsledger mit ${migrationCount} Eintraegen.`,
  );
  let previousId = 0;
  const hashes = new Set();
  for (const [index, entry] of value.entries()) {
    exactObjectKeys(entry, ["id", "hash", "createdAt"], `${label}[${index}]`);
    invariant(Number.isSafeInteger(entry.id) && entry.id > previousId, `${label} besitzt keine streng aufsteigenden Migrations-IDs.`);
    invariant(SHA256.test(entry.hash) && !hashes.has(entry.hash), `${label} besitzt keinen eindeutigen SHA-256-Migrationshash.`);
    invariant(Number.isSafeInteger(entry.createdAt) && entry.createdAt > 0, `${label} besitzt keinen exakten Migrationszeitwert.`);
    previousId = entry.id;
    hashes.add(entry.hash);
  }
  return value;
}

function validateDatabaseConstraints(value, label) {
  invariant(Array.isArray(value) && value.length > 0, `${label} besitzt keinen validierten Constraintbeleg.`);
  const names = new Set();
  for (const [index, constraint] of value.entries()) {
    exactObjectKeys(constraint, ["name", "definitionSha256", "validated"], `${label}[${index}]`);
    const name = stableId(constraint.name, `${label}[${index}].name`);
    invariant(!names.has(name), `${label} besitzt einen doppelten Constraint.`);
    invariant(constraint.validated === true, `${label}.${name} ist nicht validiert.`);
    invariant(
      SHA256.test(constraint.definitionSha256)
        && constraint.definitionSha256 === REQUIRED_DATABASE_CONSTRAINTS.get(name),
      `${label}.${name} weicht vom eingecheckten Constraint-Sollvertrag ab.`,
    );
    names.add(name);
  }
  invariant(
    names.size === REQUIRED_DATABASE_CONSTRAINTS.size
      && [...REQUIRED_DATABASE_CONSTRAINTS.keys()].every((name) => names.has(name)),
    `${label} bindet nicht den exakten Cutover-Constraintvertrag.`,
  );
  return value;
}

function validateDatabaseGuards(value, label, migrationCount) {
  const requiredGuards = new Map(databaseCutoverGuards(migrationCount).map((entry) => [entry.name, entry.definitionSha256]));
  invariant(Array.isArray(value) && value.length > 0, `${label} besitzt keinen Unveraenderlichkeitsbeleg.`);
  const names = new Set();
  for (const [index, guard] of value.entries()) {
    exactObjectKeys(guard, ["name", "definitionSha256", "enabled"], `${label}[${index}]`);
    const name = stableId(guard.name, `${label}[${index}].name`);
    invariant(!names.has(name), `${label} besitzt einen doppelten Guard.`);
    invariant(guard.enabled === true, `${label}.${name} ist nicht aktiviert.`);
    invariant(
      SHA256.test(guard.definitionSha256)
        && guard.definitionSha256 === requiredGuards.get(name),
      `${label}.${name} weicht vom eingecheckten Guard-Sollvertrag ab.`,
    );
    names.add(name);
  }
  invariant(
    names.size === requiredGuards.size
      && [...requiredGuards.keys()].every((name) => names.has(name)),
    `${label} bindet nicht den exakten Unveraenderlichkeitsvertrag.`,
  );
  return value;
}

function validateDatabaseHeadCounts(value, label) {
  exactObjectKeys(value, ["total", "v2", "nonNullInitializationHash", "incompatible"], label);
  for (const [name, count] of Object.entries(value)) {
    invariant(Number.isSafeInteger(count) && count >= 0, `${label}.${name} ist kein sicherer nichtnegativer Zaehler.`);
  }
  invariant(value.v2 <= value.total && value.nonNullInitializationHash <= value.total && value.incompatible <= value.total, `${label} besitzt widerspruechliche Head-Zaehler.`);
  invariant(value.incompatible >= value.v2 && value.incompatible >= value.nonNullInitializationHash, `${label}.incompatible deckt die V2-/initialisierten Heads nicht ab.`);
  invariant(
    value.v2 === 0 && value.nonNullInitializationHash === 0 && value.incompatible === 0,
    `${label} liegt nicht mehr im ausschliesslichen Pre-Activation-Rollbackfenster.`,
  );
  return value;
}

function validateDatabaseRollbackSnapshot(value, label, migrationCount = DATABASE_ROLLBACK_SCHEMA_MIGRATIONS) {
  const catalog = databaseAuthoritativeCatalog(migrationCount);
  exactObjectKeys(value, ["databaseIdentity", "migrationLedger", "constraints", "guards", "heads", "authoritativeHead", "keycloakIdentityHead"], label);
  invariant(UUID_V4.test(value.databaseIdentity), `${label}.databaseIdentity ist keine persistierte UUIDv4.`);
  validateDatabaseMigrationLedger(value.migrationLedger, `${label}.migrationLedger`, migrationCount);
  validateDatabaseConstraints(value.constraints, `${label}.constraints`);
  validateDatabaseGuards(value.guards, `${label}.guards`, migrationCount);
  validateDatabaseHeadCounts(value.heads, `${label}.heads`);
  exactObjectKeys(value.authoritativeHead, ["schema", "tableCount", "tableSetSha256", "worldCount", "regionalStateCount", "domainEventCount", "stateHash"], `${label}.authoritativeHead`);
  invariant(value.authoritativeHead.schema === DATABASE_AUTHORITATIVE_HEAD_SCHEMA, `${label}.authoritativeHead besitzt ein unbekanntes Schema.`);
  invariant(value.authoritativeHead.tableCount === catalog.tables.length, `${label}.authoritativeHead.tableCount bindet nicht den exakten Schema-${migrationCount}-Tabellensatz.`);
  invariant(value.authoritativeHead.tableSetSha256 === catalog.tableSetSha256, `${label}.authoritativeHead bindet nicht den exakten autoritativen Schema-${migrationCount}-Tabellensatz.`);
  invariant(Number.isSafeInteger(value.authoritativeHead.worldCount) && value.authoritativeHead.worldCount >= 0, `${label}.authoritativeHead.worldCount ist ungueltig.`);
  invariant(Number.isSafeInteger(value.authoritativeHead.regionalStateCount) && value.authoritativeHead.regionalStateCount >= 0, `${label}.authoritativeHead.regionalStateCount ist ungueltig.`);
  invariant(/^(?:0|[1-9][0-9]*)$/.test(value.authoritativeHead.domainEventCount), `${label}.authoritativeHead.domainEventCount ist keine exakte Dezimalzahl.`);
  invariant(SHA256.test(value.authoritativeHead.stateHash), `${label}.authoritativeHead bindet keinen exakten Welt-/Runtime-/Event-Kopf.`);
  invariant(value.authoritativeHead.regionalStateCount === value.heads.total, `${label}.authoritativeHead und Heads zaehlen verschiedene Regionalzustaende.`);
  validateKeycloakIdentityHead(value.keycloakIdentityHead);
  return value;
}

function canonicalInstant(value, label) {
  invariant(typeof value === "string" && Number.isFinite(Date.parse(value)), `${label} ist kein gueltiger UTC-Zeitpunkt.`);
  invariant(new Date(value).toISOString() === value, `${label} ist nicht als kanonischer UTC-Zeitpunkt serialisiert.`);
  return value;
}

function walLsn(value, label) {
  invariant(typeof value === "string" && /^[A-F0-9]+\/[A-F0-9]{1,8}$/.test(value), `${label} ist keine kanonische PostgreSQL-WAL-LSN.`);
  const [high, low] = value.split("/");
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
}

function validateDatabaseRestoreSeparation(value, label) {
  exactObjectKeys(value, [
    "schema",
    "sourceEndpointSha256",
    "restoredEndpointSha256",
    "sourceBackendSha256",
    "restoredBackendSha256",
  ], label);
  invariant(value.schema === DATABASE_RESTORE_SEPARATION_SCHEMA, `${label} besitzt ein unbekanntes Schema.`);
  for (const name of ["sourceEndpointSha256", "restoredEndpointSha256", "sourceBackendSha256", "restoredBackendSha256"]) {
    invariant(SHA256.test(value[name]), `${label}.${name} ist kein SHA-256.`);
  }
  invariant(value.sourceEndpointSha256 !== value.restoredEndpointSha256, `${label} verwendet denselben Quell- und Restore-Endpunkt.`);
  invariant(value.sourceBackendSha256 !== value.restoredBackendSha256, `${label} verwendet dieselbe PostgreSQL-Backendinstanz fuer Quelle und Restore.`);
  return value;
}

function validateDatabaseBackupManifest(value, label, source, separation) {
  exactObjectKeys(value, [
    "schema",
    "backupId",
    "databaseIdentity",
    "sourceAuthoritativeHeadSha256",
    "sourceEndpointSha256",
    "sourceBackendSha256",
    "backupStartedWalLsn",
    "backupCompletedWalLsn",
    "writersQuiesced",
    "completedAt",
  ], label);
  invariant(value.schema === DATABASE_BACKUP_MANIFEST_SCHEMA, `${label} besitzt ein unbekanntes Schema.`);
  stableId(value.backupId, `${label}.backupId`);
  invariant(value.databaseIdentity === source.databaseIdentity, `${label} bindet eine andere persistente Datenbankinstanz.`);
  invariant(value.sourceAuthoritativeHeadSha256 === source.authoritativeHead.stateHash, `${label} bindet einen anderen autoritativen Quellkopf.`);
  invariant(value.sourceEndpointSha256 === separation.sourceEndpointSha256, `${label} bindet einen anderen Quellendpunkt.`);
  invariant(value.sourceBackendSha256 === separation.sourceBackendSha256, `${label} bindet eine andere Quell-Backendinstanz.`);
  const started = walLsn(value.backupStartedWalLsn, `${label}.backupStartedWalLsn`);
  const completed = walLsn(value.backupCompletedWalLsn, `${label}.backupCompletedWalLsn`);
  invariant(completed >= started, `${label} besitzt eine rueckwaerts laufende WAL-Spanne.`);
  invariant(value.writersQuiesced === true, `${label} wurde nicht aus einem quieszierten Quellzustand erzeugt.`);
  canonicalInstant(value.completedAt, `${label}.completedAt`);
  return value;
}

function validateDatabaseRestoreProof(value, label, source, restored, separation, backupManifestSha256) {
  exactObjectKeys(value, [
    "schema",
    "backupManifestSha256",
    "databaseIdentity",
    "sourceAuthoritativeHeadSha256",
    "restoredAuthoritativeHeadSha256",
    "sourceEndpointSha256",
    "restoredEndpointSha256",
    "sourceBackendSha256",
    "restoredBackendSha256",
    "verification",
    "verified",
    "verifiedAt",
  ], label);
  invariant(value.schema === DATABASE_RESTORE_PROOF_SCHEMA, `${label} besitzt ein unbekanntes Schema.`);
  invariant(value.backupManifestSha256 === backupManifestSha256, `${label} bindet ein anderes Backup-Manifest.`);
  invariant(value.databaseIdentity === source.databaseIdentity && value.databaseIdentity === restored.databaseIdentity, `${label} bindet nicht die wiederhergestellte persistente Datenbankinstanz.`);
  invariant(value.sourceAuthoritativeHeadSha256 === source.authoritativeHead.stateHash, `${label} bindet einen anderen autoritativen Quellkopf.`);
  invariant(value.restoredAuthoritativeHeadSha256 === restored.authoritativeHead.stateHash, `${label} bindet einen anderen autoritativen Restore-Kopf.`);
  invariant(value.sourceEndpointSha256 === separation.sourceEndpointSha256 && value.restoredEndpointSha256 === separation.restoredEndpointSha256, `${label} bindet nicht das nachgewiesene Endpunktpaar.`);
  invariant(value.sourceBackendSha256 === separation.sourceBackendSha256 && value.restoredBackendSha256 === separation.restoredBackendSha256, `${label} bindet nicht das nachgewiesene Backendpaar.`);
  invariant(value.verification === "full-database-row-fingerprint", `${label} besitzt keine vollstaendige logische Reihenverifikation.`);
  invariant(value.verified === true, `${label} ist nicht als erfolgreich verifiziert.`);
  canonicalInstant(value.verifiedAt, `${label}.verifiedAt`);
  return value;
}

function databaseRollbackProofHash(proof) {
  const { proofHash: ignoredProofHash, ...payload } = proof;
  void ignoredProofHash;
  return sha256Bytes(serializeMapReleaseBuildEvidence(payload));
}

export function validateDatabaseRollbackProof(proof, expected = {}) {
  exactObjectKeys(proof, [
    "schema",
    "releaseId",
    "previousReleaseId",
    "rollbackWindow",
    "writersQuiesced",
    "source",
    "restored",
    "restoreSeparation",
    "migrationLedgerPairSha256",
    "backupManifest",
    "backupManifestSha256",
    "restoreProof",
    "restoreProofSha256",
    "proofHash",
  ], "Datenbank-Rollbackbeleg");
  invariant([DATABASE_ROLLBACK_PROOF_SCHEMA, DATABASE_ROLLBACK_PROOF_SCHEMA_34, DATABASE_ROLLBACK_PROOF_SCHEMA_35, DATABASE_ROLLBACK_PROOF_SCHEMA_36].includes(proof.schema), "Datenbank-Rollbackbeleg besitzt ein unbekanntes Schema.");
  const migrationCount = proof.schema === DATABASE_ROLLBACK_PROOF_SCHEMA_36 ? 36 : proof.schema === DATABASE_ROLLBACK_PROOF_SCHEMA_35 ? 35 : proof.schema === DATABASE_ROLLBACK_PROOF_SCHEMA_34 ? 34 : 33;
  parseReleasePair(proof.releaseId, proof.previousReleaseId);
  if (expected.releaseId !== undefined) invariant(proof.releaseId === expected.releaseId, "Datenbank-Rollbackbeleg gehoert nicht zum Kandidatenrelease.");
  if (expected.previousReleaseId !== undefined) invariant(proof.previousReleaseId === expected.previousReleaseId, "Datenbank-Rollbackbeleg gehoert nicht zum Vorgaengerrelease.");
  invariant(proof.rollbackWindow === DATABASE_ROLLBACK_WINDOW, "Datenbank-Rollbackbeleg gilt nicht ausschliesslich im Pre-Activation-Fenster.");
  invariant(proof.writersQuiesced === true, "Datenbank-Rollbackbeleg wurde nicht bei angehaltenen Schreibern erzeugt.");
  validateDatabaseRollbackSnapshot(proof.source, "Datenbank-Rollbackbeleg.source", migrationCount);
  validateDatabaseRollbackSnapshot(proof.restored, "Datenbank-Rollbackbeleg.restored", migrationCount);
  validateDatabaseRestoreSeparation(proof.restoreSeparation, "Datenbank-Rollbackbeleg.restoreSeparation");
  invariant(
    proof.source.databaseIdentity === proof.restored.databaseIdentity,
    "Datenbank-Restore gehoert nicht zur selben persistenten Datenbankinstanz.",
  );
  invariant(
    JSON.stringify(sortedValue(proof.source)) === JSON.stringify(sortedValue(proof.restored)),
    "Datenbank-Restore weicht vom quieszierten Quellzustand ab.",
  );
  const migrationLedgerPairSha256 = canonicalValueSha256({
    source: proof.source.migrationLedger,
    restored: proof.restored.migrationLedger,
  });
  invariant(
    proof.migrationLedgerPairSha256 === migrationLedgerPairSha256,
    "Datenbank-Rollbackbeleg bindet nicht das exakte Migrationsledger-Paar.",
  );
  validateDatabaseBackupManifest(
    proof.backupManifest,
    "Datenbank-Rollbackbeleg.backupManifest",
    proof.source,
    proof.restoreSeparation,
  );
  const expectedBackupManifestSha256 = sha256Bytes(serializeMapReleaseBuildEvidence(proof.backupManifest));
  invariant(
    proof.backupManifestSha256 === expectedBackupManifestSha256,
    "Datenbank-Rollbackbeleg bindet das semantische Backup-Manifest nicht kanonisch.",
  );
  validateDatabaseRestoreProof(
    proof.restoreProof,
    "Datenbank-Rollbackbeleg.restoreProof",
    proof.source,
    proof.restored,
    proof.restoreSeparation,
    proof.backupManifestSha256,
  );
  const expectedRestoreProofSha256 = sha256Bytes(serializeMapReleaseBuildEvidence(proof.restoreProof));
  invariant(
    proof.restoreProofSha256 === expectedRestoreProofSha256,
    "Datenbank-Rollbackbeleg bindet den semantischen Restore-Beleg nicht kanonisch.",
  );
  invariant(SHA256.test(proof.proofHash) && proof.proofHash === databaseRollbackProofHash(proof), "Datenbank-Rollbackbeleg besitzt keinen gueltigen kanonischen Hash.");
  return proof;
}

export function createDatabaseRollbackProof({
  releaseId,
  previousReleaseId,
  source,
  restored,
  restoreSeparation,
  backupManifest,
  backupManifestSha256,
  restoreProof,
  restoreProofSha256,
  writersQuiesced,
  rollbackWindow,
}) {
  const candidate = {
    schema: source?.migrationLedger?.length === 36 ? DATABASE_ROLLBACK_PROOF_SCHEMA_36 : source?.migrationLedger?.length === 35 ? DATABASE_ROLLBACK_PROOF_SCHEMA_35 : source?.migrationLedger?.length === 34 ? DATABASE_ROLLBACK_PROOF_SCHEMA_34 : DATABASE_ROLLBACK_PROOF_SCHEMA,
    releaseId,
    previousReleaseId,
    rollbackWindow,
    writersQuiesced,
    source,
    restored,
    restoreSeparation,
    migrationLedgerPairSha256: canonicalValueSha256({
      source: source?.migrationLedger,
      restored: restored?.migrationLedger,
    }),
    backupManifest,
    backupManifestSha256,
    restoreProof,
    restoreProofSha256,
  };
  const proof = { ...candidate, proofHash: databaseRollbackProofHash(candidate) };
  return validateDatabaseRollbackProof(proof, { releaseId, previousReleaseId });
}

export function parseCanonicalDatabaseRollbackProof(bytes, expected = {}) {
  invariant(Buffer.isBuffer(bytes) && bytes.length > 0, "Datenbank-Rollbackbeleg fehlt als kanonisches Datei-Artefakt.");
  let proof;
  try {
    proof = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Datenbank-Rollbackbeleg ist kein gueltiges JSON-Artefakt.");
  }
  validateDatabaseRollbackProof(proof, expected);
  invariant(bytes.equals(serializeMapReleaseBuildEvidence(proof)), "Datenbank-Rollbackbeleg ist nicht kanonisch serialisiert.");
  return { proof, bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

function databaseRollbackBinding(artifact) {
  const { proof } = artifact;
  return {
    schema: proof.schema,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    proofHash: proof.proofHash,
    releaseId: proof.releaseId,
    previousReleaseId: proof.previousReleaseId,
    rollbackWindow: proof.rollbackWindow,
    writersQuiesced: proof.writersQuiesced,
    migrationLedgerPairSha256: proof.migrationLedgerPairSha256,
    backupManifestSha256: proof.backupManifestSha256,
    restoreProofSha256: proof.restoreProofSha256,
    restoreSeparation: proof.restoreSeparation,
    databaseIdentity: proof.source.databaseIdentity,
    sourceAuthoritativeHead: proof.source.authoritativeHead,
    sourceHeads: proof.source.heads,
    sourceKeycloakIdentityHead: proof.source.keycloakIdentityHead,
  };
}

async function containedRealPath(root, relativePath, label) {
  const portable = portablePath(relativePath, label);
  const requestedRoot = resolve(root);
  const rootMetadata = await lstat(requestedRoot);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), `${label}: Wurzel ist kein reguläres Verzeichnis.`);
  const absoluteRoot = await realpath(requestedRoot);
  let path = absoluteRoot;
  const parts = portable.split("/");
  for (const [index, part] of parts.entries()) {
    path = resolve(path, part);
    const metadata = await lstat(path);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen nicht auflösbaren Zwischenpfad.`);
  }
  const actual = await realpath(path);
  const remainder = relative(absoluteRoot, actual);
  invariant(remainder !== "" && !remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder), `${label} verlässt die Wurzel.`);
  return actual;
}

async function absoluteFileProof(path, label) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} ist keine reguläre, nichtleere Datei.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${label} änderte sich während der Hashbildung.`);
  return { bytes, sha256: hash.digest("hex") };
}

async function fileProof(root, descriptor, label) {
  const path = await containedRealPath(root, descriptor.file, `${label}.file`);
  const proof = await absoluteFileProof(path, label);
  if (descriptor.expectedBytes !== undefined || descriptor.expectedSha256 !== undefined) {
    invariant(Number.isSafeInteger(descriptor.expectedBytes) && descriptor.expectedBytes > 0, `${label} besitzt keine erwartete Bytezahl.`);
    invariant(SHA256.test(descriptor.expectedSha256), `${label} besitzt keinen erwarteten SHA-256.`);
    invariant(proof.bytes === descriptor.expectedBytes && proof.sha256 === descriptor.expectedSha256, `${label} weicht vom gepinnten Byte-SHA-Beleg ab.`);
  }
  return proof;
}

function expectedReusedSpecificationOutputs(value, label) {
  const outputDirectory = portablePath(value?.outputDirectory, `${label}.outputDirectory`);
  let names;
  if (value.schema === "zugfolge-official-operating-points/v1") {
    names = ["official-operating-points-report.json", "operating-points.geojsonseq"];
  } else if (value.schema === "zugfolge-semantic-tile-assembly/v1") {
    names = [
      "blocks.geojsonseq",
      "conflict-resources.geojsonseq",
      "inputs.json",
      "operating-points.geojsonseq",
      "platforms.geojsonseq",
      "rail-context.geojsonseq",
      "rail-corridors.geojsonseq",
      "signals.geojsonseq",
      "stations.geojsonseq",
      "switches.geojsonseq",
      "tracks.geojsonseq",
    ];
  } else if (
    value.schema === undefined
      && typeof value.tracks === "string"
      && Array.isArray(value.platforms)
      && value.dependentLayers !== null
      && typeof value.dependentLayers === "object"
  ) {
    names = [
      "blocks.geojsonseq",
      "conflict-resources.geojsonseq",
      "normalization-report.json",
      "platforms.geojsonseq",
      "signals.geojsonseq",
      "switches.geojsonseq",
      "tracks.geojsonseq",
    ];
  } else {
    throw new Error(`${label} verwendet kein freigegebenes Cross-Release-Spezifikationsschema.`);
  }
  return names.map((name) => `${outputDirectory}/${name}`).sort();
}

function targetFileForReusedSpecification(sourceFile, sourceReleaseId, targetReleaseId, label) {
  const source = RELEASE_ID.exec(sourceReleaseId);
  const target = RELEASE_ID.exec(targetReleaseId);
  invariant(source !== null && target !== null, `${label} besitzt keine gueltigen Quell- und Zielrelease-IDs.`);
  const sourceCorpus = `germany-${source.groups.year}.${source.groups.patch}`;
  const targetCorpus = `germany-${target.groups.year}.${target.groups.patch}`;
  invariant(sourceFile.includes(sourceCorpus), `${label} ist nicht an den deklarierten Quellrelease-Pfad gebunden.`);
  const targetFile = sourceFile.replace(sourceCorpus, targetCorpus);
  invariant(targetFile !== sourceFile && !targetFile.includes(sourceCorpus), `${label} kann nicht eindeutig auf den Zielrelease-Pfad abgebildet werden.`);
  return targetFile;
}

async function validateSpecificationContentReleaseBinding(root, descriptor, label) {
  const path = await containedRealPath(root, descriptor.file, `${label}.file`);
  let raw;
  let value;
  try {
    raw = await readFile(path, "utf8");
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} ist keine gueltige JSON-Spezifikation.`);
  }
  const declared = RELEASE_ID.exec(descriptor.version);
  invariant(declared !== null, `${label} besitzt keine releasegebundene Descriptor-Version.`);
  const expected = `${declared.groups.year}.${declared.groups.patch}`;
  const observed = [
    ...[...raw.matchAll(SPECIFICATION_RELEASE_TOKEN)].map(({ groups }) => `${groups.year}.${groups.patch}`),
    ...[...descriptor.file.matchAll(SPECIFICATION_ANNUAL_PATH_TOKEN)].map(({ groups }) => `${groups.year}.${groups.patch}`),
  ];
  invariant(observed.length > 0, `${label} besitzt weder im Inhalt noch im Pfad eine pruefbare Jahres-Patchbindung.`);
  invariant(
    observed.every((version) => version === expected),
    `${label} deklariert ${descriptor.version}, enthaelt aber eine fremde Release- oder Pfadbindung.`,
  );
  if (descriptor.reuse === undefined) return;
  const expectedSourceFiles = expectedReusedSpecificationOutputs(value, label);
  const artifacts = descriptor.reuse.artifacts;
  invariant(
    JSON.stringify(artifacts.map(({ sourceFile }) => sourceFile)) === JSON.stringify(expectedSourceFiles),
    `${label}.reuse inventarisiert nicht exakt alle durch die Spezifikation erzeugten Quelldateien.`,
  );
  for (const [index, artifact] of artifacts.entries()) {
    const artifactLabel = `${label}.reuse.artifacts[${index}]`;
    invariant(
      artifact.targetFile === targetFileForReusedSpecification(
        artifact.sourceFile,
        descriptor.reuse.sourceReleaseId,
        descriptor.reuse.targetReleaseId,
        artifactLabel,
      ),
      `${artifactLabel} besitzt keinen kanonischen Zielrelease-Pfad.`,
    );
    const expectedProof = { expectedBytes: artifact.bytes, expectedSha256: artifact.sha256 };
    const sourceProof = await fileProof(root, { file: artifact.sourceFile, ...expectedProof }, `${artifactLabel}.source`);
    const targetProof = await fileProof(root, { file: artifact.targetFile, ...expectedProof }, `${artifactLabel}.target`);
    invariant(
      sourceProof.bytes === targetProof.bytes && sourceProof.sha256 === targetProof.sha256,
      `${artifactLabel} bindet keine byteidentischen Quell- und Zielartefakte.`,
    );
  }
}

function validateCommit(value, label) {
  invariant(GIT_COMMIT.test(value) && !/^0+$/.test(value), `${label} muss ein vollständiger Git-Commit sein.`);
  return value;
}

function validateOciTool(tool) {
  invariant(typeof tool.reference === "string" && !tool.reference.includes("://") && !/\s/.test(tool.reference), `Tool ${tool.id} besitzt keine OCI-Referenz.`);
  invariant(!MUTABLE_TOKEN.test(tool.reference), `Tool ${tool.id} verwendet latest oder eine unversionierte Referenz.`);
  const match = /@(?<digest>sha256:[a-f0-9]{64})$/.exec(tool.reference);
  invariant(match !== null && tool.reference.slice(0, match.index).includes("/"), `Tool ${tool.id} muss über einen vollständigen OCI-Digest gebunden sein.`);
  invariant(tool.digest === match.groups.digest, `Tool ${tool.id} nennt einen abweichenden OCI-Digest.`);
}

function validateCacheInventory(value, releaseId) {
  invariant(value?.schema === CACHE_INVENTORY_SCHEMA, "Buildcache-Inventar hat ein unbekanntes Schema.");
  invariant(value.releaseId === releaseId, "Buildcache-Inventar gehört zu einem anderen Release.");
  invariant(Array.isArray(value.files) && value.files.length > 0, "Buildcache-Inventar ist leer.");
  const files = value.files.map((entry, index) => {
    const path = portablePath(entry?.path, `buildCache.files[${index}].path`);
    invariant(path !== RESTORE_MARKER && !path.startsWith(".zugfolge-"), `Buildcache-Pfad ${path} ist reserviert.`);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `Buildcache-Datei ${path} besitzt keinen Byte-SHA-Beleg.`);
    return { path, bytes: entry.bytes, sha256: entry.sha256 };
  });
  invariant(new Set(files.map(({ path }) => path)).size === files.length, "Buildcache-Inventar enthält doppelte Pfade.");
  invariant(JSON.stringify(files.map(({ path }) => path)) === JSON.stringify(files.map(({ path }) => path).sort()), "Buildcache-Inventar muss nach Pfad sortiert sein.");
  return files;
}

function inventoryEntry(inventory, cacheFile, label) {
  const entry = inventory.find(({ path }) => path === cacheFile);
  invariant(entry !== undefined, `${label} fehlt im wiederherstellbaren Buildcache-Inventar.`);
  return entry;
}

export async function validateCurrentAnnualBuildCachePlanBinding(root, inputs, inventory, releaseId) {
  if (releaseId !== CURRENT_ANNUAL_V3_RELEASE_ID) return undefined;
  const planInput = inputs.find(({ id }) => id === "map-build-cache-inventory-plan");
  invariant(planInput?.kind === "specification", "Aktuelles Build-Evidence besitzt keinen typisierten Buildcache-Inventarplan.");
  let plan;
  try {
    plan = JSON.parse(await readFile(
      await containedRealPath(root, planInput.file, "Buildcache-Inventarplan"),
      "utf8",
    ));
  } catch (error) {
    throw new Error("Buildcache-Inventarplan ist kein gueltiges JSON-Artefakt.", { cause: error });
  }
  const mappings = validateMapBuildCacheInventoryPlan(plan, releaseId);
  invariant(
    JSON.stringify(mappings.map(({ cacheFile }) => cacheFile)) === JSON.stringify(inventory.map(({ path }) => path)),
    "Buildcache-Inventar bildet den versionierten Inventarplan nicht vollstaendig und exakt ab.",
  );
  return mappings;
}

export function validateCurrentAnnualValidatorRebuildCacheArtifacts({
  mappings,
  inventory,
  rebuildSpec,
  rebuildReceipt,
  rebuildReceiptInput,
}) {
  const expected = [
    ["Validator-Rebuild-Source-TAR", rebuildSpec.source.archive.file, rebuildSpec.source.archive],
    ["Validator-Rebuild-Provenienz", rebuildReceipt.provenance.file, rebuildReceipt.provenance],
    ["Validator-Rebuild-Receipt", rebuildReceiptInput.file, rebuildReceiptInput],
    ["Validator-Rebuild-Binary", rebuildReceipt.binaries.rebuilt.file, rebuildReceipt.binaries.rebuilt],
  ];
  for (const [label, sourceFile, proof] of expected) {
    const matches = mappings.filter((mapping) => mapping.sourceFile === sourceFile);
    invariant(matches.length === 1, `${label} fehlt oder ist nicht exakt einmal im versionierten Buildcache-Inventarplan gebunden.`);
    const cached = inventoryEntry(inventory, matches[0].cacheFile, label);
    invariant(
      cached.bytes === proof.bytes && cached.sha256 === proof.sha256,
      `${label} driftet zwischen Rebuild-Beleg, Buildcache-Plan und Buildcache-Inventar.`,
    );
  }
}

function deliverySchemaForVersion(version) {
  return operationalEvidenceVersion(version) ? DELIVERY_SCHEMA_V2 : DELIVERY_SCHEMA_V1;
}

function validateSignedDeliveryContract(value, releaseId, label = "Delivery-Manifest", version) {
  const acceptedSchemas = version === undefined
    ? [DELIVERY_SCHEMA_V1, DELIVERY_SCHEMA_V2]
    : [deliverySchemaForVersion(version)];
  invariant(acceptedSchemas.includes(value?.schema) && value.releaseId === releaseId, `${label} gehört nicht zum Buildrelease.`);
  invariant(value.approvalGates?.rights?.status === "passed" && value.approvalGates?.quality?.status === "passed", `${label} besitzt keine Rechte- und Qualitätsfreigabe.`);
  const gate = value.approvalGates?.signature;
  const signature = value.signature;
  invariant(gate?.status === "passed" && gate.algorithm === "Ed25519", `${label} besitzt keine signierte Delivery-Freigabe.`);
  const keyId = stableId(gate.keyId, `${label}.approvalGates.signature.keyId`);
  invariant(signature?.algorithm === "Ed25519" && signature.keyId === keyId, `${label} besitzt keine konsistente Ed25519-Signaturhülle.`);
  invariant(typeof signature.valueBase64 === "string", `${label} besitzt keine Ed25519-Signaturbytes.`);
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  invariant(signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.valueBase64, `${label} besitzt keine kanonischen Ed25519-Signaturbytes.`);
  invariant(SHA256.test(value.releaseHash) && value.releaseHash === deliveryReleaseHash(value), `${label} besitzt keinen gültigen kanonischen Releasehash.`);
  if (value.schema === DELIVERY_SCHEMA_V2) {
    const currentOperationalProvenance = validateGermanyOperationalDeliveryV2Pair(
      value.packageVersion,
      releaseId,
      label,
    ) === "integrated-provenance-v2";
    const expectedBindingKeys = [
      "packageManifestSchema", "infraReleaseSchema", "mapReleaseSchema", "infraReleaseHash", "mapReleaseHash",
      "sourcesSha256", "qualitySha256",
      ...(currentOperationalProvenance ? ["operationalAuthoritySha256", "operationalProvenanceSha256"] : []),
    ];
    const operationalAuthority = currentOperationalProvenance
      ? validateOperationalBuildAuthority(value.operationalAuthority)
      : undefined;
    invariant(
      value.bindings !== null && typeof value.bindings === "object" && !Array.isArray(value.bindings)
        && Object.keys(value.bindings).sort().join("\u0000") === expectedBindingKeys.sort().join("\u0000")
        && value.bindings.packageManifestSchema === "zugfolge-map-package/v2"
        && value.bindings.infraReleaseSchema === "zugfolge-infra-release/v2"
        && value.bindings.mapReleaseSchema === "zugfolge-map-release/v1"
        && SHA256.test(value.bindings.infraReleaseHash) && SHA256.test(value.bindings.mapReleaseHash)
        && SHA256.test(value.bindings.sourcesSha256) && SHA256.test(value.bindings.qualitySha256)
        && (!currentOperationalProvenance || (
          SHA256.test(value.bindings.operationalAuthoritySha256)
          && value.bindings.operationalAuthoritySha256 === operationalBuildAuthoritySha256(operationalAuthority)
          &&
          SHA256.test(value.bindings.operationalProvenanceSha256)
          && value.bindings.operationalProvenanceSha256 === germanyOperationalProvenanceSha256(value.operationalProvenance)
        )),
      `${label} bindet InfraRelease und Kartenrelease nicht über ihre kanonischen releaseHash-Werte.`,
    );
    if (!currentOperationalProvenance) {
      invariant(
        !Object.hasOwn(value, "operationalProvenance")
          && !Object.hasOwn(value.bindings, "operationalProvenanceSha256")
          && !Object.hasOwn(value, "operationalAuthority")
          && !Object.hasOwn(value.bindings, "operationalAuthoritySha256"),
        `${label} darf als Legacy-Delivery-v2 keine aktuelle Operational-v2-Ausfuehrungsprovenienz oder Build-Authority tragen.`,
      );
    }
  }
  return { keyId, releaseHash: value.releaseHash };
}

function validateCandidatePackageSpec(candidatePackage, inputs) {
  exactObjectKeys(
    candidatePackage,
    ["basePlanInputId", "signedPlanFile", "trustedKeysFile", "retainedTrustedKeyIds"],
    "candidatePackage",
  );
  const basePlanInputId = stableId(candidatePackage.basePlanInputId, "candidatePackage.basePlanInputId");
  const basePlanInput = inputs.find(({ id }) => id === basePlanInputId);
  invariant(
    basePlanInput?.kind === "specification" && basePlanInput.file.startsWith("tools/tiles/"),
    "candidatePackage.basePlanInputId muss auf den versionierten unsigned Ableitungsplan verweisen.",
  );
  const signedPlanFile = portablePath(candidatePackage.signedPlanFile, "candidatePackage.signedPlanFile");
  invariant(
    signedPlanFile.endsWith("/map-release-free-v2/signed-package-plan.json"),
    "candidatePackage.signedPlanFile muss den reproduzierbar erzeugten Signed-Paketplan binden.",
  );
  const trustedKeysFile = portablePath(candidatePackage.trustedKeysFile, "candidatePackage.trustedKeysFile");
  invariant(trustedKeysFile === "ops/keys/trusted-delivery-keys.json", "candidatePackage.trustedKeysFile muss den additiven Delivery-Keyring binden.");
  invariant(
    Array.isArray(candidatePackage.retainedTrustedKeyIds) && candidatePackage.retainedTrustedKeyIds.length > 0,
    "candidatePackage.retainedTrustedKeyIds muss mindestens einen bisherigen Vertrauensanker erhalten.",
  );
  const retainedTrustedKeyIds = candidatePackage.retainedTrustedKeyIds.map((keyId, index) =>
    stableId(keyId, `candidatePackage.retainedTrustedKeyIds[${index}]`));
  invariant(new Set(retainedTrustedKeyIds).size === retainedTrustedKeyIds.length, "candidatePackage.retainedTrustedKeyIds enthält Duplikate.");
  invariant(
    JSON.stringify(retainedTrustedKeyIds) === JSON.stringify([...retainedTrustedKeyIds].sort()),
    "candidatePackage.retainedTrustedKeyIds muss kanonisch sortiert sein.",
  );
  return { basePlanInputId, signedPlanFile, trustedKeysFile, retainedTrustedKeyIds };
}

function packageReleaseDescriptor(plan, label, expectedSchema = MAP_PACKAGE_PLAN_V2) {
  invariant(plan?.schema === expectedSchema, `${label} muss ${expectedSchema} sein.`);
  invariant(plan?.runtime?.schema === MAP_RUNTIME_V2, `${label} muss zugfolge-map-runtime/v2 unverändert binden.`);
  invariant(Array.isArray(plan.auxiliaryFiles), `${label} besitzt keine direkten Hilfsdateien.`);
  const releases = plan.auxiliaryFiles.filter(({ kind }) => kind === "release-manifest");
  invariant(releases.length === 1, `${label} muss genau einen Release-Manifest-Descriptor besitzen.`);
  const [descriptor] = releases;
  invariant(
    descriptor.id === "release-manifest"
      && descriptor.visibility === "public"
      && descriptor.installPath === "manifests/release.json",
    `${label} besitzt nicht die feste öffentliche Delivery-Rolle.`,
  );
  return descriptor;
}

function canonicalEd25519SpkiPublicKeyPem(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} ist kein öffentlicher PEM-Schlüssel.`);
  invariant(!/PRIVATE KEY/u.test(value), `${label} darf kein privates Schlüsselmaterial enthalten.`);
  invariant(
    /^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PUBLIC KEY-----\n$/u.test(value),
    `${label} ist nicht exakt als kanonischer Ed25519-SPKI-Public-Key-PEM ohne Restbytes serialisiert.`,
  );
  let publicKey;
  try {
    publicKey = createPublicKey(value);
  } catch {
    throw new Error(`${label} ist kein gültiger Ed25519-SPKI-Public-Key-PEM.`);
  }
  invariant(publicKey.type === "public" && publicKey.asymmetricKeyType === "ed25519", `${label} ist kein Ed25519-SPKI-Public-Key-PEM.`);
  const canonical = publicKey.export({ type: "spki", format: "pem" });
  invariant(typeof canonical === "string" && value === canonical, `${label} ist nicht exakt als kanonischer Ed25519-SPKI-Public-Key-PEM ohne Restbytes serialisiert.`);
  return value;
}

function validateTrustedDeliveryKeyMap(value) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Delivery-Keyring ist kein Objekt.");
  const trustedKeyIds = Object.keys(value).sort();
  invariant(trustedKeyIds.length > 0, "Delivery-Keyring ist leer.");
  for (const keyId of trustedKeyIds) {
    stableId(keyId, `Delivery-Keyring.${keyId}`);
    canonicalEd25519SpkiPublicKeyPem(value[keyId], `Delivery-Keyring.${keyId}`);
  }
  return trustedKeyIds;
}

function trustedDeliveryKeyring(value, retainedTrustedKeyIds, candidateKeyId) {
  const trustedKeyIds = validateTrustedDeliveryKeyMap(value);
  invariant(!retainedTrustedKeyIds.includes(candidateKeyId), "Der Kandidatenschlüssel darf keinen als beibehalten deklarierten Altanker ersetzen.");
  for (const keyId of retainedTrustedKeyIds) {
    invariant(trustedKeyIds.includes(keyId), `Additiver Delivery-Keyring hat den bisherigen Vertrauensanker ${keyId} entfernt.`);
  }
  invariant(trustedKeyIds.includes(candidateKeyId), `Delivery-Keyring kennt den Kandidatenschlüssel ${candidateKeyId} nicht.`);
  return trustedKeyIds;
}

function validateResolvedCandidatePackage(candidatePackage, releaseId, outputs) {
  exactObjectKeys(candidatePackage, [
    "basePlanInputId",
    "planFile",
    "bytes",
    "sha256",
    "packageId",
    "packageVersion",
    "releaseManifestFile",
    "releaseManifestBytes",
    "releaseManifestSha256",
    "releaseHash",
    "signatureKeyId",
    "trustedKeysFile",
    "trustedKeysBytes",
    "trustedKeysSha256",
    "trustedKeyIds",
    "retainedTrustedKeyIds",
  ], "candidatePackage");
  stableId(candidatePackage.basePlanInputId, "candidatePackage.basePlanInputId");
  portablePath(candidatePackage.planFile, "candidatePackage.planFile");
  portablePath(candidatePackage.releaseManifestFile, "candidatePackage.releaseManifestFile");
  portablePath(candidatePackage.trustedKeysFile, "candidatePackage.trustedKeysFile");
  stableId(candidatePackage.packageId, "candidatePackage.packageId");
  stableId(candidatePackage.signatureKeyId, "candidatePackage.signatureKeyId");
  invariant(candidatePackage.packageVersion === releaseVersion(releaseId), "Signed-Paketplan besitzt nicht die exakte Jahres-Patchversion.");
  for (const [label, bytes, digest] of [
    ["Signed-Paketplan", candidatePackage.bytes, candidatePackage.sha256],
    ["signiertes Delivery-Manifest", candidatePackage.releaseManifestBytes, candidatePackage.releaseManifestSha256],
    ["Delivery-Keyring", candidatePackage.trustedKeysBytes, candidatePackage.trustedKeysSha256],
  ]) {
    invariant(Number.isSafeInteger(bytes) && bytes > 0 && SHA256.test(digest), `${label} besitzt keinen Byte-SHA-Beleg.`);
  }
  invariant(SHA256.test(candidatePackage.releaseHash), "Signiertes Delivery-Manifest besitzt keinen Releasehash im Kandidatenbeleg.");
  for (const [label, ids] of [["trustedKeyIds", candidatePackage.trustedKeyIds], ["retainedTrustedKeyIds", candidatePackage.retainedTrustedKeyIds]]) {
    invariant(Array.isArray(ids) && ids.length > 0, `candidatePackage.${label} ist leer.`);
    ids.forEach((id, index) => stableId(id, `candidatePackage.${label}[${index}]`));
    invariant(new Set(ids).size === ids.length && JSON.stringify(ids) === JSON.stringify([...ids].sort()), `candidatePackage.${label} ist nicht eindeutig kanonisch sortiert.`);
  }
  invariant(!candidatePackage.retainedTrustedKeyIds.includes(candidatePackage.signatureKeyId), "Kandidatenschlüssel ersetzt einen beizubehaltenden Altanker.");
  invariant(candidatePackage.trustedKeyIds.includes(candidatePackage.signatureKeyId), "Kandidatenschlüssel fehlt im gebundenen Delivery-Keyring.");
  for (const keyId of candidatePackage.retainedTrustedKeyIds) {
    invariant(candidatePackage.trustedKeyIds.includes(keyId), `Beibehaltener Delivery-Vertrauensanker ${keyId} fehlt.`);
  }
  const delivery = outputs.find(({ kind }) => kind === "delivery-manifest");
  invariant(
    delivery?.file === candidatePackage.releaseManifestFile
      && delivery.bytes === candidatePackage.releaseManifestBytes
      && delivery.sha256 === candidatePackage.releaseManifestSha256,
    "Signed-Paketplan und Evidence-Ausgabe binden nicht dieselben Delivery-Bytes.",
  );
  return candidatePackage;
}

async function inspectCandidatePackage(root, candidateSpec, inputs, outputs, releaseId) {
  const normalized = validateCandidatePackageSpec(candidateSpec, inputs);
  const basePlanInput = inputs.find(({ id }) => id === normalized.basePlanInputId);
  const [basePlanBytes, signedPlanBytes, trustedKeysBytes] = await Promise.all([
    readFile(await containedRealPath(root, basePlanInput.file, "Unsigned Paket-Ableitungsplan")),
    readFile(await containedRealPath(root, normalized.signedPlanFile, "Signed-Paketplan")),
    readFile(await containedRealPath(root, normalized.trustedKeysFile, "Additiver Delivery-Keyring")),
  ]);
  let basePlan;
  let signedPlan;
  let trustedKeys;
  try {
    basePlan = JSON.parse(basePlanBytes.toString("utf8"));
    signedPlan = JSON.parse(signedPlanBytes.toString("utf8"));
    trustedKeys = JSON.parse(trustedKeysBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Signed-Paketkandidat besitzt ungültiges JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant(serializeSignedMapPackagePlan(basePlan).equals(basePlanBytes), "Unsigned Paket-Ableitungsplan ist nicht kanonisch serialisiert.");
  invariant(serializeSignedMapPackagePlan(signedPlan).equals(signedPlanBytes), "Signed-Paketplan ist nicht kanonisch serialisiert.");
  const baseDescriptor = packageReleaseDescriptor(basePlan, "Unsigned Paket-Ableitungsplan");
  const expandedBasePlan = await expandMapPackagePlan(basePlan, root);
  validateMapPackageSpec(signedPlan);
  const expandedBaseDescriptor = packageReleaseDescriptor(expandedBasePlan, "Expandierter unsigned Paketvertrag", MAP_PACKAGE_SPEC_V2);
  const signedDescriptor = packageReleaseDescriptor(signedPlan, "Signed-Paketplan", MAP_PACKAGE_SPEC_V2);
  const expectedSignedSource = deriveSignedReleaseSourceFile(baseDescriptor.sourceFile);
  invariant(signedDescriptor.sourceFile === expectedSignedSource, "Signed-Paketplan bindet nicht public/release.json aus dem unsigned Ableitungsplan.");
  invariant(signedPlan.packageId === basePlan.packageId && signedPlan.version === basePlan.version, "Signed-Paketplan verändert Paketidentität oder Version.");
  invariant(signedPlan.version === releaseVersion(releaseId), "Signed-Paketplan besitzt nicht die exakte Jahres-Patchversion.");

  invariant(
    [...signedPlan.artifacts, ...signedPlan.auxiliaryFiles].every(({ expectedBytes, expectedSha256 }) => (
      Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && SHA256.test(expectedSha256)
    )),
    "Signed-Paketplan muss jede expandierte Paketdatei bytegenau pinnen.",
  );
  for (const descriptor of [...signedPlan.artifacts, ...signedPlan.auxiliaryFiles]) {
    const path = await containedRealPath(root, descriptor.sourceFile, `Signed-Paketplan.${descriptor.id}.sourceFile`);
    const proof = await absoluteFileProof(path, `Signed-Paketplan.${descriptor.id}`);
    invariant(
      proof.bytes === descriptor.expectedBytes && proof.sha256 === descriptor.expectedSha256,
      `Signed-Paketplan.${descriptor.id} weicht von seiner aktuellen Byte-SHA-Bindung ab.`,
    );
  }
  const withoutPins = (specification) => {
    const result = structuredClone(specification);
    for (const descriptor of [...result.artifacts, ...result.auxiliaryFiles]) {
      delete descriptor.expectedBytes;
      delete descriptor.expectedSha256;
    }
    return result;
  };
  const signedSemantics = withoutPins(signedPlan);
  signedSemantics.auxiliaryFiles.find(({ kind }) => kind === "release-manifest").sourceFile = expandedBaseDescriptor.sourceFile;
  invariant(
    JSON.stringify(sortedValue(signedSemantics)) === JSON.stringify(sortedValue(withoutPins(expandedBasePlan))),
    "Signed-Paketplan verändert nach deterministischer Expansion mehr als Vollpinnung, Releasequelle und deren Byte-SHA-Bindung.",
  );

  const deliveryOutput = outputs.find(({ kind }) => kind === "delivery-manifest");
  invariant(deliveryOutput?.file === signedDescriptor.sourceFile, "Signed-Paketplan bindet nicht die Delivery-Ausgabe der Jahres-Evidence.");
  invariant(
    signedDescriptor.expectedBytes === deliveryOutput.bytes && signedDescriptor.expectedSha256 === deliveryOutput.sha256,
    "Signed-Paketplan bindet nicht die realen signierten Delivery-Bytes.",
  );
  const deliveryPath = await containedRealPath(root, signedDescriptor.sourceFile, "Signiertes Delivery-Manifest");
  const deliveryBytes = await readFile(deliveryPath);
  let delivery;
  try {
    delivery = JSON.parse(deliveryBytes.toString("utf8"));
  } catch {
    throw new Error("Signiertes Delivery-Manifest ist kein gültiges JSON-Artefakt.");
  }
  invariant(serializeDeliveryJson(delivery).equals(deliveryBytes), "Signiertes Delivery-Manifest ist nicht kanonisch serialisiert.");
  const { keyId, releaseHash } = validateSignedDeliveryContract(delivery, releaseId, "Signed-Paketplan-Delivery", 2);
  invariant(delivery.packageId === signedPlan.packageId && delivery.packageVersion === signedPlan.version, "Signed-Paketplan und Delivery besitzen verschiedene Paketidentitäten.");
  const trustedKeyIds = trustedDeliveryKeyring(trustedKeys, normalized.retainedTrustedKeyIds, keyId);
  invariant(
    verifyMapDeliveryReleaseSignature(delivery, trustedKeys[keyId]),
    "Signed-Paketplan-Delivery besteht die Ed25519-Prüfung gegen den gebundenen Keyring nicht.",
  );
  const result = {
    basePlanInputId: normalized.basePlanInputId,
    planFile: normalized.signedPlanFile,
    bytes: signedPlanBytes.length,
    sha256: sha256Bytes(signedPlanBytes),
    packageId: signedPlan.packageId,
    packageVersion: signedPlan.version,
    releaseManifestFile: signedDescriptor.sourceFile,
    releaseManifestBytes: deliveryBytes.length,
    releaseManifestSha256: sha256Bytes(deliveryBytes),
    releaseHash,
    signatureKeyId: keyId,
    trustedKeysFile: normalized.trustedKeysFile,
    trustedKeysBytes: trustedKeysBytes.length,
    trustedKeysSha256: sha256Bytes(trustedKeysBytes),
    trustedKeyIds,
    retainedTrustedKeyIds: normalized.retainedTrustedKeyIds,
  };
  return validateResolvedCandidatePackage(result, releaseId, outputs);
}

function validateOperationalV2Quality(value, id, releaseId) {
  const timetableYear = Number.parseInt(RELEASE_ID.exec(releaseId)?.groups?.year ?? "", 10);
  invariant(Number.isSafeInteger(timetableYear), `${id} besitzt keine ableitbare Fahrplanjahresbindung.`);
  try {
    validateMapDeliveryQualityReport({ qualityReport: value, releaseId, timetableYear, operationalV2: true });
  } catch (error) {
    throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateOutputShape(kind, path, releaseId, id, version, expectedProof, validateOperationalInfrastructure) {
  if (["basemap-pmtiles", "semantic-pmtiles"].includes(kind)) {
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(7);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      invariant(bytesRead === header.length && header.toString("ascii") === "PMTiles", `${id} ist kein PMTiles-Artefakt.`);
    } finally {
      await handle.close();
    }
    return {};
  }
  if (kind === "read-model") {
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      invariant(bytesRead === header.length && header.toString("binary") === "SQLite format 3\0", `${id} ist kein SQLite-Artefakt.`);
    } finally {
      await handle.close();
    }
    const inspected = await inspectPublicReadModel(path);
    invariant(inspected.infrastructureReleaseId === releaseId, `${id} ist nicht an den Buildrelease gebunden.`);
    return {};
  }
  if (kind === "train-map-projection") {
    const handle = await open(path, "r");
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      invariant(bytesRead === header.length && header.toString("binary") === "SQLite format 3\0", `${id} ist kein SQLite-Artefakt.`);
    } finally {
      await handle.close();
    }
    const inspected = await inspectTrainMapProjection(path);
    invariant(inspected.infrastructureReleaseId === releaseId, `${id} ist nicht an den Buildrelease gebunden.`);
    const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, defensive: true, timeout: 0 });
    try {
      const metadataRows = database.prepare("SELECT key, value FROM metadata ORDER BY key").all();
      const requiredKeys = [
        "corridors_sha256",
        "deployment_sha256",
        "infrastructure_release_id",
        "operational_network_sha256",
        "schema",
        "timetable_year",
        "tracks_sha256",
        "world_id",
      ];
      invariant(JSON.stringify(metadataRows.map(({ key }) => key)) === JSON.stringify(requiredKeys), `${id} besitzt keinen vollständigen Projektions-Metadatenvertrag.`);
      const metadata = Object.fromEntries(metadataRows.map(({ key, value }) => [key, value]));
      invariant(metadata.world_id === inspected.worldId && metadata.infrastructure_release_id === releaseId, `${id} verletzt seine Welt- oder Releasebindung.`);
      invariant(metadata.timetable_year === RELEASE_ID.exec(releaseId)?.groups.year, `${id} bindet ein falsches Fahrplanjahr.`);
      for (const key of ["corridors_sha256", "deployment_sha256", "operational_network_sha256", "tracks_sha256"]) {
        invariant(SHA256.test(metadata[key]), `${id} besitzt keinen gültigen ${key}-Beleg.`);
      }
      for (const table of Object.keys(inspected.tables).filter((table) => table !== "metadata")) {
        const foreign = database.prepare(`SELECT 1 AS found FROM ${table} WHERE world_id <> ? OR infrastructure_release_id <> ? LIMIT 1`)
          .get(inspected.worldId, releaseId);
        invariant(foreign === undefined, `${id} enthält Zeilen außerhalb seiner Welt- oder Releasebindung.`);
      }
    } finally {
      database.close();
    }
    return {};
  }
  if (kind === "operational-infrastructure-v2") {
    const nativeReceipt = validateOperationalInfrastructureV2NativeReceipt(
      await validateOperationalInfrastructure(path, releaseId),
      releaseId,
    );
    const after = await absoluteFileProof(path, `Ausgabe ${id}`);
    invariant(
      expectedProof.bytes === after.bytes && expectedProof.sha256 === after.sha256,
      `${id} änderte sich während der nativen Operational-v2-Validierung.`,
    );
    invariant(
      nativeReceipt.sourceBytes === after.bytes && nativeReceipt.sourceSha256 === after.sha256,
      `${id} besitzt kein an seine Quellbytes gebundenes natives Operational-v2-Receipt.`,
    );
    invariant(
      nativeReceipt.bytes === after.bytes && nativeReceipt.sha256 === after.sha256,
      `${id} entspricht nicht den nativen kanonischen Operational-v2-Ausgabe-Bytes.`,
    );
    if (after.bytes <= MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES) {
      const bytes = await readFile(path);
      invariant(
        bytes.length === after.bytes && sha256Bytes(bytes) === after.sha256,
        `${id} änderte sich vor dem JavaScript-Gegenvergleich.`,
      );
      let value;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error(`${id} ist kein gültiges JSON-Artefakt.`);
      }
      assertOperationalInfrastructureV2(value);
      invariant(value.id === releaseId, `${id} ist nicht an den Buildrelease gebunden.`);
      invariant(
        operationalInfrastructureV2StateHash(value) === nativeReceipt.stateHash,
        `${id}: JavaScript- und native Rust-Kanonisierung laufen auseinander.`,
      );
    }
    return { infraReleaseId: nativeReceipt.infraReleaseId, stateHash: nativeReceipt.stateHash };
  }
  const metadata = await lstat(path);
  invariant(metadata.size <= MAX_IN_MEMORY_OPERATIONAL_JSON_BYTES, `${id} ist als JSON-Artefakt unerwartet groß.`);
  const bytes = await readFile(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${id} ist kein gültiges JSON-Artefakt.`);
  }
  if (kind === "style") invariant(value?.version === 8, `${id} ist kein MapLibre-v8-Style.`);
  if (kind === "delivery-manifest") {
    validateSignedDeliveryContract(value, releaseId, id, version);
  }
  if (kind === "timetable-transfer-demands-v2") {
    invariant(SHA256.test(value?.gtfsSnapshotHash), `${id} besitzt keinen gebundenen GTFS-Snapshot-Hash.`);
    const passengerSegmentIds = new Set();
    if (Array.isArray(value?.transferRoutes)) {
      for (const route of value.transferRoutes) {
        if (typeof route?.sourcePassengerLegId === "string") passengerSegmentIds.add(route.sourcePassengerLegId);
        if (typeof route?.targetPassengerLegId === "string") passengerSegmentIds.add(route.targetPassengerLegId);
      }
    }
    const validated = validateSyntheticOperationalTimetableTransferDemands({
      releaseId,
      transferDemands: value,
      transferDemandsBinding: {
        file: "timetable-routes-v2.transfer-demands-v2.json",
        bytes: expectedProof.bytes,
        sha256: expectedProof.sha256,
        role: "timetable-transfer-demands",
        records: Array.isArray(value?.transferRoutes) ? value.transferRoutes.length : 0,
      },
      routeReport: { gtfsBinding: { snapshotHash: value.gtfsSnapshotHash } },
      timetableRoutesProof: { segmentIds: [...passengerSegmentIds].sort() },
    });
    invariant(
      value?.schema === "zugfolge-timetable-transfer-demands/v2"
        && value.infraReleaseId === releaseId
        && validated.dailyCirculationPlanSha256 === value.dailyPlan.planSha256
        && validated.transferSetSha256 === value.transferSetSha256,
      `${id} ist kein release- und hashgebundener Timetable-Transfer-Demands-v2-Beleg.`,
    );
    return {
      infraReleaseId: value.infraReleaseId,
      dailyPlanSha256: value.dailyPlan.planSha256,
      transferSetSha256: value.transferSetSha256,
    };
  }
  if (kind === "movement-route-templates-v2") {
    invariant(
      value?.schema === "movement-route-templates-v2"
        && value.infraReleaseId === releaseId
        && SHA256.test(value.operationalStateHash)
        && SHA256.test(value.timetableTransferSetSha256)
        && SHA256.test(value.stateHash),
      `${id} ist kein release- und hashgebundener Movement-Route-Templates-v2-Beleg.`,
    );
    return {
      infraReleaseId: value.infraReleaseId,
      operationalStateHash: value.operationalStateHash,
      timetableTransferSetSha256: value.timetableTransferSetSha256,
      stateHash: value.stateHash,
    };
  }
  if (kind === "quality-report") {
    if (operationalEvidenceVersion(version)) validateOperationalV2Quality(value, id, releaseId);
    else {
      invariant(value?.schema === "zugfolge-final-infrastructure-quality-report/v1" && value.releaseId === releaseId, `${id} ist kein releasegebundener Qualitätsbericht.`);
      invariant(value.deterministic === true && value.summary?.visibleLayers === 10 && Number.isSafeInteger(value.summary?.visibleFeatures) && value.summary.visibleFeatures > 0, `${id} besitzt keinen vollständigen deterministischen Qualitätsnachweis.`);
    }
  }
  return {};
}

function normalizeDeliveryInventory(value, releaseId, { requireSignedContract = true } = {}) {
  if (requireSignedContract) validateSignedDeliveryContract(value, releaseId);
  else invariant([DELIVERY_SCHEMA_V1, DELIVERY_SCHEMA_V2].includes(value?.schema) && value.releaseId === releaseId, "Delivery-Manifest gehört nicht zum Buildrelease.");
  invariant(Array.isArray(value.artifacts) && value.artifacts.length > 0, "Delivery-Manifest besitzt kein Artefaktinventar.");
  const ids = new Set();
  const installPaths = new Set();
  const inventory = value.artifacts.map((entry, index) => {
    const id = stableId(entry?.id, `Delivery-Artefakt[${index}].id`);
    invariant(!ids.has(id), `Delivery-Artefakt ${id} ist doppelt.`);
    ids.add(id);
    const kind = stableId(entry.kind, `Delivery-Artefakt ${id}.kind`);
    const installPath = portablePath(entry.installPath, `Delivery-Artefakt ${id}.installPath`);
    invariant(!installPaths.has(installPath), `Delivery-Installationspfad ${installPath} ist doppelt.`);
    installPaths.add(installPath);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `Delivery-Artefakt ${id} besitzt keinen Byte-SHA-Beleg.`);
    const operationalBinding = kind === "operational-infrastructure-v2"
      ? (() => {
          invariant(entry.infraReleaseId === releaseId, `Delivery-Artefakt ${id} ist nicht an den InfraRelease gebunden.`);
          invariant(SHA256.test(entry.stateHash) && entry.stateHash !== entry.sha256, `Delivery-Artefakt ${id} besitzt keine getrennte Operational-v2-Zustandsbindung.`);
          invariant(installPath === "operational-infrastructure-v2.json", `Delivery-Artefakt ${id} besitzt den falschen Operational-v2-Installationspfad.`);
          return { infraReleaseId: entry.infraReleaseId, stateHash: entry.stateHash };
        })()
      : {};
    return { id, kind, installPath, ...operationalBinding, bytes: entry.bytes, sha256: entry.sha256 };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(inventory.filter(({ kind }) => kind === "basemap").length === 1, "Delivery-Manifest muss genau eine Basemap inventarisieren.");
  return inventory;
}

function bindOutputsToDeliveryInventory(outputs, inventory) {
  const byPath = new Map(inventory.map((entry) => [entry.installPath, entry]));
  for (const output of outputs) {
    if (output.kind === "delivery-manifest") continue;
    const artifact = byPath.get(output.installFile);
    invariant(artifact !== undefined, `Ausgabe ${output.id} fehlt im Delivery-Manifestinventar.`);
    invariant(artifact.kind === OUTPUT_TO_DELIVERY_KIND[output.kind], `Ausgabe ${output.id} besitzt im Delivery-Manifest die falsche Art.`);
    invariant(artifact.bytes === output.bytes && artifact.sha256 === output.sha256, `Ausgabe ${output.id} weicht vom Delivery-Manifestinventar ab.`);
    if (output.kind === "operational-infrastructure-v2") {
      invariant(
        output.infraReleaseId === artifact.infraReleaseId
          && output.stateHash === artifact.stateHash,
        `Ausgabe ${output.id} weicht von der Operational-v2-Zustandsbindung des Delivery-Manifests ab.`,
      );
    }
  }
  return true;
}

function bindFirstClassOperationalSidecars(outputs, releaseId) {
  const operational = outputs.find(({ kind }) => kind === "operational-infrastructure-v2");
  const movement = outputs.find(({ kind }) => kind === "movement-route-templates-v2");
  const transfers = outputs.find(({ kind }) => kind === "timetable-transfer-demands-v2");
  invariant(
    operational !== undefined && movement !== undefined && transfers !== undefined,
    "Build-Evidence-v3 braucht Operational-v2, Movement-Route-Templates-v2 und Timetable-Transfer-Demands-v2 als erstklassige Ausgaben.",
  );
  invariant(
    movement.installFile === "operational-infrastructure-v2.movement-route-templates-v2.json"
      && transfers.installFile === "timetable-routes-v2.transfer-demands-v2.json",
    "Erstklassige Operational-v2-Sidecars besitzen keine kanonischen Installationspfade.",
  );
  invariant(
    movement.infraReleaseId === releaseId
      && transfers.infraReleaseId === releaseId
      && movement.operationalStateHash === operational.stateHash
      && movement.timetableTransferSetSha256 === transfers.transferSetSha256,
    "Erstklassige Operational-v2-Sidecars verletzen ihre Release-, Zustands- oder Transferbindung.",
  );
}

async function validateFirstClassOperationalSidecarFiles(root, inputs, outputs, releaseId) {
  const operational = outputs.find(({ kind }) => kind === "operational-infrastructure-v2");
  const movement = outputs.find(({ kind }) => kind === "movement-route-templates-v2");
  const transfers = outputs.find(({ kind }) => kind === "timetable-transfer-demands-v2");
  bindFirstClassOperationalSidecars(outputs, releaseId);

  const readBoundJson = async (output, label) => {
    const path = await containedRealPath(root, output.file, label);
    const bytes = await readFile(path);
    invariant(
      bytes.length === output.bytes && sha256Bytes(bytes) === output.sha256,
      `${label} änderte sich zwischen Bytebeleg und semantischer Sidecar-Prüfung.`,
    );
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${label} ist kein gültiges JSON-Artefakt.`);
    }
  };

  const transferPlan = await readBoundJson(transfers, "Timetable-Transfer-Demands-v2-Ausgabe");
  const movementArtifact = await readBoundJson(movement, "Movement-Route-Templates-v2-Ausgabe");
  const timetableRoutesInput = inputs.find(({ id }) => id === "timetable-routes-v2");
  invariant(
    timetableRoutesInput?.kind === "derived-input",
    "Build-Evidence-v3 braucht timetable-routes-v2 als bytegebundene abgeleitete Eingabe.",
  );
  const timetableRoutesPath = await containedRealPath(
    root,
    timetableRoutesInput.file,
    "Timetable-Routes-v2-Eingabe",
  );
  const timetableRoutesProof = await syntheticOperationalTimetableRoutesProof(
    timetableRoutesPath,
    "Timetable-Routes-v2-Eingabe",
  );
  invariant(
    timetableRoutesProof.bytes === timetableRoutesInput.bytes
      && timetableRoutesProof.sha256 === timetableRoutesInput.sha256,
    "Timetable-Routes-v2-Eingabe weicht von ihrem Evidence-Bytebeleg ab.",
  );
  const validatedTransfers = validateSyntheticOperationalTimetableTransferDemands({
    releaseId,
    transferDemands: transferPlan,
    transferDemandsBinding: {
      file: transfers.installFile,
      bytes: transfers.bytes,
      sha256: transfers.sha256,
      role: "timetable-transfer-demands",
      records: transferPlan.transferRoutes.length,
    },
    routeReport: { gtfsBinding: { snapshotHash: transferPlan.gtfsSnapshotHash } },
    timetableRoutesProof,
  });
  invariant(
    validatedTransfers.dailyCirculationPlanSha256 === transfers.dailyPlanSha256
      && validatedTransfers.transferSetSha256 === transfers.transferSetSha256,
    "Timetable-Transfer-Demands-v2-Ausgabe weicht von ihrer kanonisch validierten Routenbindung ab.",
  );
  const validated = validateMovementRouteTemplatesV2({
    artifact: movementArtifact,
    binding: {
      file: movement.installFile,
      bytes: movement.bytes,
      sha256: movement.sha256,
      stateHash: movement.stateHash,
      operationalStateHash: movement.operationalStateHash,
      timetableTransferSetSha256: movement.timetableTransferSetSha256,
    },
    infraReleaseId: releaseId,
    operationalStateHash: operational.stateHash,
    timetableTransferPlan: transferPlan,
  });
  invariant(
    validated.stateHash === movement.stateHash
      && validated.operationalStateHash === operational.stateHash
      && validated.timetableTransferSetSha256 === transfers.transferSetSha256,
    "Movement-Route-Templates-v2-Ausgabe weicht von ihrer kanonisch validierten Sidecar-Bindung ab.",
  );
}

export async function validateFirstClassOperationalSidecarEvidence({ artifactRoot, inputs, outputs, releaseId }) {
  invariant(RELEASE_ID.test(releaseId), "Operational-v2-Sidecar-Pruefung braucht einen Jahres-Patchrelease.");
  invariant(Array.isArray(inputs), "Operational-v2-Sidecar-Pruefung braucht ein Eingabeinventar.");
  invariant(Array.isArray(outputs), "Operational-v2-Sidecar-Pruefung braucht ein Ausgabeinventar.");
  await validateFirstClassOperationalSidecarFiles(resolve(artifactRoot), inputs, outputs, releaseId);
  return { inputs: inputs.length, outputs: 3 };
}

async function bindOperationalOutputsToArtifactInventory(root, inputs, outputs, releaseId, version) {
  const inventoryInput = inputs.find(({ id }) => id === "infra-release-artifact-inventory");
  invariant(inventoryInput?.kind === "derived-input", "Operational-v2-Evidence braucht das typisierte InfraRelease-Artefaktinventar als abgeleitete Eingabe.");
  const path = await containedRealPath(root, inventoryInput.file, "InfraRelease-Artefaktinventar");
  let inventory;
  try {
    inventory = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("InfraRelease-Artefaktinventar ist kein gültiges JSON-Artefakt.");
  }
  invariant(inventory?.schema === "zugfolge-infra-release-artifacts/v2" && Array.isArray(inventory.artifacts), "Operational-v2-Evidence bindet kein typisiertes InfraRelease-Artefaktinventar.");
  const requiredKinds = firstClassOperationalSidecarsVersion(version)
    ? ["operational-infrastructure-v2", "movement-route-templates-v2", "timetable-transfer-demands-v2"]
    : ["operational-infrastructure-v2"];
  for (const kind of requiredKinds) {
    const output = outputs.find((entry) => entry.kind === kind);
    const bindings = inventory.artifacts.filter((entry) => entry.kind === kind);
    invariant(output !== undefined && bindings.length === 1, `InfraRelease-Artefaktinventar muss genau eine ${kind}-Ausgabe binden.`);
    const [binding] = bindings;
    invariant(
      binding.file === output.installFile
        && binding.bytes === output.bytes
        && binding.sha256 === output.sha256
        && SHA256.test(binding.sha256),
      `${kind}-Ausgabe weicht von der Bytebindung des InfraRelease-Artefaktinventars ab.`,
    );
    if (kind === "operational-infrastructure-v2") {
      invariant(
        binding.infraReleaseId === releaseId
          && binding.stateHash === output.stateHash
          && SHA256.test(binding.stateHash)
          && binding.sha256 !== binding.stateHash,
        "Operational-v2-Ausgabe weicht von der Byte-/Zustandsbindung des InfraRelease-Artefaktinventars ab.",
      );
    }
  }
}

export function validateCurrentAnnualOperationalPublicationBinding({
  releaseId,
  publicationReceipt,
  outputs,
  releaseConfig,
}) {
  invariant(releaseId === CURRENT_ANNUAL_V3_RELEASE_ID, "Operational-Publication-Querbindung gilt nur fuer den aktuellen Jahresrelease.");
  invariant(publicationReceipt?.infraReleaseId === releaseId, "Operational-v2-Publication-Receipt bindet nicht den aktuellen Jahresrelease.");
  invariant(Array.isArray(outputs), "Operational-Publication-Querbindung besitzt kein Ausgabeinventar.");
  const operationalOutputs = outputs.filter(({ kind }) => kind === "operational-infrastructure-v2");
  const movementOutputs = outputs.filter(({ kind }) => kind === "movement-route-templates-v2");
  invariant(operationalOutputs.length === 1 && movementOutputs.length === 1,
    "Operational-Publication-Querbindung braucht genau ein Operational-/Movement-Ausgabepaar.");
  const [operational] = operationalOutputs;
  const [movement] = movementOutputs;
  const publishedOperational = publicationReceipt.published?.operationalInfrastructure;
  const publishedMovement = publicationReceipt.published?.movementRouteTemplates;
  invariant(
    publishedOperational?.file === operational.file
      && publishedOperational.bytes === operational.bytes
      && publishedOperational.sha256 === operational.sha256
      && publishedOperational.stateHash === operational.stateHash
      && operational.infraReleaseId === releaseId,
    "Operational-v2-Publication-Receipt bindet nicht Pfad, Bytes, SHA-256 und State-Hash der Build-Evidence-Ausgabe.",
  );
  invariant(
    publishedMovement?.file === movement.file
      && publishedMovement.bytes === movement.bytes
      && publishedMovement.sha256 === movement.sha256
      && publishedMovement.stateHash === movement.stateHash
      && publishedMovement.operationalStateHash === movement.operationalStateHash
      && publishedMovement.timetableTransferSetSha256 === movement.timetableTransferSetSha256
      && movement.infraReleaseId === releaseId,
    "Operational-v2-Publication-Receipt bindet nicht Pfad, Bytes, SHA-256, State- und Transfer-Hashes der Movement-Ausgabe.",
  );
  const operationalDeriver = releaseConfig?.pipeline?.operationalDeriver;
  invariant(
    operationalDeriver?.output === operational.file
      && operationalDeriver.candidate === publicationReceipt.sources?.candidate?.file
      && operationalDeriver.candidateMovementRouteTemplates === publicationReceipt.sources?.movementRouteTemplates?.file
      && operationalDeriver.report === publicationReceipt.sources?.report?.file,
    "Deutschland-Jahresrelease bindet nicht dieselben Operational-v2-Quell- und Zielpfade wie Publication-Receipt und Build-Evidence.",
  );
  return { operational, movement };
}

async function deliveryInventoryFromOutput(root, outputs, releaseId) {
  const delivery = outputs.find(({ kind }) => kind === "delivery-manifest");
  invariant(delivery !== undefined, "Delivery-Manifest-Ausgabe fehlt.");
  const path = await containedRealPath(root, delivery.file, "Delivery-Manifest-Ausgabe");
  const value = JSON.parse(await readFile(path, "utf8"));
  const inventory = normalizeDeliveryInventory(value, releaseId);
  bindOutputsToDeliveryInventory(outputs, inventory);
  const qualityEntries = inventory.filter(({ kind }) => kind === "quality-manifest");
  invariant(
    qualityEntries.length === 1 && value.bindings?.qualitySha256 === qualityEntries[0].sha256,
    "Delivery-Manifest bindet seinen Qualitätsbericht nicht bytegenau.",
  );
  return inventory;
}

async function releaseWrapper(root, input, expectedSchema, label) {
  invariant(input?.kind === "derived-input", `Operational-v2-Evidence benötigt ${label} als abgeleitete Eingabe.`);
  const path = await containedRealPath(root, input.file, label);
  let wrapper;
  try {
    wrapper = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} ist kein gültiges JSON-Artefakt.`);
  }
  invariant(
    wrapper !== null && typeof wrapper === "object" && !Array.isArray(wrapper)
      && Object.keys(wrapper).sort().join("\u0000") === ["release", "releaseHash"].sort().join("\u0000"),
    `${label} besitzt keine strikte releaseHash-Hülle.`,
  );
  invariant(wrapper.release?.schema === expectedSchema, `${label} besitzt ein unbekanntes Release-Schema.`);
  invariant(
    SHA256.test(wrapper.releaseHash) && wrapper.releaseHash === canonicalValueSha256(wrapper.release),
    `${label} bindet seinen kanonischen Releaseinhalt nicht.`,
  );
  return wrapper;
}

async function bindDeliveryToReleaseWrappers(
  root,
  inputs,
  outputs,
  releaseId,
  version,
  expectedOperationalProvenance,
  expectedOperationalAuthority,
) {
  const infraInput = inputs.find(({ id }) => id === "infra-release-wrapper");
  const mapInput = inputs.find(({ id }) => id === "map-release-wrapper");
  const sourcesInput = inputs.find(({ id }) => id === "delivery-sources");
  const infra = await releaseWrapper(root, infraInput, "zugfolge-infra-release/v2", "InfraRelease-Hülle");
  const map = await releaseWrapper(root, mapInput, "zugfolge-map-release/v1", "Kartenrelease-Hülle");
  invariant(sourcesInput?.kind === "derived-input", "Operational-v2-Evidence benötigt den Delivery-Quellenvertrag als abgeleitete Eingabe.");
  invariant(infra.release.releaseId === releaseId, "InfraRelease-Hülle gehört nicht zum Buildrelease.");
  invariant(typeof map.release.releaseId === "string" && map.release.releaseId !== "", "Kartenrelease-Hülle besitzt keine Release-ID.");

  const deliveryOutput = outputs.find(({ kind }) => kind === "delivery-manifest");
  const deliveryPath = await containedRealPath(root, deliveryOutput.file, "Delivery-Manifest-Ausgabe");
  const delivery = JSON.parse(await readFile(deliveryPath, "utf8"));
  validateSignedDeliveryContract(delivery, releaseId, "Delivery-Manifest-Ausgabe", 2);
  if (releaseId === CURRENT_ANNUAL_V3_RELEASE_ID) {
    validateOperationalBuildAuthority(expectedOperationalAuthority);
    invariant(
      JSON.stringify(sortedValue(delivery.operationalProvenance)) === JSON.stringify(sortedValue(expectedOperationalProvenance))
        && delivery.bindings.operationalProvenanceSha256 === germanyOperationalProvenanceSha256(expectedOperationalProvenance)
        && JSON.stringify(sortedValue(delivery.operationalAuthority)) === JSON.stringify(sortedValue(expectedOperationalAuthority))
        && delivery.bindings.operationalAuthoritySha256 === operationalBuildAuthoritySha256(expectedOperationalAuthority),
      "Delivery-v2 und Build-Evidence binden nicht dieselbe integrierte Operational-v2-Ausfuehrungsprovenienz und Build-Authority.",
    );
  }
  invariant(
    delivery.bindings.infraReleaseHash === infra.releaseHash
      && delivery.bindings.mapReleaseHash === map.releaseHash,
    "Delivery-Manifest bindet nicht die belegten kanonischen InfraRelease-/Kartenrelease-Hüllen.",
  );
  const sourcesPath = await containedRealPath(root, sourcesInput.file, "Delivery-Quellenvertrag");
  const sourcesBytes = await readFile(sourcesPath);
  const sources = JSON.parse(sourcesBytes.toString("utf8"));
  const deliveryInventory = normalizeDeliveryInventory(delivery, releaseId);
  const assetNotices = validateMapAssetNotices(sources?.assetNotices);
  validateMapAssetNoticeBindings(assetNotices, deliveryInventory);
  const rightsGate = delivery.approvalGates?.rights;
  invariant(
    sources !== null && typeof sources === "object" && !Array.isArray(sources)
      && Object.keys(sources).sort().join("\u0000") === ["schema", "releaseId", "sources", "assetInventoryPlanSha256", "assetNotices"].sort().join("\u0000")
      && sources.schema === DELIVERY_SOURCES_SCHEMA_V2
      && sources.releaseId === releaseId
      && Array.isArray(sources.sources) && sources.sources.length > 0
      && SHA256.test(sources.assetInventoryPlanSha256)
      && sources.assetInventoryPlanSha256 === map.release.assetInventoryPlanSha256
      && sourcesBytes.equals(serializeDeliveryJson(sources))
      && delivery.bindings.sourcesSha256 === sha256Bytes(sourcesBytes)
      && rightsGate?.status === "passed"
      && rightsGate.sourceManifestSchema === DELIVERY_SOURCES_SCHEMA_V2
      && rightsGate.sourceCount === sources.sources.length
      && rightsGate.assetGroupCount === assetNotices.assets.length
      && rightsGate.assetFileCount === deliveryInventory.filter(({ kind }) => ["glyph", "sprite"].includes(kind)).length,
    "Delivery-Manifest bindet nicht den belegten kanonischen Delivery-Quellenvertrag.",
  );

  const qualityOutput = outputs.find(({ kind }) => kind === "quality-report");
  const qualityPath = await containedRealPath(root, qualityOutput.file, "Operational-v2-Qualitätsbericht");
  const qualityBytes = await readFile(qualityPath);
  const qualityReport = JSON.parse(qualityBytes.toString("utf8"));
  const timetableYear = Number.parseInt(RELEASE_ID.exec(releaseId)?.groups?.year ?? "", 10);
  validateMapDeliveryQualityReport({
    qualityReport,
    releaseId,
    timetableYear,
    operationalV2: true,
    infraRelease: infra.release,
    qualitySha256: sha256Bytes(qualityBytes),
  });
  if (firstClassOperationalSidecarsVersion(version)) {
    const movementOutput = outputs.find(({ kind }) => kind === "movement-route-templates-v2");
    const transferOutput = outputs.find(({ kind }) => kind === "timetable-transfer-demands-v2");
    const timetableRoutesInput = inputs.find(({ id }) => id === "timetable-routes-v2");
    const closure = infra.release.quality?.operationalClosure;
    const movement = closure?.movementRouteTemplates;
    const timetable = closure?.timetableRouteEvidence;
    invariant(
      movement?.bytes === movementOutput.bytes
        && movement.sha256 === movementOutput.sha256
        && movement.stateHash === movementOutput.stateHash
        && movement.operationalStateHash === movementOutput.operationalStateHash
        && movement.timetableTransferSetSha256 === movementOutput.timetableTransferSetSha256,
      "InfraRelease-Hülle bindet die erstklassige Movement-Route-Templates-v2-Ausgabe nicht vollständig.",
    );
    invariant(
      timetable?.transferDemandsSchema === "zugfolge-timetable-transfer-demands/v2"
        && timetableRoutesInput?.kind === "derived-input"
        && timetable.routesBytes === timetableRoutesInput.bytes
        && timetable.routesSha256 === timetableRoutesInput.sha256
        && timetable.routeSetSha256 === timetableRoutesInput.sha256
        && timetable.transferDemandsBytes === transferOutput.bytes
        && timetable.transferDemandsSha256 === transferOutput.sha256
        && timetable.dailyCirculationPlanSha256 === transferOutput.dailyPlanSha256
        && timetable.transferSetSha256 === transferOutput.transferSetSha256,
      "InfraRelease-Hülle bindet die erstklassige Timetable-Transfer-Demands-v2-Ausgabe nicht vollständig.",
    );
  }
}

async function outputProof(root, descriptor, releaseId, version, validateOperationalInfrastructure) {
  const proof = await fileProof(root, descriptor, `Ausgabe ${descriptor.id}`);
  const path = await containedRealPath(root, descriptor.file, `Ausgabe ${descriptor.id}.file`);
  const shape = await validateOutputShape(
    descriptor.kind,
    path,
    releaseId,
    descriptor.id,
    version,
    proof,
    validateOperationalInfrastructure,
  );
  return { ...proof, ...shape };
}

async function* nonEmptyLines(path) {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  let remainder = "";
  for await (const chunk of stream) {
    remainder += chunk;
    let newline;
    while ((newline = remainder.indexOf("\n")) >= 0) {
      const line = remainder.slice(0, newline).replace(/\r$/, "");
      remainder = remainder.slice(newline + 1);
      if (line.trim().length > 0) yield line;
    }
  }
  if (remainder.trim().length > 0) yield remainder.replace(/\r$/, "");
}

async function inspectSemanticRegression(root, regression) {
  invariant(Array.isArray(regression?.semanticLayers) && regression.semanticLayers.length === SEMANTIC_LAYERS.length, "Regressionsbeleg muss exakt alle zehn öffentlichen Semantiklayer prüfen.");
  const layerNames = regression.semanticLayers.map(({ layer }) => layer);
  invariant(JSON.stringify(layerNames) === JSON.stringify(SEMANTIC_LAYERS), "Semantiklayer stehen nicht in der kanonischen Reihenfolge.");
  invariant(Array.isArray(regression.forbiddenPublicTokens) && regression.forbiddenPublicTokens.includes("12472736971"), "Der bekannte BOStrab-Knoten 12472736971 fehlt im negativen Regressionsvertrag.");
  invariant(regression.forbiddenPublicTokens.every((token) => typeof token === "string" && /^[-:a-z0-9]+$/i.test(token) && token.length >= 6), "Regressionsvertrag enthält ein ungültiges verbotenes Token.");
  invariant(Array.isArray(regression.requiredEboSignalFeatureIds) && regression.requiredEboSignalFeatureIds.length > 0, "Regressionsvertrag braucht mindestens ein positives EBO-Signal.");
  invariant(regression.requiredEboSignalFeatureIds.every((id) => /^signal:[-:a-z0-9]+$/i.test(id)), "Positiver EBO-Signalbeleg besitzt keine stabile Signal-ID.");
  const semanticLayers = [];
  const signalIds = new Set();
  for (const descriptor of regression.semanticLayers) {
    const normalized = { file: portablePath(descriptor.file, `Regressionslayer ${descriptor.layer}.file`) };
    const proof = await fileProof(root, normalized, `Regressionslayer ${descriptor.layer}`);
    const path = await containedRealPath(root, normalized.file, `Regressionslayer ${descriptor.layer}.file`);
    let features = 0;
    for await (const rawLine of nonEmptyLines(path)) {
      const line = rawLine.replace(/^\u001e/, "");
      for (const token of regression.forbiddenPublicTokens) invariant(!line.includes(token), `Verbotener öffentlicher Knotenbeleg ${token} steht im Layer ${descriptor.layer}.`);
      let feature;
      try {
        feature = JSON.parse(line);
      } catch {
        throw new Error(`Regressionslayer ${descriptor.layer} enthält ungültiges GeoJSONSeq.`);
      }
      invariant(feature?.type === "Feature" && typeof feature.properties?.feature_id === "string", `Regressionslayer ${descriptor.layer} enthält ein Feature ohne stabile ID.`);
      if (descriptor.layer === "signals") signalIds.add(feature.properties.feature_id);
      features += 1;
    }
    invariant(features > 0, `Regressionslayer ${descriptor.layer} ist leer.`);
    semanticLayers.push({ layer: descriptor.layer, file: normalized.file, features, ...proof });
  }
  for (const id of regression.requiredEboSignalFeatureIds) invariant(signalIds.has(id), `Positives EBO-Signal ${id} fehlt im Signallayer.`);
  return semanticLayers;
}

function inspectReadModelRegression(path, regression) {
  const database = new DatabaseSync(path, { readOnly: true, allowExtension: false, defensive: true, timeout: 0 });
  try {
    for (const token of regression.forbiddenPublicTokens) {
      const found = database.prepare(`SELECT object_id FROM object_details
        WHERE instr(object_id, ?) > 0 OR instr(name, ?) > 0 OR instr(facts_json, ?) > 0 LIMIT 1`).get(token, token, token);
      invariant(found === undefined, `Verbotener öffentlicher Knotenbeleg ${token} steht im ReadModel.`);
    }
    for (const id of regression.requiredEboSignalFeatureIds) {
      const found = database.prepare("SELECT 1 AS found FROM object_details WHERE kind = 'signal' AND object_id = ? LIMIT 1").get(id);
      invariant(found?.found === 1, `Positives EBO-Signal ${id} fehlt im ReadModel.`);
    }
  } finally {
    database.close();
  }
}

function validateCurrentAnnualV3Bindings(spec, version, { resolvedCommits = false } = {}) {
  if (version !== 3 || spec.releaseId !== CURRENT_ANNUAL_V3_RELEASE_ID) return;
  for (const [id, kind, file] of CURRENT_ANNUAL_V3_INPUTS) {
    invariant(
      spec.inputs.filter((input) => input?.id === id && input.kind === kind && input.file === file && input.version === spec.releaseId).length === 1,
      `Build-Evidence-v3 für ${spec.releaseId} muss ${id} exakt als ${kind} ${file} binden.`,
    );
  }
  const verifierInput = spec.inputs.find(({ id }) => id === "operational-attestation-verifier");
  const verifierKeys = resolvedCommits
    ? ["bytes", "cacheFile", "file", "id", "kind", "sha256", "version"]
    : ["cacheFile", "expectedBytes", "expectedSha256", "file", "id", "kind", "version"];
  exactObjectKeys(verifierInput, verifierKeys, "Operational-Attestierungsverifier-Eingabe");
  invariant(verifierInput.cacheFile === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.cacheFile
    && (resolvedCommits
      ? verifierInput.bytes === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.bytes
        && verifierInput.sha256 === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.sha256
      : verifierInput.expectedBytes === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.bytes
        && verifierInput.expectedSha256 === CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.sha256),
  `Build-Evidence-v3 fuer ${spec.releaseId} muss GitHub CLI ${CURRENT_ANNUAL_V3_ATTESTATION_VERIFIER.version} bytegenau pinnen.`);
  const trustedRootInput = spec.inputs.find(({ id }) => id === "operational-attestation-trusted-root");
  const trustedRootKeys = resolvedCommits
    ? ["bytes", "cacheFile", "file", "id", "kind", "sha256", "version"]
    : ["cacheFile", "expectedBytes", "expectedSha256", "file", "id", "kind", "version"];
  exactObjectKeys(trustedRootInput, trustedRootKeys, "Operational-Attestierungs-Trust-Root-Eingabe");
  invariant(trustedRootInput.cacheFile === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.cacheFile
    && (resolvedCommits
      ? trustedRootInput.bytes === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.bytes
        && trustedRootInput.sha256 === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.sha256
      : trustedRootInput.expectedBytes === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.bytes
        && trustedRootInput.expectedSha256 === CURRENT_ANNUAL_V3_ATTESTATION_TRUSTED_ROOT.sha256),
  `Build-Evidence-v3 fuer ${spec.releaseId} muss den GitHub-Attestierungs-Trust-Root bytegenau pinnen.`);
  invariant(
    spec.tools.filter((tool) => (
      tool?.id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.id
        && (resolvedCommits
          ? tool.kind === "binary"
            && tool.version === spec.commits.operationalValidatorBuild
            && tool.file === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.file
            && tool.cacheFile === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.cacheFile
            && tool.bytes === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.expectedBytes
            && tool.sha256 === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.expectedSha256
            && Object.keys(tool).length === 7
          : Object.entries(CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL).every(([key, expected]) => tool[key] === expected)
            && Object.keys(tool).length === Object.keys(CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL).length)
    )).length === 1,
    `Build-Evidence-v3 fuer ${spec.releaseId} muss das effektive Operational-v2-Validator-Binary exakt und commitgebunden deklarieren.`,
  );
  invariant(
    spec.tools.filter((tool) => (
      tool?.id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL.id
        && (resolvedCommits
          ? tool.kind === "binary"
            && tool.version === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL.version
            && tool.file === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL.file
            && tool.cacheFile === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL.cacheFile
            && tool.bytes === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BYTES
            && SHA256.test(tool.sha256)
            && Object.keys(tool).length === 7
          : Object.entries(CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL).every(([key, expected]) => tool[key] === expected)
            && Object.keys(tool).length === Object.keys(CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL).length)
    )).length === 1,
    `Build-Evidence-v3 fuer ${spec.releaseId} muss das immutable Operational-v2-Validator-Rebuild-Binary exakt deklarieren.`,
  );
  const runtimeTools = spec.tools.filter(({ id, kind }) => id === "gdal-pmtiles" && kind === "runtime-bundle");
  invariant(runtimeTools.length === 1, `Build-Evidence-v3 für ${spec.releaseId} muss genau ein manifestgebundenes gdal-pmtiles-Runtime-Bundle führen.`);
  invariant(
    runtimeTools[0].version === "3.13.2"
      && runtimeTools[0].manifestFile === PINNED_GDAL_RUNTIME_MANIFEST
      && runtimeTools[0].manifestCacheFile === PINNED_GDAL_RUNTIME_MANIFEST_CACHE,
    `Build-Evidence-v3 für ${spec.releaseId} bindet nicht das versionierte GDAL-3.13.2-win32-x64-Runtime-Manifest.`,
  );
}

function validateSpecBasics(spec, { requireExpectedInputProofs = false, resolvedCommits = false } = {}) {
  const version = specVersion(spec?.schema);
  const outputKinds = outputKindsForVersion(version);
  parseReleasePair(spec.releaseId, spec.previousReleaseId);
  validateBuildEvidenceReleaseGeneration(version, spec.releaseId);
  if (version === 1 || resolvedCommits) {
    validateCommit(spec.commits?.semanticExport, "commits.semanticExport");
    validateCommit(spec.commits?.mapBuild, "commits.mapBuild");
    if (version === 3 && spec.releaseId === CURRENT_ANNUAL_V3_RELEASE_ID) {
      validateCommit(spec.commits?.operationalValidatorBuild, "commits.operationalValidatorBuild");
      invariant(
        spec.commits.operationalValidatorBuild === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BUILD_COMMIT,
        "Operational-v2-Validator-Build-Commit stimmt nicht mit der belegten 2026.5-Derivation ueberein.",
      );
    }
    if (version === 3 && spec.commits?.operationalValidatorBuild !== undefined) {
      validateCommit(spec.commits.operationalValidatorBuild, "commits.operationalValidatorBuild");
      invariant(
        spec.tools.some((tool) => tool?.id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.id
          && tool.kind === "binary"
          && tool.version === spec.commits.operationalValidatorBuild),
        "Operational-v2-Validator-Werkzeug ist nicht mit seinem separaten Build-Commit etikettiert.",
      );
    }
  } else {
    invariant(spec.commits === undefined, "Operational-v2-Vorbereitung darf keine vorab erfundenen Commitbindungen enthalten.");
  }
  invariant(Array.isArray(spec.inputs) && spec.inputs.length >= REQUIRED_INPUT_KINDS.length, "Build-Evidence besitzt zu wenige Eingaben.");
  if (operationalEvidenceVersion(version)) {
    for (const [index, input] of spec.inputs.entries()) {
      if (input?.kind === "specification") {
        validateSpecificationDescriptorReleaseBinding(
          input,
          spec.releaseId,
          `Eingabe[${index}]`,
          { materialized: resolvedCommits },
        );
      }
    }
    for (const id of ["infra-release-wrapper", "map-release-wrapper", "delivery-sources"]) {
      invariant(
        spec.inputs.some((input) => input?.id === id && input.kind === "derived-input"),
        `Operational-v2-Evidence benötigt die abgeleitete Eingabe ${id}.`,
      );
    }
    if (firstClassOperationalSidecarsVersion(version)) {
      invariant(
        spec.inputs.some((input) => input?.id === "timetable-routes-v2" && input.kind === "derived-input"),
        "Build-Evidence-v3 benötigt timetable-routes-v2 als abgeleitete Eingabe.",
      );
    }
    if (resolvedCommits) validateResolvedCandidatePackage(spec.candidatePackage, spec.releaseId, spec.outputs);
    else validateCandidatePackageSpec(spec.candidatePackage, spec.inputs);
  }
  if (requireExpectedInputProofs) {
    for (const [index, input] of spec.inputs.entries()) {
      invariant(Number.isSafeInteger(input?.expectedBytes) && input.expectedBytes > 0, `Eingabe[${index}] besitzt keine verpflichtende erwartete Bytezahl.`);
      invariant(SHA256.test(input?.expectedSha256), `Eingabe[${index}] besitzt keinen verpflichtenden erwarteten SHA-256.`);
    }
  }
  invariant(Array.isArray(spec.tools) && spec.tools.length > 0, "Build-Evidence besitzt keine gepinnten Werkzeuge.");
  validateCurrentAnnualV3Bindings(spec, version, { resolvedCommits });
  invariant(Array.isArray(spec.outputs) && spec.outputs.length === outputKinds.length, `Build-Evidence muss exakt ${outputKinds.length} aktivierungsrelevante Ausgaben binden.`);
  invariant(spec.deployment?.activationMode === "atomic-config-swap", "Deployment muss einen atomaren Konfigurationswechsel verlangen.");
  invariant(spec.deployment?.retainPreviousForRollback === true, "Deployment muss den Vorgänger für Rollback behalten.");
  invariant(spec.buildCache?.backupRequired === true && spec.buildCache?.encrypted === true, "Buildcache muss verschlüsselt gesichert werden.");
  invariant(spec.buildCache?.restoreVerification === "empty-path-full-inventory", "Buildcache muss auf einen leeren Pfad vollständig wiederhergestellt werden.");
  return { version, outputKinds };
}

export function validateMapReleaseBuildEvidenceSpec(spec) {
  validateSpecBasics(spec);
  return spec;
}

export async function materializeMapReleaseBuildEvidence({
  spec,
  specBytes,
  specFile,
  artifactRoot,
  commits,
  validateOperationalInfrastructure = validateOperationalInfrastructureV2Native,
  attestationVerifier = verifyGithubAttestationSubject,
}) {
  const version = specVersion(spec?.schema);
  const { outputKinds } = validateSpecBasics(spec, { requireExpectedInputProofs: version === 1 });
  const requiresOperationalValidatorBuild = version === 3 && spec.tools.some((tool) => (
    tool?.id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.id
      && tool.kind === "binary"
      && tool.version === OPERATIONAL_VALIDATOR_BUILD_COMMIT_VERSION
  ));
  let commitBinding;
  if (version === 1) {
    invariant(commits === undefined, "Legacy-v1 bindet Commits ausschließlich in seiner Spezifikation.");
    commitBinding = spec.commits;
  } else {
    validateCommit(commits?.semanticExport, "commits.semanticExport");
    validateCommit(commits?.mapBuild, "commits.mapBuild");
    if (requiresOperationalValidatorBuild) validateCommit(commits?.operationalValidatorBuild, "commits.operationalValidatorBuild");
    commitBinding = {
      semanticExport: commits.semanticExport,
      mapBuild: commits.mapBuild,
      ...(requiresOperationalValidatorBuild ? { operationalValidatorBuild: commits.operationalValidatorBuild } : {}),
    };
  }
  invariant(Buffer.isBuffer(specBytes) && specBytes.length > 0, "Rohbytes der Build-Evidence-Spezifikation fehlen.");
  let parsedSpec;
  try {
    parsedSpec = JSON.parse(specBytes.toString("utf8"));
  } catch {
    throw new Error("Build-Evidence-Spezifikation ist kein gültiges JSON-Artefakt.");
  }
  invariant(JSON.stringify(sortedValue(parsedSpec)) === JSON.stringify(sortedValue(spec)), "Übergebener Buildvertrag weicht von seinen Rohbytes ab.");
  const root = resolve(artifactRoot);
  const normalizedSpecFile = portablePath(specFile, "specFile");
  invariant(normalizedSpecFile.startsWith("tools/tiles/") && normalizedSpecFile.endsWith(".spec.json"), "Build-Evidence-Spezifikation muss versioniert unter tools/tiles eingecheckt sein.");
  const actualSpec = await fileProof(root, { file: normalizedSpecFile }, "Build-Evidence-Spezifikation");
  invariant(actualSpec.bytes === specBytes.length && actualSpec.sha256 === sha256Bytes(specBytes), "Übergebene Spezifikationsbytes stimmen nicht mit specFile überein.");

  const inputIds = new Set();
  const inputs = [];
  for (const descriptor of spec.inputs) {
    const id = stableId(descriptor?.id, "Eingabe-ID");
    invariant(!inputIds.has(id), `Eingabe ${id} ist doppelt.`);
    inputIds.add(id);
    invariant(INPUT_KINDS.has(descriptor.kind), `Eingabe ${id} besitzt eine unbekannte Art.`);
    const inputVersion = pinnedVersion(descriptor.version, `Eingabe ${id}`);
    const file = portablePath(descriptor.file, `Eingabe ${id}.file`);
    if (["specification", "repo-contract"].includes(descriptor.kind)) invariant(file.startsWith("tools/"), `Repositoryvertrag ${id} muss im belegten Repository-Commit liegen.`);
    const proof = await fileProof(root, { ...descriptor, file }, `Eingabe ${id}`);
    if (operationalEvidenceVersion(version) && descriptor.kind === "specification") {
      await validateSpecificationContentReleaseBinding(root, { ...descriptor, version: inputVersion, file }, `Eingabe ${id}`);
    }
    inputs.push({
      id,
      kind: descriptor.kind,
      version: inputVersion,
      file,
      ...(descriptor.cacheFile === undefined ? {} : { cacheFile: portablePath(descriptor.cacheFile, `Eingabe ${id}.cacheFile`) }),
      ...(descriptor.reuse === undefined ? {} : { reuse: structuredClone(descriptor.reuse) }),
      ...proof,
    });
  }
  for (const kind of REQUIRED_INPUT_KINDS) invariant(inputs.some((entry) => entry.kind === kind), `Build-Evidence benötigt eine Eingabe vom Typ ${kind}.`);
  invariant(inputs.filter(({ kind }) => kind === "build-cache-inventory").length === 1, "Build-Evidence braucht genau ein Buildcache-Inventar.");

  let verifiedOperationalPublication;
  let verifiedOperationalValidatorRebuild;
  let operationalProvenance;
  let operationalAuthority;
  let currentAnnualReleaseConfig;
  let currentAnnualValidatorRebuildSpec;
  if (version === 3 && spec.releaseId === CURRENT_ANNUAL_V3_RELEASE_ID) {
    const nativeReceipt = inputs.find(({ id }) => id === "operational-native-receipt");
    const publicationReceipt = inputs.find(({ id }) => id === "operational-publication-receipt");
    invariant(nativeReceipt?.kind === "derived-input" && publicationReceipt?.kind === "derived-input", "Build-Evidence-v3 braucht beide typisierten Operational-v2-Receipts.");
    verifiedOperationalPublication = await verifyGermanyOperationalInfrastructureV2PublicationReceipt({
      workspaceRoot: root,
      publicationReceiptPath: await containedRealPath(root, publicationReceipt.file, "Operational-v2-Publication-Receipt"),
      expectedReleaseId: spec.releaseId,
    });
    invariant(verifiedOperationalPublication.proof.bytes === publicationReceipt.bytes && verifiedOperationalPublication.proof.sha256 === publicationReceipt.sha256,
      "Operational-v2-Publication-Receipt driftet von der Build-Evidence-Eingabe.");
    operationalProvenance = validateGermanyOperationalProvenance(verifiedOperationalPublication.receipt.operationalProvenance);
    invariant(
      operationalProvenance.producerKind === GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND
        && operationalProvenance.releaseEvidenceEligible === true
        && operationalProvenance.productionActivationEligible === true,
      "Build-Evidence-v3 akzeptiert nur atomar integrierte, evidence- und aktivierungsgeeignete Operational-v2-Provenienz.",
    );
    invariant(verifiedOperationalPublication.receipt.nativeReceipt.file === nativeReceipt.file
      && verifiedOperationalPublication.receipt.nativeReceipt.bytes === nativeReceipt.bytes
      && verifiedOperationalPublication.receipt.nativeReceipt.sha256 === nativeReceipt.sha256,
    "Operational-v2-Publication-Receipt bindet nicht das Build-Evidence-Native-Receipt.");
    invariant(verifiedOperationalPublication.receipt.publisher.entrypoint === "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
      "Operational-v2-Publication-Receipt bindet nicht den konfigurierten RecoveryPublisher.");
    const validatorRebuildSpecInput = inputs.find(({ id }) => id === "operational-validator-rebuild-spec");
    const validatorRebuildEvidenceInput = inputs.find(({ id }) => id === "operational-validator-rebuild-evidence");
    invariant(validatorRebuildSpecInput?.kind === "repo-contract" && validatorRebuildEvidenceInput?.kind === "derived-input",
      "Build-Evidence-v3 braucht Rebuild-Spezifikation und typisiertes Validator-Rebuild-Receipt.");
    let validatorRebuildSpec;
    try {
      validatorRebuildSpec = JSON.parse(await readFile(
        await containedRealPath(root, validatorRebuildSpecInput.file, "Operational-Validator-Rebuild-Spezifikation"),
        "utf8",
      ));
    } catch (error) {
      throw new Error("Operational-Validator-Rebuild-Spezifikation ist kein gueltiges JSON.", { cause: error });
    }
    currentAnnualValidatorRebuildSpec = validatorRebuildSpec;
    verifiedOperationalValidatorRebuild = await verifyOperationalValidatorRebuildEvidence({
      spec: validatorRebuildSpec,
      receiptPath: await containedRealPath(root, validatorRebuildEvidenceInput.file, "Operational-Validator-Rebuild-Receipt"),
      workspaceRoot: root,
    });
    invariant(
      verifiedOperationalValidatorRebuild.proof.bytes === validatorRebuildEvidenceInput.bytes
        && verifiedOperationalValidatorRebuild.proof.sha256 === validatorRebuildEvidenceInput.sha256,
      "Operational-Validator-Rebuild-Receipt driftet von der Build-Evidence-Eingabe.",
    );
    invariant(
      verifiedOperationalValidatorRebuild.receipt.specification.file === validatorRebuildSpecInput.file
        && verifiedOperationalValidatorRebuild.receipt.specification.bytes === validatorRebuildSpecInput.bytes
        && verifiedOperationalValidatorRebuild.receipt.specification.sha256 === validatorRebuildSpecInput.sha256,
      "Operational-Validator-Rebuild-Receipt bindet nicht den Build-Evidence-Rebuild-Vertrag.",
    );
    invariant(
      verifiedOperationalValidatorRebuild.receipt.releaseId === spec.releaseId
        && verifiedOperationalValidatorRebuild.receipt.source.materialization.commit === commitBinding.operationalValidatorBuild,
      "Operational-Validator-Rebuild-Receipt bindet Release oder tatsaechlichen Validator-Build-Commit falsch.",
    );
    for (const [producerId, inputId] of Object.entries(CURRENT_ANNUAL_V3_OPERATIONAL_REBUILD_PRODUCER_INPUTS)) {
      const input = inputs.find(({ id }) => id === inputId);
      const producerProof = verifiedOperationalValidatorRebuild.receipt.producer[producerId];
      invariant(
        input?.kind === "repo-contract"
          && input.file === producerProof.file
          && input.bytes === producerProof.bytes
          && input.sha256 === producerProof.sha256,
        `Operational-Validator-Rebuild-Produzent ${producerId} driftet vom Build-Evidence-Repositoryvertrag ${inputId}.`,
      );
    }
    const publicationRebuild = verifiedOperationalPublication.receipt.validatorRebuild;
    invariant(
      publicationRebuild.specification.file === validatorRebuildSpecInput.file
        && publicationRebuild.specification.bytes === validatorRebuildSpecInput.bytes
        && publicationRebuild.specification.sha256 === validatorRebuildSpecInput.sha256
        && publicationRebuild.evidence.file === validatorRebuildEvidenceInput.file
        && publicationRebuild.evidence.bytes === validatorRebuildEvidenceInput.bytes
        && publicationRebuild.evidence.sha256 === validatorRebuildEvidenceInput.sha256
        && publicationRebuild.sourceCommit === verifiedOperationalValidatorRebuild.receipt.source.materialization.commit
        && publicationRebuild.normalizedPeSha256 === verifiedOperationalValidatorRebuild.receipt.pe.normalized.expectedSha256
        && JSON.stringify(publicationRebuild.preserved) === JSON.stringify(verifiedOperationalValidatorRebuild.receipt.binaries.preserved)
        && JSON.stringify(publicationRebuild.rebuilt) === JSON.stringify(verifiedOperationalValidatorRebuild.receipt.binaries.rebuilt),
      "Operational-v2-Publication-Receipt bindet nicht dieselbe Validator-Rebuild-Evidence wie Build-Evidence-v3.",
    );
    const releaseConfigInput = inputs.find(({ id }) => id === "germany-release-spec");
    const releaseConfig = JSON.parse(await readFile(
      await containedRealPath(root, releaseConfigInput.file, "Deutschland-Jahresrelease-Konfiguration"),
      "utf8",
    ));
    currentAnnualReleaseConfig = releaseConfig;
    const recoveryPublisher = releaseConfig.pipeline?.operationalDeriver?.recoveryPublisher;
    invariant(
      recoveryPublisher?.validatorBuildCommit === commitBinding.operationalValidatorBuild
        && recoveryPublisher.validatorBuildCommit === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BUILD_COMMIT,
      "Deutschland-Jahresrelease und Build-Evidence binden nicht denselben tatsaechlichen Operational-v2-Validator-Build-Commit.",
    );
    invariant(
      recoveryPublisher.validatorExecutable === verifiedOperationalPublication.receipt.publisher.executionInventory.validatorExecutable.file,
      "Deutschland-Jahresrelease bindet nicht den vom Capture belegten Operational-v2-Validator-Pfad.",
    );
    invariant(
      recoveryPublisher.validatorBytes === verifiedOperationalPublication.receipt.publisher.executionInventory.validatorExecutable.bytes
        && recoveryPublisher.validatorSha256 === verifiedOperationalPublication.receipt.publisher.executionInventory.validatorExecutable.sha256,
      "Deutschland-Jahresrelease bindet nicht die vom Capture belegten Operational-v2-Validator-Bytes.",
    );
    invariant(
      recoveryPublisher.validatorRebuildSpecification === validatorRebuildSpecInput.file
        && recoveryPublisher.validatorRebuildEvidence === validatorRebuildEvidenceInput.file
        && recoveryPublisher.validatorRebuildExecutable === verifiedOperationalValidatorRebuild.receipt.binaries.rebuilt.file
        && recoveryPublisher.validatorRebuildExpectedBytes === verifiedOperationalValidatorRebuild.receipt.binaries.rebuilt.bytes
        && recoveryPublisher.validatorNormalizedPeSha256 === verifiedOperationalValidatorRebuild.receipt.pe.normalized.expectedSha256,
      "Deutschland-Jahresrelease bindet nicht den vollstaendig verifizierten Operational-Validator-Rebuild-Beleg.",
    );
    invariant(isRecord(recoveryPublisher.executionInventory), "Deutschland-Jahresrelease besitzt kein Operational-v2-Ausfuehrungsinventar.");
    for (const [inventoryId, executionProof] of Object.entries(verifiedOperationalPublication.receipt.publisher.executionInventory)) {
      if (inventoryId === "validatorExecutable") continue;
      invariant(
        recoveryPublisher.executionInventory[inventoryId] === executionProof.file,
        `Deutschland-Jahresrelease bindet nicht Operational-v2-Ausfuehrungsinventar ${inventoryId}.`,
      );
    }
    for (const [inventoryId, inputId] of Object.entries(CURRENT_ANNUAL_V3_OPERATIONAL_EXECUTION_INPUTS)) {
      const input = inputs.find(({ id }) => id === inputId);
      const executionProof = verifiedOperationalPublication.receipt.publisher.executionInventory[inventoryId];
      invariant(
        input?.kind === "repo-contract"
          && input.file === executionProof.file
          && input.bytes === executionProof.bytes
          && input.sha256 === executionProof.sha256,
        `Operational-v2-Ausfuehrungsinventar ${inventoryId} driftet vom Build-Evidence-Repositoryvertrag ${inputId}.`,
      );
    }
    const captureInput = inputs.find(({ id }) => id === "operational-native-receipt-capture");
    const captureEntrypoint = verifiedOperationalPublication.captureReceipt.producer.captureEntrypoint;
    invariant(
      captureInput?.kind === "repo-contract"
        && captureInput.file === captureEntrypoint.file
        && captureInput.bytes === captureEntrypoint.bytes
        && captureInput.sha256 === captureEntrypoint.sha256,
      "Native-Receipt-Capture-Entrypoint driftet vom Build-Evidence-Repositoryvertrag.",
    );
    operationalAuthority = await materializeCurrentAnnualOperationalAuthority({
      artifactRoot: root,
      inputs,
      releaseConfig,
      rebuildSpec: validatorRebuildSpec,
      outerExecution: verifiedOperationalPublication.outerExecution,
      releaseId: spec.releaseId,
      mapBuildCommit: commitBinding.mapBuild,
      attestationVerifier,
    });
  }

  const inventoryInput = inputs.find(({ id }) => id === spec.buildCache.inventoryInputId);
  invariant(inventoryInput?.kind === "build-cache-inventory", "buildCache.inventoryInputId verweist nicht auf das Buildcache-Inventar.");
  const inventoryPath = await containedRealPath(root, inventoryInput.file, "Buildcache-Inventar");
  const inventory = validateCacheInventory(JSON.parse(await readFile(inventoryPath, "utf8")), spec.releaseId);
  const currentAnnualCacheMappings = await validateCurrentAnnualBuildCachePlanBinding(root, inputs, inventory, spec.releaseId);
  if (currentAnnualCacheMappings !== undefined) {
    validateCurrentAnnualValidatorRebuildCacheArtifacts({
      mappings: currentAnnualCacheMappings,
      inventory,
      rebuildSpec: currentAnnualValidatorRebuildSpec,
      rebuildReceipt: verifiedOperationalValidatorRebuild.receipt,
      rebuildReceiptInput: inputs.find(({ id }) => id === "operational-validator-rebuild-evidence"),
    });
  }
  for (const input of inputs.filter(({ kind }) => ["source-archive", "capture-manifest", "derived-input"].includes(kind))) {
    invariant(input.cacheFile !== undefined, `Eingabe ${input.id} besitzt keinen wiederherstellbaren cacheFile-Pfad.`);
    const cached = inventoryEntry(inventory, input.cacheFile, `Eingabe ${input.id}`);
    invariant(cached.bytes === input.bytes && cached.sha256 === input.sha256, `Buildcache-Beleg für ${input.id} weicht von der Baueingabe ab.`);
  }
  const tools = [];
  const toolIds = new Set();
  for (const descriptor of spec.tools) {
    const id = stableId(descriptor?.id, "Werkzeug-ID");
    invariant(!toolIds.has(id), `Werkzeug ${id} ist doppelt.`);
    toolIds.add(id);
    const toolVersion = pinnedVersion(descriptor.version, `Werkzeug ${id}`);
    if (descriptor.kind === "oci-image") {
      validateOciTool({ ...descriptor, id });
      tools.push({ id, kind: "oci-image", version: toolVersion, reference: descriptor.reference, digest: descriptor.digest });
    } else if (descriptor.kind === "binary") {
      const file = portablePath(descriptor.file, `Werkzeug ${id}.file`);
      const cacheFile = portablePath(descriptor.cacheFile, `Werkzeug ${id}.cacheFile`);
      const proof = await fileProof(root, { ...descriptor, file }, `Werkzeug ${id}`);
      const cached = inventoryEntry(inventory, cacheFile, `Werkzeug ${id}`);
      invariant(cached.bytes === proof.bytes && cached.sha256 === proof.sha256, `Buildcache-Beleg für Werkzeug ${id} weicht ab.`);
      const effectiveVersion = version === 3
          && id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.id
          && toolVersion === OPERATIONAL_VALIDATOR_BUILD_COMMIT_VERSION
        ? commitBinding.operationalValidatorBuild
        : toolVersion;
      tools.push({ id, kind: "binary", version: effectiveVersion, file, cacheFile, ...proof });
    } else if (descriptor.kind === "runtime-bundle") {
      const manifestFile = portablePath(descriptor.manifestFile, `Werkzeug ${id}.manifestFile`);
      const manifestCacheFile = portablePath(descriptor.manifestCacheFile, `Werkzeug ${id}.manifestCacheFile`);
      invariant(manifestFile.startsWith("tools/tiles/") && manifestFile.endsWith(".manifest.json"), `Werkzeug ${id} besitzt kein versioniertes Runtime-Manifest unter tools/tiles.`);
      const loaded = await loadAndVerifyGdalRuntimeBundle(
        await containedRealPath(root, manifestFile, `Werkzeug ${id}.manifestFile`),
        root,
      );
      invariant(loaded.manifest.version === toolVersion, `Werkzeug ${id} und Runtime-Manifest besitzen verschiedene Versionen.`);
      const manifestCached = inventoryEntry(inventory, manifestCacheFile, `Werkzeug ${id}.manifest`);
      invariant(manifestCached.bytes === loaded.bytes.length && manifestCached.sha256 === loaded.sha256, `Buildcache-Beleg für Runtime-Manifest ${id} weicht ab.`);
      const bundle = gdalRuntimeBundleBinding(loaded.manifest);
      validateGdalRuntimeBundleCacheInventory(bundle, inventory);
      tools.push({
        id,
        kind: "runtime-bundle",
        version: toolVersion,
        manifestFile,
        manifestCacheFile,
        manifestBytes: loaded.bytes.length,
        manifestSha256: loaded.sha256,
        bundle,
      });
    } else {
      throw new Error(`Werkzeug ${id} besitzt eine unbekannte Art.`);
    }
  }
  if (verifiedOperationalPublication !== undefined) {
    const validator = tools.find(({ id }) => id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.id);
    const executionProof = verifiedOperationalPublication.receipt.publisher.executionInventory.validatorExecutable;
    invariant(
      validator?.kind === "binary"
        && validator.version === commitBinding.operationalValidatorBuild
        && validator.file === executionProof.file
        && validator.bytes === executionProof.bytes
        && validator.sha256 === executionProof.sha256,
      "Operational-v2-Publication-Receipt bindet nicht das commitgebundene effektive Validator-Binary der Build-Evidence.",
    );
    const rebuiltValidator = tools.find(({ id }) => id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL.id);
    const rebuiltProof = verifiedOperationalValidatorRebuild?.receipt?.binaries?.rebuilt;
    invariant(
      rebuiltValidator?.kind === "binary"
        && rebuiltValidator.version === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL.version
        && rebuiltValidator.file === rebuiltProof?.file
        && rebuiltValidator.bytes === rebuiltProof.bytes
        && rebuiltValidator.sha256 === rebuiltProof.sha256,
      "Operational-Validator-Rebuild-Receipt bindet nicht das immutable Rebuild-Binary der Build-Evidence.",
    );
  }

  const outputs = [];
  const outputIds = new Set();
  const outputKindsSeen = new Set();
  for (const descriptor of spec.outputs) {
    const id = stableId(descriptor?.id, "Ausgabe-ID");
    invariant(!outputIds.has(id), `Ausgabe ${id} ist doppelt.`);
    outputIds.add(id);
    invariant(outputKinds.includes(descriptor.kind) && !outputKindsSeen.has(descriptor.kind), `Ausgabe ${id} besitzt eine fehlende oder doppelte Art.`);
    outputKindsSeen.add(descriptor.kind);
    const file = portablePath(descriptor.file, `Ausgabe ${id}.file`);
    const installFile = portablePath(descriptor.installFile, `Ausgabe ${id}.installFile`);
    outputs.push({
      id,
      kind: descriptor.kind,
      file,
      installFile,
      ...(await outputProof(root, { ...descriptor, id, file }, spec.releaseId, version, validateOperationalInfrastructure)),
    });
  }
  invariant(outputKinds.every((kind) => outputKindsSeen.has(kind)), "Build-Evidence besitzt kein vollständiges Ergebnisinventar.");
  invariant(new Set(outputs.map(({ installFile }) => installFile)).size === outputs.length, "Ausgaben besitzen doppelte Installationspfade.");
  if (verifiedOperationalPublication !== undefined) {
    validateCurrentAnnualOperationalPublicationBinding({
      releaseId: spec.releaseId,
      publicationReceipt: verifiedOperationalPublication.receipt,
      outputs,
      releaseConfig: currentAnnualReleaseConfig,
    });
  }
  if (firstClassOperationalSidecarsVersion(version)) {
    await validateFirstClassOperationalSidecarFiles(root, inputs, outputs, spec.releaseId);
  }
  if (operationalEvidenceVersion(version)) {
    await bindOperationalOutputsToArtifactInventory(root, inputs, outputs, spec.releaseId, version);
    await bindDeliveryToReleaseWrappers(
      root,
      inputs,
      outputs,
      spec.releaseId,
      version,
      operationalProvenance,
      operationalAuthority,
    );
  }
  const deliveryInventory = await deliveryInventoryFromOutput(root, outputs, spec.releaseId);
  const candidatePackage = operationalEvidenceVersion(version)
    ? await inspectCandidatePackage(root, spec.candidatePackage, inputs, outputs, spec.releaseId)
    : undefined;

  const semanticLayers = await inspectSemanticRegression(root, spec.regressions);
  const readModel = outputs.find(({ kind }) => kind === "read-model");
  const readModelPath = await containedRealPath(root, readModel.file, "ReadModel-Regressionsprüfung");
  inspectReadModelRegression(readModelPath, spec.regressions);

  const candidateInstallPath = portablePath(spec.deployment.candidateInstallPath, "deployment.candidateInstallPath");
  const previousInstallPath = portablePath(spec.deployment.previousInstallPath, "deployment.previousInstallPath");
  invariant(candidateInstallPath.split("/").at(-1) === spec.releaseId, "Kandidatenpfad endet nicht auf der releaseId.");
  invariant(previousInstallPath.split("/").at(-1) === spec.previousReleaseId, "Rollbackpfad endet nicht auf der previousReleaseId.");
  invariant(candidateInstallPath !== previousInstallPath, "Patch- und Vorgängerrelease dürfen keinen Installationspfad teilen.");
  const activationPointer = portablePath(spec.deployment.activationPointer, "deployment.activationPointer");
  const rollbackAttestationPath = portablePath(spec.deployment.rollbackAttestationPath, "deployment.rollbackAttestationPath");
  invariant(
    ![candidateInstallPath, previousInstallPath].some((path) =>
      [activationPointer, rollbackAttestationPath].some((externalPath) => externalPath === path || externalPath.startsWith(`${path}/`))),
    "Aktivierungszeiger und Rollback-Attestation dürfen nicht in einem unveränderlichen Releaseverzeichnis liegen.",
  );
  invariant(rollbackAttestationPath !== activationPointer, "Aktivierungszeiger und Rollback-Attestation brauchen getrennte Pfade.");
  const objectKey = portablePath(spec.buildCache.objectKey, "buildCache.objectKey");
  invariant(objectKey.includes(spec.releaseId), "Buildcache-Objektschlüssel ist nicht an den Patchrelease gebunden.");
  const cacheEncryptionScheme = encryptionScheme(spec.buildCache.encryptionScheme);

  return {
    schema: evidenceSchemaForVersion(version),
    releaseId: spec.releaseId,
    previousReleaseId: spec.previousReleaseId,
    commits: commitBinding,
    buildContract: { file: normalizedSpecFile, bytes: specBytes.length, sha256: sha256Bytes(specBytes) },
    inputs: inputs.sort((left, right) => left.id.localeCompare(right.id, "en")),
    tools: tools.sort((left, right) => left.id.localeCompare(right.id, "en")),
    outputs: outputs.sort((left, right) => left.id.localeCompare(right.id, "en")),
    ...(candidatePackage === undefined ? {} : { candidatePackage }),
    deliveryInventory,
    ...(operationalProvenance === undefined ? {} : {
      operationalAuthority: structuredClone(operationalAuthority),
      operationalProvenance: structuredClone(operationalProvenance),
      operationalProvenanceSha256: germanyOperationalProvenanceSha256(operationalProvenance),
    }),
    regressions: {
      forbiddenPublicTokens: [...spec.regressions.forbiddenPublicTokens].sort(),
      requiredEboSignalFeatureIds: [...spec.regressions.requiredEboSignalFeatureIds].sort(),
      semanticLayers,
      readModelOutputId: readModel.id,
    },
    buildCache: {
      inventoryInputId: inventoryInput.id,
      inventory,
      objectKey,
      encrypted: true,
      encryptionScheme: cacheEncryptionScheme,
      backupRequired: true,
      restoreVerification: "empty-path-full-inventory",
    },
    deployment: {
      candidateInstallPath,
      previousInstallPath,
      activationPointer,
      rollbackAttestationPath,
      activationMode: "atomic-config-swap",
      retainPreviousForRollback: true,
    },
  };
}

function evidenceSpecForValidation(evidence) {
  return {
    schema: specSchemaForEvidence(evidence),
    releaseId: evidence?.releaseId,
    previousReleaseId: evidence?.previousReleaseId,
    commits: evidence?.commits,
    inputs: evidence?.inputs,
    tools: evidence?.tools,
    outputs: evidence?.outputs,
    candidatePackage: evidence?.candidatePackage,
    regressions: evidence?.regressions,
    buildCache: evidence?.buildCache,
    deployment: evidence?.deployment,
  };
}

export function validateMapReleaseBuildEvidence(evidence) {
  const version = evidenceVersion(evidence?.schema);
  const { outputKinds } = validateSpecBasics(evidenceSpecForValidation(evidence), { resolvedCommits: true });
  portablePath(evidence.buildContract?.file, "buildContract.file");
  invariant(evidence.buildContract.file.startsWith("tools/tiles/") && evidence.buildContract.file.endsWith(".spec.json"), "Build-Evidence-Spezifikation muss versioniert unter tools/tiles eingecheckt sein.");
  invariant(Number.isSafeInteger(evidence.buildContract.bytes) && evidence.buildContract.bytes > 0 && SHA256.test(evidence.buildContract.sha256), "Buildvertrag besitzt keinen Byte-SHA-Beleg.");
  const inputIds = new Set();
  for (const entry of evidence.inputs) {
    stableId(entry.id, "Eingabe-ID");
    invariant(!inputIds.has(entry.id), `Eingabe ${entry.id} ist doppelt.`);
    inputIds.add(entry.id);
    invariant(INPUT_KINDS.has(entry.kind), `Eingabe ${entry.id} besitzt eine unbekannte Art.`);
    pinnedVersion(entry.version, `Eingabe ${entry.id}`);
    portablePath(entry.file, `Eingabe ${entry.id}.file`);
    if (["specification", "repo-contract"].includes(entry.kind)) invariant(entry.file.startsWith("tools/"), `Repositoryvertrag ${entry.id} muss im belegten Repository-Commit liegen.`);
    if (entry.cacheFile !== undefined) portablePath(entry.cacheFile, `Eingabe ${entry.id}.cacheFile`);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `Eingabe ${entry.id} besitzt keinen Byte-SHA-Beleg.`);
  }
  for (const kind of REQUIRED_INPUT_KINDS) invariant(evidence.inputs.some((entry) => entry.kind === kind), `Build-Evidence benötigt eine Eingabe vom Typ ${kind}.`);
  invariant(evidence.inputs.filter(({ kind }) => kind === "build-cache-inventory").length === 1, "Build-Evidence braucht genau ein Buildcache-Inventar.");
  const toolIds = new Set();
  for (const tool of evidence.tools) {
    stableId(tool.id, "Werkzeug-ID");
    invariant(!toolIds.has(tool.id), `Werkzeug ${tool.id} ist doppelt.`);
    toolIds.add(tool.id);
    pinnedVersion(tool.version, `Werkzeug ${tool.id}`);
    if (tool.kind === "oci-image") validateOciTool(tool);
    else if (tool.kind === "binary") {
      portablePath(tool.file, `Werkzeug ${tool.id}.file`);
      portablePath(tool.cacheFile, `Werkzeug ${tool.id}.cacheFile`);
      invariant(Number.isSafeInteger(tool.bytes) && tool.bytes > 0 && SHA256.test(tool.sha256), `Werkzeug ${tool.id} besitzt keinen Byte-SHA-Beleg.`);
    } else if (tool.kind === "runtime-bundle") {
      exactObjectKeys(tool, ["id", "kind", "version", "manifestFile", "manifestCacheFile", "manifestBytes", "manifestSha256", "bundle"], `Werkzeug ${tool.id}`);
      portablePath(tool.manifestFile, `Werkzeug ${tool.id}.manifestFile`);
      portablePath(tool.manifestCacheFile, `Werkzeug ${tool.id}.manifestCacheFile`);
      invariant(Number.isSafeInteger(tool.manifestBytes) && tool.manifestBytes > 0 && SHA256.test(tool.manifestSha256), `Werkzeug ${tool.id} besitzt keinen Runtime-Manifest-Byte-SHA-Beleg.`);
      const bundle = validateGdalRuntimeBundleBinding(tool.bundle);
      invariant(bundle.version === tool.version, `Werkzeug ${tool.id} und Runtime-Bindung besitzen verschiedene Versionen.`);
    } else throw new Error(`Werkzeug ${tool.id} besitzt eine unbekannte Art.`);
  }

  const outputIds = new Set();
  const outputKindsSeen = new Set();
  for (const entry of evidence.outputs) {
    stableId(entry.id, "Ausgabe-ID");
    invariant(!outputIds.has(entry.id), `Ausgabe ${entry.id} ist doppelt.`);
    outputIds.add(entry.id);
    invariant(outputKinds.includes(entry.kind) && !outputKindsSeen.has(entry.kind), `Ausgabe ${entry.id} besitzt eine fehlende oder doppelte Art.`);
    outputKindsSeen.add(entry.kind);
    portablePath(entry.file, `Ausgabe ${entry.id}.file`);
    portablePath(entry.installFile, `Ausgabe ${entry.id}.installFile`);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `Ausgabe ${entry.id} besitzt keinen Byte-SHA-Beleg.`);
    if (entry.kind === "operational-infrastructure-v2") {
      invariant(entry.installFile === "operational-infrastructure-v2.json", `Ausgabe ${entry.id} besitzt den falschen Operational-v2-Installationspfad.`);
      invariant(entry.infraReleaseId === evidence.releaseId && SHA256.test(entry.stateHash) && entry.stateHash !== entry.sha256, `Ausgabe ${entry.id} besitzt keine releasegebundene Operational-v2-Zustandsbindung.`);
    }
    if (entry.kind === "movement-route-templates-v2") {
      invariant(
        entry.infraReleaseId === evidence.releaseId
          && SHA256.test(entry.operationalStateHash)
          && SHA256.test(entry.timetableTransferSetSha256)
          && SHA256.test(entry.stateHash),
        `Ausgabe ${entry.id} besitzt keine releasegebundene Movement-Route-Templates-v2-Zustandsbindung.`,
      );
    }
    if (entry.kind === "timetable-transfer-demands-v2") {
      invariant(
        entry.infraReleaseId === evidence.releaseId
          && SHA256.test(entry.dailyPlanSha256)
          && SHA256.test(entry.transferSetSha256),
        `Ausgabe ${entry.id} besitzt keine releasegebundene Timetable-Transfer-Demands-v2-Hashbindung.`,
      );
    }
  }
  invariant(outputKinds.every((kind) => outputKindsSeen.has(kind)), "Build-Evidence besitzt kein vollständiges Ergebnisinventar.");
  if (firstClassOperationalSidecarsVersion(version)) bindFirstClassOperationalSidecars(evidence.outputs, evidence.releaseId);
  if (operationalEvidenceVersion(version)) {
    invariant(evidence.inputs.some(({ id, kind }) => id === "infra-release-artifact-inventory" && kind === "derived-input"), "Operational-v2-Evidence besitzt kein typisiertes InfraRelease-Artefaktinventar.");
    invariant(evidence.inputs.some(({ id, kind }) => id === "infra-release-wrapper" && kind === "derived-input"), "Operational-v2-Evidence besitzt keine InfraRelease-Hülle.");
    invariant(evidence.inputs.some(({ id, kind }) => id === "map-release-wrapper" && kind === "derived-input"), "Operational-v2-Evidence besitzt keine Kartenrelease-Hülle.");
    invariant(evidence.inputs.some(({ id, kind }) => id === "delivery-sources" && kind === "derived-input"), "Operational-v2-Evidence besitzt keinen Delivery-Quellenvertrag.");
  }
  if (version === 3 && evidence.releaseId === CURRENT_ANNUAL_V3_RELEASE_ID) {
    const provenance = validateGermanyOperationalProvenance(evidence.operationalProvenance);
    invariant(
      provenance.producerKind === GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND
        && provenance.releaseEvidenceEligible === true
        && provenance.productionActivationEligible === true
        && evidence.operationalProvenanceSha256 === germanyOperationalProvenanceSha256(provenance),
      "Aktuelles Build-Evidence-v3 besitzt keine integrierte, aktivierungsgeeignete Operational-v2-Provenienzbindung.",
    );
    validateCurrentAnnualOperationalAuthority(evidence.operationalAuthority, evidence.inputs, evidence.commits.mapBuild);
  }
  invariant(new Set(evidence.outputs.map(({ installFile }) => installFile)).size === evidence.outputs.length, "Ausgaben besitzen doppelte Installationspfade.");
  const deliveryInventory = normalizeDeliveryInventory({
    schema: deliverySchemaForVersion(version),
    releaseId: evidence.releaseId,
    artifacts: evidence.deliveryInventory,
  }, evidence.releaseId, { requireSignedContract: false });
  invariant(JSON.stringify(sortedValue(deliveryInventory)) === JSON.stringify(sortedValue(evidence.deliveryInventory)), "Delivery-Manifestinventar ist nicht kanonisch nach ID geordnet.");
  bindOutputsToDeliveryInventory(evidence.outputs, deliveryInventory);

  const inventory = validateCacheInventory({ schema: CACHE_INVENTORY_SCHEMA, releaseId: evidence.releaseId, files: evidence.buildCache.inventory }, evidence.releaseId);
  const inventoryInput = evidence.inputs.find(({ id }) => id === evidence.buildCache.inventoryInputId);
  invariant(inventoryInput?.kind === "build-cache-inventory", "buildCache.inventoryInputId verweist nicht auf das Buildcache-Inventar.");
  for (const input of evidence.inputs.filter(({ kind }) => ["source-archive", "capture-manifest", "derived-input"].includes(kind))) {
    invariant(input.cacheFile !== undefined, `Eingabe ${input.id} besitzt keinen cacheFile-Pfad.`);
    const cached = inventoryEntry(inventory, input.cacheFile, `Eingabe ${input.id}`);
    invariant(cached.bytes === input.bytes && cached.sha256 === input.sha256, `Buildcache-Beleg für ${input.id} weicht ab.`);
  }
  for (const tool of evidence.tools.filter(({ kind }) => kind === "binary")) {
    const cached = inventoryEntry(inventory, tool.cacheFile, `Werkzeug ${tool.id}`);
    invariant(cached.bytes === tool.bytes && cached.sha256 === tool.sha256, `Buildcache-Beleg für Werkzeug ${tool.id} weicht ab.`);
  }
  for (const tool of evidence.tools.filter(({ kind }) => kind === "runtime-bundle")) {
    const manifest = inventoryEntry(inventory, tool.manifestCacheFile, `Werkzeug ${tool.id}.manifest`);
    invariant(manifest.bytes === tool.manifestBytes && manifest.sha256 === tool.manifestSha256, `Buildcache-Beleg für Runtime-Manifest ${tool.id} weicht ab.`);
    validateGdalRuntimeBundleCacheInventory(tool.bundle, inventory);
  }
  portablePath(evidence.buildCache.objectKey, "buildCache.objectKey");
  invariant(evidence.buildCache.objectKey.includes(evidence.releaseId), "Buildcache-Objektschlüssel ist nicht releasegebunden.");
  encryptionScheme(evidence.buildCache.encryptionScheme);

  invariant(Array.isArray(evidence.regressions?.semanticLayers) && evidence.regressions.semanticLayers.length === SEMANTIC_LAYERS.length, "Regressionsbeleg enthält nicht alle zehn Semantiklayer.");
  invariant(JSON.stringify(evidence.regressions.semanticLayers.map(({ layer }) => layer)) === JSON.stringify(SEMANTIC_LAYERS), "Regressionslayer stehen nicht in kanonischer Reihenfolge.");
  for (const layer of evidence.regressions.semanticLayers) {
    portablePath(layer.file, `Regressionslayer ${layer.layer}.file`);
    invariant(Number.isSafeInteger(layer.features) && layer.features > 0 && Number.isSafeInteger(layer.bytes) && layer.bytes > 0 && SHA256.test(layer.sha256), `Regressionslayer ${layer.layer} besitzt keinen vollständigen Beleg.`);
  }
  invariant(evidence.regressions.forbiddenPublicTokens?.includes("12472736971"), "Bekannter BOStrab-Knoten fehlt im Regressionsbeleg.");
  invariant(Array.isArray(evidence.regressions.requiredEboSignalFeatureIds) && evidence.regressions.requiredEboSignalFeatureIds.length > 0, "Positiver EBO-Signalbeleg fehlt.");
  const readModel = evidence.outputs.find(({ id }) => id === evidence.regressions.readModelOutputId);
  invariant(readModel?.kind === "read-model", "ReadModel-Regressionsbeleg verweist auf eine falsche Ausgabe.");

  const candidateInstallPath = portablePath(evidence.deployment.candidateInstallPath, "deployment.candidateInstallPath");
  const previousInstallPath = portablePath(evidence.deployment.previousInstallPath, "deployment.previousInstallPath");
  invariant(candidateInstallPath.split("/").at(-1) === evidence.releaseId && previousInstallPath.split("/").at(-1) === evidence.previousReleaseId && candidateInstallPath !== previousInstallPath, "Deploymentpfade verletzen die unveränderliche Patch-/Rollbackbindung.");
  const activationPointer = portablePath(evidence.deployment.activationPointer, "deployment.activationPointer");
  const rollbackAttestationPath = portablePath(evidence.deployment.rollbackAttestationPath, "deployment.rollbackAttestationPath");
  invariant(
    ![candidateInstallPath, previousInstallPath].some((path) =>
      [activationPointer, rollbackAttestationPath].some((externalPath) => externalPath === path || externalPath.startsWith(`${path}/`))),
    "Aktivierungszeiger und Rollback-Attestation dürfen nicht in einem unveränderlichen Releaseverzeichnis liegen.",
  );
  invariant(rollbackAttestationPath !== activationPointer, "Aktivierungszeiger und Rollback-Attestation brauchen getrennte Pfade.");
  return evidence;
}

export async function verifyMapReleaseBuildEvidence(
  evidence,
  artifactRoot,
  {
    validateOperationalInfrastructure = validateOperationalInfrastructureV2Native,
    attestationVerifier = verifyGithubAttestationSubject,
  } = {},
) {
  validateMapReleaseBuildEvidence(evidence);
  const version = evidenceVersion(evidence.schema);
  const root = resolve(artifactRoot);
  const contract = await fileProof(root, { file: evidence.buildContract.file }, "Buildvertrag");
  invariant(contract.bytes === evidence.buildContract.bytes && contract.sha256 === evidence.buildContract.sha256, "Buildvertrag weicht vom Evidence-Manifest ab.");
  for (const input of evidence.inputs) {
    const proof = await fileProof(root, { file: input.file }, `Eingabe ${input.id}`);
    invariant(proof.bytes === input.bytes && proof.sha256 === input.sha256, `Eingabe ${input.id} weicht vom Evidence-Manifest ab.`);
    if (operationalEvidenceVersion(version) && input.kind === "specification") {
      await validateSpecificationContentReleaseBinding(root, input, `Eingabe ${input.id}`);
    }
  }
  for (const tool of evidence.tools.filter(({ kind }) => kind === "binary")) {
    const proof = await fileProof(root, { file: tool.file }, `Werkzeug ${tool.id}`);
    invariant(proof.bytes === tool.bytes && proof.sha256 === tool.sha256, `Werkzeug ${tool.id} weicht vom Evidence-Manifest ab.`);
  }
  for (const tool of evidence.tools.filter(({ kind }) => kind === "runtime-bundle")) {
    const loaded = await loadAndVerifyGdalRuntimeBundle(
      await containedRealPath(root, tool.manifestFile, `Werkzeug ${tool.id}.manifestFile`),
      root,
    );
    invariant(loaded.bytes.length === tool.manifestBytes && loaded.sha256 === tool.manifestSha256, `Runtime-Manifest ${tool.id} weicht vom Evidence-Manifest ab.`);
    invariant(
      JSON.stringify(sortedValue(gdalRuntimeBundleBinding(loaded.manifest))) === JSON.stringify(sortedValue(tool.bundle)),
      `Runtime-Manifest ${tool.id} weicht von der Evidence-Runtime-Bindung ab.`,
    );
  }
  const inventory = validateCacheInventory({
    schema: CACHE_INVENTORY_SCHEMA,
    releaseId: evidence.releaseId,
    files: evidence.buildCache.inventory,
  }, evidence.releaseId);
  const currentAnnualCacheMappings = await validateCurrentAnnualBuildCachePlanBinding(
    root,
    evidence.inputs,
    inventory,
    evidence.releaseId,
  );
  if (version === 3 && evidence.releaseId === CURRENT_ANNUAL_V3_RELEASE_ID) {
    const nativeReceiptInput = evidence.inputs.find(({ id }) => id === "operational-native-receipt");
    const rebuildSpecInput = evidence.inputs.find(({ id }) => id === "operational-validator-rebuild-spec");
    const rebuildReceiptInput = evidence.inputs.find(({ id }) => id === "operational-validator-rebuild-evidence");
    const publicationReceiptInput = evidence.inputs.find(({ id }) => id === "operational-publication-receipt");
    invariant(nativeReceiptInput !== undefined && rebuildSpecInput !== undefined && rebuildReceiptInput !== undefined && publicationReceiptInput !== undefined,
      "Build-Evidence-v3 fehlen typisierte Operational-/Validator-Rebuild-Receipts.");
    const rebuildSpec = JSON.parse(await readFile(
      await containedRealPath(root, rebuildSpecInput.file, "Operational-Validator-Rebuild-Spezifikation"),
      "utf8",
    ));
    const verifiedRebuild = await verifyOperationalValidatorRebuildEvidence({
      spec: rebuildSpec,
      receiptPath: await containedRealPath(root, rebuildReceiptInput.file, "Operational-Validator-Rebuild-Receipt"),
      workspaceRoot: root,
    });
    validateCurrentAnnualValidatorRebuildCacheArtifacts({
      mappings: currentAnnualCacheMappings,
      inventory,
      rebuildSpec,
      rebuildReceipt: verifiedRebuild.receipt,
      rebuildReceiptInput,
    });
    invariant(verifiedRebuild.proof.bytes === rebuildReceiptInput.bytes && verifiedRebuild.proof.sha256 === rebuildReceiptInput.sha256,
      "Operational-Validator-Rebuild-Receipt weicht vom Evidence-Manifest ab.");
    invariant(
      verifiedRebuild.receipt.specification.file === rebuildSpecInput.file
        && verifiedRebuild.receipt.specification.bytes === rebuildSpecInput.bytes
        && verifiedRebuild.receipt.specification.sha256 === rebuildSpecInput.sha256,
      "Operational-Validator-Rebuild-Receipt bindet nicht den Evidence-Rebuild-Vertrag.",
    );
    invariant(
      verifiedRebuild.receipt.releaseId === evidence.releaseId
        && verifiedRebuild.receipt.source.materialization.commit === evidence.commits.operationalValidatorBuild,
      "Operational-Validator-Rebuild-Receipt wurde als falscher Release- oder Build-Commit umetikettiert.",
    );
    for (const [producerId, inputId] of Object.entries(CURRENT_ANNUAL_V3_OPERATIONAL_REBUILD_PRODUCER_INPUTS)) {
      const input = evidence.inputs.find(({ id }) => id === inputId);
      const producerProof = verifiedRebuild.receipt.producer[producerId];
      invariant(input?.file === producerProof.file
        && input.bytes === producerProof.bytes
        && input.sha256 === producerProof.sha256,
      `Operational-Validator-Rebuild-Produzent ${producerId} driftet vom Evidence-Manifest.`);
    }
    const verifiedPublication = await verifyGermanyOperationalInfrastructureV2PublicationReceipt({
      workspaceRoot: root,
      publicationReceiptPath: await containedRealPath(root, publicationReceiptInput.file, "Operational-v2-Publication-Receipt"),
      expectedReleaseId: evidence.releaseId,
    });
    invariant(verifiedPublication.proof.bytes === publicationReceiptInput.bytes && verifiedPublication.proof.sha256 === publicationReceiptInput.sha256,
      "Operational-v2-Publication-Receipt weicht vom Evidence-Manifest ab.");
    const verifiedProvenance = validateGermanyOperationalProvenance(verifiedPublication.receipt.operationalProvenance);
    invariant(
      germanyOperationalProvenanceSha256(verifiedProvenance) === evidence.operationalProvenanceSha256
        && JSON.stringify(sortedValue(verifiedProvenance)) === JSON.stringify(sortedValue(evidence.operationalProvenance)),
      "Operational-v2-Publication-Receipt und Build-Evidence-v3 binden nicht dieselbe integrierte Ausfuehrungsprovenienz.",
    );
    invariant(
      verifiedPublication.receipt.nativeReceipt.file === nativeReceiptInput.file
        && verifiedPublication.receipt.nativeReceipt.bytes === nativeReceiptInput.bytes
        && verifiedPublication.receipt.nativeReceipt.sha256 === nativeReceiptInput.sha256,
      "Operational-v2-Publication-Receipt bindet nicht das Evidence-Native-Receipt.",
    );
    invariant(
      verifiedPublication.receipt.publisher.entrypoint === "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
      "Operational-v2-Publication-Receipt bindet nicht den festgelegten RecoveryPublisher.",
    );
    const publicationRebuild = verifiedPublication.receipt.validatorRebuild;
    invariant(publicationRebuild.evidence.file === rebuildReceiptInput.file
      && publicationRebuild.evidence.bytes === rebuildReceiptInput.bytes
      && publicationRebuild.evidence.sha256 === rebuildReceiptInput.sha256
      && publicationRebuild.specification.file === rebuildSpecInput.file
      && publicationRebuild.specification.bytes === rebuildSpecInput.bytes
      && publicationRebuild.specification.sha256 === rebuildSpecInput.sha256
      && publicationRebuild.sourceCommit === verifiedRebuild.receipt.source.materialization.commit
      && publicationRebuild.normalizedPeSha256 === verifiedRebuild.receipt.pe.normalized.expectedSha256
      && JSON.stringify(publicationRebuild.preserved) === JSON.stringify(verifiedRebuild.receipt.binaries.preserved)
      && JSON.stringify(publicationRebuild.rebuilt) === JSON.stringify(verifiedRebuild.receipt.binaries.rebuilt),
    "Operational-v2-Publication-Receipt bindet nicht die verifizierte Rebuild-Evidence des Evidence-Manifests.");
    const releaseConfigInput = evidence.inputs.find(({ id }) => id === "germany-release-spec");
    invariant(releaseConfigInput?.kind === "specification", "Build-Evidence-v3 fehlt die typisierte Deutschland-Jahresrelease-Konfiguration.");
    const releaseConfig = JSON.parse(await readFile(
      await containedRealPath(root, releaseConfigInput.file, "Deutschland-Jahresrelease-Konfiguration"),
      "utf8",
    ));
    validateCurrentAnnualOperationalPublicationBinding({
      releaseId: evidence.releaseId,
      publicationReceipt: verifiedPublication.receipt,
      outputs: evidence.outputs,
      releaseConfig,
    });
    const recoveryPublisher = releaseConfig.pipeline?.operationalDeriver?.recoveryPublisher;
    invariant(
      recoveryPublisher?.validatorBuildCommit === evidence.commits.operationalValidatorBuild
        && recoveryPublisher.validatorBuildCommit === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_BUILD_COMMIT,
      "Deutschland-Jahresrelease und Evidence binden nicht denselben Operational-v2-Validator-Build-Commit.",
    );
    const validatorExecution = verifiedPublication.receipt.publisher.executionInventory.validatorExecutable;
    invariant(
      recoveryPublisher.validatorExecutable === validatorExecution.file
        && recoveryPublisher.validatorBytes === validatorExecution.bytes
        && recoveryPublisher.validatorSha256 === validatorExecution.sha256,
      "Deutschland-Jahresrelease bindet nicht den vom Capture belegten Operational-v2-Validator.",
    );
    invariant(
      recoveryPublisher.validatorRebuildSpecification === rebuildSpecInput.file
        && recoveryPublisher.validatorRebuildEvidence === rebuildReceiptInput.file
        && recoveryPublisher.validatorRebuildExecutable === verifiedRebuild.receipt.binaries.rebuilt.file
        && recoveryPublisher.validatorRebuildExpectedBytes === verifiedRebuild.receipt.binaries.rebuilt.bytes
        && recoveryPublisher.validatorNormalizedPeSha256 === verifiedRebuild.receipt.pe.normalized.expectedSha256,
      "Deutschland-Jahresrelease bindet nicht den vollstaendig verifizierten Operational-Validator-Rebuild-Beleg.",
    );
    invariant(isRecord(recoveryPublisher.executionInventory), "Deutschland-Jahresrelease besitzt kein Operational-v2-Ausfuehrungsinventar.");
    for (const [inventoryId, executionProof] of Object.entries(verifiedPublication.receipt.publisher.executionInventory)) {
      if (inventoryId === "validatorExecutable") continue;
      invariant(
        recoveryPublisher.executionInventory[inventoryId] === executionProof.file,
        `Deutschland-Jahresrelease bindet nicht Operational-v2-Ausfuehrungsinventar ${inventoryId}.`,
      );
    }
    for (const [inventoryId, inputId] of Object.entries(CURRENT_ANNUAL_V3_OPERATIONAL_EXECUTION_INPUTS)) {
      const input = evidence.inputs.find(({ id }) => id === inputId);
      const executionProof = verifiedPublication.receipt.publisher.executionInventory[inventoryId];
      invariant(
        input?.kind === "repo-contract"
          && input.file === executionProof.file
          && input.bytes === executionProof.bytes
          && input.sha256 === executionProof.sha256,
        `Operational-v2-Ausfuehrungsinventar ${inventoryId} driftet vom Evidence-Repositoryvertrag ${inputId}.`,
      );
    }
    const captureInput = evidence.inputs.find(({ id }) => id === "operational-native-receipt-capture");
    const captureEntrypoint = verifiedPublication.captureReceipt.producer.captureEntrypoint;
    invariant(
      captureInput?.kind === "repo-contract"
        && captureInput.file === captureEntrypoint.file
        && captureInput.bytes === captureEntrypoint.bytes
        && captureInput.sha256 === captureEntrypoint.sha256,
      "Native-Receipt-Capture-Entrypoint driftet vom Evidence-Repositoryvertrag.",
    );
    const preservedTool = evidence.tools.find(({ id }) => id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_TOOL.id);
    const rebuiltTool = evidence.tools.find(({ id }) => id === CURRENT_ANNUAL_V3_OPERATIONAL_VALIDATOR_REBUILD_TOOL.id);
    invariant(preservedTool?.file === verifiedRebuild.receipt.binaries.preserved.file
      && preservedTool.bytes === verifiedRebuild.receipt.binaries.preserved.bytes
      && preservedTool.sha256 === verifiedRebuild.receipt.binaries.preserved.sha256,
    "Evidence-Manifest bindet nicht das preserved Validator-Binary des Rebuild-Receipts.");
    invariant(rebuiltTool?.file === verifiedRebuild.receipt.binaries.rebuilt.file
      && rebuiltTool.bytes === verifiedRebuild.receipt.binaries.rebuilt.bytes
      && rebuiltTool.sha256 === verifiedRebuild.receipt.binaries.rebuilt.sha256,
    "Evidence-Manifest bindet nicht das rebuilt Validator-Binary des Rebuild-Receipts.");
    await verifyCurrentAnnualOperationalAuthorityLocal({
      artifactRoot: root,
      inputs: evidence.inputs,
      releaseConfig,
      rebuildSpec,
      outerExecution: verifiedPublication.outerExecution,
      releaseId: evidence.releaseId,
      mapBuildCommit: evidence.commits.mapBuild,
      authority: evidence.operationalAuthority,
      attestationVerifier,
    });
  }
  for (const output of evidence.outputs) {
    const proof = await outputProof(
      root,
      { ...output, expectedBytes: undefined, expectedSha256: undefined },
      evidence.releaseId,
      version,
      validateOperationalInfrastructure,
    );
    invariant(proof.bytes === output.bytes && proof.sha256 === output.sha256, `Ausgabe ${output.id} weicht vom Evidence-Manifest ab.`);
    if (output.kind === "operational-infrastructure-v2") {
      invariant(proof.infraReleaseId === output.infraReleaseId && proof.stateHash === output.stateHash, `Ausgabe ${output.id} weicht von ihrer Operational-v2-Zustandsbindung ab.`);
    }
    if (output.kind === "movement-route-templates-v2") {
      invariant(
        proof.infraReleaseId === output.infraReleaseId
          && proof.operationalStateHash === output.operationalStateHash
          && proof.timetableTransferSetSha256 === output.timetableTransferSetSha256
          && proof.stateHash === output.stateHash,
        `Ausgabe ${output.id} weicht von ihrer Movement-Route-Templates-v2-Zustandsbindung ab.`,
      );
    }
    if (output.kind === "timetable-transfer-demands-v2") {
      invariant(
        proof.infraReleaseId === output.infraReleaseId
          && proof.dailyPlanSha256 === output.dailyPlanSha256
          && proof.transferSetSha256 === output.transferSetSha256,
        `Ausgabe ${output.id} weicht von ihrer Timetable-Transfer-Demands-v2-Hashbindung ab.`,
      );
    }
  }
  if (firstClassOperationalSidecarsVersion(version)) {
    await validateFirstClassOperationalSidecarFiles(root, evidence.inputs, evidence.outputs, evidence.releaseId);
  }
  if (operationalEvidenceVersion(version)) {
    await bindOperationalOutputsToArtifactInventory(root, evidence.inputs, evidence.outputs, evidence.releaseId, version);
    await bindDeliveryToReleaseWrappers(
      root,
      evidence.inputs,
      evidence.outputs,
      evidence.releaseId,
      version,
      evidence.operationalProvenance,
      evidence.operationalAuthority,
    );
  }
  const deliveryInventory = await deliveryInventoryFromOutput(root, evidence.outputs, evidence.releaseId);
  invariant(JSON.stringify(sortedValue(deliveryInventory)) === JSON.stringify(sortedValue(evidence.deliveryInventory)), "Delivery-Manifestinventar weicht vom Evidence-Manifest ab.");
  if (operationalEvidenceVersion(version)) {
    const contract = JSON.parse(await readFile(await containedRealPath(root, evidence.buildContract.file, "Buildvertrag"), "utf8"));
    const candidatePackage = await inspectCandidatePackage(root, contract.candidatePackage, evidence.inputs, evidence.outputs, evidence.releaseId);
    invariant(
      JSON.stringify(sortedValue(candidatePackage)) === JSON.stringify(sortedValue(evidence.candidatePackage)),
      "Signed-Paketkandidat weicht vom Evidence-Manifest ab.",
    );
  }
  const regression = {
    semanticLayers: evidence.regressions.semanticLayers.map(({ layer, file }) => ({ layer, file })),
    forbiddenPublicTokens: evidence.regressions.forbiddenPublicTokens,
    requiredEboSignalFeatureIds: evidence.regressions.requiredEboSignalFeatureIds,
  };
  const semanticLayers = await inspectSemanticRegression(root, regression);
  for (const layer of semanticLayers) {
    const expected = evidence.regressions.semanticLayers.find(({ layer: name }) => name === layer.layer);
    invariant(layer.bytes === expected.bytes && layer.sha256 === expected.sha256 && layer.features === expected.features, `Regressionslayer ${layer.layer} weicht vom Evidence-Manifest ab.`);
  }
  const readModel = evidence.outputs.find(({ id }) => id === evidence.regressions.readModelOutputId);
  invariant(readModel?.kind === "read-model", "ReadModel-Regressionsbeleg verweist auf eine falsche Ausgabe.");
  inspectReadModelRegression(await containedRealPath(root, readModel.file, "ReadModel-Regressionsprüfung"), regression);
  return {
    releaseId: evidence.releaseId,
    evidenceSha256: sha256Bytes(serializeMapReleaseBuildEvidence(evidence)),
    inputs: evidence.inputs.length,
    tools: evidence.tools.length,
    outputs: evidence.outputs.length,
    deliveryArtifacts: evidence.deliveryInventory.length,
    semanticLayers: semanticLayers.length,
  };
}

async function writeAtomicCreateNew(path, bytes, label) {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.building`;
  let ownsTemporary = false;
  try {
    const handle = await open(temporary, "wx");
    ownsTemporary = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, output);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`${label} existiert bereits; create-new verweigert jede Überschreibung.`);
      throw error;
    }
    return { path: output, status: "written" };
  } finally {
    if (ownsTemporary) await rm(temporary, { force: true });
  }
}

export async function writeMapReleaseBuildEvidence(evidence, outputPath) {
  validateMapReleaseBuildEvidence(evidence);
  const bytes = serializeMapReleaseBuildEvidence(evidence);
  return { ...(await writeAtomicCreateNew(outputPath, bytes, "Build-Evidence-Manifest")), bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

export async function prepareEmptyBuildCacheRestore(restoreRoot) {
  const root = resolve(restoreRoot);
  try {
    await lstat(root);
    throw new Error(`Restore-Ziel muss vor der Vorbereitung fehlen: ${root}.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { recursive: false });
  const marker = { schema: RESTORE_MARKER_SCHEMA, nonce: randomUUID() };
  const markerBytes = serializeMapReleaseBuildEvidence(marker);
  const markerPath = resolve(root, RESTORE_MARKER);
  const handle = await open(markerPath, "wx");
  try {
    await handle.writeFile(markerBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { root, markerPath, nonce: marker.nonce, markerSha256: sha256Bytes(markerBytes) };
}

async function inventoryRestoredFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(resolve(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true })) {
    const portable = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (portable === RESTORE_MARKER) continue;
    invariant(!entry.isSymbolicLink(), `Restore enthält den symbolischen Link ${portable}.`);
    if (entry.isDirectory()) result.push(...(await inventoryRestoredFiles(root, portable)));
    else {
      invariant(entry.isFile(), `Restore enthält einen unbekannten Dateityp ${portable}.`);
      const proof = await fileProof(root, { file: portable }, `Restore-Datei ${portable}`);
      result.push({ path: portable, ...proof });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

export async function proveBuildCacheRestore(evidence, restoreRoot) {
  validateMapReleaseBuildEvidence(evidence);
  const root = resolve(restoreRoot);
  const rootMetadata = await lstat(root);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Restore-Ziel ist kein reguläres Verzeichnis.");
  const markerPath = await containedRealPath(root, RESTORE_MARKER, "Restore-Leerpfadmarker");
  const markerMetadata = await lstat(markerPath);
  invariant(markerMetadata.isFile() && !markerMetadata.isSymbolicLink(), "Restore-Leerpfadmarker ist keine reguläre Datei.");
  const markerBytes = await readFile(markerPath);
  const marker = JSON.parse(markerBytes.toString("utf8"));
  invariant(markerBytes.equals(serializeMapReleaseBuildEvidence(marker)), "Restore-Leerpfadmarker ist nicht kanonisch serialisiert.");
  invariant(JSON.stringify(Object.keys(marker).sort()) === JSON.stringify(["nonce", "schema"]), "Restore-Leerpfadmarker besitzt unbekannte Felder.");
  invariant(marker?.schema === RESTORE_MARKER_SCHEMA && typeof marker.nonce === "string" && UUID_V4.test(marker.nonce), "Restore besitzt keinen gültigen Leerpfadmarker.");
  const restored = await inventoryRestoredFiles(root);
  invariant(
    JSON.stringify(sortedValue(restored)) === JSON.stringify(sortedValue(evidence.buildCache.inventory)),
    `Wiederhergestellter Buildcache weicht vom vollständigen Evidence-Inventar ab (ist: ${restored.map(({ path }) => path).join(", ")}; erwartet: ${evidence.buildCache.inventory.map(({ path }) => path).join(", ")}).`,
  );
  for (const tool of evidence.tools.filter(({ kind }) => kind === "runtime-bundle")) {
    const loaded = await loadAndVerifyGdalRuntimeBundle(
      await containedRealPath(root, tool.manifestCacheFile, `Restore-Runtime ${tool.id}.manifest`),
      root,
      { layout: "cache" },
    );
    invariant(loaded.bytes.length === tool.manifestBytes && loaded.sha256 === tool.manifestSha256, `Wiederhergestelltes Runtime-Manifest ${tool.id} weicht von der Evidence ab.`);
    invariant(
      JSON.stringify(sortedValue(gdalRuntimeBundleBinding(loaded.manifest))) === JSON.stringify(sortedValue(tool.bundle)),
      `Wiederhergestellte Runtime ${tool.id} weicht von der Evidence-Bindung ab.`,
    );
  }
  const evidenceSha256 = sha256Bytes(serializeMapReleaseBuildEvidence(evidence));
  const inventorySha256 = sha256Bytes(Buffer.from(`${JSON.stringify(sortedValue(evidence.buildCache.inventory))}\n`, "utf8"));
  const restoreRootSha256 = sha256Bytes(Buffer.from(await realpath(root), "utf8"));
  const emptyRootMarkerSha256 = sha256Bytes(markerBytes);
  const artifactBindingSha256 = sha256Bytes(serializeMapReleaseBuildEvidence({
    emptyRootMarkerSha256,
    evidenceSha256,
    inventorySha256,
    objectKey: evidence.buildCache.objectKey,
    restoreRootSha256,
  }));
  const proof = {
    schema: RESTORE_PROOF_SCHEMA,
    releaseId: evidence.releaseId,
    evidenceSha256,
    objectKey: evidence.buildCache.objectKey,
    encrypted: true,
    encryptionScheme: evidence.buildCache.encryptionScheme,
    restoredToPreparedEmptyPath: true,
    emptyRootNonce: marker.nonce,
    emptyRootMarkerBytes: markerBytes.length,
    emptyRootMarkerSha256,
    restoreRootSha256,
    verification: "full-byte-inventory",
    verifiedFiles: restored.length,
    verifiedBytes: restored.reduce((sum, entry) => sum + entry.bytes, 0),
    inventorySha256,
    artifactBindingSha256,
  };
  return { proof, proofBytes: serializeMapReleaseBuildEvidence(proof) };
}

export async function writeBuildCacheRestoreProof(result, outputPath) {
  return writeAtomicCreateNew(outputPath, result.proofBytes, "Buildcache-Restore-Beleg");
}

function parseCanonicalRestoreProof(bytes) {
  invariant(Buffer.isBuffer(bytes) && bytes.length > 0, "Buildcache-Restore-Beleg muss als unverändertes Datei-Artefakt übergeben werden.");
  let proof;
  try {
    proof = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Buildcache-Restore-Beleg ist kein gültiges JSON-Artefakt.");
  }
  invariant(bytes.equals(serializeMapReleaseBuildEvidence(proof)), "Buildcache-Restore-Beleg ist nicht kanonisch serialisiert.");
  return proof;
}

async function assertDirectory(root, relativePath, label) {
  let path;
  try {
    path = await containedRealPath(root, relativePath, label);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} fehlt.`);
    throw error;
  }
  const metadata = await lstat(path);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} ist kein unveränderliches Releaseverzeichnis.`);
  return path;
}

function releaseVersion(releaseId) {
  const parsed = RELEASE_ID.exec(releaseId);
  invariant(parsed !== null, `${releaseId} ist kein Jahres-Patchrelease.`);
  return `${parsed.groups.year}.${parsed.groups.patch}`;
}

function requiresCreateNewDirectoryCompletion(releaseId) {
  const parsed = RELEASE_ID.exec(releaseId);
  invariant(parsed !== null, `${releaseId} ist kein Jahres-Patchrelease.`);
  const year = Number.parseInt(parsed.groups.year, 10);
  const patch = Number.parseInt(parsed.groups.patch, 10);
  return year > 2026 || (year === 2026 && patch >= 5);
}

async function assertExactInstalledInventory(root, expectedFiles, label) {
  const expected = new Set(expectedFiles);
  const observed = new Set();
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const portable = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      invariant(!entry.isSymbolicLink(), `${label} enthält den symbolischen Link ${portable}.`);
      if (entry.isDirectory()) {
        invariant([...expected].some((path) => path.startsWith(`${portable}/`)), `${label} enthält das unerwartete Verzeichnis ${portable}.`);
        await walk(resolve(directory, entry.name), portable);
      } else {
        invariant(entry.isFile() && expected.has(portable), `${label} enthält die unerwartete Datei ${portable}.`);
        observed.add(portable);
      }
    }
  }
  await walk(root);
  invariant(observed.size === expected.size && [...expected].every((path) => observed.has(path)), `${label} ist gegenüber seinem Paketmanifest unvollständig.`);
}

function installedArtifactInventoryEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    installPath: entry.installPath,
    ...(entry.kind === "operational-infrastructure-v2"
      ? { infraReleaseId: entry.infraReleaseId, stateHash: entry.stateHash }
      : {}),
    bytes: entry.bytes,
    sha256: entry.sha256,
  };
}

async function inspectInstalledMapPackage(deploymentRoot, installPath, releaseId, label) {
  const root = await assertDirectory(deploymentRoot, installPath, label);
  let completion;
  try {
    const metadata = await lstat(join(root, CREATE_NEW_DIRECTORY_COMPLETION_FILE));
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label}-Completion-Marker ist keine regulaere Datei.`);
    completion = await verifyCreateNewDirectoryCompletion(root, { kind: "map-package-installation" });
  } catch (error) {
    if (!(error?.code === "ENOENT")) throw error;
  }
  invariant(
    !requiresCreateNewDirectoryCompletion(releaseId) || completion !== undefined,
    `${label} besitzt keinen create-new-Completion-Marker fuer den aktuellen Jahreslauf.`,
  );
  let markerPath;
  try {
    markerPath = await containedRealPath(root, INSTALLED_PACKAGE_MANIFEST, `${label}-Paketmarker`);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} besitzt keinen ${INSTALLED_PACKAGE_MANIFEST}-Paketmarker.`);
    throw error;
  }
  const markerBytes = await readFile(markerPath);
  invariant(markerBytes.length > 0 && markerBytes.length <= 16 * 1024 * 1024, `${label}-Paketmarker besitzt eine unzulässige Größe.`);
  let manifest;
  try {
    manifest = JSON.parse(markerBytes.toString("utf8"));
  } catch {
    throw new Error(`${label}-Paketmarker ist kein gültiges JSON-Artefakt.`);
  }
  validateMapPackageManifest(manifest);
  invariant(markerBytes.equals(Buffer.from(serializeMapPackageManifest(manifest), "utf8")), `${label}-Paketmarker ist nicht kanonisch serialisiert.`);
  if (completion !== undefined) {
    invariant(completion.completion.bindingSha256 === sha256Bytes(markerBytes), `${label}-Completion-Marker bindet nicht den kanonischen Paketmarker.`);
  }
  invariant(manifest.version === releaseVersion(releaseId), `${label}-Paketmarker gehört nicht zum Release ${releaseId}.`);
  invariant(manifest.runtime?.publicBasePath === `/artifacts/maps/${releaseId}`, `${label}-Paketmarker besitzt eine fremde Releasewurzel.`);
  invariant(manifest.runtime.basemapStyleUrl === `/artifacts/maps/${releaseId}/style.json`, `${label}-Paketmarker besitzt einen fremden Stylepfad.`);
  invariant(manifest.runtime.infrastructurePmtilesUrl === `/artifacts/maps/${releaseId}/${releaseId}.pmtiles`, `${label}-Paketmarker besitzt einen fremden Infrastrukturpfad.`);
  const inventory = [...manifest.artifacts, ...manifest.auxiliaryFiles]
    .map(installedArtifactInventoryEntry)
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  await assertExactInstalledInventory(root, [
    ...(completion === undefined ? [] : [CREATE_NEW_DIRECTORY_COMPLETION_FILE]),
    INSTALLED_PACKAGE_MANIFEST,
    ...inventory.map(({ installPath: file }) => file),
  ], label);
  for (const artifact of inventory) {
    const observed = await fileProof(root, { file: artifact.installPath }, `${label}-Artefakt ${artifact.id}`);
    invariant(observed.bytes === artifact.bytes && observed.sha256 === artifact.sha256, `${label}-Artefakt ${artifact.id} ist beschädigt.`);
  }
  const releaseEntry = inventory.find(({ kind }) => kind === "release-manifest");
  const sourcesEntry = inventory.find(({ kind }) => kind === "source-manifest");
  const qualityEntry = inventory.find(({ kind }) => kind === "quality-manifest");
  invariant(releaseEntry !== undefined && sourcesEntry !== undefined && qualityEntry !== undefined, `${label} besitzt keinen vollständigen Release-/Quellen-/Qualitätsvertrag.`);
  const releaseBytes = await readFile(await containedRealPath(root, releaseEntry.installPath, `${label}-Delivery-Manifest`));
  const sourcesBytes = await readFile(await containedRealPath(root, sourcesEntry.installPath, `${label}-Quellenmanifest`));
  const qualityBytes = await readFile(await containedRealPath(root, qualityEntry.installPath, `${label}-Qualitätsbericht`));
  let release;
  let sources;
  let quality;
  try {
    release = JSON.parse(releaseBytes.toString("utf8"));
    sources = JSON.parse(sourcesBytes.toString("utf8"));
    quality = JSON.parse(qualityBytes.toString("utf8"));
  } catch {
    throw new Error(`${label} besitzt keinen gültigen Release-/Quellen-/Qualitätsvertrag.`);
  }
  invariant(releaseBytes.equals(serializeDeliveryJson(release)) && sourcesBytes.equals(serializeDeliveryJson(sources)), `${label} besitzt keinen kanonischen Release-/Quellenvertrag.`);
  const expectedDeliverySchema = manifest.schema === "zugfolge-map-package/v2"
    ? DELIVERY_SCHEMA_V2
    : DELIVERY_SCHEMA_V1;
  invariant(release?.schema === expectedDeliverySchema && release.releaseId === releaseId, `${label}-Delivery-Manifest gehört nicht zum installierten Paket-/Releasevertrag.`);
  if (manifest.schema === "zugfolge-map-package/v2") {
    invariant(
      sources?.schema === DELIVERY_SOURCES_SCHEMA_V2
        && sources.releaseId === releaseId
        && Array.isArray(sources.sources) && sources.sources.length > 0
        && SHA256.test(sources.assetInventoryPlanSha256)
        && Object.keys(sources).sort().join("\u0000") === ["schema", "releaseId", "sources", "assetInventoryPlanSha256", "assetNotices"].sort().join("\u0000"),
      `${label}-Quellenmanifest gehört nicht zum installierten v2-Release.`,
    );
    const assetNotices = validateMapAssetNotices(sources.assetNotices);
    validateMapAssetNoticeBindings(assetNotices, inventory);
    invariant(
      release.approvalGates?.rights?.sourceManifestSchema === DELIVERY_SOURCES_SCHEMA_V2
        && release.approvalGates.rights.sourceCount === sources.sources.length
        && release.approvalGates.rights.assetGroupCount === assetNotices.assets.length
        && release.approvalGates.rights.assetFileCount === inventory.filter(({ kind }) => ["glyph", "sprite"].includes(kind)).length,
      `${label}-Delivery-Rechtegate bindet seine Asset-Notices nicht vollständig.`,
    );
  } else {
    invariant(sources?.schema === "zugfolge-map-delivery-sources/v1" && sources.releaseId === releaseId, `${label}-Quellenmanifest gehört nicht zum installierten Release.`);
  }
  invariant(release.packageId === manifest.packageId && release.packageVersion === manifest.version, `${label}-Paketmarker ist nicht an seinen Delivery-Vertrag gebunden.`);
  invariant(release.bindings?.packageManifestSchema === manifest.schema, `${label}-Delivery-Manifest bindet ein anderes Paketmanifest-Schema.`);
  invariant(Array.isArray(release.artifacts), `${label}-Delivery-Manifest besitzt kein Artefaktinventar.`);
  const delivered = [...release.artifacts].map(installedArtifactInventoryEntry)
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const packaged = inventory.filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind));
  invariant(JSON.stringify(delivered) === JSON.stringify(packaged), `${label}-Paketmarker weicht vom Delivery-Inventar ab.`);
  invariant(release.bindings?.sourcesSha256 === sourcesEntry.sha256, `${label}-Delivery-Manifest bindet sein Quellenmanifest nicht bytegenau.`);
  invariant(release.bindings?.qualitySha256 === qualityEntry.sha256, `${label}-Delivery-Manifest bindet seinen Qualitätsbericht nicht bytegenau.`);
  if (manifest.schema === "zugfolge-map-package/v2") {
    validateSignedDeliveryContract(release, releaseId, `${label}-Delivery-Manifest`, 2);
    validateOperationalV2Quality(quality, `${label}-Qualitätsbericht`, releaseId);
  }
  return { root, manifest, markerBytes, inventory, release, releaseBytes, sources, sourcesBytes, quality, qualityBytes };
}

async function inspectSignedWorldDeployment(path, trustedKeys) {
  const bytes = await readFile(resolve(path));
  invariant(bytes.length > 0, "Signiertes Weltdeployment ist leer.");
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Signiertes Weltdeployment ist kein gueltiges JSON-Artefakt.");
  }
  const deployment = decodeAlphaValue(envelope?.deployment);
  invariant(deployment?.schema === "zugfolge-alpha-world-deployment/v1", "Weltdeployment besitzt kein freigegebenes V1-Rollback-Schema.");
  invariant(typeof deployment.worldId === "string" && deployment.worldId.length > 0, "Weltdeployment besitzt keine Weltbindung.");
  invariant(typeof deployment.worldDefinition?.epoch === "string", "Weltdeployment besitzt keine Epoch-Bindung.");
  const epoch = new Date(deployment.worldDefinition.epoch);
  invariant(!Number.isNaN(epoch.getTime()) && epoch.toISOString() === deployment.worldDefinition.epoch, "Weltdeployment besitzt keine kanonische Epoch-Bindung.");
  invariant(Number.isSafeInteger(deployment.repeatEveryS) && deployment.repeatEveryS > 0, "Weltdeployment besitzt keine Wiederholungsperiode.");
  const deploymentHash = alphaHash(deployment.schema, deployment);
  invariant(envelope.deploymentHash === deploymentHash, "Weltdeployment-Hash stimmt nicht mit dem signierten Inhalt ueberein.");
  const signature = envelope.signature;
  invariant(signature?.algorithm === "Ed25519" && typeof signature.keyId === "string" && typeof signature.valueBase64 === "string", "Weltdeployment besitzt keine Ed25519-Signaturhuelle.");
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  invariant(signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.valueBase64, "Weltdeployment besitzt keine kanonischen Ed25519-Signaturbytes.");
  if (trustedKeys !== undefined) {
    const publicKey = trustedDeliveryPublicKey(trustedKeys, signature.keyId, "Weltdeployment");
    invariant(
      verifyEd25519(null, Buffer.from(deploymentHash, "hex"), createPublicKey(publicKey), signatureBytes),
      "Weltdeployment besitzt keine gueltige vertrauenswuerdige Ed25519-Signatur.",
    );
  }
  return {
    bytes,
    sha256: sha256Bytes(bytes),
    deploymentHash,
    worldId: deployment.worldId,
    worldEpoch: deployment.worldDefinition.epoch,
    repeatEveryS: deployment.repeatEveryS,
    keyId: signature.keyId,
  };
}

async function inspectInstalledRuntimeTuple(previous, previousReleaseId) {
  const readModelEntry = previous.inventory.find(({ kind }) => kind === "read-model");
  const projectionEntry = previous.inventory.find(({ kind }) => kind === "train-map-projection");
  invariant(readModelEntry !== undefined && projectionEntry !== undefined, "Rollbackrelease besitzt kein vollstaendiges ReadModel-/Projektions-Tuple.");
  const readModelPath = await containedRealPath(previous.root, readModelEntry.installPath, "Rollback-ReadModel");
  const projectionPath = await containedRealPath(previous.root, projectionEntry.installPath, "Rollback-Zugprojektion");
  const [readModel, projection] = await Promise.all([
    inspectPublicReadModel(readModelPath),
    inspectTrainMapProjection(projectionPath),
  ]);
  invariant(readModel.infrastructureReleaseId === previousReleaseId, "Rollback-ReadModel ist nicht an das vorherige Kartenrelease gebunden.");
  invariant(projection.infrastructureReleaseId === previousReleaseId, "Rollback-Zugprojektion ist nicht an das vorherige Kartenrelease gebunden.");
  invariant(readModel.worldId === projection.worldId, "Rollback-ReadModel und Zugprojektion gehoeren zu verschiedenen Welten.");
  return {
    schema: RUNTIME_ROLLBACK_TUPLE_SCHEMA,
    mapReleaseId: previousReleaseId,
    readModel: {
      file: readModelEntry.installPath,
      bytes: readModelEntry.bytes,
      sha256: readModelEntry.sha256,
      schema: "zugfolge-livemap-read-model-sqlite/v2",
      applicationId: readModel.applicationId,
      userVersion: readModel.userVersion,
      worldId: readModel.worldId,
      infrastructureReleaseId: readModel.infrastructureReleaseId,
      worldEpoch: readModel.scheduleTime.worldEpoch,
      serviceDate: readModel.scheduleTime.serviceDate,
      timeZone: readModel.scheduleTime.timeZone,
      serviceStartOffsetS: readModel.scheduleTime.serviceStartOffsetS,
      repeatEveryS: readModel.scheduleTime.repeatEveryS,
    },
    trainMapProjection: {
      file: projectionEntry.installPath,
      bytes: projectionEntry.bytes,
      sha256: projectionEntry.sha256,
      schema: projection.schema,
      applicationId: projection.sqliteApplicationId,
      userVersion: projection.sqliteUserVersion,
      schemaSqlSha256: projection.schemaSqlSha256,
      worldId: projection.worldId,
      infrastructureReleaseId: projection.infrastructureReleaseId,
      deploymentHash: projection.deploymentHash,
    },
  };
}

function validateDatabaseRollbackBinding(binding, previousReleaseId) {
  exactObjectKeys(binding, [
    "schema",
    "bytes",
    "sha256",
    "proofHash",
    "releaseId",
    "previousReleaseId",
    "rollbackWindow",
    "writersQuiesced",
    "migrationLedgerPairSha256",
    "backupManifestSha256",
    "restoreProofSha256",
    "restoreSeparation",
    "databaseIdentity",
    "sourceAuthoritativeHead",
    "sourceHeads",
    "sourceKeycloakIdentityHead",
  ], "Rollback-Runtime-Tuple.databaseRollback");
  invariant([DATABASE_ROLLBACK_PROOF_SCHEMA, DATABASE_ROLLBACK_PROOF_SCHEMA_34, DATABASE_ROLLBACK_PROOF_SCHEMA_35, DATABASE_ROLLBACK_PROOF_SCHEMA_36].includes(binding.schema), "Rollback-Runtime-Tuple bindet kein bekanntes Datenbankbeweis-Schema.");
  parseReleasePair(binding.releaseId, binding.previousReleaseId);
  invariant(binding.previousReleaseId === previousReleaseId, "Rollback-Runtime-Tuple bindet den Datenbankbeleg an einen anderen Vorgaenger.");
  invariant(Number.isSafeInteger(binding.bytes) && binding.bytes > 0 && SHA256.test(binding.sha256), "Rollback-Runtime-Tuple bindet den Datenbankbeleg nicht bytegenau.");
  invariant(SHA256.test(binding.proofHash), "Rollback-Runtime-Tuple bindet keinen kanonischen Datenbankbeweis-Hash.");
  invariant(binding.rollbackWindow === DATABASE_ROLLBACK_WINDOW, "Rollback-Runtime-Tuple besitzt kein ausschliessliches Pre-Activation-Datenbankfenster.");
  invariant(binding.writersQuiesced === true, "Rollback-Runtime-Tuple bindet keinen quieszierten Datenbankzustand.");
  invariant(SHA256.test(binding.migrationLedgerPairSha256), "Rollback-Runtime-Tuple bindet kein exaktes Migrationsledger-Paar.");
  invariant(SHA256.test(binding.backupManifestSha256), "Rollback-Runtime-Tuple bindet kein Datenbank-Backup-Manifest.");
  invariant(SHA256.test(binding.restoreProofSha256), "Rollback-Runtime-Tuple bindet keinen Datenbank-Restore-Beleg.");
  validateDatabaseRestoreSeparation(binding.restoreSeparation, "Rollback-Runtime-Tuple.databaseRollback.restoreSeparation");
  invariant(UUID_V4.test(binding.databaseIdentity), "Rollback-Runtime-Tuple bindet keine persistente Datenbankinstanz.");
  exactObjectKeys(binding.sourceAuthoritativeHead, ["schema", "tableCount", "tableSetSha256", "worldCount", "regionalStateCount", "domainEventCount", "stateHash"], "Rollback-Runtime-Tuple.databaseRollback.sourceAuthoritativeHead");
  invariant(binding.sourceAuthoritativeHead.schema === DATABASE_AUTHORITATIVE_HEAD_SCHEMA && SHA256.test(binding.sourceAuthoritativeHead.stateHash), "Rollback-Runtime-Tuple bindet keinen exakten autoritativen Datenbankkopf.");
  const catalog = databaseAuthoritativeCatalog(binding.schema === DATABASE_ROLLBACK_PROOF_SCHEMA_36 ? 36 : binding.schema === DATABASE_ROLLBACK_PROOF_SCHEMA_35 ? 35 : binding.schema === DATABASE_ROLLBACK_PROOF_SCHEMA_34 ? 34 : 33);
  invariant(binding.sourceAuthoritativeHead.tableCount === catalog.tables.length && binding.sourceAuthoritativeHead.tableSetSha256 === catalog.tableSetSha256, "Rollback-Runtime-Tuple bindet einen fremden Schema-Tabellensatz.");
  validateDatabaseHeadCounts(binding.sourceHeads, "Rollback-Runtime-Tuple.databaseRollback.sourceHeads");
  validateKeycloakIdentityHead(binding.sourceKeycloakIdentityHead);
  return binding;
}

function validateRuntimeRollbackTuple(tuple, previousReleaseId) {
  invariant(tuple?.schema === RUNTIME_ROLLBACK_TUPLE_SCHEMA && tuple.mapReleaseId === previousReleaseId, "Rollback-Runtime-Tuple gehoert nicht zum Vorgaengerrelease.");
  invariant(GIT_COMMIT.test(tuple.sourceCommit) && !/^0+$/.test(tuple.sourceCommit), "Rollback-Runtime-Tuple besitzt keinen unveraenderlichen Source-Commit.");
  invariant(OCI_DIGEST.test(tuple.imageDigest), "Rollback-Runtime-Tuple besitzt keinen unveraenderlichen Image-Digest.");
  invariant(OCI_DIGEST.test(tuple.odooImageDigest), "Rollback-Runtime-Tuple besitzt keinen unveraenderlichen Odoo-Image-Digest.");
  invariant(tuple.odooImageDigest !== tuple.imageDigest, "Rollback-Runtime-Tuple muss Game- und Odoo-Image getrennt binden.");
  const world = tuple.worldDeployment;
  invariant(Number.isSafeInteger(world?.bytes) && world.bytes > 0 && SHA256.test(world?.sha256), "Rollback-Runtime-Tuple bindet das Weltdeployment nicht bytegenau.");
  invariant(world.schema === "zugfolge-alpha-world-deployment/v1" && typeof world.worldId === "string" && SHA256.test(world.deploymentHash), "Rollback-Runtime-Tuple besitzt keine gueltige V1-Welt-/Deploymentbindung.");
  invariant(typeof world.worldEpoch === "string" && Number.isSafeInteger(world.repeatEveryS) && world.repeatEveryS > 0 && typeof world.keyId === "string", "Rollback-Runtime-Tuple besitzt keinen vollstaendigen Weltzeit-/Signaturvertrag.");
  const readModel = tuple.readModel;
  invariant(readModel?.schema === "zugfolge-livemap-read-model-sqlite/v2" && readModel.infrastructureReleaseId === previousReleaseId, "Rollback-Runtime-Tuple besitzt kein kompatibles ReadModel-Schema/Release.");
  invariant(Number.isSafeInteger(readModel.applicationId) && Number.isSafeInteger(readModel.userVersion) && Number.isSafeInteger(readModel.repeatEveryS), "Rollback-Runtime-Tuple besitzt keinen vollstaendigen ReadModel-Runtimevertrag.");
  invariant(Number.isSafeInteger(readModel.bytes) && readModel.bytes > 0 && SHA256.test(readModel.sha256), "Rollback-Runtime-Tuple bindet das ReadModel nicht bytegenau.");
  const projection = tuple.trainMapProjection;
  invariant(projection?.schema === "zugfolge-train-map-projection/v2" && projection.infrastructureReleaseId === previousReleaseId, "Rollback-Runtime-Tuple besitzt kein kompatibles Projektions-Schema/Release.");
  invariant(Number.isSafeInteger(projection.applicationId) && Number.isSafeInteger(projection.userVersion) && SHA256.test(projection.schemaSqlSha256), "Rollback-Runtime-Tuple besitzt keinen vollstaendigen Projektions-Runtimevertrag.");
  invariant(Number.isSafeInteger(projection.bytes) && projection.bytes > 0 && SHA256.test(projection.sha256), "Rollback-Runtime-Tuple bindet die Zugprojektion nicht bytegenau.");
  invariant(
    readModel.worldId === world.worldId
      && projection.worldId === world.worldId
      && projection.deploymentHash === world.deploymentHash
      && readModel.worldEpoch === world.worldEpoch
      && readModel.repeatEveryS === world.repeatEveryS,
    "Rollback-Runtime-Tuple koppelt Welt, Zeitvertrag und Zugprojektion nicht konsistent.",
  );
  validateDatabaseRollbackBinding(tuple.databaseRollback, previousReleaseId);
  return tuple;
}

function rollbackAttestationHash(attestation) {
  invariant(
    attestation?.schema === ROLLBACK_ATTESTATION_SCHEMA || attestation?.schema === RUNTIME_ROLLBACK_ATTESTATION_SCHEMA,
    "Rollback-Attestation besitzt kein bekanntes Schema.",
  );
  const { attestationHash: ignoredHash, signature: ignoredSignature, ...payload } = attestation;
  void ignoredHash;
  void ignoredSignature;
  return sha256Bytes(serializeMapReleaseBuildEvidence(payload));
}

function validateRollbackAttestationContent(attestation, previousReleaseId) {
  invariant(
    [ROLLBACK_ATTESTATION_SCHEMA, RUNTIME_ROLLBACK_ATTESTATION_SCHEMA].includes(attestation?.schema)
      && attestation.previousReleaseId === previousReleaseId,
    "Rollback-Attestation gehört nicht zum belegten Vorgänger.",
  );
  invariant(
    attestation.packageManifest?.file === INSTALLED_PACKAGE_MANIFEST
      && Number.isSafeInteger(attestation.packageManifest.bytes)
      && attestation.packageManifest.bytes > 0
      && SHA256.test(attestation.packageManifest.sha256),
    "Rollback-Attestation bindet keinen kanonischen Paketmarker bytegenau.",
  );
  const deliveryFile = portablePath(attestation.deliveryManifest?.file, "Rollback-Attestation.deliveryManifest.file");
  invariant(
    Number.isSafeInteger(attestation.deliveryManifest.bytes)
      && attestation.deliveryManifest.bytes > 0
      && SHA256.test(attestation.deliveryManifest.sha256),
    "Rollback-Attestation bindet kein Delivery-Manifest bytegenau.",
  );
  if (attestation.schema === RUNTIME_ROLLBACK_ATTESTATION_SCHEMA) validateRuntimeRollbackTuple(attestation.runtimeTuple, previousReleaseId);
  else invariant(attestation.runtimeTuple === undefined, "Legacy-Rollback-Attestation darf kein ungebundenes Runtime-Tuple vortaeuschen.");
  return { deliveryFile };
}

export function validateUnsignedMapRollbackAttestation(attestation) {
  const { deliveryFile } = validateRollbackAttestationContent(attestation, attestation?.previousReleaseId);
  invariant(attestation.approvalGate?.status === "missing", "Unsignierte Rollback-Attestation besitzt keinen explizit fehlenden Freigabestatus.");
  invariant(attestation.signature === null && attestation.attestationHash === undefined, "Unsignierte Rollback-Attestation darf weder Signatur noch Attestation-Hash enthalten.");
  return { deliveryFile, schema: attestation.schema };
}

function validateRollbackAttestation(attestation, previousReleaseId) {
  const { deliveryFile } = validateRollbackAttestationContent(attestation, previousReleaseId);
  const gate = attestation.approvalGate;
  const signature = attestation.signature;
  invariant(gate?.status === "passed" && gate.algorithm === "Ed25519", "Rollback-Attestation besitzt keine signierte Freigabe.");
  const keyId = stableId(gate.keyId, "Rollback-Attestation.approvalGate.keyId");
  invariant(signature?.algorithm === "Ed25519" && signature.keyId === keyId, "Rollback-Attestation besitzt keine konsistente Ed25519-Signaturhülle.");
  invariant(typeof signature.valueBase64 === "string", "Rollback-Attestation besitzt keine Ed25519-Signaturbytes.");
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  invariant(signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.valueBase64, "Rollback-Attestation besitzt keine kanonischen Ed25519-Signaturbytes.");
  invariant(SHA256.test(attestation.attestationHash) && attestation.attestationHash === rollbackAttestationHash(attestation), "Rollback-Attestation besitzt keinen gültigen kanonischen Hash.");
  return { deliveryFile, keyId, attestationHash: attestation.attestationHash, schema: attestation.schema };
}

export async function createMapRollbackAttestation({ deploymentRoot, previousInstallPath, previousReleaseId, runtimeIdentity }) {
  const previous = await inspectInstalledMapPackage(deploymentRoot, previousInstallPath, previousReleaseId, "Rollbackrelease");
  const releaseEntry = previous.inventory.find(({ kind }) => kind === "release-manifest");
  invariant(releaseEntry !== undefined, "Rollbackrelease besitzt kein Delivery-Manifest.");
  const common = {
    previousReleaseId,
    packageManifest: {
      file: INSTALLED_PACKAGE_MANIFEST,
      bytes: previous.markerBytes.length,
      sha256: sha256Bytes(previous.markerBytes),
    },
    deliveryManifest: {
      file: releaseEntry.installPath,
      bytes: previous.releaseBytes.length,
      sha256: sha256Bytes(previous.releaseBytes),
    },
    approvalGate: { status: "missing" },
    signature: null,
  };
  if (runtimeIdentity === undefined) return { schema: ROLLBACK_ATTESTATION_SCHEMA, ...common };
  invariant(GIT_COMMIT.test(runtimeIdentity.sourceCommit) && !/^0+$/.test(runtimeIdentity.sourceCommit), "Runtime-Identitaet besitzt keinen unveraenderlichen Source-Commit.");
  invariant(OCI_DIGEST.test(runtimeIdentity.imageDigest), "Runtime-Identitaet besitzt keinen unveraenderlichen Image-Digest.");
  invariant(OCI_DIGEST.test(runtimeIdentity.odooImageDigest), "Runtime-Identitaet besitzt keinen unveraenderlichen Odoo-Image-Digest.");
  invariant(runtimeIdentity.odooImageDigest !== runtimeIdentity.imageDigest, "Runtime-Identitaet muss Game- und Odoo-Image getrennt binden.");
  const installed = await inspectInstalledRuntimeTuple(previous, previousReleaseId);
  invariant(typeof runtimeIdentity.databaseRollbackProofPath === "string" && runtimeIdentity.databaseRollbackProofPath.length > 0, "Runtime-Identitaet besitzt keinen Datenbank-Rollbackbeleg-Pfad.");
  const [world, databaseRollbackArtifact] = await Promise.all([
    inspectSignedWorldDeployment(runtimeIdentity.worldDeploymentPath),
    readFile(resolve(runtimeIdentity.databaseRollbackProofPath)).then((bytes) => parseCanonicalDatabaseRollbackProof(bytes, { previousReleaseId })),
  ]);
  const runtimeTuple = validateRuntimeRollbackTuple({
    ...installed,
    sourceCommit: runtimeIdentity.sourceCommit,
    imageDigest: runtimeIdentity.imageDigest,
    odooImageDigest: runtimeIdentity.odooImageDigest,
    worldDeployment: {
      bytes: world.bytes.length,
      sha256: world.sha256,
      schema: "zugfolge-alpha-world-deployment/v1",
      worldId: world.worldId,
      deploymentHash: world.deploymentHash,
      worldEpoch: world.worldEpoch,
      repeatEveryS: world.repeatEveryS,
      keyId: world.keyId,
    },
    databaseRollback: databaseRollbackBinding(databaseRollbackArtifact),
  }, previousReleaseId);
  return { schema: RUNTIME_ROLLBACK_ATTESTATION_SCHEMA, ...common, runtimeTuple };
}

export function signMapRollbackAttestation(attestation, privateKeyPem, keyId) {
  invariant(attestation?.approvalGate?.status === "missing" && attestation.signature === null, "Nur eine explizit unsignierte Rollback-Attestation darf signiert werden.");
  stableId(keyId, "Rollback-Attestation-Schlüssel-ID");
  const privateKey = createPrivateKey(privateKeyPem);
  invariant(privateKey.asymmetricKeyType === "ed25519", "Rollback-Attestation verlangt einen Ed25519-Schlüssel.");
  const candidate = {
    ...attestation,
    approvalGate: { status: "passed", algorithm: "Ed25519", keyId },
    signature: null,
  };
  const attestationHash = rollbackAttestationHash(candidate);
  const signature = signEd25519(null, Buffer.from(attestationHash, "hex"), privateKey);
  return {
    ...candidate,
    attestationHash,
    signature: { algorithm: "Ed25519", keyId, valueBase64: signature.toString("base64") },
  };
}

function verifyMapRollbackAttestation(attestation, publicKeyPem) {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const signature = Buffer.from(attestation?.signature?.valueBase64 ?? "", "base64");
    return publicKey.asymmetricKeyType === "ed25519"
      && attestation?.attestationHash === rollbackAttestationHash(attestation)
      && signature.length === 64
      && verifyEd25519(null, Buffer.from(attestation.attestationHash, "hex"), publicKey, signature);
  } catch {
    return false;
  }
}

async function assessRuntimeRollbackTuple({
  attestation,
  previous,
  previousReleaseId,
  candidateReleaseId,
  runtimeIdentity,
  databaseRollbackProofBytes,
  trustedKeys,
}) {
  if (attestation.schema !== RUNTIME_ROLLBACK_ATTESTATION_SCHEMA) {
    return {
      eligible: false,
      mapEligible: false,
      databaseEligible: false,
      writersQuiesced: false,
      reason: "runtime-tuple-unbound-v1",
    };
  }
  if (runtimeIdentity === undefined) {
    return {
      eligible: false,
      mapEligible: false,
      databaseEligible: false,
      writersQuiesced: false,
      reason: "runtime-identity-missing",
    };
  }
  invariant(GIT_COMMIT.test(runtimeIdentity.sourceCommit) && !/^0+$/.test(runtimeIdentity.sourceCommit), "Aktuelle Runtime besitzt keinen unveraenderlichen Source-Commit.");
  invariant(OCI_DIGEST.test(runtimeIdentity.imageDigest), "Aktuelle Runtime besitzt keinen unveraenderlichen Image-Digest.");
  invariant(OCI_DIGEST.test(runtimeIdentity.odooImageDigest), "Aktuelle Runtime besitzt keinen unveraenderlichen Odoo-Image-Digest.");
  invariant(runtimeIdentity.odooImageDigest !== runtimeIdentity.imageDigest, "Aktuelle Runtime muss Game- und Odoo-Image getrennt binden.");
  invariant(typeof runtimeIdentity.worldDeploymentPath === "string" && runtimeIdentity.worldDeploymentPath.length > 0, "Aktuelle Runtime besitzt keinen Weltdeployment-Pfad.");
  invariant(typeof runtimeIdentity.databaseRollbackProofPath === "string" && runtimeIdentity.databaseRollbackProofPath.length > 0, "Aktuelle Runtime besitzt keinen Datenbank-Rollbackbeleg-Pfad.");
  const [installed, world] = await Promise.all([
    inspectInstalledRuntimeTuple(previous, previousReleaseId),
    inspectSignedWorldDeployment(runtimeIdentity.worldDeploymentPath, trustedKeys),
  ]);
  const databaseRollbackArtifact = parseCanonicalDatabaseRollbackProof(databaseRollbackProofBytes, {
    releaseId: candidateReleaseId,
    previousReleaseId,
  });
  const actual = validateRuntimeRollbackTuple({
    ...installed,
    sourceCommit: runtimeIdentity.sourceCommit,
    imageDigest: runtimeIdentity.imageDigest,
    odooImageDigest: runtimeIdentity.odooImageDigest,
    worldDeployment: {
      bytes: world.bytes.length,
      sha256: world.sha256,
      schema: "zugfolge-alpha-world-deployment/v1",
      worldId: world.worldId,
      deploymentHash: world.deploymentHash,
      worldEpoch: world.worldEpoch,
      repeatEveryS: world.repeatEveryS,
      keyId: world.keyId,
    },
    databaseRollback: databaseRollbackBinding(databaseRollbackArtifact),
  }, previousReleaseId);
  invariant(
    JSON.stringify(sortedValue(actual)) === JSON.stringify(sortedValue(attestation.runtimeTuple)),
    "Aktuelles Source-/Image-/Welt-/Map-/Datenbank-Runtime-Tuple weicht von der signierten Rollback-Attestation ab.",
  );
  return {
    eligible: true,
    mapEligible: true,
    databaseEligible: true,
    writersQuiesced: databaseRollbackArtifact.proof.writersQuiesced,
    rollbackWindow: databaseRollbackArtifact.proof.rollbackWindow,
    databaseRollbackProofHash: databaseRollbackArtifact.proof.proofHash,
    databaseBackupManifestSha256: databaseRollbackArtifact.proof.backupManifestSha256,
    databaseRestoreProofSha256: databaseRollbackArtifact.proof.restoreProofSha256,
    reason: "full-stack-runtime-tuple-v3-verified",
  };
}

export async function writeMapRollbackAttestation(attestation, outputPath) {
  validateRollbackAttestation(attestation, attestation?.previousReleaseId);
  const bytes = serializeMapReleaseBuildEvidence(attestation);
  return { ...(await writeAtomicCreateNew(outputPath, bytes, "Rollback-Attestation")), bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

export async function writeUnsignedMapRollbackAttestation(attestation, outputPath) {
  validateUnsignedMapRollbackAttestation(attestation);
  const bytes = serializeMapReleaseBuildEvidence(attestation);
  return { ...(await writeAtomicCreateNew(outputPath, bytes, "Unsignierte Rollback-Attestation")), bytes: bytes.length, sha256: sha256Bytes(bytes) };
}

async function inspectActivationPointer(deploymentRoot, evidence, expectedActiveReleaseId) {
  invariant(
    expectedActiveReleaseId === evidence.previousReleaseId || expectedActiveReleaseId === evidence.releaseId,
    "Erwartetes aktives Kartenrelease muss explizit Kandidat oder belegter Vorgänger sein.",
  );
  const pointer = await containedRealPath(deploymentRoot, evidence.deployment.activationPointer, "Aktivierungszeiger");
  const bytes = await readFile(pointer);
  invariant(bytes.length > 0 && bytes.length <= 64 * 1024, "Aktivierungszeiger besitzt eine unzulässige Größe.");
  const text = bytes.toString("utf8");
  invariant(!text.includes("\r") && text.endsWith("\n"), "Aktivierungszeiger ist nicht als kanonische LF-env-Datei serialisiert.");
  const entries = text.slice(0, -1).split("\n").map((line) => {
    const match = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>[^\s"']+)$/.exec(line);
    invariant(match !== null, "Aktivierungszeiger enthält keine kanonische KEY=VALUE-Zeile.");
    return [match.groups.key, match.groups.value];
  });
  invariant(entries.length === ACTIVATION_POINTER_KEYS.length && new Set(entries.map(([key]) => key)).size === entries.length, "Aktivierungszeiger muss genau vier eindeutige Kartenwerte enthalten.");
  invariant(JSON.stringify(entries.map(([key]) => key).sort()) === JSON.stringify(ACTIVATION_POINTER_KEYS), "Aktivierungszeiger enthält fremde oder fehlende Kartenwerte.");
  const values = Object.fromEntries(entries);
  const releaseId = expectedActiveReleaseId;
  const installPath = releaseId === evidence.previousReleaseId
    ? evidence.deployment.previousInstallPath
    : evidence.deployment.candidateInstallPath;
  const expected = {
    MAP_RELEASE_ID: releaseId,
    MAP_RELEASE_HOST_DIR: installPath,
    MAP_BASEMAP_STYLE_URL: `/artifacts/maps/${releaseId}/style.json`,
    MAP_GERMANY_PMTILES_URL: `/artifacts/maps/${releaseId}/${releaseId}.pmtiles`,
  };
  invariant(ACTIVATION_POINTER_KEYS.every((key) => values[key] === expected[key]), `Aktivierungszeiger verweist nicht vollständig auf das explizit erwartete Release ${releaseId}.`);
  return {
    path: pointer,
    values,
    activeReleaseId: releaseId,
    state: releaseId === evidence.previousReleaseId ? "pre-activation" : "active-candidate",
  };
}

function trustedDeliveryPublicKey(trustedDeliveryKeys, keyId, label = "Delivery") {
  validateTrustedDeliveryKeyMap(trustedDeliveryKeys);
  const publicKey = trustedDeliveryKeys[keyId];
  invariant(typeof publicKey === "string", `${label}-Signaturschlüssel ${keyId} ist nicht vertrauenswürdig.`);
  return publicKey;
}

function runtimeTrustedDeliveryKeyring(evidence, trustedDeliveryKeys, trustedDeliveryKeysBytes) {
  if (evidenceVersion(evidence.schema) !== 2) {
    validateTrustedDeliveryKeyMap(trustedDeliveryKeys);
    return trustedDeliveryKeys;
  }
  invariant(Buffer.isBuffer(trustedDeliveryKeysBytes) && trustedDeliveryKeysBytes.length > 0, "Operational-v2-Preflight benötigt den Delivery-Keyring als unveränderte Datei-Bytes.");
  invariant(
    trustedDeliveryKeysBytes.length === evidence.candidatePackage.trustedKeysBytes
      && sha256Bytes(trustedDeliveryKeysBytes) === evidence.candidatePackage.trustedKeysSha256,
    "Operational-v2-Preflight-Keyring weicht vom bytegenau gebundenen candidatePackage-Keyring ab.",
  );
  let parsed;
  try {
    parsed = JSON.parse(trustedDeliveryKeysBytes.toString("utf8"));
  } catch {
    throw new Error("Operational-v2-Preflight-Keyring ist kein gültiges JSON-Artefakt.");
  }
  const trustedKeyIds = trustedDeliveryKeyring(
    parsed,
    evidence.candidatePackage.retainedTrustedKeyIds,
    evidence.candidatePackage.signatureKeyId,
  );
  invariant(
    JSON.stringify(trustedKeyIds) === JSON.stringify(evidence.candidatePackage.trustedKeyIds),
    "Operational-v2-Preflight-Keyring besitzt nicht exakt die in candidatePackage gebundenen Vertrauensanker-IDs.",
  );
  if (trustedDeliveryKeys !== undefined) {
    invariant(
      JSON.stringify(sortedValue(trustedDeliveryKeys)) === JSON.stringify(sortedValue(parsed)),
      "Operational-v2-Preflight-Keyring-Objekt weicht von seinen übergebenen Datei-Bytes ab.",
    );
  }
  return parsed;
}

function runtimeTrustedReleaseKeyScopes(
  evidence,
  trustedReleaseKeys,
  trustedAlphaWorldKeys,
  trustedMapInfraKeys,
) {
  const version = evidenceVersion(evidence.schema);
  if (version === 1 && trustedAlphaWorldKeys === undefined && trustedMapInfraKeys === undefined) {
    // Ausschliesslich der historische Evidence-v1-Vertrag bleibt lesbar. V2
    // darf diesen flachen, protokolluebergreifenden Trust-Pfad nie verwenden.
    return {
      alphaWorldKeys: trustedReleaseKeys,
      mapInfraKeys: trustedReleaseKeys,
    };
  }
  invariant(
    trustedAlphaWorldKeys !== undefined && trustedMapInfraKeys !== undefined,
    "Operational-v2-Preflight benoetigt disjunkte Alpha-Welt- und Map-/Infra-Key-Scopes; der flache Keyring ist nicht autorisierend.",
  );
  const alphaKeyIds = validateTrustedDeliveryKeyMap(trustedAlphaWorldKeys);
  const mapKeyIds = validateTrustedDeliveryKeyMap(trustedMapInfraKeys);
  const alphaKeySet = new Set(alphaKeyIds);
  invariant(
    mapKeyIds.every((keyId) => !alphaKeySet.has(keyId)),
    "Release-Key-Scopes duerfen keine Schluessel-ID mehreren Protokollrollen zuweisen.",
  );
  const assignedKeyIds = [...alphaKeyIds, ...mapKeyIds].sort();
  const trustedKeyIds = Object.keys(trustedReleaseKeys).sort();
  invariant(
    JSON.stringify(assignedKeyIds) === JSON.stringify(trustedKeyIds),
    "Release-Key-Scopes muessen den Evidence-gebundenen Public-Keyring vollstaendig partitionieren.",
  );
  for (const keyId of assignedKeyIds) {
    const scopedKey = trustedAlphaWorldKeys[keyId] ?? trustedMapInfraKeys[keyId];
    invariant(
      scopedKey === trustedReleaseKeys[keyId],
      `Release-Key-Scope fuer ${keyId} weicht vom Evidence-gebundenen Public-Keyring ab.`,
    );
  }
  return {
    alphaWorldKeys: trustedAlphaWorldKeys,
    mapInfraKeys: trustedMapInfraKeys,
  };
}

export async function preflightMapReleaseActivation({
  evidence,
  deploymentRoot,
  restoreProofBytes,
  restoreRoot,
  trustedDeliveryKeys,
  trustedDeliveryKeysBytes,
  trustedAlphaWorldKeys,
  trustedMapInfraKeys,
  expectedActiveReleaseId,
  runtimeIdentity,
  databaseRollbackProofBytes,
}) {
  validateMapReleaseBuildEvidence(evidence);
  const runtimeTrustedDeliveryKeys = runtimeTrustedDeliveryKeyring(evidence, trustedDeliveryKeys, trustedDeliveryKeysBytes);
  const runtimeTrustedReleaseScopes = runtimeTrustedReleaseKeyScopes(
    evidence,
    runtimeTrustedDeliveryKeys,
    trustedAlphaWorldKeys,
    trustedMapInfraKeys,
  );
  const runtimeTrustedAlphaWorldKeys = runtimeTrustedReleaseScopes.alphaWorldKeys;
  const runtimeTrustedMapInfraKeys = runtimeTrustedReleaseScopes.mapInfraKeys;
  const evidenceSha256 = sha256Bytes(serializeMapReleaseBuildEvidence(evidence));
  const activation = await inspectActivationPointer(deploymentRoot, evidence, expectedActiveReleaseId);
  const restoreProof = parseCanonicalRestoreProof(restoreProofBytes);
  invariant(typeof restoreRoot === "string" && restoreRoot.length > 0, "Preflight benötigt den tatsächlich wiederhergestellten Cachepfad.");
  const actualRestore = await proveBuildCacheRestore(evidence, restoreRoot);
  invariant(actualRestore.proofBytes.equals(restoreProofBytes), "Buildcache-Restore-Beleg weicht vom aktuell verifizierten Restore-Artefakt ab.");
  invariant(restoreProof?.schema === RESTORE_PROOF_SCHEMA && restoreProof.releaseId === evidence.releaseId, "Buildcache-Restore-Beleg gehört nicht zum Kandidaten.");
  invariant(restoreProof.evidenceSha256 === evidenceSha256, "Buildcache-Restore-Beleg bindet ein anderes Evidence-Manifest.");
  invariant(restoreProof.objectKey === evidence.buildCache.objectKey && restoreProof.encrypted === true && restoreProof.encryptionScheme === evidence.buildCache.encryptionScheme, "Buildcache-Restore-Beleg bindet nicht das verschlüsselte Backup.");
  invariant(restoreProof.restoredToPreparedEmptyPath === true && restoreProof.verification === "full-byte-inventory", "Buildcache wurde nicht vollständig auf einen vorbereiteten leeren Pfad wiederhergestellt.");
  invariant(typeof restoreProof.emptyRootNonce === "string" && UUID_V4.test(restoreProof.emptyRootNonce), "Buildcache-Restore-Beleg besitzt keinen Leerpfadnachweis.");
  invariant(restoreProof.verifiedFiles === evidence.buildCache.inventory.length, "Buildcache-Restore-Beleg besitzt eine abweichende Dateizahl.");
  invariant(restoreProof.verifiedBytes === evidence.buildCache.inventory.reduce((sum, entry) => sum + entry.bytes, 0), "Buildcache-Restore-Beleg besitzt eine abweichende Bytezahl.");
  const expectedInventorySha256 = sha256Bytes(Buffer.from(`${JSON.stringify(sortedValue(evidence.buildCache.inventory))}\n`, "utf8"));
  invariant(restoreProof.inventorySha256 === expectedInventorySha256, "Buildcache-Restore-Beleg bindet ein anderes Inventar.");
  invariant(SHA256.test(restoreProof.emptyRootMarkerSha256) && Number.isSafeInteger(restoreProof.emptyRootMarkerBytes) && restoreProof.emptyRootMarkerBytes > 0, "Buildcache-Restore-Beleg bindet keinen Leerpfadmarker bytegenau.");
  invariant(SHA256.test(restoreProof.restoreRootSha256) && SHA256.test(restoreProof.artifactBindingSha256), "Buildcache-Restore-Beleg besitzt keine kryptografische Artefaktbindung.");

  const candidate = await inspectInstalledMapPackage(deploymentRoot, evidence.deployment.candidateInstallPath, evidence.releaseId, "Kandidatenrelease");
  const previous = await inspectInstalledMapPackage(deploymentRoot, evidence.deployment.previousInstallPath, evidence.previousReleaseId, "Rollbackrelease");
  invariant(candidate.root !== previous.root, "Kandidat und Rollbackziel dürfen nicht dasselbe Verzeichnis sein.");

  const rollbackAttestationPath = await containedRealPath(deploymentRoot, evidence.deployment.rollbackAttestationPath, "Rollback-Attestation");
  const rollbackAttestationBytes = await readFile(rollbackAttestationPath);
  let rollbackAttestation;
  try {
    rollbackAttestation = JSON.parse(rollbackAttestationBytes.toString("utf8"));
  } catch {
    throw new Error("Rollback-Attestation ist kein gültiges JSON-Artefakt.");
  }
  invariant(rollbackAttestationBytes.equals(serializeMapReleaseBuildEvidence(rollbackAttestation)), "Rollback-Attestation ist nicht kanonisch serialisiert.");
  const rollbackSigned = validateRollbackAttestation(rollbackAttestation, evidence.previousReleaseId);
  const rollbackPublicKey = trustedDeliveryPublicKey(runtimeTrustedMapInfraKeys, rollbackSigned.keyId, "Rollback-Attestation");
  invariant(
    verifyMapRollbackAttestation(rollbackAttestation, rollbackPublicKey),
    "Rollback-Attestation besitzt keine gültige vertrauenswürdige Ed25519-Signatur.",
  );
  const previousReleaseEntry = previous.inventory.find(({ kind }) => kind === "release-manifest");
  invariant(
    rollbackAttestation.packageManifest.file === INSTALLED_PACKAGE_MANIFEST
      && rollbackAttestation.packageManifest.bytes === previous.markerBytes.length
      && rollbackAttestation.packageManifest.sha256 === sha256Bytes(previous.markerBytes),
    "Rollback-Attestation weicht vom installierten kanonischen Paketmarker ab.",
  );
  invariant(
    previousReleaseEntry !== undefined
      && rollbackSigned.deliveryFile === previousReleaseEntry.installPath
      && rollbackAttestation.deliveryManifest.bytes === previous.releaseBytes.length
      && rollbackAttestation.deliveryManifest.sha256 === sha256Bytes(previous.releaseBytes),
    "Rollback-Attestation weicht vom installierten Delivery-Manifest ab.",
  );
  let rollbackRuntime;
  try {
    rollbackRuntime = await assessRuntimeRollbackTuple({
      attestation: rollbackAttestation,
      previous,
      previousReleaseId: evidence.previousReleaseId,
      candidateReleaseId: evidence.releaseId,
      runtimeIdentity,
      databaseRollbackProofBytes,
      trustedKeys: runtimeTrustedAlphaWorldKeys,
    });
  } catch (error) {
    if (expectedActiveReleaseId !== evidence.releaseId) throw error;
    rollbackRuntime = {
      eligible: false,
      mapEligible: false,
      databaseEligible: false,
      writersQuiesced: false,
      reason: "full-stack-runtime-tuple-mismatch",
    };
  }
  const deliveryOutput = evidence.outputs.find(({ kind }) => kind === "delivery-manifest");
  const installedDelivery = await fileProof(candidate.root, { file: deliveryOutput.installFile }, "Installiertes Delivery-Manifest");
  invariant(installedDelivery.bytes === deliveryOutput.bytes && installedDelivery.sha256 === deliveryOutput.sha256, "Installiertes Delivery-Manifest weicht vom Buildbeleg ab.");
  const deliveryBytes = await readFile(await containedRealPath(candidate.root, deliveryOutput.installFile, "Installiertes Delivery-Manifest"));
  const delivery = JSON.parse(deliveryBytes.toString("utf8"));
  invariant(deliveryBytes.equals(serializeDeliveryJson(delivery)), "Installiertes Delivery-Manifest ist nicht kanonisch serialisiert.");
  const signed = validateSignedDeliveryContract(delivery, evidence.releaseId, "Installiertes Delivery-Manifest");
  if (evidence.releaseId === CURRENT_ANNUAL_V3_RELEASE_ID) {
    validateOperationalBuildAuthority(evidence.operationalAuthority);
    invariant(
      JSON.stringify(sortedValue(delivery.operationalAuthority))
        === JSON.stringify(sortedValue(evidence.operationalAuthority))
        && delivery.bindings.operationalAuthoritySha256
          === operationalBuildAuthoritySha256(evidence.operationalAuthority),
      "Installiertes Delivery-Manifest und Build-Evidence binden nicht dieselbe Operational-Build-Authority.",
    );
  }
  const publicKey = trustedDeliveryPublicKey(runtimeTrustedMapInfraKeys, signed.keyId);
  invariant(verifyMapDeliveryReleaseSignature(delivery, publicKey), "Installiertes Delivery-Manifest besitzt keine gültige vertrauenswürdige Ed25519-Signatur.");
  const packageInventory = candidate.inventory
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(JSON.stringify(sortedValue(packageInventory)) === JSON.stringify(sortedValue(evidence.deliveryInventory)), "Kandidaten-Paketinventar weicht vom signierten Delivery-Manifest ab.");
  invariant(candidate.manifest.packageId === delivery.packageId && candidate.manifest.version === delivery.packageVersion, "Kandidaten-Paketmarker ist nicht an den signierten Delivery-Vertrag gebunden.");
  const releaseEntry = candidate.inventory.find(({ kind }) => kind === "release-manifest");
  invariant(releaseEntry?.installPath === deliveryOutput.installFile && releaseEntry.bytes === installedDelivery.bytes && releaseEntry.sha256 === installedDelivery.sha256, "Kandidaten-Paketmarker bindet das signierte Delivery-Manifest nicht bytegenau.");
  const sourcesEntry = candidate.inventory.find(({ kind }) => kind === "source-manifest");
  invariant(sourcesEntry !== undefined && sourcesEntry.sha256 === delivery.bindings?.sourcesSha256, "Kandidaten-Paketmarker bindet den signierten Quellenbeleg nicht bytegenau.");
  for (const artifact of evidence.deliveryInventory) {
    let proof;
    try {
      proof = await fileProof(candidate.root, { file: artifact.installPath }, `Installiertes Delivery-Artefakt ${artifact.id}`);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Installiertes Delivery-Artefakt ${artifact.id} fehlt.`);
      throw error;
    }
    invariant(proof.bytes === artifact.bytes && proof.sha256 === artifact.sha256, `Installiertes Delivery-Artefakt ${artifact.id} weicht vom Delivery-Manifest ab.`);
  }
  const fullStackRollbackEligible = rollbackRuntime.mapEligible === true
    && rollbackRuntime.databaseEligible === true
    && rollbackRuntime.writersQuiesced === true;
  invariant(rollbackRuntime.eligible === fullStackRollbackEligible, "Full-Stack-Rollbackstatus widerspricht seinen Map-/Datenbank-/Quiescence-Gates.");
  return {
    releaseId: evidence.releaseId,
    previousReleaseId: evidence.previousReleaseId,
    mapActivationEligible: true,
    activationEligible: fullStackRollbackEligible,
    rollbackEligible: fullStackRollbackEligible,
    rollbackEligibilityReason: rollbackRuntime.reason,
    mapRollbackEligible: rollbackRuntime.mapEligible,
    databaseRollbackEligible: rollbackRuntime.databaseEligible,
    writersQuiesced: rollbackRuntime.writersQuiesced,
    rollbackWindow: rollbackRuntime.rollbackWindow ?? null,
    databaseRollbackProofHash: rollbackRuntime.databaseRollbackProofHash ?? null,
    databaseBackupManifestSha256: rollbackRuntime.databaseBackupManifestSha256 ?? null,
    databaseRestoreProofSha256: rollbackRuntime.databaseRestoreProofSha256 ?? null,
    activationMode: "atomic-config-swap",
    activationState: activation.state,
    activeReleaseId: activation.activeReleaseId,
    activationPointer: evidence.deployment.activationPointer,
    activationPointerPath: activation.path,
    candidateRoot: candidate.root,
    previousRoot: previous.root,
    deliveryKeyId: signed.keyId,
    deliveryReleaseHash: signed.releaseHash,
    rollbackAttestationPath,
    rollbackAttestationSchema: rollbackSigned.schema,
    rollbackAttestationKeyId: rollbackSigned.keyId,
    rollbackAttestationHash: rollbackSigned.attestationHash,
    evidenceSha256,
    verifiedDeliveryArtifacts: evidence.deliveryInventory.length,
  };
}

export async function preflightMapReleaseRollback({
  evidence,
  deploymentRoot,
  trustedDeliveryKeys,
  trustedDeliveryKeysBytes,
  trustedAlphaWorldKeys,
  trustedMapInfraKeys,
  expectedActiveReleaseId,
  runtimeIdentity,
  databaseRollbackProofBytes,
}) {
  validateMapReleaseBuildEvidence(evidence);
  invariant(expectedActiveReleaseId === evidence.previousReleaseId, "Attestierter Rollback verlangt den belegten Vorgänger als aktiven Kartenzeiger.");
  const runtimeTrustedDeliveryKeys = runtimeTrustedDeliveryKeyring(evidence, trustedDeliveryKeys, trustedDeliveryKeysBytes);
  const runtimeTrustedReleaseScopes = runtimeTrustedReleaseKeyScopes(
    evidence,
    runtimeTrustedDeliveryKeys,
    trustedAlphaWorldKeys,
    trustedMapInfraKeys,
  );
  const evidenceSha256 = sha256Bytes(serializeMapReleaseBuildEvidence(evidence));
  const activation = await inspectActivationPointer(deploymentRoot, evidence, expectedActiveReleaseId);
  const previous = await inspectInstalledMapPackage(
    deploymentRoot,
    evidence.deployment.previousInstallPath,
    evidence.previousReleaseId,
    "Rollbackrelease",
  );
  const rollbackAttestationPath = await containedRealPath(
    deploymentRoot,
    evidence.deployment.rollbackAttestationPath,
    "Rollback-Attestation",
  );
  const rollbackAttestationBytes = await readFile(rollbackAttestationPath);
  let rollbackAttestation;
  try {
    rollbackAttestation = JSON.parse(rollbackAttestationBytes.toString("utf8"));
  } catch {
    throw new Error("Rollback-Attestation ist kein gültiges JSON-Artefakt.");
  }
  invariant(rollbackAttestationBytes.equals(serializeMapReleaseBuildEvidence(rollbackAttestation)), "Rollback-Attestation ist nicht kanonisch serialisiert.");
  const rollbackSigned = validateRollbackAttestation(rollbackAttestation, evidence.previousReleaseId);
  const rollbackPublicKey = trustedDeliveryPublicKey(
    runtimeTrustedReleaseScopes.mapInfraKeys,
    rollbackSigned.keyId,
    "Rollback-Attestation",
  );
  invariant(
    verifyMapRollbackAttestation(rollbackAttestation, rollbackPublicKey),
    "Rollback-Attestation besitzt keine gültige vertrauenswürdige Ed25519-Signatur.",
  );
  const previousReleaseEntry = previous.inventory.find(({ kind }) => kind === "release-manifest");
  invariant(
    rollbackAttestation.packageManifest.file === INSTALLED_PACKAGE_MANIFEST
      && rollbackAttestation.packageManifest.bytes === previous.markerBytes.length
      && rollbackAttestation.packageManifest.sha256 === sha256Bytes(previous.markerBytes),
    "Rollback-Attestation weicht vom installierten kanonischen Paketmarker ab.",
  );
  invariant(
    previousReleaseEntry !== undefined
      && rollbackSigned.deliveryFile === previousReleaseEntry.installPath
      && rollbackAttestation.deliveryManifest.bytes === previous.releaseBytes.length
      && rollbackAttestation.deliveryManifest.sha256 === sha256Bytes(previous.releaseBytes),
    "Rollback-Attestation weicht vom installierten Delivery-Manifest ab.",
  );
  const rollbackRuntime = await assessRuntimeRollbackTuple({
    attestation: rollbackAttestation,
    previous,
    previousReleaseId: evidence.previousReleaseId,
    candidateReleaseId: evidence.releaseId,
    runtimeIdentity,
    databaseRollbackProofBytes,
    trustedKeys: runtimeTrustedReleaseScopes.alphaWorldKeys,
  });
  const fullStackRollbackEligible = rollbackRuntime.mapEligible === true
    && rollbackRuntime.databaseEligible === true
    && rollbackRuntime.writersQuiesced === true;
  invariant(rollbackRuntime.eligible === fullStackRollbackEligible, "Full-Stack-Rollbackstatus widerspricht seinen Map-/Datenbank-/Quiescence-Gates.");
  invariant(fullStackRollbackEligible, "Attestierter Rollback besitzt keinen vollständig qualifizierten Full-Stack-Rückweg.");
  return {
    releaseId: evidence.releaseId,
    previousReleaseId: evidence.previousReleaseId,
    mapActivationEligible: false,
    activationEligible: false,
    rollbackEligible: true,
    rollbackEligibilityReason: rollbackRuntime.reason,
    mapRollbackEligible: true,
    databaseRollbackEligible: true,
    writersQuiesced: true,
    rollbackWindow: rollbackRuntime.rollbackWindow,
    databaseRollbackProofHash: rollbackRuntime.databaseRollbackProofHash,
    databaseBackupManifestSha256: rollbackRuntime.databaseBackupManifestSha256,
    databaseRestoreProofSha256: rollbackRuntime.databaseRestoreProofSha256,
    activationState: activation.state,
    activeReleaseId: activation.activeReleaseId,
    activationPointer: evidence.deployment.activationPointer,
    activationPointerPath: activation.path,
    previousRoot: previous.root,
    rollbackAttestationPath,
    rollbackAttestationSchema: rollbackSigned.schema,
    rollbackAttestationKeyId: rollbackSigned.keyId,
    rollbackAttestationHash: rollbackSigned.attestationHash,
    evidenceSha256,
  };
}

export const MAP_RELEASE_BUILD_EVIDENCE_SCHEMAS = Object.freeze({
  spec: SPEC_SCHEMA_V1,
  specV1: SPEC_SCHEMA_V1,
  specV2: SPEC_SCHEMA_V2,
  specV3: SPEC_SCHEMA_V3,
  evidence: EVIDENCE_SCHEMA_V1,
  evidenceV1: EVIDENCE_SCHEMA_V1,
  evidenceV2: EVIDENCE_SCHEMA_V2,
  evidenceV3: EVIDENCE_SCHEMA_V3,
  cacheInventory: CACHE_INVENTORY_SCHEMA,
  restoreProof: RESTORE_PROOF_SCHEMA,
  rollbackAttestation: ROLLBACK_ATTESTATION_SCHEMA,
  runtimeRollbackAttestation: RUNTIME_ROLLBACK_ATTESTATION_SCHEMA,
  runtimeRollbackTuple: RUNTIME_ROLLBACK_TUPLE_SCHEMA,
  databaseRollbackProof: DATABASE_ROLLBACK_PROOF_SCHEMA,
  databaseAuthoritativeHead: DATABASE_AUTHORITATIVE_HEAD_SCHEMA,
  databaseBackupManifest: DATABASE_BACKUP_MANIFEST_SCHEMA,
  databaseRestoreProof: DATABASE_RESTORE_PROOF_SCHEMA,
  databaseRestoreSeparation: DATABASE_RESTORE_SEPARATION_SCHEMA,
});
