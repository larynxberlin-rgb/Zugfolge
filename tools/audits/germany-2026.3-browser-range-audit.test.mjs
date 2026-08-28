import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeBrowserRangeAudit } from "./germany-2026.3-browser-range-audit.mjs";

test("legt den Elternordner eines neuen v2-Auditpfads an und überschreibt keinen vorhandenen Beleg", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-browser-audit-writer-"));
  try {
    const output = join(root, "fresh", "nested", "browser-audit-v2.json");
    const audit = {
      schema: "zugfolge-germany-browser-range-audit/v2",
      releaseId: "infra-deutschland-2026.3",
      passed: true,
    };
    const written = await writeBrowserRangeAudit(audit, output);
    assert.equal(written.outputPath, output);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), audit);
    await assert.rejects(
      writeBrowserRangeAudit(audit, output),
      (error) => error?.code === "EEXIST",
      "Ein vorhandener Auditbeleg muss unverändert erhalten bleiben.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
