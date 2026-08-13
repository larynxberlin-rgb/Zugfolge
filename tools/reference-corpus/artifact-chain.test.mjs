import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createUnsignedBundleFromFiles,
  signBundle,
  verifyArtifactChainFiles,
  verifyBundleFiles,
  verifySignedBundle,
} from "./artifact-chain.mjs";
import { canonicalJson, compareWithModel, sha256 } from "./reference-corpus.mjs";
import { materializeSyntheticValidationFixture } from "./fixtures/synthetic-validation.mjs";

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

async function temporaryDirectory(t, suffix = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), `zugfolge-reference-chain-${suffix}`));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function signedFixture(t) {
  const root = await temporaryDirectory(t, "signed-");
  const fixture = await materializeSyntheticValidationFixture(root);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bundle = await createUnsignedBundleFromFiles({
    chainPath: fixture.artifacts.chain.path,
    rootDirectory: root,
    createdAt: fixture.frozenAt,
  });
  return { root, fixture, privateKey, publicKey, signed: signBundle(bundle, privateKey) };
}

test("synthetischer Validierungsholdout qualifiziert und verifiziert die vollständige Artefaktkette", async (t) => {
  const { root, fixture, publicKey, signed } = await signedFixture(t);
  const verifiedChain = await verifyArtifactChainFiles(fixture.values.chain, root);
  assert.equal(verifiedChain.report.passed, true);
  assert.equal(verifiedChain.report.releaseQualified, true);
  assert.equal(verifiedChain.report.qualification.basis, "verified-disjoint-frozen-artifacts");
  assert.equal(verifiedChain.report.qualification.calibrationSampleCount, 2);
  assert.equal(verifiedChain.report.qualification.validationSampleCount, 2);
  assert.equal(verifiedChain.report.sources.technicalValidation.datasetId, "synthetic-validation-dataset-v1");
  assert.equal(verifiedChain.report.sources.technicalValidation.source.id, "synthetic-independent-validation-source");
  assert.equal(verifiedChain.report.assumptions.infrastructure.length, 1);
  assert.equal(verifiedChain.report.assumptions.vehicle.length, 1);
  assert.ok(verifiedChain.report.comparisons.every((comparison) => comparison.validationSampleId));
  assert.deepEqual(await verifyBundleFiles(signed, publicKey, root), signed.bundle);
});

test("fehlgeschlagene unabhängige Validierung bleibt vor Release-Manifest und Signatur gesperrt", async (t) => {
  const root = await temporaryDirectory(t, "failed-");
  const fixture = await materializeSyntheticValidationFixture(root);
  const failedModel = JSON.parse(canonicalJson(fixture.values.modelResults));
  failedModel.results[0].runningSeconds += 1_000;
  failedModel.results[0].modeledTimetableSeconds += 1_000;
  assert.throws(
    () => compareWithModel(fixture.values.corpus, failedModel, fixture.values.report.tolerance),
    /Rust-Releasecompiler/,
  );
});

test("jede nach der Signatur veränderte Artefaktdatei wird abgewiesen", async (t) => {
  const { root, fixture, publicKey, signed } = await signedFixture(t);
  const records = [
    ...Object.entries(fixture.values.chain.artifacts)
      .filter(([name]) => name !== "sourceTables")
      .map(([name, record]) => [name, record]),
    ...fixture.values.chain.artifacts.sourceTables.map((record, index) => [`sourceTables[${index}]`, record]),
  ];
  for (const [name, record] of records) {
    const file = path.join(root, record.path);
    const original = await readFile(file);
    await writeFile(file, Buffer.concat([original, Buffer.from("tampered")]));
    await assert.rejects(
      () => verifyBundleFiles(signed, publicKey, root),
      new RegExp(name === "release-chain" ? "Artefakthash" : "Artefakthash"),
      name,
    );
    await writeFile(file, original);
  }
  const chainFile = path.join(root, fixture.artifacts.chain.path);
  const originalChain = await readFile(chainFile);
  await writeFile(chainFile, Buffer.concat([originalChain, Buffer.from("tampered")]));
  await assert.rejects(() => verifyBundleFiles(signed, publicKey, root), /Artefakthash/);
});

test("Rust bindet Quellarchiv und jede Capture-Tabelle an das Capture-Manifest", async (t) => {
  for (const [index, target] of ["sourceArchive", "sourceTable"].entries()) {
    const root = await temporaryDirectory(t, `raw-binding-${index}-`);
    const fixture = await materializeSyntheticValidationFixture(root);
    const chain = JSON.parse(await readFile(path.join(root, fixture.artifacts.chain.path), "utf8"));
    const record = target === "sourceArchive" ? chain.artifacts.sourceArchive : chain.artifacts.sourceTables[0];
    const changed = Buffer.from(`manipulierte Rohbytes ${target}\n`);
    await writeFile(path.join(root, record.path), changed);
    record.sha256 = sha256(changed);
    await writeFile(path.join(root, fixture.artifacts.chain.path), jsonBytes(chain));
    await assert.rejects(
      () => createUnsignedBundleFromFiles({
        chainPath: fixture.artifacts.chain.path,
        rootDirectory: root,
        createdAt: fixture.frozenAt,
      }),
      /Quellarchiv|Capture-Tabelle/,
    );
  }
});

