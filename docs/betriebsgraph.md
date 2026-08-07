# Betriebsgraph — Domänenmodell der Infrastruktur

Ergebnis von **M1.1**. Beschreibt, woraus das Netz im Modell besteht, welche
Zusicherungen dabei gelten und was ausdrücklich noch **nicht** dazugehört.

Umsetzung: [`crates/zugfolge-infra`](../crates/zugfolge-infra). Fachliche
Einbettung — Konfliktressourcen, Trassenvergabe, Simulation:
[`infrastruktur.md`](infrastruktur.md). Datenlage und Rechte:
[`daten.md`](daten.md), [`rechte.md`](rechte.md).

---

## 1. Die drei Gedanken, die das Modell tragen

**Gefahren wird auf Gleisen, nicht auf Kanten.** Eine Kante verbindet zwei
Betriebsstellen; ein Gleis ist das, was ein Zug befährt. Ob zwei Züge auf einem
Abschnitt in den Zugfolgefall oder in eine Gegenfahrt geraten, entscheidet
dadurch die Infrastruktur allein — über die Richtungsbindung des Gleises. Das
ist der Befund des Spikes aus M0.3, und er steht hier als Datenmodell statt als
Regel: **Ein Ressourcenmodell trägt beide Konfliktarten.**

**Attribute sind Bänder.** Vmax, Neigung, Elektrifizierung und Zugsicherung
ändern sich entlang eines Gleises: Eine Strecke ist bis Kilometer 4 auf
160 km/h ausgelegt und danach auf 120, ein Systemwechsel liegt mitten auf der
freien Strecke, die Zugbeeinflussung wechselt am Streckenende. Alle vier haben
dieselbe Form und stehen deshalb als **ein** Bandprofil da, das sein Gleis
lückenlos und überschneidungsfrei abdeckt.

**Jeder Wert trägt seine Herkunft.** `daten.md` 2 verlangt Quelle und
Confidence je Attribut. Das ist keine Buchhaltung: Der Vertrauensgrad
entscheidet in M1.4, welcher Abschnitt Qualitätsklasse A erreichen kann.
Deshalb hängt die Herkunft am einzelnen **Band**, nicht am Gleis — eine
erfasste Geschwindigkeit und eine aus einem Höhenmodell abgeleitete Neigung
sind nicht gleich viel wert.

---

## 2. Die Bausteine

| Begriff | Bezeichner | Trägt |
|---------|------------|-------|
| Betriebsstelle | `OperatingPoint` | Kürzel, Name, Art, Lage |
| Kante | `TrackEdge` | zwei Betriebsstellen, Name, Länge; die Kilometrierung läuft von `from` nach `to` |
| Gleis | `Track` | Ort, Bezeichnung, Art, Richtungsbindung, Spurweite, Länge, Nutzlänge und vier Bandprofile |
| Bahnsteig | `Platform` | Gleis, Bezeichnung, Lage am Gleis, Nutzlänge, Höhe über Schienenoberkante |
| Bandprofil | `BandProfile` | die lückenlose Folge von Bändern eines Attributs |
| Herkunft | `Provenance` | Quelle und Vertrauensgrad eines Wertes |

**Die Art der Betriebsstelle ist kein Etikett.** Sie beantwortet zwei Fragen,
die im Betrieb wirklich gestellt werden: *Kann dort gekreuzt werden?* — nur im
Bahnhof und in der Ausweichanschlussstelle, und daran hängt die Auflösung jeder
Gegenfahrt (M3.4). *Kann dort ein Fahrgast einsteigen?* — nur im Bahnhof und am
Haltepunkt. Dazu kommt: *Hat sie Weichen?* — und damit einen Bahnhofskopf,
dessen Fahrstraßen abgeleitet werden müssen (M1.7).

**Die Art des Gleises entscheidet, was darauf stattfindet.** Zugfahrten laufen
nur auf Hauptgleisen; auf Neben-, Abstell- und Anschlussgleisen wird
ausschließlich rangiert, und zwar automatisiert (E12). Der Netzfilter aus M1.3
behält alle drei ausdrücklich — sie sind Konfliktressourcen wie jedes andere
Gleis und tragen später Zusatzfahrten, Abstellung und Versorgung (M5).

**Elektrifizierung ist zweiteilig:** Bauart und System. Das System entscheidet,
ob ein Triebfahrzeug den Strom nutzen kann; die Bauart entscheidet, ob der
Abschnitt überhaupt zum Netz gehört — E14 grenzt auf die EBO ab, und M1.3
wirft Stromschienennetze über die Netzausschlussliste heraus. Beschreiben
können muss das Modell beides, sonst hätte der Filter nichts zum Aussortieren.

