import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectConductorSceneInputV1 } from "@zugfolge/runtime-native";
import { loadConductorSceneDeployment } from "./conductor-scene-configuration.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
async function prepare() {
  const fixture = JSON.parse(await readFile(new URL("../../../packages/runtime-native/src/fixtures/conductor-scenes-v1.json", import.meta.url), "utf8")) as { initial: { input: ProjectConductorSceneInputV1 } };
  const frame = fixture.initial.input;
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-scene-deployment-")); roots.push(directory);
  const sceneReleasePath = join(directory, "scene.json"), path = join(directory, "deployment.json");
  const sceneBytes = `${JSON.stringify(frame.sceneRelease)}\n`;
  await writeFile(sceneReleasePath, sceneBytes);
  const region = { regionId: frame.binding.regionId, infraReleaseId: frame.binding.infraReleaseId, infraReleaseHash: frame.binding.infraReleaseHash,
    sceneReleasePath, sceneFileSha256: sha(sceneBytes), sceneReleaseHash: frame.binding.sceneReleaseHash };
  const period = { periodId: frame.binding.periodId, validFromMs: 0, validUntilMs: 10000,
    artReleaseId: frame.binding.artReleaseId, artManifestHash: frame.binding.artManifestHash, regions: [region] };
  const deployment = { schemaVersion: "conductor-scene-deployment/v1", worldId: frame.binding.worldId, periods: [period] };
  async function save() { const bytes = `${JSON.stringify(deployment)}\n`; await writeFile(path, bytes); return sha(bytes); }
  const input = { path, expectedSha256: await save(), worldId: deployment.worldId, allowTestFixtures: true as const,
    runtime: { releaseHash: () => frame.binding.sceneReleaseHash } };
  return { directory, sceneReleasePath, deployment, region, period, frame, input, save };
}

describe("pinned conductor scene deployment", () => {
  it("matches the original world, period, region and infra pins in a half-open interval, without exposing mutable state", async () => {
    const test = await prepare(), { frame } = test;
    const loaded = await loadConductorSceneDeployment(test.input);
    const args = [frame.binding.worldId, frame.binding.periodId, frame.binding.regionId, 1, frame.binding.infraReleaseId, frame.binding.infraReleaseHash] as const;
    expect(loaded.period(...args)?.sceneRelease).toEqual(frame.sceneRelease);
    expect(loaded.period(...args)).not.toBe(loaded.period(...args));
    for (let index = 0; index < args.length; index++) {
      const changed = [...args]; Reflect.set(changed, index, typeof changed[index] === "number" ? 10000 : "other");
      expect(loaded.period(...changed as unknown as typeof args)).toBeUndefined();
    }
    expect(loaded.period(args[0], args[1], args[2], 0, args[4], args[5])).toBeDefined();
  });

  it("rejects test coverage by default and denies tampered bytes, hash pins, overlaps and foreign releases", async () => {
    const test = await prepare();
    const { allowTestFixtures: _explicitTestOption, ...production } = test.input;
    await expect(loadConductorSceneDeployment(production)).rejects.toThrow("Szenendeployment");
    for (const changed of [{ ...test.input, worldId: "other-world" }, { ...test.input, expectedSha256: "0".repeat(64) },
      { ...test.input, runtime: { releaseHash: () => "e".repeat(64) } }]) await expect(loadConductorSceneDeployment(changed)).rejects.toThrow("Szenendeployment");
    test.region.infraReleaseHash = "f".repeat(64);
    await expect(loadConductorSceneDeployment({ ...test.input, expectedSha256: await test.save() })).rejects.toThrow("Szenendeployment");
    test.region.infraReleaseHash = test.frame.binding.infraReleaseHash;
    test.deployment.periods.push({ ...test.period, periodId: "overlapping-period" });
    await expect(loadConductorSceneDeployment({ ...test.input, expectedSha256: await test.save() })).rejects.toThrow("Szenendeployment");
    test.deployment.periods.pop();
    const expectedSha256 = await test.save();
    await writeFile(test.sceneReleasePath, "private tampered source path");
    await expect(loadConductorSceneDeployment({ ...test.input, expectedSha256 })).rejects.toThrow("Szenendeployment");
  });

  it("blocks missing files and symlink ancestors without leaking local paths", async () => {
    const test = await prepare();
    const linked = join(test.directory, "linked");
    const target = await mkdtemp(join(tmpdir(), "zugfolge-scene-link-target-")); roots.push(target);
    await writeFile(join(target, "scene.json"), await readFile(test.sceneReleasePath));
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    for (const sceneReleasePath of [join(test.directory, "missing-secret.json"), join(linked, "scene.json")]) {
      test.region.sceneReleasePath = sceneReleasePath;
      try { await loadConductorSceneDeployment({ ...test.input, expectedSha256: await test.save() }); throw new Error("expected failure"); }
      catch (error) { expect(String(error)).toContain("Szenendeployment"); expect(String(error)).not.toContain(test.directory); }
    }
  });
});
