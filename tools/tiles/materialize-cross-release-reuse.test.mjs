import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  crossReleaseReusePlan,
  materializeCrossReleaseReuse,
} from "./materialize-cross-release-reuse.mjs";

const sourceReleaseId = "infra-deutschland-2026.3";
const targetReleaseId = "infra-deutschland-2026.5";

function proof(bytes) {
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function specification(artifacts) {
  return {
    schema: "zugfolge-map-release-build-evidence-spec/v2",
    releaseId: targetReleaseId,
    inputs: [{
      id: "semantic-spec",
      kind: "specification",
      version: sourceReleaseId,
      file: "tools/spec.json",
      reuse: {
        mode: "byte-identical-cross-release",
        sourceReleaseId,
        targetReleaseId,
        artifacts,
      },
    }],
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-cross-release-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const values = [Buffer.from("alpha\n"), Buffer.from("beta\n")];
  const artifacts = values.map((bytes, index) => ({
    sourceFile: `var/derived/germany-2026.3/layers/${index}.bin`,
    targetFile: `var/derived/germany-2026.5/layers/${index}.bin`,
    ...proof(bytes),
  }));
  for (const [index, bytes] of values.entries()) {
    const path = join(root, artifacts[index].sourceFile);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  return { root, values, artifacts, spec: specification(artifacts) };
}

test("materialisiert alle gepinnten Artefakte atomar create-new und unabhängig von der Quelle", async (t) => {
  const value = await fixture(t);
  const receipt = await materializeCrossReleaseReuse({ spec: value.spec, artifactRoot: value.root });
  assert.equal(receipt.schema, "zugfolge-cross-release-reuse-materialization/v1");
  assert.equal(receipt.releaseId, targetReleaseId);
  assert.equal(receipt.artifactCount, 2);
  for (const [index, artifact] of value.artifacts.entries()) {
    assert.deepEqual(await readFile(join(value.root, artifact.targetFile)), value.values[index]);
  }

  await writeFile(join(value.root, value.artifacts[0].targetFile), "changed\n");
  assert.deepEqual(await readFile(join(value.root, value.artifacts[0].sourceFile)), value.values[0]);
});

test("verweigert vorhandene Ziele vor jeder Veröffentlichung", async (t) => {
  const value = await fixture(t);
  const existing = join(value.root, value.artifacts[1].targetFile);
  await mkdir(dirname(existing), { recursive: true });
  await writeFile(existing, "keep\n");
  await assert.rejects(
    materializeCrossReleaseReuse({ spec: value.spec, artifactRoot: value.root }),
    /existiert bereits|create-new/u,
  );
  assert.equal(await readFile(existing, "utf8"), "keep\n");
  await assert.rejects(lstat(join(value.root, value.artifacts[0].targetFile)), { code: "ENOENT" });
});

test("verweigert fehlende oder veränderte Quellen ohne Zielartefakt", async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.root, value.artifacts[0].sourceFile), "tampered\n");
  await assert.rejects(
    materializeCrossReleaseReuse({ spec: value.spec, artifactRoot: value.root }),
    /Bytezahl|Byte-SHA/u,
  );
  for (const artifact of value.artifacts) {
    await assert.rejects(lstat(join(value.root, artifact.targetFile)), { code: "ENOENT" });
  }
});

test("verweigert Junctions im Quellpfad", async (t) => {
  const value = await fixture(t);
  const realDirectory = join(value.root, "outside");
  const linkedDirectory = join(value.root, "linked");
  await mkdir(realDirectory);
  await writeFile(join(realDirectory, "source.bin"), "junction\n");
  await symlink(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  const bytes = Buffer.from("junction\n");
  const artifact = {
    sourceFile: "linked/germany-2026.3/source.bin",
    targetFile: "linked/germany-2026.5/source.bin",
    ...proof(bytes),
  };
  await assert.rejects(
    materializeCrossReleaseReuse({ spec: specification([artifact]), artifactRoot: value.root }),
    /symbolischen Link|Junction/u,
  );
});

test("rollt bereits veröffentlichte Ziele bei einem späten Publish-Fehler zurück", async (t) => {
  const value = await fixture(t);
  let calls = 0;
  const publishLink = async (source, target) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("injected publish failure"), { code: "EIO" });
    return link(source, target);
  };
  await assert.rejects(
    materializeCrossReleaseReuse({ spec: value.spec, artifactRoot: value.root, publishLink }),
    /injected publish failure/u,
  );
  for (const artifact of value.artifacts) {
    await assert.rejects(lstat(join(value.root, artifact.targetFile)), { code: "ENOENT" });
  }
});

