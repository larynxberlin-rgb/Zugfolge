import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("regionaler Server-Startupvertrag", () => {
  it("entfernt eine erst dauerhaft archivierte Welt aus Worker, Scheduler und signierter Baseline", async () => {
    const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
    const handler = source.indexOf("const worldCloseAdminHandler = createWorldCloseAdminHandler(");
    const regionalRelease = source.indexOf("regionalSimulation.releaseWorld(worldId)", handler);
    const deploymentRelease = source.indexOf("deploymentRuntime.releaseWorld(worldId)", handler);
    const baselineRelease = source.indexOf("signedDeployments.delete(worldId)", handler);

    expect(handler).toBeGreaterThan(-1);
    expect(regionalRelease).toBeGreaterThan(handler);
    expect(deploymentRelease).toBeGreaterThan(regionalRelease);
    expect(baselineRelease).toBeGreaterThan(deploymentRelease);
  });

  it("startet oder restauriert signierte Welten vor der einzigen Runtime-Revalidierung", async () => {
    const serverSource = await readFile(new URL("./server.ts", import.meta.url), "utf8");
    const legacyHotGate = serverSource.indexOf("await assertNoLegacyHotInfrastructureChanges(");
    const worldStart = serverSource.indexOf("await startSignedAlphaWorld(");
    const reconciliation = serverSource.indexOf("await reconcileActiveWorldInfrastructureRuntimes(");
    const appConstruction = serverSource.indexOf("const app = buildApp(");

    expect(legacyHotGate).toBeGreaterThan(-1);
    expect(worldStart).toBeGreaterThan(legacyHotGate);
    expect(worldStart).toBeGreaterThan(-1);
    expect(reconciliation).toBeGreaterThan(worldStart);
    expect(appConstruction).toBeGreaterThan(reconciliation);
    expect(serverSource.indexOf("await reconcileActiveWorldInfrastructureRuntimes(", reconciliation + 1))
      .toBe(-1);
    expect(serverSource).not.toContain("await regionalSimulation.restore(");

    const startPortSource = await readFile(new URL("./alpha-world-start.ts", import.meta.url), "utf8");
    const bootstrapHelper = startPortSource.indexOf("export async function initializeOrRestoreRegionalSimulation(");
    const initialize = startPortSource.indexOf("await worker.initialize(", bootstrapHelper);
    const restore = startPortSource.indexOf("await worker.restore(", bootstrapHelper);
    const regionalStart = startPortSource.indexOf("async initializeRegionalSimulation(");
    const persistedLookup = startPortSource.indexOf("from(regionalSimulationStates)", regionalStart);
    const bootstrapCall = startPortSource.indexOf("await initializeOrRestoreRegionalSimulation(", regionalStart);
    const verification = startPortSource.indexOf("async verify(", regionalStart);

    expect(bootstrapHelper).toBeGreaterThan(-1);
    expect(initialize).toBeGreaterThan(bootstrapHelper);
    expect(restore).toBeGreaterThan(initialize);
    expect(regionalStart).toBeGreaterThan(restore);
    expect(persistedLookup).toBeGreaterThan(regionalStart);
    expect(bootstrapCall).toBeGreaterThan(persistedLookup);
    expect(verification).toBeGreaterThan(bootstrapCall);
  });

  it("validiert statische Archivpfade und entfernt sie vor jeder aktiven Runtime-Registrierung", async () => {
    const serverSource = await readFile(new URL("./server.ts", import.meta.url), "utf8");
    // Dieser Guard prueft ausschliesslich die Startupreihenfolge. Die Semantik
    // der Weltgrenze wird mit echten Datenbank-/HTTP-Regressionen geprueft.
    // Argumentnamen, Formatierung und die Implementierung der Grenze gehoeren
    // nicht zum Ordnungsvertrag.
    const position = (pattern: RegExp, after = 0): number => {
      const match = pattern.exec(serverSource.slice(Math.max(0, after)));
      return match === null ? -1 : Math.max(0, after) + match.index;
    };
    const resolution = position(/\bawait\s+resolveAlphaWorldStartupDeployments\s*\(/u);
    const archivedLoop = position(/\bfor\s*\([^)]*\bof\s+archivedWorldIds\s*\)/u, resolution);
    const archivedRelease = position(/\bdeploymentRuntime\s*\.\s*releaseWorld\s*\(/u, archivedLoop);
    const activeLoop = position(/\bfor\s*\([^)]*\bof\s+persistedActiveDeployments\s*\)/u, archivedRelease);
    const serverWorldGate = position(/\bassertServerWorldDeployment\s*\(/u, activeLoop);
    const activeRegistration = position(/\bdeploymentRuntime\s*\.\s*register\s*\(/u, activeLoop);
    const fleetGate = position(/\bdeploymentRuntime\s*\.\s*assertVehicleCatalogDeploymentBindings\s*\(/u, activeRegistration);

    expect(resolution).toBeGreaterThan(-1);
    expect(archivedLoop).toBeGreaterThan(resolution);
    expect(archivedRelease).toBeGreaterThan(archivedLoop);
    expect(activeLoop).toBeGreaterThan(archivedRelease);
    expect(serverWorldGate).toBeGreaterThan(activeLoop);
    expect(activeRegistration).toBeGreaterThan(serverWorldGate);
    expect(fleetGate).toBeGreaterThan(activeRegistration);

    const startSource = await readFile(new URL("./alpha-world-start.ts", import.meta.url), "utf8");
    const archivedBranch = startSource.indexOf('if (world.lifecycleStatus === "archived")');
    const exactHeadGate = startSource.indexOf("await assertArchivedAlphaWorldDeploymentHead(", archivedBranch);
    const activeMapRemoval = startSource.indexOf("signedDeployments.delete(worldId)", exactHeadGate);
    const skip = startSource.indexOf("continue;", activeMapRemoval);

    expect(archivedBranch).toBeGreaterThan(-1);
    expect(exactHeadGate).toBeGreaterThan(archivedBranch);
    expect(activeMapRemoval).toBeGreaterThan(exactHeadGate);
    expect(skip).toBeGreaterThan(activeMapRemoval);
  });

  it("oeffnet Liveness vor dem Cold-Catch-up und fenced bis zu dessen Abschluss alle Fachrouten", async () => {
    const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
    const listener = source.lastIndexOf("await app.listen(");
    const catchUp = source.lastIndexOf("runRegionalAdvance();");

    expect(listener).toBeGreaterThan(-1);
    expect(catchUp).toBeGreaterThan(listener);
    expect(source).not.toContain("await regionalAdvanceCoordinator.run(");
    expect(source).toContain("regionalSimulationStartupRouteAllowed(request.url)");
    expect(source).toContain("regionalSimulationStartupReady = true");
  });
});