**Zugsicherung ist eine Menge, kein Feld.** PZB und LZB liegen übereinander,
ETCS wird über beide gelegt und jahrelang parallel betrieben. Ob ein Zug einen
Abschnitt befahren darf, ist deshalb eine Schnittmengenfrage zwischen Strecke
und Fahrzeugausrüstung (M1.9, M5.2), keine Gleichheitsprüfung.

---

## 3. Zusicherungen

Was beim Bau geprüft wird, kann später nicht mehr falsch sein. Das ist kein
Stil, sondern eine Notwendigkeit: Ein `InfraRelease` ist unveränderlich
(M1.12). Ein Fehler, der beim Bauen nicht auffällt, fällt zum ersten Mal auf,
wenn eine Welt schon drei Monate darauf läuft — und dann ist er nicht mehr
behebbar, ohne die Welt anzufassen.

Am einzelnen Baustein:

- Betriebsstelle, Kante, Gleis und Bahnsteig haben einen nichtleeren Namen.
- Längen und Geschwindigkeiten sind positiv. Vmax null wäre keine langsame
  Strecke, sondern eine gesperrte — und eine Sperrung ist eine Betriebslage
  (M8), keine Eigenschaft des Gleises.
- Die Nutzlänge eines Gleises ist nicht größer als das Gleis.
- Ein Bandprofil beginnt bei null, endet an der Gleislänge, hat keine Lücke und
  keine Überschneidung, und jedes Band hat eine Ausdehnung.
- **Alle vier Bandprofile sind Pflicht.** Ein stillschweigend angenommenes
  Vmax-Profil wäre eine erfundene Geschwindigkeit ohne Quelle.

Im Verbund:

- Jede Kante endet an zwei verschiedenen, existierenden Betriebsstellen.
- Jedes Gleis liegt auf einer existierenden Kante oder in einer existierenden
  Betriebsstelle.
- Jeder Bahnsteig liegt an einem existierenden Gleis **in einer
  Betriebsstelle** und ragt nicht darüber hinaus.
- Kennungen sind eindeutig; ein Betriebsstellenkürzel bezeichnet genau eine
  Betriebsstelle; zwei Gleise am selben Ort heißen nicht gleich. Dasselbe
  `Gleis 1` in zwei Bahnhöfen ist dagegen der Normalfall.
- Keine Kante ohne Gleis, keine Betriebsstelle ohne Gleis, keine Betriebsstelle
  ohne Anschluss ans Netz.

Gemeldet wird der **erste** Fund. Der vollständige Mängelbericht eines Imports
ist die Abdeckungsmessung aus M1.4, nicht diese Prüfung.

---

## 4. Einheiten und Determinismus

Invariante 3 gilt ohne Ausnahme: Längen in Millimetern, Geschwindigkeiten in
Millimetern je Sekunde, Neigungen in Zehntel Promille, Koordinaten in
Zehnmillionstel Grad, Frequenzen in Milli-Hertz. Keine Gleitkommazahl im
Modell — auch nicht für 16,7 Hz.

Die Umrechnung aus km/h rundet **auf**. Eine abgerundete Vmax wäre eine stille
Streckenverlangsamung, die niemand angeordnet hat.

Die Neigung ist auf die Kilometrierung bezogen: positiv ist eine Steigung von
`from` nach `to`. Aus Sicht der Gegenrichtung kehrt sie sich um. Ohne diese
Umkehr rechnete die Fahrdynamik (M1.10) den halben Netzverkehr bergauf, der
bergab fährt.

**Der Fingerabdruck.** Der Betriebsgraph implementiert `DeterministicModel` mit
dem Kommandotyp `Infallible` — das ist die Aussage selbst: Er nimmt keine
Kommandos entgegen, er ist ein Artefakt und kein Zustand. Was er beisteuert,
ist ein kanonischer Zustands-Hash: die Prüfsumme, mit der eine Welt ihren
Infrastrukturstand pinnt und ein Replay ihn wiedererkennt. Aufzählungen gehen
über eine **stabile Textkennung** in den Hash ein, nicht über eine
Variantennummer; Mengen sind geordnet. Der Fingerabdruck hängt dadurch nicht an
der Einfügereihenfolge — sonst wäre er als Prüfsumme wertlos, denn ein Import
liest seine Quelle in der Reihenfolge, in der sie geschrieben ist.

Golden-Master: `crates/zugfolge-infra/tests/golden/operating-graph.hash`, in
der CI auf Linux **und** Windows gegen dieselbe Datei geprüft.

