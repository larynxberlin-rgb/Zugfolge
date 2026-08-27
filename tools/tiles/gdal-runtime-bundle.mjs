import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const GDAL_RUNTIME_BUNDLE_SCHEMA = "zugfolge-gdal-runtime-bundle/v1";
export const PINNED_GDAL_RUNTIME_MANIFEST = "tools/tiles/gdal-runtime.3.13.2-win32-x64.manifest.json";
export const PINNED_GDAL_RUNTIME_MANIFEST_CACHE = "tools/gdal-runtime-3.13.2-win32-x64/manifest.json";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const VERSION = /^[1-9][0-9]*(?:\.[0-9]+){1,3}(?:[-+][a-z0-9.-]+)?$/i;
const MAX_PROBE_BYTES = 8 * 1024 * 1024;

export const PINNED_GDAL_RUNTIME_PROFILE = Object.freeze({
  runtimeId: "gdal-3.13.2-win32-x64",
  version: "3.13.2",
  platform: { os: "win32", arch: "x64" },
  entryPoint: {
    sourceFile: "var/tooling-pinned/gdal-3.13.2/ogr2ogr.exe",
    cacheFile: "tools/gdal-3.13.2/ogr2ogr.exe",
  },
  environment: {
    pathPrepend: {
      sourceDirectory: "var/tooling-pinned/gdal-3.13.2-pixi/.pixi/envs/default/Library/bin",
      cacheDirectory: "tools/gdal-3.13.2-pixi/.pixi/envs/default/Library/bin",
    },
    gdalData: {
      sourceDirectory: "var/tooling-pinned/gdal-3.13.2-pixi/.pixi/envs/default/Library/share/gdal",
      cacheDirectory: "tools/gdal-3.13.2-pixi/.pixi/envs/default/Library/share/gdal",
    },
    projData: {
      sourceDirectory: "var/tooling-pinned/gdal-3.13.2-pixi/.pixi/envs/default/Library/share/proj",
      cacheDirectory: "tools/gdal-3.13.2-pixi/.pixi/envs/default/Library/share/proj",
    },
  },
  scopes: [
    {
      kind: "directory",
      sourcePath: "var/tooling-pinned/gdal-3.13.2-pixi/.pixi/envs/default/Library/bin",
      cachePath: "tools/gdal-3.13.2-pixi/.pixi/envs/default/Library/bin",
    },
    {
      kind: "directory",
      sourcePath: "var/tooling-pinned/gdal-3.13.2-pixi/.pixi/envs/default/Library/lib/gdalplugins",
      cachePath: "tools/gdal-3.13.2-pixi/.pixi/envs/default/Library/lib/gdalplugins",
    },
    {
      kind: "directory",
      sourcePath: "var/tooling-pinned/gdal-3.13.2-pixi/.pixi/envs/default/Library/share/gdal",
      cachePath: "tools/gdal-3.13.2-pixi/.pixi/envs/default/Library/share/gdal",
    },
    {
      kind: "directory",
      sourcePath: "var/tooling-pinned/gdal-3.13.2-pixi/.pixi/envs/default/Library/share/proj",
      cachePath: "tools/gdal-3.13.2-pixi/.pixi/envs/default/Library/share/proj",
    },
    {
      kind: "directory",
      sourcePath: "var/tooling-pinned/gdal-3.13.2-pixi/.pixi/envs/default/conda-meta",
      cachePath: "tools/gdal-3.13.2-pixi/.pixi/envs/default/conda-meta",
    },
    {
      kind: "file",
      sourcePath: "var/tooling-pinned/gdal-3.13.2-pixi/pixi.lock",
      cachePath: "tools/gdal-3.13.2-pixi/pixi.lock",
    },
    {
      kind: "file",
      sourcePath: "var/tooling-pinned/gdal-3.13.2-pixi/pixi.toml",
      cachePath: "tools/gdal-3.13.2-pixi/pixi.toml",
    },
    {
      kind: "file",
      sourcePath: "var/tooling-pinned/gdal-3.13.2/ogr2ogr.exe",
      cachePath: "tools/gdal-3.13.2/ogr2ogr.exe",
    },
  ],
  probes: {
    version: {
      args: ["--version"],
      expectedStdout: "GDAL 3.13.2 \"Iowa City\", released 2026/07/20",
    },
    pmtilesDriver: {
      args: ["--formats"],
      expectedStdoutLine: "PMTiles -vector- (rw+v): ProtoMap Tiles (*.pmtiles)",
    },
  },
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    `${label} besitzt fremde oder fehlende Felder.`,
  );
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

export function serializeGdalRuntimeBundle(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0 && !isAbsolute(value), `${label} muss relativ sein.`);
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} ist nicht portabel.`);
  invariant(value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthält einen unsicheren Pfadabschnitt.`);
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function containedPath(root, portable, label) {
  const path = resolve(root, ...portablePath(portable, label).split("/"));
  const remainder = relative(root, path);
  invariant(remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder), `${label} verlässt die Laufzeitwurzel.`);
  return path;
}

