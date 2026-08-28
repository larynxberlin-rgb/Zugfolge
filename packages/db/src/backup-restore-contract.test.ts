import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    const operation = join(root, "game.operation.json");
    const receipt = join(root, "game.restore.json");
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
    await executable(join(bin, "psql"), `#!/bin/sh
case "$*" in
  *pg_current_wal_lsn*) printf '%s\n' '0/16B6C50' ;;
  *) printf '%s\n' "\${MOCK_MIGRATION_COUNT:-27}" ;;
esac
`);
    for (const command of ["dropdb", "createdb", "pg_restore"]) {
      await executable(join(bin, command), "#!/bin/sh\nexit 0\n");
    }
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      MOCK_MIGRATION_COUNT: "27",
      DATABASE_ROLLBACK_WRITERS_QUIESCED: "true",
    };

    const backup = spawnSync("sh", [backupScript, "postgres://source/game", dump, manifest, operation], {
      encoding: "utf8",
      env: environment,
    });
    expect(backup.status, backup.stderr).toBe(0);
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      schema: "zugfolge-game-backup/v2",
      migrationCount: 27,
    });
    expect(JSON.parse(await readFile(operation, "utf8"))).toMatchObject({
      schema: "zugfolge-game-backup-operation/v1",
      backupId: expect.stringMatching(/^pgdump-sha256-[a-f0-9]{64}$/),
      backupStartedWalLsn: "0/16B6C50",
      backupCompletedWalLsn: "0/16B6C50",
      writersQuiesced: true,
    });
    const originalDump = await readFile(dump);
    const originalManifest = await readFile(manifest);
    const originalOperation = await readFile(operation);
    const duplicateBackup = spawnSync("sh", [backupScript, "postgres://source/game", dump, manifest, operation], {
      encoding: "utf8",
      env: environment,
    });
    expect(duplicateBackup.status).toBe(66);
    expect(await readFile(dump)).toEqual(originalDump);
    expect(await readFile(manifest)).toEqual(originalManifest);
    expect(await readFile(operation)).toEqual(originalOperation);

    const restored = spawnSync("sh", [restoreScript, "postgres://admin/postgres", "zugfolge_restore_contract", dump, manifest, receipt], {
      encoding: "utf8",
      env: environment,
    });
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({
      schema: "zugfolge-game-restore/v2",
      database: "zugfolge_restore_contract",
      migrationCount: 27,
      identical: true,
      dumpSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(JSON.parse(restored.stdout));

    await writeFile(receipt, "foreign-receipt", "utf8");
    const overwriteRefused = spawnSync("sh", [restoreScript, "postgres://admin/postgres", "zugfolge_restore_contract", dump, manifest, receipt], {
      encoding: "utf8",
      env: environment,
    });
    expect(overwriteRefused.status).toBe(66);
    expect(await readFile(receipt, "utf8")).toBe("foreign-receipt");

    const mismatchedManifest = join(dirname(manifest), "mismatched.manifest.json");
    await writeFile(mismatchedManifest, (await readFile(manifest, "utf8")).replace('"migrationCount":27', '"migrationCount":28'), "utf8");
    const refused = spawnSync("sh", [restoreScript, "postgres://admin/postgres", "zugfolge_restore_contract", dump, mismatchedManifest], {
      encoding: "utf8",
      env: environment,
    });
    expect(refused.status).toBe(69);
    expect(refused.stderr).toContain("does not match backup 28");
  });

  it("erzeugt ohne explizit quieszierten Writerzustand keinen Operationsbeleg", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-game-backup-quiescence-"));
    const bin = join(root, "bin");
    const dump = join(root, "game.dump");
    const manifest = join(root, "game.manifest.json");
    const operation = join(root, "game.operation.json");
    await mkdir(bin);
    await executable(join(bin, "pg_dump"), "#!/bin/sh\nexit 99\n");
    const refused = spawnSync("sh", [backupScript, "postgres://source/game", dump, manifest, operation], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(refused.status).toBe(65);
    expect(refused.stderr).toContain("WRITERS_QUIESCED");
    await expect(access(operation)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
