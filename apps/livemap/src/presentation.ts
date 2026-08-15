import type { OperatingStatus, PublicExternalTrain } from "./protocol.js";

const WORDS: Readonly<Record<string, string>> = { hbf: "Hbf", bf: "Bf", ost: "Ost", west: "West", nord: "Nord", sued: "Süd", süd: "Süd" };

export function railwayPlaceLabel(identifier: string | null): string {
  if (identifier === null || identifier.trim() === "") return "Außenziel";
  const external = /^external\s+(origin|destination):/i.exec(identifier.trim());
  if (external?.[1]?.toLowerCase() === "origin") return "Außenherkunft";
  if (external?.[1]?.toLowerCase() === "destination") return "Außenziel";
  return identifier.split(/[-_]+/).filter(Boolean).map((part) => WORDS[part.toLowerCase()] ?? `${part[0]?.toLocaleUpperCase("de") ?? ""}${part.slice(1)}`).join(" ");
}

export function operatingStatusLabel(status: OperatingStatus): string {
  return ({ planned: "geplant", running: "unterwegs", waiting: "wartet", at_platform: "am Bahnsteig", completed: "beendet", cancelled: "fällt aus" } as const)[status];
}

export function externalStatusLabel(status: PublicExternalTrain["status"]): string {
  return ({ outside: "außerhalb des Spielgebiets", "ready-at-boundary": "an der Netzgrenze bereit", "waiting-for-capacity": "wartet auf freie Kapazität", "completed-outside": "außerhalb beendet" } as const)[status];
}

/** Entfernt beendete Außenläufe und genau gleiche Kettenbeine aus der Live-Ansicht. */
export function visibleExternalTrains(trains: Iterable<PublicExternalTrain>): readonly PublicExternalTrain[] {
  const visible = new Map<string, PublicExternalTrain>();
  for (const train of trains) {
    if (train.status === "completed-outside") continue;
    const key = `${train.journeyChainId}\u0000${train.externalLegId}`;
    const current = visible.get(key);
    if (current === undefined || train.scheduledEndS > current.scheduledEndS || (train.scheduledEndS === current.scheduledEndS && train.id > current.id)) visible.set(key, train);
  }
  return [...visible.values()].sort((a, b) => a.trainNumber.localeCompare(b.trainNumber, "de") || a.scheduledEndS - b.scheduledEndS || a.id.localeCompare(b.id));
}

export type MapView = "playable" | "germany" | "world";

export function setMapViewButtons(buttons: Iterable<HTMLButtonElement>, active: MapView): void {
  for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset["mapView"] === active));
}

export function localizeMapControls(container: ParentNode): void {
  const controls = [
    [".maplibregl-ctrl-zoom-in", "Hineinzoomen"],
    [".maplibregl-ctrl-zoom-out", "Herauszoomen"],
    [".maplibregl-ctrl-compass", "Karte nach Norden ausrichten"],
    [".maplibregl-ctrl-attrib-button", "Kartenquellen anzeigen"],
  ] as const;
  controls.forEach(([selector, label]) => {
    const element = container.querySelector<HTMLElement>(selector);
    element?.setAttribute("aria-label", label);
    element?.setAttribute("title", label);
  });
}