function validatePathPair(value, label, suffix) {
  exactKeys(value, [`source${suffix}`, `cache${suffix}`], label);
  return {
    [`source${suffix}`]: portablePath(value[`source${suffix}`], `${label}.source${suffix}`),
    [`cache${suffix}`]: portablePath(value[`cache${suffix}`], `${label}.cache${suffix}`),
  };
}

function validateProfile(value, label = "GDAL-Runtime-Profil") {
  exactKeys(value, ["runtimeId", "version", "platform", "entryPoint", "environment", "scopes", "probes"], label);
  invariant(typeof value.runtimeId === "string" && SAFE_ID.test(value.runtimeId), `${label}.runtimeId ist ungueltig.`);
  invariant(typeof value.version === "string" && VERSION.test(value.version), `${label}.version ist nicht gepinnt.`);
  exactKeys(value.platform, ["os", "arch"], `${label}.platform`);
  invariant(["win32", "linux", "darwin"].includes(value.platform.os), `${label}.platform.os ist unbekannt.`);
  invariant(["x64", "arm64"].includes(value.platform.arch), `${label}.platform.arch ist unbekannt.`);
  const entryPoint = validatePathPair(value.entryPoint, `${label}.entryPoint`, "File");

  exactKeys(value.environment, ["pathPrepend", "gdalData", "projData"], `${label}.environment`);
  const environment = Object.fromEntries(Object.entries(value.environment).map(([name, descriptor]) => [
    name,
    validatePathPair(descriptor, `${label}.environment.${name}`, "Directory"),
  ]));

  invariant(Array.isArray(value.scopes) && value.scopes.length > 0, `${label}.scopes ist leer.`);
  const scopes = value.scopes.map((scope, index) => {
    exactKeys(scope, ["kind", "sourcePath", "cachePath"], `${label}.scopes[${index}]`);
    invariant(["file", "directory"].includes(scope.kind), `${label}.scopes[${index}].kind ist unbekannt.`);
    return {
      kind: scope.kind,
      sourcePath: portablePath(scope.sourcePath, `${label}.scopes[${index}].sourcePath`),
      cachePath: portablePath(scope.cachePath, `${label}.scopes[${index}].cachePath`),
    };
  });
  invariant(JSON.stringify(scopes.map(({ sourcePath }) => sourcePath)) === JSON.stringify(scopes.map(({ sourcePath }) => sourcePath).sort(compareText)), `${label}.scopes muss nach sourcePath sortiert sein.`);
  invariant(new Set(scopes.map(({ sourcePath }) => sourcePath.toLowerCase())).size === scopes.length, `${label}.scopes besitzt doppelte Quellpfade.`);
  invariant(new Set(scopes.map(({ cachePath }) => cachePath.toLowerCase())).size === scopes.length, `${label}.scopes besitzt doppelte Cachepfade.`);
  for (const [index, scope] of scopes.entries()) {
    for (const other of scopes.slice(index + 1)) {
      invariant(!(scope.sourcePath.startsWith(`${other.sourcePath}/`) || other.sourcePath.startsWith(`${scope.sourcePath}/`)), `${label}.scopes besitzt überlappende Quellbereiche.`);
      invariant(!(scope.cachePath.startsWith(`${other.cachePath}/`) || other.cachePath.startsWith(`${scope.cachePath}/`)), `${label}.scopes besitzt überlappende Cachebereiche.`);
    }
  }
  invariant(scopes.some((scope) => scope.kind === "file" && scope.sourcePath === entryPoint.sourceFile && scope.cachePath === entryPoint.cacheFile), `${label}.entryPoint ist kein eigener Datei-Scope.`);
  for (const descriptor of Object.values(environment)) {
    invariant(scopes.some((scope) => scope.kind === "directory" && scope.sourcePath === descriptor.sourceDirectory && scope.cachePath === descriptor.cacheDirectory), `${label}.environment verweist nicht auf einen vollständigen Verzeichnis-Scope.`);
  }

  exactKeys(value.probes, ["version", "pmtilesDriver"], `${label}.probes`);
  exactKeys(value.probes.version, ["args", "expectedStdout"], `${label}.probes.version`);
  exactKeys(value.probes.pmtilesDriver, ["args", "expectedStdoutLine"], `${label}.probes.pmtilesDriver`);
  for (const [name, probe] of Object.entries(value.probes)) {
    invariant(Array.isArray(probe.args) && probe.args.length > 0 && probe.args.every((arg) => typeof arg === "string" && arg.length > 0 && !arg.includes("\0")), `${label}.probes.${name}.args ist ungueltig.`);
  }
  invariant(typeof value.probes.version.expectedStdout === "string" && value.probes.version.expectedStdout.length > 0 && !value.probes.version.expectedStdout.includes("\r"), `${label}.probes.version.expectedStdout ist ungueltig.`);
  invariant(typeof value.probes.pmtilesDriver.expectedStdoutLine === "string" && /PMTiles.*\(rw\+v\)/u.test(value.probes.pmtilesDriver.expectedStdoutLine), `${label}.probes.pmtilesDriver bindet keinen schreib- und lesbaren PMTiles-Vektortreiber.`);

  return {
    runtimeId: value.runtimeId,
    version: value.version,
    platform: { os: value.platform.os, arch: value.platform.arch },
    entryPoint,
    environment,
    scopes,
    probes: structuredClone(value.probes),
  };
}

