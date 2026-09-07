import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, parse, resolve } from "node:path";
const FAILURE = "Die lokale Deploymentdatei ist ungültig.";
function check(value: unknown): asserts value { if (!value) throw new Error(FAILURE); }
function text(value: unknown): string { check(typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value)); return value; }
/** Bounded local bytes shared by the cold deployment loaders; no network or symlink traversal. */
export async function readLocalDeploymentFile(path: unknown, maximum: number): Promise<Buffer> {
  const input = text(path);
  check(isAbsolute(input) && !input.startsWith("\\\\") && !input.startsWith("//") && !input.split(/[\\/]/u).includes(".."));
  const absolute = resolve(input);
  for (let current = absolute; ; current = dirname(current)) {
    const stat = await lstat(current);
    check(!stat.isSymbolicLink());
    if (current === parse(current).root) break;
  }
  const canonical = normalize(await realpath(absolute));
  check(process.platform === "win32" ? canonical.toLowerCase() === normalize(absolute).toLowerCase() : canonical === normalize(absolute));
  const file = await open(absolute, "r");
  try {
    const before = await file.stat();
    check(before.isFile() && before.size > 0 && before.size <= maximum);
    const bytes = Buffer.alloc(before.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const part = await file.read(bytes, read, bytes.length - read, null);
      if (part.bytesRead === 0) break;
      read += part.bytesRead;
    }
    const after = await file.stat(), named = await lstat(absolute);
    check(read === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs
      && !named.isSymbolicLink() && named.dev === before.dev && named.ino === before.ino);
    return bytes.subarray(0, read);
  } finally { await file.close(); }
}
