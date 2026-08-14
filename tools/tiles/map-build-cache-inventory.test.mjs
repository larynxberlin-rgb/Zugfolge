import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MAP_BUILD_CACHE_INVENTORY_PLAN_SCHEMA,
  MAP_BUILD_CACHE_INVENTORY_SCHEMA,
  buildMapBuildCacheInventory,
  loadMapBuildCacheInventoryPlan,
  writeMapBuildCacheInventory,
} from "./map-build-cache-inventory.mjs";

const RELEASE_ID = "infra-deutschland-2026.2";
const CLI = fileURLToPath(new URL("./map-build-cache-inventory-cli.mjs", import.meta.url));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-cache-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, "artifacts");
  await mkdir(artifactRoot);
  return { root, artifactRoot };
}

async function put(root, portablePath, bytes) {
  const path = join(root, ...portablePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

function plan(files, overrides = {}) {
  return {
    schema: MAP_BUILD_CACHE_INVENTORY_PLAN_SCHEMA,
    releaseId: RELEASE_ID,
    files,
    ...overrides,
  };
}

test("builds a deterministic cache inventory sorted by cache path", async (t) => {
  const { root, artifactRoot } = await fixture(t);
  const alpha = Buffer.from("alpha-cache-bytes");
  const zeta = Buffer.from("zeta-cache-bytes");
  await put(artifactRoot, "derived/zeta.bin", zeta);
  await put(artifactRoot, "sources/alpha.bin", alpha);

  const input = plan([
    { sourceFile: "derived/zeta.bin", cacheFile: "derived/zeta.bin" },
    { sourceFile: "sources/alpha.bin", cacheFile: "archives/alpha.bin" },
  ]);
  const first = await buildMapBuildCacheInventory({ releaseId: RELEASE_ID, artifactRoot, plan: input });
  const second = await buildMapBuildCacheInventory({ releaseId: RELEASE_ID, artifactRoot, plan: input });

  assert.deepEqual(first.inventory, {
    schema: MAP_BUILD_CACHE_INVENTORY_SCHEMA,
    releaseId: RELEASE_ID,
    files: [
      { path: "archives/alpha.bin", bytes: alpha.length, sha256: sha256(alpha) },
      { path: "derived/zeta.bin", bytes: zeta.length, sha256: sha256(zeta) },
    ],
  });
  assert.ok(first.inventoryBytes.equals(second.inventoryBytes));
  assert.equal(first.inventorySha256, sha256(first.inventoryBytes));

  const firstOutput = join(root, "output", "inventory-first.json");
  const secondOutput = join(root, "output", "inventory-second.json");
  await writeMapBuildCacheInventory(first, firstOutput);
  await writeMapBuildCacheInventory(second, secondOutput);
  assert.ok((await readFile(firstOutput)).equals(await readFile(secondOutput)));
  assert.equal((await readFile(firstOutput, "utf8")).at(-1), "\n");
});

test("rejects duplicate source and cache paths including case collisions", async (t) => {
  const { artifactRoot } = await fixture(t);
  await put(artifactRoot, "source.bin", "source");

  await assert.rejects(
    buildMapBuildCacheInventory({
      releaseId: RELEASE_ID,
      artifactRoot,
      plan: plan([
        { sourceFile: "source.bin", cacheFile: "one.bin" },
        { sourceFile: "SOURCE.bin", cacheFile: "two.bin" },
      ]),
    }),
    /Quellpfad .* doppelt/,
  );
  await assert.rejects(
    buildMapBuildCacheInventory({
      releaseId: RELEASE_ID,
      artifactRoot,
      plan: plan([
        { sourceFile: "source.bin", cacheFile: "cache.bin" },
        { sourceFile: "other.bin", cacheFile: "CACHE.bin" },
      ]),
    }),
    /Cachepfad .* doppelt/,
  );
});

test("rejects unsafe, mutable, reserved, and release-mismatched plans", async (t) => {
  const { artifactRoot } = await fixture(t);
  await put(artifactRoot, "source.bin", "source");
  const cases = [
    [plan([{ sourceFile: "../outside.bin", cacheFile: "source.bin" }]), /unsicheren Pfadabschnitt/],
    [plan([{ sourceFile: "source.bin", cacheFile: "sources/latest.bin" }]), /latest noch unversioniert/],
    [plan([{ sourceFile: "source.bin", cacheFile: ".zugfolge-private.json" }]), /reservierten Cachepfad/],
    [plan([{ sourceFile: "source.bin", cacheFile: "source.bin", ignored: true }]), /unerwartete oder fehlende Felder/],
    [plan([{ sourceFile: "source.bin", cacheFile: "source.bin" }], { releaseId: "infra-deutschland-2026.1" }), /anderen Release/],
  ];
  for (const [input, expected] of cases) {
    await assert.rejects(buildMapBuildCacheInventory({ releaseId: RELEASE_ID, artifactRoot, plan: input }), expected);
  }
});

test("rejects directories, empty files, and symlinks below artifactRoot", async (t) => {
  const { root, artifactRoot } = await fixture(t);
  await mkdir(join(artifactRoot, "directory"));
  await put(artifactRoot, "empty.bin", Buffer.alloc(0));
  await assert.rejects(
    buildMapBuildCacheInventory({
      releaseId: RELEASE_ID,
      artifactRoot,
      plan: plan([{ sourceFile: "directory", cacheFile: "directory.bin" }]),
    }),
    /reguläre Datei/,
  );
  await assert.rejects(
    buildMapBuildCacheInventory({
      releaseId: RELEASE_ID,
      artifactRoot,
      plan: plan([{ sourceFile: "empty.bin", cacheFile: "empty.bin" }]),
    }),
    /darf nicht leer sein/,
  );

  const outside = join(root, "outside");
  await mkdir(outside);
  await put(outside, "secret.bin", "secret");
  const link = join(artifactRoot, "linked-directory");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    buildMapBuildCacheInventory({
      releaseId: RELEASE_ID,
      artifactRoot,
      plan: plan([{ sourceFile: "linked-directory/secret.bin", cacheFile: "secret.bin" }]),
    }),
    /symbolischen Link/,
  );
});

test("writes create-new atomically and never replaces an existing output", async (t) => {
  const { root, artifactRoot } = await fixture(t);
  await put(artifactRoot, "source.bin", "source");
  const result = await buildMapBuildCacheInventory({
    releaseId: RELEASE_ID,
    artifactRoot,
    plan: plan([{ sourceFile: "source.bin", cacheFile: "source.bin" }]),
  });
  const output = join(root, "inventory.json");
  const sentinel = Buffer.from("do-not-replace");
  await writeFile(output, sentinel);
  await assert.rejects(writeMapBuildCacheInventory(result, output), (error) => error?.code === "EEXIST");
  assert.ok((await readFile(output)).equals(sentinel));
});

test("loads only a regular bounded UTF-8 JSON plan", async (t) => {
  const { root } = await fixture(t);
  const validPath = join(root, "plan.json");
  const input = plan([{ sourceFile: "source.bin", cacheFile: "source.bin" }]);
  await writeFile(validPath, `${JSON.stringify(input)}\n`);
  assert.deepEqual(await loadMapBuildCacheInventoryPlan(validPath), input);

  const invalidPath = join(root, "invalid.json");
  await writeFile(invalidPath, Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(loadMapBuildCacheInventoryPlan(invalidPath), /kein gültiges UTF-8-JSON/);
});

test("CLI materializes the same deterministic v1 inventory", async (t) => {
  const { root, artifactRoot } = await fixture(t);
  const bytes = Buffer.from("cli-source-bytes");
  await put(artifactRoot, "source.bin", bytes);
  const planPath = join(root, "plan.json");
  const outputPath = join(root, "out", "inventory.json");
  await writeFile(planPath, `${JSON.stringify(plan([{ sourceFile: "source.bin", cacheFile: "cache/source.bin" }]), null, 2)}\n`);

  const result = spawnSync(process.execPath, [CLI, "build", RELEASE_ID, artifactRoot, planPath, outputPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    action: "built",
    releaseId: RELEASE_ID,
    inventoryPath: outputPath,
    inventoryBytes: (await readFile(outputPath)).length,
    inventorySha256: sha256(await readFile(outputPath)),
    files: 1,
  });
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
    schema: MAP_BUILD_CACHE_INVENTORY_SCHEMA,
    releaseId: RELEASE_ID,
    files: [{ path: "cache/source.bin", bytes: bytes.length, sha256: sha256(bytes) }],
  });
});
