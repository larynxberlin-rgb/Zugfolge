import { parsePlanningProjection, type PlanningResultProjection } from "../../packages/planning-projection/src/index.js";
import { renderProjection } from "../../apps/game-web/src/view.js";

/** Synthetischer Vergleich; keine Anfrage, Übernahme oder Zuteilung auf einem Spielserver. */
export function mountPlanningAdjustmentsPreview(root: HTMLElement): void {
  const parameters = new URLSearchParams(location.search);
  let status = parameters.get("result") ?? "allocated";
  let selectedTrainId = "sample-own";
  const requestedDepartureS = 28_800;
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
    const departure = proposed || rejected || legacy ? requestedDepartureS : requestedDepartureS + 120;
    const planning: PlanningResultProjection = proposed || rejected ? { status: proposed ? "requested" : "rejected", requestedDepartureS, plannedDepartureS: null, adjustments: [] }
      : { status: "allocated", requestedDepartureS, plannedDepartureS: departure, adjustments };
    const resource = { id: "sample-block", kind: "block", label: "Abschnitt Beispiel Abzweig–Süd" };
    const projection = parsePlanningProjection({
      schemaVersion: "planning-projection/v1", projectionRevision: 3, worldId: "synthetic-planning-preview",
      corridor: { id: "sample-corridor", name: "Beispiel Nord–Süd" },
      stations: [{ id: "sample-north", name: "Beispiel Nord", distanceMm: 0 }, { id: "sample-central", name: "Beispiel Mitte", distanceMm: 10_000_000 },
        { id: "sample-junction", name: "Beispiel Abzweig", distanceMm: 20_000_000 }, { id: "sample-south", name: "Beispiel Süd", distanceMm: 40_000_000 }],
      trains: [{ id: "sample-own", number: "FV 26801", direction: "with-chainage", calls: [{ stationId: "sample-north", timeS: departure },
        { stationId: "sample-south", timeS: departure + (proposed || rejected || legacy ? 1_800 : 2_040) }], ...(legacy ? {} : { planning }) },
      { id: "sample-other", number: "R 65100", direction: "against-chainage", calls: [{ stationId: "sample-south", timeS: 29_500 }, { stationId: "sample-north", timeS: 31_100 }] }],
      occupations: [],
      conflicts: proposed ? [{ id: "sample-conflict", kind: "opposing-move", resource, window: { startS: 29_500, endS: 29_620 }, trainIds: ["sample-own", "sample-other"],
        explanation: "Beide Beispiel-Züge beanspruchen den eingleisigen Abschnitt zur gleichen Zeit.", alternative: { alternativeId: "sample-alternative", trainId: "sample-own",
          departureShiftS: 120, explanation: "Mit diesen Anpassungen kann dein Zug den Abschnitt ohne Konflikt mit der Gegenfahrt befahren.",
          planning: { status: "proposed", requestedDepartureS, plannedDepartureS: requestedDepartureS + 120, adjustments } } }] : [],
    });
    root.innerHTML = renderProjection(projection, { density: "control", showBlockingTimes: false, selectedTrainId,
      selectedConflictId: proposed ? "sample-conflict" : "", demoMode: true, livemapUrl: "?screen=planner" });
    const controls = document.createElement("div");
    controls.className = "demo-banner";
    controls.style.flexWrap = "wrap";
    controls.setAttribute("aria-label", "Beispiel für die Trassenplanung wählen");
    for (const [value, label] of [["allocated", "Zugeteilte Anpassungen"], ["proposed", "Noch nicht übernommener Vorschlag"], ["rejected", "Ablehnung"], ["legacy", "Historische Daten"]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "zf-button";
      button.textContent = label!; button.setAttribute("aria-pressed", String(status === value));
      button.addEventListener("click", () => { status = value!; render(); }); controls.append(button);
    }
    root.querySelector(".context")?.after(controls);
    root.querySelector("[data-apply-alternative]")?.addEventListener("click", () => { status = "allocated"; render(); });
    root.querySelectorAll<SVGGElement>("[data-train]").forEach((element) => {
      const select = () => { selectedTrainId = element.dataset["train"]!; render(); };
      element.addEventListener("click", select);
      element.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    });
  };
  render();
}