function scopeForFile(file, scopes, side) {
  const pathName = side === "source" ? "sourcePath" : "cachePath";
  const matches = scopes.filter((scope) => scope.kind === "file"
    ? file === scope[pathName]
    : file.startsWith(`${scope[pathName]}/`));
  invariant(matches.length === 1, `${file} gehört nicht eindeutig zu einem GDAL-Runtime-Scope.`);
  return matches[0];
}

function mappedPath(file, scope, from, to) {
  const sourceName = from === "source" ? "sourcePath" : "cachePath";
  const targetName = to === "source" ? "sourcePath" : "cachePath";
  if (scope.kind === "file") return scope[targetName];
  return `${scope[targetName]}${file.slice(scope[sourceName].length)}`;
}

function runtimeInventory(files) {
  const canonical = files.map(({ sourceFile, cacheFile, bytes, sha256 }) => `${sourceFile}\0${cacheFile}\0${bytes}\0${sha256}\n`).join("");
  const cacheCanonical = files.map(({ cacheFile, bytes, sha256 }) => `${cacheFile}\0${bytes}\0${sha256}\n`).join("");
  return {
    files: files.length,
    bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    sha256: sha256Bytes(Buffer.from(canonical, "utf8")),
    cacheSha256: sha256Bytes(Buffer.from(cacheCanonical, "utf8")),
  };
}

