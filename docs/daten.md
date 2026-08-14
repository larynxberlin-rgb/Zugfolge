# Daten, Quellen, Rechte, Qualitätsklassen

## 1. Was OSM und OpenRailwayMap wirklich liefern

Das Tagging-Schema ist ausgesprochen detailliert, und Deutschland gehört zu den
am besten erfassten Netzen: Streckentopologie, `maxspeed`, `electrified` mit
Spannung und Frequenz, Gleisnummern über `railway:track_ref`, Betriebsstellen,
Zugbeeinflussung über `railway:pzb` / `railway:etcs`, Hauptsignale, Vorsignale
und Blockkennzeichen nach ESO. Für Signale gilt die Erfassung in Deutschland
weitgehend als abgeschlossen, mit bekannten Lücken bei Zs 3(v) und bei
vorübergehenden Langsamfahrstellen, die dort ohnehin nicht geführt werden.

Drei Dinge stehen **nicht** darin und müssen abgeleitet werden — das ist Arbeit,
kein Import:

| Fehlt | Konsequenz |
|-------|------------|
| Blockabschnitte als Objekte | aus Signalstandort, Zugbeeinflussung und Topologie ableiten (M1.6) |
| Fahrstraßen, Durchrutschwege, Flankenschutz | aus Weichenlage und Signalstandort erzeugen (M1.7, **XL** — schwerster Einzelposten in M1) |
| Längsneigung (`incline` kaum gepflegt) | aus einem Höhenmodell entlang der Gleisgeometrie ableiten (M1.5) |

Deshalb steht die **Abdeckungsmessung (M1.4) vor** der Blockbildung. Sie
entscheidet datenbasiert, welcher Abschnitt Qualitätsklasse A erreichen kann und
welcher konservativ als B geführt wird. Die Qualitätsklassen sind damit kein
Notbehelf, sondern das Ergebnis einer Messung.

### 1.1 EBO-Grenze für Punktobjekte

Signale, Weichen, punktförmige Konfliktressourcen und `rail_context` werden
nur exportiert, wenn ihre Knotenkennung zu mindestens einem nach dem
Netzfilter erhaltenen EBO-Weg gehört. Isolierte Punktobjekte bleiben ebenso
draußen wie Knoten mit eindeutigen BOStrab-/Nicht-EBO-Tags. Gehört derselbe
Knoten zugleich zu einem erhaltenen EBO-Weg und einem ausgeschlossenen
Bahnweg, gilt er fail-closed als nicht freigegeben. Qualitätsklasse C
beschreibt nur unzureichende Daten **innerhalb** dieses EBO-Ausschnitts und
erweitert den Produktscope nicht.

Der vorgelagerte PBF-Ausschnitt bewahrt deshalb ausgeschlossene Tram-,
Stadtbahn-, U-Bahn-, Schmalspur-, Standseil- und Einschienenbahnwege als reine
Scope-Evidenz. Ihre Kanten bestehen den Netzfilter weiterhin nicht und können
nie zu Tracks werden; ihre Knotenzugehörigkeit verhindert lediglich, dass ein
gemischt genutztes Punktobjekt nach dem Wegfilter fälschlich als EBO gilt.

## 2. Quellen und Rechte

**Grundregel: Ohne dokumentierte Freigabe kein Import.** Die Pilotregion muss
allein mit OSM-Extract und eigenen Regeln spielbar sein — sonst blockiert die
Rechtslage das gesamte Projekt.

- Ein genehmigter, versionierter OSM-PBF-Extract ist die Basis für Geometrie und
  Railway-Tags. OpenRailwayMap ist dabei Interpretationsdokumentation, kein
  separater Datenprovider.
- OSM-abgeleitete und unabhängig lizenzierte Fakten bleiben getrennte
  Datenebenen, bis eine qualifizierte ODbL-Prüfung die Derivative-/Collective-
  Database- und Bereitstellungspflichten freigibt.
- OpenStation und StaDa sind als Stationsdatenquellen freigegeben. Jeder
  Jahresrelease bindet trotzdem nur den tatsächlich verwendeten Snapshot mit
  Version, Bereitstellungsweg, Attribution, Hash und Feldmapping. Der Kandidat
  2026.1 verwendet OpenStation unter CC0; eine allgemeine Freigabe erzwingt
  keine Vermischung beider Bestände.
- RINF bleibt bis zu einer schriftlichen Wiederverwendungsentscheidung
  blockiert. pathOS und TPN sind ohne neue Berechtigung und ausdrücklichen
  Vertrag als Spiel- oder Validierungsbackend ausgeschlossen.
