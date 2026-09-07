/** Explizit fiktive Tarif-/Prüfregeln, tatsächliche M5-/M10-/Sitzungs-/Ledgerproduzenten. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { DialogueEvidenceV1, FareControlPolicyV1 } from "@zugfolge/runtime-native";
import { buildEconomyRelease, persistEconomyTransition, startEconomyWorld, type EconomyRelease, type EconomyWorldState, type FareInspectionEconomyV1 } from "@zugfolge/economy";
import { controlJson, controlRecord, fareControlRuntimeFromAddon, loadFareControlRuntime, type FareControlRuntime } from "./conductor-control-runtime.js";
import { createConductorControlIntegration, type ConductorControlService } from "./conductor-control.js";
import { parseConductorControlDeployment } from "./conductor-control-configuration.js";
import { createConductorPoliceAdapter } from "./conductor-police.js";
import { loadConductorContext } from "./conductor-context.js";
import { createConductorSessionNativeFixture, hasSessionNativeFixture } from "./conductor-session.native-fixture.js";
import { callInteriorFixtureRust } from "./conductor-interior.native-fixture.js";
import { advanceConductorControlWorld } from "./conductor-session-scheduler.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const fareControlBinary = process.env["ZUGFOLGE_FARE_CONTROL_TEST_BINARY"] ?? resolve(ROOT, `target/debug/examples/fare_control_json${process.platform === "win32" ? ".exe" : ""}`);
export const hasFareControlNative = hasSessionNativeFixture && (process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined || existsSync(fareControlBinary));
export function fareControlFixtureRuntime(): FareControlRuntime {
  if (process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] !== undefined) return loadFareControlRuntime();
  const methods = { initializeFareControl: "initialize", applyFareControl: "apply", restoreFareControl: "restore", projectFareCases: "project", projectFareControlReport: "report",
    hashFareInspectionPolicy: "policy-hash", hashFareJourneyEvidence: "journey-hash", hashPoliceResponseModel: "model-hash",
    duePoliceResponse: "police-due", nextFareControlWakeup: "next-wakeup" };
  return fareControlRuntimeFromAddon(Object.fromEntries(Object.entries(methods).map(([name, operation]) => [name,
    (json: string) => callInteriorFixtureRust(fareControlBinary, [operation], JSON.parse(json))])));
}
export function fareControlFixtureEconomy(overrides: Partial<FareInspectionEconomyV1> = {}): EconomyRelease {
  const source = JSON.parse(readFileSync(resolve(ROOT, "crates/zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3.json"), "utf8"),
    (_key, value: unknown) => typeof value === "string" && /^-?[0-9]+$/u.test(value) ? BigInt(value) : value).economy.release as EconomyRelease;
  return buildEconomyRelease({ ...source, fareInspection: { schemaVersion: "fare-inspection-economy/v1", minimumClaimCents: 6000n,
    ordinaryFareMultiplier: 2, reducedClaimCents: 700n, proofWindowDays: 7, dayLengthMs: 86_400_000, handlingCostCents: 100n,
    proofHandlingCostCents: 250n, policeHandlingCostCents: 300n, fullPaymentBasisPoints: 10_000, partialPaymentBasisPoints: 0,
    partialPaymentShareBasisPoints: 5000, paymentDelayMs: 10_000, writeOffDelayMs: 30_000, validProofSubmissionBasisPoints: 10_000,
    validProofDelayMs: 20_000, premiumMultiplierBasisPoints: 40_000, positiveDailyCapBasisPoints: 50,
    revenueAllocation: "uniform_settled_service_interval/v1", ...overrides } });
}
export interface FareControlNativeFixtureOptions {
  readonly identityRefusalBasisPoints?: number;
  readonly invalidDocumentPresentedBasisPoints?: number;
  readonly demandSeed?: string;
  readonly policeResponseMs?: number;
  readonly policeMaxWaitMs?: number;
  readonly sessionFixture?: Omit<NonNullable<Parameters<typeof createConductorSessionNativeFixture>[1]>, "demandSeed">;
  readonly economyFixture?: (state: EconomyWorldState, operatorId: string,
    fixture: Awaited<ReturnType<typeof createConductorSessionNativeFixture>>) => EconomyWorldState;
}
export async function createFareControlNativeFixture(options: FareControlNativeFixtureOptions = {}) {
  let control: ConductorControlService | undefined;
  const fixture = await createConductorSessionNativeFixture({
    async apply(...args) { if (control === undefined) throw new Error("Kontrolladapter ist noch nicht initialisiert."); return control.apply(...args); },
    async evidence(...args) { if (control === undefined) throw new Error("Kontrolladapter ist noch nicht initialisiert."); return control.evidence(...args); },
    async closeSession(...args) { if (control?.closeSession === undefined) throw new Error("Kontrolladapter ist noch nicht initialisiert."); return control.closeSession(...args); },
    async publicHistory(...args) { if (control === undefined) throw new Error("Kontrolladapter ist noch nicht initialisiert."); return control.publicHistory(...args); },
    async publicStatus(...args) { if (control === undefined) throw new Error("Kontrolladapter ist noch nicht initialisiert."); return control.publicStatus(...args); },
  }, { ...options.sessionFixture, ...(options.demandSeed === undefined ? {} : { demandSeed: options.demandSeed }) });
  try {
    const runtime = fareControlFixtureRuntime(), economy = fareControlFixtureEconomy(), { worldId, operatorId, trainRunId } = fixture.access;
    const started = startEconomyWorld({ worldId, seed: 71n, durationMonths: 6, release: economy,
      lots: Array.from({ length: 8 }, (_, index) => ({ id: `explicit-test-lot-${index}`, size: 100, attractiveness: 100 })), authorityBudgets: [], accounts: [] });
    const economyState = options.economyFixture?.(started.state, operatorId, fixture) ?? started.state;
    await persistEconomyTransition(fixture.db, { ...started, state: economyState, expectedRevision: null, committedAt: new Date(fixture.clock.nowMs), enqueuedAt: new Date(fixture.clock.nowMs) });
    const context = await loadConductorContext(fixture.db, fixture.access, fixture.dependencies), periodId = context.period.periodId;
    const policy = { schemaVersion: "fare-inspection-policy/v1", policyId: "explicit-test-inspection", worldId, periodId, contentHash: "",
      invalidDocumentPresentedBasisPoints: options.invalidDocumentPresentedBasisPoints ?? 0, identityRefusalBasisPoints: options.identityRefusalBasisPoints ?? 0, concreteDangerBasisPoints: 0 };
    policy.contentHash = runtime.policyHash(policy);
    const model = { schemaVersion: "police-response-model/v1", modelId: "explicit-test-police", worldId, contentHash: "",
      availableBasisPoints: 10_000, delayedBasisPoints: 0, responseMs: options.policeResponseMs ?? 1000,
      delayedResponseMs: (options.policeResponseMs ?? 1000) + 1000, identitySuccessBasisPoints: 10_000 };
    model.contentHash = runtime.modelHash(model);
    const stopPlan = controlRecord(controlRecord(controlRecord(context.operationalWorld["trains"])[trainRunId])["passengerStops"]);
    const stops = controlRecord(stopPlan["plan"])["stops"] as unknown[];
    const holdPolicy: FareControlPolicyV1 = { schema: "zugfolge-fare-control-policy/v1", policyId: "explicit-test-police-hold", revision: 1,
      worldId, schedulePeriodId: periodId, contentHash: "", maxPoliceHoldsPerTrainRun: 1,
      eligibleReasons: ["identity_refusal", "concrete_danger"], targetRule: "next_unreached_scheduled_passenger_stop",
      providerByStopId: Object.fromEntries(stops.map(controlRecord).map((stop) => [String(stop["stopId"]), "explicit-test-authority"])),
      maxWaitMs: options.policeMaxWaitMs ?? 60_000, policeResponseModelId: model.modelId, policeResponseModelHash: model.contentHash, publicCause: "authority.police.fare-control" };
    if (fixture.native.operational.fareControlPolicyHash === undefined) throw new Error("Echter nativer Haltepolicyhash fehlt.");
    const pinnedHoldPolicy = { ...holdPolicy, contentHash: fixture.native.operational.fareControlPolicyHash(holdPolicy) };
    await fixture.apply("control-fixture:install-hold-policy", { type: "set-fare-control-policy", policy: pinnedHoldPolicy }); await fixture.refresh();
    const journeys = new Map<string, Record<string, unknown>>();
    for (const value of context.projectionInput.evaluation["manifests"] as unknown[]) {
      const manifest = controlRecord(value); if (manifest["trainRunId"] !== trainRunId) continue;
      for (const source of manifest["passengers"] as unknown[]) {
        const passenger = controlRecord(source), key = `${passenger["boardingStopId"]}:${passenger["alightingStopId"]}`;
        const journey = { schemaVersion: "fare-journey-evidence/v1", evidenceId: `explicit-test:${key}`, worldId, periodId, trainRunId,
          boardingStopId: passenger["boardingStopId"], alightingStopId: passenger["alightingStopId"], ordinaryFareCents: "1250",
          ticketOffice: "available", ticketMachine: "unknown", sourceId: "explicit-fictional-game-tariff-not-real-world-fare", contentHash: "" };
        journey.contentHash = runtime.journeyHash(journey); journeys.set(key, journey);
      }
    }
    const bytes = Buffer.from(controlJson({ schemaVersion: "conductor-control-deployment/v1", worldId, periods: [{ periodId,
      validFromMs: 0, validUntilMs: 86_400_000, economyReleaseHash: economy.checksum, inspectionPolicy: policy, policeResponseModel: model, journeys: [...journeys.values()] }] }));
    const releases = parseConductorControlDeployment({ bytes, expectedSha256: createHash("sha256").update(bytes).digest("hex"), worldId, runtime });
    const police = createConductorPoliceAdapter({ runtime: fixture.native.operational, regionBindings: fixture.dependencies.regionBindings, controlRuntime: runtime });
    control = createConductorControlIntegration({ runtime, releases, police });
    return { ...fixture, control, controlRuntime: runtime, controlReleases: releases, controlDeploymentBytes: bytes, economy,
      controlContext: () => loadConductorContext(fixture.db, fixture.access, fixture.dependencies), operatorId,
      async originalDialogueCandidates(options: { fareFacts?: readonly string[] } = {}) {
        // Isolierte Auswahl aus demselben Originalmanifest. Keine Speicherung,
        // keine Text-/Faktenänderung und keine Übertragung an Spielerantworten.
        const actual = await loadConductorContext(fixture.db, fixture.access, fixture.dependencies);
        const projected = fixture.runtimes.interior.project(actual.projectionInput);
        const onboard = new Set(projected.passengers.filter((row) => row.activity === "onboard").map((row) => row.passengerKey));
        const manifest = (actual.projectionInput.evaluation["manifests"] as unknown[]).map(controlRecord)
          .find((row) => row["trainRunId"] === trainRunId && row["segmentId"] === projected.segmentId);
        if (manifest === undefined) throw new Error("Der originale M10-Fahrgastbeleg fehlt.");
        const dialogue = fixture.dependencies.sessionReleases.resolve(worldId, periodId)!;
        const source = controlRecord(dialogue.dialogueReleases[0]);
        const trees = (source["families"] as unknown[]).map(controlRecord).flatMap((family) => (family["trees"] as unknown[]).map(controlRecord));
        const path = process.env["ZUGFOLGE_DIALOGUE_TEST_BINARY"] ?? resolve(ROOT, `target/debug/examples/dialogue_json${process.platform === "win32" ? ".exe" : ""}`);
        return (manifest["passengers"] as unknown[]).map(controlRecord).filter((row) => onboard.has(String(row["passengerKey"]))
          && (options.fareFacts === undefined || options.fareFacts.includes(String(row["fareFact"])))).map((passenger) => {
          const result = JSON.parse(callInteriorFixtureRust(path, ["start"], { release: source, input: {
            worldId, periodId, trainRunId, passengerKey: passenger["passengerKey"], encounterId: "original-dialogue-selection-probe", nowMs: actual.nowMs,
            releaseHash: dialogue.currentDialogueReleaseHash, seed: actual.projectionInput.binding.seedHash, fareFact: passenger["fareFact"],
            evidence: { documentStatus: "unchecked", acquisitionException: "unknown", identityStatus: "unknown", concreteDanger: false },
          } }));
          const tree = trees.find((row) => row["treeId"] === result.state.treeId);
          if (tree === undefined) throw new Error("Der nativ gewählte Originaldialog fehlt im gepinnten Release.");
          return { passengerKey: String(passenger["passengerKey"]), fareFact: String(passenger["fareFact"]),
            alightingStopId: String(passenger["alightingStopId"]), treeId: String(tree["treeId"]),
            presentation: String(tree["presentation"]), tone: String(tree["tone"]), cooperation: String(tree["cooperation"]),
            passengerText: String(result.encounter.passengerText) };
        });
      },
      async candidateDialogue(passengerKey: string) {
        // Nur Node-seitige Auswahlhilfe: derselbe native Resolver und derselbe
        // ursprüngliche M10-Seed wie beim späteren tatsächlichen Erstkontakt.
        const actual = await loadConductorContext(fixture.db, fixture.access, fixture.dependencies);
        const projected = fixture.runtimes.interior.project(actual.projectionInput);
        if (!projected.passengers.some((person) => person.passengerKey === passengerKey && person.activity === "onboard")) throw new Error("Der Fahrgast ist nicht tatsächlich an Bord.");
        const manifest = (actual.projectionInput.evaluation["manifests"] as unknown[]).map(controlRecord)
          .find((row) => row["trainRunId"] === trainRunId && row["segmentId"] === projected.segmentId);
        const passenger = (manifest?.["passengers"] as unknown[]).map(controlRecord).find((row) => row["passengerKey"] === passengerKey);
        if (passenger === undefined) throw new Error("Der native Fahrgastbeleg fehlt.");
        const dialogue = fixture.dependencies.sessionReleases.resolve(worldId, periodId)!;
        const path = process.env["ZUGFOLGE_DIALOGUE_TEST_BINARY"] ?? resolve(ROOT, `target/debug/examples/dialogue_json${process.platform === "win32" ? ".exe" : ""}`);
        const result = JSON.parse(callInteriorFixtureRust(path, ["start"], { release: dialogue.dialogueReleases[0], input: {
          worldId, periodId, trainRunId, passengerKey, encounterId: "native-dialogue-selection-probe", nowMs: actual.nowMs,
          releaseHash: dialogue.currentDialogueReleaseHash, seed: actual.projectionInput.binding.seedHash, fareFact: passenger["fareFact"],
          evidence: { documentStatus: "unchecked", acquisitionException: "unknown", identityStatus: "unknown", concreteDanger: false },
        } }));
        return { treeId: String(result.state.treeId), passengerText: String(result.encounter.passengerText) };
      },
      async inspectionCandidates(options: { all?: boolean } = {}) {
        // Ausschließlich Node-Testauswahl: Diese isolierte Native-Probe wird
        // niemals persistiert oder als tatsächlich erfolgte Kontrolle gezählt.
        const actual = await loadConductorContext(fixture.db, fixture.access, fixture.dependencies);
        const projected = fixture.runtimes.interior.project(actual.projectionInput), selected = new Map<string, Record<string, unknown>>();
        const binding = actual.projectionInput.binding;
        const manifests = (actual.projectionInput.evaluation["manifests"] as unknown[]).map(controlRecord);
        const manifest = manifests.find((row) => row["trainRunId"] === trainRunId && row["segmentId"] === projected.segmentId);
        if (manifest === undefined) throw new Error("Die tatsächliche Teilreise fehlt.");
        const release = releases.resolve(worldId, periodId, actual.nowMs)!;
        const visible = new Map(projected.passengers.filter((passenger) => passenger.activity === "onboard").map((passenger) => [passenger.passengerKey, passenger]));
        const passengers = (manifest["passengers"] as unknown[]).map(controlRecord).filter((passenger) => visible.has(String(passenger["passengerKey"])))
          .sort((a, b) => visible.get(String(a["passengerKey"]))!.xMm - visible.get(String(b["passengerKey"]))!.xMm);
        const pins = passengers.map((passenger) => {
          const journey = release.journeys.find((row) => row["trainRunId"] === trainRunId && row["boardingStopId"] === passenger["boardingStopId"] && row["alightingStopId"] === passenger["alightingStopId"]);
          return { worldId, operatorId, periodId, trainRunId, encounterId: "native-selection-probe",
              manifestRevision: binding.manifestRevision, demandStateHash: binding.demandStateHash, segmentId: projected.segmentId, passenger,
              dialogueReleaseHash: fixture.dependencies.sessionReleases.resolve(worldId, periodId)!.currentDialogueReleaseHash,
              inspectedAtMs: actual.nowMs, seedHash: binding.seedHash, inspectionPolicy: release.inspectionPolicy,
              journeyEvidence: journey ?? null, economyRelease: JSON.parse(controlJson(economy)), expectedEconomyReleaseHash: economy.checksum };
        });
        const candidates: { passengerKey: string; fareFact: unknown; evidence: DialogueEvidenceV1 }[] = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"] === undefined
          ? JSON.parse(callInteriorFixtureRust(fareControlBinary, ["inspect-candidates"], pins))
          : pins.map((pin) => {
          const scratch = runtime.initialize(worldId, operatorId, actual.nowMs), caseId = "native-candidate-probe";
          const opened = runtime.apply(scratch, { worldId, operatorId, commandId: "candidate-open", expectedRevision: 0, nowMs: actual.nowMs,
            action: { type: "open_case", caseId, pin } });
          const checked = runtime.apply(opened.state, { worldId, operatorId, commandId: "candidate-check", expectedRevision: opened.state.revision,
            nowMs: actual.nowMs, action: { type: "inspect_document", caseId } });
          return { passengerKey: String(pin.passenger["passengerKey"]), fareFact: pin.passenger["fareFact"], evidence: checked.state.cases[caseId]!.evidence };
        });
        const measured = [];
        for (const candidate of candidates) {
          const passenger = visible.get(candidate.passengerKey)!;
          const target = actual.layout.interactions.find((row) => row.kind === "passenger" && row.targetId === passenger.placeId)!;
          const path = fixture.runtimes.interior.path({ schemaVersion: "conductor-interior-path-input/v1", layout: actual.layout,
            expectedLayoutHash: actual.layout.layoutHash, fromNodeId: actual.layout.entranceNodeId, toNodeId: target.nodeId, wheelchair: false });
          const key = `${candidate.fareFact}:${candidate.evidence.identityStatus}`, previous = selected.get(key);
          const result = { ...candidate, pathLengthMm: path.lengthMm }; measured.push(result);
          if (previous === undefined || path.lengthMm < Number(previous["pathLengthMm"])) selected.set(key, result);
        }
        return options.all === true ? measured : [...selected.values()];
      },
      async advanceControl() {
        await advanceConductorControlWorld({ db: fixture.db, worldId, regions: fixture.dependencies.regionBindings(),
          runtime: fixture.native.operational, control: control! });
      } };
  } catch (error) { await fixture.dispose(); throw error; }
}
