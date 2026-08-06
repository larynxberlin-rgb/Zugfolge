# ADR-0001: SPNV ist das erste vollständig spielbare Geschäftsfeld

- **Status:** Angenommen — bindend (entspricht E1)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../produkt.md](../produkt.md)
- **Betrifft Milestones:** M6 (SPNV), M10 (SPFV), M11 (SGV)
- **Verwandte ADRs:** [ADR-0007](0007-eigenbetrieb-bei-gescheiterter-ausschreibung.md), [ADR-0018](0018-weltlaufzeit-und-skalierende-perioden.md)

## Kontext

Eine Eisenbahn-Unternehmenssimulation kann in drei Geschäftsfeldern spielen:
Schienenpersonennahverkehr (SPNV), Fernverkehr (SPFV) und Güterverkehr (SGV).
Fern- und Güterverkehr setzen ein vollständiges Nachfragemodell voraus —
Zonen, Reisezeit-, Preis- und Verkehrsmittelwahl —, das teuer zu bauen und
schwer zu kalibrieren ist. Es müsste stehen, bevor überhaupt ein Zug
wirtschaftlich sinnvoll fährt. Das würde die Prüfung der eigentlichen
Existenzfragen — Netz, Trassen, Konflikte, Betrieb — hinter ein großes,
riskantes Teilsystem schieben.

## Entscheidung

SPNV ist das erste vollständig spielbare Geschäftsfeld. Fern- und Güterverkehr
folgen erst nach dem Alpha-Schnitt (M10, M11).

## Begründung

Im SPNV liefert die Kette Ausschreibung → Verkehrsvertrag ein klares Ziel,
planbare Erlöse und mit Bonus und Pönale ein sofortiges, verständliches
Feedback. Das ersetzt in der ersten Ausbaustufe das vollständige
Nachfragemodell: Die Erlösseite ist vertraglich gesetzt, nicht simuliert.
Damit lässt sich beweisen, dass Netz, Trassenvergabe und Betrieb tragen, bevor
die aufwändige Nachfragemodellierung überhaupt begonnen wird.

## Konsequenzen

- **Erleichtert:** Der Alpha-Schnitt (M0–M9) kommt ohne Nachfragemodell aus.
  Die Wirtschaft in M6 rechnet gegen Bestellerentgelt, Bonus und Pönale.
- **Kostet / schränkt ein:** SPFV und SGV sind bis M10/M11 nicht spielbar; das
  Nachfragemodell (M10.1) ist bewusst nach hinten gestellt.
- **Milestones:** M6 baut das erste Wirtschafts-Geschäftsfeld vollständig aus;
  M10 und M11 setzen darauf auf und ergänzen Nachfrage und Warenströme.
