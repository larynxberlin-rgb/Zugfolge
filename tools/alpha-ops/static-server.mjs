import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? "4179");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("invalid port");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const requested = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const relative = requested === "four-eyes-preview.html"
    ? "odoo/addons/zugfolge_admin/static/tests/admin-preview.html"
    : requested;
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  try {
    if (!statSync(path).isFile()) throw new Error("not file");
    response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(port, process.env["HOST"] ?? "0.0.0.0", () => process.stdout.write(`static server http://127.0.0.1:${port}\n`));