- Öffentliche OSM-/OpenRailwayMap-Tiles und öffentliches Nominatim werden nicht
  produktiv genutzt. Das Spiel erzeugt und hostet eigene Dark-Vector-Tiles.
- Der offizielle Datensatz „Infrastrukturdaten der DB InfraGO“ ergänzt OSM
  jährlich unter CC BY 4.0 um amtliche Streckensegmente, Betriebsstellen,
  Kilometrierung, Geschwindigkeit, Elektrifizierung, Gleisanzahl sowie Bauwerke.
  Er ersetzt keine Einzelgleis-, Signal- oder Fahrstraßentopologie.
- Entgeltregeln aus TPS-/SPS-/APS-/INB- und Anlagen-/Stationspreisquellen werden
  erst nach einer periodenbezogenen Rechteentscheidung als eigene, versionierte
  Regeln implementiert und mit zulässigen offiziellen Beispielen geprüft.
- Reale Baustellen- und Störungsfeeds benötigen einen Vertrag, der kommerziellen
  Abruf, Speicherung, Ableitung, Kartendarstellung, Replay, Audit, Aufbewahrung
  und Löschung abdeckt.
- **Jedes importierte Attribut trägt Quelle, Lizenz, Gültigkeit, Checksumme und
  Confidence.**

## 3. Trassenfinder (E10)

Wertvoll ist die **Struktur**: welche Parameter eine Trassenanfrage definieren —
Regellokbezeichnung, Kupplungsart, längenabhängige Achslastgrenzen, Zuglänge und
Masse — und welche Kostenkategorien real existieren: Trassenpreis nach TPS,
Stationsentgelt nach SPS, Anlagenpreise, Energiebedarf. Das ist eine fertige
Modellierungscheckliste für `PathRequest` und `EconomyRelease`.

Zwei Grenzen bleiben unabhängig von der Rechtslage bestehen:

- **Kein Laufzeitdienst.** Determinismus und Replay verlangen, dass jede
  Kostenberechnung aus dem gepinnten `EconomyRelease` der Welt kommt. Ein
  externer Dienst im heißen Pfad macht Replays unreproduzierbar und koppelt die
  Simulation an fremde Verfügbarkeit.
- **Keine Präzisionswahrheit.** Der Betreiber weist Fahrzeiten, Energiebedarf
  und Preise selbst als unverbindliche Richtwerte aus vereinfachter Berechnung
  aus. Für einen Größenordnungsabgleich genau richtig, für eine Referenzwahrheit
  nicht.

Sinnvolle Nutzung: **in der Entwicklung manuell gegen einzelne Richtwerte
kalibrieren, im Betrieb ohne ihn auskommen.** Eine solche Abfrage kann ein
minimales, unmittelbar an den konkreten Kalibrierlauf gebundenes eigenes
Ergebnisprotokoll erhalten. Automatisierter Abruf, Rohantworten und eine
systematische Referenzsammlung bleiben gesperrt. Die genaue Grenze steht im
Rechte-Gate (`rechte.md` 4; Eintrag `trassenfinder` im Quellenregister, Status
`entwicklung`). Eine gegen denselben Einzelwert eingestellte Rechnung ist noch
keine unabhängige Validierung.

**Davon getrennt (E22):** Dieselbe API stellt unter `/infrastrukturen` eine
reine Stammdatenressource bereit — Betriebsstellen und Streckensegmente,
gebunden an ein Fahrplanjahr statt an einen laufenden Abruf, öffentlich ohne
Nutzungsbedingungen zugänglich. Das ist keine „unverbindliche Richtwert"-Werte
im Sinne von E10, sondern Stammdaten, und wird als eigene, jährlich einmalig
gezogene Importquelle geführt (`trassenfinder-infrastruktur-api`, Status
`freigegeben`) — Grundlage der jährlichen Infrastrukturaktualisierung zum
realen Fahrplanwechsel. Die beiden Grenzen oben gelten unverändert für die
Routensuche.

## 4. Trassenpreissystem als Vorbild für den `EconomyRelease`

Die reale Struktur ist übernahmefähig und liefert von sich aus die
mehrdimensionalen Zielkonflikte aus `produkt.md`: Grundpreis je Zugkm nach
Streckenkategorie, differenzierte Trassenprodukte für Personen- und
Güterverkehr, Zuschläge für hochbelastete Abschnitte, für besonders langsame
Züge und für schwere Güterzüge, dazu ein Anreizsystem, das Pünktlichkeit
finanziell bewertet. Getrennte Systeme für Stationen und Anlagen.

