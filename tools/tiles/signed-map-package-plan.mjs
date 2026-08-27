import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  buildMapDeliveryRelease,
  canonicalEd25519SpkiPublicKey,
  deliveryReleaseHash,
  inventoryMapDeliveryPackageArtifacts,
  serializeDeliveryJson,
  verifyMapDeliveryReleaseSignature,
} from "./map-delivery-release.mjs";
import {
  expandMapPackagePlan,
  validateMapPackageSpec,
  validatePortableRelativePath,
} from "./map-package.mjs";
import { assertCreateNewTarget, publishFileCreateNew } from "./create-new-output.mjs";

const MAP_PACKAGE_PLAN_V2 = "zugfolge-map-package-plan/v2";
const MAP_RUNTIME_V2 = "zugfolge-map-runtime/v2";
const DELIVERY_RELEASE_V2 = "zugfolge-map-delivery-release/v2";
const UNSIGNED_RELEASE_SUFFIX = "/delivery-unsigned/release.json";
const SIGNED_RELEASE_SUFFIX = "/public/release.json";
const SHA256 = /^[a-f0-9]{64}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_TRUSTED_KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} ist kein Objekt.`);
  invariant(
    Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000"),
    `${label} besitzt unerwartete oder fehlende Felder.`,
  );
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalValueSha256(value) {
  return sha256(Buffer.from(JSON.stringify(sortedValue(value)), "utf8"));
}

function parseCanonicalDelivery(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} ist kein gueltiges JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant(serializeDeliveryJson(value).equals(bytes), `${label} besitzt keine kanonischen Delivery-JSON-Bytes.`);
  return value;
}

async function readContainedRegularFile(sourceRoot, portablePath, label) {
  validatePortableRelativePath(portablePath, label);
  const requestedRoot = resolve(sourceRoot);
  const rootMetadata = await lstat(requestedRoot);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Quellwurzel muss ein regulaeres Verzeichnis ohne symbolischen Link sein.");
  const canonicalRoot = await realpath(requestedRoot);
  let current = canonicalRoot;
  for (const segment of portablePath.split("/")) {
    current = join(current, segment);
    const metadata = await lstat(current);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
  }
  const canonicalPath = await realpath(current);
  const remainder = relative(canonicalRoot, canonicalPath);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlaesst die Quellwurzel.`);
  const metadata = await lstat(canonicalPath);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} muss eine regulaere Datei sein.`);
  return readFile(canonicalPath);
}

function releaseDescriptor(plan) {
  invariant(Array.isArray(plan?.auxiliaryFiles), "Operational-v2-Paketplan braucht direkte Hilfsdateien.");
  const releases = plan.auxiliaryFiles.filter((descriptor) => descriptor?.kind === "release-manifest");
  invariant(releases.length === 1, "Operational-v2-Paketplan braucht genau einen Release-Manifest-Descriptor.");
  const [descriptor] = releases;
  invariant(
    descriptor.id === "release-manifest"
      && descriptor.visibility === "public"
      && descriptor.installPath === "manifests/release.json",
    "Release-Manifest-Descriptor weicht von der festen oeffentlichen Paketrolle ab.",
  );
  return descriptor;
}

export function deriveSignedReleaseSourceFile(unsignedSourceFile) {
  validatePortableRelativePath(unsignedSourceFile, "Unsigned Release-Manifest-Quelle");
  invariant(
    unsignedSourceFile.endsWith(UNSIGNED_RELEASE_SUFFIX),
    `Unsigned Release-Manifest-Quelle muss auf ${UNSIGNED_RELEASE_SUFFIX.slice(1)} enden.`,
  );
  return `${unsignedSourceFile.slice(0, -UNSIGNED_RELEASE_SUFFIX.length)}${SIGNED_RELEASE_SUFFIX}`;
}

function currentReleaseSourceFiles(unsignedSourceFile) {
  const releaseRoot = unsignedSourceFile.slice(0, -UNSIGNED_RELEASE_SUFFIX.length);
  return {
    infraRelease: `${releaseRoot}/public/infra-release.json`,
    mapRelease: `${releaseRoot}/public/map-release.json`,
  };
}

function materializedRelease(bytes, schema, label) {
  const wrapper = exactKeys(parseJson(bytes, label), ["release", "releaseHash"], `${label}-Huelle`);
  invariant(SHA256.test(wrapper.releaseHash), `${label}-Huelle besitzt keinen gueltigen releaseHash.`);
  invariant(
    wrapper.releaseHash === canonicalValueSha256(wrapper.release),
    `${label}-Huelle bindet nicht ihren aktuellen kanonischen Releaseinhalt.`,
  );
  invariant(wrapper.release?.schema === schema, `${label} hat ein unbekanntes Schema.`);
  return wrapper;
}

function oneByKind(entries, kind, label) {
  const matches = entries.filter((entry) => entry?.kind === kind);
  invariant(matches.length === 1, `${label} braucht genau einen ${kind}-Eintrag.`);
  return matches[0];
}

function descriptorForKind(spec, kind) {
  return oneByKind([...spec.artifacts, ...spec.auxiliaryFiles], kind, "Aktueller expandierter Paketvertrag");
}

function currentArtifactForDescriptor(currentArtifacts, descriptor) {
  const matches = currentArtifacts.filter(({ id }) => id === descriptor.id);
  invariant(matches.length === 1, `Aktuelles Paketinventar braucht genau den Eintrag ${descriptor.id}.`);
  const [artifact] = matches;
  invariant(
    artifact.kind === descriptor.kind && artifact.installPath === descriptor.installPath,
    `Aktuelles Paketinventar bildet Rolle oder Installationspfad von ${descriptor.id} nicht exakt ab.`,
  );
  return artifact;
}

function validateCurrentMapArtifacts(mapRelease, currentArtifacts, spec) {
  invariant(Array.isArray(mapRelease.artifacts) && mapRelease.artifacts.length === 2, "Aktueller Kartenrelease braucht genau zwei PMTiles-Artefaktbindungen.");
  for (const kind of ["basemap", "infrastructure"]) {
    const descriptor = descriptorForKind(spec, kind);
    const current = currentArtifactForDescriptor(currentArtifacts, descriptor);
    const binding = oneByKind(mapRelease.artifacts, kind, "Aktueller Kartenrelease");
    invariant(
      binding.bytes === current.bytes && binding.sha256 === current.sha256,
      `Aktueller Kartenrelease und aktuelles Paketinventar binden verschiedene ${kind}-Bytes.`,
    );
  }
}

function validateCurrentInfraArtifacts(infraRelease, currentArtifacts, spec, releaseId) {
  invariant(Array.isArray(infraRelease.artifacts), "Aktueller InfraRelease besitzt kein Artefaktinventar.");
  const mappings = [
    ["infrastructure", "infrastructure"],
    ["read-model", "read-model"],
    ["operational-infrastructure-v2", "operational-infrastructure-v2"],
    ["movement-route-templates-v2", "movement-route-templates-v2"],
    ["timetable-transfer-demands-v2", "timetable-transfer-demands-v2"],
    ["quality-report", "quality-manifest"],
  ];
  const requiredPackageKinds = new Set([
    "operational-infrastructure-v2",
    "movement-route-templates-v2",
    "timetable-transfer-demands-v2",
  ]);
  for (const [releaseKind, packageKind] of mappings) {
    const releaseBindings = infraRelease.artifacts.filter((entry) => entry?.kind === releaseKind);
    if (!requiredPackageKinds.has(packageKind) && releaseBindings.length === 0) continue;
    invariant(releaseBindings.length === 1, `Aktueller InfraRelease braucht genau eine ${releaseKind}-Bindung.`);
    const descriptor = descriptorForKind(spec, packageKind);
    const current = currentArtifactForDescriptor(currentArtifacts, descriptor);
    const [binding] = releaseBindings;
    invariant(
      binding.file === descriptor.sourceFile.split("/").at(-1)
        && binding.bytes === current.bytes
        && binding.sha256 === current.sha256,
      `Aktueller InfraRelease und aktuelles Paketinventar binden verschiedene ${releaseKind}-Dateien.`,
    );
    if (packageKind === "operational-infrastructure-v2") {
      invariant(
        binding.id === current.id
          && binding.infraReleaseId === releaseId
          && current.infraReleaseId === releaseId
          && binding.stateHash === current.stateHash
          && SHA256.test(current.stateHash),
        "Aktueller InfraRelease, Delivery und Paketplan binden nicht denselben Operational-v2-Zustand.",
      );
    }
  }
}

async function validateCurrentUnsignedDelivery(release, spec, sourceRoot, unsignedSourceFile) {
  const sourceDescriptors = spec.auxiliaryFiles.filter(({ kind }) => kind === "source-manifest");
  invariant(sourceDescriptors.length === 1, "Aktueller Paketvertrag braucht genau ein Sources-v2-Manifest.");
  const sourceDescriptor = sourceDescriptors[0];
  const qualityDescriptor = descriptorForKind(spec, "quality-manifest");
  const releaseSources = currentReleaseSourceFiles(unsignedSourceFile);
  const [currentArtifacts, sourcesBytes, qualityBytes, infraBytes, mapBytes] = await Promise.all([
    inventoryMapDeliveryPackageArtifacts({ packageSpec: spec, sourceRoot }),
    readContainedRegularFile(sourceRoot, sourceDescriptor.sourceFile, "Aktuelles Sources-v2-Manifest"),
    readContainedRegularFile(sourceRoot, qualityDescriptor.sourceFile, "Aktueller Qualitaetsbericht"),
    readContainedRegularFile(sourceRoot, releaseSources.infraRelease, "Aktueller InfraRelease"),
    readContainedRegularFile(sourceRoot, releaseSources.mapRelease, "Aktueller Kartenrelease"),
  ]);

  invariant(
    sameJson(release.artifacts, currentArtifacts),
    "Unsigned Delivery-v2-Artefakte stimmen nicht exakt mit dem aktuellen expandierten Paketinventar (ID, Rolle, Installationspfad, Bytes, SHA-256 und Operational-Bindung) ueberein.",
  );
  const bindings = exactKeys(release.bindings, [
    "packageManifestSchema", "infraReleaseSchema", "mapReleaseSchema", "sourcesSha256",
    "qualitySha256", "infraReleaseHash", "mapReleaseHash",
  ], "Unsigned Delivery-v2-Bindungen");
  invariant(
    bindings.packageManifestSchema === "zugfolge-map-package/v2"
      && bindings.infraReleaseSchema === "zugfolge-infra-release/v2"
      && bindings.mapReleaseSchema === "zugfolge-map-release/v1",
    "Unsigned Delivery-v2 bindet nicht die festen Operational-v2-Paket- und Release-Schemata.",
  );

  const sources = parseCanonicalDelivery(sourcesBytes, "Aktuelles Sources-v2-Manifest");
  invariant(
    sources?.schema === "zugfolge-map-delivery-sources/v2"
      && sources.releaseId === release.releaseId
      && Array.isArray(sources.sources)
      && Array.isArray(sources.assetNotices?.assets)
      && bindings.sourcesSha256 === sha256(sourcesBytes),
    "Unsigned Delivery-v2 bindet nicht das aktuelle Sources-v2-Manifest.",
  );
  const qualityArtifact = currentArtifactForDescriptor(currentArtifacts, qualityDescriptor);
  invariant(
    bindings.qualitySha256 === qualityArtifact.sha256
      && qualityArtifact.bytes === qualityBytes.length
      && qualityArtifact.sha256 === sha256(qualityBytes),
    "Unsigned Delivery-v2 bindet nicht den aktuellen Qualitaetsbericht.",
  );
  const infraWrapper = materializedRelease(infraBytes, "zugfolge-infra-release/v2", "Aktueller InfraRelease");
  const mapWrapper = materializedRelease(mapBytes, "zugfolge-map-release/v1", "Aktueller Kartenrelease");
  invariant(
    bindings.infraReleaseHash === infraWrapper.releaseHash
      && bindings.mapReleaseHash === mapWrapper.releaseHash,
    "Unsigned Delivery-v2 bindet nicht die aktuellen Infra-/Kartenrelease-Hashes.",
  );
  invariant(
    infraWrapper.release.releaseId === release.releaseId
      && infraWrapper.release.timetableYear === release.timetableYear
      && mapWrapper.release.releaseId === release.releaseId,
    "Unsigned Delivery-v2, InfraRelease und Kartenrelease besitzen keine gemeinsame Release-Identitaet.",
  );
  validateCurrentInfraArtifacts(infraWrapper.release, currentArtifacts, spec, release.releaseId);
  validateCurrentMapArtifacts(mapWrapper.release, currentArtifacts, spec);
  const auxiliaryArtifactProofs = spec.auxiliaryFiles
    .filter(({ kind }) => ["read-model", "train-map-projection"].includes(kind))
    .map((descriptor) => {
      const artifact = currentArtifactForDescriptor(currentArtifacts, descriptor);
      return { id: artifact.id, bytes: artifact.bytes, sha256: artifact.sha256 };
    });
  const rebuilt = await buildMapDeliveryRelease({
    releaseId: release.releaseId,
    timetableYear: release.timetableYear,
    packageSpec: spec,
    sourceRoot,
    infraRelease: infraWrapper,
    mapRelease: mapWrapper,
    auxiliaryArtifactProofs,
  });
  invariant(
    rebuilt.releaseBytes.equals(serializeDeliveryJson(release)) && rebuilt.sourcesBytes.equals(sourcesBytes),
    "Unsigned Delivery-v2 und Sources-v2 sind nicht bytegleich aus dem strikten aktuellen Delivery-Builder neu materialisierbar.",
  );
  return {
    artifacts: currentArtifacts,
    sources: { bytes: sourcesBytes.length, sha256: sha256(sourcesBytes) },
  };
}

function validateUnsignedRelease(release, plan, descriptor, actualBinding) {
  invariant(release?.schema === DELIVERY_RELEASE_V2, "Unsigned Release-Manifest muss Delivery-v2 sein.");
  invariant(release.packageId === plan.packageId && release.packageVersion === plan.version, "Unsigned Delivery-Identitaet weicht vom Operational-v2-Paketplan ab.");
  const signatureGate = exactKeys(release?.approvalGates?.signature, ["status", "reason"], "Unsigned Delivery-v2-Signaturgate");
  invariant(
    release?.approvalGates?.rights?.status === "passed"
      && release?.approvalGates?.quality?.status === "passed"
      && signatureGate.status === "missing"
      && typeof signatureGate.reason === "string"
      && signatureGate.reason.trim() !== ""
      && release.releaseHash === null
      && release.signature === null,
    "Unsigned Release-Manifest besitzt keinen explizit freigegebenen, unsignierten Delivery-v2-Vertrag.",
  );
  const hasExpectedBytes = Object.hasOwn(descriptor, "expectedBytes");
  const hasExpectedSha256 = Object.hasOwn(descriptor, "expectedSha256");
  invariant(hasExpectedBytes === hasExpectedSha256, "Unsigned Release-Manifest-Descriptor besitzt nur einen halben Byte-SHA-Beleg.");
  if (hasExpectedBytes) {
    invariant(
      descriptor.expectedBytes === actualBinding.bytes && descriptor.expectedSha256 === actualBinding.sha256,
      "Unsigned Release-Manifest-Descriptor stimmt nicht mit seinen realen Bytes ueberein.",
    );
  }
}

function validateSignedRelease(unsignedRelease, signedRelease, plan) {
  invariant(signedRelease?.schema === DELIVERY_RELEASE_V2, "Signiertes Release-Manifest muss Delivery-v2 sein.");
  invariant(signedRelease.packageId === plan.packageId && signedRelease.packageVersion === plan.version, "Signierte Delivery-Identitaet weicht vom Operational-v2-Paketplan ab.");
  const gate = exactKeys(signedRelease?.approvalGates?.signature, ["status", "algorithm", "keyId"], "Signiertes Delivery-v2-Signaturgate");
  const signature = exactKeys(signedRelease?.signature, ["algorithm", "keyId", "valueBase64"], "Signierte Delivery-v2-Signatur");
  invariant(
    gate?.status === "passed"
      && gate.algorithm === "Ed25519"
      && STABLE_ID.test(gate.keyId ?? "")
      && signature?.algorithm === "Ed25519"
      && signature.keyId === gate.keyId
      && typeof signature.valueBase64 === "string",
    "Signiertes Release-Manifest besitzt keine konsistente Ed25519-Signaturhuelle.",
  );
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  invariant(
    signatureBytes.length === 64 && signatureBytes.toString("base64") === signature.valueBase64,
    "Signiertes Release-Manifest besitzt keine kanonischen Ed25519-Signaturbytes.",
  );
  invariant(
    SHA256.test(signedRelease.releaseHash) && signedRelease.releaseHash === deliveryReleaseHash(signedRelease),
    "Signiertes Release-Manifest besitzt keinen konsistenten Delivery-Release-Hash.",
  );
  const expectedSignedRelease = {
    ...unsignedRelease,
    approvalGates: {
      ...unsignedRelease.approvalGates,
      signature: gate,
    },
    releaseHash: signedRelease.releaseHash,
    signature,
  };
  invariant(
    sameJson(signedRelease, expectedSignedRelease),
    "Signierter Deliveryvertrag veraendert ausser Signaturgate, Release-Hash und Signatur weitere fachliche Felder.",
  );
}

function parseTrustedDeliveryKeys(trustedKeysBytes) {
  const trustedDeliveryKeys = parseJson(trustedKeysBytes, "Delivery-Keyring");
  invariant(
    trustedDeliveryKeys !== null && typeof trustedDeliveryKeys === "object" && !Array.isArray(trustedDeliveryKeys),
    "Delivery-Keyring ist kein Objekt.",
  );
  invariant(Object.keys(trustedDeliveryKeys).length > 0, "Delivery-Keyring ist leer.");
  for (const [keyId, publicKeyPem] of Object.entries(trustedDeliveryKeys)) {
    invariant(SAFE_TRUSTED_KEY_ID.test(keyId), "Delivery-Keyring enthaelt keine gueltige Schluessel-ID.");
    canonicalEd25519SpkiPublicKey(publicKeyPem, `Delivery-Keyring.${keyId}`);
  }
  return trustedDeliveryKeys;
}

function scopedTrustedKeyIds(value, label) {
  invariant(
    Array.isArray(value)
      && value.length > 0
      && value.every((entry) => typeof entry === "string" && SAFE_TRUSTED_KEY_ID.test(entry)),
    `${label} muss eine nichtleere Liste sicherer Schluessel-IDs sein.`,
  );
  const ids = [...value].sort((left, right) => left.localeCompare(right, "en"));
  invariant(new Set(ids).size === ids.length, `${label} enthaelt doppelte Schluessel-IDs.`);
  return ids;
}

function parseTrustedDeliveryKeyScopes(trustedKeyScopesBytes, trustedDeliveryKeys) {
  const scopes = parseJson(trustedKeyScopesBytes, "Delivery-Key-Scope-Vertrag");
  exactKeys(scopes, ["alphaWorldDeployments", "mapInfraDeliveries"], "Delivery-Key-Scope-Vertrag");
  const alphaWorldKeyIds = scopedTrustedKeyIds(scopes.alphaWorldDeployments, "alphaWorldDeployments");
  const mapInfraKeyIds = scopedTrustedKeyIds(scopes.mapInfraDeliveries, "mapInfraDeliveries");
  const alphaWorldKeySet = new Set(alphaWorldKeyIds);
  const overlap = mapInfraKeyIds.find((keyId) => alphaWorldKeySet.has(keyId));
  invariant(overlap === undefined, `Release-Schluessel '${overlap}' darf nicht mehreren Protokollrollen angehoeren.`);
  const assigned = [...alphaWorldKeyIds, ...mapInfraKeyIds].sort((left, right) => left.localeCompare(right, "en"));
  const available = Object.keys(trustedDeliveryKeys).sort((left, right) => left.localeCompare(right, "en"));
  invariant(
    assigned.join("\0") === available.join("\0"),
    "Release-Key-Allow-lists muessen den kanonischen Public-Keyring disjunkt und vollstaendig abdecken.",
  );
  const mapInfraDeliveries = Object.fromEntries(mapInfraKeyIds.map((keyId) => {
    const publicKeyPem = trustedDeliveryKeys[keyId];
    invariant(publicKeyPem !== undefined, `Map-/Infra-Allow-list referenziert den unbekannten Schluessel '${keyId}'.`);
    return [keyId, publicKeyPem];
  }));
  for (const keyId of alphaWorldKeyIds) {
    invariant(
      trustedDeliveryKeys[keyId] !== undefined,
      `Alpha-Welt-Allow-list referenziert den unbekannten Schluessel '${keyId}'.`,
    );
  }
  return mapInfraDeliveries;
}

function validateTrustedDeliverySignature(signedRelease, trustedMapInfraKeys) {
  invariant(
    trustedMapInfraKeys !== null && typeof trustedMapInfraKeys === "object" && !Array.isArray(trustedMapInfraKeys),
    "Map-/Infra-Vertrauensanker fuer den signierten Deliveryvertrag fehlen.",
  );
  const publicKeyPem = trustedMapInfraKeys[signedRelease.signature.keyId];
  invariant(typeof publicKeyPem === "string", `Map-/Infra-Allow-list kennt ${signedRelease.signature.keyId} nicht.`);
  invariant(
    verifyMapDeliveryReleaseSignature(signedRelease, publicKeyPem),
    "Signiertes Release-Manifest besteht die kryptografische Ed25519-Pruefung nicht.",
  );
}

function pinExpandedUnsignedSpec(packageSpec, currentInventory, unsignedBinding) {
  const currentById = new Map(currentInventory.artifacts.map((artifact) => [artifact.id, artifact]));
  const pin = (descriptor) => {
    const proof = descriptor.kind === "release-manifest"
      ? unsignedBinding
      : descriptor.kind === "source-manifest"
        ? currentInventory.sources
        : currentById.get(descriptor.id);
    invariant(
      proof !== undefined && Number.isSafeInteger(proof.bytes) && proof.bytes > 0 && SHA256.test(proof.sha256),
      `Vollstaendig expandierter Signed-Paketvertrag kann ${descriptor.id} nicht bytegenau pinnen.`,
    );
    return { ...descriptor, expectedBytes: proof.bytes, expectedSha256: proof.sha256 };
  };
  const pinned = {
    ...packageSpec,
    artifacts: packageSpec.artifacts.map(pin),
    auxiliaryFiles: packageSpec.auxiliaryFiles.map(pin),
  };
  const restorePins = (descriptor, original) => {
    const restored = { ...descriptor };
    delete restored.expectedBytes;
    delete restored.expectedSha256;
    if (Object.hasOwn(original, "expectedBytes")) restored.expectedBytes = original.expectedBytes;
    if (Object.hasOwn(original, "expectedSha256")) restored.expectedSha256 = original.expectedSha256;
    return restored;
  };
  const restoredExpandedSpec = {
    ...pinned,
    artifacts: pinned.artifacts.map((descriptor, index) => restorePins(descriptor, packageSpec.artifacts[index])),
    auxiliaryFiles: pinned.auxiliaryFiles.map((descriptor, index) => restorePins(descriptor, packageSpec.auxiliaryFiles[index])),
  };
  invariant(
    sameJson(restoredExpandedSpec, packageSpec),
    "Vollstaendige Byte-SHA-Pinnung darf den expandierten unsigned Paketvertrag fachlich nicht veraendern.",
  );
  validateMapPackageSpec(pinned);
  invariant(
    [...pinned.artifacts, ...pinned.auxiliaryFiles].every(({ expectedBytes, expectedSha256 }) => (
      Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && SHA256.test(expectedSha256)
    )),
    "Signed-Paketvertrag muss jede expandierte Paketdatei bytegenau pinnen.",
  );
  return pinned;
}

function buildSignedPlan(pinnedUnsignedSpec, signedSourceFile, signedBinding) {
  const descriptor = releaseDescriptor(pinnedUnsignedSpec);
  const signedDescriptor = {
    ...descriptor,
    sourceFile: signedSourceFile,
    expectedBytes: signedBinding.bytes,
    expectedSha256: signedBinding.sha256,
  };
  const signedPlan = {
    ...pinnedUnsignedSpec,
    auxiliaryFiles: pinnedUnsignedSpec.auxiliaryFiles.map((entry) => entry === descriptor ? signedDescriptor : entry),
  };

  const restoredDescriptor = { ...signedDescriptor, sourceFile: descriptor.sourceFile };
  restoredDescriptor.expectedBytes = descriptor.expectedBytes;
  restoredDescriptor.expectedSha256 = descriptor.expectedSha256;
  const restoredPlan = {
    ...signedPlan,
    auxiliaryFiles: signedPlan.auxiliaryFiles.map((entry) => entry === signedDescriptor ? restoredDescriptor : entry),
  };
  invariant(
    sameJson(restoredPlan, pinnedUnsignedSpec),
    "Signed-Paketplan wuerde mehr als Releasequelle und deren zwingende Byte-SHA-Bindung veraendern.",
  );
  return signedPlan;
}

export async function preflightUnsignedMapDeliveryRelease(unsignedPlan, sourceRoot) {
  invariant(unsignedPlan?.schema === MAP_PACKAGE_PLAN_V2, "Delivery-v2-Signatur verlangt zugfolge-map-package-plan/v2.");
  invariant(unsignedPlan?.runtime?.schema === MAP_RUNTIME_V2, "Delivery-v2-Signatur verlangt unveraendert zugfolge-map-runtime/v2.");
  const descriptor = releaseDescriptor(unsignedPlan);
  const [packageSpec, releaseBytes] = await Promise.all([
    expandMapPackagePlan(unsignedPlan, sourceRoot),
    readContainedRegularFile(sourceRoot, descriptor.sourceFile, "Unsigned Release-Manifest"),
  ]);
  invariant(packageSpec.runtime.schema === MAP_RUNTIME_V2, "Expandierter unsigned Paketvertrag hat den Runtime-v2-Vertrag verloren.");
  const releaseBinding = { bytes: releaseBytes.length, sha256: sha256(releaseBytes) };
  const release = parseCanonicalDelivery(releaseBytes, "Unsigned Release-Manifest");
  validateUnsignedRelease(release, unsignedPlan, descriptor, releaseBinding);
  const currentInventory = await validateCurrentUnsignedDelivery(release, packageSpec, sourceRoot, descriptor.sourceFile);
  return {
    release,
    releaseBytes,
    releaseSha256: releaseBinding.sha256,
    releaseSourceFile: descriptor.sourceFile,
    releasePath: resolve(sourceRoot, ...descriptor.sourceFile.split("/")),
    packageSpec,
    currentInventory,
  };
}

export async function deriveSignedMapPackagePlan(
  unsignedPlan,
  sourceRoot,
  trustedKeysSourceFile,
  trustedKeyScopesSourceFile,
) {
  invariant(unsignedPlan?.schema === MAP_PACKAGE_PLAN_V2, "Signed-Paketplan kann nur aus zugfolge-map-package-plan/v2 abgeleitet werden.");
  invariant(unsignedPlan?.runtime?.schema === MAP_RUNTIME_V2, "Signed-Paketplan verlangt unveraendert zugfolge-map-runtime/v2.");
  validatePortableRelativePath(trustedKeysSourceFile, "Delivery-Keyring");
  validatePortableRelativePath(trustedKeyScopesSourceFile, "Delivery-Key-Scope-Vertrag");
  const descriptor = releaseDescriptor(unsignedPlan);
  const signedSourceFile = deriveSignedReleaseSourceFile(descriptor.sourceFile);

  const [unsignedPreflight, signedBytes, trustedKeysBytes, trustedKeyScopesBytes] = await Promise.all([
    preflightUnsignedMapDeliveryRelease(unsignedPlan, sourceRoot),
    readContainedRegularFile(sourceRoot, signedSourceFile, "Signiertes Release-Manifest"),
    readContainedRegularFile(sourceRoot, trustedKeysSourceFile, "Delivery-Keyring"),
    readContainedRegularFile(sourceRoot, trustedKeyScopesSourceFile, "Delivery-Key-Scope-Vertrag"),
  ]);

  const signedBinding = { bytes: signedBytes.length, sha256: sha256(signedBytes) };
  const unsignedRelease = unsignedPreflight.release;
  const signedRelease = parseCanonicalDelivery(signedBytes, "Signiertes Release-Manifest");
  validateSignedRelease(unsignedRelease, signedRelease, unsignedPlan);
  const trustedDeliveryKeys = parseTrustedDeliveryKeys(trustedKeysBytes);
  const trustedMapInfraKeys = parseTrustedDeliveryKeyScopes(trustedKeyScopesBytes, trustedDeliveryKeys);
  validateTrustedDeliverySignature(signedRelease, trustedMapInfraKeys);

  const pinnedUnsignedSpec = pinExpandedUnsignedSpec(
    unsignedPreflight.packageSpec,
    unsignedPreflight.currentInventory,
    { bytes: unsignedPreflight.releaseBytes.length, sha256: unsignedPreflight.releaseSha256 },
  );
  const signedPlan = buildSignedPlan(pinnedUnsignedSpec, signedSourceFile, signedBinding);
  const signedSpec = validateMapPackageSpec(signedPlan);
  invariant(signedSpec.runtime.schema === MAP_RUNTIME_V2, "Expandierter signed Paketvertrag hat den Runtime-v2-Vertrag verloren.");
  const operational = signedSpec.auxiliaryFiles.filter(({ kind }) => kind === "operational-infrastructure-v2");
  invariant(
    operational.length === 1 && operational[0].infraReleaseId === signedRelease.releaseId,
    "Signierter Deliveryvertrag und Operational-v2-Artefaktinventar binden nicht denselben InfraRelease.",
  );

  return {
    plan: signedPlan,
    signedReleaseSourceFile: signedSourceFile,
    signedReleaseBytes: signedBinding.bytes,
    signedReleaseSha256: signedBinding.sha256,
    releaseId: signedRelease.releaseId,
    keyId: signedRelease.signature.keyId,
    trustedKeysSourceFile,
    trustedKeyScopesSourceFile,
  };
}

export function serializeSignedMapPackagePlan(plan) {
  return Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

export async function writeSignedMapPackagePlan(plan, outputPath) {
  const output = resolve(outputPath);
  const bytes = serializeSignedMapPackagePlan(plan);
  await assertCreateNewTarget(output, "Signed-Paketplan-Ziel");
  await mkdir(dirname(output), { recursive: true });
  const temporaryRoot = await mkdtemp(join(dirname(output), `.${basename(output)}.writing-`));
  const temporaryPath = join(temporaryRoot, basename(output));
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publishFileCreateNew(temporaryPath, output, "Signed-Paketplan-Ziel");
    return { status: "written", outputPath: output, bytes: bytes.length, sha256: sha256(bytes) };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
