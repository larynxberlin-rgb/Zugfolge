# Wirtschaft: Kreislauf, Märkte, Ausschreibung, Scheitern

## 1. Gemeinsamer Spielkreislauf

```text
Markt erkennen
  → Angebot planen
  → Fahrzeuge und Personal sichern
  → Trasse beantragen
  → Betrieb durchführen
  → Ergebnis auswerten
  → Angebot verbessern
```

Alle drei Geschäftsfelder sind vollständig spielbar:

- **SPFV** — eigenwirtschaftliche Linien, Haltepolitik, Tarife, Komfort,
  Nachfrage, Vertrieb, vollständiges Erlösrisiko.
- **SGV** — Verladerverträge, Spot- und Langfristaufträge, Zugbildung,
  Terminals, Wagenumläufe, Leerfahrten, Lieferqualität.
- **SPNV** — spielweltgenerierte Ausschreibungen mit Leistungsbeschreibung,
  Qualitätsanforderungen, Mobilisierungsphase, Angebotswertung, Verkehrsvertrag,
  Bonus und Pönale. **Erstes vollständig spielbares Feld (E1).**

Gemeinsame Kosten und Restriktionen: Trassen-, Stations-, Abstell- und
Anlagenentgelte; Fahrzeugkauf, Leasing und Finanzierung; Energie, Personal,
Verwaltung; Wartung, Fristen, Werkstattaufenthalte; Leer- und
Zuführungsfahrten; Verspätungs-, Ausfall- und Vertragsfolgekosten.

Geld wird ausschließlich als **Integer-Cent** in einem unveränderlichen,
ausgeglichenen Ledger geführt. Alle Balancewerte liegen in einem versionierten
`EconomyRelease` und sind nicht im Programmcode verdrahtet.

## 2. Nachfrage und Wettbewerb

- Personenverkehr verwendet ein zonenbasiertes Nachfragemodell aus Bevölkerung,
  Arbeitsplätzen, POIs, Reiseanlässen, Saison und Tageszeit.
- Die Verkehrsmittel- und Zugwahl bewertet Fahrpreis, Reisezeit, Umstiege, Takt,
  Zuverlässigkeit und Komfort.
- Güterverkehr entsteht aus Industrie-, Terminal-, Hafen- und
  Warenstrommodellen sowie generierten Verladerverträgen.
- SPNV-Aufgabenträger sind simulierte Marktakteure, aber keine Zugbetreiber.
- Reale öffentliche Daten kalibrieren Größenordnungen; reale Personen oder
  vertrauliche Unternehmensdaten werden nicht nachgebildet.
- Kredite, Restrukturierung und Insolvenz gehören zur Wirtschaft.

## 3. Vergabezyklus und Betriebsübergang (E18)

Vertragslaufzeiten skalieren mit der Weltlaufzeit — Werte und Herleitung in
`produkt.md` 6.1. Der **Ablauf** ist in jeder Welt derselbe.

Die zugrunde liegenden Linien und sinnvollen Lose kommen nicht aus einem
Spielerformular: Ein gehashter GTFS-Planungssnapshot bildet aktive Fahrten auf
den internen Betriebsgraphen ab und erzeugt daraus Fahrtenbilder, verbundene
Liniengruppen und das Mengengerüst der Leistungsbeschreibung. GTFS liefert das
Angebot; Befahrbarkeit, Energie- und Fahrzeugregeln bleiben versionierte
Zugfolge-Daten. Der genaue Vertrag einschließlich Pilotnachweis und Grenzen
steht in [`gtfs-angebotsplanung.md`](gtfs-angebotsplanung.md).

### 3.1 Der Zyklus

```text
laufender Verkehrsvertrag des Altbetreibers
│
├─ Ausschreibungsvorlauf   (beginnt eine Periode vor Vertragsende)
│    Leistungsbeschreibung und Auskömmlichkeitsgrenze veröffentlicht,
│    Angebotsfrist, Wertung, Zuschlag
│
├─ Mobilisierungsphase     (Rest der laufenden Periode)
│    Gewinner sichert Fahrzeuge und Personal, beantragt Trassen
│    ► Altbetreiber fährt weiter — mit vollen Pflichten und voller Pönale
│
└─ Betriebsübergang        (ausschließlich zum Fahrplanstichtag)
     Trassen gehen über, Verkehrsvertrag wechselt
```

