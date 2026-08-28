import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { WINDOWS_BUILD_ANCHOR_HELPER_SOURCE } from "./operational-validator-rebuild-evidence.mjs";

const execFileAsync = promisify(execFile);
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const OUTPUT_BASENAME = "operational-windows-anchor-helper.dll";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sectionOffsetForRva(bytes, peOffset, rva) {
  const numberOfSections = bytes.readUInt16LE(peOffset + 6);
  const optionalHeaderBytes = bytes.readUInt16LE(peOffset + 20);
  const table = peOffset + 24 + optionalHeaderBytes;
  for (let index = 0; index < numberOfSections; index += 1) {
    const header = table + index * 40;
    const virtualSize = bytes.readUInt32LE(header + 8);
    const virtualAddress = bytes.readUInt32LE(header + 12);
    const rawBytes = bytes.readUInt32LE(header + 16);
    const rawOffset = bytes.readUInt32LE(header + 20);
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawBytes)) return rawOffset + rva - virtualAddress;
  }
  throw new Error(`Helper-PE-RVA 0x${rva.toString(16)} liegt ausserhalb aller Sections.`);
}

function normalizeFrameworkAssembly(input, sourceBytes) {
  const bytes = Buffer.from(input);
  invariant(bytes.subarray(0, 2).toString("ascii") === "MZ", "Helper-Assembly besitzt keinen MZ-Header.");
  const peOffset = bytes.readUInt32LE(0x3c);
  invariant(bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), "Helper-Assembly besitzt keinen PE-Header.");
  const optional = peOffset + 24;
  invariant(bytes.readUInt16LE(optional) === 0x20b, "Helper-Assembly ist nicht PE32+.");
  bytes.writeUInt32LE(0, peOffset + 8);
  const cliRva = bytes.readUInt32LE(optional + 112 + 14 * 8);
  const cli = sectionOffsetForRva(bytes, peOffset, cliRva);
  const metadataRva = bytes.readUInt32LE(cli + 8);
  const metadata = sectionOffsetForRva(bytes, peOffset, metadataRva);
  invariant(bytes.readUInt32LE(metadata) === 0x424a5342, "Helper-Assembly besitzt keinen CLR-Metadatenkopf.");
  const versionBytes = bytes.readUInt32LE(metadata + 12);
  let cursor = metadata + 16 + versionBytes;
  cursor = (cursor + 3) & ~3;
  const streamCount = bytes.readUInt16LE(cursor + 2);
  cursor += 4;
  let guidStream;
  for (let index = 0; index < streamCount; index += 1) {
    const offset = bytes.readUInt32LE(cursor);
    const size = bytes.readUInt32LE(cursor + 4);
    let end = cursor + 8;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    invariant(end < bytes.length, "Helper-Assembly besitzt einen unvollstaendigen Metadaten-Streamnamen.");
    const name = bytes.subarray(cursor + 8, end).toString("ascii");
    if (name === "#GUID") guidStream = { offset: metadata + offset, size };
    cursor = (end + 4) & ~3;
  }
  invariant(guidStream && guidStream.size > 0 && guidStream.size % 16 === 0, "Helper-Assembly besitzt keinen kanonischen #GUID-Stream.");
  const sourceHash = sha256(sourceBytes);
  for (let offset = 0; offset < guidStream.size; offset += 16) {
    const replacement = createHash("sha256").update(`${sourceHash}:guid:${offset / 16}`, "utf8").digest();
    replacement.copy(bytes, guidStream.offset + offset, 0, 16);
  }
  return bytes;
}

async function compileOnce(root, id) {
  const source = resolve(root, `helper-${id}.cs`);
  const outputDirectory = resolve(root, `output-${id}`);
  const output = resolve(outputDirectory, OUTPUT_BASENAME);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(outputDirectory));
  await writeFile(source, WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, { encoding: "utf8", flag: "wx" });
  await execFileAsync(CSC, ["/nologo", "/target:library", "/platform:x64", "/optimize+", "/debug-", `/out:${output}`, source], {
    encoding: "utf8",
    windowsHide: true,
  });
  return normalizeFrameworkAssembly(await readFile(output), Buffer.from(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, "utf8"));
}

export async function buildOperationalValidatorWindowsAnchorHelper(outputInput) {
  const output = resolve(outputInput);
  invariant(basename(output).toLowerCase() === OUTPUT_BASENAME, `Helper-Ausgabe muss ${OUTPUT_BASENAME} heissen.`);
  const temporary = await mkdtemp(resolve(tmpdir(), "zugfolge-anchor-helper-"));
  try {
    const first = await compileOnce(temporary, "a");
    const second = await compileOnce(temporary, "b");
    invariant(first.equals(second), "Framework-csc-Helper ist nach PE/MVID-Normalisierung nicht deterministisch.");
    await writeFile(output, first, { flag: "wx" });
    return { bytes: first.length, path: output, sha256: sha256(first), sourceSha256: sha256(Buffer.from(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, "utf8")) };
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const output = process.argv[2];
  if (!output) throw new Error("Aufruf: node build-operational-validator-windows-anchor-helper.mjs <output.dll>");
  process.stdout.write(`${JSON.stringify(await buildOperationalValidatorWindowsAnchorHelper(output))}\n`);
}