---

## 5. Was bewusst noch nicht dazugehört

| Fehlt | Gehört nach |
|-------|-------------|
| `InfraRelease` mit Version, Lizenz, Prüfsumme und Confidence je Attribut | M1.12 |

Das Modell ist auf alle vorbereitet und nimmt keines vorweg. **Ein
Blockabschnitt ist kein Gleis, eine Fahrstraße ist keine Kante, eine
Stationsanreicherung ist keine Betriebsstelle und eine Anlage ist kein Gleis**
— deshalb liefern M1.6 (Abschnitt 11), M1.7 (Abschnitt 12), M1.8 (Abschnitt 13)
und M1.11 (Abschnitt 14) sie als eigene, abgeleitete Artefakte neben dem
Modell, nicht als neue Bausteine darin. Die Vorbereitung im Modell besteht aus
drei Dingen: der Richtungsbindung des Gleises, die beide Konfliktarten trägt;
dem Bandprofil, in dem Signale und Blöcke ihre Abschnitte finden; und dem
Vertrauensgrad, den die Abdeckungsmessung liest.

---

## 6. Das Beispielnetz

`reference_network()` ist die Prüfstrecke des Modells. **Seine Daten sind
erfunden** — sie prüfen das Modell aus M1.1 für sich, unabhängig von einem
echten Extract. Ein Beispiel mit realen Namen und Werten würde vortäuschen, es
gäbe schon echte Infrastruktur, obwohl der Import (M1.2, Abschnitt 7) noch gar
nicht bis in den Betriebsgraphen hinein abbildet. Die Größenordnungen sind
realistisch gewählt, sonst prüfte das Beispiel nichts.

```text
Nordstadt ══ 5 km ══ Waldhof ══ 7 km ══ Sandberg ── 9 km, eingleisig ── Talheim
 Bf, 3 Gleise         Hp, 2 Gleise      Bf, 3 Gleise + Abstellgleis     Bf, 2 Gleise
 760 mm               550 mm            760 mm                          380 mm
 ├─ zweigleisig, Richtungsgleise ──────┤├─ Systemwechsel: ab hier ohne Fahrdraht
 ├─ 160 km/h, Gz 100 ──────────────────┤├─ 100 km/h, Gz 80
 ├─ PZB und LZB ───────────────────────┤├─ nur PZB
```

Enthalten sind damit: Richtungsgleise **und** ein eingleisiger Abschnitt, ein
Haltepunkt ohne Kreuzungsmöglichkeit, ein Abstellgleis, ein Wechsel der
Elektrifizierung, ein Wechsel der Zugsicherung, ein mehrbändiges
Neigungsprofil und vier verschiedene Bahnsteighöhen.

Die Quellenkennung `beispielnetz` steht bewusst **nicht** im Quellenregister.
Das Rechte-Gate prüft die Herkunft von Importen (Invariante 8) — hier wurde
nichts importiert, es gibt also nichts freizugeben. Ein erfundener Eintrag im
Register wäre eine Freigabe ohne Gegenstand.

---

## 7. Der Rohgraph — Ergebnis von M1.2

Die Import-Pipeline liest einen genehmigten OSM-PBF-Extract (Quelle
`osm-pbf-lhe`, `docs/rechte.md`) und baut daraus einen **Rohgraph** —
Topologie, Geometrie und Tags, roh und ungefiltert. Er ist bewusst **kein**
`OperatingGraph`: Welcher Punkt ein Bahnhof, welches Gleis ein Hauptgleis wird
und was zum EBO-Netz überhaupt gehört, entscheiden der Netzfilter (M1.3) und
die spätere fachliche Abbildung, nicht der Import selbst. Der Rohgraph ist die
gemeinsame Eingabe für alle folgenden Schritte von M1 — jeder von ihnen
braucht die volle, ungefilterte Topologie, keine schon getroffene Vorauswahl.

**Die Bausteine.**

| Begriff | Bezeichner | Trägt |
|---------|------------|-------|
| Rohgraph | `RawGraph` | Quelle, die bedeutsamen Knoten, die Kanten |
| Rohknoten | `RawNode` | OSM-Kennung, Lage, OSM-Tags |
| Rohkante | `RawEdge` | OSM-Weg, Start- und Zielknoten, volle Geometrie, OSM-Tags |

