import { copyFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAPLIBRE_WORKER_FILES = Object.freeze([
  "maplibre-gl-worker.mjs",
  "maplibre-gl-shared.mjs",
]);

export async function copyMapLibreWorkers(sourceDirectory, destinationDirectory) {
  await mkdir(destinationDirectory, { recursive: true });
  const copied = [];
  for (const name of MAPLIBRE_WORKER_FILES) {
    const source = join(sourceDirectory, name);
    const destination = join(destinationDirectory, name);
    const sourceStat = await stat(source);
    if (!sourceStat.isFile() || sourceStat.size === 0) {
      throw new Error(`MapLibre-Laufzeitartefakt '${name}' fehlt oder ist leer.`);
    }
    await copyFile(source, destination);
    const destinationStat = await stat(destination);
    if (destinationStat.size !== sourceStat.size) {
      throw new Error(`MapLibre-Laufzeitartefakt '${name}' wurde nicht bytevollständig kopiert.`);
    }
    copied.push(Object.freeze({ name: basename(destination), bytes: destinationStat.size }));
  }
  return Object.freeze(copied);
}

const isCommand = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isCommand) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const appDirectory = resolve(scriptDirectory, "..");
  const copied = await copyMapLibreWorkers(
    join(appDirectory, "node_modules", "maplibre-gl", "dist"),
    join(appDirectory, "dist", "assets"),
  );
  process.stdout.write(`${JSON.stringify({ copied })}\n`);
}
