import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { artifact, outputs } from "./paths.mjs";
import { verifyNativeKernel } from "./native/verify-native.mjs";
import { verifyOfflineArt } from "./assets-v2/verify-art.mjs";
import { loadOriginalDemoArt } from "./original-art.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const repository = resolve(root, "../..");
let output = artifact;
let prepareOnly = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--prepare-only") prepareOnly = true;
  else if (args[index] === "--out" && args[index + 1]) output = resolve(args[++index]);
  else throw new Error("Aufruf: node build.mjs [--prepare-only] [--out DATEI.html]");
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Bündelt den von prepare-data.mjs streng geladenen Originalexport; keine neue Projektion. */
async function prepareOriginalArt() {
  const art = JSON.parse(await readFile(resolve(root, "data/art-view.json"), "utf8"));
  const atlases = JSON.parse(await readFile(resolve(root, "data/atlases.json"), "utf8"));
  const { atlas: original, worldId } = await loadOriginalDemoArt();
  if (!isDeepStrictEqual(art, original.renderView(worldId))) {
    throw new Error("Der Originalatlasexport wurde gegenüber der signierten Releaseprojektion verändert.");
  }
  const manifestBytes = await readFile(resolve(repository, "assets/conductor-art/v1/manifest.json"));
  if (art.schemaVersion !== "conductor-art-view/v1" || art.pixelsPerMetre !== 32
    || art.manifestSha256 !== sha(manifestBytes) || art.files.length !== 7 || Object.keys(atlases).length !== 7
    || new Set(art.files.map((file) => file.id)).size !== 7) throw new Error("Der geprüfte Originalatlasexport fehlt oder stimmt nicht mit dem Repository überein.");
  for (const file of art.files) {
    if (typeof atlases[file.id] !== "string") throw new Error("Ein Originalatlas fehlt im Export.");
    const bytes = Buffer.from(atlases[file.id], "base64");
    if (sha(bytes) !== file.sha256 || bytes.toString("base64") !== atlases[file.id]) throw new Error("Originalatlas stimmt nicht mit seinem geprüften Export überein.");
  }
  return { manifestSha256: art.manifestSha256, files: art.files.map(({ id, sha256 }) => ({ id, sha256 })) };
}

