import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishFileCreateNew, publishFilesCreateNew } from "./create-new-output.mjs";

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
