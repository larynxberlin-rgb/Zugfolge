import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./reference-corpus.mjs";

export const TECHNICAL_DATASET_SCHEMA = "zugfolge-technical-reference-dataset/v1";
export const EVALUATION_CONFIG_SCHEMA = "zugfolge-technical-evaluation-config/v1";
export const QUALIFICATION_EVIDENCE_SCHEMA = "zugfolge-qualification-evidence/v1";
export const ARTIFACT_CHAIN_SCHEMA = "zugfolge-release-artifact-chain/v1";
export const BUNDLE_SCHEMA = "zugfolge-pilot-release-bundle/v3";
const verifiedBundles = new WeakSet();
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmpty(value, name) {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
}

function sha256Hex(value, name) {
  invariant(typeof value === "string" && /^[0-9a-f]{64}$/u.test(value), `${name} muss ein SHA-256-Hash sein.`);
}

function timestamp(value, name) {
  nonEmpty(value, name);
  invariant(Number.isFinite(Date.parse(value)), `${name} muss ein ISO-8601-Zeitpunkt sein.`);
}

function assertSafeRelativePath(value, name) {
  nonEmpty(value, name);
  invariant(!path.isAbsolute(value), `${name} muss relativ zum Artefaktordner sein.`);
  const normalized = path.normalize(value);
  invariant(
    normalized !== ".." && !normalized.startsWith(`..${path.sep}`),
    `${name} darf den Artefaktordner nicht verlassen.`,
  );
  return normalized;
}

function resolveArtifact(rootDirectory, relativePath, name) {
  const root = path.resolve(rootDirectory);
  const normalized = assertSafeRelativePath(relativePath, name);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  invariant(relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `${name} liegt außerhalb des Artefaktordners.`);
  return resolved;
}

async function assertRealPathWithinRoot(rootDirectory, resolvedPath, name) {
  const [realRoot, realFile] = await Promise.all([realpath(path.resolve(rootDirectory)), realpath(resolvedPath)]);
  const relative = path.relative(realRoot, realFile);
  invariant(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${name} verweist über einen Symlink aus dem Artefaktordner.`);
}

function validateArtifactRecord(record, name) {
  invariant(record && typeof record === "object" && !Array.isArray(record), `${name} fehlt.`);
  assertSafeRelativePath(record.path, `${name}.path`);
  sha256Hex(record.sha256, `${name}.sha256`);
  return record;
}

async function readArtifact(rootDirectory, record, name) {
  validateArtifactRecord(record, name);
  const resolved = resolveArtifact(rootDirectory, record.path, `${name}.path`);
  await assertRealPathWithinRoot(rootDirectory, resolved, `${name}.path`);
  const bytes = await readFile(resolved);
  invariant(sha256(bytes) === record.sha256, `${name}: Artefakthash stimmt nicht (${record.path}).`);
  return bytes;
}

async function readJsonArtifact(rootDirectory, record, name) {
  const bytes = await readArtifact(rootDirectory, record, name);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${name} ist kein gültiges JSON: ${error instanceof Error ? error.message : error}`);
  }
  return { bytes, value };
}

async function artifactRecordForPath(rootDirectory, relativePath, name) {
  const normalized = assertSafeRelativePath(relativePath, name);
  const resolved = resolveArtifact(rootDirectory, normalized, name);
  await assertRealPathWithinRoot(rootDirectory, resolved, name);
  const bytes = await readFile(resolved);
  return Object.freeze({ path: relativePath, sha256: sha256(bytes) });
}

function sameArtifactRecord(actual, expected, name) {
  validateArtifactRecord(actual, name);
  validateArtifactRecord(expected, `${name} (Kette)`);
  invariant(actual.path === expected.path && actual.sha256 === expected.sha256, `${name} ist nicht exakt an die Artefaktkette gebunden.`);
}

