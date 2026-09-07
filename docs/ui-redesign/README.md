# Zugfolge: neue Spieleroberfläche

Umsetzung auf Grundlage von PR #530. Die LiveMap wird zur deutschlandweiten
Spielübersicht. Eine gemeinsame dunkle Oberfläche mit eigener roter Gleismarke
verbindet Karte, Fahrplan, Betrieb, Markt und Unternehmen.

Zur Weiterarbeit gehören [Design und Spielertexte](../design.md),
[Navigation und Spielerwege](../ux-spieler-shell.md),
[Zeichen und Symbole](../brand/README.md) sowie die
[zugeordneten GitHub-Abnahmen](issue-abgleich.md).

## LiveMap

![LiveMap mit Deutschlandübersicht](screenshots/map.png)

Die Karte startet mit ganz Deutschland. Zugfilter, Suche und eine ausklappbare
Zugübersicht ergänzen die geografische Auswahl. Auffällige Fahrten stehen im
Infobereich zuerst. Zugdetails öffnen sich direkt über der Karte. Die Zahlen
kommen aus dem jeweils empfangenen Stream und berücksichtigen den aktiven Filter.

## Unternehmen gründen

![Unternehmen gründen](screenshots/foundation.png)

Der Einstieg führt über Spielername und Spielregeln zur eigenen Bahn.
„Weltvertrag“ heißt in der Oberfläche „Dein Einstieg“; die eigentliche
Gründung heißt „Unternehmen gründen“. Startkapital und Bedingungen bleiben
zugänglich. Die bestehenden Bestätigungen für verbindliche Entscheidungen
bleiben erhalten.

## Weitere Ansichten

| Ansicht | Bildschirmfoto |
| --- | --- |
| Spiel starten | [Einstieg](screenshots/entry.png) |
| Zug auswählen | [Zugdetails](screenshots/train-details.png) |
| Unternehmen und Finanzen | [Unternehmen](screenshots/company.png) |
| Eigene Fahrzeuge | [Flotte](screenshots/fleet.png) |
| Verkehrsaufträge | [Aufträge](screenshots/markets.png) |
| Fahrzeuge kaufen oder mieten | [Fahrzeugmarkt](screenshots/vehicles.png) |
| Verträge zwischen Unternehmen | [Zusammenarbeit](screenshots/cooperation.png) |
| Fahrt, Leerfahrt und Werkstatt | [Fahrten planen](screenshots/workshop.png) |
| Nachrichten und Fristen | [Postfach](screenshots/mailbox.png) |
| Betriebsentscheidungen | [Betriebszentrale](screenshots/operations.png) |
| Regeln für den Betrieb | [Automatik](screenshots/program.png) |
| Tagesberichte | [Berichte](screenshots/reports.png) |
| Zeitliche Planung | [Bildfahrplan](screenshots/planner.png) |
| Mobile LiveMap | [Karte auf dem Handy](screenshots/map-mobile.png) |
| Mobiles Unternehmen | [Unternehmen auf dem Handy](screenshots/company-mobile.png) |
| Mobiler Markt | [Markt auf dem Handy](screenshots/markets-mobile.png) |
| Mobiler Betrieb | [Betrieb auf dem Handy](screenshots/operations-mobile.png) |
| Mobiler Fahrplan | [Fahrplan auf dem Handy](screenshots/planner-mobile.png) |

## Fahrzeugmarkt und öffentliches Fahrzeugregister (M12.2)

Der Fahrzeugmarkt zeigt Kaufpreis beziehungsweise Gesamtmiete, Zustand,
Laufleistung und die tatsächlichen Angebots-, Reservierungs- und Wartungsfristen
in kompakten Handelszeilen. Kauf und Miete lassen sich getrennt filtern;
aufgeklappte Angebotsdetails zeigen Mechanik, Antrieb, Bremsen und Ausstattung.
Fehlende Zustands- oder Wertangaben bleiben als unbekannt erkennbar.

Das öffentliche Fahrzeugregister ist unabhängig von aktuellen Marktangeboten
und einem eigenen Unternehmen zugänglich. Flotte und Angebote öffnen denselben
dauerhaft verlinkten Fahrzeugpass. Auch weiterverkaufte, zurückgegebene und
ausgemusterte Fahrzeuge bleiben auffindbar. Der Pass zeigt den Datenstand,
Eigentümer und Halter, Zustands- und Wartungsdaten sowie einen lesbaren,
seitenweise vollständig zugänglichen Lebenslauf. Technische Belege lassen sich
zusätzlich aufklappen.

| Ansicht | Bildschirmfoto |
| --- | --- |
| Kauf- und Mietangebote | [Fahrzeugmarkt](screenshots/m12-vehicles.png) |
| Öffentlicher Fahrzeugpass | [Fahrzeugpass](screenshots/m12-passport.png) |
| Fahrzeugpass auf dem Handy | [Mobiler Fahrzeugpass](screenshots/m12-passport-mobile.png) |

**Diese Screenshots zeigen die implementierten Oberflächen mit gekennzeichneten
Beispieldaten.** Die Vorschaukarte ist ein vereinfachtes Schema Deutschlands;
Korridore und Züge sind illustrative Testdaten. Im Spiel bleibt die vorhandene
selbst gehostete Karte mit ihren bestätigten Zugpositionen maßgeblich.
Der Bildfahrplan zeigt einen einzelnen Beispielabschnitt innerhalb Deutschlands.

