import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { conductorSceneRuntimeFromAddon, ConductorSceneError, loadConductorSceneRuntime, parseConductorSceneRelease, parseSceneProjection } from "./scenes.js";
import type { ProjectConductorSceneInputV1, SceneProjectionV1 } from "./scene-types.js";

type Frame = { input: ProjectConductorSceneInputV1; output: SceneProjectionV1 };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/conductor-scenes-v1.json", import.meta.url), "utf8")) as {
  initial: Frame; moving: Frame; restored: Frame;
};
function runtime(output: unknown = fixture.initial.output) {
  return conductorSceneRuntimeFromAddon({ projectConductorScene: () => JSON.stringify(output),
    hashConductorSceneRelease: () => fixture.initial.input.binding.sceneReleaseHash });
}
function rehash(value: Record<string, unknown>): unknown {
  value["stateHash"] = createHash("sha256").update(JSON.stringify({ ...value, stateHash: "" })).digest("hex");
  return value;
}

describe("authoritative scene transport", () => {
  it("accepts genuine Rust standing, moving and restored snapshots without changing source fields", () => {
    for (const frame of [fixture.initial, fixture.moving, fixture.restored]) {
      expect(runtime(frame.output).project(frame.input)).toEqual(frame.output);
      expect(parseConductorSceneRelease(frame.input.sceneRelease)).toEqual(frame.input.sceneRelease);
    }
    expect(fixture.moving.output).toEqual(fixture.restored.output);
    expect(fixture.moving.output.motionState).toBe("moving");
  });

  it("rejects private fields, unchecked source additions, byte changes and invalid blend arithmetic", () => {
    const base = structuredClone(fixture.initial.output);
    const cases = [
      { ...base, fareFact: "private" },
      { ...base, station: { ...base.station, accountId: "private" } },
      { ...base, routeMm: base.routeMm + 1 },
      rehash({ ...base, environment: { ...base.environment, ruralBasisPoints: 8000, suburbanBasisPoints: 8000 } }),
      rehash({ ...base, lighting: { ...base.lighting, windowLightBasisPoints: 1234 } }),
      rehash({ ...base, speedMmps: Number.MAX_SAFE_INTEGER }),
    ];
    for (const changed of cases) expect(() => parseSceneProjection(changed)).toThrow(ConductorSceneError);
    expect(() => parseConductorSceneRelease({ ...fixture.initial.input.sceneRelease, worldId: "client-world" })).toThrow(ConductorSceneError);
  });

  it("rejects even internally rehashed results from another binding, route or sample time", () => {
    const base = structuredClone(fixture.initial.output);
    for (const key of Object.keys(base.binding)) {
      const old = Reflect.get(base.binding, key) as unknown;
      const next = typeof old === "number" ? old + 1 : ["operationalStateHash", "sceneReleaseHash", "infraReleaseHash", "artManifestHash"].includes(key) ? "e".repeat(64) : `${old}:other`;
      const changed = rehash({ ...base, binding: { ...base.binding, [key]: next } });
      expect(() => runtime(changed).project(fixture.initial.input)).toThrow(ConductorSceneError);
    }
    for (const changed of [rehash({ ...base, atMs: base.atMs + 1 }), rehash({ ...base, routeVersionId: "different-route" })])
      expect(() => runtime(changed).project(fixture.initial.input)).toThrow(ConductorSceneError);
  });

  it("does not expose native exception text or accept malformed JSON/hash output", () => {
    for (const message of ["/private/source/customer-data.json", "scene_stale_projection"]) {
      const broken = conductorSceneRuntimeFromAddon({ projectConductorScene: () => { throw new Error(message); }, hashConductorSceneRelease: () => "bad" });
      try { broken.project(fixture.initial.input); throw new Error("expected failure"); }
      catch (error) { expect(error).toBeInstanceOf(ConductorSceneError); expect(String(error)).not.toContain(message); }
      expect(() => broken.releaseHash(fixture.initial.input.sceneRelease)).toThrow(ConductorSceneError);
    }
    const malformed = conductorSceneRuntimeFromAddon({ projectConductorScene: () => "{", hashConductorSceneRelease: () => "bad" });
    expect(() => malformed.project(fixture.initial.input)).toThrow(ConductorSceneError);
  });

  it.skipIf(!process.env["ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY"] && !process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"])("replays the committed engine snapshots through the actual native runtime", () => {
    const binary = process.env["ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY"]!;
    function command(kind: string, input: string): unknown {
      const result = spawnSync(binary, [kind], { input: `${input}\n`, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      expect(result.status).toBe(0);
      const value: unknown = JSON.parse(result.stdout);
      if (value && typeof value === "object" && "error" in value) throw new Error(String(value.error));
      return value;
    }
    const actual = binary ? conductorSceneRuntimeFromAddon({ projectConductorScene: (input) => JSON.stringify(command("project", input)),
      hashConductorSceneRelease: (input) => (command("hash-release", input) as { sceneReleaseHash: string }).sceneReleaseHash }) : loadConductorSceneRuntime();
    for (const frame of [fixture.initial, fixture.moving, fixture.restored]) {
      expect(actual.project(frame.input)).toEqual(frame.output);
      expect(actual.releaseHash(frame.input.sceneRelease)).toBe(frame.input.binding.sceneReleaseHash);
    }
    expect(() => actual.project({ ...fixture.initial.input, binding: { ...fixture.initial.input.binding, worldId: "foreign-world" } })).toThrow(ConductorSceneError);
  });
});
