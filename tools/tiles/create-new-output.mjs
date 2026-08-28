import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const CREATE_NEW_DIRECTORY_COMPLETION_FILE = ".zugfolge-create-new-complete.json";
export const CREATE_NEW_DIRECTORY_COMPLETION_SCHEMA = "zugfolge-create-new-directory-completion/v1";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_KIND = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function isMissing(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function existingTargetError(pathInput, label = "Ausgabeziel") {
  const path = resolve(pathInput);
  const error = new Error(`${label} existiert bereits und darf im create-new-Jahreslauf weder ersetzt noch wiederverwendet werden: ${path}`);
  error.code = "EEXIST";
  error.path = path;
  return error;
}

export async function assertCreateNewTarget(pathInput, label = "Ausgabeziel") {
  const path = resolve(pathInput);
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return path;
    throw error;
  }
  throw existingTargetError(path, label);
}

export async function assertCreateNewTargets(targets) {
  const normalized = targets.map(({ path, label }) => ({ path: resolve(path), label }));
  for (const target of normalized) await assertCreateNewTarget(target.path, target.label);
  return normalized;
}

async function removePublishedLink(entry) {
  let staged;
  let published;
  try {
    [staged, published] = await Promise.all([
      lstat(entry.stagedPath, { bigint: true }),
      lstat(entry.outputPath, { bigint: true }),
    ]);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!sameIdentity(staged, published)) return;

  const quarantineRoot = await mkdtemp(join(dirname(entry.outputPath), ".zugfolge-create-new-rollback-"));
  const quarantined = join(quarantineRoot, basename(entry.outputPath));
  try {
    await rename(entry.outputPath, quarantined);
    const moved = await lstat(quarantined, { bigint: true });
    if (!sameIdentity(staged, moved)) {
      try {
        await link(quarantined, entry.outputPath);
        await unlink(quarantined);
        await rmdir(quarantineRoot);
      } catch (restoreError) {
        throw new AggregateError(
          [restoreError],
          `${entry.label} wurde waehrend des owned-only Rollbacks fremd ersetzt und bleibt im Quarantaeneverzeichnis erhalten.`,
        );
      }
      return;
    }
    await unlink(quarantined);
    await rmdir(quarantineRoot);
  } catch (error) {
    try {
      await rmdir(quarantineRoot);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOTEMPTY") {
        throw new AggregateError([error, cleanupError], "Create-new-Rollback-Quarantaene konnte nicht bereinigt werden.");
      }
    }
    throw error;
  }
}

/**
 * Entfernt sichtbare create-new-Hardlinks nur, solange sie noch dieselbe
 * Dateidentitaet wie das zugehoerige Staging besitzen. Fremde Ersetzungen
 * bleiben damit auch bei einem spaeten Publikationsfehler unangetastet.
 */
