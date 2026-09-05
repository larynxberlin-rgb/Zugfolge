import type { GameHint } from "@zugfolge/design-system";

export const GAME_HINTS: readonly GameHint[] = [
  {"id": "entry-contract", "selector": "#world-contract-title", "title": "Willkommen an Bord.", "text": "Hier siehst du Startkapital und Spielregeln. Wähle deinen Spielernamen und starte anschließend dein Unternehmen."},
  {"id": "found-company", "selector": "#evu-gruenden h2", "title": "Wie heißt deine Bahn?", "text": "Gib deinem Unternehmen einen Namen. Mit der Gründung erhältst du dein Startkapital. Auf dem Markt findest du danach Fahrzeuge und erste Aufträge."},
  {"id": "tender-offer", "selector": "#tender-bid-submit", "title": "Dein erster Verkehrsauftrag", "text": "Prüfe Strecke, Frist und Anforderungen. Dein Angebot sollte Fahrzeuge, Personal und Betriebskosten decken. Mit dem Absenden gibst du ein verbindliches Gebot ab."},
  {"id": "vehicle-offers", "selector": "#vehicle-market h2", "title": "Der richtige Zug für deine Strecke", "text": "Vergleiche Preis, Sitzplätze, Zustand und Zulassung. Reserviere ein passendes Fahrzeug und prüfe vor der Übernahme noch einmal die Kosten."},
  {"id": "cooperation-contracts", "selector": "#cooperation-contracts h2", "title": "Gemeinsam weiterkommen", "text": "Miete Fahrzeuge oder vereinbare Leistungen mit anderen Unternehmen. Achte auf Preis, Laufzeit und Kündigungsfrist."},
  {"id": "path-request", "selector": "[data-path-request] button[type=submit]", "title": "Eine neue Verbindung", "text": "Wähle deinen Zug, Start, Ziel und Abfahrtszeit. Wir prüfen, ob die Fahrt ins Netz passt. Erst nach der Bestätigung ist deine Trasse reserviert."},
  {"id": "planning-diagram", "selector": "#steps", "title": "So liest du deinen Fahrplan", "text": "Jede Linie ist eine Zugfahrt: waagerecht läuft die Zeit, senkrecht folgen die Bahnhöfe. Mit Sperrzeiten siehst du, wann ein Abschnitt belegt ist."},
  {"id": "planning-alternative", "selector": "[data-apply-alternative]", "title": "Mach Platz für deinen Zug", "text": "Hier findest du eine passende Alternative zum Zeitkonflikt. Prüfe die neue Abfahrt und bestätige, wenn sie zu deiner Planung passt."},
  {"id": "company-finances", "selector": ".company-balance", "title": "Dein finanzieller Spielraum", "text": "Vorgemerkte Ausgaben sind vom verfügbaren Geld bereits abgezogen. Dieser Betrag hilft dir bei der Planung deiner nächsten Investition."},
  {"id": "mailbox-deadlines", "selector": "#attention-title", "title": "Nichts verpassen", "text": "Öffne eine Nachricht, um zur passenden Entscheidung zu gelangen. Als gelesen markieren bestätigt nur die Nachricht; Aufträge und Käufe bleiben eigene Entscheidungen."},
];
