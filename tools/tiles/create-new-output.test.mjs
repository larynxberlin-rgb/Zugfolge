import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  CREATE_NEW_DIRECTORY_COMPLETION_FILE,
  CREATE_NEW_DIRECTORY_COMPLETION_SCHEMA,
  publishDirectoryCreateNew,
  publishFileCreateNew,
  publishFilesCreateNew,
  verifyCreateNewDirectoryCompletion,
} from "./create-new-output.mjs";

test("create-new publiziert eine vollstaendige Staging-Datei und ersetzt kein vorhandenes Ziel", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-create-new-file-"));
  try {
    const staged = join(root, "staged.json");
    const output = join(root, "output.json");
    await writeFile(staged, "first");
    await publishFileCreateNew(staged, output, "Testziel");
    assert.equal(await readFile(output, "utf8"), "first");

    const second = join(root, "second.json");
    await writeFile(second, "second");
    await assert.rejects(
      publishFileCreateNew(second, output, "Testziel"),
      (error) => error?.code === "EEXIST" && /weder ersetzt noch wiederverwendet/u.test(error.message),
    );
    assert.equal(await readFile(output, "utf8"), "first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Mehrdatei-Publikation rollt ihr erstes Ziel bei einer Kollision des zweiten Ziels zurueck", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-create-new-multiple-"));
  try {
    const stagedFirst = join(root, "staged-first");
    const stagedSecond = join(root, "staged-second");
    const outputFirst = join(root, "output-first");
    const outputSecond = join(root, "output-second");
    await Promise.all([
      writeFile(stagedFirst, "first"),
      writeFile(stagedSecond, "second"),
      writeFile(outputSecond, "existing-partial-target"),
    ]);
    await assert.rejects(
      publishFilesCreateNew([
        { stagedPath: stagedFirst, outputPath: outputFirst, label: "Erstes Ziel" },
        { stagedPath: stagedSecond, outputPath: outputSecond, label: "Zweites Ziel" },
      ]),
      (error) => error?.code === "EEXIST",
    );
    await assert.rejects(readFile(outputFirst), (error) => error?.code === "ENOENT");
    assert.equal(await readFile(outputSecond, "utf8"), "existing-partial-target");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("konkurrierende Verzeichnispublikation reserviert POSIX-sicher genau einen Sieger", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-create-new-directory-race-"));
  try {
    const target = join(root, "published");
    const contenders = [
      { id: "first", hash: "a".repeat(64), staged: join(root, "staged-first") },
      { id: "second", hash: "b".repeat(64), staged: join(root, "staged-second") },
    ];
    for (const contender of contenders) {
      await mkdir(contender.staged);
      await writeFile(join(contender.staged, "payload.txt"), contender.id);
    }
    const results = await Promise.allSettled(contenders.map(async (contender) => {
      await publishDirectoryCreateNew(contender.staged, target, {
        schema: CREATE_NEW_DIRECTORY_COMPLETION_SCHEMA,
        kind: "race-fixture",
        bindingSha256: contender.hash,
      }, "Race-Ziel");
      return contender;
    }));
    const fulfilled = results.filter(({ status }) => status === "fulfilled");
    const rejected = results.filter(({ status }) => status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason?.code, "EEXIST");
    const winner = fulfilled[0].value;
    assert.equal(await readFile(join(target, "payload.txt"), "utf8"), winner.id);
    await verifyCreateNewDirectoryCompletion(target, { kind: "race-fixture", bindingSha256: winner.hash });
    assert.deepEqual((await readdir(target)).sort(), [CREATE_NEW_DIRECTORY_COMPLETION_FILE, "payload.txt"].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("vorhandener partieller Verzeichnisbaum wird nie ersetzt und bleibt ohne Completion unbrauchbar", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-create-new-directory-partial-"));
  try {
    const staged = join(root, "staged");
    const target = join(root, "published");
    await Promise.all([mkdir(staged), mkdir(target)]);
    await Promise.all([
      writeFile(join(staged, "payload.txt"), "new"),
      writeFile(join(target, "foreign.txt"), "existing"),
    ]);
    await assert.rejects(
      publishDirectoryCreateNew(staged, target, {
        schema: CREATE_NEW_DIRECTORY_COMPLETION_SCHEMA,
        kind: "partial-fixture",
        bindingSha256: "c".repeat(64),
      }, "Partielles Ziel"),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(await readFile(join(target, "foreign.txt"), "utf8"), "existing");
    await assert.rejects(verifyCreateNewDirectoryCompletion(target), /unvollstaendig/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nach der Zielreservierung eingeschobener Fremdeintrag wird unter Linux-Rennen nie ersetzt", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-create-new-directory-entry-race-"));
  try {
    const staged = join(root, "staged");
    const target = join(root, "published");
    const stagedTree = join(staged, "a-tree");
    await mkdir(stagedTree, { recursive: true });
    await Promise.all(Array.from({ length: 512 }, (_, index) => (
      writeFile(join(stagedTree, `${String(index).padStart(4, "0")}.txt`), `payload-${index}`)
    )));
    await writeFile(join(staged, "z-collision.txt"), "publisher");

    const foreignEntry = join(target, "z-collision.txt");
    const insertForeignEntry = async () => {
      for (;;) {
        try {
          await writeFile(foreignEntry, "foreign", { flag: "wx" });
          return;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await delay(0);
        }
      }
    };
    const [publication, insertion] = await Promise.allSettled([
      publishDirectoryCreateNew(staged, target, {
        schema: CREATE_NEW_DIRECTORY_COMPLETION_SCHEMA,
        kind: "entry-race-fixture",
        bindingSha256: "d".repeat(64),
      }, "Entry-Race-Ziel"),
      insertForeignEntry(),
    ]);
    assert.equal(insertion.status, "fulfilled");
    assert.equal(publication.status, "rejected");
    assert.equal(publication.reason?.code, "EEXIST");
    assert.equal(await readFile(foreignEntry, "utf8"), "foreign");
    await assert.rejects(verifyCreateNewDirectoryCompletion(target), /unvollstaendig/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
