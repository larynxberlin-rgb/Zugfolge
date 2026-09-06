# ADR-0009: Vollständige Transparenz auf der Livemap

- **Status:** Angenommen — bindend (entspricht E9)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../infrastruktur.md](../infrastruktur.md)
- **Betrifft Milestones:** M4.8 (Livemap, Sichtbarkeitsregeln), M2.6 (Datenschutz)
- **Verwandte ADRs:** [ADR-0035](0035-deutschlandweite-spieleroberflaeche.md), [ADR-0017 – historisch](0017-design-domaenensprache-achromatisch-dunkel.md)

## Kontext

In einer Welt mit mehreren konkurrierenden EVU ist zu entscheiden, wie viel ein
Spieler vom Betrieb der anderen sieht. Zu wenig Sichtbarkeit lässt die Welt tot
wirken; zu viel gäbe Geschäftsgeheimnisse preis. Der reale Bahnbetrieb ist im
öffentlichen Raum weithin einsehbar — Züge fahren sichtbar, mit Nummer und
Verspätung.

## Entscheidung

Die Livemap ist **vollständig transparent**: Konkurrenten sehen Zugnummer,
Position, Verspätung und Betriebsstatus in Echtzeit. **Vertrags- und
Ladungsdetails bleiben geschützt.**

## Begründung

Die Transparenz ist realistisch — der fahrende Betrieb ist öffentlich — und
lässt die Welt belebt wirken. Die Grenze verläuft am Geschäftsgeheimnis: Was ein
Beobachter am Gleis sehen könnte, ist offen; was in Verträgen und Frachtbriefen
steht, nicht.

## Konsequenzen

- **Erleichtert:** Die Welt wirkt lebendig; Konkurrenzbeobachtung wird zum
  legitimen Teil des Spiels.
- **Kostet / schränkt ein:** Die Sichtbarkeitsgrenze muss serverseitig
  durchgesetzt werden — der Browser darf niemals versteckte Wettbewerbsdaten
  erhalten (Autorisierung serverseitig). Vertrags- und Ladungsdaten müssen
  sauber von den öffentlichen Betriebsdaten getrennt sein.
- **Milestones:** M4.8 (Livemap-Frontend mit Zuglaufansicht und
  Sichtbarkeitsregeln); die Datenschutzgrundlagen kommen aus M2.6.
