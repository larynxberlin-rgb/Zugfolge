# ADR-0018: Weltlaufzeit 6–18 Monate oder unbefristet; Perioden skalieren mit

- **Status:** Angenommen — bindend (entspricht E18)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../produkt.md](../produkt.md) · [../wirtschaft.md](../wirtschaft.md)
- **Betrifft Milestones:** M6.3 (WorldProfile), M6.3a (Vergabekalender), M9.8 (Weltende)
- **Verwandte ADRs:** [ADR-0003](0003-fahrplanperiode-als-weltparameter.md), [ADR-0007](0007-eigenbetrieb-bei-gescheiterter-ausschreibung.md), [ADR-0008](0008-insolvenz-als-totalverlust.md)

## Kontext

Welten werden nie zurückgesetzt, sollen aber unterschiedlich lang laufen — von
einer halbjährigen bis zur unbefristeten Welt. Eine feste Achtwochenperiode
(ADR-0003) ergäbe in einer Sechsmonatswelt nur drei Perioden: Der
Saison-Rhythmus wäre nicht spürbar und keine Ausschreibung vollständig
durchlaufbar. Ohne gestaffelte Vertragsenden gäbe es zudem Phasen ganz ohne
Markt.

## Entscheidung

Die Weltlaufzeit beträgt **6–18 Monate oder ist unbefristet**; Perioden- und
Vertragslängen **skalieren mit**. Zielgrößen über alle Weltlängen: rund 8–11
Fahrplanperioden und 3–4 Vergabezyklen je Welt. Vertragsenden werden gestaffelt.
Der Betriebsübergang erfolgt ausschließlich zum Fahrplanstichtag; bis dahin
fährt der Altbetreiber mit vollen Pflichten weiter. Beim Weltstart hält der
Eigenbetrieb alle Lose; sie werden nach einem veröffentlichten, aus dem Weltseed
erzeugten Vergabekalender in gleichmäßigen Fenstern freigegeben — Permutation
statt Ziehung, geschichtet nach Losgröße. Eine Welt endet mit einer
Schlusswertung.

## Begründung

Nur mitskalierende Perioden halten den Saison-Rhythmus über alle Weltlängen
spürbar und jede Ausschreibung vollständig durchlaufbar. Gestaffelte
Vertragsenden sorgen dafür, dass durchgehend Markt herrscht. Der aus dem Seed
erzeugte Vergabekalender macht die Losfreigabe reproduzierbar und im Nachhinein
prüfbar.

## Konsequenzen

- **Erleichtert:** Kurze und lange Welten fühlen sich gleichermaßen vollständig
  an; der Markt bleibt durchgehend lebendig. Der Übergang zum Stichtag
  verhindert Qualitätsverfall in den letzten Wochen (ADR-0008 greift bis zuletzt).
- **Kostet / schränkt ein:** Perioden- und Vertragslängen sind nicht frei,
  sondern aus der Weltlaufzeit abgeleitet. Beim Weltentwurf ist zu prüfen, dass
  sich Erst- und Wiedervergabe überlappen.
- **Invarianten:** Der Vergabekalender entsteht aus dem Seed-Substream
  `tender_release` und ist damit deterministisch (Invariante 2/3-nah, Replay).
- **Milestones:** M6.3 (`WorldProfile`), M6.3a (Vergabekalender), M9.8
  (Weltende: letzte Periode ohne Ausschreibung, Schlusswertung, Archiv).
