# ADR-0021: SPNV-Ausschreibungen variieren nach einem angekündigten Vergabeprofil

- **Status:** Angenommen — bindend (entspricht E21)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../wirtschaft.md](../wirtschaft.md) · [../produkt.md](../produkt.md)
- **Betrifft Milestones:** M6.4a (Vergabeprofil), M6.4 (Ausschreibungsgenerator), M6.1 (`EconomyRelease`), M6.5 (Auskömmlichkeitsgrenze), M6.6/M6.6a (Wertung, Fahrzeugvorgaben)
- **Verwandte ADRs:** [ADR-0011](0011-kein-einzelner-optimierungswert.md), [ADR-0018](0018-weltlaufzeit-und-skalierende-perioden.md), [ADR-0019](0019-realismus-dient-dem-spiel.md), [ADR-0007](0007-eigenbetrieb-bei-gescheiterter-ausschreibung.md)

## Kontext

SPNV ist das erste vollständig spielbare Geschäftsfeld (E1), und sein Kern ist
die Ausschreibung: Leistungsbeschreibung, Angebot, Wertung, Zuschlag,
Verkehrsvertrag. Das Angebot hat bewusst wenige Felder (E19), und die Wertung ist
vor Abgabe sichtbar (`wirtschaft.md` 3.5). Genau diese gewollte Klarheit hat eine
Kehrseite: Bleiben Zuschnitt, Anforderungen und Wertungsgewichte über alle Lose
hinweg gleich, findet ein Spieler einmal die auskömmlichste Kombination aus
Bestellerentgelt, Fahrzeugkonzept und Qualitätszusagen — und wendet dieselbe
Schablone auf jedes weitere Los an. Über 3–4 Vergabezyklen je Welt (E18) verfällt
das Spiel dann zur wiederholten Eingabe desselben Angebots.

E11 verbietet bereits, die Güte einer Linie auf **eine** Kennzahl zu kollabieren,
und `produkt.md` 7 zeigt, dass die umkämpfte, gemeinsame Kapazität eine
berechenbare Einheits-*Zeitlage* strukturell ausschließt. Beides wirkt aber
**innerhalb** einer Ausschreibung und auf der Trassenseite. Keine bestehende
Entscheidung sorgt dafür, dass sich die **Anforderungen von Ausschreibung zu
Ausschreibung** unterscheiden — dass also die betriebswirtschaftlich richtige
Antwort auf Los B eine andere ist als auf Los A.

## Entscheidung

**Jede SPNV-Ausschreibung trägt ein `TenderProfile` — eine deterministisch aus
dem Weltseed gezogene, vorab veröffentlichte Kombination von Anforderungs- und
Wertungshebeln —, sodass ein für ein Los optimiertes Angebot samt Flotten- und
Betriebsprogrammzuschnitt beim nächsten Los nicht mehr die beste Antwort ist.**

Das Profil verschiebt, was ein wettbewerbsfähiges Angebot ausmacht, entlang
weniger Hebel. Jeder Hebel muss den Test aus E19 bestehen — er verändert eine
Entscheidung des Spielers, nicht nur eine Zahl:

- **Wertungsgewichtung** (`ScoringWeights`) — das Verhältnis von Preis- zu
  Qualitätspunkten. Ein preislastiges Los belohnt das knappe Gebot, ein
  qualitätslastiges die teureren Zusatzzusagen.
- **Anforderungsschwerpunkt** — worauf das Fahrzeugkonzept zielt: hohe
  Sitzplatzdichte einer S-Bahn-Linie, Reisekomfort eines langlaufenden RE,
  Fahrrad- und Rollstuhlkapazität eines touristischen Netzes. Eine für das eine
  Profil bestellte Flotte (E20) ist für das andere schlecht geeignet.
- **Pönaleschwerpunkt** — welche Qualitätsdimension der Vertrag am härtesten
  sanktioniert: Pünktlichkeit, Ausfälle, Sitzplatzangebot oder
  Anschlusssicherung. Das verschiebt die Prioritäten im Betriebsprogramm (E2).
- **Sonderauflagen** — begrenzte, ausdrücklich genannte Zusatzbedingungen:
  verpflichtende Zusatzhalte, eine Obergrenze für das Fahrzeugalter, eine
  Antriebsauflage auf einem nicht elektrifizierten Ast, ein gefordertes
  SEV-Konzept.

Vier Eigenschaften sind nicht verhandelbar:

**Deterministisch aus dem Weltseed**, Substream `tender_profile`. Kein
`Math.random()`, reproduzierbar, im Nachhinein prüfbar — wie der Vergabekalender
aus `tender_release` (E18).