export function validateGdalRuntimeBundleManifest(value) {
  exactKeys(value, ["schema", "runtimeId", "version", "platform", "entryPoint", "environment", "scopes", "probes", "inventory", "files"], "GDAL-Runtime-Manifest");
  invariant(value.schema === GDAL_RUNTIME_BUNDLE_SCHEMA, "GDAL-Runtime-Manifest hat ein unbekanntes Schema.");
  const {
    schema: _schema,
    inventory: _inventory,
    files: _files,
    ...profileValue
  } = value;
  void _schema;
  void _inventory;
  void _files;
  const profile = validateProfile(profileValue, "GDAL-Runtime-Manifest");
  invariant(Array.isArray(value.files) && value.files.length > 0, "GDAL-Runtime-Manifest besitzt keine Dateien.");
  const files = value.files.map((entry, index) => {
    exactKeys(entry, ["sourceFile", "cacheFile", "bytes", "sha256"], `GDAL-Runtime-Manifest.files[${index}]`);
    const sourceFile = portablePath(entry.sourceFile, `GDAL-Runtime-Manifest.files[${index}].sourceFile`);
    const cacheFile = portablePath(entry.cacheFile, `GDAL-Runtime-Manifest.files[${index}].cacheFile`);
    invariant(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && SHA256.test(entry.sha256), `GDAL-Runtime-Manifest.files[${index}] besitzt keinen Byte-SHA-Beleg.`);
    const sourceScope = scopeForFile(sourceFile, profile.scopes, "source");
    invariant(mappedPath(sourceFile, sourceScope, "source", "cache") === cacheFile, `GDAL-Runtime-Manifest.files[${index}] besitzt keinen kanonischen Cachepfad.`);
    return { sourceFile, cacheFile, bytes: entry.bytes, sha256: entry.sha256 };
  });
  invariant(JSON.stringify(files.map(({ sourceFile }) => sourceFile)) === JSON.stringify(files.map(({ sourceFile }) => sourceFile).sort(compareText)), "GDAL-Runtime-Manifest.files muss nach sourceFile sortiert sein.");
  invariant(new Set(files.map(({ sourceFile }) => sourceFile.toLowerCase())).size === files.length, "GDAL-Runtime-Manifest besitzt doppelte Quelldateien.");
  invariant(new Set(files.map(({ cacheFile }) => cacheFile.toLowerCase())).size === files.length, "GDAL-Runtime-Manifest besitzt doppelte Cachedateien.");
  for (const scope of profile.scopes) {
    invariant(files.some(({ sourceFile }) => scope.kind === "file" ? sourceFile === scope.sourcePath : sourceFile.startsWith(`${scope.sourcePath}/`)), `GDAL-Runtime-Scope ${scope.sourcePath} ist leer.`);
  }
  exactKeys(value.inventory, ["files", "bytes", "sha256", "cacheSha256"], "GDAL-Runtime-Manifest.inventory");
  const inventory = runtimeInventory(files);
  invariant(
    value.inventory.files === inventory.files
      && value.inventory.bytes === inventory.bytes
      && value.inventory.sha256 === inventory.sha256
      && value.inventory.cacheSha256 === inventory.cacheSha256,
    "GDAL-Runtime-Manifest.inventory weicht von der exakten Dateimenge ab.",
  );
  return { schema: GDAL_RUNTIME_BUNDLE_SCHEMA, ...profile, inventory, files };
}

export function gdalRuntimeBundleBinding(manifest) {
  const value = validateGdalRuntimeBundleManifest(manifest);
  const { files: _files, schema: _schema, ...binding } = value;
  void _files;
  void _schema;
  return binding;
}

export function validateGdalRuntimeBundleBinding(value) {
  exactKeys(value, ["runtimeId", "version", "platform", "entryPoint", "environment", "scopes", "probes", "inventory"], "GDAL-Runtime-Bindung");
  const { inventory: _inventory, ...profileValue } = value;
  void _inventory;
  const profile = validateProfile(profileValue, "GDAL-Runtime-Bindung");
  exactKeys(value.inventory, ["files", "bytes", "sha256", "cacheSha256"], "GDAL-Runtime-Bindung.inventory");
  invariant(Number.isSafeInteger(value.inventory.files) && value.inventory.files > 0, "GDAL-Runtime-Bindung.inventory.files ist ungueltig.");
  invariant(Number.isSafeInteger(value.inventory.bytes) && value.inventory.bytes > 0, "GDAL-Runtime-Bindung.inventory.bytes ist ungueltig.");
  invariant(SHA256.test(value.inventory.sha256) && SHA256.test(value.inventory.cacheSha256), "GDAL-Runtime-Bindung.inventory besitzt keine Hashbindung.");
  return { ...profile, inventory: structuredClone(value.inventory) };
}

