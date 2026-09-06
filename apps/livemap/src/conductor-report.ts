import type { ConductorApi, ConductorControlStatus } from "./conductor-api.js";
import "./conductor.css";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
}
function euro(value: string): string {
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value)) return "Betrag nicht verfügbar";
  const cents = BigInt(value), magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "−" : ""}${(magnitude / 100n).toLocaleString("de-DE")},${String(magnitude % 100n).padStart(2, "0")} €`;
}

/** Renders only native public amounts. No balance, premium or cap calculation. */
export function renderConductorControlReport(host: HTMLElement, control: ConductorControlStatus, nowMs?: number): void {
  const expanded = new Set([...host.querySelectorAll<HTMLDetailsElement>("details[open][data-case-id]")].map((row) => row.dataset["caseId"]));
  host.replaceChildren(element("h2", "Fälle dieser Fahrt"));
  if (control.hold) {
    const labels = { requested: "Polizei angefordert · Halt wird vorbereitet", active: "Polizeihalt aktiv · die Fahrt wartet", released: "Polizeihalt freigegeben" };
    const outcomes = { identity_confirmed: "Identität bestätigt", identity_not_confirmed: "Identität konnte nicht bestätigt werden", unavailable: "Polizei nicht verfügbar",
      timeout: "Wartezeit beendet", target_unavailable: "Vorgesehener Halt nicht mehr erreichbar" };
    const line = element("p", labels[control.hold.status]); line.className = "conductor-evidence"; host.append(line);
    if (control.hold.outcome) host.append(element("p", outcomes[control.hold.outcome]));
  }
  if (!control.cases.length) host.append(element("p", "Für diese Fahrt sind noch keine Kontrollfälle bestätigt."));
  const statuses = { open: "In Bearbeitung", closed_without_claim: "Ohne Forderung abgeschlossen", claim_open: "Forderung offen", settled: "Abgerechnet" };
  control.cases.forEach((row, index) => {
    const detail = element("details"); detail.dataset["caseId"] = row.caseId; detail.open = expanded.has(row.caseId);
    detail.append(element("summary", `Fall ${index + 1} · ${statuses[row.status]}`));
    if (row.claimKind) {
      detail.append(element("p", `${row.claimKind === "provisional" ? "Vorläufige" : "Reguläre"} Forderung: ${euro(row.claimCents)}`),
        element("p", `Gezahlt: ${euro(row.paidCents)} · Kosten: ${euro(row.costsCents)}`), element("p", `Abgeschrieben: ${euro(row.writtenOffCents)}`));
      if (row.claimKind === "provisional" && row.status === "claim_open") {
        const minutes = nowMs === undefined ? undefined : Math.max(0, Math.ceil((row.proofDeadlineMs - nowMs) / 60000));
        detail.append(element("p", minutes === undefined ? `Nachweisfrist: Spielminute ${Math.ceil(row.proofDeadlineMs / 60000)}.`
          : minutes > 0 ? `Nachweisfrist: noch ${minutes} Spielminuten beim letzten bestätigten Stand.` : "Die Nachweisfrist ist abgelaufen."));
      }
    }
    host.append(detail);
  });
  host.append(element("h2", "Tagesbericht deines Unternehmens"));
  if (!control.days.length) host.append(element("p", "Noch kein Spieltag abgerechnet. Offene Forderungen sind kein sicherer Erlös."));
  for (const day of control.days) {
    const detail = element("section"); detail.className = "conductor-day";
    detail.append(element("h3", `Tag ${Math.floor(day.dayStartMs / 86400000) + 1}`),
      element("p", `Bestätigte SPNV-Vertragserlöse: ${euro(day.contractRevenueCents)}`),
      element("p", `Netto aus Kontrollen: ${euro(day.netCents)}`), element("p", `Kontrollprämie: ${euro(day.premiumCents)}`),
      element("p", `Tagesdeckel-Ausgleich: ${euro(day.capAdjustmentCents)}`), element("p", `Verbleibender Kontrollbeitrag: ${euro(day.contributionCents)}`));
    host.append(detail);
  }
  host.append(element("p", "Betriebliche Verspätungen und Vertragspönalen werden in der regulären Abrechnung geführt."));
}

export async function openConductorReport(input: { api: ConductorApi; trainLabel: string; returnFocus: HTMLElement }): Promise<void> {
  const dialog = element("dialog"); dialog.className = "conductor-confirm conductor-report";
  const title = element("h1", `Kontrollbericht · ${input.trainLabel}`); title.id = "conductor-report-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const status = element("p", "Bestätigte Abrechnung wird geladen …"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const report = element("section"); report.className = "conductor-control-status";
  const refresh = element("button", "Bericht aktualisieren"), close = element("button", "Zurück"); refresh.type = close.type = "button";
  let disposed = false;
  const load = async () => {
    refresh.disabled = true;
    try { const value = await input.api.report(); if (disposed) return; renderConductorControlReport(report, value); status.textContent = "Letzter bestätigter Abrechnungsstand."; }
    catch (error) { if (!disposed) status.textContent = error instanceof Error ? error.message : "Der Bericht konnte nicht geladen werden."; }
    finally { refresh.disabled = false; }
  };
  const leave = () => { disposed = true; dialog.close(); dialog.remove(); input.returnFocus.focus({ preventScroll: true }); };
  close.addEventListener("click", leave); refresh.addEventListener("click", () => { void load(); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); leave(); });
  dialog.append(title, status, report, refresh, close); document.body.append(dialog); dialog.showModal(); close.focus(); await load();
}
