import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createGdalRuntimeBundleManifest,
  gdalRuntimeBundleBinding,
  loadGdalRuntimeBundle,
  validateGdalRuntimeBundleCacheInventory,
  verifyGdalRuntimeBundle,
  writeGdalRuntimeBundle,
} from "./gdal-runtime-bundle.mjs";

const VERSION_STDOUT = "GDAL 3.13.2 fixture";
const PMTILES_LINE = "PMTiles -vector- (rw+v): ProtoMap Tiles (*.pmtiles)";

function fixtureProfile() {
  return {
    runtimeId: "gdal-fixture-3.13.2",
    version: "3.13.2",
    platform: { os: process.platform, arch: process.arch },
    entryPoint: { sourceFile: "runtime/entry/ogr2ogr.exe", cacheFile: "tools/runtime/entry/ogr2ogr.exe" },
    environment: {
      pathPrepend: { sourceDirectory: "runtime/lib", cacheDirectory: "tools/runtime/lib" },
      gdalData: { sourceDirectory: "runtime/share/gdal", cacheDirectory: "tools/runtime/share/gdal" },
      projData: { sourceDirectory: "runtime/share/proj", cacheDirectory: "tools/runtime/share/proj" },
    },
    scopes: [
      { kind: "file", sourcePath: "runtime/entry/ogr2ogr.exe", cachePath: "tools/runtime/entry/ogr2ogr.exe" },
      { kind: "directory", sourcePath: "runtime/lib", cachePath: "tools/runtime/lib" },
      { kind: "directory", sourcePath: "runtime/share/gdal", cachePath: "tools/runtime/share/gdal" },
      { kind: "directory", sourcePath: "runtime/share/proj", cachePath: "tools/runtime/share/proj" },
    ],
    probes: {
      version: { args: ["--version"], expectedStdout: VERSION_STDOUT },
      pmtilesDriver: { args: ["--formats"], expectedStdoutLine: PMTILES_LINE },
    },
  };
}