### 3.2 Die Regeln, die das trägt

**Der Altbetreiber fährt bis zur letzten Sekunde mit unveränderten Pflichten.**
Pönalen, Qualitätsanforderungen und Nachweispflichten gelten bis zum Tag des
Übergangs. Ohne diese Regel hätte jeder unterlegene Betreiber einen Anreiz, die
letzten Wochen schleifen zu lassen — und die Fahrgäste zahlten die Zeche für
einen Vergabewettbewerb. Die Präqualifikation merkt sich das Endverhalten.

**Der Übergang findet nur zum Fahrplanstichtag statt**, nie mitten in einer
Periode. Real so, und technisch sauber, weil Trassen ohnehin periodenweise
vergeben werden.

**Gewinnt der Bisherige, entfällt die Mobilisierung.** Kein Fahrzeug- oder
Personalwechsel, nahtloser Übergang, keine Umstellungskosten. Das ist ein echter
Amtsinhabervorteil — real ebenso — und belohnt gute Leistung mit Stabilität statt
mit einem Bonus.

**Die Mobilisierung ist nachweispflichtig.** Der Gewinner muss vor dem Stichtag
belegen, dass Fahrzeuge, Personal und Trassen tatsächlich vorhanden sind.
Schafft er es nicht:

- der Betriebsübergang findet nicht statt;
- der **Eigenbetrieb** übernimmt (Abschnitt 4);
- der Gewinner zahlt Vertragsstrafe und trägt einen Präqualifikationsschaden.

Das ist die Sperre gegen Dumping-Gebote von Spielern ohne Substanz. Ohne sie
wäre die günstigste Strategie, alles zu bieten und später zu sehen, was daraus
wird.

**Vertragsende durch Weltende ist kein Scheitern.** Läuft eine Welt aus,
enden die Verträge regulär — keine Insolvenz, keine Pönale, keine
Präqualifikationsfolge.

### 3.3 Erstvergabe beim Weltstart

**Beim Weltstart hält der Eigenbetrieb sämtliche Lose, und es läuft keine
einzige Ausschreibung.** Sie werden erst nach und nach freigegeben.

Der Grund: Startete alles gleichzeitig, wäre das Netz binnen einer Periode
verteilt — und danach gäbe es wochenlang nichts zu bieten, weil die
Erstverträge erst später auslaufen. Wer in dieser Zeit dazustößt, fände eine
Welt ohne Einstieg vor.

**Der Vergabekalender**, erzeugt bei Weltstart:

```text
1. Alle Lose starten beim Eigenbetrieb.
2. Vergabefenster werden GLEICHMÄSSIG über die erste Welthälfte verteilt.
3. Lose werden nach Größe und Attraktivität in Schichten geteilt.
4. Innerhalb jeder Schicht werden sie den Fenstern zufällig zugeordnet
   — eine Permutation, keine Ziehung.
5. Jedes Los wird mit Vorlauf angekündigt, bevor die Angebotsfrist öffnet.
```

Drei Eigenschaften sind dabei nicht verhandelbar:

**Permutation statt Ziehung.** Würde man je Periode und Los würfeln, entstünden
Häufungen — fünf Lose in einer Periode, keines in der nächsten. Genau das soll
der Mechanismus verhindern. Die Fenster stehen deshalb fest und gleichmäßig; nur
die **Zuordnung** ist zufällig.

**Geschichtet, damit es keinen Jackpot gibt.** Fielen die drei attraktivsten
Lose zufällig in das erste Fenster, hätten die Spieler der ersten Tage einen
kaum aufholbaren Vorsprung. Die Schichtung sorgt dafür, dass jedes Fenster eine
Mischung aus großen und kleinen Losen enthält — jedes lohnt sich, keines
entscheidet die Welt.

**Deterministisch aus dem Weltseed**, Substream `tender_release`. Der Kalender
ist damit reproduzierbar und im Nachhinein prüfbar. Kein `Math.random()`.

