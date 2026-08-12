import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildReleaseArtifactInventory } from "./release-artifacts.mjs";

test("inventarisiert Releaseartefakte bytegenau und stabil sortiert", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-artifacts-"));
  await Promise.all([writeFile(join(root, "a.bin"), "a"), writeFile(join(root, "b.bin"), "bb")]);
  const result = await buildReleaseArtifactInventory({
    schema: "zugfolge-infra-release-artifact-spec/v1",
    artifacts: [
      { id: "zwei", kind: "second", sourceFile: "b.bin", file: "b.bin" },
      { id: "eins", kind: "first", sourceFile: "a.bin", file: "a.bin" },
    ],
  }, root);
  assert.deepEqual(result.artifacts.map(({ id, bytes }) => [id, bytes]), [["eins", 1], ["zwei", 2]]);
  assert.equal(result.artifacts[0].sha256, "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
});
