import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const backupScript = join(repositoryRoot, "ops/alpha/backup-game.sh");
const restoreScript = join(repositoryRoot, "ops/alpha/restore-game.sh");

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

describe.skipIf(process.platform === "win32")("Game-Backup-/Restore-Vertrag", () => {
  it("bindet die Migrationszahl an das Manifest und verweigert Abweichungen", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-backup-contract-"));
    const bin = join(root, "bin");
    const dump = join(root, "game.dump");
    const manifest = join(root, "game.manifest.json");
    await mkdir(bin);
    await executable(join(bin, "pg_dump"), `#!/bin/sh
set -eu
output=
for argument in "$@"; do
  case "$argument" in --file=*) output=\${argument#--file=} ;; esac
done
test -n "$output"
printf 'bound-game-backup' >"$output"
`);
    await executable(join(bin, "psql"), "#!/bin/sh\nprintf '%s\\n' \"${MOCK_MIGRATION_COUNT:-27}\"\n");
    for (const command of ["dropdb", "createdb", "pg_restore"]) {
      await executable(join(bin, command), "#!/bin/sh\nexit 0\n");
    }
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MOCK_MIGRATION_COUNT: "27" };

    const backup = spawnSync("sh", [backupScript, "postgres://source/game", dump, manifest], {
      encoding: "utf8",
      env: environment,
    });
    expect(backup.status, backup.stderr).toBe(0);
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      schema: "zugfolge-game-backup/v2",
      migrationCount: 27,
    });

    const restored = spawnSync("sh", [restoreScript, "postgres://admin/postgres", "zugfolge_restore_contract", dump, manifest], {
      encoding: "utf8",
      env: environment,
    });
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ migrationCount: 27, identical: true });

    const mismatchedManifest = join(dirname(manifest), "mismatched.manifest.json");
    await writeFile(mismatchedManifest, (await readFile(manifest, "utf8")).replace('"migrationCount":27', '"migrationCount":28'), "utf8");
    const refused = spawnSync("sh", [restoreScript, "postgres://admin/postgres", "zugfolge_restore_contract", dump, mismatchedManifest], {
      encoding: "utf8",
      env: environment,
    });
    expect(refused.status).toBe(69);
    expect(refused.stderr).toContain("does not match backup 28");
  });
});
