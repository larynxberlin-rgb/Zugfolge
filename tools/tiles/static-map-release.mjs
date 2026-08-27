import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { inspectPublicReadModel } from "./livemap-read-model.mjs";
import { assertCreateNewTarget, publishDirectoryCreateNew } from "./create-new-output.mjs";
import { validateMapAssetNoticeBindings, validateMapAssetNotices } from "./map-asset-notices.mjs";
import { validateStaticMapQuality } from "./static-map-quality.mjs";
import {
  BASEMAP_VECTOR_LAYERS,
  INFRASTRUCTURE_VECTOR_LAYERS,
  expandMapPackagePlan,
  inspectPmtilesFile,
  validatePublicMapPackageJson,
  validateRuntimeStyle,
  validateStaticMapReleaseDocument,
  validatePortableRelativePath,
} from "./map-package.mjs";

export const STATIC_MAP_RELEASE_MATERIALIZATION_SCHEMA = "zugfolge-static-map-release-materialization/v2";
export const STATIC_MAP_PACKAGE_PLAN_SCHEMA = "zugfolge-static-map-package-plan/v2";
export const STATIC_MAP_RELEASE_SCHEMA = "zugfolge-static-map-release/v2";

const REQUIRED_AUXILIARY_KINDS = Object.freeze(["quality-manifest", "read-model", "source-manifest", "style"]);
const STATIC_CLAIM_KEYS = Object.freeze(["operationalInfraRelease", "productionActivationEligible", "signatureStatus"]);
const SHA256 = /^[a-f0-9]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function serialize(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function validateClaims(claims) {
  invariant(claims !== null && typeof claims === "object" && !Array.isArray(claims), "claims fehlt.");
  invariant(Object.keys(claims).sort().join(",") === [...STATIC_CLAIM_KEYS].sort().join(","), "claims besitzt unerwartete oder fehlende Felder.");
  invariant(claims.operationalInfraRelease === false, "claims.operationalInfraRelease muss false sein.");
  invariant(claims.productionActivationEligible === false, "claims.productionActivationEligible muss false sein.");
  invariant(claims.signatureStatus === "unsigned", "claims.signatureStatus muss unsigned sein.");
}

function validateCutover(cutover) {
  invariant(cutover !== null && typeof cutover === "object" && !Array.isArray(cutover), "cutover fehlt.");
  invariant(Object.keys(cutover).sort().join(",") === "javascriptOperationalFallback,legacyTrainMapProjection,trainPositionEstimates,waypointFallback", "cutover besitzt unerwartete oder fehlende Felder.");
  invariant(Object.values(cutover).every((value) => value === false), "Der harte Karten-Cutover muss Legacy train-map-projection, Waypoints, Estimates und JavaScript-Fallback abschalten.");
}

function validateMaterializationSpec(spec) {
  invariant(spec?.schema === STATIC_MAP_RELEASE_MATERIALIZATION_SCHEMA, "Unbekannte statische Kartenrelease-Materialisierung.");
  validatePortableRelativePath(`${spec.releaseId}.json`, "releaseId");
  validatePortableRelativePath(`${spec.packageId}.json`, "packageId");
  validatePortableRelativePath(`${spec.version}.json`, "version");
  validatePortableRelativePath(`${spec.corpusId}.json`, "corpusId");
  validateClaims(spec.claims);
  validateCutover(spec.cutover);
  invariant(Number.isSafeInteger(spec.partBytes) && spec.partBytes > 0 && spec.partBytes < 2 * 1024 * 1024 * 1024, "partBytes ist ungueltig.");
  invariant(spec.runtime?.schema === "zugfolge-map-runtime/v2", "Statischer Karten-Cutover braucht den Runtime-Vertrag zugfolge-map-runtime/v2.");
  invariant(Array.isArray(spec.artifacts) && spec.artifacts.length === 2, "Materialisierung braucht Basemap und Infrastruktur-PMTiles.");
  const artifactKinds = spec.artifacts.map(({ kind }) => kind).sort();
  invariant(JSON.stringify(artifactKinds) === JSON.stringify(["basemap", "infrastructure"]), "Materialisierung braucht genau Basemap und Infrastruktur-PMTiles.");
  for (const artifact of spec.artifacts) {
    validatePortableRelativePath(artifact.sourceFile, `${artifact.id}.sourceFile`);
    validatePortableRelativePath(artifact.installPath, `${artifact.id}.installPath`);
    invariant(artifact.sourceFile.endsWith(".pmtiles") && artifact.installPath.endsWith(".pmtiles"), `${artifact.id} muss PMTiles binden.`);
    invariant(artifact.expectedBytes === undefined && artifact.expectedSha256 === undefined, `${artifact.id} darf keinen ungeprueften Vorabhash tragen; die Materialisierung berechnet ihn aus den realen Bytes.`);
    const expectedLayers = artifact.kind === "basemap" ? BASEMAP_VECTOR_LAYERS : INFRASTRUCTURE_VECTOR_LAYERS;
    invariant(JSON.stringify([...artifact.expectedVectorLayers].sort()) === JSON.stringify(expectedLayers), `${artifact.id} verletzt den festen Layervertrag.`);
  }
  invariant(Array.isArray(spec.auxiliaryFiles) && spec.auxiliaryFiles.length === REQUIRED_AUXILIARY_KINDS.length, "Materialisierung braucht Style, ReadModel, Qualitaet und Quellen.");
  const auxiliaryKinds = spec.auxiliaryFiles.map(({ kind }) => kind).sort();
  invariant(JSON.stringify(auxiliaryKinds) === JSON.stringify([...REQUIRED_AUXILIARY_KINDS].sort()), "Materialisierung darf weder Operational-v2 noch Legacy-Projektion enthalten.");
  for (const descriptor of spec.auxiliaryFiles) {
    validatePortableRelativePath(descriptor.sourceFile, `${descriptor.id}.sourceFile`);
    validatePortableRelativePath(descriptor.installPath, `${descriptor.id}.installPath`);
    invariant(descriptor.visibility === "public", `${descriptor.id} muss oeffentlich sein.`);
    invariant(descriptor.expectedBytes === undefined && descriptor.expectedSha256 === undefined, `${descriptor.id} darf keinen ungeprueften Vorabhash tragen.`);
  }
  invariant(Array.isArray(spec.auxiliaryTrees) && spec.auxiliaryTrees.length === 2, "Materialisierung braucht lokale Glyphen- und Spritebaeume.");
  invariant(JSON.stringify(spec.auxiliaryTrees.map(({ kind }) => kind).sort()) === JSON.stringify(["glyph", "sprite"]), "Materialisierung braucht genau Glyphen- und Spritebaeume.");
  return spec;
}

async function fileProof(path, label) {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} muss eine regulaere Datei sein.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function containedPath(root, portable, label) {
  validatePortableRelativePath(portable, label);
  const path = resolve(root, ...portable.split("/"));
  const remainder = relative(root, path);
  invariant(remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder), `${label} verlaesst die Quellwurzel.`);
  return path;
}

