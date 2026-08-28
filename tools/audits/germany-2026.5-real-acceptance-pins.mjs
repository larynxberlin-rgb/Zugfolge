import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

export const GERMANY_2026_5_REAL_ACCEPTANCE_PIN_SCHEMA =
  "zugfolge-germany-2026.5-real-acceptance-pins/v1";
export const GERMANY_2026_5_RELEASE_ID = "infra-deutschland-2026.5";
export const GERMANY_2026_5_REAL_ACCEPTANCE_PIN_PATH = join(
  import.meta.dirname,
  "germany-2026.5-real-acceptance.pins.json",
);
export const GERMANY_2026_5_REAL_ACCEPTANCE_PIN_ENV =
  "ZUGFOLGE_REAL_GERMANY_2026_5_PIN_CONTRACT";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const MINIMUM_OPERATIONAL_BYTES = 900 * 1024 * 1024;
const execute = promisify(execFile);
const PIN_REPOSITORY_FILE = "tools/audits/germany-2026.5-real-acceptance.pins.json";
const EXPECTED_FILES = Object.freeze({
  alphaWorldBuildConfiguration: "alpha-world-build-configuration.json",
  operationalInfrastructure: "operational-infrastructure-v2.json",
  timetableTransferDemands: "timetable-routes-v2.transfer-demands-v2.json",
  movementRouteTemplates: "operational-infrastructure-v2.movement-route-templates-v2.json",
  semanticPmtiles: "map-release-free-v2/infra-deutschland-2026.5.pmtiles",
  mapSourceCapture: "map-release-free-v2/public/map-source-capture.json",
  staticMapSources: "map-release-free-v2/public/static-map-sources-v2.json",
  unsignedDeployment: "alpha-world-deployment.2026.5.json",
  signedDeployment: "alpha-world-deployment.2026.5.signed.json",
  signedMapPackageManifest: "map-package-signed/manifest.json",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(record(value, label)).sort();
  const wanted = [...expected].sort();
  invariant(isDeepStrictEqual(actual, wanted), `${label} besitzt nicht exakt die erwarteten Felder.`);
}

function positiveBytes(value, label, minimum = 1) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${label}.bytes ist kleiner als die harte Mindestgroesse.`);
}

function sha256(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} ist kein SHA-256.`);
}

function fixedFile(value, expected, label) {
  invariant(value === expected, `${label}.file muss exakt '${expected}' sein.`);
  invariant(!isAbsolute(value) && !value.split(/[\\/]/u).includes(".."), `${label}.file darf die Artefaktwurzel nicht verlassen.`);
}

function fileBinding(value, expectedFile, label, { minimumBytes = 1, extraKeys = [] } = {}) {
  exactKeys(value, ["file", "bytes", "sha256", ...extraKeys], label);
  fixedFile(value.file, expectedFile, label);
  positiveBytes(value.bytes, label, minimumBytes);
  sha256(value.sha256, `${label}.sha256`);
}

