# ADR-0010: Trassenfinder ist Kalibrierwerkzeug, keine Laufzeitabhängigkeit

- **Status:** Angenommen — bindend (entspricht E10)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../daten.md](../daten.md)
- **Betrifft Milestones:** M0.4 (Rechte-Gate, Nutzungsbedingungen), M1.13 (Referenzkorpus)
- **Verwandte ADRs:** [ADR-0005](0005-rust-kern-typescript-plattform.md)

## Kontext

Es existiert ein externer Trassenfinder-Dienst, dessen Struktur und
Kostenkategorien als Modellierungscheckliste wertvoll sind. Es liegt nahe, ihn
zur Laufzeit für Fahrzeit- oder Entgeltberechnung zu nutzen, statt die
Berechnung selbst zu bauen.

## Entscheidung

Der Trassenfinder ist ausschließlich ein **Kalibrier- und Validierungswerkzeug
der Entwicklung**, keine Laufzeitabhängigkeit. Im Spielbetrieb wird er nicht
aufgerufen.

## Begründung

Determinismus und Replay verbieten einen externen Dienst im heißen Pfad — ein
Aufruf, dessen Antwort sich ändern kann, zerstört die Reproduzierbarkeit.
Zudem sind die Werte laut Betreiber unverbindliche Richtwerte aus vereinfachter
Berechnung, taugen also ohnehin nicht als verbindliche Laufzeitquelle. Als
Checkliste der Kostenkategorien und als Referenz zur Kalibrierung sind sie
dagegen nützlich.

## Konsequenzen

- **Erleichtert:** Die Entwicklung kann eigene Fahrzeit- und
  Entgeltberechnungen gegen den Trassenfinder kalibrieren, ohne eine
  Laufzeitbindung einzugehen.
- **Kostet / schränkt ein:** Alle im Betrieb benötigten Werte müssen selbst
  berechnet und in gepinnten Releases hinterlegt werden (`InfraRelease`,
  `EconomyRelease`). Die Nutzungsbedingungen des Trassenfinders sind im
  Rechte-Gate zu dokumentieren.
- **Invarianten:** Trägt Invariante 6 (kein externer Dienst im heißen Pfad) und
  stützt Invariante 3 (Determinismus).
- **Milestones:** M0.4 (Rechte-Gate inklusive Trassenfinder-Nutzungsbedingungen),
  M1.13 (Abweichungsreport gegen reale Fahrzeiten).
