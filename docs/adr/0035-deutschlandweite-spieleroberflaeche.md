# ADR-0035: Deutschlandweite Spieleroberfläche mit der LiveMap im Zentrum

- **Status:** Angenommen — bindend (entspricht E17); ersetzt ADR-0017.
- **Anlass:** Ausdrückliche Produktvorgabe vom 5. September 2026 für den
  vollständigen UI/UX-Neuaufbau auf Grundlage von PR #530.
- **Bezug:** [Design](../design.md), [Spieleroberfläche](../ux-spieler-shell.md),
  [Umsetzung mit Bildern](../ui-redesign/README.md).

## Entscheidung

Das Spiel erhält eine durchgehend dunkle Oberfläche mit deutscher Bahnatmosphäre,
eigener roter Gleismarke und gemeinsamer Navigation. Die LiveMap zeigt beim
Einstieg ganz Deutschland und verbindet Übersicht mit konkreten Entscheidungen.
Eine regionale Pilotstrecke bestimmt nicht mehr die Informationsarchitektur.

Der Nutzer hat die bisherigen Designleitplanken ausdrücklich aufgehoben.
Damit entfallen die Beschränkung auf eine achromatische Marke und die Vorgabe,
Markenrot grundsätzlich auszuschließen. Betriebliche Zustände bleiben durch
Text, Zahlen und Muster unterscheidbar.

Große Seiten werden in Aufgaben und Register aufgeteilt. Eingaben bleiben bei
Registerwechseln erhalten. Spielertexte beschreiben Handlungen: „Unternehmen
gründen“, „Fahrt planen“, „Als gelesen markieren“ und „Regeln aktivieren“.
Technische Nachweise sind bei Bedarf aufklappbar.

## Folgen

Die gemeinsame Identität liegt im Design-System; LiveMap, Spielverwaltung und
Betriebszentrale verwenden dieselbe Navigation. Der äußere Rahmen passt in den
Bildschirm. Lange Inhalte haben eigene Scrollbereiche. Mobil bleibt die
Hauptnavigation am unteren Bildschirmrand sichtbar.

Die UI verarbeitet die vorhandenen serverseitigen Daten und Kommandos.
Deutschlandweite Gestaltung erfindet weder Fahrten noch simulierte Positionen.
Fehlende und veraltete Daten werden als solche angezeigt. Berechtigungen,
bestätigte Bewegungen, Geldberechnung und Spielkommandos behalten ihre bisherigen
Verträge. Die Tooltip-Hilfe und die einzelne öffentliche Welt aus PR #530 bleiben erhalten.

Eine getrennte Vorschau mit gekennzeichneten Beispieldaten ermöglicht visuelle
Prüfungen ohne Anmeldung oder produktive Spielkommandos. Sie wird nicht in die
Produktionsanwendungen importiert.
