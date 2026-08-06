# ADR-0016: Lizenz PolyForm Shield 1.0.0 — Source Available

- **Status:** Angenommen — bindend (entspricht E16)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../geschaeft.md](../geschaeft.md)
- **Betrifft Milestones:** M0.2 (Lizenz-Scan), M0.5 (LICENSE, CLA)
- **Verwandte ADRs:** [ADR-0006](0006-baureihen-faktisch-marken-eigen.md)

## Kontext

Der Quelltext soll einsehbar sein, ohne dass daraus ein konkurrierendes
Produkt entstehen darf. Zwischen echter Open-Source-Lizenzierung und einem
reinen Closed-Source-Modell liegt das Feld „Source Available", das genau diese
Mischung erlaubt. Die Wortwahl ist dabei nicht kosmetisch: „Open Source" ist
ein definierter Begriff mit klaren Anforderungen.

## Entscheidung

Das Projekt steht unter **PolyForm Shield 1.0.0** und bezeichnet sich als
**Source Available, nicht Open Source**. Erlaubt ist jede Nutzung außer
konkurrierenden Produkten — ausdrücklich auch kostenlose und
plattformübergreifende Nutzung.

## Begründung

PolyForm Shield erlaubt weitreichende Nutzung und schließt allein das
Konkurrenzprodukt aus. Die Open Source Definition verlangt jedoch erlaubte
abgeleitete Werke und Nichtdiskriminierung nach Einsatzzweck — beides erfüllt
das Projekt bewusst nicht. Es „Open Source" zu nennen wäre daher falsch; die
präzise Bezeichnung ist „Source Available".

## Konsequenzen

- **Erleichtert:** Der Quelltext bleibt einsehbar und breit nutzbar, ohne dass
  ein Wettbewerber ihn gegen das Projekt wenden darf.
- **Kostet / schränkt ein:** Es gilt die Sprachregelung aus `CLAUDE.md` — das
  Projekt heißt durchgängig „Source Available", niemals „Open Source". Bis der
  Lizenzvolltext eingesetzt ist, trägt `LICENSE` einen Warnblock und ist **nicht
  gültig**.
- **Milestones:** M0.2 (Lizenz-Scan der Abhängigkeiten auf Verträglichkeit),
  M0.5 (LICENSE, CLA, Schichtentrennung von Code, Daten und Marke).
