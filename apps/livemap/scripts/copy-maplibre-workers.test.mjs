import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyMapLibreWorkers, MAPLIBRE_WORKER_FILES } from "./copy-maplibre-workers.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MapLibre-Workerartefakte", () => {
  it("liefert Worker und dessen gemeinsames Modul byteidentisch in den Build", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-maplibre-worker-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    const destination = join(root, "dist", "assets");
    await mkdir(source, { recursive: true });
    for (const [index, name] of MAPLIBRE_WORKER_FILES.entries()) {
      await writeFile(join(source, name), `worker-${index}-${name}`, "utf8");
    }

    const copied = await copyMapLibreWorkers(source, destination);

    expect(copied.map((entry) => entry.name)).toEqual(MAPLIBRE_WORKER_FILES);
    for (const name of MAPLIBRE_WORKER_FILES) {
      expect(await readFile(join(destination, name))).toEqual(await readFile(join(source, name)));
    }
  });

  it("bricht bei einem unvollständigen Worker-Inventar ab", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-maplibre-worker-missing-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "source"), { recursive: true });
    await writeFile(join(root, "source", MAPLIBRE_WORKER_FILES[0]), "worker", "utf8");

    await expect(copyMapLibreWorkers(join(root, "source"), join(root, "dist"))).rejects.toThrow();
  });
});
