import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { ArtAtlasError, invariant } from "./errors.js";
import { loadArtAtlasForWorld } from "./loader.js";
import type { LoadArtAtlasInput, LoadedArtAtlas } from "./loader.js";
import { parseArtAtlasManifest, parseArtAtlasSignature, parseArtAtlasWorldPin } from "./parse.js";

export interface LoadArtAtlasDirectoryInput extends Pick<LoadArtAtlasInput, "worldId" | "expectedPin" | "signature" | "trustedKeys"> {
  /** Unveränderlich bereitgestellter lokaler Releaseordner; kein Vertrauensspeicher. */
  directory: string;
}

function samePath(first: string, second: string): boolean {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

/** Auch Eltern des Releaseordners dürfen keine Links oder Junctions enthalten. */
async function regularPath(path: string, file: boolean): Promise<Awaited<ReturnType<typeof lstat>>> {
  const root = parse(path).root;
  const segments = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let stat = await lstat(root);
  invariant(!stat.isSymbolicLink() && stat.isDirectory(), "atlas_directory_path_invalid");
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]!);
    stat = await lstat(current);
    invariant(!stat.isSymbolicLink(), "atlas_directory_path_invalid");
    invariant(index === segments.length - 1 && file ? stat.isFile() : stat.isDirectory(), "atlas_directory_file_invalid");
  }
  invariant(samePath(await realpath(path), path), "atlas_directory_path_invalid");
  return stat;
}

async function readBounded(directory: string, resourcePath: string, maximum: number): Promise<Uint8Array> {
  // Ressourcepfade kommen aus dem strikten Manifestparser; diese Grenze bleibt
  // zusätzlich gegen spätere Aufrufer-/Parseränderungen geschlossen.
  invariant(resourcePath.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) && part !== "." && part !== ".."), "atlas_directory_path_invalid");
  const path = resolve(directory, resourcePath);
  const inside = relative(directory, path);
  invariant(inside !== "" && !isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${sep}`), "atlas_directory_path_invalid");
  let descriptor: FileHandle | undefined;
  try {
    const before = await regularPath(path, true);
    invariant(before.size > 0 && before.size <= maximum, "atlas_resource_size_invalid");
    descriptor = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await descriptor.stat();
    invariant(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, "atlas_directory_resource_changed");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await descriptor.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await regularPath(path, true), final = await descriptor.stat();
    invariant(length === before.size && [after, final].every((stat) => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs), "atlas_directory_resource_changed");
    return bytes.subarray(0, length);
  } finally {
    await descriptor?.close();
  }
}

/** Lokale Bytes werden geprüft; Vertrauen, Weltpin und Signatur kommen allein vom Server. */
export async function loadArtAtlasFromDirectory(input: LoadArtAtlasDirectoryInput): Promise<LoadedArtAtlas> {
  try {
    invariant(typeof input.directory === "string" && input.directory.length > 0 && input.directory.length <= 4096 && !input.directory.includes("\0") && !/^[a-z]+:\/\//i.test(input.directory) && !/^(\\\\|\/\/)/.test(input.directory), "atlas_directory_path_invalid");
    const worldId = input.worldId, signature = parseArtAtlasSignature(input.signature), trustedKeys = new Map(input.trustedKeys);
    const expectedPin = parseArtAtlasWorldPin(input.expectedPin);
    invariant(expectedPin.worldId === worldId, "atlas_world_mismatch");
    const directory = resolve(input.directory);
    await regularPath(directory, false);
    const manifestBytes = await readBounded(directory, "manifest.json", 32 * 1024 * 1024);
    let json: unknown;
    try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown; }
    catch { throw new ArtAtlasError("manifest_json_invalid"); }
    const manifest = parseArtAtlasManifest(json);
    const resources = async (rows: { path: string }[], perFile: number, totalLimit: number): Promise<Map<string, Uint8Array>> => {
      const result = new Map<string, Uint8Array>();
      let total = 0;
      for (const row of rows) {
        if (result.has(row.path)) continue;
        const bytes = await readBounded(directory, row.path, Math.min(perFile, totalLimit - total));
        total += bytes.byteLength;
        result.set(row.path, bytes);
      }
      return result;
    };
    const files = await resources(manifest.files, 64 * 1024 * 1024, 128 * 1024 * 1024);
    const evidence = await resources(manifest.evidence, 16 * 1024 * 1024, 64 * 1024 * 1024);
    return loadArtAtlasForWorld({ worldId, expectedPin, signature, trustedKeys, manifestBytes, resources: { files, evidence } });
  } catch (error) {
    if (error instanceof ArtAtlasError) throw error;
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") throw new ArtAtlasError("atlas_directory_resource_missing");
    if (code === "ELOOP") throw new ArtAtlasError("atlas_directory_path_invalid");
    throw new ArtAtlasError("atlas_directory_read_failed");
  }
}