export function validateGermany20265RealAcceptancePins(value, expectedSourceCommit) {
  exactKeys(value, [
    "schema",
    "releaseId",
    "sourceCommit",
    "alphaWorldBuildConfiguration",
    "operationalInfrastructure",
    "timetableTransferDemands",
    "movementRouteTemplates",
    "semanticPmtiles",
    "mapSourceCapture",
    "staticMapSources",
    "unsignedDeployment",
    "signedDeployment",
    "runtimeBuild",
    "signedMapPackageManifest",
  ], "Deutschland-2026.5-Realabnahme-Pins");
  invariant(value.schema === GERMANY_2026_5_REAL_ACCEPTANCE_PIN_SCHEMA, "Deutschland-2026.5-Realabnahme-Pins besitzen ein falsches Schema.");
  invariant(value.releaseId === GERMANY_2026_5_RELEASE_ID, "Deutschland-2026.5-Realabnahme-Pins besitzen eine falsche Release-ID.");
  invariant(typeof value.sourceCommit === "string" && COMMIT.test(value.sourceCommit), "Deutschland-2026.5-Realabnahme-Pins brauchen einen vollen lowercase Source-Commit.");
  if (expectedSourceCommit !== undefined) {
    invariant(COMMIT.test(expectedSourceCommit), "Der ausgecheckte Source-Commit ist ungueltig.");
    invariant(value.sourceCommit === expectedSourceCommit, "Der Pinvertrag gehoert nicht zum ausgecheckten Source-Commit.");
  }

  fileBinding(
    value.alphaWorldBuildConfiguration,
    EXPECTED_FILES.alphaWorldBuildConfiguration,
    "alphaWorldBuildConfiguration",
  );
  fileBinding(
    value.operationalInfrastructure,
    EXPECTED_FILES.operationalInfrastructure,
    "operationalInfrastructure",
    { minimumBytes: MINIMUM_OPERATIONAL_BYTES, extraKeys: ["schemaVersion", "stateHash"] },
  );
  invariant(
    value.operationalInfrastructure.schemaVersion === "zugfolge-operational-infrastructure-binding/v2",
    "Operational-v2-Pin besitzt ein falsches Binding-Schema.",
  );
  sha256(value.operationalInfrastructure.stateHash, "operationalInfrastructure.stateHash");

  fileBinding(
    value.timetableTransferDemands,
    EXPECTED_FILES.timetableTransferDemands,
    "timetableTransferDemands",
    { extraKeys: ["dailyPlanSha256", "transferSetSha256"] },
  );
  sha256(value.timetableTransferDemands.dailyPlanSha256, "timetableTransferDemands.dailyPlanSha256");
  sha256(value.timetableTransferDemands.transferSetSha256, "timetableTransferDemands.transferSetSha256");

  fileBinding(
    value.movementRouteTemplates,
    EXPECTED_FILES.movementRouteTemplates,
    "movementRouteTemplates",
    { extraKeys: ["stateHash", "operationalStateHash", "timetableTransferSetSha256"] },
  );
  sha256(value.movementRouteTemplates.stateHash, "movementRouteTemplates.stateHash");
  sha256(value.movementRouteTemplates.operationalStateHash, "movementRouteTemplates.operationalStateHash");
  sha256(value.movementRouteTemplates.timetableTransferSetSha256, "movementRouteTemplates.timetableTransferSetSha256");
  invariant(
    value.movementRouteTemplates.operationalStateHash === value.operationalInfrastructure.stateHash,
    "Movement-Route-Templates und Operational-v2 besitzen verschiedene State-Hashes.",
  );
  invariant(
    value.movementRouteTemplates.timetableTransferSetSha256 === value.timetableTransferDemands.transferSetSha256,
    "Movement-Route-Templates und Transfer-Demands-v2 besitzen verschiedene Transfer-Set-Hashes.",
  );

  fileBinding(value.semanticPmtiles, EXPECTED_FILES.semanticPmtiles, "semanticPmtiles");
  fileBinding(value.mapSourceCapture, EXPECTED_FILES.mapSourceCapture, "mapSourceCapture");
  fileBinding(value.staticMapSources, EXPECTED_FILES.staticMapSources, "staticMapSources");

  fileBinding(value.unsignedDeployment, EXPECTED_FILES.unsignedDeployment, "unsignedDeployment");
  fileBinding(
    value.signedDeployment,
    EXPECTED_FILES.signedDeployment,
    "signedDeployment",
    { extraKeys: ["deploymentHash", "signatureKeyId"] },
  );
  sha256(value.signedDeployment.deploymentHash, "signedDeployment.deploymentHash");
  invariant(value.signedDeployment.signatureKeyId === "zugfolge-alpha-2026.3", "Signed Deployment besitzt eine falsche Alpha-Key-ID.");
  invariant(value.signedDeployment.bytes > value.unsignedDeployment.bytes, "Signed Deployment muss die Signatur zusaetzlich zum identischen Deployment tragen.");

  exactKeys(value.runtimeBuild, ["nativeAddonSha256", "typescriptBuildSetSha256"], "runtimeBuild");
  sha256(value.runtimeBuild.nativeAddonSha256, "runtimeBuild.nativeAddonSha256");
  sha256(value.runtimeBuild.typescriptBuildSetSha256, "runtimeBuild.typescriptBuildSetSha256");
  fileBinding(
    value.signedMapPackageManifest,
    EXPECTED_FILES.signedMapPackageManifest,
    "signedMapPackageManifest",
  );
  return Object.freeze(structuredClone(value));
}

