# ADR-0010: Trassenfinder als optionales externes Planungs- und Kalibrierwerkzeug

- **Status:** Angenommen — bindend (entspricht E10); am 07.09.2026 im ausdrücklichen Nutzerauftrag erweitert
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../daten.md](../daten.md) · [../trassenfinder-routenimport.md](../trassenfinder-routenimport.md) · [../rechte.md](../rechte.md#4-trassenfinder-nutzungsbedingungen-e10)
- **Betrifft Milestones:** M0.4 (Rechte-Gate, Nutzungsbedingungen), M1.13 (Referenzkorpus), Spielerplanung eigener Fahrten
- **Verwandte ADRs:** [ADR-0005](0005-rust-kern-typescript-plattform.md)

## Kontext

Die Struktur des externen Trassenfinders und seine Kostenkategorien helfen bei
der Entwicklung eigener Modelle. Selbst bestellte Fahrten brauchen außerdem
eine verständliche Möglichkeit, den gewünschten Laufweg festzulegen. Der
Nutzerauftrag vom 07.09.2026 ergänzt dafür eine Verknüpfung zur öffentlichen
Weboberfläche und die Übernahme einer selbst exportierten Routendatei.

Die bisherige Beschränkung auf Entwicklungskalibrierung wird für diese
unmittelbare, nutzergesteuerte Eingabe erweitert. Der Trassenfinder darf weder
Simulation noch Entgeltberechnung oder Trassenvergabe übernehmen.

## Entscheidung

Der Trassenfinder ist ein **optionales externes Planungs- und
Kalibrierwerkzeug**, keine Laufzeitabhängigkeit. Der Spieler öffnet die externe
Weboberfläche selbst, plant dort eine einzelne Route und wählt anschließend
deren „CSV-Export des Laufwegs“ lokal in Zugfolge aus.

Der Browser liest nur die geordnete Betriebsstellenfolge als Fahrwegwunsch.
Die Rohdatei bleibt lokal und wird weder hochgeladen noch im Repository,
Browserarchiv oder Spieljournal aufbewahrt. Die gewählten Kennungen müssen
vollständig auf Stationen des gepinnten Weltreleases aufgelöst werden.
Automatisch erfolgt das nur bei einem eindeutigen exakten Katalogcode.
Unbekannte oder mehrdeutige Kürzel erfordern für jeden Punkt eine ausdrückliche
Auswahl durch den Spieler, ohne Namensheuristik, Vorgabewert oder Auslassen.
Diese lokale Auswahl ist ein Fahrwegwunsch, kein dauerhafter Alias und kein
Nachweis einer RIL-100-Identität. Eine deutschlandweite automatische
Kürzelzuordnung ist nicht Bestandteil dieser Erweiterung.
Erst diese nativen Stationskennungen gelangen in den normalen Planungsantrag.
Zwischenpunkte sind Durchfahrtvorgaben; Halte bleiben getrennte Entscheidungen.

Der Server prüft den gesamten Fahrweg mit eigener Infrastruktur und der
bestehenden Trassenautorität. Fremde Fahrzeiten, Haltezeiten, Physik, Geometrie,
Streckeneigenschaften, Preise oder Energiezahlen werden nicht übernommen.
Zugfolge ruft keine Trassenfinder-API auf, automatisiert keine Webabfragen und
bestellt keine reale DB-Trasse. Ein nicht zuordenbarer oder nicht befahrbarer
Laufweg wird vollständig abgelehnt.

## Begründung

Ein externer Dienst im heißen Pfad würde Reproduzierbarkeit und Verfügbarkeit
der Spielwelt von einem fremden System abhängig machen. Auch manuell
exportierte Richtwerte sind keine verbindliche Betriebswahrheit. Eine vom
Spieler gewählte Stationsfolge lässt sich dagegen wie ein direkt eingegebener
Fahrwegwunsch gegen den eigenen Weltzustand prüfen und deterministisch
verarbeiten.

Die Erweiterung ist eine dokumentierte Projektentscheidung im Nutzerauftrag.
Sie behauptet keine neue Lizenz oder Betreiberfreigabe für Speicherung,
systematische Auswertung oder Weiterveröffentlichung externer Datenbestände.
Die bisherigen Quellen- und Rechte-Gates bleiben für diese Nutzungen bestehen.

## Konsequenzen

- Die eigene Routenwahl bleibt ohne Trassenfinder nutzbar; Ausfall oder Änderung
  des externen Angebots blockieren das Spiel nicht.
- Der lokale CSV-Importer besitzt einen engen, belegten Formatvertrag und
  meldet unverständliche Dateien oder unbekannte Betriebsstellen ausdrücklich.
  Der Spieler löst jeden nicht automatisch eindeutigen Punkt ausdrücklich auf.
  Danach wird die gesamte Stationsfolge einschließlich ihrer Verbindungen
  erneut geprüft. Der Importer darf keine Teilroute oder ähnlich benannte
  Station stillschweigend wählen und speichert keine Kürzelzuordnungen.
- Der Planungsantrag speichert native Stationskennungen und Durchfahrtvorgaben.
  Spielinfrastruktur, Fahrdynamik, Verfügbarkeit, Konflikte, Nachfrage und
  Entgelte bleiben an die eigenen Releases und Autoritäten gebunden.
- Entwicklungskalibrierungen behalten ihren getrennten, eng begrenzten
  Nachweisweg. Weder Exportdateien noch fremde Routenergebnisse werden zu einem
  wiederverwendbaren Referenzkorpus oder Infrastrukturrelease.
- Invariante 6 (kein externer Dienst im heißen Pfad), die deterministische
  Verarbeitung und Invariante 8 (dokumentierte Rechteentscheidung) bleiben
  unverändert. Der konkrete Eingabe- und Prüfvertrag steht in
  [Trassenfinder-Routenimport](../trassenfinder-routenimport.md).
