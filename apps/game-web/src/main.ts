import type { Density } from "@zugfolge/design-system";
import "@zugfolge/design-system/styles.css";
import { mountGlossaryLayer } from "@zugfolge/glossary";
import "@zugfolge/glossary/styles.css";
import type { PlanningProjectionV1 } from "@zugfolge/planning-projection";

import { GameApiClient, type CapacityHeatmapCell, type OnboardingAssistant, type StartPackageGrant, type TutorialJourney } from "./api.js";
import { ensureAccessToken, loadRuntimeConfiguration } from "./auth.js";
import { conflictsForTrain } from "./diagram.js";
import { renderJourney } from "./journey.js";
import { primaryMapDestination } from "./navigation.js";
import { renderLoadState, renderProjection } from "./view.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("App-Wurzel fehlt");
const app = root;
mountGlossaryLayer(document.body);

const parameters = new URLSearchParams(window.location.search);
const runtimeConfiguration = loadRuntimeConfiguration();
const demoMode = parameters.get("demo") === "1";
const requestedView = parameters.get("view");
const journeyMode = !demoMode && requestedView !== "diagram";
const worldId = parameters.get("world") ?? runtimeConfiguration.publicWorldId;
const tutorialWorldId = parameters.get("tutorialWorld") ?? runtimeConfiguration.tutorialWorldId;
const livemapUrl = runtimeConfiguration.livemapUrl === "" ? "" : (() => {
  const value = new URL(runtimeConfiguration.livemapUrl, window.location.href);
  value.searchParams.set("world", worldId);
  return value.href;
})();
const primaryDestination = primaryMapDestination({
  requestedView,
  demoMode,
  livemapUrl: runtimeConfiguration.livemapUrl,
  worldId,
  pageUrl: window.location.href,
});
if (primaryDestination !== undefined) window.location.replace(primaryDestination);
let api: GameApiClient | undefined;

let density: Density = "control";
let showBlockingTimes = true;
let selectedTrainId = "";
let selectedConflictId = "";
let projection: PlanningProjectionV1 | undefined;
let loadError = "";
let message = "";
let messageTone: "status" | "error" = "status";
let applyingAlternativeId = "";
let demoApply: ((current: PlanningProjectionV1, alternativeId: string) => PlanningProjectionV1) | undefined;
let tutorialJourney: TutorialJourney | undefined;
let startPackage: StartPackageGrant | undefined;
let heatmap: readonly CapacityHeatmapCell[] = [];
let onboardingAssistant: OnboardingAssistant | undefined;
let journeyBusy = false;

function explicitDemoUrl(): string {
  const demoParameters = new URLSearchParams(window.location.search);
  demoParameters.set("demo", "1");
  return `?${demoParameters.toString()}`;
}

function chooseInitialSelection(current: PlanningProjectionV1): void {
  selectedTrainId = current.trains[0]?.id ?? "";
  selectedConflictId = conflictsForTrain(current, selectedTrainId)[0]?.id ?? "";
}

function reconcileSelection(current: PlanningProjectionV1): void {
  if (!current.trains.some((train) => train.id === selectedTrainId)) {
    selectedTrainId = current.trains[0]?.id ?? "";
  }
  const available = conflictsForTrain(current, selectedTrainId);
  if (!available.some((conflict) => conflict.id === selectedConflictId)) {
    selectedConflictId = available[0]?.id ?? "";
  }
}

function render(): void {
  app.dataset.density = density;
  if (journeyMode) {
    app.innerHTML = renderJourney({
      tutorialWorldId,
      publicWorldId: worldId,
      tutorial: tutorialJourney,
      grant: startPackage,
      heatmap,
      assistant: onboardingAssistant,
      busy: journeyBusy,
      message,
      messageTone,
      livemapUrl,
    });
    bindJourney();
    return;
  }
  if (projection === undefined) {
    app.innerHTML = renderLoadState(
      loadError === "" ? "loading" : "error",
      loadError === "" ? "Planner-Ergebnis wird geladen …" : loadError,
      loadError === "" ? undefined : explicitDemoUrl(),
    );
    return;
  }
  app.innerHTML = renderProjection(projection, {
    density,
    showBlockingTimes,
    selectedTrainId,
    selectedConflictId,
    message,
    messageTone,
    applyingAlternativeId: applyingAlternativeId === "" ? undefined : applyingAlternativeId,
  });
  bind();
}

