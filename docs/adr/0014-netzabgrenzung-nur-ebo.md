# ADR-0014: Netzabgrenzung: ausschließlich EBO

- **Status:** Angenommen — bindend (entspricht E14)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../produkt.md](../produkt.md) · [../daten.md](../daten.md)
- **Betrifft Milestones:** M1.3 (Netzfilter)
- **Verwandte ADRs:** —

## Kontext

Das Netz muss eine klare Außengrenze haben — sonst franst es an Straßenbahnen,
Stadtbahnen, U-Bahnen, Schmalspur- und Werksbahnen aus, jeweils mit eigenem
Regelwerk und eigenen Grenzfällen. Solche Grenzfälle sind im automatisierten
Import besonders teuer, weil jeder Sonderfall eine eigene Entscheidung
verlangt.

## Entscheidung

Die Netzabgrenzung folgt **ausschließlich der EBO**, ohne Übergang zu BOStrab.
Straßenbahn, Stadtbahn, U-Bahn (BOStrab), Schmalspur (ESBO) und Bus kommen
nicht vor; ein Wechsel zwischen den Regelwerken wird nicht umgesetzt. Innerhalb
der EBO bleiben betrieblich abgetrennte Stromschienennetze über eine
Netzausschlussliste draußen.

## Begründung

Die Regelwerksgrenze der EBO ist eindeutig, im Import prüfbar und kennt keine
Grenzfälle. Sie an einem Kriterium festzumachen, das sich aus den Daten
ableiten lässt, macht den Netzfilter deterministisch und wartbar — im Gegensatz
zu einer Abgrenzung, die von Fall zu Fall entschieden werden müsste.

## Konsequenzen

- **Erleichtert:** Der Netzfilter ist maschinell entscheidbar: `railway=rail`
  in 1435 mm bleibt, alles andere wird verworfen oder über die
  Ausschlussliste ausgeschlossen.
- **Kostet / schränkt ein:** Mischbetriebe und Regelwerksübergänge sind kein
  Spielinhalt — bewusst, nicht aus Versehen. Betriebs-, Abstell- und
  Anschlussgleise müssen dennoch erhalten bleiben und dürfen nicht mit den
  ausgeschlossenen Netzen weggefiltert werden.
- **Milestones:** M1.3 (Netzfilter: nur `railway=rail` in 1435 mm; Tram,
  Stadtbahn, U-Bahn, Schmalspur, Standseil- und Einschienenbahnen verwerfen;
  Stromschienennetze über Netzausschlussliste).
