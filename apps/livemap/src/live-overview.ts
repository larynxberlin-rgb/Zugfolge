import { escapeHtml, icon } from "@zugfolge/design-system";
import { operatorLabel, type PublicTrain } from "./protocol.js";

export type TrainScope = "all" | "own";

export function filterTrains(trains: readonly PublicTrain[], scope: TrainScope, operatorId: string, query = ""): readonly PublicTrain[] {
  const search = query.trim().toLocaleLowerCase("de");
  return trains.filter((train) => (scope === "all" || (operatorId !== "" && train.operatorId === operatorId))
    && (search === "" || `${train.trainNumber} ${operatorLabel(train)} ${train.nextOperatingPoint ?? ""}`.toLocaleLowerCase("de").includes(search)));
}

export function liveOverview(trains: readonly PublicTrain[]): { active: number; moving: number; delayed: number; unknownDelay: number } {
  const active = trains.filter((train) => train.status !== "completed" && train.status !== "cancelled" && train.status !== "planned");
  return {
    active: active.length,
    moving: active.filter((train) => train.status === "running").length,
    delayed: active.filter((train) => train.delaySeconds !== undefined && train.delaySeconds >= 60).length,
    unknownDelay: active.filter((train) => train.delaySeconds === undefined).length,
  };
}

export function trainSituation(train: PublicTrain): string {
  if (train.status === "cancelled") return "Fällt aus";
  if (train.status === "completed") return "Angekommen";
  if (train.positionFrozen === true) return "Position wird geprüft";
  if (train.delaySeconds === undefined) return "Verspätung unbekannt";
  if (train.delaySeconds >= 60) return `+${Math.floor(train.delaySeconds / 60)} min`;
  if (train.status === "waiting") return "Wartet";
  if (train.status === "planned") return "Geplant";
  return "Pünktlich";
}

/** Informational priority only; this does not predict or execute dispatch actions. */
export function watchTrains(trains: readonly PublicTrain[]): readonly PublicTrain[] {
  return trains.filter((train) => train.status !== "completed" && train.status !== "planned")
    .toSorted((a, b) => Number(b.status === "cancelled") - Number(a.status === "cancelled")
      || Number(b.disruption !== undefined) - Number(a.disruption !== undefined)
      || (b.delaySeconds ?? 0) - (a.delaySeconds ?? 0)
      || a.trainNumber.localeCompare(b.trainNumber, "de"))
    .slice(0, 4);
}

export function watchMarkup(trains: readonly PublicTrain[]): string {
  const watched = watchTrains(trains);
  if (watched.length === 0) return `<div class="live-empty">${icon("route")}<strong>Platz für deine nächsten Züge</strong><p>Sobald Fahrten unterwegs sind, siehst du hier ihren aktuellen Stand.</p></div>`;
  return watched.map((train) => `<button class="watch-train" type="button" data-watch-train="${escapeHtml(train.id)}"><span class="watch-train__head"><strong>${icon("train")}${escapeHtml(train.trainNumber)}</strong><span class="${train.status === "cancelled" || train.disruption !== undefined ? "tone-danger" : (train.delaySeconds ?? 0) >= 60 ? "tone-attention" : "tone-neutral"}">${escapeHtml(trainSituation(train))}</span></span><span class="watch-train__destination">${escapeHtml(train.nextOperatingPoint ?? "Im Streckennetz")}${icon("chevron")}</span><small>${escapeHtml(operatorLabel(train))}</small>${train.disruption === undefined ? "" : `<span class="watch-train__cause">${icon("warning")}${escapeHtml(train.disruption.causeLabel)}</span>`}</button>`).join("");
}