### 3.4 Der Kalender ist öffentlich

> **Zufällig ist, wie der Vergabekalender zustande kam — nicht, ob man ihn
> kennt.** Er wird bei Weltstart vollständig veröffentlicht.

Das ist zunächst kontraintuitiv, aber zwingend. Erschienen Ausschreibungen zu
unangekündigten Zeitpunkten, hätte derjenige einen Vorteil, der als Erster
nachschaut — und **Zeitverfügbarkeit wäre wieder ein Wettbewerbsvorteil**, genau
das, was das Betriebsprogramm (E2) verhindern soll.

Die Veröffentlichung ist zudem real: Aufgabenträger geben ihre Vergabekalender
Jahre im Voraus bekannt, und vor jeder Ausschreibung steht ohnehin eine
Vorinformation. Sie schafft Planungssicherheit — wer weiß, dass ein großes Los
in drei Perioden kommt, kann Kapital, Fahrzeuge und Personal darauf ausrichten.
Das ist Strategie, kein Informationsleck.

### 3.5 Das Verfahren ist kurz und abstrahiert (E19)

**Vorlauf ist nicht Wartezeit.** Der Ausschreibungsvorlauf von einer Periode
beschreibt, wie früh ein Los angekündigt wird — nicht, wie lange der Spieler
nichts tun kann. Die eigentliche Angebotsfrist ist kurz, und die Zeit danach ist
aktive Mobilisierung, keine Warteschleife.

```text
Vorinformation     Los angekündigt, Leistungsbeschreibung einsehbar
Angebotsfrist      3–7 Tage Echtzeit  ·  kleine Lose 24–48 Stunden
Zuschlag           sofort bei Fristende, deterministisch gewertet
Mobilisierung      bis zum Fahrplanstichtag — Fahrzeuge, Personal, Trassen
Betriebsaufnahme   Fahrplanstichtag
```

Die **Schnellvergabe kleiner Lose** ist Absicht: Ein neuer Spieler soll seine
erste eigene Ausschreibung in Tagen gewinnen können, nicht in Wochen. Das
Startpaket (→ `produkt.md` 3) überbrückt die Zeit davor, damit ab Minute eins
Züge fahren.

**Die Leistungsbeschreibung ist eine Karte, kein Aktenordner** — in einer halben
Minute lesbar: Linien, Zugkm je Periode, Takt, Betriebszeiten, Mindest-
anforderungen an die Fahrzeuge, Laufzeit, Auskömmlichkeitsgrenze, Eckwerte für
Bonus und Pönale. Alles Weitere liegt aufgeklappt darunter.

**Das Angebot hat wenige Felder**, nicht Dutzende:

| Feld | Wirkung |
|------|---------|
| Bestellerentgelt je Zugkm | der zentrale Hebel, muss unter der Auskömmlichkeitsgrenze liegen |
| Fahrzeugkonzept | Formation und Ausstattung (→ `betrieb.md` 3) — erfüllt die Mindestanforderungen oder übertrifft sie |
| Optionale Qualitätszusagen | zusätzliche Halte, höhere Pünktlichkeitsgarantie, mehr Sitzplätze — bringen Wertungspunkte und kosten Geld |

**Die Wertung ist vor Abgabe sichtbar.** Der Spieler sieht die Aufschlüsselung
seines *eigenen* Angebots — Preispunkte, Qualitätspunkte, Gesamtwertung — bevor
er einreicht. Das lehrt das System nebenbei und ersetzt jede Anleitung. Angebote
der Konkurrenz bleiben selbstverständlich verborgen.

**Angebotsassistent** als Automatikstufe (→ `produkt.md` 5): Der Spieler gibt
eine Zielmarge vor, das System rechnet den passenden Preis und zeigt die
erwartete Wertung. Wer selbst rechnet, holt mehr heraus — dasselbe Muster wie
überall sonst.

**Nicht modelliert**, weil ohne Entscheidung: Teilnahmewettbewerb, Eignungs-
formblätter, Nebenangebote, Aufklärungsgespräche, Nachprüfungsverfahren. Die
Eignung wird über die Präqualifikation abgebildet, die ohnehin mitläuft.