function rustArtifactInput(input) {
  invariant(input?.artifacts && typeof input.artifacts === "object", "artifacts fehlt.");
  const compilerArtifacts = Object.fromEntries(Object.entries(input.artifacts).map(([name, artifact]) => {
    if (Array.isArray(artifact)) {
      return [name, artifact.map((entry, index) => {
        validateArtifactRecord(entry?.record, `artifacts.${name}[${index}].record`);
        assertSafeRelativePath(entry?.sourcePath, `artifacts.${name}[${index}].sourcePath`);
        invariant(entry.bytes !== undefined, `artifacts.${name}[${index}].bytes fehlt.`);
        return { record: entry.record, sourcePath: entry.sourcePath, bytesHex: Buffer.from(entry.bytes).toString("hex") };
      })];
    }
    validateArtifactRecord(artifact?.record, `artifacts.${name}.record`);
    invariant(artifact.bytes !== undefined, `artifacts.${name}.bytes fehlt.`);
    return [name, {
      record: artifact.record,
      bytesHex: Buffer.from(artifact.bytes).toString("hex"),
    }];
  }));
  return { createdAt: input.createdAt, artifacts: compilerArtifacts };
}

function runReferenceCompiler(command, input) {
  const compiler = spawnSync(
    process.env.CARGO ?? "cargo",
    [
      "run", "--quiet", "--locked",
      "-p", "zugfolge-infra",
      "--bin", "zugfolge-infra-release",
      "--", command,
    ],
    {
      cwd: REPOSITORY_ROOT,
      input: JSON.stringify({
        input: rustArtifactInput(input),
      }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  );
  if (compiler.error) throw compiler.error;
  if (compiler.status !== 0) {
    throw new Error(compiler.stderr.trim() || `Rust-Releasecompiler endete mit Status ${compiler.status}.`);
  }
  return JSON.parse(compiler.stdout);
}

export function referenceReportFromRust(input) {
  return Object.freeze(runReferenceCompiler("reference-report", input));
}

export function referenceChainFromRust(input) {
  const verified = runReferenceCompiler("verify-reference-chain", input);
  return Object.freeze({
    ...verified,
    report: Object.freeze({ ...verified.report }),
    releaseManifest: Object.freeze({ ...verified.releaseManifest }),
  });
}

export function qualifiedReleaseFromRust(input) {
  timestamp(input?.createdAt, "createdAt");
  const manifest = runReferenceCompiler("qualified-reference-manifest", input);
  return Object.freeze({
    ...manifest,
    candidateManifest: Object.freeze({ ...manifest.candidateManifest }),
    qualification: Object.freeze({ ...manifest.qualification }),
  });
}

function artifactEntries(artifacts) {
  return [
    ["captureConfig", artifacts.captureConfig],
    ["captureManifest", artifacts.captureManifest],
    ["sourceArchive", artifacts.sourceArchive],
    ...(artifacts.sourceTables ?? []).map((record, index) => [`sourceTables[${index}]`, record]),
    ["normalizedObservations", artifacts.normalizedObservations],
    ["referenceCorpus", artifacts.referenceCorpus],
    ["qualificationEvidence", artifacts.qualificationEvidence],
    ["calibrationDataset", artifacts.calibrationDataset],
    ["calibrationConfig", artifacts.calibrationConfig],
    ["validationDataset", artifacts.validationDataset],
    ["validationConfig", artifacts.validationConfig],
    ["modelConfig", artifacts.modelConfig],
    ["modelResults", artifacts.modelResults],
    ["report", artifacts.report],
    ["releaseCandidate", artifacts.releaseCandidate],
    ["releaseManifest", artifacts.releaseManifest],
  ];
}

function validateArtifactChainShape(chain) {
  invariant(chain?.schema === ARTIFACT_CHAIN_SCHEMA, "Unbekanntes Artefaktketten-Schema.");
  invariant(chain.artifacts && typeof chain.artifacts === "object", "artifacts fehlt.");
  invariant(Array.isArray(chain.artifacts.sourceTables) && chain.artifacts.sourceTables.length > 0, "sourceTables fehlt.");
  const seenPaths = new Set();
  for (const [name, record] of artifactEntries(chain.artifacts)) {
    validateArtifactRecord(record, `artifacts.${name}`);
    const normalizedPath = path.normalize(record.path).toLocaleLowerCase("en-US");
    invariant(!seenPaths.has(normalizedPath), `Artefaktpfad '${record.path}' ist in der Kette doppelt.`);
    seenPaths.add(normalizedPath);
  }
}

export async function createArtifactChainManifest(paths, rootDirectory) {
  const required = [
    "captureConfig",
    "captureManifest",
    "sourceArchive",
    "normalizedObservations",
    "referenceCorpus",
    "qualificationEvidence",
    "modelConfig",
    "modelResults",
    "report",
    "releaseCandidate",
    "releaseManifest",
  ];
  for (const name of required) nonEmpty(paths[name], `paths.${name}`);
  nonEmpty(paths.sourceTableDirectory, "paths.sourceTableDirectory");
  const baseRecords = Object.fromEntries(await Promise.all(required.map(async (name) => [
    name,
    await artifactRecordForPath(rootDirectory, paths[name], `paths.${name}`),
  ])));
  const captureManifest = JSON.parse((await readFile(resolveArtifact(rootDirectory, paths.captureManifest, "paths.captureManifest"))).toString("utf8"));
  const evidence = JSON.parse((await readFile(resolveArtifact(rootDirectory, paths.qualificationEvidence, "paths.qualificationEvidence"))).toString("utf8"));
  invariant(Array.isArray(captureManifest.files) && captureManifest.files.length > 0, "Capture-Manifest enthält keine Tabellen.");
  const sourceTables = await Promise.all(captureManifest.files.map(async (table, index) => {
    nonEmpty(table.path, `captureManifest.files[${index}].path`);
    assertSafeRelativePath(table.path, `captureManifest.files[${index}].path`);
    const relativePath = path.join(paths.sourceTableDirectory, table.path);
    const record = await artifactRecordForPath(rootDirectory, relativePath, `sourceTables[${index}]`);
    return Object.freeze({ ...record, sourcePath: table.path });
  }));
  const chain = Object.freeze({
    schema: ARTIFACT_CHAIN_SCHEMA,
    artifacts: Object.freeze({
      captureConfig: baseRecords.captureConfig,
      captureManifest: baseRecords.captureManifest,
      sourceArchive: baseRecords.sourceArchive,
      sourceTables: Object.freeze(sourceTables),
      normalizedObservations: baseRecords.normalizedObservations,
      referenceCorpus: baseRecords.referenceCorpus,
      qualificationEvidence: baseRecords.qualificationEvidence,
      calibrationDataset: evidence.calibration?.dataset,
      calibrationConfig: evidence.calibration?.config,
      validationDataset: evidence.validation?.dataset,
      validationConfig: evidence.validation?.config,
      modelConfig: baseRecords.modelConfig,
      modelResults: baseRecords.modelResults,
      report: baseRecords.report,
      releaseCandidate: baseRecords.releaseCandidate,
      releaseManifest: baseRecords.releaseManifest,
    }),
  });
  validateArtifactChainShape(chain);
  return chain;
}

export async function verifyArtifactChainFiles(chain, rootDirectory) {
  validateArtifactChainShape(chain);
  const artifacts = chain.artifacts;
  const loadedEntries = await Promise.all(
    artifactEntries(artifacts).map(async ([name, record]) => [name, await readArtifact(rootDirectory, record, `artifacts.${name}`)]),
  );
  const loaded = new Map(loadedEntries);
  const releaseManifest = JSON.parse(loaded.get("releaseManifest").toString("utf8"));
  const compilerArtifacts = Object.fromEntries(
    artifactEntries(artifacts)
      .filter(([name]) => name !== "sourceTables[0]" && !name.startsWith("sourceTables["))
      .map(([name, record]) => [name === "releaseCandidate" ? "candidateManifest" : name, { record, bytes: loaded.get(name) }]),
  );
  compilerArtifacts.sourceTables = artifacts.sourceTables.map((record, index) => ({
    record,
    sourcePath: record.sourcePath,
    bytes: loaded.get(`sourceTables[${index}]`),
  }));
  const verified = referenceChainFromRust({
    createdAt: releaseManifest.createdAt,
    artifacts: compilerArtifacts,
  });
  return Object.freeze({ chain, report: verified.report, releaseManifest: verified.releaseManifest });
}

export async function createUnsignedBundleFromFiles(input) {
  timestamp(input.createdAt, "createdAt");
  const chainPath = assertSafeRelativePath(input.chainPath, "chainPath");
  const resolvedChain = resolveArtifact(input.rootDirectory, chainPath, "chainPath");
  await assertRealPathWithinRoot(input.rootDirectory, resolvedChain, "chainPath");
  const chainBytes = await readFile(resolvedChain);
  const chain = JSON.parse(chainBytes.toString("utf8"));
  const verified = await verifyArtifactChainFiles(chain, input.rootDirectory);
  invariant(input.createdAt === verified.releaseManifest.createdAt, "Bundle- und Release-Manifest-Zeitpunkt stimmen nicht überein.");
  const bundle = Object.freeze({
    schema: BUNDLE_SCHEMA,
    chain: Object.freeze({ path: input.chainPath, sha256: sha256(chainBytes) }),
    releaseManifest: Object.freeze({ ...chain.artifacts.releaseManifest }),
    reportSha256: chain.artifacts.report.sha256,
    releaseChecksum: verified.releaseManifest.releaseChecksum,
    createdAt: input.createdAt,
  });
  verifiedBundles.add(bundle);
  return bundle;
}

export function signBundle(bundle, privateKeyPem) {
  invariant(bundle?.schema === BUNDLE_SCHEMA, "Nur eine vollständig geprüfte Artefaktkette darf signiert werden.");
  invariant(verifiedBundles.has(bundle), "Signatur verweigert: Bundle wurde in diesem Prozess nicht vollständig gegen seine Artefakte geprüft.");
  const privateKey = privateKeyPem instanceof KeyObject ? privateKeyPem : createPrivateKey(privateKeyPem);
  invariant(privateKey.type === "private", "Release-Schlüssel muss privat sein.");
  const publicKey = createPublicKey(privateKey);
  invariant(publicKey.asymmetricKeyType === "ed25519", "Nur Ed25519-Release-Schlüssel sind zulässig.");
  const payload = Buffer.from(canonicalJson(bundle));
  return Object.freeze({
    bundle,
    signature: Object.freeze({
      algorithm: "Ed25519",
      publicKeySha256: sha256(publicKey.export({ type: "spki", format: "der" })),
      valueBase64: cryptoSign(null, payload, privateKey).toString("base64"),
    }),
  });
}

export function verifySignedBundle(signedBundle, publicKeyPem) {
  invariant(signedBundle.bundle?.schema === BUNDLE_SCHEMA, "Unbekanntes Bundle-Schema.");
  invariant(signedBundle.signature?.algorithm === "Ed25519", "Nur Ed25519-Signaturen sind zulässig.");
  const publicKey = publicKeyPem instanceof KeyObject && publicKeyPem.type === "public"
    ? publicKeyPem
    : createPublicKey(publicKeyPem);
  invariant(publicKey.asymmetricKeyType === "ed25519", "Nur Ed25519-Release-Schlüssel sind zulässig.");
  invariant(
    signedBundle.signature.publicKeySha256 === sha256(publicKey.export({ type: "spki", format: "der" })),
    "Signatur wurde nicht mit dem erwarteten Release-Schlüssel erstellt.",
  );
  invariant(
    cryptoVerify(
      null,
      Buffer.from(canonicalJson(signedBundle.bundle)),
      publicKey,
      Buffer.from(signedBundle.signature.valueBase64, "base64"),
    ),
    "Signatur des Pilot-Releases ist ungültig.",
  );
  return signedBundle.bundle;
}

export async function verifyBundleFiles(signedBundle, publicKeyPem, rootDirectory) {
  const bundle = verifySignedBundle(signedBundle, publicKeyPem);
  validateArtifactRecord(bundle.chain, "bundle.chain");
  const chainArtifact = await readJsonArtifact(rootDirectory, bundle.chain, "bundle.chain");
  const verified = await verifyArtifactChainFiles(chainArtifact.value, rootDirectory);
  sameArtifactRecord(bundle.releaseManifest, chainArtifact.value.artifacts.releaseManifest, "bundle.releaseManifest");
  invariant(bundle.reportSha256 === chainArtifact.value.artifacts.report.sha256, "Bundle und Report-Artefakt stimmen nicht überein.");
  invariant(bundle.releaseChecksum === verified.releaseManifest.releaseChecksum, "Bundle und qualifiziertes Release-Manifest stimmen nicht überein.");
  invariant(bundle.createdAt === verified.releaseManifest.createdAt, "Bundle- und Release-Manifest-Zeitpunkt stimmen nicht überein.");
  return bundle;
}
