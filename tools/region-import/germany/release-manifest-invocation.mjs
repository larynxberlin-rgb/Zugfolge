import { resolve } from "node:path";

export const GERMANY_RELEASE_MANIFEST_USAGE =
  "Aufruf: build-germany-release.mjs manifest CONFIG CATALOG RIGHTS CAPTURE ARTIFACTS STATIC_QUALITY OPERATIONAL_QUALITY OUTPUT";

export function germanyReleaseManifestCompilerArgs(args, resolvePath = resolve) {
  if (!Array.isArray(args) || args.length !== 8 || args.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(GERMANY_RELEASE_MANIFEST_USAGE);
  }
  return ["manifest", ...args.map((path) => resolvePath(path))];
}
