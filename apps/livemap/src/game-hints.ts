import type { GameHint } from "@zugfolge/design-system";

export const MAP_HINTS: readonly GameHint[] = [
  {"id": "map-entry", "selector": "#journey-link", "title": "Deine Bahn startet hier", "text": "Hier findest du deine Spielwelt und gründest dein Unternehmen. Danach führen Fahrplan, Betrieb und Markt zu deinen nächsten Entscheidungen."},
  {"id": "map-area", "selector": "#show-germany", "title": "Ein ganzes Land im Blick", "text": "Von Hamburg bis München: Die LiveMap zeigt dir das deutsche Schienennetz. Zoome näher heran und wähle einen Bahnhof oder Zug für Details."},
  {"id": "map-trains", "selector": "#train-search", "title": "Finde deinen Zug", "text": "Suche nach Zugnummer, Unternehmen oder nächstem Halt. Die Zugübersicht lässt sich auch mit der Tastatur bedienen. Meine Züge zeigt nur dein Unternehmen."},
  {"id": "map-rzue", "selector": "#mode-rzue", "title": "Ein Blick auf die Gleise", "text": "Das Gleisbild zeigt Zugpositionen, belegte Abschnitte und Fahrstraßen schematisch. So erkennst du leichter, wo Züge warten oder sich Wege kreuzen."},
];
