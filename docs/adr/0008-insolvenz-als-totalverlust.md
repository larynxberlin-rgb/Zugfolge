# ADR-0008: Insolvenz bedeutet Totalverlust des EVU

- **Status:** Angenommen — bindend (entspricht E8)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../wirtschaft.md](../wirtschaft.md)
- **Betrifft Milestones:** M6.12 (Liquidität, Restrukturierung), M6.13 (Eskalationsleiter)
- **Verwandte ADRs:** [ADR-0007](0007-eigenbetrieb-bei-gescheiterter-ausschreibung.md)

## Kontext

Eine Wirtschaftssimulation braucht eine echte Konsequenz für Scheitern, sonst
ist unternehmerisches Risiko folgenlos und jede Entscheidung beliebig. Zugleich
darf das Scheitern weder überraschend über den Spieler hereinbrechen noch sich
durch einen Neustart des EVU billig abschütteln lassen (Reset-Exploit).

## Entscheidung

Insolvenz bedeutet den **Totalverlust des EVU**. Sie tritt ausschließlich am
Ende einer vollständig telegrafierten Eskalationsleiter (Stufe 1–5) ein und ist
gegen den Reset-Exploit gesperrt. Der **Account bleibt bestehen** — verloren
geht das Unternehmen, nicht der Spieler.

## Begründung

Die harte Konsequenz macht wirtschaftliche Entscheidungen bedeutsam. Sie ist
nur vertretbar, weil sie vollständig angekündigt ist: Der Spieler sieht das
Scheitern ab Stufe 1 kommen und hat auf jeder Stufe Handlungsspielraum. Die
Sperre gegen den Reset-Exploit verhindert, dass Insolvenz zur billigen
Entschuldung missbraucht wird.

## Konsequenzen

- **Erleichtert:** Risiko wird real und damit spielbar. Weil der Verkehr beim
  Eigenbetrieb weiterläuft (ADR-0007), schadet die Insolvenz eines EVU nicht den
  Fahrgästen der Welt.
- **Kostet / schränkt ein:** Die Eskalationsleiter muss lückenlos über Postfach
  und Bericht kommuniziert werden — ein stiller Totalverlust wäre unfair. Es
  braucht eine explizite Sperre gegen wiederholte Insolvenz zur Entschuldung.
- **Milestones:** M6.12 (Ergebnisrechnung, Liquidität, Kredite,
  Restrukturierung), M6.13 (Insolvenz-Eskalationsleiter Stufe 1–5 mit Postfach-
  und Berichtsmeldungen).
