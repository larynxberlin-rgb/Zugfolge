# M15.4 — Konfigurationsgetreue begehbare Fahrzeuginnenräume

Version: `interior-layout/v1`. Dieser Fachvertrag konkretisiert
[E29](schaffnermodus.md) und [Issue #214](https://github.com/larynxberlin-rgb/Zugfolge/issues/214).
Er beschreibt die verbindlichen Regeln. Der implementierte Stand und die
tatsächlich ausgeführten Nachweise stehen im
[M15.4-Prüfbericht](conductor-interior/README.md).

## 1. Zweck und fachliche Autorität

`InteriorLayoutV1` ist die deterministische, begehbare Innenraumprojektion einer
konkreten M5-Formation. Sie beschreibt deren tatsächliche Konfiguration und
Kapazität mit generischen, ausdrücklich versionierten Geometrieregeln. Sie ist
keine exakte Nachbildung einer realen Baureihe. Weder eine Grafik noch der
Browser ändern Fahrzeugbestand, Formation, Sitzplatzzahl oder Abfahrtsrecht.

| Quelle | Verbindliche Aussage |
|---|---|
| Persistierter M5-Zustand und dessen verifizierter Mobilisierungssnapshot | Welt, EVU, konkrete Formation, geordnete individuelle Fahrzeuge, Ausrichtung und Zustandsrevision |
| Gepinnter Serverdeployment und committed Simulationszeit | Aktive Fahrplanperiode; M5 selbst führt keine Periodenzuordnung |
| Gepinnter Fleet-Authority-Release | Fahrzeugidentität, technische Länge und belegte Kapazitäts-/Ausstattungswerte |
| Vollständiger M5-Konfigurationsbeleg am Asset | Baulich feste `StructuralConfiguration` und aktuell eingebaute `InteriorConfiguration` |
| Gepinnte M15-Geometriepolicy | Generische Kastenaufteilung, Innenbreite, Decks, Treppen, Türanordnung, Gang- und Modulmaße sowie ausdrückliche Übergangsrechte |
| Freigegebenes M15.3-Artmanifest | Darstellbare eigene Bildmotive; keine technische Fahrzeuggeometrie oder Kapazität |

Der Plattformdienst liest diese Quellen nach Welt-, Perioden-, EVU- und
Kontozugriffsprüfung. Das Layout ist formationsbezogen und besitzt noch keine
Zuglaufzuordnung. Der Aufrufer darf Kennungen und einen erwarteten
Zustandshash senden, aber keinen eigenen Flottencheckpoint, keine fertige
Formation, keine Geometriepolicy und kein Platzinventar einschleusen.
Nach einem Zugriffsentzug oder einer Zustandsänderung ist der vorherige
Prüferfolg keine fortgeltende Autorisierung.
Der konkrete lesende API-Endpunkt, die unabhängige Atlas-/Deploymentprüfung,
die committed Periodenquelle und datensparsame Telemetrie stehen im
[Plattformvertrag](conductor-interior-platform.md).

## 2. Vollständiger M5-Konfigurationsbeleg

Der vollständige Feld-, Validierungs- und Persistenzvertrag steht kanonisch in
[M5-Konfiguration als Quelle für M15.4](m5-interior-configuration.md).
Das dort definierte optionale `vehicleConfiguration` mit Schema
`m5-vehicle-configuration/v1` überträgt die bestehende feste Grundauslegung
und den tatsächlich eingebauten Innenraum verlustfrei. M15 liest ausschließlich
die nativ geprüfte, committed Fassung dieses Belegs.

Fehlende historische Belege bleiben in M5 abwesend und behalten dessen
bisherige Hash-/Restore-Semantik. In M15.4 führen sie bei einem
Passagierfahrzeug zu einer konkreten Ablehnung. Es entstehen keine
Standardkapazitäten oder geschätzten Tür-/WC-Angaben. Widersprüche gegen die
übrigen M5-Fakten werden an der gemeinsamen nativen Grenze abgelehnt.

Ein abgeschlossener Werkstattumbau muss den tatsächlich übernommenen Beleg und
seinen Zustandshash ändern. Ein lediglich geplanter oder noch nicht bezahlter
Umbau darf kein neues Layout aktivieren. M15 erzeugt keine eigenen
Umbauentscheidungen; es liest die von M5 übernommene Konfiguration.

## 3. Öffentliche Verträge und Pins

Die reine Rust-Grenze heißt `build_interior_layout`; die JSON-Grenze
`build_interior_layout_json`. Die Native-Runtime-Grenze heißt
`buildConductorInterior`. Sie nimmt `BuildInteriorLayoutInputV1` entgegen
und liefert ausschließlich ein vollständig geprüftes `InteriorLayoutV1` oder
einen konkreten `InteriorLayoutIssueV1`-Befund. Keine teilweise validierte
Geometrie darf als betretbares Layout erscheinen.

`InteriorLayoutBindingV1` bindet mindestens:

- Welt und Fahrplanperiode;
- EVU, aber keine erfundene Zuglaufzuordnung;
- Formation, deren Revision und verifizierten M5-Zustandshash;
- Fleet-Authority-Release samt Hash;
- Hash des verifizierten Mobilisierungssnapshots;
- Geometriepolicy samt Versions-/Hashbindung;
- Art-Release und exakten Artmanifest-Hash.

Die konkret benannten Pins sind `worldId`, `periodId`, `operatorId`,
`formationId`, `formationRevision`, `fleetStateHash`,
`fleetAuthorityReleaseId`, `fleetAuthorityReleaseHash`,
`mobilizationSnapshotHash`, `artReleaseId`, `artManifestHash` und
`geometryPolicyHash`. Der Eingang enthält `authorityRelease`, `mobilization`
und `geometryPolicy`. Ihre Vertrauensprüfung erfolgt am Plattformdienst; der
reine Kern prüft zusätzlich alle Referenzen, Hashes und fachlichen Widersprüche.
`BuildInteriorLayoutInputV1` trägt dafür das Schema
`conductor-interior-layout-input/v1` und einen ausdrücklichen `binding`-Block.
Der Mobilisierungssnapshot allein enthält nur seine bisherigen aggregierten
Fachwerte; sein Hash beweist keine vollständige Tür- oder WC-Konfiguration.
Deshalb sind der zusätzlich verifizierte Authority-Release- und Fleet-State-Hash
verpflichtend.

Der genaue Transport steht in den
[Rust-Typen](../crates/zugfolge-conductor/src/interior_types.rs) und ihrer
[TypeScript-Projektion](../packages/runtime-native/src/interior-types.ts).
Das Layout führt neben `binding`, `layoutId` und `layoutHash` die
Gesamtkapazität `capacity`, die geordneten `vehicles`, `passengerPlaces`,
`specialBays`, `obstacles`, `nodes`, `edges`, `interactions`, `doors`, `seats` und den
verifizierten Einstieg `entranceNodeId`. Die Fahrzeuge enthalten ihre
vollständige Konfiguration samt `configurationHash`, eigene Kapazität und
geordnete Kästen. Ein für Fahrgäste unbegehbarer Lokomotivkasten darf
`configuration: null` führen; er erzeugt kein Fahrgastplatzinventar.

Der Hash des vollständigen Layouts bindet diese Pins, die konkrete
Fahrzeugreihenfolge und Ausrichtung, alle verwendeten Konfigurationsbelege,
Kästen und Decks, begehbare Flächen, Kollisionsflächen, Türen, Übergänge,
Treppen, Interaktionspunkte und das vollständige Platzinventar. Arrays ohne
fachliche Reihenfolgebedeutung werden nach stabilen Kennungen kanonisiert.
Die Formation selbst wird nicht nach Fahrzeugkennung sortiert: ihre
autoritative Reihenfolge ist fachlich relevant.

Ein Restore mit denselben Eingaben liefert bitgleich dieselben Kennungen,
Positionen und Hashes. Ein Perioden-, Formations-, Konfigurations- oder
Releasewechsel verlangt eine neue Ableitung. Ein alter Clientpin wird dabei
abgelehnt; ein alter Innenraum wird nicht durch veränderte Koordinaten unter
demselben Hash weiterverwendet.

## 4. Generische Geometriepolicy

`InteriorGeometryPolicyV1` enthält alle Gestaltungsparameter ausdrücklich und
ganzzahlig. Insbesondere ist ihre Zuordnung zu einem Fahrzeugtyp beziehungsweise
einer vollständigen Konfiguration ein eigener releasegebundener Beleg.
Baureihenbezeichnungen, Handelsnamen, Sitzplatzzahlen und PNG-Dateinamen dürfen
weder Deckzahl noch Durchgangsrechte implizit bestimmen.

Die Policy regelt:

- Aufteilung eines individuellen Fahrzeugs in geordnete Wagenkästen;
- Länge, nutzbare Innenbreite und Wände jedes Kastens;
- dessen echte Innenebenen und die Lage ihrer End-/Treppenbereiche;
- Anzahl, lichte Breite und deterministische Längslage der Seitentüren;
- Gangbreiten, freie Zugänge und Kollisionsabstände;
- Modulmaße und Anordnung für die gewählte Sitzart und Bestuhlungsdichte;
- WC-, barrierefreie WC-, Fahrrad-, Kinderwagen- und Rollstuhlflächen;
- tatsächlich erlaubte innere und äußere Wagenübergänge.

Ihr Schema lautet `conductor-interior-geometry-policy/v1`. Sie besitzt
`policyId` und `vehicleTypes`. Jeder Profileintrag benennt `vehicleTypeId`,
`configurationHash`, eine ausdrückliche `artFamily` und die geordneten
`bodies`. Mehrere Profile desselben Fahrzeugtyps sind nur mit unterschiedlichen
vollständigen Konfigurationshashes zulässig; die Auswahl trifft genau den
Hash des aktuellen M5-Belegs. Ein Typname allein darf keine nach einem Umbau
veraltete Geometrie auswählen. `configurationHash: null` ist ausschließlich
für ein nicht für Fahrgäste vorgesehenes Fahrzeug ohne Innenraumbeleg zulässig.
Jeder Kasten enthält
`bodyId`, `lengthMm`, `widthMm`, `deckIds`, `entranceDeckId`,
`doorPositionsMm`, `stairs`, `gapAfterMm`, `frontGangway` und `rearGangway`.
`deckIds` ist entweder `['main']` oder `['lower','upper']`; der Einstieg liegt
auf `main` beziehungsweise `lower`. Eine Treppe trägt `stairId`,
`fromDeckId`, `toDeckId` und `atMm`.

Die Türlängslagen gelten symmetrisch für beide Fahrzeugseiten. Ihre Summe über
die Kästen entspricht exakt `doorCountPerSide`; jede lichte Breite kommt aus
`doorWidthMm`. Randüberläufe und Überschneidungen mit ungeeigneten Endbereichen
sind Fehler. Der letzte Kasten erzeugt keinen nicht belegten Restabstand.

Die V1-Designregeln verwenden 100 mm Wände, einen 1.000 mm breiten Mittelgang,
450 mm Sitzbreite und einen 580 mm breiten Prüfkörper für die Schaffnerbewegung.
Der Reihenabstand ist bei `dense` 700 mm, bei `standard` 850 mm und bei
`spacious` 1.000 mm. `face_to_face` ergänzt diesen Abstand um 250 mm und
wechselt die Sitzrichtung zwischen den Reihen; `row` richtet sie einheitlich
aus. `folding` verwendet die geringere eigene Sitztiefe und erzeugt durch
die Klappbarkeit keine zusätzliche Stehplatzkapazität. Diese Zahlen sind generische Spielgeometrie, keine
Baureihenmessung oder Barrierefreiheitszertifizierung. Andere Werte verlangen
eine ausdrücklich geänderte, erneut geprüfte Policy-/Schemafassung.

Die reservierten Module derselben Version verwenden folgende ganzzahlige
Maße. Längsausdehnung und Querbreite werden im ausgegebenen `rect` ausdrücklich
geführt; die Flächen müssen neben Gang, Türen und Treppen tatsächlich passen.

| Modul | Reserviertes Maß |
|---|---|
| Fester Sitz | 450 mm Breite, 500 mm Tiefe |
| Klappsitz | 450 mm Breite, 450 mm Tiefe; kein zusätzlicher Stehplatz |
| Rollstuhlfläche | 900 × 1.400 mm |
| Fahrradfläche | 600 × 1.600 mm |
| Kinderwagenfläche | 700 × 1.100 mm |
| WC | 800 × 1.600 mm |
| Barrierefreies WC | 900 × 2.200 mm |
| Treppenbereich | 900 × 2.000 mm |

Der stufenfreie Pfad verwendet einen 900 mm breiten Rollstuhl-Prüfkörper.
Auch diese reservierten Spielmaße sind keine Zulassungs- oder Messdaten einer
realen Fahrzeugbaureihe.

Die Summe der Kastenlängen und ausdrücklich modellierten inneren Übergänge
entspricht exakt der M5-Fahrzeuglänge. Ein langes Triebzug-Asset darf nicht
stillschweigend als einzelner unrealistisch langer Wagenkasten gelten. Eine
Kupplung stellt ebenfalls keinen begehbaren Gangübergang her: dessen Lage,
lichte Breite und Berechtigung müssen ausdrücklich vorliegen.

Die sieben Atlasdateien und insbesondere die generischen Fahrzeugbildrahmen
von 3 × 27 m aus [M15.3](art-atlas.md) sind keine M5-Maßquelle. Das Layout
verwendet seine eigenen bestätigten Millimetermaße. Die Darstellung darf
passende freigegebene Motive aus dem Atlas zu diesen Flächen zusammensetzen;
ein eingebranntes Sitzbild darf keine von M5 abweichenden Sitze vortäuschen.

## 5. Koordinaten, Ausrichtung und Doppelstockwagen

Jeder räumliche Punkt besitzt eine konkrete Fahrzeug-, Wagenkasten- und
Deckidentität. `xMm` liegt längs des zugehörigen Kastens, `yMm` quer in dessen
nutzbarer Breite. Beide Werte sind nichtnegative, sichere Ganzzahlen in
Millimetern und liegen innerhalb der bezeichneten Fläche. Die lokale
Koordinate bleibt von der Position des Zuges auf dem Gleis unabhängig.

Die Platzierung der Kästen in der Formation und eine gegenläufige
Fahrzeugausrichtung sind explizite Transformationen dieser lokalen Räume.
`vehicleOffsetMm` und `formationOffsetMm` bezeichnen die Längsplatzierung des
Kastens im individuellen Fahrzeug beziehungsweise in der Formation;
`reversed` bezeichnet seine autoritative Ausrichtung. Diese Werte ersetzen
keine lokale Kasten- oder Deckidentität.
Eine Drehung vertauscht sichtbar Vorder-/Hinterende und Fahrzeugseiten; sie
erfindet keine neue Tür oder Fahrzeugkennung. Physische Platzkennungen bleiben
an ihr Fahrzeug, ihren Kasten, ihr Deck und ihren lokalen Platz gebunden.

Ein Doppelstockwagen besitzt mindestens ein Unter- und ein Oberdeck. Gleiche
lokale x/y-Koordinaten auf verschiedenen Decks sind unterschiedliche Orte.
Weder ein großer y-Versatz außerhalb der Wagenbreite noch eine erfundene
Fahrzeugkennung kodiert ein Oberdeck.

Treppen bestehen aus zwei belegten Zugängen in den jeweiligen Decks und einer
ausdrücklichen verbindenden Kante. Diese Zugänge und ihre Kollisions-/Freiflächen
werden vor der Sitzverteilung reserviert. Ein Deckwechsel ist nur über eine
solche Verbindung möglich. Die Treppe ist kein zusätzlicher Sitz-, Steh- oder
Rollstuhlplatz. Höhenunterschiede dürfen nicht durch frei begehbare
Querverbindungen oder ein unsichtbares Teleportieren verschwinden.

Die Unterdeck-Tür-, Rollstuhl-, Mehrzweck- und gegebenenfalls barrierefreie
WC-Verbindung muss ohne Treppenkante erreichbar sein. Ein Oberdeck gilt nicht
allein deshalb als barrierefrei, weil der Wagen einen Rollstuhlplatz besitzt.
Ein tatsächlich modellierter geeigneter Lift benötigt einen eigenen belegten
Verbindungstyp; ohne ihn bleibt eine Treppe für Rollstuhlpfade ausgeschlossen.

## 6. Begehbarkeit, Kollision und Interaktionen

Die Erzeugung reserviert zuerst Wände, Endbereiche, Türen, Übergänge,
Treppen und durchgehende Gänge. Danach werden feste Nutzungsflächen und die
konkreten Plätze eingesetzt. Die zuletzt verbleibende Fläche darf nicht durch
eine nachträgliche Kapazitätskorrektur aufgefüllt werden.

Der Begehbarkeitsgraph verbindet ausschließlich Punkte auf nachgewiesenen
freien Flächen. Jede Kante bleibt vollständig in diesen Flächen und hält die
in der Policy festgelegten Kollisionsabstände ein. Eine Prüfung nur der beiden
Endpunkte reicht nicht: auch ein diagonaler Weg darf keine Wand oder Sitzreihe
durchschneiden. Türen, Treppen und Wagenübergänge sind benannte Verbindungen
mit überprüfbaren Endpunkten.

`InteriorNodeV1` bindet eine `nodeId` an einen vollständigen
`InteriorPointV1`. `InteriorEdgeV1` verbindet `fromNodeId` und `toNodeId`
mit `edgeId`, ganzzahliger `lengthMm`, `wheelchairAccessible` und
`kind: walk | stair | gangway`. Eine Gangway oder Treppe bleibt damit auch
im Browser eine ausdrückliche Kante. `InteriorObstacleV1` trägt Kasten und
Deck sowie ein lokales `rect` mit `xMm`, `yMm`, `lengthMm` und `widthMm`.
Ein `InteriorInteractionV1` benennt seinen `targetId` und einen tatsächlich
erreichbaren `nodeId`, statt die Kollisionsfläche zum Laufziel zu erklären.
`InteriorDoorV1` nennt außerdem die wirkliche Fahrzeugseite `left` oder
`right`, ihre konkrete Öffnung als `rect` und den zugehörigen Zugangsknoten.
Die Darstellung zeichnet damit die belegte Türbreite, keinen bloßen Türpunkt.
`InteriorSeatV1` verbindet `placeId` und `obstacleId` mit
`facing: forward | backward`. Die Darstellung zeigt eine entsprechende
Lehne und Sitzrichtung; sie ersetzt die einzelne M5-Sitzfläche nicht durch
eine Grafikkachel mit mehreren eingezeichneten Sitzen.

Alle für den Schaffner vorgesehenen Innenebenen und Interaktionspunkte des
angenommenen Layouts müssen von dessen Einstieg erreichbar sein. Eine
unterbrochene Passagierverbindung wird mit
`formation_passenger_area_disconnected` abgelehnt und nicht durch einen
fiktiven Übergang repariert. Eigene Außentüren zweier getrennter Komponenten
stellen in M15.4 keine Verbindung her; ein späterer Bahnsteig-/Sitzungswechsel
ersetzt den geforderten zusammenhängenden Innenraumbeweis nicht.
Nicht für Fahrgäste vorgesehene Führerstands- oder
Technikflächen bleiben als abgegrenzte Flächen sichtbar; sie werden nicht als
öffentliche Sitz- oder Stehfläche gezählt.

Ein fester Sitz und ein WC haben eine belegte Kollisionsfläche. Ihr
Interaktionspunkt liegt am erreichbaren freien Zugang; der Schaffner muss
nicht durch den Sitz beziehungsweise durch die WC-Wand laufen. Ein Sitzplatz
des Fahrgasts darf innerhalb seiner Sitzfläche liegen, ein stehender Fahrgast
benötigt seine reservierte freie Fläche. Interaktionspunkte und Sitzflächen
sind daher ausdrücklich unterschiedliche Objekte.

Die reine Bewegungsprüfung verwirft fremde Layoutpins, falsche Decks,
außerhalb liegende Punkte und kollidierende Wege. M15.4 liefert diese
Geometrie- und Bewegungsprüfung; die persistente Schaffnersitzung und deren
Produktivkommandos bleiben bei M15.7. Eine Browserabnahme von M15.4 muss trotzdem
die wirkliche geprüfte Geometrie begehen können.

`FindInteriorPathInputV1` bindet das vollständige Layout, seinen erwarteten
Hash, `fromNodeId`, `toNodeId` und `wheelchair`; das Ergebnis `InteriorPathV1`
enthält die geordnete Folge von Knoten und Kanten samt Gesamtlänge.
`CheckInteriorMovementInputV1` prüft dagegen einen konkreten Weg von `from`
nach `to`, ebenfalls mit erwartetem Layouthash und Rollstuhlmerkmal.
Ein Kasten- oder Deckübergang verlangt `transitionEdgeId`; innerhalb einer
Ebene ist dieser Wert `null`. `InteriorMovementResultV1` enthält `allowed`
und bei Ablehnung eine konkrete `issue`. Keiner dieser Eingänge autorisiert
den Aufrufer oder ersetzt die erneut geprüfte serverseitige Sitzungsgrenze.

## 7. Kapazitäten und M15.2-Anschluss

Das Platzinventar stimmt pro Asset und in der Summe exakt mit M5 überein:

| M5-Wert | Innenrauminventar |
|---|---|
| `firstClassSeats` | genau diese Anzahl Premium-Sitzplätze |
| `secondClassSeats` | genau diese Anzahl Standard-Sitzplätze |
| `multipurpose.standing` | genau diese Anzahl Standard-Stehplätze |
| `multipurpose.wheelchairs` | genau diese Anzahl physischer Rollstuhlflächen in `specialBays` |
| `multipurpose.bicycles` | genau diese Anzahl physischer Fahrradflächen in `specialBays` |
| `multipurpose.pushchairs` | genau diese Anzahl physischer Kinderwagenflächen in `specialBays` |
| `toilets`, `accessibleToilets` | genau diese Anzahl WC- beziehungsweise barrierefreier WC-Flächen |

M10 zählt zwei verschiedene Ressourcen: einen Sitz-/Stehkapazitätsplatz und
bei entsprechendem Bedarf zusätzlich eine Sonderfläche. Sein `seat_plan`
weist auch einem Fahrgast mit Rollstuhlbedarf zunächst einen freien Sitz zu;
das Merkmal `seated` darf deshalb nicht in `standing` umgedeutet werden.

V2 bildet diese beiden Ressourcen ausdrücklich ab. Alle M5-Sitz- und
Stehflächen bleiben als kapazitätsführende Plätze erhalten. `specialBays`
enthält zusätzlich genau die oben genannten Nutzungsflächen; jede trägt
`spaceId`, `vehicleId`, `bodyId`, `deckId`, `xMm`, `yMm` und `spaceNeed`
mit `wheelchair`, `bicycle` oder `stroller`. Diese Flächen zählen nicht als
zusätzliche Personenplätze und sind geometrisch von festen Sitzflächen und
anderen exklusiven Nutzungsflächen getrennt.

Eine entsprechende Fahrgastzuweisung belegt genau einen Kapazitätsplatz und
genau eine passende Sonderfläche desselben individuellen Fahrzeugs. Beide
Belegungen sind exklusiv. Die Zuordnung darf sich nicht mit einer bloßen
fahrzeugübergreifenden Summenprüfung begnügen. Ein belegter Rollstuhlbedarf ist
deshalb auch bei null M5-Stehplätzen grundsätzlich darstellbar, wenn die
zusätzlich erforderliche Rollstuhlfläche real im Layout untergebracht ist.
Fehlt diese Fläche oder eine vollständige kompatible Zuteilung, wird konkret
abgelehnt; weder Bedarf noch Personenzahl werden reduziert.

Bei einem Rollstuhlfahrgast bezeichnet `placeId` weiterhin den von M10
zugewiesenen Sitz-/Stehkapazitätsplatz. Seine sichtbare Position und
Kasten-/Deckidentität kommen aus der tatsächlich belegten Rollstuhlfläche.
`posture` bleibt die unveränderte M10-Zuweisung. Bei Fahrrad-/Kinderwagenbedarf
bleibt die Person an ihrem Kapazitätsplatz; die zusätzliche Parkfläche ist
über `spaceId` eindeutig zugeordnet. Ein unbelasteter normaler Fahrgast hat
`spaceId: null`. Damit entstehen weder Geisterkoordinaten noch zusätzliche
Personen; sichtbarer Aufenthaltsort und verbrauchte Kapazität sind vollständig
auf das Layout zurückführbar.

`InteriorPassengerPlacesV2` und `PassengerProjectionV2` ergänzen M15.2 um die
ausdrückliche Kasten- und Deckidentität. `InteriorPassengerPlaceV2` und
`VisiblePassengerV2` erhalten dafür zusätzlich `bodyId` und `deckId` mit
`main`, `lower` oder `upper`; `VisiblePassengerV2` enthält außerdem
`spaceId: string | null`. `InteriorPassengerPlacesV2` enthält neben den
Kapazitätsplätzen den vollständigen `specialBays`-Vektor. Beide Wrapper binden
mit `sourceLayoutHash` das
vollständige Quelllayout. Sie verwenden dieselben wirklichen Fahrgäste,
Komfortklassen und Sitz-/Stehzuweisungen. Die bisherigen V1-Verträge und deren
Golden-Master bleiben unverändert. Ein Doppelstocklayout wird nicht durch
Koordinatentricks auf V1 reduziert.

Die Schemas heißen `interior-passenger-places/v2`,
`passenger-projection/v2` und `conductor-passenger-projection-input/v2`.
Das Layout selbst enthält nur den noch zuglaufungebundenen
`passengerPlaces`- und `specialBays`-Vektor sowie seine M5-Kapazitäten. Erst
`bind_interior_passenger_places(layout, trainRunId, service)` erzeugt das
zuggebundene Inventar mit einem eigenen `layoutHash` zusätzlich zu
`sourceLayoutHash`. Die Zuglaufzuordnung muss der autorisierte Server
unabhängig nachweisen. `TrainServiceV1` enthält keine `formationId`; eine
Formation-ID darf daher nicht als Zuglauf ausgegeben werden. Die reine
Formations-Geometrieabnahme behauptet keine produktive M15.7-Zugzuordnung.

Der V2-Projektor erhält ausschließlich dieses vom geprüften Layout abgeleitete
Inventar. Er darf keine zusätzlichen Plätze erzeugen. Seine Welt-, Zug-,
Perioden-, Zustands- und Layouthashes müssen zum autorisierten Eingang passen.
Sichtbare Positionen bleiben vollständig einem konkreten Kapazitätsplatz oder
der ausdrücklich zugeordneten Rollstuhlfläche zuordenbar. Die tatsächlichen
Haltquittungen und M10-Autorität werden durch
diesen Geometrievertrag nicht ersetzt.

## 8. Ablehnung und technische Grenzen

Eine Ablehnung benennt den fehlenden oder widersprüchlichen Nachweis mit einer
stabilen Kennung und betroffener Fahrzeug-/Konfigurationsreferenz. Dazu zählen
mindestens fehlende Konfiguration oder Profilzuordnung, falscher Releasepin,
falsche Welt/Periode/Formation, veraltete Revision, widersprüchliche
Kapazitätswerte, unpassende Kastenlängensumme, unzulässige Türlage, fehlender
Übergang, unerreichbarer Platz, fehlender barrierefreier Pfad sowie
Flächen-/Kapazitätsüberlauf.

Unbekannte Schemas, Felder und Kennungen sowie negative, nichtganzzahlige oder
überlaufende Maße werden abgelehnt. Der Kern verwendet ausschließlich
explizite Werte und deterministische Ordnung; weder Uhrzeit, Datenbank noch
Netzwerkzugriff sind Teil der Geometrieerzeugung. Telemetrie darf die
Fehlerkennung und aggregierten Umfang melden; vollständige Platz-/Spielerlisten
oder Zugangsdaten gehören nicht in das Weltlog.

## 9. Erforderliche Abnahmebelege

Der Abschluss verlangt gemeinsam:

1. Unit-/Propertyprüfungen für Kapazitätsgleichheit, positive Flächen,
   Platz-Eindeutigkeit je Deck, erreichbare Interaktionen, kollisionsfreie
   Wege, Tür-/Übergangslagen und vollständige Doppelstocktreppen.
2. Determinismus und serialisiertes Restore bei gleicher Formation sowie
   Ablehnung fremder Welt, Periode, Formation, Revision und Releasepins.
3. Den echten M5-Initialize-/Verify-/Persistenzpfad mit vollständigen
   Konfigurationen und den daraus durch Rust erzeugten Layouts.
4. Mehrere unterschiedlich konfigurierte SPNV-Formationen im begehbaren
   Browsernachweis, einschließlich Klassen-/Mehrzweckunterschieden und
   Doppelstock-Deckwechseln. Eine fehlende Konfiguration muss sichtbar den
   konkreten Einstieg blockieren.
5. Eine vollständig deckfähige M15.2-Projektion auf dieses Inventar sowie
   unveränderte V1-Nachweise; kein manuell angelegtes positives Platzinventar.

Der öffentliche Repository-Korpus enthält gemäß
[Fahrzeugkatalogvertrag](fahrzeugkatalog.md) fiktive Testdaten. Neue
Nachweiskonfigurationen werden daher ausdrücklich als konfigurierte
Spielassets bezeichnet. Ihre Ausführung muss den echten Rust-, Persistenz-
und Browserpfad verwenden; sie sind kein Beleg für die bislang nicht im
Workspace vorhandenen vollständigen privaten Produktivkataloge. Ein solcher
Katalog darf später nur mit denselben vollständigen Belegen eintreten.

Die [Reproduktionskommandos und konkreten Resultate](conductor-interior/README.md)
führen die tatsächlich ausgeführten Prüfungen und ihre Belegdateien.
Der dort verwendete temporäre Art-Testschlüssel ersetzt keine produktive
Signeridentität; eine formationsbezogene Geometrieprüfung eröffnet keine
persistente Schaffnersitzung.