async function tamperJsonAndRebindChain(root, targetPath, mutate, chainArtifactName) {
  const targetFile = path.join(root, targetPath);
  const target = JSON.parse(await readFile(targetFile, "utf8"));
  mutate(target);
  const targetBytes = jsonBytes(target);
  await writeFile(targetFile, targetBytes);
  const chainFile = path.join(root, "release-chain.json");
  const chain = JSON.parse(await readFile(chainFile, "utf8"));
  chain.artifacts[chainArtifactName].sha256 = sha256(targetBytes);
  await writeFile(chainFile, jsonBytes(chain));
}

test("jede semantische Verbindung der Hashkette wird vor dem Signieren erneut geprüft", async (t) => {
  const cases = [
    {
      name: "Capture-Konfiguration -> Capture-Manifest",
      artifact: "captureManifest",
      mutate: (value) => { value.configArtifactSha256 = "f".repeat(64); },
      error: /Konfigurationsbytes/,
    },
    {
      name: "Capture-Manifest -> Normalisierung",
      artifact: "normalizedObservations",
      mutate: (value) => { value.capture.manifestSha256 = "f".repeat(64); },
      error: /Capture-Manifest/,
    },
    {
      name: "Normalisierung -> Referenzkorpus",
      artifact: "referenceCorpus",
      mutate: (value) => { value.artifactBinding.normalizedObservationsSha256 = "f".repeat(64); },
      error: /Referenzkorpus\.artifactBinding/,
    },
    {
      name: "Qualifikationsnachweis -> Evidenzdatensatz",
      artifact: "qualificationEvidence",
      mutate: (value) => { value.calibration.dataset.sha256 = "f".repeat(64); },
      error: /calibration\.dataset/,
    },
    {
      name: "eingefrorene Mindestmengen -> Qualifikationsnachweis",
      artifact: "qualificationEvidence",
      mutate: (value) => { value.policy.minimumValidationSamples = 1; },
      error: /Qualifikationsmindestmengen/,
    },
    {
      name: "Referenzkorpus -> Modellkonfiguration",
      artifact: "modelConfig",
      mutate: (value) => { value.artifactBinding.referenceCorpusSha256 = "f".repeat(64); },
      error: /modelConfig\.artifactBinding/,
    },
    {
      name: "Modellkonfiguration -> Modellergebnis",
      artifact: "modelResults",
      mutate: (value) => { value.modelInputSha256 = "f".repeat(64); },
      error: /Modellkonfigurationsbytes/,
    },
    {
      name: "Modellergebnis -> Abweichungsreport",
      artifact: "report",
      mutate: (value) => { value.artifactBinding.modelResultsSha256 = "f".repeat(64); },
      error: /Abweichungsreport/,
    },
    {
      name: "eingefrorene Toleranz -> Abweichungsreport",
      artifact: "report",
      mutate: (value) => { value.tolerance.absoluteSeconds = 999_999; },
      error: /Reporttoleranz/,
    },
    {
      name: "Abweichungsreport -> Release-Manifest",
      artifact: "releaseManifest",
      mutate: (value) => { value.qualification.reportSha256 = "f".repeat(64); },
      error: /Release-Manifest/,
    },
  ];
  for (const [index, fixtureCase] of cases.entries()) {
    await t.test(fixtureCase.name, async (subtest) => {
      const root = await temporaryDirectory(subtest, `link-${index}-`);
      const fixture = await materializeSyntheticValidationFixture(root);
      await tamperJsonAndRebindChain(
        root,
        fixture.values.chain.artifacts[fixtureCase.artifact].path,
        fixtureCase.mutate,
        fixtureCase.artifact,
      );
      await assert.rejects(
        () => createUnsignedBundleFromFiles({
          chainPath: fixture.artifacts.chain.path,
          rootDirectory: root,
          createdAt: fixture.frozenAt,
        }),
        fixtureCase.error,
      );
    });
  }
});

test("Bundle-Manipulation und falscher Release-Schlüssel werden kryptographisch abgewiesen", async (t) => {
  const { signed, publicKey, privateKey } = await signedFixture(t);
  assert.throws(() => signBundle({ ...signed.bundle }, privateKey), /nicht vollständig.*geprüft/);
  const tampered = JSON.parse(canonicalJson(signed));
  tampered.bundle.reportSha256 = "f".repeat(64);
  assert.throws(() => verifySignedBundle(tampered, publicKey), /ungültig/);
  const otherKey = generateKeyPairSync("ed25519").publicKey;
  assert.throws(() => verifySignedBundle(signed, otherKey), /erwarteten Release-Schlüssel/);
});
