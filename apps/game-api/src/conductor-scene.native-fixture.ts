/** Explicit fictional scene metadata, bound to the unchanged native session fixture infrastructure. */
import { conductorSceneRuntimeFromAddon, loadConductorSceneRuntime, type ConductorSceneReleaseV1 } from "@zugfolge/runtime-native";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callInteriorFixtureRust } from "./conductor-interior.native-fixture.js";
import { loadConductorSceneDeployment } from "./conductor-scene-configuration.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
interface Infra {
  id: string;
  routeVersions: Record<string, { id: string; templateId: string; legs: { edgeId: string; direction: "along" | "against"; edgeEntryMm: number; edgeExitMm: number; routeStartMm: number }[] }>;
  platformIntervals: Record<string, { edgeId: string; direction: "along" | "against"; fromMm: number; toMm: number }>;
  interlockingRoutes: Record<string, { routeTemplateId: string; signalId: string; authorityStartRouteMm: number; movementKind: string }>;
}
export async function conductorSceneNativeFixture(input: {
  directory: string; worldId: string; periodId: string; regionId: string; infrastructure: unknown; infrastructureStateHash: string;
  routeVersionId: string; stops: readonly { stationId: string; platformId: string }[];
  artReleaseId: string; artManifestHash: string; epochUtcTimeOfDayMs?: number;
}) {
  const infrastructure = input.infrastructure as Infra, route = infrastructure.routeVersions[input.routeVersionId]!;
  const final = route.legs.at(-1)!, lengthMm = final.routeStartMm + Math.abs(final.edgeExitMm - final.edgeEntryMm);
  const sourceId = "explicit-fictional-session-scene";
  const descriptions = [
    { name: "Kleiner Prüfhaltepunkt Ährenfeld", kind: "halt" as const, category: 7 },
    { name: "Mittlerer Prüfbahnhof mit langem Namen Süd", kind: "station" as const, category: 4 },
    { name: "Großer Prüfstadt-Hauptbahnhof Süd", kind: "station" as const, category: 1 },
  ];
  if (input.stops.length !== descriptions.length) throw new Error("The bounded native scene fixture requires its three actual stops.");
  const routeStations = input.stops.map((stop) => {
    const platform = infrastructure.platformIntervals[stop.platformId]!;
    const parts = route.legs.filter((leg) => leg.edgeId === platform.edgeId && leg.direction === platform.direction).flatMap((leg) => {
      const low = Math.max(platform.fromMm, Math.min(leg.edgeEntryMm, leg.edgeExitMm));
      const high = Math.min(platform.toMm, Math.max(leg.edgeEntryMm, leg.edgeExitMm));
      if (low >= high) return [];
      return [{ from: leg.routeStartMm + (leg.direction === "along" ? low - leg.edgeEntryMm : leg.edgeEntryMm - high),
        until: leg.routeStartMm + (leg.direction === "along" ? high - leg.edgeEntryMm : leg.edgeEntryMm - low) }];
    }).sort((a, b) => a.from - b.from);
    if (!parts.length || parts.some((part, index) => index > 0 && parts[index - 1]!.until !== part.from)) throw new Error("Actual platform coverage is disconnected.");
    return { operatingPointId: stop.stationId, platformId: stop.platformId, platformLabel: "1 · Prüfgleis",
      fromRouteMm: parts[0]!.from, toRouteMm: parts.at(-1)!.until };
  });
  const scene: ConductorSceneReleaseV1 = { schemaVersion: "conductor-scene-release/v1", releaseId: "scene:explicit-session-fixture-v1",
    infraReleaseId: infrastructure.id, infraReleaseHash: input.infrastructureStateHash, policyId: "conductor-scenes/v1", coverage: "test-fixture",
    sources: [{ sourceId, sourceSha256: sha(JSON.stringify({ descriptions, source: "Authored fictional scene metadata for native integration only" })),
      rightsEvidenceSha256: sha("Explicit owned test descriptions; no real station classification or settlement measurement is claimed."), provenance: "observed" }],
    stations: input.stops.map((stop, index) => ({ operatingPointId: stop.stationId, ...descriptions[index]!, categorySourceId: sourceId,
      platformCount: 1, dailyCalls: null, sourceIds: [sourceId] })),
    routes: [{ routeVersionId: route.id, lengthMm, sourceIds: [sourceId],
      urbanity: [{ routeMm: 0, urbanityBasisPoints: 0 }, { routeMm: Math.floor(lengthMm / 2), urbanityBasisPoints: 5000 }, { routeMm: lengthMm, urbanityBasisPoints: 10000 }],
      stations: routeStations,
      signals: Object.values(infrastructure.interlockingRoutes).filter((locking) => locking.routeTemplateId === route.templateId && locking.movementKind === "train")
        .map((locking) => ({ signalId: locking.signalId, routeMm: locking.authorityStartRouteMm })) }],
    calendar: { epochUtcTimeOfDayMs: input.epochUtcTimeOfDayMs ?? 43_200_000,
      offsets: [{ fromMs: 0, untilMs: 86_400_000, utcOffsetMinutes: 0 }] } };
  const addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"];
  const sceneBinary = process.env["ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY"] ?? join(dirname(process.env["ZUGFOLGE_SESSION_TEST_BINARY"]
    ?? resolve(ROOT, "target/debug/examples/session_json")), `scene_json${process.platform === "win32" ? ".exe" : ""}`);
  const runtime = addonPath ? loadConductorSceneRuntime() : conductorSceneRuntimeFromAddon({
    projectConductorScene: (json) => {
      const result = callInteriorFixtureRust(sceneBinary, [], JSON.parse(json)).trim();
      const decoded = JSON.parse(result) as { error?: string };
      if (typeof decoded.error === "string") throw new Error(decoded.error);
      return result;
    },
    hashConductorSceneRelease: (json) => (JSON.parse(callInteriorFixtureRust(sceneBinary, ["hash-release"], JSON.parse(json))) as { sceneReleaseHash: string }).sceneReleaseHash,
  });
  const validation = addonPath ? (createRequire(import.meta.url)(addonPath) as { validateConductorSceneInfrastructure(input: string): string })
    .validateConductorSceneInfrastructure(JSON.stringify([scene, infrastructure])) : callInteriorFixtureRust(sceneBinary, ["validate-infrastructure"], [scene, infrastructure]);
  if ((JSON.parse(validation) as { valid?: boolean }).valid !== true) throw new Error("Native scene/infrastructure binding failed.");
  const scenePath = join(input.directory, "conductor-scene-fixture.json"), sceneBytes = `${JSON.stringify(scene)}\n`;
  await writeFile(scenePath, sceneBytes);
  const sceneReleaseHash = runtime.releaseHash(scene);
  const document = { schemaVersion: "conductor-scene-deployment/v1", worldId: input.worldId,
    periods: [{ periodId: input.periodId, validFromMs: 0, validUntilMs: 86_400_000, artReleaseId: input.artReleaseId, artManifestHash: input.artManifestHash,
      regions: [{ regionId: input.regionId, infraReleaseId: infrastructure.id, infraReleaseHash: input.infrastructureStateHash,
        sceneReleasePath: scenePath, sceneFileSha256: sha(sceneBytes), sceneReleaseHash }] }] };
  const path = join(input.directory, "conductor-scene-deployment.json"), bytes = `${JSON.stringify(document)}\n`; await writeFile(path, bytes);
  const deployment = await loadConductorSceneDeployment({ path, expectedSha256: sha(bytes), worldId: input.worldId, runtime, allowTestFixtures: true });
  return { runtime, deployment, sceneReleaseHash, source: "Explicit fictional station/urbanity metadata; native validation against the actual original infrastructure" };
}
