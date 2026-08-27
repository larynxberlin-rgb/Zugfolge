import { link, lstat, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  try {
    const [staged, published] = await Promise.all([
      lstat(entry.stagedPath, { bigint: true }),
      lstat(entry.outputPath, { bigint: true }),
    ]);
    if (sameIdentity(staged, published)) await unlink(entry.outputPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
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
    const rollbackErrors = [];
    for (const entry of published.reverse()) {
      try {
        await removePublishedLink(entry);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Create-new-Publikation und Rollback sind fehlgeschlagen.");
    throw error;
  }
  return entries.map(({ outputPath }) => outputPath);
}

export async function publishFileCreateNew(stagedPath, outputPath, label = "Ausgabeziel") {
  await publishFilesCreateNew([{ stagedPath, outputPath, label }]);
  return resolve(outputPath);
}

export async function publishDirectoryCreateNew(stagedPathInput, outputPathInput, label = "Ausgabeverzeichnis") {
  const stagedPath = resolve(stagedPathInput);
  const outputPath = resolve(outputPathInput);
  for (let attempt = 0; ; attempt += 1) {
    await assertCreateNewTarget(outputPath, label);
    try {
      await rename(stagedPath, outputPath);
      return outputPath;
    } catch (error) {
      if (error !== null && typeof error === "object" && ["EEXIST", "ENOTEMPTY"].includes(error.code)) {
        throw existingTargetError(outputPath, label);
      }
      const retryable = error !== null && typeof error === "object" && ["EACCES", "EBUSY", "EPERM"].includes(error.code);
      if (!retryable || attempt >= 5) throw error;
      await delay(25 * (2 ** attempt));
    }
  }
}