Genau dieses Gefüge — **nicht die konkreten Zahlen** — gehört in den
versionierten `EconomyRelease`.

## 5. Qualitätsklassen

- **A — validiert:** Jede für den konkreten Objekttyp erforderliche Dimension
  ist unabhängig und fachlich geprüft; vollständige Simulation.
- **B — konservativ:** Datenlücken werden durch sichtbare virtuelle Blöcke und
  versionierte sichere Annahmen geschlossen. Das Objekt kann betrieblich
  modelliert werden, wenn zusätzlich `orderable=true` gilt.
- **C — unzureichend:** Darstellung auf der Karte, aber keine
  Trassenbestellung.

Jede Welt pinnt einen vollständigen Release-Satz aus Infrastruktur, Tarifen,
Nachfrage, Fahrzeugkatalog und Regeln. Updates erfolgen ausschließlich zu
angekündigten Fahrplanstichtagen.

### 5.1 Dimensionsqualität statt Gesamtetikett

Der Deutschland-Compiler 2026.1 bewertet Topologie, Höchstgeschwindigkeit,
Neigung, Elektrifizierung, Gleisanzahl, Signale, Blöcke und
Konfliktressourcen getrennt. Die öffentliche Objektklasse ist das Minimum der
für den jeweiligen Layertyp erforderlichen Dimensionen, ergänzt um Ursache und
betroffene Länge. A verlangt vollständige dimensionsbezogene Evidenz und
Review; B darf eine Lücke mit einer dokumentierten, sicheren Regel schließen;
C bleibt sichtbar, aber nicht bestellbar. Ein Tag wie
`zugfolge:validated=yes`, eine einzelne Quelle oder ein KI-Urteil darf A nie
pauschal setzen.

APN-Skizzen werden gemäß Projektentscheidung nur im internen Jahreslauf zur
Plausibilisierung von Bahnhofstopologien automatisiert ausgewertet. Sie helfen
bei Gleisen, Weichen und Signalen in Betriebsstellen, lösen aber weder
Geschwindigkeitslücken noch die freie Strecke. APN-Rohdaten und -Provenienz
werden nicht ausgeliefert und sind allein nicht A-fähig. Vollständiger Prozess,
Artefaktvertrag und Abnahmegrenze: [`deutschland-infracorpus.md`](deutschland-infracorpus.md)
und der feste [`Jahres-Prompt`](prompts/infrarelease-deutschland-jahreslauf.md).

### 5.2 Messstand des Jahreskandidaten 2026.1

Der reale Deutschlandlauf verarbeitet 1.600.662 sichtbare Fachobjekte in zehn
semantischen Layern. Der öffentliche Qualitätsbericht weist 0 Objekte als A,
1.489.960 als B und 110.702 als C aus. Das ist beabsichtigt ehrlich: Keine
Dimension wurde allein aufgrund einer Quelle, einer automatischen Ableitung
oder einer internen Planprüfung zu A hochgestuft.

Für den betrieblich wichtigsten Gleislayer ergeben sich 609.242 Abschnitte mit
83.491.261.974 mm Gesamtlänge. Davon sind 609.237 Abschnitte beziehungsweise
83.491.089.540 mm als konservatives B-Modell geschlossen; fünf Abschnitte mit
zusammen 172.434 mm bleiben C. Weitere C-Objekte sind insbesondere 21.109
Bahnsteige, 30.088 Weichen, 28.603 Signale und 30.098
Konfliktressourcen. `classCPlayable=false` bleibt ein hart geprüftes Gate.

Damit ist der Kandidat keine Behauptung hundertprozentiger Realitätsgleichheit.
Er ist ein deutschlandweit sichtbarer Bestand, in dem bestellbare Bereiche
über versionierte Regeln vollständig und konservativ modelliert werden. Der
maschinenlesbare Bericht wird im Kartenpaket als `manifests/quality.json`
ausgeliefert; Herleitung und Abnahmegrenze stehen in
[`deutschland-infracorpus.md`](deutschland-infracorpus.md).

**Lizenzhinweis:** Die ODbL kann die Projektlizenz nicht überschreiben — ist der
`InfraRelease` eine abgeleitete Datenbank im Sinne der ODbL, greifen deren
Share-alike-Pflichten unabhängig vom Lizenztext. Das ist zugleich ein Daten- und
ein Lizenzthema und braucht eine gemeinsame Antwort (→ `geschaeft.md`).
