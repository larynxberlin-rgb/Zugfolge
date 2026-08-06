# ADR-0013: Der Automatikmodus bleibt in öffentlichen Welten kostenlos

- **Status:** Angenommen — bindend (entspricht E13)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../geschaeft.md](../geschaeft.md)
- **Betrifft Milestones:** M13.3 (Entitlements), M13.8 (erweiterte Automatisierung privat)
- **Verwandte ADRs:** [ADR-0002](0002-betriebsprogramm-als-kern-loop.md), [ADR-0019](0019-realismus-dient-dem-spiel.md)

## Kontext

Das Spiel wird monetarisiert. Die gefährlichste Form wäre pay-to-win: Wer zahlt,
gewinnt. Weil der Kern-Loop das offline laufende Betriebsprogramm ist
(ADR-0002), wäre eine kostenpflichtige Automatik genau das — ein Vorteil auf dem
Umweg über Zeit, erkauft statt erspielt. Zugleich ist die Automatikstufe der
Boden, auf dem Kurzzeitspieler überhaupt stehen.

## Entscheidung

Der Automatikmodus bleibt in **öffentlichen Welten kostenlos**. Monetarisiert
werden Darstellung, Sammelbearbeitung, Exporte, Archivtiefe, Weltplätze und
Kosmetik. **Erweiterte Automatisierung** ist ausschließlich privaten Welten
vorbehalten.

## Begründung

Eine kostenpflichtige Automatik wäre pay-to-win über den Umweg Zeit. Dazu kommt
das geschäftliche Argument: Die Automatikstufe bedient das Segment mit der
niedrigsten Zahlungsbereitschaft; sie kostenpflichtig zu machen würde den
Einstiegstrichter verengen. Bezahlt wird für Komfort und Darstellung, nie für
Wettbewerbsvorteil in öffentlichen Welten.

## Konsequenzen

- **Erleichtert:** Kurzzeitspieler bleiben ohne Zahlung wettbewerbsfähig; der
  Einstieg bleibt weit offen.
- **Kostet / schränkt ein:** Kein Monetarisierungsmerkmal darf in öffentlichen
  Welten die Betriebsgüte beeinflussen. Erweiterte Automatisierung ist
  auf private Welten begrenzt.
- **Invarianten:** Trägt Invariante 5 — kein Payment-Tier-Feld in Planner,
  Nachfrage, Wirtschaft, Trassenvergabe oder Live-Disposition; ein CI-Wächter
  prüft das (M0.2).
- **Milestones:** M13.3 (Entitlements, Zugfolge Plus, Kosmetik, Weltplätze),
  M13.8 (erweiterte Automatisierung ausschließlich in privaten Welten).
