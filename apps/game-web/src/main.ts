import type { Density } from "@zugfolge/design-system";
import "@zugfolge/design-system/styles.css";
import { mountGlossaryLayer } from "@zugfolge/glossary";
import "@zugfolge/glossary/styles.css";
import type { PlanningProjectionV1 } from "@zugfolge/planning-projection";

import { GameApiClient, type TutorialAction, type TutorialSessionView } from "./api.js";
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
const publicWorldId = parameters.get("publicWorld") ?? runtimeConfiguration.publicWorldId;
const tutorialReference = parameters.get("tutorial");
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
let tutorialSession: TutorialSessionView | undefined;
let journeyBusy = journeyMode && !demoMode;
let coachDismissed = false;
let whyOpen = false;
let tutorialPoll: ReturnType<typeof setTimeout> | undefined;

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
      publicWorldId,
      tutorial: tutorialSession,
      busy: journeyBusy,
      message,
      coachDismissed,
      whyOpen,
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
  app.querySelector("#tutorial-start")?.addEventListener("click", () => void startTutorial());
  app.querySelector("#tutorial-restart")?.addEventListener("click", () => void restartTutorial());
  app.querySelector("#tutorial-summary-confirm")?.addEventListener("click", () => void confirmTutorialSummary());
  app.querySelector("#tutorial-hint")?.addEventListener("click", () => void openTutorialHint());
  app.querySelector("#tutorial-dismiss")?.addEventListener("click", () => void dismissTutorialDialogue());
  app.querySelector("#tutorial-coach-reopen")?.addEventListener("click", () => { coachDismissed = false; render(); focusCoach(); });
  app.querySelector("#tutorial-why")?.addEventListener("click", () => { whyOpen = !whyOpen; render(); app.querySelector<HTMLButtonElement>("#tutorial-why")?.focus(); });
  const focusButton = app.querySelector<HTMLButtonElement>("#tutorial-focus-target");
  focusButton?.addEventListener("click", () => focusTarget(focusButton.dataset.target));
  app.querySelector<HTMLFormElement>("#tutorial-tender-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    void applyTutorialAction({ type: "submit-bid", orderingFeeCentsPerTrainKm: String(data.get("orderingFeeCentsPerTrainKm") ?? ""), punctualityBasisPoints: Number(data.get("punctualityBasisPoints")), extraSeats: Number(data.get("extraSeats")) });
  });
  app.querySelector<HTMLFormElement>("#tutorial-program-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    void applyTutorialAction({ type: "activate-program", templateId: String(data.get("templateId")) as "connections" | "punctuality", changedRule: String(data.get("changedRule")) as "hold-connections" | "prioritize-punctuality" | "activate-reserve", thresholdSeconds: Number(data.get("thresholdSeconds")) });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-offer]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "accept-lease", offerId: button.dataset.tutorialOffer ?? "" })));
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-path]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "confirm-path", alternativeId: button.dataset.tutorialPath ?? "" })));
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-dispatch]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "dispatch", action: button.dataset.tutorialDispatch as "short_turn" | "request_reroute" | "trigger_rail_replacement" })));
}

function focusTarget(target: string | undefined): void {
  if (target === undefined || target === "") return;
  const element = app.querySelector<HTMLElement>(`#${CSS.escape(target)}`);
  element?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  element?.focus({ preventScroll: true });
}

function focusCoach(): void {
  app.querySelector<HTMLElement>("#lutz-name")?.focus({ preventScroll: true });
}

function setTutorialSession(next: TutorialSessionView, updateUrl = true): void {
  const previousDialogue = tutorialSession?.dialogue.id;
  tutorialSession = next;
  if (previousDialogue !== next.dialogue.id) {
    coachDismissed = false;
    whyOpen = false;
  }
  if (updateUrl) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("world", next.tutorialWorldId);
    nextUrl.searchParams.set("publicWorld", next.publicWorldId);
    nextUrl.searchParams.set("tutorial", next.reference);
    history.replaceState({ tutorial: next.reference }, "", nextUrl);
  }
  scheduleTutorialPoll();
}

