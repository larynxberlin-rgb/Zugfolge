# ADR-0006: Baureihennummern faktisch, Marken eigen

- **Status:** Angenommen — bindend (entspricht E6)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../geschaeft.md](../geschaeft.md)
- **Betrifft Milestones:** M5.1 (getrennte Felder Baureihe/Handelsname)
- **Verwandte ADRs:** [ADR-0016](0016-lizenz-polyform-shield.md), [ADR-0017](0017-design-domaenensprache-achromatisch-dunkel.md)

## Kontext

Das Spiel bildet reale Fahrzeuge und ein reales Netz ab. Damit stellt sich die
Frage, was rechtlich übernommen werden darf und was geschützt ist. Zwischen
sachlichen Angaben und geschützten Zeichen verläuft eine klare Linie, die im
Zweifel teuer wird, wenn man sie erst spät zieht.

## Entscheidung

Baureihenbezeichnungen und technische Daten werden **faktisch** übernommen.
Herstellerproduktnamen, EVU-Marken, Zuggattungsmarken, Lackierungen und Logos
sind geschützte Zeichen und werden durch **eigene** Marken ersetzt.

## Begründung

Baureihennummern und technische Kennwerte sind sachliche Angaben ohne
markenrechtlichen Schutz — sie herzustellen schafft Wiedererkennung ohne
Rechtsrisiko. Produktnamen, Unternehmens- und Gattungsmarken, Farbgebungen und
Logos dagegen sind geschützt; ihre Verwendung wäre eine Rechtsverletzung.

## Konsequenzen

- **Erleichtert:** Fahrzeuge bleiben faktisch wiedererkennbar; die
  Domänenanmutung (ADR-0017) trägt die Atmosphäre statt eines Markenzitats.
- **Kostet / schränkt ein:** Für jede Produkt-, Unternehmens- und
  Gattungsmarke muss ein eigenes Pendant erdacht werden. Baureihenbezeichnung
  und Handelsname sind getrennte Datenfelder, nicht ein Feld.
- **Milestones:** M5.1 führt den Fahrzeugkatalog mit getrennten Feldern für
  Baureihenbezeichnung und Handelsname. Der Rechteschutz insgesamt gehört zu
  M0.5 (Schichtentrennung von Code, Daten und Marke).