export async function verifyGermany20265PinRegistration(pinPath, pins, registeredAtCommit) {
  const registration = registrationCommit(registeredAtCommit);
  invariant(registration !== pins.sourceCommit, "Pin-Registrierung und Artefaktquelle duerfen nicht derselbe Commit sein.");
  const repositoryRoot = resolve(dirname(pinPath), "../..");
  invariant(
    relative(repositoryRoot, pinPath).replaceAll("\\", "/") === PIN_REPOSITORY_FILE,
    `Der Realabnahme-Pinvertrag muss aus ${PIN_REPOSITORY_FILE} im Registrierungscheckout stammen.`,
  );
  const options = { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 };
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execute("git", ["rev-parse", "HEAD"], options),
    execute("git", ["status", "--porcelain", "--untracked-files=all"], options),
    execute("git", ["ls-files", "--error-unmatch", "--", PIN_REPOSITORY_FILE], options),
    execute("git", ["cat-file", "-e", `${pins.sourceCommit}^{commit}`], options),
  ]);
  invariant(head.trim() === registration, "Pinvertrag stammt nicht aus dem angegebenen Registrierungscommit.");
  invariant(status === "", "Pin-Registrierungscheckout ist nicht sauber.");
  await execute("git", ["merge-base", "--is-ancestor", pins.sourceCommit, registration], options);
}

export async function loadGermany20265RealAcceptancePins(expectedSourceCommit) {
  const configuredPath = process.env[GERMANY_2026_5_REAL_ACCEPTANCE_PIN_ENV];
  if (configuredPath !== undefined) {
    invariant(isAbsolute(configuredPath), `${GERMANY_2026_5_REAL_ACCEPTANCE_PIN_ENV} muss absolut sein.`);
  }
  const pinPath = configuredPath === undefined
    ? GERMANY_2026_5_REAL_ACCEPTANCE_PIN_PATH
    : resolve(configuredPath);
  const serialized = await readFile(pinPath, "utf8");
  const pins = validateGermany20265RealAcceptancePins(JSON.parse(serialized), expectedSourceCommit);
  if (configuredPath !== undefined) {
    await verifyGermany20265PinRegistration(
      pinPath,
      pins,
      process.env.ZUGFOLGE_REAL_GERMANY_PIN_REGISTRATION_COMMIT,
    );
  }
  return pins;
}

async function fileProof(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return Object.freeze({ bytes, sha256: hash.digest("hex") });
}

function artifactPath(root, binding) {
  const absoluteRoot = resolve(root);
  const path = resolve(absoluteRoot, ...binding.file.split("/"));
  invariant(path.startsWith(`${absoluteRoot}/`) || path.startsWith(`${absoluteRoot}\\`), `Artefakt '${binding.file}' verlaesst die Artefaktwurzel.`);
  return path;
}

async function assertFileBinding(root, binding, label) {
  const proof = await fileProof(artifactPath(root, binding));
  invariant(
    isDeepStrictEqual(proof, { bytes: binding.bytes, sha256: binding.sha256 }),
    `${label} verletzt den repo- und commitgebundenen Datei-Pin.`,
  );
  return proof;
}

function assertConfigurationBinding(configuration, pins) {
  invariant(configuration.schemaVersion === "zugfolge-alpha-world-build-configuration/v3", "Alpha-World-Buildkonfiguration besitzt ein falsches Schema.");
  invariant(isDeepStrictEqual(configuration.operationalInfrastructure, {
    file: pins.operationalInfrastructure.file,
    bytes: pins.operationalInfrastructure.bytes,
    sha256: pins.operationalInfrastructure.sha256,
    stateHash: pins.operationalInfrastructure.stateHash,
  }), "Alpha-World-Buildkonfiguration bindet nicht exakt das gepinnte Operational-v2-Artefakt.");
  for (const [name, expected] of [
    ["timetableTransferDemands", pins.timetableTransferDemands],
    ["movementRouteTemplates", pins.movementRouteTemplates],
  ]) {
    const actual = configuration[name];
    invariant(actual !== undefined, `Alpha-World-Buildkonfiguration enthaelt ${name} nicht.`);
    for (const key of Object.keys(expected)) {
      if (key === "schemaVersion") continue;
      invariant(actual[key] === expected[key], `Alpha-World-Buildkonfiguration verletzt ${name}.${key}.`);
    }
  }
}

