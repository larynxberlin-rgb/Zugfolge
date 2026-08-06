# ADR-0002: Kern-Loop ist das Betriebsprogramm

- **Status:** Angenommen — bindend (entspricht E2)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../betrieb.md](../betrieb.md)
- **Betrifft Milestones:** M4.4 (Dispositionsschnittstelle), M7 (Betriebsprogramm)
- **Verwandte ADRs:** [ADR-0013](0013-automatikmodus-kostenlos.md), [ADR-0019](0019-realismus-dient-dem-spiel.md)

## Kontext

Die Welten laufen dauerhaft in 1:1-Echtzeit, ohne Wipes. In einer solchen Welt
entsteht sofort ein Fairnessproblem: Wer mehr Stunden am Tag zusehen und
eingreifen kann, hätte einen strukturellen Vorteil — die Simulation würde
Zeitverfügbarkeit belohnen statt unternehmerische Qualität. Zugleich soll die
betriebliche Tiefe erhalten bleiben, die das Spiel ausmacht.

## Entscheidung

Der zentrale Spiel-Loop ist das **Betriebsprogramm**: ein vom Spieler
gebautes Dispo-Regelwerk, mit dem der Server den Betrieb fährt — auch und
gerade, während der Spieler offline ist. Der Spieler gestaltet Regeln, nicht
einzelne Klicks in Echtzeit.

## Begründung

Das Betriebsprogramm löst Offline-Fairness und betriebliche Tiefe in einem
Zug. Anwesenheit wird zum Komfort — man *kann* live eingreifen —, nicht zum
Wettbewerbsvorteil. Die Qualität des Regelwerks entscheidet, nicht die am
Bildschirm verbrachte Zeit.

## Konsequenzen

- **Erleichtert:** Macht den kostenlosen Automatikmodus (ADR-0013) überhaupt
  erst fair und trägt das gesamte Monetarisierungsmodell.
- **Kostet / schränkt ein:** Der Kern braucht einen definierten
  Entscheidungspunkt je Ereignis, an dem das Regelwerk greift. Diese
  Dispositionsschnittstelle muss früh eingezogen werden (M4.4), sonst müsste der
  fertige Simulationskern später aufgeschnitten werden.
- **Invarianten:** Das Regelwerk läuft im Simulationskern und muss
  deterministisch sein — kein `now()` (Invariante 2), Simulationszeit ist ein
  expliziter Wert.
- **Milestones:** M4.4 legt die Schnittstelle mit konservativem
  Standardverhalten an; M7 baut Regelmodell, Editor und Betriebszentrale aus.