export function validateGdalRuntimeBundleCacheInventory(binding, cacheInventory) {
  const value = validateGdalRuntimeBundleBinding(binding);
  invariant(Array.isArray(cacheInventory), "GDAL-Runtime-Cacheinventar fehlt.");
  const selected = cacheInventory.filter(({ path }) => value.scopes.some((scope) => scope.kind === "file"
    ? path === scope.cachePath
    : path.startsWith(`${scope.cachePath}/`)));
  selected.sort((left, right) => compareText(left.path, right.path));
  invariant(selected.length === value.inventory.files, "GDAL-Runtime-Cacheinventar besitzt eine fehlende oder zusätzliche Laufzeitdatei.");
  invariant(selected.every(({ path, bytes, sha256 }) => typeof path === "string" && Number.isSafeInteger(bytes) && bytes > 0 && SHA256.test(sha256)), "GDAL-Runtime-Cacheinventar besitzt einen unvollständigen Dateibeleg.");
  const cacheCanonical = selected.map(({ path, bytes, sha256 }) => `${path}\0${bytes}\0${sha256}\n`).join("");
  invariant(selected.reduce((sum, entry) => sum + entry.bytes, 0) === value.inventory.bytes, "GDAL-Runtime-Cacheinventar besitzt eine abweichende Bytezahl.");
  invariant(sha256Bytes(Buffer.from(cacheCanonical, "utf8")) === value.inventory.cacheSha256, "GDAL-Runtime-Cacheinventar weicht von der exakten Manifestdateimenge ab.");
  return selected;
}

