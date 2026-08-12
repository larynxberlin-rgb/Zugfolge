import type { Density } from "@zugfolge/design-system";
import "@zugfolge/design-system/styles.css";
import { mountGlossaryLayer } from "@zugfolge/glossary";
import "@zugfolge/glossary/styles.css";
import type { PlanningProjectionV1 } from "@zugfolge/planning-projection";

import { GameApiClient } from "./api.js";
import { conflictsForTrain } from "./diagram.js";
import { renderLoadState, renderProjection } from "./view.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("App-Wurzel fehlt");
const app = root;
mountGlossaryLayer(document.body);

const parameters = new URLSearchParams(window.location.search);
const demoMode = parameters.get("demo") === "1";
const worldId = parameters.get("world") ?? "";
const accessToken = sessionStorage.getItem("zugfolge.accessToken") ?? "";
const apiBaseUrl =
  document.querySelector<HTMLMetaElement>('meta[name="game-api-url"]')?.content ?? "";
const api =
  !demoMode && accessToken !== ""
    ? new GameApiClient(apiBaseUrl, accessToken)
    : undefined;

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
    message = `Serverautoritaere Planner-Projektion Revision ${projection.projectionRevision} wurde geladen.`;
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

void boot();
