import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reproduzierbare Toolpfade, unabhängig vom Arbeitsverzeichnis des Aufrufers. */
export const root = dirname(fileURLToPath(import.meta.url));
export const repository = resolve(root, "../..");
export const outputs = resolve(repository, "outputs/conductor-offline");
export const artifact = resolve(outputs, "M15-Offline-Demo.html");
await mkdir(outputs, { recursive: true });

export const outputPath = (name) => resolve(outputs, name);

/** Nur vorhandene Originalprogramme verwenden; dieser Helfer baut keinen Kern. */
export function nativeExample(name, environmentName) {
  if (process.env[environmentName]) return resolve(process.env[environmentName]);
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(repository, process.env.CARGO_TARGET_DIR) : resolve(repository, "target");
  return resolve(target, "release/examples", `${name}${process.platform === "win32" ? ".exe" : ""}`);
}

export async function browserLaunchOptions() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.ZUGFOLGE_BROWSER_EXECUTABLE;
  if (configured) return { executablePath: resolve(configured), headless: true };
  if (process.platform === "win32") return { channel: "msedge", headless: true };
  for (const executablePath of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"]) {
    try { await access(executablePath); return { executablePath, headless: true }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Ohne Systembrowser verwendet Playwright seinen zuvor installierten Chromium.
  return { headless: true };
}