const nativeEvidence = await verifyNativeKernel();
const demoArtEvidence = await verifyOfflineArt();
const artEvidence = await prepareOriginalArt();
if (prepareOnly) {
  process.stdout.write(JSON.stringify({ prepared: true, atlasCount: artEvidence.files.length, manifestSha256: artEvidence.manifestSha256 }) + "\n");
} else {
  const fixture = JSON.parse(await readFile(resolve(root, "data/fixture.json"), "utf8"));
  const artView = JSON.parse(await readFile(resolve(root, "data/art-view.json"), "utf8"));
  if (fixture.source?.interior?.binding?.artReleaseId !== artView.releaseId
    || fixture.source?.interior?.binding?.artManifestHash !== artView.manifestSha256) {
    throw new Error("Die native Innenraumquelle ist nicht an die eingebetteten Originalatlanten gebunden.");
  }
  const liveRequire = createRequire(resolve(repository, "apps/livemap/package.json"));
  const viteRequire = createRequire(liveRequire.resolve("vite"));
  const { build } = await import(pathToFileURL(viteRequire.resolve("esbuild")).href);
  const aliases = {
    "@zugfolge-offline/conductor-mode": resolve(repository, "apps/livemap/src/conductor-mode.ts"),
    "@zugfolge-offline/conductor-api": resolve(repository, "apps/livemap/src/conductor-api.ts"),
    "@zugfolge-offline/conductor-renderer": resolve(repository, "apps/livemap/src/conductor-renderer.ts"),
    "@zugfolge/design-system": resolve(repository, "packages/design-system/src/index.ts"),
    "@zugfolge/design-system/railway.css": resolve(repository, "packages/design-system/src/railway.css"),
    "@zugfolge/design-system/styles.css": resolve(repository, "packages/design-system/src/styles.css"),
  };
  const result = await build({ absWorkingDir: root, entryPoints: ["src/main.ts"], bundle: true, write: false,
    format: "iife", platform: "browser", target: ["es2022"], minify: true, legalComments: "inline", sourcemap: false,
    metafile: true, outfile: resolve(root, "in-memory/demo.js"), splitting: false,
    nodePaths: [resolve(repository, "apps/livemap/node_modules"), resolve(repository, "node_modules")],
    loader: { ".wasm": "binary", ".png": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "original-ui-and-inline-bytes", setup(build) {
      build.onResolve({ filter: /^@zugfolge(?:-offline)?\// }, (request) => aliases[request.path] ? { path: aliases[request.path] } : undefined);
      build.onResolve({ filter: /\?bytes$/ }, (request) => ({ path: resolve(request.resolveDir, request.path.slice(0, -6)), namespace: "inline-bytes" }));
      build.onLoad({ filter: /.*/, namespace: "inline-bytes" }, async (request) => ({ contents: await readFile(request.path), loader: "binary" }));
    } }],
  });
  if (Object.values(result.metafile.outputs).some((item) => item.imports.length > 0)
    || result.outputFiles.some((file) => !/\.(?:js|css)$/u.test(file.path))) throw new Error("Der Offline-Build enthält externe oder ausgelagerte Dateien.");
  const script = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text;
  if (!script || !css || /@import\s|url\(\s*["']?(?:https?:)?\/\//iu.test(css)) throw new Error("Der Offline-Build ist unvollständig oder enthält externe Styles.");
  const template = await readFile(resolve(root, "template.html"), "utf8");
  if (template.split("<!--DEMO_CSS-->").length !== 2 || template.split("<!--DEMO_JS-->").length !== 2) throw new Error("Die HTML-Vorlage ist nicht eindeutig.");
  const scriptBytes = Buffer.from(script), compressedScript = gzipSync(scriptBytes, { level: 9 });
  if (!gunzipSync(compressedScript).equals(scriptBytes)) throw new Error("Das komprimierte Spielskript ist nicht unverändert wiederherstellbar.");
  const bootstrap = `(async()=>{try{if(typeof DecompressionStream!=="function")throw new Error("Diese Demo benötigt einen aktuellen Browser mit DecompressionStream, zum Beispiel Edge oder Chrome.");const packed=${JSON.stringify(compressedScript.toString("base64"))};const bytes=Uint8Array.from(atob(packed),c=>c.charCodeAt(0));const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));const code=await new Response(stream).text();const script=document.createElement("script");script.textContent=code;document.body.append(script);}catch(error){const host=document.getElementById("demo-root");const message=document.createElement("p");message.setAttribute("role","alert");message.style.cssText="max-width:650px;margin:48px auto;padding:24px;font:16px/1.6 system-ui;color:#f5f7fa";message.textContent=error instanceof Error&&error.message.startsWith("Diese Demo benötigt")?error.message:"Die lokale Demo konnte nicht entpackt werden. Öffne die HTML-Datei erneut in einem aktuellen Browser.";host.replaceChildren(message);}})();`;
  const html = template.replace("<!--DEMO_CSS-->", () => css.replace(/<\/style/giu, "\\3c /style"))
    .replace("<!--DEMO_JS-->", () => bootstrap.replace(/<\/script/giu, "<\\/script"));
  await mkdir(dirname(output), { recursive: true });
  const temporary = resolve(dirname(output), `.${randomUUID()}.offline-demo.tmp`);
  try { await writeFile(temporary, html, { flag: "wx" }); await rename(temporary, output); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  const proof = { schemaVersion: "zugfolge-offline-demo-build/v1", output: relative(root, output).replaceAll("\\", "/"),
    sha256: sha(Buffer.from(html)), bytes: Buffer.byteLength(html), art: artEvidence, native: nativeEvidence, demoArt: demoArtEvidence,
    scriptCompression: { format: "gzip-base64", compressedBytes: compressedScript.length, decodedBytes: scriptBytes.length, decodedSha256: sha(scriptBytes), networkRequired: false },
    embeddedInputs: await Promise.all(["native/kernel.wasm", "data/fixture.json", "data/art-view.json", "data/atlases.json", "data/scene.json", "data/practice-public.json", "assets-v2/characters.png", "assets-v2/environment.png"]
      .map(async (path) => { const bytes = await readFile(resolve(root, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; })),
    externalImports: Object.values(result.metafile.outputs).flatMap((item) => item.imports),
    originalUi: await Promise.all(["conductor-report.ts", "conductor-dialog.ts", "conductor.css"]
      .map(async (file) => ({ path: `apps/livemap/src/${file}`, sha256: sha(await readFile(resolve(repository, "apps/livemap/src", file))) }))),
    gameUi: await Promise.all(["src/main.ts", "src/game-mode.ts", "src/game-mode.css", "src/game-renderer.ts", "src/demo.css", "src/offline-api.ts", "src/worker-runtime.ts", "src/wasm-loader.ts", "src/bootstrap.ts", "src/assets.ts"]
      .map(async (path) => ({ path, sha256: sha(await readFile(resolve(root, path))) }))) };
  await writeFile(resolve(outputs, "build-info.json"), JSON.stringify(proof, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ output, bytes: proof.bytes, sha256: proof.sha256, atlasCount: artEvidence.files.length }) + "\n");
}