async function put(root, portable, bytes) {
  const path = join(root, ...portable.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-gdal-runtime-"));
  await put(root, "runtime/entry/ogr2ogr.exe", "fixture entry point\n");
  await put(root, "runtime/lib/gdal.dll", "fixture dll\n");
  await put(root, "runtime/share/gdal/header.dxf", "fixture gdal data\n");
  await put(root, "runtime/share/proj/proj.db", "fixture proj data\n");
  const manifest = await createGdalRuntimeBundleManifest({ profile: fixtureProfile(), artifactRoot: root });
  return { root, manifest };
}

async function executeProbe({ args }) {
  if (args[0] === "--version") return { stdout: `${VERSION_STDOUT}\r\n`, stderr: "" };
  return { stdout: `  ${PMTILES_LINE}\r\n`, stderr: "" };
}

test("bindet und startet die exakte Runtime-Dateimenge aus dem Source-Layout", async () => {
  const value = await fixture();
  try {
    const verified = await verifyGdalRuntimeBundle({ manifest: value.manifest, artifactRoot: value.root, executeProbe });
    assert.equal(verified.files, 4);
    assert.equal(verified.bytes, value.manifest.inventory.bytes);
    assert.equal(verified.probes.version, VERSION_STDOUT);
    assert.equal(verified.probes.pmtilesDriver, PMTILES_LINE);
    assert.equal(verified.invocation.command, join(value.root, "runtime", "entry", "ogr2ogr.exe"));
    assert.equal(verified.invocation.environment.GDAL_DATA, join(value.root, "runtime", "share", "gdal"));
    assert.equal(verified.invocation.environment.PROJ_DATA, join(value.root, "runtime", "share", "proj"));
    assert.ok(verified.invocation.environment.PATH.startsWith(join(value.root, "runtime", "lib")));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("verifiziert dieselbe Runtime aus dem vollständigen Cache-Restore-Layout", async () => {
  const value = await fixture();
  const restored = await mkdtemp(join(tmpdir(), "zugfolge-gdal-runtime-cache-"));
  try {
    for (const file of value.manifest.files) {
      const target = join(restored, ...file.cacheFile.split("/"));
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(join(value.root, ...file.sourceFile.split("/")), target);
    }
    const verified = await verifyGdalRuntimeBundle({ manifest: value.manifest, artifactRoot: restored, layout: "cache", executeProbe });
    assert.equal(verified.files, value.manifest.inventory.files);
    assert.equal(verified.invocation.command, join(restored, "tools", "runtime", "entry", "ogr2ogr.exe"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test("lehnt fehlende, zusätzliche und geänderte Runtime-Dateien ab", async () => {
  const value = await fixture();
  try {
    await rm(join(value.root, "runtime", "lib", "gdal.dll"));
    await assert.rejects(
      verifyGdalRuntimeBundle({ manifest: value.manifest, artifactRoot: value.root, executeProbe }),
      /fehlende, zusätzliche oder falsch abgebildete Dateien/u,
    );
    await put(value.root, "runtime/lib/gdal.dll", "fixture dll\n");
    await put(value.root, "runtime/lib/unexpected.dll", "unexpected\n");
    await assert.rejects(
      verifyGdalRuntimeBundle({ manifest: value.manifest, artifactRoot: value.root, executeProbe }),
      /fehlende, zusätzliche oder falsch abgebildete Dateien/u,
    );
    await rm(join(value.root, "runtime", "lib", "unexpected.dll"));
    await writeFile(join(value.root, "runtime", "lib", "gdal.dll"), "mutated dll\n");
    await assert.rejects(
      verifyGdalRuntimeBundle({ manifest: value.manifest, artifactRoot: value.root, executeProbe }),
      /weicht vom Manifest ab/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("lehnt falsche Plattform und fehlenden PMTiles-rw+v-Probeausgang ab", async () => {
  const value = await fixture();
  try {
    const wrongPlatform = structuredClone(value.manifest);
    wrongPlatform.platform.os = process.platform === "win32" ? "linux" : "win32";
    await assert.rejects(
      verifyGdalRuntimeBundle({ manifest: wrongPlatform, artifactRoot: value.root, executeProbe }),
      /GDAL-Runtime verlangt/u,
    );
    await assert.rejects(
      verifyGdalRuntimeBundle({
        manifest: value.manifest,
        artifactRoot: value.root,
        executeProbe: async ({ args }) => args[0] === "--version"
          ? { stdout: VERSION_STDOUT, stderr: "" }
          : { stdout: "PMTiles -vector- (ro): unavailable\n", stderr: "" },
      }),
      /PMTiles-rw\+v/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("bindet Runtime-Dateien vollständig an das Cache-Inventar", async () => {
  const value = await fixture();
  try {
    const inventory = value.manifest.files.map(({ cacheFile: path, bytes, sha256 }) => ({ path, bytes, sha256 }));
    const binding = gdalRuntimeBundleBinding(value.manifest);
    assert.equal(validateGdalRuntimeBundleCacheInventory(binding, inventory).length, value.manifest.inventory.files);
    await assert.rejects(async () => validateGdalRuntimeBundleCacheInventory(binding, inventory.slice(1)), /fehlende oder zusätzliche/u);
    const mutated = structuredClone(inventory);
    mutated[0].sha256 = "f".repeat(64);
    await assert.rejects(async () => validateGdalRuntimeBundleCacheInventory(binding, mutated), /exakten Manifestdateimenge/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("schreibt und lädt das kanonische Manifest create-new", async () => {
  const value = await fixture();
  try {
    const output = join(value.root, "contracts", "runtime.manifest.json");
    const written = await writeGdalRuntimeBundle(value.manifest, output);
    const loaded = await loadGdalRuntimeBundle(output);
    assert.equal(loaded.sha256, written.sha256);
    assert.deepEqual(loaded.manifest, value.manifest);
    await assert.rejects(writeGdalRuntimeBundle(value.manifest, output), /EEXIST/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("weist symbolische Links und Junctions im Runtime-Scope zurück", async (context) => {
  const value = await fixture();
  try {
    const target = join(value.root, "outside-lib");
    await mkdir(target);
    await writeFile(join(target, "gdal.dll"), "fixture dll\n");
    const link = join(value.root, "runtime", "lib");
    await rm(link, { recursive: true });
    try {
      await symlink(target, link, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        context.skip(`Symlink auf diesem Host nicht verfügbar: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      verifyGdalRuntimeBundle({ manifest: value.manifest, artifactRoot: value.root, executeProbe }),
      /symbolischen Link|Reparse/u,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
