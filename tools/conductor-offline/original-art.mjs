import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repository } from "./paths.mjs";

/** Derselbe freigegebene Export wie prepare-data; keine Freigabe der Übungswelt. */
export async function loadOriginalDemoArt() {
  const liveRequire = createRequire(resolve(repository, "apps/livemap/package.json"));
  const viteRequire = createRequire(liveRequire.resolve("vite"));
  const { build } = await import(pathToFileURL(viteRequire.resolve("esbuild")).href);
  const compiled = await build({ entryPoints: [resolve(repository, "packages/conductor-art/src/index.ts")],
    bundle: true, write: false, format: "esm", platform: "node", target: "node24", metafile: true, logLevel: "silent" });
  if (compiled.outputFiles.length !== 1 || Object.values(compiled.metafile.outputs)
    .some((output) => output.imports.some((item) => !item.path.startsWith("node:")))) {
    throw new Error("Der Originalatlasprüfer enthält einen unerwarteten externen Import.");
  }
  const { loadArtAtlasFromDirectory } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`);
  const worldId = "0db56535-a466-44a8-a991-38a8a1f7566c";
  const read = async (path) => JSON.parse(await readFile(resolve(repository, path), "utf8"));
  const atlas = await loadArtAtlasFromDirectory({ directory: resolve(repository, "assets/conductor-art/v1"), worldId,
    expectedPin: await read(`ops/conductor/worlds/${worldId}/art-world-pin.json`),
    signature: await read(`ops/conductor/worlds/${worldId}/art-signature.json`),
    trustedKeys: new Map(Object.entries(await read("ops/keys/trusted-conductor-art-keys.json"))) });
  return { atlas, worldId };
}