### 3.6 Überlappung von Erst- und Wiedervergabe

Die Erstvergabe läuft über die erste Welthälfte, die ersten Verträge laufen nach
zwei bis drei Perioden aus. Beide Ströme **überlappen sich damit von selbst** —
während die letzten Lose erstmals vergeben werden, kommen die frühesten schon
zur Wiedervergabe. Dadurch gibt es zu keinem Zeitpunkt eine Welt ohne offene
Ausschreibung, und ein später dazugestoßener Spieler findet immer einen Einstieg.

Diese Überlappung ist eine **Prüfbedingung beim Weltentwurf**, keine Hoffnung:
Vergabekalender und Vertragslaufzeiten werden gegeneinander geprüft, bevor eine
Welt startet.

### 3.7 Jede Ausschreibung variiert (E21)

Das Angebot hat wenige Felder und die Wertung ist vorab sichtbar (3.5) — gewollt,
damit das Verfahren in Minuten zu spielen ist. Die Kehrseite: Bliebe der Zuschnitt
über alle Lose gleich, fände ein Spieler einmal die auskömmlichste Kombination
aus Bestellerentgelt, Fahrzeugkonzept und Qualitätszusagen und wendete diese
**08/15-Schablone** danach auf jedes weitere Los an. Über 3–4 Vergabezyklen je
Welt (E18) verkäme die Ausschreibung zur Formularwiederholung.

> **Deshalb trägt jede Ausschreibung ein `TenderProfile`** — eine Kombination
> von Anforderungs- und Wertungshebeln, die verschiebt, was ein
> wettbewerbsfähiges Angebot ausmacht. Ein für ein Los optimiertes Angebot samt
> Flotten- und Betriebsprogrammzuschnitt ist beim nächsten Los nicht mehr die
> beste Antwort.

**Die Hebel** — jeder verändert eine Entscheidung des Spielers, nicht nur eine
Zahl (E19):

| Hebel | Was er verschiebt |
|-------|-------------------|
| Wertungsgewichtung (`ScoringWeights`) | Verhältnis von Preis- zu Qualitätspunkten: preislastig belohnt das knappe Gebot, qualitätslastig die teureren Zusatzzusagen |
| Anforderungsschwerpunkt | worauf das Fahrzeugkonzept zielt — Sitzplatzdichte einer S-Bahn, Reisekomfort eines langen RE, Fahrrad- und Rollstuhlkapazität eines touristischen Netzes (E20) |
| Pönaleschwerpunkt | welche Qualitätsdimension der Vertrag am härtesten sanktioniert — Pünktlichkeit, Ausfälle, Sitzplatzangebot oder Anschlusssicherung; verschiebt die Prioritäten im Betriebsprogramm (E2) |
| Sonderauflagen | begrenzte, ausdrücklich genannte Zusatzbedingungen — verpflichtende Zusatzhalte, Obergrenze für das Fahrzeugalter, Antriebsauflage auf einem nicht elektrifizierten Ast, gefordertes SEV-Konzept |

**Vier Eigenschaften sind nicht verhandelbar** — dieselben, die auch den
Vergabekalender (3.3, 3.4) tragen:

- **Deterministisch aus dem Weltseed**, Substream `tender_profile`. Kein
  `Math.random()`, reproduzierbar und im Nachhinein prüfbar. Ein neuer Substream
  verändert die bestehenden nicht.
- **Vorab veröffentlicht.** Das Profil steht in der Leistungsbeschreibung, sobald
  das Los angekündigt ist. *Zufällig ist, wie das Profil gezogen wurde — nicht,
  ob man es kennt.* Damit bleibt Planung möglich und Zeitverfügbarkeit kein
  Vorteil (E2).
- **Aus einem versionierten, gedeckelten Katalog** im `EconomyRelease`, je Welt
  gepinnt — Balance im Release, nicht im Code. Die Auskömmlichkeitsgrenze wird
  für das jeweilige Profil berechnet und wie bisher vor Angebotsöffnung
  veröffentlicht (4).
