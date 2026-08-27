import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ANNUAL_PATCH_CONTRACT_FILES = Object.freeze([
  "tools/region-import/germany/final-quality-inputs.annual-{patch}.json",
  "tools/region-import/germany/operational-infrastructure.annual-{patch}.json",
  "tools/region-import/germany/operational-quality.annual-{patch}.json",
  "tools/region-import/germany/release-artifacts.annual-{patch}.json",
  "tools/region-import/germany/release.annual-{patch}.config.json",
  "tools/region-import/germany/source-capture.annual-{patch}.plan.json",
  "tools/region-import/germany/synthetic-operational-b.{patch}.policy.json",
  "tools/region-import/germany/synthetic-operational-closure.annual-{patch}.json",
  "tools/region-import/germany/timetable-route-compiler.annual-{patch}.json",
  "tools/tiles/livemap-read-model.annual-{patch}.json",
  "tools/tiles/map-build-cache-inventory.annual-{patch}.plan.json",
  "tools/tiles/map-package.annual-{patch}.plan.json",
  "tools/tiles/map-release-build-evidence.annual-{patch}.spec.json",
  "tools/tiles/map-release.annual-{patch}.spec.json",
  "tools/tiles/static-map-quality.annual-{patch}.json",
  "tools/tiles/static-map-release.annual-{patch}.json",
  "tools/tiles/static-map-sources.annual-{patch}.json",
]);

const PATCH = /^(?<year>[0-9]{4})\.(?<patch>[1-9][0-9]*)$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parsedPatch(value, label) {
  const match = PATCH.exec(value);
  invariant(match !== null, `${label} muss YYYY.PATCH entsprechen.`);
  return Object.freeze({
    patch: Number.parseInt(match.groups.patch, 10),
    value,
    year: Number.parseInt(match.groups.year, 10),
  });
}

function contractPath(template, patch) {
  invariant(template.includes("{patch}"), "Jahresvertragspfad besitzt keinen Patch-Platzhalter.");
  return template.replaceAll("{patch}", patch);
}

function pathInside(root, path, label) {
  const absolute = resolve(root, path);
  const relation = relative(root, absolute);
  invariant(relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !relation.includes(`${sep}..${sep}`), `${label} verlaesst die Repositorywurzel.`);
  return absolute;
}

async function absent(path, label) {
  try {
    await access(path, constants.F_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} existiert bereits; create-new verweigert die Ueberschreibung.`);
}

async function readContract(path, sourcePatch, targetPatch) {
  const info = await stat(path);
  invariant(info.isFile(), `Jahresvertragsquelle ist keine regulaere Datei: ${path}`);
  const source = await readFile(path, "utf8");
  invariant(source.includes(sourcePatch), `Jahresvertragsquelle bindet ${sourcePatch} nicht: ${path}`);
  invariant(!source.includes(targetPatch), `Jahresvertragsquelle enthaelt bereits Zielpatch ${targetPatch}: ${path}`);
  const target = source.replaceAll(sourcePatch, targetPatch);
  JSON.parse(target);
  invariant(!target.includes(sourcePatch), `Zielvertrag enthaelt weiterhin Quellpatch ${sourcePatch}: ${path}`);
  return target;
}

/**
 * Erstellt den vollständigen eingecheckten JSON-Vertragssatz eines neuen
 * Jahres-Patchreleases. Die Quellvertraege bleiben bytegleich unveraendert;
 * jedes Ziel wird ausschließlich create-new angelegt.
 */
export async function createAnnualPatchRelease({
  repositoryRoot,
  sourcePatch,
  targetPatch,
  files = ANNUAL_PATCH_CONTRACT_FILES,
}) {
  const root = resolve(repositoryRoot);
  const source = parsedPatch(sourcePatch, "Quellpatch");
  const target = parsedPatch(targetPatch, "Zielpatch");
  invariant(source.year === target.year && target.patch === source.patch + 1, "Zielpatch muss der direkte naechste Patch desselben Fahrplanjahres sein.");
  invariant(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length, "Jahresvertragsliste muss eindeutig und nicht leer sein.");

  const contracts = files.map((template) => Object.freeze({
    source: pathInside(root, contractPath(template, source.value), "Jahresvertragsquelle"),
    target: pathInside(root, contractPath(template, target.value), "Jahresvertragsziel"),
    template,
  }));
  invariant(new Set(contracts.map(({ target: path }) => path)).size === contracts.length, "Jahresvertragsziele sind nicht eindeutig.");

  const prepared = [];
  for (const contract of contracts) {
    await absent(contract.target, `Jahresvertragsziel ${contract.template}`);
    prepared.push(Object.freeze({
      ...contract,
      content: await readContract(contract.source, source.value, target.value),
    }));
  }

  const claimPath = pathInside(root, `tools/region-import/germany/.annual-patch-release-${target.value}.claim`, "Jahresrelease-Claim");
  await absent(claimPath, "Jahresrelease-Claim");
  await mkdir(dirname(claimPath), { recursive: true });
  const claim = await open(claimPath, "wx", 0o600);
  const created = [];
  try {
    await claim.writeFile(`${source.value}->${target.value}\n`, "utf8");
    await claim.sync();
    for (const contract of prepared) {
      await absent(contract.target, `Jahresvertragsziel ${contract.template}`);
      await mkdir(dirname(contract.target), { recursive: true });
      await writeFile(contract.target, contract.content, { encoding: "utf8", flag: "wx", mode: 0o644 });
      created.push(contract.target);
    }
  } catch (error) {
    for (const path of created.reverse()) await rm(path, { force: true });
    throw error;
  } finally {
    await claim.close();
    await unlink(claimPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  return Object.freeze({
    files: Object.freeze(prepared.map(({ target: path }) => relative(root, path).replaceAll("\\", "/"))),
    sourcePatch: source.value,
    targetPatch: target.value,
  });
}

async function main(argv) {
  const [sourcePatch, targetPatch, repositoryRoot = "."] = argv;
  invariant(sourcePatch && targetPatch, "Aufruf: create-annual-patch-release.mjs SOURCE_PATCH TARGET_PATCH [REPOSITORY_ROOT]");
  const result = await createAnnualPatchRelease({ repositoryRoot, sourcePatch, targetPatch });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
