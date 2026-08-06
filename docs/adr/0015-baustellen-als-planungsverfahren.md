# ADR-0015: Baustellen sind ein eigenes Planungsverfahren

- **Status:** Angenommen — bindend (entspricht E15)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../betrieb.md](../betrieb.md)
- **Betrifft Milestones:** M8.5–M8.8 (Ankündigung, Ersatzkonzept, Wettlauf)
- **Verwandte ADRs:** [ADR-0004](0004-kapazitaetsschutz-gegen-landgrab.md), [ADR-0019](0019-realismus-dient-dem-spiel.md)

## Kontext

Baustellen könnten als bloßer Schaden modelliert werden — eine Strecke fällt
zufällig aus, der Betrieb bricht ein. Das wäre betrieblich unrealistisch und
spielerisch arm: Es erzeugt Frust, aber keine Entscheidung. Reale Baustellen
werden mit langem Vorlauf angekündigt und verlangen ein geplantes Ersatzkonzept.

## Entscheidung

Baustellen sind ein **eigenes Planungsverfahren**, kein bloßer Schaden.
Angekündigte Sperrungen mit Vorlauf, ein Ersatzkonzept als eigener
`PlanningRun` gegen die Restkapazität, und ein Wettlauf mehrerer EVU um
dieselbe Umleitungstrasse.

## Begründung

Als Planungsfenster statt Überraschung erzeugen Baustellen genau die
interessanten Entscheidungen, die „Realismus dient dem Spiel" (ADR-0019)
verlangt: umplanen, Ersatz konzipieren, um knappe Umleitungskapazität
konkurrieren. Der Netzfahrplan bleibt dabei konfliktfrei, weil das Ersatzkonzept
gegen dieselbe Konfliktprüfung läuft wie der reguläre Verkehr.

## Konsequenzen

- **Erleichtert:** Baustellen werden zu einem eigenen Spielinhalt mit
  Vorlauf, Wettbewerb um Umleitungstrassen und vertraglich abgestufter
  Behandlung (Minderung statt Pönale bei fristgerechtem Konzept).
- **Kostet / schränkt ein:** Es braucht ein eigenes Ankündigungs- und
  Planungsverfahren samt Maßnahmenkasten — deutlich mehr als ein Schadensflag.
  Die Umleitungskapazität ist knapp und umkämpft (ADR-0004).
- **Milestones:** M8.5 (Baustellenankündigung mit Vorlauf), M8.6 (Ersatzkonzept
  als eigener `PlanningRun`), M8.7 (Maßnahmenkasten), M8.8 (Wettlauf um
  Ersatzkapazität).