function metadataEqual(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function regularFileProof(path, label) {
  const before = await lstat(path, { bigint: true });
  invariant(before.isFile() && !before.isSymbolicLink(), `${label} muss eine reguläre Datei ohne Reparse-Link sein.`);
  invariant(before.size > 0n && before.size <= BigInt(Number.MAX_SAFE_INTEGER), `${label} besitzt eine unzulässige Größe.`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const after = await lstat(path, { bigint: true });
  invariant(after.isFile() && !after.isSymbolicLink() && metadataEqual(before, after) && BigInt(bytes) === after.size, `${label} änderte sich beim Hashen.`);
  return { bytes, sha256: hash.digest("hex") };
}

async function assertNoReparse(path, label, directory) {
  const metadata = await lstat(path);
  invariant(!metadata.isSymbolicLink(), `${label} ist ein symbolischer Link oder Junction/Reparse-Punkt.`);
  invariant(directory ? metadata.isDirectory() : metadata.isFile(), `${label} besitzt den falschen Dateityp.`);
  const actual = await realpath(path);
  invariant(sameFilesystemPath(path, actual), `${label} wird über einen Link oder Junction/Reparse-Punkt aufgelöst.`);
}

async function collectDirectoryFiles(root, scope, layout, portableDirectory, result) {
  const absoluteDirectory = containedPath(root, portableDirectory, `GDAL-Runtime-Scope ${portableDirectory}`);
  await assertNoReparse(absoluteDirectory, `GDAL-Runtime-Scope ${portableDirectory}`, true);
  const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const relativeName = `${portableDirectory}/${entry.name}`;
    const absolute = containedPath(root, relativeName, `GDAL-Runtime-Datei ${relativeName}`);
    invariant(!entry.isSymbolicLink(), `GDAL-Runtime enthält den symbolischen Link oder Junction/Reparse-Punkt ${relativeName}.`);
    if (entry.isDirectory()) await collectDirectoryFiles(root, scope, layout, relativeName, result);
    else {
      invariant(entry.isFile(), `GDAL-Runtime enthält einen unbekannten Dateityp ${relativeName}.`);
      await assertNoReparse(absolute, `GDAL-Runtime-Datei ${relativeName}`, false);
      const from = layout;
      const to = layout === "source" ? "cache" : "source";
      const other = mappedPath(relativeName, scope, from, to);
      result.push(layout === "source"
        ? { sourceFile: relativeName, cacheFile: other, absolute }
        : { sourceFile: other, cacheFile: relativeName, absolute });
    }
  }
}

async function collectRuntimeFiles(root, scopes, layout) {
  invariant(["source", "cache"].includes(layout), "GDAL-Runtime-Layout muss source oder cache sein.");
  const result = [];
  for (const scope of scopes) {
    const portable = layout === "source" ? scope.sourcePath : scope.cachePath;
    if (scope.kind === "directory") await collectDirectoryFiles(root, scope, layout, portable, result);
    else {
      const absolute = containedPath(root, portable, `GDAL-Runtime-Datei ${portable}`);
      await assertNoReparse(absolute, `GDAL-Runtime-Datei ${portable}`, false);
      result.push({ sourceFile: scope.sourcePath, cacheFile: scope.cachePath, absolute });
    }
  }
  return result.sort((left, right) => compareText(left.sourceFile, right.sourceFile));
}

async function mapLimit(values, limit, mapper) {
  const result = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      result[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return result;
}

export async function createGdalRuntimeBundleManifest({ profile = PINNED_GDAL_RUNTIME_PROFILE, artifactRoot }) {
  const normalized = validateProfile(profile);
  const root = resolve(artifactRoot);
  await assertNoReparse(root, "GDAL-Runtime-Artefaktwurzel", true);
  const discovered = await collectRuntimeFiles(root, normalized.scopes, "source");
  const files = await mapLimit(discovered, 4, async (entry) => ({
    sourceFile: entry.sourceFile,
    cacheFile: entry.cacheFile,
    ...(await regularFileProof(entry.absolute, `GDAL-Runtime-Datei ${entry.sourceFile}`)),
  }));
  return validateGdalRuntimeBundleManifest({
    schema: GDAL_RUNTIME_BUNDLE_SCHEMA,
    ...normalized,
    inventory: runtimeInventory(files),
    files,
  });
}

function normalizedConsoleOutput(value) {
  return String(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd();
}

function executeRuntimeProbe({ command, args, environment }) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const timeout = setTimeout(() => child.kill(), 30_000);
    function capture(target, chunk) {
      bytes += chunk.length;
      if (bytes > MAX_PROBE_BYTES) {
        child.kill();
        reject(new Error("GDAL-Runtime-Probe erzeugte zu viele Ausgabebytes."));
      } else target.push(chunk);
    }
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`GDAL-Runtime-Probe endete mit ${code ?? `Signal ${signal}`}.`));
      else accept({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

function cleanRuntimeEnvironment(baseEnvironment, pathPrepend, gdalData, projData) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (["path", "gdal_data", "proj_data"].includes(key.toLowerCase())) delete environment[key];
  }
  const originalPath = baseEnvironment.PATH ?? baseEnvironment.Path ?? baseEnvironment.path ?? "";
  environment.PATH = originalPath === "" ? pathPrepend : `${pathPrepend}${delimiter}${originalPath}`;
  environment.GDAL_DATA = gdalData;
  environment.PROJ_DATA = projData;
  return environment;
}

export function createGdalRuntimeInvocation(manifest, artifactRoot, { layout = "source", baseEnvironment = process.env } = {}) {
  const value = validateGdalRuntimeBundleManifest(manifest);
  invariant(["source", "cache"].includes(layout), "GDAL-Runtime-Layout muss source oder cache sein.");
  const root = resolve(artifactRoot);
  const side = layout === "source" ? "source" : "cache";
  const command = containedPath(root, value.entryPoint[`${side}File`], "GDAL-Runtime-Entry-Point");
  const pathPrepend = containedPath(root, value.environment.pathPrepend[`${side}Directory`], "GDAL-Runtime-PATH");
  const gdalData = containedPath(root, value.environment.gdalData[`${side}Directory`], "GDAL_DATA");
  const projData = containedPath(root, value.environment.projData[`${side}Directory`], "PROJ_DATA");
  return { command, environment: cleanRuntimeEnvironment(baseEnvironment, pathPrepend, gdalData, projData) };
}

async function runRuntimeProbes(manifest, invocation, executeProbe) {
  const version = await executeProbe({ ...invocation, args: manifest.probes.version.args });
  invariant(normalizedConsoleOutput(version.stderr) === "", "GDAL-Versionsprobe schrieb unerwartet auf stderr.");
  invariant(normalizedConsoleOutput(version.stdout) === manifest.probes.version.expectedStdout, "GDAL-Versionsprobe weicht vom Runtime-Manifest ab.");
  const formats = await executeProbe({ ...invocation, args: manifest.probes.pmtilesDriver.args });
  invariant(normalizedConsoleOutput(formats.stderr) === "", "GDAL-Treiberprobe schrieb unerwartet auf stderr.");
  const lines = normalizedConsoleOutput(formats.stdout).split("\n").map((line) => line.trim()).filter(Boolean);
  invariant(lines.filter((line) => line === manifest.probes.pmtilesDriver.expectedStdoutLine).length === 1, "GDAL-Treiberprobe besitzt nicht exakt den gepinnten PMTiles-rw+v-Treiber.");
  return {
    version: manifest.probes.version.expectedStdout,
    pmtilesDriver: manifest.probes.pmtilesDriver.expectedStdoutLine,
  };
}

export async function verifyGdalRuntimeBundle({
  manifest,
  artifactRoot,
  layout = "source",
  enforcePlatform = true,
  executeProbe = executeRuntimeProbe,
  runProbes = true,
}) {
  const value = validateGdalRuntimeBundleManifest(manifest);
  if (enforcePlatform) {
    invariant(process.platform === value.platform.os && process.arch === value.platform.arch, `GDAL-Runtime verlangt ${value.platform.os}-${value.platform.arch}, Prozess ist ${process.platform}-${process.arch}.`);
  }
  const root = resolve(artifactRoot);
  await assertNoReparse(root, "GDAL-Runtime-Artefaktwurzel", true);
  const discovered = await collectRuntimeFiles(root, value.scopes, layout);
  invariant(
    JSON.stringify(discovered.map(({ sourceFile, cacheFile }) => ({ sourceFile, cacheFile })))
      === JSON.stringify(value.files.map(({ sourceFile, cacheFile }) => ({ sourceFile, cacheFile }))),
    "GDAL-Runtime-Dateimenge besitzt fehlende, zusätzliche oder falsch abgebildete Dateien.",
  );
  const proofs = await mapLimit(discovered, 4, async (entry, index) => {
    const proof = await regularFileProof(entry.absolute, `GDAL-Runtime-Datei ${layout === "source" ? entry.sourceFile : entry.cacheFile}`);
    invariant(proof.bytes === value.files[index].bytes && proof.sha256 === value.files[index].sha256, `GDAL-Runtime-Datei ${entry.sourceFile} weicht vom Manifest ab.`);
    return proof;
  });
  const invocation = createGdalRuntimeInvocation(value, root, { layout });
  const probes = runProbes ? await runRuntimeProbes(value, invocation, executeProbe) : undefined;
  return {
    runtimeId: value.runtimeId,
    version: value.version,
    platform: `${value.platform.os}-${value.platform.arch}`,
    files: proofs.length,
    bytes: proofs.reduce((sum, proof) => sum + proof.bytes, 0),
    inventorySha256: value.inventory.sha256,
    invocation,
    ...(probes === undefined ? {} : { probes }),
  };
}

export async function loadGdalRuntimeBundle(manifestPath) {
  const path = resolve(manifestPath);
  await assertNoReparse(path, "GDAL-Runtime-Manifest", false);
  const bytes = await readFile(path);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GDAL-Runtime-Manifest ist kein gueltiges UTF-8-JSON.");
  }
  const manifest = validateGdalRuntimeBundleManifest(parsed);
  invariant(bytes.equals(serializeGdalRuntimeBundle(manifest)), "GDAL-Runtime-Manifest ist nicht kanonisch serialisiert.");
  return { manifest, bytes, sha256: sha256Bytes(bytes), path };
}

export async function loadAndVerifyGdalRuntimeBundle(manifestPath, artifactRoot, options = {}) {
  const loaded = await loadGdalRuntimeBundle(manifestPath);
  const verification = await verifyGdalRuntimeBundle({ manifest: loaded.manifest, artifactRoot, ...options });
  return { ...loaded, verification };
}

export async function writeGdalRuntimeBundle(manifest, outputPath) {
  const value = validateGdalRuntimeBundleManifest(manifest);
  const bytes = serializeGdalRuntimeBundle(value);
  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return { path, bytes: bytes.length, sha256: sha256Bytes(bytes), files: value.inventory.files, runtimeBytes: value.inventory.bytes };
}