**Wann ein OSM-Knoten zum Rohknoten wird.** Ein OSM-Weg trägt in der Regel
weit mehr Stützpunkte, als betrieblich bedeutsam sind — die meisten
beschreiben nur die Kurvenform. Ein Knoten wird deshalb nur dann zum eigenen
`RawNode`, statt bloß ein Punkt auf der Geometrie einer `RawEdge` zu bleiben,
wenn er

- Anfang oder Ende eines Wegs ist,
- zwei oder mehr Wege verbindet (eine Verzweigung), oder
- selbst einen `railway`-Tag trägt — eine Weiche, ein Prellbock, eine
  Blockkennzeichnung sind betrieblich bedeutsam, auch wenn nur ein Weg sie
  berührt.

**Was in den Rohgraphen eingeht.** Jeder OSM-Weg mit einem `railway`-Tag,
gleich welchem Wert — die engere Auswahl nach Spurweite, Betriebsart und
Netzausschlussliste ist M1.3. Ein Weg, der einen Knoten außerhalb des Extracts
referenziert, oder ein railway-Weg mit weniger als zwei Knoten, bricht den
Import mit einer benannten Meldung ab, statt eine unvollständige Topologie
still auszuliefern.

**Was der Rohgraph bewusst nicht ist.** Kein `OperatingGraph`, keine
Zusicherungen aus Abschnitt 3 dieses Dokuments, keine Herkunftsangabe je
Attribut (`Provenance`) — die Quelle hängt hier am ganzen Rohgraphen, nicht am
einzelnen Wert, weil noch kein einzelnes Attribut ausgewählt wurde. Das kommt
mit der fachlichen Abbildung, die auf M1.3 folgt.

Umsetzung: [`crates/zugfolge-infra/src/import`](../crates/zugfolge-infra/src/import).

---

## 8. Der Netzfilter — Ergebnis von M1.3

Der Rohgraph führt jeden Weg mit einem `railway`-Tag, gleich welchem Wert.
Der Netzfilter wählt daraus das EBO-Netz aus (E14): ausschließlich
`railway=rail` in Regelspur, ohne Stromschiene. Jeder andere `railway`-Wert
fällt heraus — Straßenbahn, Stadtbahn, U-Bahn, Standseil- und
Einschienenbahn eingeschlossen, aber auch jeder Wert, den die Regel nicht
ausdrücklich nennt: Unbekanntes wird nicht stillschweigend als Eisenbahn
behandelt. Schmalspur scheidet zusätzlich über das `gauge`-Tag aus, weil OSM
sie sowohl als eigenen `railway`-Wert als auch als `railway=rail` mit
abweichender Spurweite führt. Eine Stromschiene erkennt der Filter am
OSM-Tag `electrified=rail` — der Bauart, nicht dem System, wie
`docs/betriebsgraph.md` 2 sie unterscheidet.

**Was bleibt.** Betriebs-, Abstell- und Anschlussgleise sind `railway=rail`
wie jedes Hauptgleis; der Filter verwirft nichts über ein `service`-Tag. Sie
bleiben Konfliktressourcen wie jedes andere Gleis und tragen später
Zusatzfahrten, Abstellung und Versorgung (M5).

Das Ergebnis ist wieder ein `RawGraph` — noch kein `OperatingGraph`. Welches
Gleis ein Hauptgleis wird, entscheidet die fachliche Abbildung, die auf M1.3
folgt.

Umsetzung: [`crates/zugfolge-infra/src/network_filter.rs`](../crates/zugfolge-infra/src/network_filter.rs).

---

## 9. Die Abdeckungsmessung — Ergebnis von M1.4

Jedes Band eines Gleisattributs trägt seinen Vertrauensgrad (`Confidence`,
Abschnitt 1). Die Abdeckungsmessung liest ihn und bildet ihn unmittelbar auf
die Qualitätsklassen aus `docs/daten.md` 5 ab: erfasst trägt Klasse A,
abgeleitet höchstens B, angenommen höchstens C. Das ist die einfachste
Abbildung, die sich heute begründen lässt (E19) — die eigentliche Klasse A
setzt zusätzlich geprüfte Blöcke und Fahrstraßen voraus (M1.6, M1.7), die
noch fehlen. Was diese Stufe liefert, ist die datenseitige Obergrenze, auf
der jene Stufen aufsetzen.

**Je Attribut und Streckenabschnitt**, wie der Milestone verlangt: Der
Bericht summiert Länge je Vertrauensgrad für jedes der vier Attribute
getrennt und zerlegt jedes Gleis an jeder Bandgrenze seiner vier Profile neu
— jeder entstehende Abschnitt trägt die Klasse seines schwächsten Attributs
an dieser Stelle, dieselbe Regel wie `Track::confidence`, nur ortsaufgelöst
statt gleisweit. Alle Anteile sind ganzzahlig in Promille (Invariante 3).