function registrationCommit(value) {
  invariant(typeof value === "string" && COMMIT.test(value), "Der Pin-Registrierungscommit ist ungueltig.");
  return value;
}

function registrationCommitForPins(value, pins) {
  const registration = registrationCommit(value);
  invariant(registration !== pins.sourceCommit, "Pin-Registrierung und Artefaktquelle duerfen nicht derselbe Commit sein.");
  return registration;
}

export async function verifyGermany20265RealAcceptanceArtifacts(artifactRoot, pins, registeredAtCommit) {
  invariant(isAbsolute(artifactRoot), "Deutschland-2026.5-Artefaktwurzel muss absolut sein.");
  const bindingEntries = [
    ["alphaWorldBuildConfiguration", pins.alphaWorldBuildConfiguration],
    ["operationalInfrastructure", pins.operationalInfrastructure],
    ["timetableTransferDemands", pins.timetableTransferDemands],
    ["movementRouteTemplates", pins.movementRouteTemplates],
    ["semanticPmtiles", pins.semanticPmtiles],
    ["mapSourceCapture", pins.mapSourceCapture],
    ["staticMapSources", pins.staticMapSources],
    ["unsignedDeployment", pins.unsignedDeployment],
    ["signedDeployment", pins.signedDeployment],
    ["signedMapPackageManifest", pins.signedMapPackageManifest],
  ];
  const proofs = Object.fromEntries(await Promise.all(bindingEntries.map(async ([name, binding]) => [
    name,
    await assertFileBinding(artifactRoot, binding, name),
  ])));
  const configuration = JSON.parse(await readFile(
    artifactPath(artifactRoot, pins.alphaWorldBuildConfiguration),
    "utf8",
  ));
  assertConfigurationBinding(configuration, pins);
  const [unsignedDocument, signedDocument] = await Promise.all([
    readFile(artifactPath(artifactRoot, pins.unsignedDeployment), "utf8").then(JSON.parse),
    readFile(artifactPath(artifactRoot, pins.signedDeployment), "utf8").then(JSON.parse),
  ]);
  invariant(isDeepStrictEqual(unsignedDocument.deployment, signedDocument.deployment), "Unsigned und Signed Deployment enthalten nicht denselben Weltvertrag.");
  invariant(signedDocument.deploymentHash === pins.signedDeployment.deploymentHash, "Signed Deployment verletzt den gepinnten Deployment-Hash.");
  invariant(signedDocument.signature?.algorithm === "Ed25519", "Signed Deployment besitzt keine Ed25519-Signatur.");
  invariant(signedDocument.signature?.keyId === pins.signedDeployment.signatureKeyId, "Signed Deployment verletzt die gepinnte Signatur-Key-ID.");
  return Object.freeze({
    schema: "zugfolge-germany-2026.5-real-artifact-verification/v1",
    releaseId: pins.releaseId,
    sourceCommit: pins.sourceCommit,
    pinRegistrationCommit: registrationCommitForPins(registeredAtCommit, pins),
    proofs,
    alphaWorldConfigurationBound: true,
    deploymentBytesEqualBeforeSignature: true,
  });
}

export async function verifyGermany20265RealBuilderOutputs(
  builderArtifactRoot,
  candidateArtifactRoot,
  pins,
  registeredAtCommit,
) {
  invariant(isAbsolute(builderArtifactRoot), "Deutschland-2026.5-Builderwurzel muss absolut sein.");
  invariant(isAbsolute(candidateArtifactRoot), "Deutschland-2026.5-Kandidatenwurzel muss absolut sein.");
  const proofs = {};
  for (const [name, binding] of [
    ["semanticPmtiles", pins.semanticPmtiles],
    ["mapSourceCapture", pins.mapSourceCapture],
    ["staticMapSources", pins.staticMapSources],
  ]) {
    const [fresh, candidate] = await Promise.all([
      assertFileBinding(builderArtifactRoot, binding, `frisches ${name}`),
      assertFileBinding(candidateArtifactRoot, binding, `Kandidat ${name}`),
    ]);
    invariant(isDeepStrictEqual(fresh, candidate), `Frisches ${name} ist nicht byte-/hashgleich zum Kandidaten.`);
    proofs[name] = Object.freeze({ fresh, candidate });
  }
  return Object.freeze({
    schema: "zugfolge-germany-2026.5-real-builder-reproduction/v1",
    releaseId: pins.releaseId,
    sourceCommit: pins.sourceCommit,
    pinRegistrationCommit: registrationCommitForPins(registeredAtCommit, pins),
    runtimeBinding: "tools/tiles/gdal-runtime.3.13.2-win32-x64.manifest.json",
    assetNoticesBinding: "tools/tiles/map-asset-notices.annual-2026.5.json",
    createNewBuilderRoot: resolve(builderArtifactRoot),
    proofs,
    candidateBytesEqual: true,
  });
}

