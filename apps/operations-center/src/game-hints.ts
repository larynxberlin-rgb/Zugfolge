import type { GameHint } from "@zugfolge/design-system";

export const OPERATIONS_HINTS: readonly GameHint[] = [
  { id: "operations-refresh", selector: "#refresh", title: "Den Betrieb verfolgen", text: "Laden Sie den aktuellen Stand, bevor Sie eingreifen. Entscheidungen und Meldungen beziehen sich auf die vom Server bestätigten Fahrten Ihres EVU." },
  { id: "program-template", selector: "#program h2", title: "Regeln für den Alltag festlegen", text: "Wählen Sie eine passende Vorlage und passen Sie Bedingungen sowie Aktionen an. Das aktive Betriebsprogramm arbeitet auch weiter, wenn Sie nicht angemeldet sind." },
  { id: "program-backtest", selector: "#run-backtest", title: "Änderungen zuerst prüfen", text: "Der Rücktest zeigt, wie Ihre Regeln auf vorhandene Betriebsereignisse reagieren. Prüfen Sie die Ergebnisse, bevor Sie eine neue Programmversion speichern und aktivieren." },
  { id: "program-activate", selector: "#activate-program", title: "Die gespeicherte Version in Kraft setzen", text: "Speichern und Aktivieren sind getrennte Schritte. Erst die Aktivierung macht die gewählte Version für die laufende automatische Disposition wirksam." },
  { id: "dispatch-override", selector: "[data-open-override]", title: "Eine Entscheidung übersteuern", text: "Lesen Sie zuerst den Auslöser und die Begründung. Wählen Sie dann Ihre betriebliche Reaktion und geben Sie einen nachvollziehbaren Grund für den Eingriff an." },
  { id: "daily-report", selector: "#generate-report", title: "Aus dem Betriebstag lernen", text: "Der Tagesbericht fasst den belegten Verlauf für den gewählten Tag zusammen. Nutzen Sie ihn, um wiederkehrende Probleme zu erkennen und Ihr Betriebsprogramm gezielt anzupassen." },
];