function bindJourney(): void {
  app.querySelector("#tutorial-refresh")?.addEventListener("click", () => void refreshTutorial());
  app.querySelector("#tutorial-reset")?.addEventListener("click", () => void resetTutorial());
  app.querySelector("#claim-start-package")?.addEventListener("click", () => void claimStartPackage());
  app.querySelector("#heatmap-refresh")?.addEventListener("click", () => void refreshOnboarding());
}

async function journeyAction(action: () => Promise<void>, success: string): Promise<void> {
  if (journeyBusy) return;
  journeyBusy = true;
  message = "Autoritativer Weltzustand wird aktualisiert …";
  messageTone = "status";
  render();
  try {
    await action();
    message = success;
    messageTone = "status";
  } catch (error) {
    message = error instanceof Error ? error.message : "Spielerreise konnte nicht aktualisiert werden.";
    messageTone = "error";
  } finally {
    journeyBusy = false;
    render();
  }
}

async function refreshTutorial(): Promise<void> {
  const client = api;
  if (client === undefined || tutorialWorldId === "") return;
  return journeyAction(async () => { tutorialJourney = await client.loadTutorial(tutorialWorldId); }, "Tutorialbelege sind aktuell.");
}

async function resetTutorial(): Promise<void> {
  const client = api;
  if (client === undefined || tutorialWorldId === "") return;
  return journeyAction(async () => { tutorialJourney = await client.resetTutorial(tutorialWorldId); }, "Neue Tutorial-Sitzung wurde autoritativ angelegt.");
}

async function refreshOnboarding(): Promise<void> {
  const client = api;
  if (client === undefined || worldId === "") return;
  return journeyAction(async () => {
    [startPackage, heatmap, onboardingAssistant] = await Promise.all([
      client.loadStartPackage(worldId),
      client.loadCapacityHeatmap(worldId),
      client.loadOnboardingAssistant(worldId),
    ]);
  }, "Startpaket, Kapazität und Betriebsassistent sind aktuell.");
}

async function claimStartPackage(): Promise<void> {
  const client = api;
  if (client === undefined || worldId === "") return;
  return journeyAction(async () => {
    startPackage = await client.claimStartPackage(worldId);
    [heatmap, onboardingAssistant] = await Promise.all([
      client.loadCapacityHeatmap(worldId),
      client.loadOnboardingAssistant(worldId),
    ]);
  }, "Startpaket wurde über Fleet-, Economy- und Betriebsprogramm-Single-Writer zugeteilt.");
}

function bind(): void {
  app.querySelector("#density")?.addEventListener("click", () => {
    density = density === "control" ? "document" : "control";
    render();
  });
  app.querySelector("#steps")?.addEventListener("click", () => {
    showBlockingTimes = !showBlockingTimes;
    render();
  });
  app.querySelectorAll<HTMLElement>("[data-train]").forEach((node) => {
    const select = (): void => {
      selectedTrainId = node.dataset.train ?? "";
      selectedConflictId =
        projection === undefined
          ? ""
          : (conflictsForTrain(projection, selectedTrainId)[0]?.id ?? "");
      message = "";
      render();
    };
    node.addEventListener("click", select);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-conflict]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedConflictId = node.dataset.conflict ?? "";
      message = "";
      render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-apply-alternative]").forEach((node) => {
    node.addEventListener("click", () => {
      const alternativeId = node.dataset.applyAlternative ?? "";
      if (alternativeId !== "") void applyAlternative(alternativeId);
    });
  });
}