Der [KI-Designentwurf](design-concept-deutschland.png) ist eine Konzeptgrafik.
Er ist separat von den Browser-Screenshots abgelegt und behauptet keine
bereits vorhandenen Spielkennzahlen oder zusätzlichen Backend-Funktionen.

## Lokal ansehen und prüfen

Nach `pnpm install --frozen-lockfile` zunächst die beteiligten Anwendungen
einschließlich ihrer Abhängigkeiten bauen:

```sh
pnpm --filter @zugfolge/game-web... --filter @zugfolge/livemap... --filter @zugfolge/operations-center... build
node tools/ui-preview/server.mjs
```

Anschließend `http://127.0.0.1:4173/?screen=map` öffnen. Weitere Startansichten
lassen sich mit `screen=foundation`, `company`, `markets`, `workshop`, `mailbox`,
`operations`, `program`, `reports` oder `planner` aufrufen. Die Vorschau schreibt
keine produktiven Spielzustände. Ihre Daten werden nicht von den
Produktionsanwendungen importiert.

In einem zweiten Terminal:

```sh
node tools/ui-preview/check.mjs
pnpm --no-bail --filter @zugfolge/design-system --filter @zugfolge/game-web --filter @zugfolge/livemap --filter @zugfolge/operations-center test
```

Der Browsercheck verwendet unter Windows das installierte Edge. Auf anderen
Systemen kann `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` auf Chromium zeigen.
`UI_PREVIEW_PORT` und `UI_PREVIEW_ORIGIN` erlauben einen anderen lokalen Port.

Der Nachweis umfasst 34 Layouts bei 1440×900, 1366×768, 1024×768, 390×844 und
320×844 Pixeln, Register per Tastatur und Fragmentlink, Eingaben beim
Registerwechsel, geöffnete Formulare beim Aktualisieren, eigene Züge,
Zugsuche, Detailansicht sowie eingeblendete Spielhinweise auf 320 Pixeln. Das maschinenlesbare Ergebnis steht in
[screenshots/qa.json](screenshots/qa.json). Die 207 Tests der vier beteiligten
Pakete und acht bestehende Browsertests im gebauten Spiel ergänzen
diesen UI-Nachweis: drei zur Tooltip-Hilfe und fünf zur Betriebszentrale
einschließlich Eingabe-, Fokus- und Dialogerhaltung bei Live-Aktualisierungen.
Ein vollständiger Produktions-, Last- oder Anmeldetest ist
damit nicht verbunden.

### Zusätzlicher Nachweis für M12.2

Bei laufender Vorschau prüft der folgende Befehl ausschließlich den ergänzten
Fahrzeugmarkt, das Register, die Fahrzeugpässe und das Formular zur Betriebsaufgabe.
Er schreibt die drei oben verlinkten M12-Screenshots und
[`m12-qa.json`](screenshots/m12-qa.json); die bisherigen Screenshots bleiben erhalten.

```sh
node tools/ui-preview/check-vehicle-market.mjs
```

Der Nachweis umfasst **17 Layoutprüfungen** bei 1440, 1024, 390 und 320 Pixeln:
keinen horizontalen Überlauf oder Dokumentscroll, Kauf-/Mietfilter, Suche,
Register per Tastatur, erhaltene Formularwerte und Fokus beim Aktualisieren,
Schließen von Angebotsdetails mit Escape sowie direkt verlinkte, verkaufte und
ausgemusterte Fahrzeuge mit lesbarer Historie. Das Formular zur Betriebsaufgabe
erhält seine Preise beim Registerwechsel; die Bestätigung bleibt ausdrücklich
erforderlich.

**Vier Browsertests am gebauten Spiel** prüfen die bestehenden Spielhinweise
und die Betriebsaufgabe. Der neue
Bestätigungstest belegt: Vor dem Dialog und nach Abbrechen wird kein
`fleet-exit`-POST gesendet; Abbrechen erhält den eingegebenen Preis. Erst die
ausdrückliche Bestätigung sendet genau einen Aufruf mit Integer-Centpreisen.
Ausführung unter PowerShell nach dem oben beschriebenen Abhängigkeitsbuild:

```powershell
pnpm --filter @zugfolge/game-web build
$env:ZUGFOLGE_BROWSER_E2E = "1"
pnpm --filter @zugfolge/game-api exec vitest run src/game-hints.browser.test.ts --maxWorkers=1
```

Die Browserprüfungen verwenden gekennzeichnete Beispieldaten beziehungsweise
lokale API-Testantworten. Sie ersetzen keine Abnahme einer laufenden öffentlichen
Spielwelt oder einen vollständigen manuellen Zugänglichkeitsaudit.

## Inspiration und Gestaltung

AirlineSim diente als Inspiration für den Wechsel zwischen Unternehmensüberblick,
Fahrzeugen und operativen Entscheidungen. Verwendet wurden die offiziellen
Beschreibungen des [Unternehmensüberblicks](https://handbook.airlinesim.aero/en/docs/user-interface/company-overview/)
und des [Betriebsbereichs](https://handbook.airlinesim.aero/en/docs/user-interface/operations-tab/).
Layout, Zeichen, Farben und Texte wurden eigenständig für Zugfolge aufgebaut.
Die [Bildherkunft](images.md) dokumentiert die generierte Zugaufnahme.
