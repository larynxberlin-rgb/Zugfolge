import type { GameHint } from "@zugfolge/design-system";

export const MAP_HINTS: readonly GameHint[] = [
  { id: "map-entry", selector: "#journey-link", title: "In dieser Welt anfangen", text: "Hier prüfen Sie den Weltvertrag und gründen Ihr EVU. Danach führen Planung, Betrieb und Märkte zu den Entscheidungen für Ihr Unternehmen." },
  { id: "map-area", selector: "#fit-playable", title: "Das nutzbare Netz finden", text: "Diese Ansicht zeigt die spielbare Region. Klicken Sie auf einen Bahnhof, eine Strecke oder einen Zug, um die aktuellen Informationen zu öffnen." },
  { id: "map-trains", selector: "#object-list-title", title: "Züge auch ohne Kartenklick auswählen", text: "In dieser Liste erreichen Sie die sichtbaren Zugfahrten mit der Tastatur. Die Details zeigen die bestätigte Betriebslage; eigene Züge bieten zusätzliche Unternehmensinformationen." },
  { id: "map-rzue", selector: "#mode-rzue", title: "Belegungen nachvollziehen", text: "Die RZÜ stellt die betriebliche Lage schematisch dar. Nutzen Sie sie, um Zugpositionen, belegte Abschnitte und Fahrstraßen im Zusammenhang zu prüfen." },
];
