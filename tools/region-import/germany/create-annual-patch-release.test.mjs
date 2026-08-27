import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";

import { createAnnualPatchRelease } from "./create-annual-patch-release.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-annual-patch-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const files = [
    "contracts/release.annual-{patch}.json",
    "contracts/package.annual-{patch}.plan.json",
  ];
  for (const template of files) {
    const path = join(root, template.replace("{patch}", "2026.4"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ id: "infra-deutschland-2026.4", path: "var/derived/germany-2026.4" }, null, 2)}\n`, "utf8");
  }
  return { files, root };
}

test("erstellt den vollstaendigen direkten Jahrespatch create-new und laesst Quellen bytegleich", async (t) => {
  const { files, root } = await fixture(t);
  const sourcePath = join(root, "contracts/release.annual-2026.4.json");
  const before = await readFile(sourcePath);

  const result = await createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.5", files });

  assert.deepEqual(result.files, [
    "contracts/release.annual-2026.5.json",
    "contracts/package.annual-2026.5.plan.json",
  ]);
  assert.deepEqual(await readFile(sourcePath), before);
  assert.deepEqual(JSON.parse(await readFile(join(root, result.files[0]), "utf8")), {
    id: "infra-deutschland-2026.5",
    path: "var/derived/germany-2026.5",
  });
});

test("verweigert vorhandene Ziele vor jeder Mutation", async (t) => {
  const { files, root } = await fixture(t);
  const existing = join(root, "contracts/release.annual-2026.5.json");
  await writeFile(existing, "unveraendert\n", "utf8");

  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.5", files }),
    /existiert bereits.*create-new/u,
  );
  assert.equal(await readFile(existing, "utf8"), "unveraendert\n");
  await assert.rejects(readFile(join(root, "contracts/package.annual-2026.5.plan.json")), /ENOENT/u);
});

test("verweigert uebersprungene, fremde oder bereits vermischte Patchidentitaeten", async (t) => {
  const { files, root } = await fixture(t);
  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.6", files }),
    /direkte naechste Patch/u,
  );
  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2027.5", files }),
    /direkte naechste Patch/u,
  );

  const mixed = join(root, "contracts/package.annual-2026.4.plan.json");
  await writeFile(mixed, '{"id":"infra-deutschland-2026.4","future":"2026.5"}\n', "utf8");
  await assert.rejects(
    createAnnualPatchRelease({ repositoryRoot: root, sourcePatch: "2026.4", targetPatch: "2026.5", files }),
    /enthaelt bereits Zielpatch/u,
  );
});