function scheduleTutorialPoll(): void {
  if (tutorialPoll !== undefined) clearTimeout(tutorialPoll);
  if (tutorialSession?.lifecycle !== "running" && tutorialSession?.lifecycle !== "summary") return;
  tutorialPoll = setTimeout(() => void silentRefreshTutorial(), 2_000);
}

async function silentRefreshTutorial(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined || journeyBusy) { scheduleTutorialPoll(); return; }
  try {
    const next = await client.loadTutorial(session.tutorialWorldId);
    const changed = next.currentChapter !== session.currentChapter || next.lifecycle !== session.lifecycle || next.dialogue.id !== session.dialogue.id;
    setTutorialSession(next);
    if (changed) { render(); focusCoach(); }
  } catch { /* Die sichtbare Aktion liefert weiterhin erklaerbare Fehler; Polling bleibt still. */ }
  scheduleTutorialPoll();
}

async function journeyAction(action: () => Promise<void>, success: string): Promise<void> {
  if (journeyBusy) return;
  journeyBusy = true;
  message = "Autoritativer Weltzustand wird aktualisiert …";
  render();
  try {
    await action();
    message = success;
  } catch (error) {
    message = error instanceof Error ? error.message : "Spielerreise konnte nicht aktualisiert werden.";
  } finally {
    journeyBusy = false;
    render();
    if (tutorialSession !== undefined) focusCoach();
  }
}

async function startTutorial(): Promise<void> {
  const client = api;
  if (client === undefined || publicWorldId === "") return;
  return journeyAction(async () => setTutorialSession(await client.startTutorial(publicWorldId)), "Ihre private Tutorialwelt ist bereit.");
}

async function restartTutorial(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  return journeyAction(async () => setTutorialSession(await client.restartTutorial(session.tutorialWorldId)), "Die alte Welt wurde archiviert; eine neue Tutorialwelt ist bereit.");
}

async function applyTutorialAction(action: TutorialAction): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  return journeyAction(async () => setTutorialSession(await client.tutorialAction(session.tutorialWorldId, action)), "Autoritativer Nachweis erbracht. Das nächste Kapitel ist bereit.");
}

async function openTutorialHint(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  return journeyAction(async () => setTutorialSession(await client.openTutorialHint(session.tutorialWorldId)), "Lutz hat einen zusätzlichen Hinweis eingeblendet.");
}

async function dismissTutorialDialogue(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  try {
    setTutorialSession(await client.dismissTutorialDialogue(session.tutorialWorldId, session.dialogue.id));
    coachDismissed = true;
    render();
  } catch (error) {
    message = error instanceof Error ? error.message : "Hinweis konnte nicht ausgeblendet werden.";
    render();
  }
}

async function confirmTutorialSummary(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  return journeyAction(async () => setTutorialSession(await client.confirmTutorialSummary(session.tutorialWorldId)), "Die Tutorialwelt wurde geschlossen. Ihre öffentliche Welt blieb unverändert.");
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
      journeyBusy = false;
      message = detail;
    }
    else loadError = detail;
    render();
    return;
  }
  if (journeyMode) {
    if (api === undefined || publicWorldId === "") {
      journeyBusy = false;
      message = "Öffentliche Weltkennung oder angemeldete Sitzung fehlt. Produktivdaten werden nicht durch Beispieldaten ersetzt.";
      render();
      return;
    }
    journeyBusy = true;
    render();
    try {
      const requestedTutorialWorld = tutorialReference === null ? undefined : worldId;
      const tutorial = await (requestedTutorialWorld === undefined ? api.loadActiveTutorial(publicWorldId) : api.loadTutorial(requestedTutorialWorld));
      if (tutorial !== undefined) setTutorialSession(tutorial);
    } catch (error) {
      message = error instanceof Error ? error.message : "Spielerreise konnte nicht geladen werden.";
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