- **Geschichtet, keine Ziehung je Los.** Über eine Welt hinweg kommt eine Spanne
  von Schwerpunkten vor, kein einzelnes Profil bestimmt eine Welt — Permutation
  statt Ziehung wie in 3.3. Eine Wiedervergabe desselben Loses kann ein anderes
  Profil tragen.

**Es bleibt eine Karte (E19).** Das Profil erscheint als wenige beschriftete
Schwerpunkte auf derselben in einer halben Minute lesbaren Leistungsbeschreibung
— keine Vergabeakte, keine Dutzend Regler. Der Angebotsassistent (3.5)
berücksichtigt das aktive Profil.

**Kein reaktiver Wiederholungswächter.** Ausdrücklich *nicht* eingeführt wird ein
Mechanismus, der gleiche Angebote erkennt und bestraft. Das wäre eine wertende,
undurchsichtige Serverentscheidung — das Gegenteil der nachrechenbaren Regel, die
dieses Projekt überall bevorzugt (4). Die Schablone verliert ihren Wert, weil das
nächste Los andere Antworten verlangt, nicht weil der Server das Wiederholen
ahndet. So ergänzt E21 die Entscheidung E11 (kein einzelner Optimierungswert):
E11 hält die Ziele **innerhalb** einer Ausschreibung mehrdimensional, E21 lässt
das Zielgewicht **zwischen** den Ausschreibungen wandern.

## 4. Eigenbetrieb — Ausfallsicherung des Aufgabenträgers (E7)

**Wann er greift**

1. Kein Angebot innerhalb der Angebotsfrist.
2. Alle Angebote über der veröffentlichten Auskömmlichkeitsgrenze.
3. Kündigung oder Insolvenz eines EVU während der Vertragslaufzeit.

**Die Auskömmlichkeitsgrenze wird vor Angebotsöffnung veröffentlicht** und
deterministisch aus dem `EconomyRelease` berechnet: Zugkm × Kostensatz zuzüglich
Aufschlägen für Fahrzeugbedarf, Nachtabstellung und Zugsicherungsausrüstung.
Angebote darüber sind ungültig. Nichts daran ist verborgen — es gibt nichts zu
erraten und nichts auszunutzen. Das ersetzt eine wertende Serverentscheidung
(„zu teuer“) durch eine nachrechenbare Regel.

**Der Eigenbetrieb ist bewusst mittelmäßig.** Sonst gäbe es keinen Grund zu
bieten:

- fährt exakt die Mindestbedienung, keine Zusatzhalte, keine Verstärker;
- Standardfahrzeuge aus dem Fahrzeugpool des Aufgabenträgers, älterer Jahrgang;
- festes, konservatives Betriebsprogramm ohne Optimierung, dadurch spürbar
  schlechtere Pünktlichkeit als ein gut geführtes EVU;
- nimmt am normalen `PlanningRun` teil, aber mit nachrangiger Priorität im
  Konfliktfall; seine Trassen werden bei Übernahme sofort freigegeben;
- erhält niemals einen Qualitätsbonus;
- ist optisch eindeutig gekennzeichnet — neutrale Lackierung, eigene Markierung
  auf der Livemap, niemals als Spieler-EVU getarnt.

**Er verschwindet wieder.** Eine Notvergabe ist auf zwei Perioden befristet.
Danach wird neu ausgeschrieben, mit einem **nachgebesserten Paket**: höheres
Bestellerentgelt, reduzierter Leistungsumfang oder gestellte Fahrzeuge aus dem
Pool. Eine gescheiterte Ausschreibung macht die nächste attraktiver —
selbstheilendes Ventil und automatischer Schwierigkeitsregler zugleich.

**Anti-Kartell ohne Sonderregel.** Jeder Aufgabenträger hat ein endliches
Periodenbudget, und Notvergaben sind für ihn teuer. Wer sich abspricht und ein
Netz leerlaufen lässt, drückt dieses Budget — die nächste Ausschreibung in
derselben Region fällt kleiner aus oder entfällt. Kollektiver Boykott schadet
allen Beteiligten, ganz ohne künstliche Anti-Absprache-Mechanik.