Umsetzung: [`crates/zugfolge-infra/src/coverage.rs`](../crates/zugfolge-infra/src/coverage.rs).

---

## 10. Das Neigungsprofil aus dem Höhenmodell — Ergebnis von M1.5

`docs/daten.md` 1 nennt die Längsneigung als eine der drei Angaben, die OSM
nicht liefert und die deshalb abgeleitet werden müssen — aus einem digitalen
Höhenmodell (DEM) entlang der Gleisgeometrie. M1.5 liefert das Verfahren:
Höhenstichproben (Position, Höhe) werden zu einem geglätteten
`BandProfile<Gradient>` verrechnet, wie `Track::builder` es erwartet. Jedes
abgeleitete Band trägt `Confidence::Derived`.

**Geglättet**, wie der Milestone verlangt: Statt Stichprobe gegen Stichprobe
zu rechnen, setzt das Verfahren Stützpunkte im Abstand einer
Mindestbandlänge, interpoliert die Höhe an jedem Stützpunkt linear aus den
umliegenden Stichproben und bildet erst zwischen den Stützpunkten ein Band.
Ein Reststück kürzer als die Mindestbandlänge bekommt kein eigenes Band,
sondern verlängert das letzte.

**Kein Import.** Das Höhenmodell der Pilotregion steht im Quellenregister
mit Status `pruefung` — Version, Bereitstellungsweg und Lizenz sind noch
nicht geklärt (`docs/rechte.md` 3). Invariante 8 verbietet jeden Import ohne
dokumentierte Freigabe. M1.5 liefert deshalb nur das Verfahren, nicht den
Import: Es rechnet mit Höhenstichproben, gleich woher sie stammen. Sobald das
Höhenmodell freigegeben ist, liest ein eigener Import reale Stichproben und
übergibt sie an dieses Verfahren — daran ändert sich dann nichts.

Umsetzung: [`crates/zugfolge-infra/src/elevation.rs`](../crates/zugfolge-infra/src/elevation.rs).

---

## 11. Die Blockableitung — Ergebnis von M1.6

`docs/daten.md` 1 führt die Blockabschnitte unter dem, was OSM **nicht** als
Objekte liefert: Sie müssen aus **Signalstandort, Zugbeeinflussung und
Topologie** abgeleitet werden. M1.6 liefert das Verfahren —
`derive_block_sections` zerlegt ein Gleis in die lückenlose Folge seiner
`BlockSection`s. Es fasst die drei Eingaben so zusammen:

- **Signalpositionen.** Ein Hauptsignal begrenzt einen Block, ein Vorsignal
  nicht. Neben dem ortsfesten Hauptsignal kennt das Verfahren die
  **Blockkennzeichen der Führerraumsignalisierung** (`SignalKind`): Eine reine
  LZB- oder eine reine ETCS-Strecke hat keine ortsfesten Hauptsignale, ihre
  Blockgrenzen liegen als LZB-Blockkennzeichen oder ETCS-Blockmarken vor. Diese
  Grenzen und die beiden Gleisenden bilden die realen Blockgrenzen.
- **Zugbeeinflussung entscheidet die Art des Blocks.** Läuft ein Abschnitt
  durchgehend unter LZB oder ETCS Level 2, ist er **führerraumsignalisiert**
  (`BlockKind::CabSignalled`) — ein realer Block, auch ohne ein ortsfestes
  Signal und auch über große Länge. Das ist der reine LZB- und der reine
  ETCS-Block, und er wird gerade **nicht** als Datenlücke behandelt. Ein
  ungesicherter Abschnitt dagegen trägt keine Zugfahrten und erreicht Klasse C.
- **Lücken werden zu virtuellen Blöcken.** Nur wo weder ein Kennzeichen noch die
  durchgehende Überwachung einspringt, gilt ein zu langer Abschnitt als
  Datenlücke und wird konservativ in gleich lange virtuelle Blöcke zerlegt
  (`BlockKind::Virtual`, Klasse B).

Die **Qualitätsklassifizierung A/B/C** je Block folgt daraus: ein realer Block
— signalisiert oder führerraumsignalisiert — auf erfasster, durchgehend
gesicherter Strecke ist Klasse A; ein virtueller Block Klasse B; ein Block über
einem ungesicherten Abschnitt Klasse C. Das setzt die Abbildung aus M1.4 fort,
in der die geprüften Blöcke noch fehlten. Ein Block ist **kein Gleis**: Er
entsteht neben dem Modell, nicht als Baustein darin (Abschnitt 5). Wie M1.5 ist
das Verfahren **kein Import** — es rechnet mit Signalpositionen, gleich woher
sie stammen.

