/** Rebuild the transport evidence from the actual Rust engine, on explicitly fictional geography. */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const extension = process.platform === "win32" ? ".exe" : "";
const target = process.env.CARGO_TARGET_DIR ?? resolve(root, "target");
const fixtureBinary = process.env.ZUGFOLGE_SCENE_FIXTURE_BINARY ?? resolve(target, `debug/examples/scene_fixture_json${extension}`);
const sceneBinary = process.env.ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY ?? resolve(target, `debug/examples/scene_json${extension}`);
function command(binary, input) {
  const result = spawnSync(binary, [], { input, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("The actual scene evidence executable failed.");
  const value = JSON.parse(result.stdout);
  if (value?.error) throw new Error("The actual scene projection rejected its engine fixture.");
  return value;
}
const inputs = command(fixtureBinary);
if (Object.keys(inputs).sort().join(",") !== "initial,moving,restored") throw new Error("Unexpected native fixture schema.");
const frames = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, { input, output: command(sceneBinary, `${JSON.stringify(input)}\n`) }]));
const evidence = { provenance: "Explicit fictional geography; input from scene_fixture_json OperationalWorld, output from scene_json Rust projection. No production coverage claim.", ...frames };
writeFileSync(resolve(root, "packages/runtime-native/src/fixtures/conductor-scenes-v1.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ frames: Object.keys(frames), restoredProjectionMatches: JSON.stringify(frames.moving.output) === JSON.stringify(frames.restored.output) }));