async function containedRegularFile(root, portable, label) {
  const path = containedPath(root, portable, label);
  let current = root;
  const segments = portable.split("/");
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const metadata = await lstat(current);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
    invariant(index === segments.length - 1 ? metadata.isFile() : metadata.isDirectory(), `${label} ist kein regulaerer Dateipfad.`);
  }
  return path;
}

async function readPublicJson(path, label) {
  const bytes = await readFile(path);
  invariant(bytes.length > 0 && bytes.length <= 32 * 1024 * 1024, `${label} hat eine unzulässige Groesse.`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} ist kein gueltiges JSON.`);
  }
  validatePublicMapPackageJson(value, label);
  return value;
}

function pinned(descriptor, proof) {
  return { ...descriptor, expectedBytes: proof.bytes, expectedSha256: proof.sha256 };
}

async function inspectCoreInputs(spec, sourceRoot) {
  const proofById = new Map();
  for (const artifact of spec.artifacts) {
    const path = await containedRegularFile(sourceRoot, artifact.sourceFile, `${artifact.id}.sourceFile`);
    const inspection = await inspectPmtilesFile(path, artifact.id);
    invariant(JSON.stringify(inspection.vectorLayerIds) === JSON.stringify([...artifact.expectedVectorLayers].sort()), `${artifact.id} enthaelt nicht exakt die erwarteten Vektorlayer.`);
    proofById.set(artifact.id, await fileProof(path, artifact.id));
  }
  for (const descriptor of spec.auxiliaryFiles) {
    const path = await containedRegularFile(sourceRoot, descriptor.sourceFile, `${descriptor.id}.sourceFile`);
    if (descriptor.kind === "read-model") {
      const inspection = await inspectPublicReadModel(path);
      invariant(inspection.infrastructureReleaseId === spec.corpusId, "ReadModel gehoert zu einem anderen Infrastrukturkorpus.");
    } else if (descriptor.kind === "quality-manifest") {
      const quality = await readPublicJson(path, descriptor.id);
      validateStaticMapQuality(quality, { releaseId: spec.releaseId, infrastructureCorpusId: spec.corpusId });
    } else if (descriptor.kind === "source-manifest") {
      const sources = await readPublicJson(path, descriptor.id);
      invariant(sources.schema === "zugfolge-static-map-sources/v3" && sources.releaseId === spec.corpusId && Array.isArray(sources.sources) && sources.sources.length > 0, "Quellenmanifest gehoert nicht zum statischen Karten-v3-Korpus oder ist leer.");
      invariant(SHA256.test(sources.assetInventoryPlanSha256), "Quellenmanifest besitzt keinen Cache-Inventarplan-SHA fuer die Assetbaeume.");
      validateMapAssetNotices(sources.assetNotices);
      invariant(sources.sources.every((source) => source?.approved === true && typeof source.id === "string" && source.id !== "" && typeof source.license === "string" && source.license !== "" && typeof source.attribution === "string" && source.attribution !== "" && Number.isSafeInteger(source.capture?.bytes) && source.capture.bytes > 0 && SHA256.test(source.capture.sha256)), "Quellenmanifest besitzt keine vollstaendig freigegebenen Lizenz-, Attributions- und Capture-Bindungen.");
      const basemapProof = proofById.get(spec.artifacts.find(({ kind }) => kind === "basemap").id);
      const basemapSources = sources.sources.filter(({ scope }) => scope === "basemap");
      invariant(basemapSources.length === 1 && basemapSources[0].capture.bytes === basemapProof.bytes && basemapSources[0].capture.sha256 === basemapProof.sha256, "Basemapquelle ist nicht bytegenau an das tatsaechliche Basemap-PMTiles gebunden.");
    } else if (descriptor.kind === "style") {
      await readPublicJson(path, descriptor.id);
    }
    proofById.set(descriptor.id, await fileProof(path, descriptor.id));
  }
  return proofById;
}

async function writeDurable(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function materializeStaticMapRelease(specInput, sourceRootInput, outputRootInput) {
  const spec = validateMaterializationSpec(specInput);
  const requestedSourceRoot = resolve(sourceRootInput);
  const sourceMetadata = await lstat(requestedSourceRoot);
  invariant(sourceMetadata.isDirectory() && !sourceMetadata.isSymbolicLink(), "Quellwurzel muss ein regulaeres Verzeichnis sein.");
  const sourceRoot = await realpath(requestedSourceRoot);
  const outputRoot = resolve(outputRootInput);
  const outputRemainder = relative(sourceRoot, outputRoot);
  invariant(outputRemainder !== "" && outputRemainder !== ".." && !outputRemainder.startsWith(`..${sep}`) && !isAbsolute(outputRemainder), "Materialisierungsziel muss innerhalb der Quellwurzel liegen.");
  await assertCreateNewTarget(outputRoot, "Static-Map-Release-Ziel");
  const outputParent = dirname(outputRoot);
  await mkdir(outputParent, { recursive: true });
  const parentMetadata = await lstat(outputParent);
  invariant(parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink(), "Materialisierungsziel-Elternverzeichnis muss regulaer sein.");
  const realOutputParent = await realpath(outputParent);
  const realParentRemainder = relative(sourceRoot, realOutputParent);
  invariant(realParentRemainder !== ".." && !realParentRemainder.startsWith(`..${sep}`) && !isAbsolute(realParentRemainder), "Materialisierungsziel-Elternpfad verlaesst die reale Quellwurzel.");

  const proofById = await inspectCoreInputs(spec, sourceRoot);
  const coreDescriptors = [...spec.artifacts, ...spec.auxiliaryFiles]
    .map((descriptor) => ({
      id: descriptor.id,
      kind: descriptor.kind,
      installPath: descriptor.installPath,
      ...proofById.get(descriptor.id),
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const releaseDocument = {
    schema: STATIC_MAP_RELEASE_SCHEMA,
    releaseId: spec.releaseId,
    status: "unsigned",
    claims: spec.claims,
    cutover: spec.cutover,
    artifacts: coreDescriptors,
  };
  const releaseBytes = serialize(releaseDocument);
  const releaseProof = { bytes: releaseBytes.length, sha256: createHash("sha256").update(releaseBytes).digest("hex") };
  const finalReleasePortable = `${outputRemainder.replaceAll("\\", "/")}/release.json`;
  const plan = {
    schema: STATIC_MAP_PACKAGE_PLAN_SCHEMA,
    packageId: spec.packageId,
    version: spec.version,
    releaseId: spec.releaseId,
    claims: spec.claims,
    cutover: spec.cutover,
    partBytes: spec.partBytes,
    runtime: spec.runtime,
    artifacts: spec.artifacts.map((descriptor) => pinned(descriptor, proofById.get(descriptor.id))),
    auxiliaryFiles: [
      ...spec.auxiliaryFiles.map((descriptor) => pinned(descriptor, proofById.get(descriptor.id))),
      {
        id: "static-map-release",
        kind: "release-manifest",
        visibility: "public",
        sourceFile: finalReleasePortable,
        installPath: "manifests/static-map-release.json",
        expectedBytes: releaseProof.bytes,
        expectedSha256: releaseProof.sha256,
      },
    ],
    auxiliaryTrees: spec.auxiliaryTrees,
  };
  const planBytes = serialize(plan);

  const temporaryRoot = await mkdtemp(join(outputParent, `.${basename(outputRoot)}.materializing-`));
  let completed = false;
  try {
    await writeDurable(join(temporaryRoot, "release.json"), releaseBytes);
    const temporaryReleasePortable = relative(sourceRoot, join(temporaryRoot, "release.json")).replaceAll("\\", "/");
    const verificationPlan = {
      ...plan,
      auxiliaryFiles: plan.auxiliaryFiles.map((descriptor) => descriptor.kind === "release-manifest"
        ? { ...descriptor, sourceFile: temporaryReleasePortable }
        : descriptor),
    };
    const expanded = await expandMapPackagePlan(verificationPlan, sourceRoot);
    const sourceDescriptor = expanded.auxiliaryFiles.find(({ kind }) => kind === "source-manifest");
    const sources = await readPublicJson(await containedRegularFile(sourceRoot, sourceDescriptor.sourceFile, `${sourceDescriptor.id}.sourceFile`), sourceDescriptor.id);
    const assetDescriptors = [];
    for (const descriptor of expanded.auxiliaryFiles.filter(({ kind }) => ["glyph", "sprite"].includes(kind))) {
      const path = await containedRegularFile(sourceRoot, descriptor.sourceFile, `${descriptor.id}.sourceFile`);
      assetDescriptors.push({ ...descriptor, ...await fileProof(path, descriptor.id) });
    }
    validateMapAssetNoticeBindings(sources.assetNotices, assetDescriptors);
    const styleDescriptor = expanded.auxiliaryFiles.find(({ kind }) => kind === "style");
    const style = await readPublicJson(await containedRegularFile(sourceRoot, styleDescriptor.sourceFile, `${styleDescriptor.id}.sourceFile`), styleDescriptor.id);
    validateRuntimeStyle(style, expanded);
    validateStaticMapReleaseDocument(releaseDocument, expanded);
    await writeDurable(join(temporaryRoot, "package-plan.json"), planBytes);

    await publishDirectoryCreateNew(temporaryRoot, outputRoot, "Static-Map-Release-Ziel");
    completed = true;
    return { status: "materialized", outputRoot, plan, release: releaseDocument };
  } finally {
    if (!completed) await rm(temporaryRoot, { recursive: true, force: true });
  }
}
