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
| Blockabschnitte, virtuelle Blöcke | M1.6 |
| Weichen, Fahrstraßen, Durchrutschwege, Ausschlussmengen im Bahnhofskopf | M1.7 |
| Stationsdaten-Anreicherung | M1.8 |
| Anlagenkataster — Werkstatt, Wäsche, Tankstelle, Entsorgung, Abstellung | M1.11 |
| `InfraRelease` mit Version, Lizenz, Prüfsumme und Confidence je Attribut | M1.12 |

Das Modell ist auf alle vorbereitet und nimmt keines vorweg. **Ein
Blockabschnitt ist kein Gleis, und eine Fahrstraße ist keine Kante** — wer sie
hier unterbrächte, müsste sie in M1.6 und M1.7 wieder herausoperieren. Die
Vorbereitung besteht aus drei Dingen: der Richtungsbindung des Gleises, die
beide Konfliktarten trägt; dem Bandprofil, in dem Signale und Blöcke später
ihre Abschnitte finden; und dem Vertrauensgrad, den die Abdeckungsmessung
liest.

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