Umsetzung: [`crates/zugfolge-infra/src/blocks.rs`](../crates/zugfolge-infra/src/blocks.rs).

---

## 12. Die Fahrstraßen- und Durchrutschwegableitung — Ergebnis von M1.7

`docs/daten.md` 1 nennt Fahrstraßen, Durchrutschwege und Flankenschutz als den
**schwersten Einzelposten in M1**: Sie müssen aus **Weichenlage und
Signalstandort** erzeugt werden. Der Spike aus M0.3 hat gezeigt, warum
(`infrastruktur.md` 1): Der Bahnhofskopf braucht **Ausschlussmengen** statt
einzelner Ressourcen. M1.7 liefert das Verfahren.

Ein `StationHead` beschreibt den Kopf als kleinen Graphen: `HeadElement`e sind
die belegbaren Stücke Gleis, `HeadNode`s ihre Verbindungspunkte — Endpunkt, Stoß
oder Weiche. Eine `Switch` trägt Spitze, Stamm- und Zweiggleis; durch sie führt
ein Fahrweg nur von der Spitze auf **eines** der beiden Zweige, nie von einem
Zweig auf den anderen. Genau diese Bindung macht die `SwitchPosition` einer
Fahrstraße aus. Ein `HeadSignal` steht am Knotenende eines Elements und ist der
Beginn einer Fahrstraße.

`derive_interlocking_routes` zählt von jedem Signal aus alle Fahrwege durch den
Weichenfächer auf. Jede `InterlockingRoute` hält fest, welche Elemente sie
belegt und welche Weichen sie in welche Lage zwingt. Endet sie an einem Signal,
folgt der **Durchrutschweg** (`OverlapPath`) dahinter — geradeaus über die
Grundstellung der folgenden Weichen bis zu einer Mindestlänge; endet sie am
Prellbock oder Gleisende, deckt der Endpunkt selbst. Aus dem Vergleich der
belegten Elemente und der geforderten Weichenlagen entsteht die
**Ausschlussmenge** je Fahrstraße: Zwei Fahrstraßen, die sich ein Element oder
eine Weiche in unterschiedlicher Lage teilen, schließen einander aus; zwei über
getrennte Elemente dürfen gleichzeitig gestellt werden. Das ist die
Konfliktressource, die der Spike offengelassen hat (M3.1, M3.3).

Die Qualitätsklasse einer Fahrstraße folgt dem Vertrauensgrad der Kopfdaten. Wie
M1.5 und M1.6 ist das Verfahren **kein Import** — es rechnet mit einer
gegebenen Weichenlage, gleich woher sie stammt.

Umsetzung: [`crates/zugfolge-infra/src/interlocking.rs`](../crates/zugfolge-infra/src/interlocking.rs).

---

## 13. Die Stationsdaten-Anreicherung — Ergebnis von M1.8

`docs/daten.md` 2 nennt OpenStation und StaDa als Stationsdaten-Kandidaten:
Bahnhofskategorie und Ausstattung — Barrierefreiheit, Wetterschutz,
Fahrgastinformation und mehr. `docs/rechte.md` 3 führt beide Quellen noch auf
`pruefung`; Invariante 8 verbietet jeden Import ohne dokumentierte Freigabe.
**M1.8 liefert deshalb das Modell und das Verfahren, mit dem eine
Betriebsstelle angereichert wird, keinen Import** — wie M1.5 für die Neigung
aus dem Höhenmodell.

**Warum Anreicherung anders ist als Ersterfassung.** Ein `OperatingPoint` oder
ein `Platform` trägt eine einzige `Provenance` für den ganzen Datensatz, weil
er in einem Zug entsteht — aus demselben Import, zur selben Zeit. Eine
Anreicherung dagegen kommt in Schüben: Die Bahnhofskategorie mag aus einer
Quelle stammen, die Ausstattung erst später aus einer anderen nachgetragen
werden. `StationEnrichment` trägt seine beiden Angaben deshalb je als
`Attributed<T>` — mit eigener Quelle und eigenem Vertrauensgrad je Feld, statt
mit einer gemeinsamen Herkunft für den ganzen Eintrag.

**Was angereichert werden kann.** Nur eine Betriebsstelle mit planmäßigem
Fahrgastwechsel (`OperatingPointKind::allows_passenger_stop`) hat
Stationsdaten — an einer Abzweig- oder Blockstelle gibt es keine Station
anzureichern. `StationEnrichmentCatalogBuilder::build` prüft das gegen einen
fertigen `OperatingGraph`, zusammen mit der Eindeutigkeit je Betriebsstelle.

