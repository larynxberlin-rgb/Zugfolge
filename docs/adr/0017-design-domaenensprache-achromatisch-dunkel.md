# ADR-0017: Design — Domänensprache, achromatische Marke, durchgehend dunkel

- **Status:** Ersetzt durch [ADR-0035](0035-deutschlandweite-spieleroberflaeche.md) am 5. September 2026. Der folgende Text dokumentiert die historische Entscheidung.
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../design.md](../design.md)
- **Betrifft Milestones:** M3.9 (Gestaltungssystem), M4.8 (Normalzustand farblos)
- **Verwandte ADRs:** [ADR-0006](0006-baureihen-faktisch-marken-eigen.md), [ADR-0009](0009-vollstaendige-transparenz-livemap.md)

## Kontext

Das Produkt soll eine deutsche Bahnanmutung tragen, ohne eine Firmenmarke zu
zitieren — das verbietet schon der Rechteschutz (ADR-0006). Zugleich ist Farbe
in einer Leitstellen-Oberfläche eine knappe Ressource: Wird sie für die Marke
verbraucht, steht sie für den Betriebszustand nicht mehr eindeutig zur
Verfügung.

## Entscheidung

Das Design spricht **Domänensprache statt Markenzitat**: Die Anmutung entsteht
über Signalfarblogik, Bildfahrplan-Konventionen und Leitstellendichte. Die
**Marke ist achromatisch**; Farbe gehört ausschließlich dem Betrieb. Die
Oberfläche ist **durchgehend dunkel** ohne Hellmodus, mit einer zweiten
Dichtestufe für die Lesbarkeit langer Texte. Die Wortmarke ist rein und wird
für kleine Größen auf ein Monogramm derselben Schrift gekürzt.

## Begründung

Weil Farbe dem Betrieb gehört, bleibt Rot als Alarmfarbe eindeutig — das ist
zugleich das stärkere Gestaltungsargument gegen ein Marken-Rot. Die
Domänensprache trägt die Atmosphäre glaubwürdiger als ein Markenzitat und
umgeht dessen Rechtsrisiko. Der durchgehend dunkle Grund entspricht der
Leitstellenanmutung; die zweite Dichtestufe verhindert, dass lange Texte darunter
leiden.

## Konsequenzen

- **Erleichtert:** Betriebszustände lassen sich eindeutig über Farbe codieren,
  weil die Marke keine beansprucht. Der Normalzustand bleibt farblos (ADR-0009,
  M4.8) — Farbe bedeutet immer etwas.
- **Kostet / schränkt ein:** Kein Hellmodus; keine Markenfarbe. Jede
  Oberflächenarbeit, jedes Diagramm und jede Zustandsdarstellung müssen sich an
  `design.md` halten — Farbe wird nicht dekorativ eingesetzt.
- **Milestones:** M3.9 (Gestaltungssystem konkretisieren: Farbwerte gegen reale
  Datendichte, Komponentenbibliothek, Icon-Set, beide Dichtestufen), M4.8
  (Zustandsdarstellung, Normalzustand farblos).
