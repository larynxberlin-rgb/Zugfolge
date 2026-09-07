import type { ConductorApi } from "./conductor-api.js";

/** Gemeinsamer Eigentümer-Einstieg; sämtliche Berechtigungen prüft der Server. */
export async function appendConductorEntry(input: {
  readonly host: HTMLElement;
  readonly api: ConductorApi;
  readonly trainLabel: string;
  readonly worldLabel?: string;
  readonly operatorLabel?: string;
  readonly isCurrent: () => boolean;
}): Promise<void> {
  const section = document.createElement("section"); section.className = "owner-action conductor-entry";
  section.setAttribute("aria-label", "Schaffnermodus");
  const entry = document.createElement("button"); entry.type = "button";
  entry.textContent = "Als Schaffner mitfahren"; entry.disabled = true;
  const note = document.createElement("p"); note.setAttribute("role", "status");
  note.textContent = "Verfügbarkeit der Fahrt wird geprüft …";
  const report = document.createElement("button"); report.type = "button"; report.textContent = "Kontrollbericht";
  const current = () => section.isConnected && input.isCurrent();
  report.addEventListener("click", async () => {
    if (!current()) return;
    const { openConductorReport } = await import("./conductor-report.js");
    if (current()) await openConductorReport({ api: input.api, trainLabel: input.trainLabel, returnFocus: report });
  });
  section.append(entry, report, note); input.host.append(section);
  try {
    const available = await input.api.availability();
    if (!current()) return;
    entry.disabled = false;
    entry.textContent = available.sessionId === null ? "Als Schaffner mitfahren" : "Schaffnersitzung fortsetzen";
    note.textContent = "Begehbarer Innenraum, Fahrgäste und Fahrkartenkontrolle in deiner aktuellen Fahrt.";
    entry.addEventListener("click", async () => {
      if (!current()) return;
      entry.disabled = true;
      try {
        const { openConductorMode } = await import("./conductor-mode.js");
        if (current()) await openConductorMode({ api: input.api, trainLabel: input.trainLabel,
          ...(input.worldLabel === undefined ? {} : { worldLabel: input.worldLabel }),
          ...(input.operatorLabel === undefined ? {} : { operatorLabel: input.operatorLabel }), returnFocus: entry });
      } catch (error) {
        if (current()) note.textContent = error instanceof Error ? error.message : "Der Schaffnermodus konnte nicht geöffnet werden.";
      } finally { if (current()) entry.disabled = false; }
    });
  } catch (error) {
    if (current()) note.textContent = error instanceof Error ? error.message : "Der Schaffnermodus ist für diese Fahrt nicht verfügbar.";
  }
}