Wie M1.5, M1.6 und M1.7 ist das Verfahren **kein Import** — es rechnet mit
einer gegebenen Bahnhofskategorie und Ausstattung, gleich woher sie stammen.
Sobald OpenStation oder StaDa freigegeben ist, füllt ein eigener Import
`StationEnrichment`-Werte; an diesem Modul ändert sich dann nichts.

Umsetzung: [`crates/zugfolge-infra/src/station.rs`](../crates/zugfolge-infra/src/station.rs).

---

## 14. Der Anlagenkataster — Ergebnis von M1.11

`docs/betrieb.md` 4 nennt den Satz wörtlich: **Anlagen sind Konfliktressourcen
wie Gleise.** Werkstätten, Behandlungs- und Waschanlagen, Tankstellen,
Entsorgungsanlagen und Abstellgleise haben Kapazität, Öffnungszeiten,
Nutzlänge und Baureihenkompetenz — erst dadurch können zwei EVU tatsächlich um
dieselbe Abstellanlage in derselben Nacht konkurrieren, statt dass Versorgung
eine unbegrenzte Ressource wäre.

**Eine `Facility` liegt auf einem vorhandenen Gleis** — nicht auf einem
durchgehenden Hauptgleis, auf dem Zugfahrten stattfinden, sondern auf einem
Neben-, Abstell- oder Anschlussgleis, wie es der Netzfilter aus M1.3
ausdrücklich erhält. Sie trägt eine `FacilityKind` (Werkstatt,
Behandlungsanlage, Waschanlage, Tankstelle, Entsorgungsanlage oder als Anlage
geführtes Abstellgleis), eine Kapazität — gleichzeitig behandelbare Fahrzeuge
—, eine `OpeningHours`, eine Nutzlänge und eine `FleetCompetence`: die
Baureihen, die sie behandeln kann, als Menge wie `TrainProtection` auf der
Strecke. Das ist dieselbe Form, mit der `docs/betrieb.md` 4 sie beschreibt, nur
je Anlage statt in Prosa.

`FacilityCatalogBuilder::build` prüft jede Anlage gegen einen fertigen
`OperatingGraph`: Das genannte Gleis muss existieren und darf kein
Hauptgleis sein, auf dem Zugfahrten stattfinden.

**Was hier bewusst nicht steht.** Die **Belegung** einer Anlage durch eine
konkrete Zusatzfahrt ist Aufgabe der Konfliktengine (M5.7) — derselben, die
auch den Fahrweg vergibt. M1.11 liefert nur den Kataster: welche Anlagen es
gibt und was sie leisten können, nicht, wer sie wann belegt.

Umsetzung: [`crates/zugfolge-infra/src/facility.rs`](../crates/zugfolge-infra/src/facility.rs).

---

## 15. Die Zugcharakteristik — Ergebnis von M1.9

`docs/infrastruktur.md` 2 nennt den Satz wörtlich: **„Zugcharakteristik statt
Fahrzeugliste."** Der Trassen-Planner (M3.4) und die Fahrzeitrechnung (M1.10)
rechnen mit Masse, Länge, Vmax, Anfahr- und Bremsvermögen, Antriebsart und
Zugsicherung — nicht mit konkreten Fahrzeugen. Erst `docs/betrieb.md` 1 bildet
echte Formationen auf eine `TrainCharacteristics` ab (M5.2). So arbeiten reale
Fahrplanrechner auch, und es entkoppelt die Trassenplanung vom Fahrzeugkatalog,
der zwei Milestones später entsteht.

**Warum genau diese sechs Angaben.** Sie sind exakt das, was eine
Fahrzeitrechnung braucht und nichts darüber hinaus. **Masse** geht in keine
Rechnung dieses Crates unmittelbar ein — Anfahr- und Bremsvermögen sind bereits
Beschleunigungswerte, in denen die Masse aufgeht, wie es das reale
Betriebsprogramm auch hält. Sie wird trotzdem geführt, weil M5.6
(Bedarfsmodell) und M11.5 (Bremshundertstel) sie brauchen werden. **Länge** und
**Vmax** begrenzen zusammen mit der Infrastruktur, was ein Zug befahren darf.
**Anfahr- und Bremsvermögen** sind die zwei Kennwerte, die M1.10 in Bewegung
setzt. **Antriebsart** (`TractionType`) entscheidet, welche Elektrifizierung
nutzbar ist — dieselbe Schnittmengenfrage wie bei der Zugsicherung: Diesel- und
Akkubetrieb sind vom Fahrdraht unabhängig, ein elektrischer Antrieb braucht ein
gemeinsames Bahnstromsystem mit dem Abschnitt. Und **Zugsicherung** ist
`TrainProtection` — derselbe Typ wie streckenseitig, denn `protection.rs` sagt
es bereits: „Fahrzeugseitig gilt dasselbe."