export function verifyGermany20265OperationalValidationReceipt(receipt, pins) {
  invariant(receipt !== null && typeof receipt === "object", "Operational-v2-Validator-Receipt fehlt.");
  invariant(receipt.sourceBytes === pins.operationalInfrastructure.bytes, "Operational-v2-Validator meldet eine falsche Quellbytezahl.");
  invariant(receipt.sourceSha256 === pins.operationalInfrastructure.sha256, "Operational-v2-Validator meldet einen falschen Quell-SHA-256.");
  invariant(receipt.stateHash === pins.operationalInfrastructure.stateHash, "Operational-v2-Validator meldet einen falschen State-Hash.");
  invariant(receipt.validationMode === "native-streaming-redb-v1", "Operational-v2-Validator lief nicht im nativen Streamingmodus.");
  return receipt;
}

function environmentLines(pins, registeredAtCommit) {
  const registration = registrationCommitForPins(registeredAtCommit, pins);
  return [
    ["ZUGFOLGE_REAL_GERMANY_PIN_REGISTRATION_COMMIT", registration],
    ["ZUGFOLGE_REAL_GERMANY_EXPECTED_SOURCE_COMMIT", pins.sourceCommit],
    ["ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_BYTES", pins.operationalInfrastructure.bytes],
    ["ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_SOURCE_SHA256", pins.operationalInfrastructure.sha256],
    ["ZUGFOLGE_OPERATIONAL_V2_REAL_EXPECTED_STATE_HASH", pins.operationalInfrastructure.stateHash],
    ["ZUGFOLGE_REAL_GERMANY_EXPECTED_NAPI_SHA256", pins.runtimeBuild.nativeAddonSha256],
    ["ZUGFOLGE_REAL_GERMANY_EXPECTED_TYPESCRIPT_BUILD_SET_SHA256", pins.runtimeBuild.typescriptBuildSetSha256],
    ["ZUGFOLGE_REAL_GERMANY_EXPECTED_UNSIGNED_DEPLOYMENT_SHA256", pins.unsignedDeployment.sha256],
    ["ZUGFOLGE_REAL_GERMANY_EXPECTED_SIGNED_DEPLOYMENT_SHA256", pins.signedDeployment.sha256],
    ["ZUGFOLGE_REAL_GERMANY_EXPECTED_DEPLOYMENT_HASH", pins.signedDeployment.deploymentHash],
    ["ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_BYTES", pins.signedMapPackageManifest.bytes],
    ["ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_SHA256", pins.signedMapPackageManifest.sha256],
  ].map(([name, value]) => `${name}=${value}`).join("\n");
}

function parseMetrics(serialized) {
  const entries = serialized.trim().split(/\r?\n/u).map((line) => line.split("="));
  invariant(entries.every((entry) => entry.length === 2), "cgroup-v2-Metrikdatei ist ungueltig.");
  const metrics = Object.fromEntries(entries.map(([name, value]) => [name, Number(value)]));
  exactKeys(metrics, [
    "memoryMaxBytes",
    "memorySwapMaxBytes",
    "memoryPeakBytes",
    "oomBefore",
    "oomAfter",
    "oomKillBefore",
    "oomKillAfter",
  ], "cgroup-v2-Metriken");
  invariant(Object.values(metrics).every(Number.isSafeInteger), "cgroup-v2-Metrik ist keine sichere Ganzzahl.");
  invariant(metrics.memoryMaxBytes === 512 * 1024 * 1024, "Operational-RSS-Lauf braucht exakt 512 MiB memory.max.");
  invariant(metrics.memorySwapMaxBytes === 0, "Operational-RSS-Lauf darf keinen Swap besitzen.");
  invariant(metrics.memoryPeakBytes <= metrics.memoryMaxBytes, "Operational-RSS-Lauf ueberschritt memory.max.");
  invariant(metrics.oomAfter === metrics.oomBefore, "Operational-RSS-Lauf erzeugte ein OOM-Ereignis.");
  invariant(metrics.oomKillAfter === metrics.oomKillBefore, "Operational-RSS-Lauf erzeugte einen OOM-Kill.");
  return Object.freeze(metrics);
}

