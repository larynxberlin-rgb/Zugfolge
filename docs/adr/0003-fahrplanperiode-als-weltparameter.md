# ADR-0003: Fahrplanperiode ist ein Weltparameter, 3–8 Wochen

- **Status:** Angenommen — bindend (entspricht E3)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../infrastruktur.md](../infrastruktur.md)
- **Betrifft Milestones:** M3.6 (Fahrplanperiode als Ablauf)
- **Verwandte ADRs:** [ADR-0018](0018-weltlaufzeit-und-skalierende-perioden.md)

## Kontext

Eine dauerhaft laufende Echtzeitwelt braucht einen Takt, an dem sich
Fahrplanwechsel, Trassenanmeldung und Veröffentlichung ausrichten. Ohne einen
solchen Puls gäbe es keinen definierten Stichtag, zu dem Änderungen wirksam
werden, und keinen wiederkehrenden Rhythmus, den Spieler erleben.

## Entscheidung

Die Fahrplanperiode ist ein **Weltparameter** mit einer Länge von 3 bis 8
Wochen. Acht Wochen gelten für die unbefristete Welt; kürzere Welten stauchen
die Periode.

## Begründung

Die Periode gibt dem 1:1-Weltlauf einen Puls und deckt sich mit dem Grundsatz,
dass Updates nur zu angekündigten Fahrplanstichtagen wirksam werden. Eine feste
Länge würde kurzen Welten nicht gerecht: Erst die Staffelung nach Weltlaufzeit
(ADR-0018) hält den Saison-Rhythmus überall mehrfach erlebbar.

## Konsequenzen

- **Erleichtert:** Ein klarer Stichtag für Trassenvergabe, Betriebsübergänge
  und Veröffentlichungen. Änderungen sammeln sich bis zum nächsten Stichtag.
- **Kostet / schränkt ein:** Die Periodenlänge ist nicht frei, sondern an die
  Weltlaufzeit gekoppelt (ADR-0018) — sie kann nicht unabhängig gewählt werden.
- **Milestones:** M3.6 baut den Periodenablauf aus — Anmeldefenster,
  Koordinierung, Veröffentlichung, Betrieb.