**Was hier bewusst nicht steht.** Kein Fahrzeugkatalog, keine Formation, kein
Zulassungsdatum, keine Eigentumsfrage — das liefert `docs/betrieb.md` 1 erst
mit M5.1. `TrainCharacteristics` ist die abstrakte Fahrzeitrechnungs-Sicht auf
einen Zug, keine Zusicherung über ein reales Fahrzeug.

Umsetzung: [`crates/zugfolge-infra/src/train.rs`](../crates/zugfolge-infra/src/train.rs).

---

## 16. Fahrdynamik und Fahrzeitrechner — Ergebnis von M1.10

`docs/monorepo.md` 3 sagt es ausdrücklich: **`infra-pipeline` ist die einzige
Domäne ohne `no-floats`** — genau, weil dieses eine Modul einmalig mit
Gleitkomma rechnet und dabei ganzzahlige Fahrzeittabellen ausgibt. Alles, was
hinein- und herausgeht, bleibt ganzzahlig (Invariante 3); nur die Physik
dazwischen rechnet in Gleitkomma.

**Das Verfahren.** Ein `RunPath` ist ein Fahrweg als lückenlose Folge von
`RunSegment`s — Länge, zulässige Geschwindigkeit (schon das Minimum aus Zug-
und Streckengeschwindigkeit) und Neigung in Fahrtrichtung.
`RunPath::push_track_range` baut ihn aus einem `Track`, geschnitten an jeder
Bandgrenze von Vmax- oder Neigungsprofil, und prüft dabei die
Zugsicherungs- und Antriebskompatibilität — ein Fahrweg, den der Zug gar nicht
befahren dürfte, bekommt gar keine Fahrzeit. `derive_running_time_table`
rechnet darüber die maximal mögliche Geschwindigkeit an jeder Segmentgrenze in
zwei Durchgängen: rückwärts die Bremskurve vor jeder Beschränkung, vorwärts das
tatsächlich Erreichbare aus Einstiegsgeschwindigkeit und Anfahrvermögen. Aus
beiden Geschwindigkeiten integriert das Verfahren je Segment ein Trapez- oder
Dreiecksgeschwindigkeitsprofil — Beschleunigung, Beharrung, Bremsung — zu einer
Zeit, aufgerundet in die Fahrzeittabelle: Eine vorberechnete Fahrzeit darf nie
eine schnellere Fahrt versprechen, als physikalisch möglich ist.

**Die Neigung wirkt auf beide Vermögen.** Steigung mindert das Anfahr-,
Gefälle mindert das Bremsvermögen — `sin θ ≈ Gefälle ‰ / 1000`, die im Bahnbau
übliche Kleinwinkelnäherung. Reicht ein Vermögen unter der Neigung nicht mehr
aus, meldet das Verfahren einen Fehler, statt eine unmögliche Fahrt zu
berechnen — dieselbe Haltung wie beim Domänenmodell: ein Fehler, der beim
Rechnen nicht auffällt, fiele sonst zum ersten Mal auf, wenn eine Welt schon
darauf läuft.

**Was hier bewusst nicht steht.** Masse geht nicht in die Rechnung ein —
Anfahr- und Bremsvermögen (M1.9) sind bereits Beschleunigungswerte, in denen
sie aufgeht. Kein Halt, keine Räum- oder Fahrstraßenbildezeit:
`docs/infrastruktur.md` 1 zählt sechs Anteile der Sperrzeit auf, dieses Modul
liefert genau einen — die Fahrzeit. Die anderen fünf gehören zum
Sperrzeitenmodell (M3.1). Und kein Fahrweg durch den Graphen — welche Gleise
ein Zug in welcher Reihenfolge befährt, entscheidet der Planner (M3.4); dieses
Modul rechnet nur die Zeit über einen bereits gegebenen Fahrweg.

Umsetzung: [`crates/zugfolge-infra/src/dynamics.rs`](../crates/zugfolge-infra/src/dynamics.rs).

Umsetzung: [`crates/zugfolge-infra/src/facility.rs`](../crates/zugfolge-infra/src/facility.rs).