async function writeJsonNew(path, value) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(argv) {
  const [command, ...arguments_] = argv;
  if (command === "export-env") {
    const [registeredAtCommit] = arguments_;
    invariant(arguments_.length === 1, "Aufruf: export-env PIN_REGISTRATION_COMMIT");
    const pins = await loadGermany20265RealAcceptancePins();
    await verifyGermany20265PinRegistration(GERMANY_2026_5_REAL_ACCEPTANCE_PIN_PATH, pins, registeredAtCommit);
    process.stdout.write(`${environmentLines(pins, registeredAtCommit)}\n`);
    return;
  }
  if (command === "verify-artifacts") {
    const [artifactRoot, expectedSourceCommit, registeredAtCommit, output] = arguments_;
    invariant(arguments_.length === 4, "Aufruf: verify-artifacts ARTIFACT_ROOT EXPECTED_SOURCE_COMMIT PIN_REGISTRATION_COMMIT OUTPUT");
    const pins = await loadGermany20265RealAcceptancePins(expectedSourceCommit);
    await writeJsonNew(output, await verifyGermany20265RealAcceptanceArtifacts(
      resolve(artifactRoot),
      pins,
      registeredAtCommit,
    ));
    return;
  }
  if (command === "verify-validator") {
    const [receiptPath, expectedSourceCommit] = arguments_;
    invariant(arguments_.length === 2, "Aufruf: verify-validator RECEIPT EXPECTED_SOURCE_COMMIT");
    const pins = await loadGermany20265RealAcceptancePins(expectedSourceCommit);
    verifyGermany20265OperationalValidationReceipt(JSON.parse(await readFile(receiptPath, "utf8")), pins);
    return;
  }
  if (command === "verify-builder") {
    const [builderArtifactRoot, candidateArtifactRoot, expectedSourceCommit, registeredAtCommit, output] = arguments_;
    invariant(arguments_.length === 5, "Aufruf: verify-builder BUILDER_ARTIFACT_ROOT CANDIDATE_ARTIFACT_ROOT EXPECTED_SOURCE_COMMIT PIN_REGISTRATION_COMMIT OUTPUT");
    const pins = await loadGermany20265RealAcceptancePins(expectedSourceCommit);
    await writeJsonNew(output, await verifyGermany20265RealBuilderOutputs(
      resolve(builderArtifactRoot),
      resolve(candidateArtifactRoot),
      pins,
      registeredAtCommit,
    ));
    return;
  }
  if (command === "write-rss-proof") {
    const [receiptPath, metricsPath, expectedSourceCommit, registeredAtCommit, output] = arguments_;
    invariant(arguments_.length === 5, "Aufruf: write-rss-proof RECEIPT METRICS EXPECTED_SOURCE_COMMIT PIN_REGISTRATION_COMMIT OUTPUT");
    const pins = await loadGermany20265RealAcceptancePins(expectedSourceCommit);
    const receipt = verifyGermany20265OperationalValidationReceipt(
      JSON.parse(await readFile(receiptPath, "utf8")),
      pins,
    );
    const metrics = parseMetrics(await readFile(metricsPath, "utf8"));
    await writeJsonNew(output, {
      schema: "zugfolge-operational-streaming-rss-proof/v2",
      infraReleaseId: pins.releaseId,
      sourceCommit: pins.sourceCommit,
      pinRegistrationCommit: registrationCommitForPins(registeredAtCommit, pins),
      sourceBytes: receipt.sourceBytes,
      sourceSha256: receipt.sourceSha256,
      stateHash: receipt.stateHash,
      validationMode: receipt.validationMode,
      memoryLimitEnforcement: "fresh-docker-cgroup-v2-memory-max-without-swap",
      ...metrics,
    });
    return;
  }
  throw new Error("Unbekannter Deutschland-2026.5-Realabnahme-Pin-Befehl.");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
