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
Bahnweg, gilt er fail-closed als nicht freigegeben. Der Compiler führt diesen
Befund ausschließlich in der internen Builddiagnose. Betrifft er eine
Pflichtdimension des freizugebenden EBO-Korpus, blockiert er den Kandidaten;
ein unvollständiges Objekt gelangt nicht in `InfraRelease`, PMTiles oder
Spieler-Readmodels und erweitert den Produktscope nicht.

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
- OpenStation und StaDa sind als Stationsdatenquellen freigegeben. OpenStation
  ist der kostenfreie Stations- und Bahnsteig-Pflichtinput; StaDa bleibt eine
  optionale Anreicherung und sein Fehlen blockiert keinen Jahreslauf. Jeder
  Release bindet nur tatsächlich verwendete Snapshots mit Version,
  Bereitstellungsweg, Attribution, Hash und Feldmapping. Eine allgemeine
  Freigabe erzwingt keine Vermischung beider Bestände.
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
gebunden an ein Fahrplanjahr statt an einen laufenden Abruf. Ihre bestehende
Rechtefreigabe bleibt unverändert; sie ist im Deutschland-Quellvertrag jedoch
nur eine optionale Gegenprüfung. OSM-PBF, offizielles DB-InfraGO-Open-Data,
OpenStation, GTFS und DEM müssen den Jahreslauf ohne diesen Snapshot tragen.
Die beiden Grenzen oben gelten unverändert für die Routensuche.

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
- **B — konservativ abgeleitet:** Datenlücken sind durch einen versionierten,
  deterministischen Offline-Regelsatz in **jeder** Pflichtdimension
  vollständig geschlossen. Für `synthetic-operational-b/v2` bindet ein
  Closure-Receipt Policy, neun Eingabedateien, Candidate, natives Operational-v2-
  Artefakt und Zustand per SHA-256. Zu den neun Eingaben gehören der freie
  GTFS-Snapshot, sein qualifizierter v2-Routenbericht und die kanonische
  `timetableRoutes`-JSONSeq. Der Bericht muss Snapshot- und Archiv-SHA,
  `CC-BY-4.0`, vollständige 1:1-Abdeckung aller ausgewählten B-Segmente sowie
  `operationalNetworkUsed=false`, `gtfsShapeGeometryUsed=false` und
  `inventedGeometryUsed=false` belegen. Das Ergebnis trägt intern `derived`, ist
  nicht Klasse-A-fähig und kann nur mit `orderable=true` betrieblich verwendet
  werden.

Eine bloße Annahme (`assumed`) ohne diesen vollständigen Schließungsnachweis
bleibt Klasse C. Ein sicherer Einzelwert wie 20 km/h genügt nicht, wenn
Fahrstraße, Schutzressourcen, Bahnsteigintervall oder Regionsübergabe offen
bleiben. Umgekehrt macht eine vollständige synthetische B-Ableitung keinen
realen Signalstandort, keine reale Weichenlage und keine reale Stellwerkslogik
geltend.

Das ausgelieferte Operational-v2-Artefakt enthält die synthetisch abgeleiteten
Betriebsobjekte tatsächlich
(`syntheticOperationalDetailsShipped=true`). Beobachtete und synthetische
Objekte teilen dabei dieselben Laufzeit-Collections
(`observedAndSyntheticObjectsShareRuntimeCollections=true`). Eine objektweise
Lineage wird nicht mit ausgeliefert
(`objectLevelProvenanceShipped=false`); diese Grenze ändert weder die
Derived/B-Klassifikation noch `realInterlockingFactsClaimed=false`.

Weitere betriebliche Releaseklassen gibt es nicht. Bleibt eine Pflichtdimension
des Operational-v2-Modells offen, setzt das `activationEligible=false` und
blockiert Signatur, Veröffentlichung und Weltaktivierung des Kandidaten. Davon
getrennt darf ein sichtbares, nicht bestellbares Karten-Evidenzobjekt C bleiben,
wenn der Operational-v2-Graph seine Funktion unabhängig vollständig als
Derived/B schließt. Das C-Objekt wird weder entfernt noch zu B umetikettiert und
ist selbst niemals betriebliche Source of Truth.

Jede Welt pinnt einen vollständigen Release-Satz aus Infrastruktur, Tarifen,
Nachfrage, Fahrzeugkatalog und Regeln. Updates erfolgen ausschließlich zu
angekündigten Fahrplanstichtagen.

### 5.1 Dimensionsqualität statt Gesamtetikett

Der Deutschland-Compiler 2026.1 bewertet Topologie, Höchstgeschwindigkeit,
Neigung, Elektrifizierung, Gleisanzahl, Signale, Blöcke und
Konfliktressourcen getrennt. Die öffentliche Objektklasse ist das Minimum der
für den jeweiligen Layertyp erforderlichen Dimensionen, ergänzt um Ursache und
betroffene Länge. A verlangt vollständige dimensionsbezogene Evidenz und
Review; B darf eine Lücke nur mit einer dokumentierten, vollständigen
Derived-Closure schließen; gewöhnliches `assumed` bleibt C. Bleibt eine
Pflichtdimension danach offen, blockiert sie den Kandidaten. Ein
Tag wie `zugfolge:validated=yes`, eine einzelne Quelle oder ein KI-Urteil darf
A nie pauschal setzen.

