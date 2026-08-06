# ADR-0012: Rangieren ist ausschließlich automatisiert

- **Status:** Angenommen — bindend (entspricht E12)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../betrieb.md](../betrieb.md)
- **Betrifft Milestones:** M5.9 (Rangieraufwand), M11.2 (Zugbildung im SGV)
- **Verwandte ADRs:** [ADR-0019](0019-realismus-dient-dem-spiel.md)

## Kontext

Rangieren ließe sich als einzeln steuerbare Bewegung modellieren — Lok an,
kuppeln, umsetzen, abstellen. Das ist die Ebene, auf der betriebliche
Detailtiefe in reine Klickarbeit umschlägt: viel Interaktion, kaum
Entscheidung. Zugleich ist der Rangieraufwand betrieblich real und darf nicht
verschwinden.

## Entscheidung

Rangieren ist **ausschließlich automatisiert**. Der Spieler plant das Ergebnis —
Formation, Gleis, Reihenfolge —, nie die Bewegung. Rangieraufwand wird als
Zeitbedarf und kurzzeitige Anlagenbelegung verrechnet. Das gilt auch im
Güterverkehr.

## Begründung

Einzeln steuerbare Rangierbewegungen wären reine Klickarbeit ohne
interessante Entscheidung — ein Widerspruch zu „Realismus dient dem Spiel"
(ADR-0019). Als Zeitbedarf und kurzzeitige Belegung bleibt der Aufwand
betrieblich wirksam, ohne den Spieler zu Mikromanagement zu zwingen.

## Konsequenzen

- **Erleichtert:** Die Planung bleibt auf der Ergebnisebene; der Rangieraufwand
  fließt über dieselbe Konfliktengine wie der Fahrweg in Kapazität und Zeit ein.
- **Kostet / schränkt ein:** Es gibt bewusst keine manuelle
  Rangiersteuerung — auch nicht als Option. Der automatisierte Aufwand muss
  betrieblich plausibel bemessen sein, damit er als Kosten- und Zeitfaktor
  ernst genommen wird.
- **Milestones:** M5.9 (Rangieraufwand als Zeitbedarf und kurzzeitige Belegung),
  M11.2 (Zugbildung im SGV — Rangieren bleibt auch dort automatisiert).