**Weltstart.** Wenn eine Welt öffnet, hält der Eigenbetrieb das **gesamte**
SPNV-Netz der Region, und es läuft zunächst keine einzige Ausschreibung. Die
Welt sieht ab Sekunde eins aus wie eine echte Eisenbahn, und die Spieler erobern
sie Ausschreibung für Ausschreibung nach dem veröffentlichten Vergabekalender
(3.3). Das löst das schwierigste Problem eines persistenten Spiels — den leeren
ersten Tag — ohne einen einzigen künstlichen Konkurrenten.

Fernverkehr und Güterverkehr erhalten bewusst **keine** Ausfallsicherung. Beide
sind eigenwirtschaftlich: fährt niemand, fährt niemand. Unerfüllte Nachfrage
bleibt aber als offener Marktbedarf sichtbar — als Signal an die Spieler, nicht
als Füllmasse.

## 5. Insolvenz als Totalverlust (E8)

Scheitern beendet das EVU vollständig: Verträge werden gekündigt, Trassen
freigegeben und der Restwert geht an die Gläubiger. Die Fahrzeuge verschwinden
dabei nicht aus der Welt: Leasingfahrzeuge gehen an ihren Leasinggeber zurück;
eigene Fahrzeuge werden mit tatsächlichem Fristenstand, Zustandsprofil und
vollständigem Lebenslauf auf dem Gebrauchtmarkt verwertet. Der Account bleibt
bestehen, das Unternehmen nicht.

Harte Konsequenzen sind nur zulässig, wenn sie **vollständig vorhersehbar**
sind. Deshalb eine sichtbare Eskalationsleiter — jede Stufe erscheint im
Postfach und im Tagesbericht:

| Stufe | Auslöser | Wirkung |
|-------|----------|---------|
| 1 Frühwarnung | Liquidität reicht weniger als zwei Perioden | Warnung, Prognoserechnung, Handlungsvorschläge |
| 2 Zahlungsverzug | fällige Entgelte nicht gedeckt | Verzugszinsen, keine neuen Trassenanträge |
| 3 Kreditsperre | Bonität unter Schwellwert | keine neuen Kredite, kein Fahrzeugkauf |
| 4 Vertragskündigung | Nachweise oder Pönalen überschritten | Aufgabenträger kündigt, Eigenbetrieb übernimmt |
| 5 Insolvenz | Zahlungsunfähigkeit festgestellt | Liquidation, EVU endet |

**Kein Reset-Exploit.** Insolvenz darf kein billiger Ausweg aus einem schlechten
Vertrag sein. Zwei Sperren:

- Pönalen und Kündigungsfolgen greifen **vor** Stufe 5, nicht erst danach.
- Der Spieler trägt eine **Präqualifikation** — einen Eignungsnachweis über
  seine Betriebshistorie in dieser Welt. Nach einer Insolvenz ist er für mehrere
  Perioden nur für kleine Lose zugelassen und startet mit schlechterer Bonität.
  Das entspricht der realen Eignungsprüfung im Vergabeverfahren und schließt die
  Lücke, ohne eine künstliche Strafe zu erfinden.

Eine freiwillige Betriebsaufgabe verwendet dieselben Rücklaufwege für die
Flotte. Ihre wirtschaftlichen Folgen bleiben von der Insolvenz getrennt:
offene Verpflichtungen, Kündigungsfolgen und Gebrauchtmarkterlös werden
abgerechnet, aber nur eine tatsächlich eingetretene Insolvenz löst die
weltgebundene Präqualifikationsfolge aus.

## 6. Kooperation zwischen EVU

Kein Gilden- oder Allianzsystem, sondern spielweltseitig durchgesetzte Verträge
mit Laufzeit, Entgelt und Pönale:

- Traktionsleistungen (ein EVU stellt Lok und Personal für den Zug eines
  anderen);
- Fahrzeugvermietung und -verkauf inklusive Fristenstand;
- Anschlussvereinbarungen mit verbindlichen Wartezeiten;
- Wagenübergang im SGV;
- Ersatzverkehrshilfe bei Störungen;
- Bietergemeinschaften für SPNV-Ausschreibungen.

Daraus entsteht Politik zwischen Spielern, ohne ein zusätzliches Sozialsystem
bauen zu müssen.
