import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = dirname(fileURLToPath(import.meta.url));
const RELEASE = resolve(TOOL, "../../assets/conductor-art/v1");
const STATIC = new Map([["/", ["preview.html", "text/html; charset=utf-8"]],
  ["/brand.svg", ["../../docs/brand/zugfolge-rail-mark.svg", "image/svg+xml"]],
  ["/preview.mjs", ["preview.mjs", "text/javascript; charset=utf-8"]],
  ["/preview.css", ["preview.css", "text/css; charset=utf-8"]]]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function inside(root, path) {
  const actualRoot = await realpath(root), actualPath = await realpath(resolve(root, path));
  const part = relative(actualRoot, actualPath);
  if (isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`)) throw new Error("outside_release");
  return readFile(actualPath);
}

async function readRelease(root) {
  const bytes = await inside(root, "prepared.json");
  const prepared = JSON.parse(bytes.toString("utf8"));
  if (prepared.schemaVersion !== "conductor-art-prepared/v1" || !Array.isArray(prepared.files)
    || !Array.isArray(prepared.assets) || !Array.isArray(prepared.animations)) throw new Error("invalid_prepared");
  let manifest = null, manifestSha256 = null;
  try {
    const manifestBytes = await inside(root, "manifest.json");
    manifest = JSON.parse(manifestBytes.toString("utf8"));
    manifestSha256 = digest(manifestBytes);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { schemaVersion: "conductor-art-preview/v1", preparedSha256: digest(bytes), prepared, manifest, manifestSha256 };
}

/** Local read-only review surface: only this release's declared atlas PNGs are served. */
export async function startArtPreviewServer({ port = 4186, releaseDirectory = RELEASE } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_port");
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const send = (status, type, bytes) => {
      response.writeHead(status, { "Content-Type": type });
      response.end(request.method === "HEAD" ? undefined : bytes);
    };
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("Allow", "GET, HEAD"); return send(405, "text/plain; charset=utf-8", "Nur lesender Zugriff.");
    }
    try {
      const rawPath = (request.url ?? "").split("?")[0];
      if (!rawPath.startsWith("/") || /[%\\\0]/.test(rawPath) || rawPath.split("/").includes(".."))
        return send(404, "text/plain; charset=utf-8", "Nicht verfügbar.");
      const hostname = request.headers.host?.split(":")[0];
      if (hostname !== "127.0.0.1" && hostname !== "localhost") return send(403, "text/plain; charset=utf-8", "Nur lokal verfügbar.");
      if (STATIC.has(rawPath)) {
        const [file, type] = STATIC.get(rawPath);
        return send(200, type, await readFile(resolve(TOOL, file)));
      }
      if (rawPath === "/api/release") return send(200, "application/json; charset=utf-8", JSON.stringify(await readRelease(releaseDirectory)));
      if (/^\/atlases\/[a-zA-Z0-9._-]+\.png$/.test(rawPath)) {
        const data = await readRelease(releaseDirectory), path = rawPath.slice(1);
        if (data.prepared.files.some((file) => file.path === path)) return send(200, "image/png", await inside(releaseDirectory, path));
      }
      return send(404, "text/plain; charset=utf-8", "Nicht verfügbar.");
    } catch (error) {
      return send(error.code === "ENOENT" ? 404 : 503, "text/plain; charset=utf-8", "Der Grafikstand ist noch nicht vollständig lesbar.");
    }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startArtPreviewServer({ port: Number(process.env.ART_PREVIEW_PORT ?? 4186) });
  console.log(`Atlas-Grafikprüfung: http://127.0.0.1:${server.address().port}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
}