test("quittiert keine gleich lang manipulierten Staging-Bytes und rollt eigene Links zurück", async (t) => {
  const value = await fixture(t);
  let calls = 0;
  const publishLink = async (source, target) => {
    calls += 1;
    if (calls === 1) await writeFile(source, Buffer.alloc(value.values[0].length, 0x78));
    return link(source, target);
  };
  await assert.rejects(
    materializeCrossReleaseReuse({ spec: value.spec, artifactRoot: value.root, publishLink }),
    /Byte-SHA-Beleg/u,
  );
  for (const artifact of value.artifacts) {
    await assert.rejects(lstat(join(value.root, artifact.targetFile)), { code: "ENOENT" });
  }
});

test("entfernt einen eigenen größenveränderten Link bei fehlgeschlagener Abschlussprüfung", async (t) => {
  const value = await fixture(t);
  let calls = 0;
  const publishLink = async (source, target) => {
    calls += 1;
    if (calls === 1) await writeFile(source, Buffer.concat([value.values[0], Buffer.from("tampered\n")]));
    return link(source, target);
  };
  await assert.rejects(
    materializeCrossReleaseReuse({ spec: value.spec, artifactRoot: value.root, publishLink }),
    /Dateidentität/u,
  );
  for (const artifact of value.artifacts) {
    await assert.rejects(lstat(join(value.root, artifact.targetFile)), { code: "ENOENT" });
  }
});

test("Planprüfung verwirft nichtkanonische, doppelte und releasefremde Ziele", () => {
  const bytes = Buffer.from("alpha\n");
  const artifact = {
    sourceFile: "var/derived/germany-2026.3/layers/a.bin",
    targetFile: "var/derived/germany-2026.4/layers/a.bin",
    ...proof(bytes),
  };
  assert.throws(() => crossReleaseReusePlan(specification([artifact])), /nicht kanonisch/u);
  const canonical = { ...artifact, targetFile: "var/derived/germany-2026.5/layers/a.bin" };
  assert.throws(() => crossReleaseReusePlan(specification([canonical, canonical])), /doppelte/u);
  assert.throws(
    () => crossReleaseReusePlan({ ...specification([canonical]), releaseId: "infra-europa-2026.5" }),
    /Jahresfamilie|Buildrelease/u,
  );
  assert.throws(
    () => crossReleaseReusePlan(specification([{
      ...canonical,
      sourceFile: "var/derived/germany-2026.3/latest/a.bin",
      targetFile: "var/derived/germany-2026.5/latest/a.bin",
    }])),
    /latest|unversioniert/u,
  );
});

test("inventarisiert den eingecheckten Deutschland-Vertrag vollständig", async () => {
  const actual = JSON.parse(await readFile(
    new URL("./map-release-build-evidence.annual-2026.4.spec.json", import.meta.url),
    "utf8",
  ));
  const plan = crossReleaseReusePlan(actual);
  assert.equal(plan.releaseId, "infra-deutschland-2026.4");
  assert.equal(plan.artifacts.length, 20);
  assert.equal(new Set(plan.artifacts.map(({ targetFile }) => targetFile)).size, 20);
});

test("übernimmt denselben Wiederverwendungsvertrag in Build-Evidence-v3", async (t) => {
  const value = await fixture(t);
  const spec = { ...value.spec, schema: "zugfolge-map-release-build-evidence-spec/v3" };
  const receipt = await materializeCrossReleaseReuse({ spec, artifactRoot: value.root });
  assert.equal(receipt.releaseId, targetReleaseId);
  assert.equal(receipt.artifactCount, 2);
});
