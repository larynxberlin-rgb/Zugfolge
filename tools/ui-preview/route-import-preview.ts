import { mountRouteImport, RouteImportSession, routeMatchesEndpoints, routeViaStationIds, type RouteCatalog } from "../../apps/game-web/src/route-import.js";
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
  instructions.innerHTML = '<p class="eyebrow">BEISPIELDATEN · LOKALE FUNKTIONSPRÜFUNG</p><h3>Trassenfinder-Import ausprobieren</h3><p>Lade die synthetische CSV-Datei herunter und wähle sie in einem der beiden Formulare aus. Es werden keine Fahrten gebucht.</p><p data-preview-downloads></p><details><summary>Beispielantrag prüfen</summary><pre data-preview-payload style="white-space:pre-wrap;overflow-wrap:anywhere">Übernimm einen Fahrweg und zeige den Beispielantrag an.</pre></details><p data-preview-result role="status" aria-live="polite"></p>';
  for (const [label, filename, content] of [
    ["Beispiel-CSV herunterladen", "synthetischer-laufweg.csv", csv],
    ["CSV mit unbekanntem Punkt herunterladen", "synthetischer-laufweg-fehler.csv", csv.replace('"XB"', '"UNBEKANNT"')],
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
      if (session.applied || session.candidate || session.busy) session.clear("Start oder Ziel wurde geändert. Übernimm den Fahrweg erneut.");
    });
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.textContent = "Planungsantrag als Beispiel anzeigen";
    form.addEventListener("submit", () => {
      try {
        session.assertReady();
        if (session.applied && !routeMatchesEndpoints(session.applied, origin.value, destination.value)) throw new Error("Start oder Ziel wurde geändert.");
        const fields = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
        const flexibility = parsePlanningFlexibility(fields, { departureMinutes: 30, runningMinutes: 15 });
        instructions.querySelector("[data-preview-payload]")!.textContent = JSON.stringify({ worldId, formationId: fields["formationId"], originStationId: origin.value, destinationStationId: destination.value, ...(session.applied ? { viaStationIds: routeViaStationIds(session.applied) } : {}), stops: [], earlierS: 0, laterS: flexibility.departureFlexibilityS, extraRunningTimeS: flexibility.extraRunningTimeS, maxOperationalStops: 4 }, null, 2);
        instructions.querySelector("details")!.open = true;
        instructions.querySelector("[data-preview-result]")!.textContent = "Beispielantrag angezeigt. Es wurde nichts an einen Server gesendet.";
      } catch (value) {
        instructions.querySelector("[data-preview-result]")!.textContent = value instanceof Error ? value.message : "Die Beispielprüfung ist fehlgeschlagen.";
      }
    });
  });
}