export async function rollbackFilesCreateNew(entriesInput) {
  const entries = entriesInput.map(({ stagedPath, outputPath, label = "Ausgabeziel" }) => ({
    stagedPath: resolve(stagedPath),
    outputPath: resolve(outputPath),
    label,
  }));
  const rollbackErrors = [];
  for (const entry of entries.reverse()) {
    try {
      await removePublishedLink(entry);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) throw new AggregateError(rollbackErrors, "Create-new-Rollback ist fehlgeschlagen.");
}

/**
 * Publiziert vollstaendig geschriebene Dateien per Hardlink. `link` ist im
 * Gegensatz zu `rename` create-new: ein zeitgleich erzeugtes Ziel wird nie
 * ersetzt. Bei mehreren Zielen werden bereits publizierte Links bei einer
 * spaeteren Kollision nur dann entfernt, wenn sie noch auf exakt unsere
 * Staging-Datei zeigen.
 */
export async function publishFilesCreateNew(entriesInput) {
  const entries = entriesInput.map(({ stagedPath, outputPath, label = "Ausgabeziel" }) => ({
    stagedPath: resolve(stagedPath),
    outputPath: resolve(outputPath),
    label,
  }));
  const published = [];
  try {
    for (const entry of entries) {
      try {
        await link(entry.stagedPath, entry.outputPath);
      } catch (error) {
        if (error !== null && typeof error === "object" && error.code === "EEXIST") {
          throw existingTargetError(entry.outputPath, entry.label);
        }
        throw error;
      }
      published.push(entry);
    }
  } catch (error) {
    try {
      await rollbackFilesCreateNew(published);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Create-new-Publikation und Rollback sind fehlgeschlagen.");
    }
    throw error;
  }
  return entries.map(({ outputPath }) => outputPath);
}

export async function publishFileCreateNew(stagedPath, outputPath, label = "Ausgabeziel") {
  await publishFilesCreateNew([{ stagedPath, outputPath, label }]);
  return resolve(outputPath);
}

function validateDirectoryCompletion(completion, label = "Completion-Marker") {
  if (completion === null || typeof completion !== "object" || Array.isArray(completion)) throw new Error(`${label} muss ein Objekt sein.`);
  if (Object.keys(completion).sort().join(",") !== "bindingSha256,kind,schema") throw new Error(`${label} besitzt unerwartete oder fehlende Felder.`);
  if (completion.schema !== CREATE_NEW_DIRECTORY_COMPLETION_SCHEMA) throw new Error(`${label} besitzt ein unbekanntes Schema.`);
  if (typeof completion.kind !== "string" || !SAFE_KIND.test(completion.kind)) throw new Error(`${label}.kind ist ungueltig.`);
  if (typeof completion.bindingSha256 !== "string" || !SHA256.test(completion.bindingSha256)) throw new Error(`${label}.bindingSha256 ist ungueltig.`);
  return completion;
}

function serializeDirectoryCompletion(completionInput) {
  const completion = validateDirectoryCompletion(completionInput);
  return Buffer.from(`${JSON.stringify({
    schema: completion.schema,
    kind: completion.kind,
    bindingSha256: completion.bindingSha256,
  }, null, 2)}\n`, "utf8");
}

export async function writeCreateNewDirectoryCompletionMarker(rootInput, completionInput) {
  const root = resolve(rootInput);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("Completion-Staging muss ein regulaeres Verzeichnis sein.");
  const markerPath = join(root, CREATE_NEW_DIRECTORY_COMPLETION_FILE);
  await assertCreateNewTarget(markerPath, "Staging-Completion-Marker");
  const markerHandle = await open(markerPath, "wx", 0o600);
  try {
    await markerHandle.writeFile(serializeDirectoryCompletion(completionInput));
    await markerHandle.sync();
  } finally {
    await markerHandle.close();
  }
  return markerPath;
}

async function linkTreeEntryCreateNew(sourceRoot, destinationRoot, entry, label) {
  const source = join(sourceRoot, entry.name);
  const destination = join(destinationRoot, entry.name);
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) throw new Error(`${label} enthaelt den unzulaessigen symbolischen Link ${entry.name}.`);
  if (metadata.isDirectory()) {
    try {
      await mkdir(destination, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error !== null && typeof error === "object" && error.code === "EEXIST") {
        throw existingTargetError(destination, `${label}-Eintrag`);
      }
      throw error;
    }
    await linkTreeCreateNew(source, destination, label);
    return;
  }
  if (!metadata.isFile()) throw new Error(`${label} enthaelt den unzulaessigen Spezialdatei-Eintrag ${entry.name}.`);
  try {
    await link(source, destination);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "EEXIST") {
      throw existingTargetError(destination, `${label}-Eintrag`);
    }
    throw error;
  }
}

async function linkTreeCreateNew(sourceRoot, destinationRoot, label, { skipCompletionMarker = false } = {}) {
  const entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter(({ name }) => !skipCompletionMarker || name !== CREATE_NEW_DIRECTORY_COMPLETION_FILE)
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) await linkTreeEntryCreateNew(sourceRoot, destinationRoot, entry, label);
}

