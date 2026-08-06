# ADR-0004: Kapazität wird aktiv gegen Landgrab geschützt

- **Status:** Angenommen — bindend (entspricht E4)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../infrastruktur.md](../infrastruktur.md)
- **Betrifft Milestones:** M3.7 (Ad-hoc, Verfall), M3.8 (Rahmenverträge), M6.11 (Aufgabenträger-Budget)
- **Verwandte ADRs:** [ADR-0018](0018-weltlaufzeit-und-skalierende-perioden.md)

## Kontext

Trassenkapazität ist endlich, besonders auf den Korridoren der Pilotregion.
In einer persistenten Welt ohne Wipe können Früheinsteiger diese Korridore
dauerhaft binden — durch Rahmenverträge, gehortete Trassen oder nie genutzte
Reservierungen. Wo das ungebremst geschieht, finden neue Spieler keinen
Zugang mehr; die Welt stirbt sozial, obwohl technisch alles läuft.

## Entscheidung

Kapazität wird **aktiv** gegen Landgrab geschützt, statt sich allein auf
Marktkräfte zu verlassen. Mechanismen: Kapazitätsdeckel bei Rahmenverträgen,
Verfall ungenutzter Trassen, und ein endliches Aufgabenträger-Budget je
Periode.

## Begründung

Ohne Gegenmaßnahmen binden Früheinsteiger die knappen Korridore und verschließen
den Markt. Der Schutz ist kein Balancing-Detail, sondern Bedingung dafür, dass
eine Welt über ihre gesamte Laufzeit bespielbar bleibt.

## Konsequenzen

- **Erleichtert:** Neue Spieler finden über die gesamte Weltlaufzeit Zugang;
  der Markt bleibt in Bewegung.
- **Kostet / schränkt ein:** Rahmenverträge dürfen keine unbegrenzte
  Kapazität binden; nicht genutzte Trassen verfallen. Beides muss in der
  Trassenvergabe erzwungen, nicht empfohlen werden.
- **Milestones:** M3.7 (Ad-hoc-Trassen aus Restkapazität, Verfall bei
  Nichtnutzung), M3.8 (Rahmenverträge mit Kapazitätsdeckel), M6.11
  (Aufgabenträger-Budget als endliche Periodenressource — trägt die
  Anti-Kartell-Wirkung). Ergänzt durch gestaffelte Vertragsenden (ADR-0018).