**Vorab veröffentlicht.** Das Profil steht in der Leistungsbeschreibung, sobald
das Los angekündigt ist. Zufällig ist, *wie* das Profil gezogen wurde, nicht,
*ob* man es kennt (`wirtschaft.md` 3.4). Damit bleibt Planung möglich und
Zeitverfügbarkeit kein Vorteil (E2).

**Aus einem versionierten, gedeckelten Katalog.** Die möglichen Profile, ihre
Hebel und Punktgewichte liegen im `EconomyRelease` und sind je Welt gepinnt —
Balance im Release, nicht im Code. Die Auskömmlichkeitsgrenze wird für das
jeweilige Profil berechnet und wie bisher vor Angebotsöffnung veröffentlicht
(`wirtschaft.md` 4).

**Geschichtet, keine Ziehung je Los.** Über eine Welt hinweg werden die Profile
so verteilt, dass eine Spanne von Schwerpunkten vorkommt und kein einzelnes
Profil eine Welt bestimmt — dieselbe Permutation-statt-Ziehung wie beim
Vergabekalender (`wirtschaft.md` 3.3). Eine Wiedervergabe desselben Loses kann
ein anderes Profil tragen.

**Es bleibt eine Karte (E19).** Das Profil erscheint als wenige beschriftete
Schwerpunkte auf derselben in einer halben Minute lesbaren Leistungsbeschreibung
— keine Vergabeakte, keine Dutzend Regler.

Ausdrücklich **nicht** eingeführt wird ein reaktiver „Wiederholungswächter", der
gleiche Angebote erkennt und bestraft. Das wäre eine wertende, undurchsichtige
Serverentscheidung — das Gegenteil der nachrechenbaren Regel, die dieses Projekt
an jeder Stelle bevorzugt (`wirtschaft.md` 4).

## Begründung

Variation muss **strukturell und angekündigt** sein, nicht reaktiv und verborgen.
Ein Detektor, der eine „08/15-Schablone" erkennt und dämpft, verstieße gegen den
Determinismus, gegen die vollständige Vorab-Transparenz der Vergabe und gegen das
Prinzip, dass Regeln nachrechenbar sind statt gewertet. Er wäre zudem umgehbar
und würde als Willkür erlebt.

Ein aus dem Seed gezogenes, veröffentlichtes Profil erreicht dasselbe Ziel ohne
diese Kosten: Die Schablone verliert ihren Wert, weil das nächste Los andere
Antworten verlangt — nicht, weil der Server das Wiederholen bestraft. Das ist
genau die Ergänzung, die E11 fehlt: E11 hält die Ziele **innerhalb** einer
Ausschreibung mehrdimensional; E21 sorgt dafür, dass sich das Zielgewicht
**zwischen** den Ausschreibungen verschiebt. Erst beide zusammen schließen die
Monokultur von beiden Seiten.

Die Beschränkung auf einen versionierten Katalog und die Bindung jedes Hebels an
den E19-Test verhindern, dass Variation zu Rauschen wird. Ein Hebel, der keine
andere Entscheidung erzeugt, gehört nicht ins Profil.

## Konsequenzen

Was aus der Entscheidung folgt — bewusst auch das Unbequeme:

- **Erleichtert:** Wiederkehrende Ausschreibungen bleiben ein Spiel statt einer
  Formularwiederholung. Verschiedene Flotten- und Betriebsstrategien werden über
  eine Welt hinweg abwechselnd belohnt; eine breit aufgestellte oder
  anpassungsfähige Flotte (E20) zahlt sich aus. Ergänzt die
  Anti-Monokultur-Wirkung von E11 auf der Nachfrageseite der Vergabe.
- **Kostet / schränkt ein:** Der `EconomyRelease` muss einen Profilkatalog samt
  Punktgewichten führen und versionieren. Der Ausschreibungsgenerator und die
  Wertung müssen das Profil verarbeiten, die Auskömmlichkeitsgrenze
  profilabhängig rechnen, und die Leistungsbeschreibung das Profil lesbar
  darstellen. Der Angebotsassistent (`wirtschaft.md` 3.5) muss das aktive Profil
  berücksichtigen. Jeder Profilhebel ist gegen den E19-Test zu rechtfertigen.
- **Invarianten:** Das Profil entsteht aus dem Seed-Substream `tender_profile`
  und ist damit deterministisch und replaybar (nahe Invariante 2/3).
  Punktgewichte und Grenzwerte kommen aus dem gepinnten `EconomyRelease`, nicht
  aus dem Code (Invariante 6). Kein Payment-Tier fließt in Profil oder Wertung
  ein (Invariante 5).
- **Milestones:** M6.1 (`EconomyRelease` trägt den Profilkatalog), M6.4/M6.4a
  (Ausschreibungsgenerator zieht und veröffentlicht das Profil), M6.5
  (Auskömmlichkeitsgrenze profilabhängig), M6.6/M6.6a (Wertung und
  Fahrzeugvorgaben folgen dem Profil).
