# ADR-0019: Realismus dient dem Spiel

- **Status:** Angenommen — bindend (entspricht E19)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../produkt.md](../produkt.md) · [../wirtschaft.md](../wirtschaft.md)
- **Betrifft Milestones:** M6.6 (schlanke Ausschreibung)
- **Verwandte ADRs:** [ADR-0002](0002-betriebsprogramm-als-kern-loop.md), [ADR-0012](0012-rangieren-nur-automatisiert.md), [ADR-0015](0015-baustellen-als-planungsverfahren.md), [ADR-0020](0020-fahrzeuge-konfiguriert-bestellt.md)

## Kontext

Das Projekt hat einen hohen Realismusanspruch. Unbegrenzt verfolgt, führt er in
Verwaltungsarbeit, die kein Spieler will: Vergabeakten, Formularketten,
Mikroschritte ohne Entscheidung. Die Zielgruppe sind interessierte Laien, keine
Betriebsplaner. Ohne eine klare Regel, wo Realismus endet, wächst er
unkontrolliert.

## Entscheidung

Realismus dient dem Spiel, nicht umgekehrt. Der Test lautet: *Erzeugt dieser
Schritt eine Entscheidung, die der Spieler interessant findet?* Wenn nein, wird
er abstrahiert oder weggelassen. **Gegenprobe:** Sperrzeiten, Konfliktprüfung,
Fahrdynamik, Umlaufbindung und Fristen werden **nicht** abstrahiert —
abstrahiert wird Verwaltung, nicht Betrieb.

## Begründung

Die Spieler sind interessierte Laien; für sie zählt die interessante
Entscheidung, nicht die vollständige Verwaltungstreue. Die Gegenprobe hält den
betrieblichen Kern scharf: Genau die Teile, die das Spiel einzigartig machen,
bleiben unverkürzt, während Formalismus ohne Entscheidungsgehalt entfällt.

## Konsequenzen

- **Erleichtert:** Die Ausschreibung bleibt schlank — Angebotsfrist 3–7 Tage,
  kleine Lose 24–48 Stunden, Zuschlag sofort, Angebot mit wenigen Feldern statt
  Vergabeakte. Rangieren (ADR-0012) und Fahrzeugkauf (ADR-0020) folgen derselben
  Regel.
- **Kostet / schränkt ein:** Jeder vorgeschlagene Detailgrad muss den Test
  bestehen; der betriebliche Kern (Sperrzeiten, Konflikt, Fahrdynamik, Umlauf,
  Fristen) ist von der Abstraktion ausdrücklich ausgenommen und darf nicht
  vereinfacht werden.
- **Milestones:** M6.6 (Angebotsabgabe mit wenigen Feldern, Fristen, sofortiger
  Zuschlag) ist die sichtbarste Anwendung.
