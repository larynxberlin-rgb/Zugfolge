#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE,
  GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE,
  germanyOperationalSystemLauncherSource,
} from "./operational-infrastructure-v2-execution-pins.mjs";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export function buildGermanyOperationalSystemLauncherSources() {
  return new Map([
    [GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE, Buffer.from(germanyOperationalSystemLauncherSource("win32"), "utf8")],
    [GERMANY_OPERATIONAL_LINUX_LAUNCHER_SOURCE_FILE, Buffer.from(germanyOperationalSystemLauncherSource("linux"), "utf8")],
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await Promise.all([...buildGermanyOperationalSystemLauncherSources()].map(([file, bytes]) => writeFile(join(REPOSITORY_ROOT, file), bytes)));
}
