import { mountRouteImport, RouteImportSession, routeMatchesEndpoints, type RouteCatalog } from "../../apps/game-web/src/route-import.js";
import { parsePlanningFlexibility } from "../../apps/game-web/src/planning-flexibility.js";

/** Ausschließlich synthetische Daten; diese Vorschau sendet keine Planungsanträge. */
export function mountRouteImportPreview(root: HTMLElement, worldId: string): void {
  const catalog: RouteCatalog = {
    worldId, releaseId: "synthetic-route-preview-v1",
    stations: [{ id: "sample-north", code: "XA", name: "Beispiel Nord" }, { id: "sample-junction", code: "XB", name: "Beispiel Abzweig" }, { id: "sample-south", code: "XC", name: "Beispiel Süd" }],
    segments: [{ fromStationId: "sample-north", toStationId: "sample-junction" }, { fromStationId: "sample-junction", toStationId: "sample-south" }],
  };
  const csv = '\uFEFF"Lfd. km";"Betriebsstelle";"Betriebsstelle (kurz)";"Ankunftszeit";"Abfahrtszeit";"Haltart"\r\n"0";"Beispiel Nord";"XA";"08:00";"08:00";"Verkehrshalt"\r\n"10,2";"Beispiel Abzweig";"XB";"08:15";"08:16";"Verkehrshalt"\r\n"20,5";"Beispiel Süd";"XC";"08:30";"08:30";"Verkehrshalt"\r\n';
  const instructions = document.createElement("section");
  instructions.className = "journey-card";
  instructions.innerHTML = '<p class="eyebrow">BEISPIELVORSCHAU</p><h3>Fahrweg planen</h3><p>Plane deinen Fahrweg mit Trassenfinder oder probiere eine Beispielroute aus. Lade dazu die CSV-Datei herunter und wähle sie unten bei deiner Fahrt aus.</p><p data-preview-downloads></p><details><summary>Deine Fahrt im Überblick</summary><p data-preview-summary style="white-space:pre-line;overflow-wrap:anywhere">Übernimm einen Fahrweg und prüfe deine Fahrt.</p></details><p data-preview-result role="status" aria-live="polite"></p>';
  for (const [label, filename, content] of [
    ["Beispielroute herunterladen", "beispielroute.csv", csv],
    ["Beispielroute zur Zuordnung herunterladen", "beispielroute-zuordnung.csv", csv.replace('"XB"', '"UNBEKANNT"')],
  ]) {
    const link = document.createElement("a"); link.textContent = label!; link.download = filename!;
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(content!)}`;
    link.style.marginRight = "1rem";
    instructions.querySelector("[data-preview-downloads]")!.append(link);
  }
  root.querySelector("#betriebsplanung .journey-heading")?.after(instructions);
  const stationList = root.querySelector<HTMLDataListElement>("#planning-stations");
  if (stationList) {
    stationList.replaceChildren(...catalog.stations.map((station) => {
      const option = document.createElement("option"); option.value = station.id; option.label = station.name; return option;
    }));
  }
  root.querySelectorAll<HTMLFormElement>("form").forEach((form) => form.addEventListener("submit", (event) => event.preventDefault()));
  root.querySelectorAll<HTMLFormElement>("[data-path-request]").forEach((form) => {
    const session = new RouteImportSession(`${worldId}:synthetic-operator`);
    const origin = form.querySelector<HTMLInputElement>('[name="originStationId"]')!;
    const destination = form.querySelector<HTMLInputElement>('[name="destinationStationId"]')!;
    const host = form.querySelector<HTMLElement>("[data-route-import]")!;
    mountRouteImport(host, session, {
      loadCatalog: async () => catalog,
      apply: (route) => { origin.value = route.stations[0]!.id; destination.value = route.stations.at(-1)!.id; },
      remove: () => undefined,
    });
    for (const input of [origin, destination]) input.addEventListener("input", () => {
      if (session.applied || session.candidate || session.busy || session.pendingMapping) session.clear("Start oder Ziel wurde geändert. Übernimm den Fahrweg erneut.");
    });
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.textContent = "Fahrt prüfen";
    form.addEventListener("submit", () => {
      try {
        session.assertReady();
        if (session.applied && !routeMatchesEndpoints(session.applied, origin.value, destination.value)) throw new Error("Start oder Ziel wurde geändert.");
        const fields = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
        const flexibility = parsePlanningFlexibility(fields, { departureMinutes: 30, runningMinutes: 15 });
        const start = catalog.stations.find((station) => station.id === origin.value);
        const end = catalog.stations.find((station) => station.id === destination.value);
        if (!start || !end) throw new Error("Wähle Start und Ziel aus den Betriebsstellen der Beispielroute.");
        const names = session.applied?.stations.map((station) => station.name) ?? [start.name, end.name];
        instructions.querySelector("[data-preview-summary]")!.textContent = `Fahrweg: ${names.join(" → ")}\nGewünschte Abfahrt: in ${fields["departureInMinutes"]} Minuten.\nSpielraum bei Konflikten: bis zu ${flexibility.departureFlexibilityS / 60} Minuten später und bis zu ${flexibility.extraRunningTimeS / 60} Minuten zusätzliche Fahrzeit.\nDie Zwischenpunkte werden ohne Fahrgastwechsel durchfahren. Bei Konflikten können Betriebshalte und längere Aufenthalte nötig werden.`;
        instructions.querySelector("details")!.open = true;
        instructions.querySelector("[data-preview-result]")!.textContent = "So sieht deine Beispielplanung aus. In dieser Vorschau wird keine Fahrt angemeldet.";
      } catch (value) {
        instructions.querySelector("[data-preview-result]")!.textContent = value instanceof Error ? value.message : "Deine Fahrt konnte noch nicht geprüft werden.";
      }
    });
  });
}
