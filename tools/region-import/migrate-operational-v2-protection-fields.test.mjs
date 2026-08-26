import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  migrateOperationalV2ProtectionFields,
  parseMigrationCliArguments,
} from "./migrate-operational-v2-protection-fields.mjs";

const RELEASE_ID = "infra-deutschland-migration-test";

async function syntaxValidatingNativeReceipt(path, expectedReleaseId) {
  const bytes = await readFile(path);
  try {
    JSON.parse(bytes);
  } catch (error) {
    throw new Error(`Aktueller nativer Testvalidator wies JSON zurueck: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stateHash = createHash("sha256").update("test-state\0").update(bytes).digest("hex");
  return {
    schema: "operational-infrastructure-v2",
    infraReleaseId: expectedReleaseId,
    sourceBytes: bytes.length,
    sourceSha256: sha256,
    bytes: bytes.length,
    sha256,
    stateHash,
    validationMode: "native-streaming-redb-v1",
  };
}

function migrationOptions(paths, overrides = {}) {
  return {
    ...paths,
    expectedReleaseId: RELEASE_ID,
    expectedReplacements: 1,
    expectedGenericEtcsDropped: 0,
    expectedPzbFallbackApplied: 0,
    validateCurrent: syntaxValidatingNativeReceipt,
    ...overrides,
  };
}

async function fixture(t, source, existingOutput) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-protection-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputPath = join(root, "legacy.json");
  const outputPath = join(root, "migrated.json");
  await writeFile(inputPath, source);
  if (existingOutput !== undefined) await writeFile(outputPath, existingOutput);
  const expectedSourceBytes = Buffer.byteLength(source);
  const expectedSourceSha256 = createHash("sha256").update(source).digest("hex");
  return { inputPath, outputPath, expectedSourceBytes, expectedSourceSha256 };
}

test("migriert ueber Einbyte-Chunkgrenzen, erhaelt Fremdbytes und versteht escapte Systemstrings", async (t) => {
  const source = Buffer.from(
    "{ \"note\" : \"escaped \\\"requiredProtectionSystems\\\" and ] stay byte-identical\", \"legs\" : [ { \"requiredProtectionSystems\" \r\n : [\"lzb\",\"p\\u007Ab\"], \"tail\" : \"x\" }, {\"requiredProtection\\u0053ystems\":[\"etcs-level2\"]} ] }\n",
    "utf8",
  );
  const expected = Buffer.from(
    source.toString("utf8")
      .replace("\"requiredProtectionSystems\" \r\n : [\"lzb\",\"p\\u007Ab\"]", "\"availableProtectionSystems\" \r\n : [\"lzb\",\"p\\u007Ab\"],\"simultaneouslyRequiredProtectionSystems\":[]")
      .replace("\"requiredProtection\\u0053ystems\":[\"etcs-level2\"]", "\"availableProtectionSystems\":[\"etcs-level2\"],\"simultaneouslyRequiredProtectionSystems\":[]"),
    "utf8",
  );
  const paths = await fixture(t, source);
  const { inputPath, outputPath } = paths;

  const receipt = await migrateOperationalV2ProtectionFields(migrationOptions(
    paths,
    { chunkBytes: 1, expectedReplacements: 2 },
  ));

  assert.equal(receipt.replacements, 2);
  assert.equal(receipt.genericEtcsDropped, 0);
  assert.equal(receipt.pzbFallbackApplied, 0);
  assert.equal(receipt.expectedReleaseId, RELEASE_ID);
  assert.equal(receipt.schema, "zugfolge-operational-v2-protection-fields-migration-receipt/v1");
  assert.equal(receipt.sourceBytes, source.length);
  assert.equal(receipt.sourceSha256, createHash("sha256").update(source).digest("hex"));
  assert.equal(receipt.outputBytes, expected.length);
  assert.equal(receipt.outputSha256, createHash("sha256").update(expected).digest("hex"));
  assert.deepEqual(await readFile(inputPath), source);
  assert.deepEqual(await readFile(outputPath), expected);
  const parsed = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(parsed.legs[0].availableProtectionSystems, ["lzb", "pzb"]);
  assert.deepEqual(parsed.legs[0].simultaneouslyRequiredProtectionSystems, []);
  assert.equal(parsed.note, "escaped \"requiredProtectionSystems\" and ] stay byte-identical");
});

test("verweigert Null-Lauf sowie bereits aktuelle und gemischte Schluessel ohne Ausgabe", async (t) => {
  const cases = [
    ["zero", "{\"note\":\"requiredProtectionSystems\"}\n", /Null-Lauf/u],
    ["current", "{\"availableProtectionSystems\":[\"pzb\"],\"simultaneouslyRequiredProtectionSystems\":[]}\n", /bereits aktuelle oder gemischte/u],
    ["mixed", "{\"requiredProtectionSystems\":[\"pzb\"],\"availableProtectionSystems\":[\"pzb\"]}\n", /bereits aktuelle oder gemischte/u],
    ["escaped-current", "{\"availableProtection\\u0053ystems\":[\"pzb\"]}\n", /bereits aktuelle oder gemischte/u],
  ];
  for (const [name, source, expectedError] of cases) {
    await t.test(name, async (subtest) => {
      const paths = await fixture(subtest, source);
      await assert.rejects(
        migrateOperationalV2ProtectionFields(migrationOptions(paths, { chunkBytes: 3 })),
        expectedError,
      );
      await assert.rejects(readFile(paths.outputPath), { code: "ENOENT" });
    });
  }
});

test("entfernt generisches ETCS und wendet den gepinnten PZB-Fallback nur auf leere Restmengen an", async (t) => {
  const source = "{\"legs\":[{\"requiredProtectionSystems\":[\"pzb\"]},{\"requiredProtectionSystems\":[\"lzb\",\"pzb\"]},{\"requiredProtectionSystems\":[\"etcs\",\"pzb\"]},{\"requiredProtectionSystems\":[\"etcs\"]}]}\n";
  const paths = await fixture(t, source);

  const receipt = await migrateOperationalV2ProtectionFields(migrationOptions(paths, {
    expectedReplacements: 4,
    expectedGenericEtcsDropped: 2,
    expectedPzbFallbackApplied: 1,
    chunkBytes: 5,
  }));

  assert.equal(receipt.replacements, 4);
  assert.equal(receipt.genericEtcsDropped, 2);
  assert.equal(receipt.pzbFallbackApplied, 1);
  const migrated = JSON.parse(await readFile(paths.outputPath, "utf8"));
  assert.deepEqual(
    migrated.legs.map((leg) => leg.availableProtectionSystems),
    [["pzb"], ["lzb", "pzb"], ["pzb"], ["pzb"]],
  );
  assert.deepEqual(migrated.legs.map((leg) => leg.simultaneouslyRequiredProtectionSystems), [[], [], [], []]);
});

test("verweigert jeden Drift der drei expliziten Korpuszaehler ohne Ausgabe", async (t) => {
  const source = "{\"requiredProtectionSystems\":[\"etcs\"]}\n";
  const cases = [
    ["Ersetzungen", { expectedReplacements: 2 }, /1 statt 2 erwartete Ersetzungen/u],
    ["ETCS-Entfernungen", { expectedGenericEtcsDropped: 0 }, /1 statt 0 erwartete generische ETCS-Entfernungen/u],
    ["PZB-Fallbacks", { expectedPzbFallbackApplied: 0 }, /1 statt 0 erwartete PZB-Fallbacks/u],
  ];
  for (const [name, override, expectedError] of cases) {
    await t.test(name, async (subtest) => {
      const paths = await fixture(subtest, source);
      await assert.rejects(migrateOperationalV2ProtectionFields(migrationOptions(paths, {
        expectedGenericEtcsDropped: 1,
        expectedPzbFallbackApplied: 1,
        ...override,
      })), expectedError);
      await assert.rejects(readFile(paths.outputPath), { code: "ENOENT" });
    });
  }
});

test("verweigert falsche Legacy-Quellpins vor dem Anlegen einer Ausgabe", async (t) => {
  const source = "{\"requiredProtectionSystems\":[\"pzb\"]}\n";
  const cases = [
    ["Bytes", { expectedSourceBytes: Buffer.byteLength(source) + 1 }],
    ["SHA-256", { expectedSourceSha256: "0".repeat(64) }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async (subtest) => {
      const paths = await fixture(subtest, source);
      await assert.rejects(
        migrateOperationalV2ProtectionFields(migrationOptions(paths, override)),
        /verletzt ihre festen Pins/u,
      );
      await assert.rejects(readFile(paths.outputPath), { code: "ENOENT" });
    });
  }
});

test("veroeffentlicht trotz passender Zaehler kein syntaktisch ungueltiges aeusseres JSON", async (t) => {
  const cases = [
    ["nacktes Token", "{\"requiredProtectionSystems\":[\"pzb\"],\"x\":nonsense}\n"],
    ["fehlendes Komma", "{\"requiredProtectionSystems\":[\"pzb\"] \"x\":1}\n"],
    ["zwei Wurzeln", "{\"requiredProtectionSystems\":[\"pzb\"]}{\"x\":1}\n"],
  ];
  for (const [name, source] of cases) {
    await t.test(name, async (subtest) => {
      const paths = await fixture(subtest, source);
      await assert.rejects(
        migrateOperationalV2ProtectionFields(migrationOptions(paths)),
        /Testvalidator wies JSON zurueck/u,
      );
      await assert.rejects(readFile(paths.outputPath), { code: "ENOENT" });
    });
  }
});

test("veroeffentlicht keine nach dem nativen Receipt veraenderte Temporaerdatei", async (t) => {
  const source = "{\"requiredProtectionSystems\":[\"pzb\"]}\n";
  const paths = await fixture(t, source);
  const mutatingValidator = async (path, expectedReleaseId) => {
    const receipt = await syntaxValidatingNativeReceipt(path, expectedReleaseId);
    await writeFile(path, `${await readFile(path, "utf8")} `);
    return receipt;
  };

  await assert.rejects(
    migrateOperationalV2ProtectionFields(migrationOptions(paths, { validateCurrent: mutatingValidator })),
    /aenderte sich vor dem create-new Link/u,
  );
  await assert.rejects(readFile(paths.outputPath), { code: "ENOENT" });
});

test("behandelt den schliessenden Quote exakt an der 512-Byte-Keygrenze", async (t) => {
  const longKey = "x".repeat(511);
  const source = `{\"${longKey}\":0,\"requiredProtectionSystems\":[\"pzb\"]}\n`;
  const paths = await fixture(t, source);

  await migrateOperationalV2ProtectionFields(migrationOptions(paths, { chunkBytes: 17 }));

  const migrated = JSON.parse(await readFile(paths.outputPath, "utf8"));
  assert.equal(migrated[longKey], 0);
  assert.deepEqual(migrated.availableProtectionSystems, ["pzb"]);
});

test("erhaelt einen escapten Quote exakt hinter einem Backslash an der Key-Puffergrenze", async (t) => {
  const longKey = `${"x".repeat(510)}\"y`;
  const source = `{${JSON.stringify(longKey)}:0,\"requiredProtectionSystems\":[\"pzb\"]}\n`;
  const paths = await fixture(t, source);

  await migrateOperationalV2ProtectionFields(migrationOptions(paths, { chunkBytes: 19 }));

  const migrated = JSON.parse(await readFile(paths.outputPath, "utf8"));
  assert.equal(migrated[longKey], 0);
  assert.deepEqual(migrated.availableProtectionSystems, ["pzb"]);
});

test("begrenzt die JSON-Schachtelung bei fester Speichernutzung", async (t) => {
  const atLimit = `${"[".repeat(255)}{\"requiredProtectionSystems\":[\"pzb\"]}${"]".repeat(255)}\n`;
  const accepted = await fixture(t, atLimit);
  await migrateOperationalV2ProtectionFields(migrationOptions(accepted, { chunkBytes: 1 }));
  assert.ok((await readFile(accepted.outputPath)).length > 0);

  const beyondLimit = `${"[".repeat(256)}{\"requiredProtectionSystems\":[\"pzb\"]}${"]".repeat(256)}\n`;
  const rejected = await fixture(t, beyondLimit);
  await assert.rejects(
    migrateOperationalV2ProtectionFields(migrationOptions(rejected, { chunkBytes: 1 })),
    /JSON-Schachtelungsgrenze von 256/u,
  );
  await assert.rejects(readFile(rejected.outputPath), { code: "ENOENT" });
});

test("verweigert ungueltige oder semantisch nichtkanonische Legacy-Arrays", async (t) => {
  const cases = [
    ["kein Array", "{\"requiredProtectionSystems\":\"pzb\"}\n", /keinen Arraywert/u],
    ["leer", "{\"requiredProtectionSystems\":[]}\n", /nichtleere Systemliste/u],
    ["duplikat", "{\"requiredProtectionSystems\":[\"pzb\",\"pzb\"]}\n", /kanonisch sortiert/u],
    ["unsortiert", "{\"requiredProtectionSystems\":[\"pzb\",\"lzb\"]}\n", /kanonisch sortiert/u],
    ["unbekannt", "{\"requiredProtectionSystems\":[\"foo\"]}\n", /kanonisch sortiert/u],
    ["ungueltiges JSON", "{\"requiredProtectionSystems\":[\"pzb\",]}\n", /kein gueltiges JSON-Array/u],
  ];
  for (const [name, source, expectedError] of cases) {
    await t.test(name, async (subtest) => {
      const paths = await fixture(subtest, source);
      await assert.rejects(migrateOperationalV2ProtectionFields(migrationOptions(paths, { chunkBytes: 2 })), expectedError);
      await assert.rejects(readFile(paths.outputPath), { code: "ENOENT" });
    });
  }
});

test("create-new erhaelt eine vorhandene Zieldatei unveraendert", async (t) => {
  const existing = Buffer.from("do-not-overwrite\n", "utf8");
  const paths = await fixture(t, "{\"requiredProtectionSystems\":[\"pzb\"]}\n", existing);

  await assert.rejects(migrateOperationalV2ProtectionFields(migrationOptions(paths)), /create-new/u);

  assert.deepEqual(await readFile(paths.outputPath), existing);
});

test("CLI verlangt Release-ID, Legacy-Quellpins und alle drei expliziten Driftzaehler", () => {
  assert.deepEqual(parseMigrationCliArguments([
    "legacy.json",
    "new.json",
    "--expected-pzb-fallback-applied",
    "0",
    "--expected-generic-etcs-dropped",
    "25321",
    "--expected-release-id",
    "infra-deutschland-2026.3",
    "--expected-source-bytes",
    "1455920792",
    "--expected-source-sha256",
    "64bcc5a750c0667526baf95a5ae8f9fa9c6ff64e63b24462090cc1c36c6abb4c",
    "--expected-replacements",
    "644900",
  ]), {
    inputPath: "legacy.json",
    outputPath: "new.json",
    expectedReleaseId: "infra-deutschland-2026.3",
    expectedSourceBytes: 1_455_920_792,
    expectedSourceSha256: "64bcc5a750c0667526baf95a5ae8f9fa9c6ff64e63b24462090cc1c36c6abb4c",
    expectedReplacements: 644900,
    expectedGenericEtcsDropped: 25321,
    expectedPzbFallbackApplied: 0,
  });
  assert.throws(
    () => parseMigrationCliArguments(["legacy.json", "new.json", "--expected-release-id", RELEASE_ID]),
    /--expected-source-bytes fehlt/u,
  );
  assert.throws(
    () => parseMigrationCliArguments([
      "legacy.json", "new.json",
      "--expected-release-id", RELEASE_ID,
      "--expected-source-bytes", "1",
      "--expected-source-sha256", "0".repeat(64),
      "--expected-replacements", "01",
      "--expected-generic-etcs-dropped", "0",
      "--expected-pzb-fallback-applied", "0",
    ]),
    /nichtnegative Dezimalzahl/u,
  );
});
