import type { GameHint } from "@zugfolge/design-system";

export const OPERATIONS_HINTS: readonly GameHint[] = [
  {"id": "operations-refresh", "selector": "#refresh", "title": "Deine Züge im Blick", "text": "Hier siehst du aktuelle Meldungen und Entscheidungen deiner Bahn. Aktualisiere den Stand, bevor du selbst eingreifst."},
  {"id": "program-template", "selector": "#program h2", "title": "Deine Bahn fährt weiter", "text": "Mit Regeln legst du fest, wie deine Bahn auf Störungen reagiert. Die aktive Automatik arbeitet auch, wenn du offline bist."},
  {"id": "program-backtest", "selector": "#run-backtest", "title": "Erst ausprobieren", "text": "Teste deine gespeicherten Regeln an bisherigen Ereignissen. Schau dir an, was deine Bahn damit tun würde, bevor du die Regeln aktivierst."},
  {"id": "program-activate", "selector": "#activate-program", "title": "Jetzt übernimmt die Automatik", "text": "Speichere zuerst deinen Entwurf. Mit Regeln aktivieren wird diese Version für den laufenden Betrieb wirksam."},
  {"id": "dispatch-override", "selector": "[data-open-override]", "title": "Du entscheidest", "text": "Lies die Ursache und die bisherige Entscheidung. Wähle dann eine Maßnahme und begründe kurz deinen Eingriff."},
  {"id": "daily-report", "selector": "#generate-report", "title": "Aus jedem Tag lernen", "text": "Dein Tagesbericht zeigt Fahrten, Kosten und Entscheidungen. Erkenne wiederkehrende Probleme und passe deine Automatik daran an."},
];