APN-Skizzen dürfen gemäß Projektentscheidung nur optional im internen
Jahreslauf zur Plausibilisierung von Bahnhofstopologien ausgewertet werden,
sofern Zugriff und Rechte im konkreten Lauf bestätigt sind. Ihr Fehlen ist kein
Release-Blocker. Sie helfen gegebenenfalls bei Gleisen, Weichen und Signalen in
Betriebsstellen, lösen aber weder Geschwindigkeitslücken noch die freie Strecke.
APN-Rohdaten und -Provenienz werden nicht ausgeliefert und sind allein nicht
A-fähig. Vollständiger Prozess, Artefaktvertrag und Abnahmegrenze:
[`deutschland-infracorpus.md`](deutschland-infracorpus.md)
und der feste [`Jahres-Prompt`](prompts/infrarelease-deutschland-jahreslauf.md).

### 5.2 Messstand des historischen Jahreskandidaten 2026.1

Der ausgeführte Deutschlandlauf verarbeitete 1.600.662 Fachobjekte in zehn
semantischen Layern. Nach dem damaligen Drei-Zustands-Schema waren 1.489.960
Objekte konservativ geschlossen und 110.702 Objekte unzureichend; darunter
fünf Gleisabschnitte mit zusammen 172.434 mm sowie zahlreiche Bahnsteige,
Weichen, Signale und Konfliktressourcen. Dieser Messstand bleibt als
Buildnachweis erhalten, erfüllt den heutigen A-/B-only-Vertrag aber
ausdrücklich **nicht** und darf nicht signiert, veröffentlicht oder aktiviert
werden.

Ein neuer Kandidat muss alle Objekte seines verbindlichen Korpusscopes als A
oder vollständig geschlossenes B erzeugen. Der öffentliche Qualitätsbericht
weist ausschließlich A/B sowie `unresolvedRequired=0` aus; die detaillierten
offenen Befunde bleiben im internen Buildnachweis. Erst ein neu gebautes
Artefakt mit neuem Hash kann den bisherigen Messstand ablösen.

**Lizenzhinweis:** Die ODbL kann die Projektlizenz nicht überschreiben — ist der
`InfraRelease` eine abgeleitete Datenbank im Sinne der ODbL, greifen deren
Share-alike-Pflichten unabhängig vom Lizenztext. Das ist zugleich ein Daten- und
ein Lizenzthema und braucht eine gemeinsame Antwort (→ `geschaeft.md`).

## 6. Betriebliche Releaseartefakte (E31)

Signal, Weiche, Block, Freimeldegrenze, Fahrstraßenvorlage, Durchrutschweg,
Flankenschutz, Rangiergrenze, Bahnsteigintervall, Regionsgrenze und RZÜ-Layout
tragen im operativen `InfraRelease` dieselbe interne Herkunfts- und
Rechtekette wie vorhandene Attribute. Fehlt ein rechtlich freigegebener oder
fachlich vollständiger Wert, darf der Offline-Compiler ihn nur nach einer
versionierten deterministischen Generierungsregel ergänzen. Eine laufende Welt
erfindet nichts. Kann diese Regel eine Pflichtdimension nicht vollständig und
konservativ schließen, blockiert der Befund den ganzen Releasekandidaten.

Die öffentliche Projektion darf für einen synthetischen B-Vertrag nur
`qualityClass=B`, `provenance=derived`, Policy- und Closure-Hash sowie
`realInterlockingFactsClaimed=false` ausweisen. Synthetische Signal-, Weichen-,
Fahrstraßen- oder Schutzdetails werden nicht als reale Anlagenobjekte
veröffentlicht. Diagnose-, Releasepflege- und Migrationswerkzeuge behalten die
objektgenaue Herkunft intern.

### 6.1 Zwei getrennte Qualitätsartefakte

Der detaillierte sichtbare Kartenbericht
`zugfolge-final-infrastructure-quality-report/v1` trägt
`purpose=visible-map-quality-evidence` und `operationalReleaseGate=false`. Die
öffentliche Projektion `zugfolge-static-map-quality/v2` bindet ihn und weist
A/B/C unverändert aus. Der separate
`zugfolge-operational-infrastructure-quality-report/v1` bindet diesen
Static-Map-Beleg per SHA-256, qualifiziert aber ausschließlich das native,
vollständig geschlossene Operational-v2-Artefakt. Nur dort muss die operative
Klassenbilanz C=0 und `unresolvedRequired=0` sein.

Diese Trennung lockert weder Rechte-, Signatur- noch Aktivierungsgates: Der
Operational-Bericht verlangt ein bytegeprüftes Closure- und natives Receipt,
setzt `mapClassCReclassified=false` sowie `mapObjectsRemoved=false` und erklärt
ausdrücklich, dass seine Freigabe weder Signatur noch Aktivierung impliziert.
Details: [`betriebsengine.md`](betriebsengine.md) 2.
