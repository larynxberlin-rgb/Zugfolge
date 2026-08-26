import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const command = resolve("tools/alpha-ops/activate-production-recovery.mjs");
const continuationCommand = resolve("tools/alpha-ops/continue-production-recovery.mjs");

function runCommand(path, ...arguments_) {
  return spawnSync(process.execPath, [path, ...arguments_], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {},
  });
}

const run = (...arguments_) => runCommand(command, ...arguments_);

test("Recovery-CLI leitet den kanonischen prepared-Modus an den Kernvertrag weiter", () => {
  const result = run("prepared");

  assert.equal(result.status, 65);
  assert.doesNotMatch(result.stderr, /Aufruf:/u);
  assert.match(result.stderr, /PRODUCTION_RECOVERY_ID fehlt/u);
});

test("getrennte Continuation-CLI leitet ohne frei waehlbaren Modus an den Kernvertrag weiter", () => {
  const result = runCommand(continuationCommand);

  assert.equal(result.status, 65);
  assert.doesNotMatch(result.stderr, /Aufruf:/u);
  assert.match(result.stderr, /PRODUCTION_RECOVERY_ID fehlt/u);

  const argument = runCommand(continuationCommand, "continue");
  assert.equal(argument.status, 64);
  assert.match(argument.stderr, /continue-production-recovery\.mjs/u);
});

test("Recovery-CLI verweigert fehlende, unbekannte und mehrfach angegebene Modi vor dem Kernvertrag", () => {
  for (const arguments_ of [[], ["unknown"], ["continue"], ["prepared", "extra"]]) {
    const result = run(...arguments_);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /<prepared\|preflight\|activate\|reseal>/u);
  }
});
