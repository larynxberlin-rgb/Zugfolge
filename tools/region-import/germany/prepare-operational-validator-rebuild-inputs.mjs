import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const TOOLCHAIN_MANIFEST_SCHEMA = "zugfolge-operational-validator-toolchain-manifest/v1";
const VENDOR_COMMENT = "cargo-vendor-tree-v1";
const PORTABLE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\x00-\x1f]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const collator = new Intl.Collator("en-US", { sensitivity: "variant", usage: "sort" });

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function portable(root, path, label) {
  const value = relative(root, path).split(sep).join("/");
  invariant(value !== "" && PORTABLE_PATH.test(value), `${label} besitzt keinen sicheren relativen Pfad: ${value}`);
  return value;
}

async function inventory(rootInput) {
  const root = resolve(rootInput);
  invariant(isAbsolute(root), "Inputwurzel muss absolut aufloesbar sein.");
  const rootMetadata = await lstat(root);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Inputwurzel muss ein regulaeres, reparsefreies Verzeichnis sein.");
  const directories = [];
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => collator.compare(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path, { bigint: true });
      invariant(!metadata.isSymbolicLink(), `Inputbaum enthaelt einen Link/Reparse-Point: ${path}`);
      if (metadata.isDirectory()) {
        directories.push({ file: portable(root, path, "Verzeichnis"), path });
        await visit(path);
      } else {
        invariant(metadata.isFile() && metadata.size > 0n && metadata.size <= 512n * 1024n * 1024n, `Inputbaum enthaelt keine zulaessige regulaere Datei: ${path}`);
        files.push({ bytes: Number(metadata.size), file: portable(root, path, "Datei"), path });
      }
    }
  }
  await visit(root);
  invariant(directories.length + files.length <= 100_000, "Inputbaum ist unerwartet gross.");
  return { directories, files, root };
}

function writeOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  invariant(text.length < length, "TAR-Oktalwert ist zu gross.");
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  for (;;) {
    const next = String(length).length + 1 + Buffer.byteLength(payload);
    if (next === length) return Buffer.from(`${length} ${payload}`, "utf8");
    length = next;
  }
}

function tarHeader({ bytes, mode, name, type }) {
  invariant(Buffer.byteLength(name, "utf8") <= 100, `TAR-Pfad ist zu lang: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0;
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    invariant(bytesWritten > 0, "Create-new Ausgabedatei nahm keine Bytes an.");
    offset += bytesWritten;
  }
}

async function writeVendorTar(root, output) {
  const tree = await inventory(root);
  invariant(tree.directories.some(({ file }) => file === ".cargo") && tree.directories.some(({ file }) => file === "vendor"), "Vendorwurzel muss .cargo und vendor enthalten.");
  invariant(tree.files.some(({ file }) => file === ".cargo/config.toml"), "Vendorwurzel bindet keine .cargo/config.toml.");
  const handle = await open(resolve(output), "wx", 0o600);
  let primaryError;
  try {
    const comment = paxRecord("comment", VENDOR_COMMENT);
    await writeAll(handle, tarHeader({ bytes: comment.length, mode: 0o600, name: "pax_global_header", type: "g" }));
    await writeAll(handle, comment);
    await writeAll(handle, Buffer.alloc((512 - (comment.length % 512)) % 512));
    const entries = [
      ...tree.directories.map((entry) => ({ ...entry, directory: true })),
      ...tree.files.map((entry) => ({ ...entry, directory: false })),
    ].sort((left, right) => collator.compare(left.directory ? `${left.file}/` : left.file, right.directory ? `${right.file}/` : right.file));
    for (const entry of entries) {
      const name = entry.directory ? `${entry.file}/` : entry.file;
      await writeAll(handle, tarHeader({ bytes: entry.directory ? 0 : entry.bytes, mode: entry.directory ? 0o700 : 0o600, name, type: entry.directory ? "5" : "0" }));
      if (!entry.directory) {
        const bytes = await readFile(entry.path);
        invariant(bytes.length === entry.bytes, `Vendor-Datei driftete waehrend TAR-Erzeugung: ${entry.file}`);
        await writeAll(handle, bytes);
        await writeAll(handle, Buffer.alloc((512 - (bytes.length % 512)) % 512));
      }
    }
    await writeAll(handle, Buffer.alloc(1024));
    await handle.sync();
  } catch (error) { primaryError = error; }
  let closeError;
  try { await handle.close(); } catch (error) { closeError = error; }
  if (primaryError && closeError) throw new AggregateError([primaryError, closeError], "Vendor-TAR und Close sind fehlgeschlagen.");
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  const bytes = await readFile(resolve(output));
  return { bytes: bytes.length, path: resolve(output), sha256: sha256(bytes) };
}

async function writeToolchainManifest(root, id, output) {
  invariant(/^[A-Za-z0-9._+-]+$/u.test(id), "Toolchain-Manifest-ID ist ungueltig.");
  const tree = await inventory(root);
  const files = [];
  for (const entry of tree.files) {
    const bytes = await readFile(entry.path);
    invariant(bytes.length === entry.bytes, `Toolchain-Datei driftete bei der Manifestbildung: ${entry.file}`);
    files.push({ bytes: entry.bytes, file: entry.file, sha256: sha256(bytes) });
  }
  const value = { directories: tree.directories.map(({ file }) => file), files, id, schema: TOOLCHAIN_MANIFEST_SCHEMA };
  const bytes = canonicalBytes(value);
  const handle = await open(resolve(output), "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  return { bytes: bytes.length, directoryCount: value.directories.length, fileCount: files.length, path: resolve(output), sha256: sha256(bytes) };
}

const [command, ...args] = process.argv.slice(2);
let result;
if (command === "vendor-tar" && args.length === 2) result = await writeVendorTar(args[0], args[1]);
else if (command === "toolchain-manifest" && args.length === 3) result = await writeToolchainManifest(args[0], args[1], args[2]);
else throw new Error([
  "Aufruf:",
  "  prepare-operational-validator-rebuild-inputs.mjs vendor-tar ROOT OUTPUT.tar",
  "  prepare-operational-validator-rebuild-inputs.mjs toolchain-manifest ROOT ID OUTPUT.json",
].join("\n"));
invariant(Number.isSafeInteger(result.bytes) && result.bytes > 0 && SHA256.test(result.sha256), "Vorbereitungsbeleg ist ungueltig.");
process.stdout.write(`${JSON.stringify(result)}\n`);
