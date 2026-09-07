import { parsePlanningProjection, type PlanningResultProjection, type PlanningTimelineCallProjection } from "../../packages/planning-projection/src/index.js";
import { renderProjection } from "../../apps/game-web/src/view.js";

/** Synthetischer Vergleich; keine Anfrage, Übernahme oder Zuteilung auf einem Spielserver. */
export function mountPlanningAdjustmentsPreview(root: HTMLElement): void {
  const parameters = new URLSearchParams(location.search);
  let status = parameters.get("result") ?? "allocated";
  let selectedTrainId = "sample-own";
  let planningView: "comparison" | "diagram" = "comparison";
  const requestedDepartureS = 28_800;
  const requested: readonly PlanningTimelineCallProjection[] = [
    { stationId: "sample-north", arrivalS: 28_800, departureS: 28_800, kind: "origin" },
    { stationId: "sample-central", arrivalS: 29_400, departureS: 29_460, kind: "passenger-stop" },
    { stationId: "sample-junction", arrivalS: 30_000, departureS: 30_000, kind: "pass" },
    { stationId: "sample-south", arrivalS: 30_600, departureS: 30_600, kind: "destination" },
  ];
  const planned: readonly PlanningTimelineCallProjection[] = [
    { stationId: "sample-north", arrivalS: 28_920, departureS: 28_920, kind: "origin" },
    { stationId: "sample-central", arrivalS: 29_520, departureS: 29_700, kind: "passenger-stop" },
    { stationId: "sample-junction", arrivalS: 30_240, departureS: 30_360, kind: "operational-stop" },
    { stationId: "sample-south", arrivalS: 30_960, departureS: 30_960, kind: "destination" },
  ];
  const adjustments: PlanningResultProjection["adjustments"] = [
    { kind: "departure-shift", stationId: "sample-north", requestedS: requestedDepartureS, plannedS: requestedDepartureS + 120,
      explanation: "Die spätere Abfahrt hält den nötigen Abstand zur vorausfahrenden Beispiel-Fahrt." },
    { kind: "dwell-extension", stationId: "sample-central", requestedS: 60, plannedS: 180,
      explanation: "Der verlängerte Aufenthalt in Beispiel Mitte ermöglicht die Weiterfahrt nach dem kreuzenden Zug." },
    { kind: "operational-stop", stationId: "sample-junction", requestedS: 0, plannedS: 120,
      explanation: "Der zusätzliche Betriebshalt in Beispiel Abzweig wartet die Freigabe des folgenden Abschnitts ab; Fahrgäste steigen hier nicht ein." },
    { kind: "running-time-extension", stationId: "sample-south", requestedS: 1_800, plannedS: 2_040,
      explanation: "Die Gesamtfahrtdauer enthält die oben einzeln erklärten längeren Aufenthalte." },
  ];
  const render = () => {
    const proposed = status === "proposed";
    const rejected = status === "rejected";
    const legacy = status === "legacy";
    const pending = proposed || rejected || status === "requested";
    const departure = pending ? requestedDepartureS : requestedDepartureS + 120;
    const planning: PlanningResultProjection = pending ? { status: rejected ? "rejected" : "requested", requestedDepartureS, plannedDepartureS: null, adjustments: [], timeline: { requested, planned: null } }
      : { status: "allocated", requestedDepartureS, plannedDepartureS: departure, adjustments, ...(legacy ? {} : { timeline: { requested, planned } }) };
    const resource = { id: "sample-block", kind: "block", label: "Abschnitt Beispiel Abzweig–Süd" };
    const projection = parsePlanningProjection({
      schemaVersion: "planning-projection/v1", projectionRevision: 3, worldId: "synthetic-planning-preview",
      corridor: { id: "sample-corridor", name: "Beispiel Nord–Süd" },
      stations: [{ id: "sample-north", name: "Beispiel Nord", distanceMm: 0 }, { id: "sample-central", name: "Beispiel Mitte", distanceMm: 10_000_000 },
        { id: "sample-junction", name: "Beispiel Abzweig", distanceMm: 20_000_000 }, { id: "sample-south", name: "Beispiel Süd", distanceMm: 40_000_000 }],
      trains: [{ id: "sample-own", number: "FV 26801", direction: "with-chainage", calls: [{ stationId: "sample-north", timeS: departure },
        { stationId: "sample-south", timeS: departure + (pending ? 1_800 : 2_040) }], planning },
      { id: "sample-other", number: "R 65100", direction: "against-chainage", calls: [{ stationId: "sample-south", timeS: 29_500 }, { stationId: "sample-north", timeS: 31_100 }] }],
      occupations: [],
      conflicts: proposed ? [{ id: "sample-conflict", kind: "opposing-move", resource, window: { startS: 29_500, endS: 29_620 }, trainIds: ["sample-own", "sample-other"],
        explanation: "Beide Beispiel-Züge beanspruchen den eingleisigen Abschnitt zur gleichen Zeit.", alternative: { alternativeId: "sample-alternative", trainId: "sample-own",
          departureShiftS: 120, explanation: "Mit diesen Anpassungen kann dein Zug den Abschnitt ohne Konflikt mit der Gegenfahrt befahren.",
          planning: { status: "proposed", requestedDepartureS, plannedDepartureS: requestedDepartureS + 120, adjustments, timeline: { requested, planned } } } }] : [],
    });
    root.innerHTML = renderProjection(projection, { density: "control", showBlockingTimes: false, selectedTrainId,
      selectedConflictId: proposed ? "sample-conflict" : "", planningView, demoMode: true, livemapUrl: "?screen=planner" });
    const controls = document.createElement("div");
    controls.className = "demo-banner";
    controls.style.flexWrap = "wrap";
    controls.setAttribute("aria-label", "Beispiel für die Trassenplanung wählen");
    const statusLabel = document.createElement("label"); statusLabel.htmlFor = "planning-preview-result"; statusLabel.textContent = "Beispielvorschau · Planungsstand ";
    const statusSelect = document.createElement("select"); statusSelect.id = "planning-preview-result"; statusSelect.className = "zf-button";
    for (const [value, label] of [["allocated", "Zugeteilte Anpassungen"], ["proposed", "Noch nicht übernommener Vorschlag"], ["requested", "Noch in Planung"], ["rejected", "Ablehnung"], ["legacy", "Älterer Planungsstand"]]) {
      const option = document.createElement("option"); option.value = value!; option.textContent = label!; option.selected = status === value; statusSelect.append(option);
    }
    statusSelect.addEventListener("change", () => { status = statusSelect.value; render(); }); statusLabel.append(statusSelect); controls.append(statusLabel);
    root.querySelector(".context")?.after(controls);
    root.querySelectorAll("[data-apply-alternative]").forEach((button) => button.addEventListener("click", () => { status = "allocated"; render(); }));
    root.querySelector<HTMLSelectElement>("#planning-train")?.addEventListener("change", (event) => { selectedTrainId = (event.currentTarget as HTMLSelectElement).value; render(); });
    root.querySelectorAll<HTMLButtonElement>("[data-planning-view]").forEach((button) => button.addEventListener("click", () => {
      planningView = button.dataset["planningView"] === "diagram" ? "diagram" : "comparison"; render();
    }));
    root.querySelectorAll<SVGGElement>("[data-train]").forEach((element) => {
      const select = () => { selectedTrainId = element.dataset["train"]!; render(); };
      element.addEventListener("click", select);
      element.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    });
  };
  render();
}
