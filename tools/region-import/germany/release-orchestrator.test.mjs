import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { canonical } from "./quality-model.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const node = process.execPath;
const script = join(root, "tools/region-import/germany/build-germany-release.mjs");
const fixturePath = join(root, "crates/zugfolge-infra/tests/fixtures/release-manifest-input.json");
const goldenPath = join(root, "crates/zugfolge-infra/tests/fixtures/public-release.golden.json");

async function run(args, cwd = root) {
  await new Promise((accept, reject) => {
    const child = spawn(node, [script, ...args], { cwd, stdio: "ignore", shell: false });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`Orchestrator endete mit ${code}.`)));
  });
}

test("JavaScript-Orchestrator liefert byteidentisch den Rust-Golden-Master", { timeout: 120_000 }, async (context) => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-release-orchestrator-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(
    ["config", "catalog", "rights", "capture", "artifacts", "quality"].map(async (key) => {
      const path = join(directory, `${key}.json`);
      await writeFile(path, `${JSON.stringify(key === "artifacts" ? { artifacts: fixture[key] } : fixture[key], null, 2)}\n`);
    }),
  );
  const output = join(directory, "release.json");
  await run(
    ["manifest", "config.json", "catalog.json", "rights.json", "capture.json", "artifacts.json", "quality.json", "release.json"],
    directory,
  );
  const actual = JSON.parse(await readFile(output, "utf8"));
  const golden = JSON.parse(await readFile(goldenPath, "utf8"));
  assert.deepEqual(actual, golden);
  assert.equal(canonical(actual), canonical(golden));
});

test("JavaScript-Korpusbildung ist ohne sichtbare Nicht-Autoritativ-Freigabe fail-closed", async () => {
  await assert.rejects(
    run(["compile"]),
    /Orchestrator endete/,
  );
});