export async function verifyCreateNewDirectoryCompletion(rootInput, expected = {}) {
  const requestedRoot = resolve(rootInput);
  const rootMetadata = await lstat(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("Create-new-Ziel muss ein regulaeres Verzeichnis sein.");
  const root = await realpath(requestedRoot);
  const markerPath = join(root, CREATE_NEW_DIRECTORY_COMPLETION_FILE);
  let markerMetadata;
  try {
    markerMetadata = await lstat(markerPath);
  } catch (error) {
    if (isMissing(error)) throw new Error(`Create-new-Ziel ist unvollstaendig: ${CREATE_NEW_DIRECTORY_COMPLETION_FILE} fehlt.`);
    throw error;
  }
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink() || markerMetadata.size <= 0 || markerMetadata.size > 4096) {
    throw new Error("Create-new-Completion-Marker ist keine kleine regulaere Datei.");
  }
  const bytes = await readFile(markerPath);
  let completion;
  try {
    completion = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Create-new-Completion-Marker ist kein gueltiges JSON.");
  }
  validateDirectoryCompletion(completion);
  if (!bytes.equals(serializeDirectoryCompletion(completion))) throw new Error("Create-new-Completion-Marker ist nicht kanonisch serialisiert.");
  if (expected.kind !== undefined && completion.kind !== expected.kind) throw new Error("Create-new-Completion-Marker besitzt eine falsche Zielart.");
  if (expected.bindingSha256 !== undefined && completion.bindingSha256 !== expected.bindingSha256) throw new Error("Create-new-Completion-Marker bindet nicht den erwarteten Inhalt.");
  return { root, completion };
}

/**
 * Reserviert das sichtbare Ziel atomar mit `mkdir`. Anders als POSIX-`rename`
 * kann diese Operation kein inzwischen angelegtes leeres Ziel ersetzen. Die
 * bereits vollstaendig gebauten Eintraege werden erst danach per exklusivem
 * `mkdir` beziehungsweise create-new-Hardlink in die reservierte Wurzel
 * uebernommen. Damit kann auch ein nach der Reservierung eingeschobener
 * Fremdeintrag nie ersetzt werden. Der vorab synchronisierte Marker wird als
 * letzte Operation per create-new-Hardlink sichtbar. Ein Abbruch hinterlaesst
 * bewusst einen markerlosen, von allen Lesern abzuweisenden Teilbaum.
 */
export async function publishDirectoryCreateNew(stagedPathInput, outputPathInput, completionInput, label = "Ausgabeverzeichnis") {
  const stagedPath = resolve(stagedPathInput);
  const outputPath = resolve(outputPathInput);
  const stagedMetadata = await lstat(stagedPath);
  if (!stagedMetadata.isDirectory() || stagedMetadata.isSymbolicLink()) throw new Error("Create-new-Staging muss ein regulaeres Verzeichnis sein.");
  const completion = validateDirectoryCompletion(completionInput);
  const stagedMarker = await writeCreateNewDirectoryCompletionMarker(stagedPath, completion);
  try {
    await mkdir(outputPath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "EEXIST") throw existingTargetError(outputPath, label);
    throw error;
  }
  const entries = (await readdir(stagedPath, { withFileTypes: true }))
    .filter(({ name }) => name !== CREATE_NEW_DIRECTORY_COMPLETION_FILE);
  if (entries.length === 0) throw new Error("Create-new-Staging besitzt keine Nutzdaten.");
  await linkTreeCreateNew(stagedPath, outputPath, label, { skipCompletionMarker: true });
  try {
    await link(stagedMarker, join(outputPath, CREATE_NEW_DIRECTORY_COMPLETION_FILE));
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "EEXIST") {
      throw existingTargetError(join(outputPath, CREATE_NEW_DIRECTORY_COMPLETION_FILE), "Create-new-Completion-Marker");
    }
    throw error;
  }
  await verifyCreateNewDirectoryCompletion(outputPath, completion);
  return outputPath;
}