async function applyAlternative(alternativeId: string): Promise<void> {
  if (projection === undefined || applyingAlternativeId !== "") return;
  const previousRevision = projection.projectionRevision;
  applyingAlternativeId = alternativeId;
  message = "Alternative wurde eingereiht; der Client wartet auf die neue Planner-Projektion.";
  messageTone = "status";
  render();
  try {
    if (demoMode && demoApply !== undefined) {
      projection = demoApply(projection, alternativeId);
    } else if (api !== undefined && worldId !== "") {
      projection = await api.applyAlternative(worldId, previousRevision, alternativeId);
    } else {
      throw new Error("Weltkennung oder angemeldete Sitzung fehlt.");
    }
    reconcileSelection(projection);
    message = `Serverautoritäre Planner-Projektion Revision ${projection.projectionRevision} wurde geladen.`;
    messageTone = "status";
  } catch (error) {
    message =
      error instanceof Error
        ? error.message
        : "Alternative konnte nicht angewendet werden.";
    messageTone = "error";
  } finally {
    applyingAlternativeId = "";
    render();
  }
}

async function boot(): Promise<void> {
  render();
  if (demoMode) {
    const demo = await import("./demo.js");
    demoApply = demo.applyDemoAlternative;
    projection = demo.demoProjection;
    chooseInitialSelection(projection);
    render();
    return;
  }
  try {
    const accessToken = await ensureAccessToken(runtimeConfiguration);
    if (accessToken === "") return;
    api = new GameApiClient(runtimeConfiguration.gameApiUrl, accessToken);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Anmeldung fehlgeschlagen.";
    if (journeyMode) {
      message = detail;
      messageTone = "error";
    }
    else loadError = detail;
    render();
    return;
  }
  if (journeyMode) {
    if (api === undefined || worldId === "") {
      message = "Öffentliche Weltkennung oder angemeldete Sitzung fehlt. Produktivdaten werden nicht durch Beispieldaten ersetzt.";
      messageTone = "error";
      render();
      return;
    }
    journeyBusy = true;
    render();
    try {
      const [tutorialResult, grantResult, heatmapResult, assistantResult] = await Promise.allSettled([
        tutorialWorldId === "" ? Promise.resolve(undefined) : api.loadTutorial(tutorialWorldId),
        api.loadStartPackage(worldId),
        api.loadCapacityHeatmap(worldId),
        api.loadOnboardingAssistant(worldId),
      ]);
      if (tutorialResult.status === "fulfilled") tutorialJourney = tutorialResult.value;
      if (grantResult.status === "fulfilled") startPackage = grantResult.value;
      if (heatmapResult.status === "fulfilled") heatmap = heatmapResult.value;
      if (assistantResult.status === "fulfilled") onboardingAssistant = assistantResult.value;
      const failures = [tutorialResult, grantResult, heatmapResult, assistantResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        const first = failures[0]!.reason;
        const detail = first instanceof Error ? first.message : "Unbekannter Ladefehler.";
        message = `${failures.length} Bereich${failures.length === 1 ? "" : "e"} der Spielerreise konnte${failures.length === 1 ? "" : "n"} nicht geladen werden: ${detail}`;
        messageTone = "error";
      }
    } catch (error) {
      message = error instanceof Error ? error.message : "Spielerreise konnte nicht geladen werden.";
      messageTone = "error";
    } finally {
      journeyBusy = false;
      render();
    }
    return;
  }
  if (worldId === "" || api === undefined) {
    loadError =
      "Weltkennung oder angemeldete Sitzung fehlt. Im Produktivmodus werden keine Beispieldaten eingesetzt.";
    render();
    return;
  }
  try {
    projection = await api.loadProjection(worldId);
    chooseInitialSelection(projection);
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : "Planner-Ergebnis konnte nicht geladen werden.";
  }
  render();
}

if (primaryDestination === undefined) void boot();
