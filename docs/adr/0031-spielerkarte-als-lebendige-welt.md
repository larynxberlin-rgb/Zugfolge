# ADR-0031: Die Spielerkarte zeigt die lebendige gemeinsame Welt, nicht den Infrastruktur-Editor

- **Status:** Angenommen — bindend (entspricht E30)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../produkt.md](../produkt.md) · [../design.md](../design.md) · [../livemap-detailkatalog.md](../livemap-detailkatalog.md) · [../ux-spieler-shell.md](../ux-spieler-shell.md)
- **Betrifft Milestones:** M9.3, M9.10, M10, M11, M13.5, M14.2
- **Verwandte ADRs:** [ADR-0009](0009-vollstaendige-transparenz-livemap.md), [ADR-0035](0035-deutschlandweite-spieleroberflaeche.md), [ADR-0017 – historisch](0017-design-domaenensprache-achromatisch-dunkel.md), [ADR-0019](0019-realismus-dient-dem-spiel.md), [ADR-0026](0026-karte-als-spielzentrum.md), [ADR-0027](0027-geschaetzte-zugkartenposition-nur-visuell.md)
- **Teilablösung:** Ersetzt für das normale Spielerprofil die Aussagen aus ADR-0026, nach denen jedes sichtbare Fachobjekt anklickbar sein muss. Präzisiert E26 zugleich auf einen A-/B-only-Releasevertrag: Unvollständige Pflichtdimensionen bleiben interne Builddiagnose und blockieren den Kandidaten. Vollständigkeit, Releasebindung, Selbsthosting und Spielbarkeitsmaske des Deutschland-Korpus bleiben unverändert.

## Kontext

Die Weltkarte ist für viele einzelne Managemententscheidungen nicht zwingend:
Eine Trasse lässt sich im Bildfahrplan bestellen, ein Umlauf in einer Tabelle
disponieren und ein Vertrag in einem Dokument prüfen. Trotzdem ist die Karte
das Spielzentrum. Bewegte Züge anderer EVU, die gemeinsame Weltzeit,
Störungen, Bahnhofstafeln und Fahrgastinformation vermitteln, dass die Welt
weiterläuft und der Spieler Teil eines gemeinsamen Eisenbahnbetriebs ist.
Gerade diese Präsenz rechtfertigt den Server- und Betriebsaufwand der
selbstgehosteten Karte.

Das bisherige Darstellungsmodell setzte dagegen die Vollständigkeit des
Datenartefakts mit der benötigten Spielerinformation gleich. Einzelne
Bahnsteige, Weichen, Blöcke, technische Betriebsstellen und andere
Importobjekte erzeugten überlagerte Punkte und einen kryptischen
Objektwähler. Selbst unzureichend qualifizierte Objekte wurden früher als
sichtbare dritte Kategorie behandelt. Der Klick auf eine Strecke
konfrontierte den Spieler mit internen Modell- und
Evidenzdaten statt mit einer verständlichen Streckenauskunft. Das ist die
Perspektive eines Infrastrukturprüfers, nicht die eines EVU.

## Entscheidung

**Die Live-Karte ist die räumliche Bühne einer lebendigen, gemeinsamen und
serverautoritativen Welt. Ihr normales Spielerprofil zeigt nur Objekte, die
Orientierung, Weltpräsenz oder eine konkrete betriebliche Handlung tragen; das
vollständige Infrastrukturartefakt bleibt davon unberührt.**

Die OSM-Basiskarte ist ausschließlich atmosphärischer und geografischer
Kontext. Sie ist weder fachliche Infrastrukturwahrheit noch Interaktionsquelle
und erzeugt keine Spielhandlung. Sie darf deshalb als statisches,
hashbenanntes und stark gecachtes PMTiles-Artefakt progressiv geladen werden.
Serverautoritative Züge, Störungen, Weltzeit und Objektdetails bleiben davon
getrennte Projektionen; ein fehlender Basiskartenausschnitt darf ihren Zustand
nicht verändern oder durch OSM-Merkmale ersetzen.

Im normalen Spielerprofil gelten folgende Ebenen:

| Objekt | Darstellung | Interaktion |
|---|---|---|
| fahrende Züge | bewegter Marker mit EVU, Zugnummer und Betriebsabweichung | öffnet Betriebssicht und FIS; eigene Züge dürfen autorisierte EVU-Daten ergänzen |
| Strecken der Klassen A/B | ruhige Linien, bei Störung mit Zustandsoverlay | öffnet eine kurze Streckenauskunft |
| Bahnhof/Betriebsstelle | genau ein markanter Marker und eine Bezeichnung je releasegebundener Stationsgruppe, einschließlich **RIL-100-Kürzel** | öffnet Grunddaten, aktuelle Fallblattanzeige und belegte Bahnhofsstatistik für den gesamten Bahnhof |
| Werkstatt | eigenes markantes Werkstattsymbol, sobald ein autoritatives, benanntes Werkstatt-Readmodel vorliegt | öffnet Leistungen, Zugang und Verfügbarkeit; generische Konfliktressourcen werden nie als Werkstatt ausgegeben |
| Signale der Klassen A/B | kleines, achromatisches Signalicon ohne behaupteten Signalzustand | reine Orientierung; kein Objektwähler, solange keine verständliche, autoritative Signalauskunft vorliegt |
| Sperrung, Einschränkung, Baustelle | Muster, Symbol und Betriebsfarbe über dem betroffenen A/B-Netz | führt in Störungs- beziehungsweise Betriebsdetail |

Der freigegebene Release enthält ausschließlich A/B. Offene Pflichtdimensionen
erscheinen daher weder als Strecke noch als Signal oder Überlagerung, sondern
blockieren bereits den Jahreskandidaten. Ebenso werden Bahnsteigpunkte, Weichen,
`operating_points`, Blöcke, `conflict_resources`, Anlagen und `rail_context`
nicht als auswählbare Kartenobjekte dargestellt. Bahnsteige bleiben fachlich
erhalten und erscheinen dort, wo sie eine Spielerfrage beantworten — etwa als
Gleis-/Bahnsteigspalte der Bahnhofstafel. Weichen, Blöcke und
Konfliktressourcen wirken weiterhin vollständig in Planung und Simulation.
Support, Qualitätssicherung und interne Diagnose dürfen ein ausdrücklich
getrenntes technisches Profil verwenden. Eine fachlich belegte Werkstatt ist
kein solcher technischer Punkt, sondern ein Spielerort und gehört mit eigenem
Symbol auf die Karte. Das aktuelle `conflict_resources`-Tile belegt allerdings
nur generische Blöcke, Weichen und Gleisabschnitte. Es darf nicht in
vermeintliche Werkstätten umgedeutet werden. Vor der Darstellung braucht es
einen eigenen releasegebundenen Vertrag mit stabiler ID, Name, Lage,
Leistungsarten sowie Betreiber- und Zugangsstatus.

Bahnhofsgruppen werden im Release gebildet und erhalten eine stabile
Gruppenkennung sowie einen Kartenanker. RIL 100, EVA/UIC und eine
Quell-Gruppenreferenz werden genutzt, wenn sie eindeutig belegt sind. Der
Browser gruppiert weder per Namensähnlichkeit noch per Abstand und erfindet
keine Betriebsstellenbeziehung. Bahnsteige sind Kindinformationen dieser
Gruppe, keine eigenen Stationsmarker.

Die Bahnhofsauskunft ist zweistufig. Mit dem heutigen Datenstand zeigt sie
Name, RIL 100, EVA/UIC, Betriebsstellenart und das aktuelle Fahrplanfenster mit
Fallblattanzeige. Langzeitkennzahlen wie Fahrgastaufkommen, Zugfahrten,
Pünktlichkeit oder EVU-Anteile erscheinen erst aus einem versionierten
`StationSummaryReadModel`, das Zeitraum und Datenstand nennt und aus
serverautoritativen Ereignissen gebildet wird. Fehlende Statistik wird nicht
aus dem aktuellen Tafelbild hochgerechnet.

Ein Streckenklick zeigt im Hauptbereich höchstens die für einen Spieler
verständlichen Fakten:

1. amtliche Streckennummer (`route_number`, VzG-Bezug),
2. amtliche Streckenkurzbezeichnung (`route_name`),
3. zulässige Geschwindigkeit (Vzul),
4. Elektrifizierung,
5. Gleiszahl.

Nur belegte Werte werden gezeigt. Releasekennung, Qualitätsklasse,
Modellzustand, technische ID und weitere freigegebene Fakten liegen
standardmäßig geschlossen unter „Technische Details“. Mehrere tatsächlich
sinnvolle Treffer werden nach `Zug → Bahnhof/Werkstatt → Strecke` priorisiert
und mit verständlichen Bezeichnungen statt Layernamen präsentiert.

Der gegenwärtige Infrastrukturrelease enthält **keine belastbare
KBS-Bezeichnung**. VzG-Streckennummer und Streckenkurzname dürfen deshalb
weder als „KBS“ beschriftet noch durch eine vermeintlich passende
Kursbuchstrecke ersetzt werden. Eine spätere KBS-Anzeige verlangt eine
versionierte, autoritative Zuordnung mit Quelle, Gültigkeitszeitraum und
eindeutiger Beziehung zu den angezeigten Segmenten; bis dahin heißt das Feld
ehrlich „Streckennummer (VzG)“ beziehungsweise „Streckenbezeichnung“.

## Bahngefühl als Nutzungserfahrung

Die Eisenbahnanmutung entsteht hier nicht durch Dekor. Sie entsteht durch den
Arbeitsablauf und die verlässliche Reaktion der Welt:

- Züge bewegen sich auf der gemeinsamen Weltzeit und gehören sichtbar zu EVU;
- eine Station antwortet mit der Fallblattanzeige aller relevanten Fahrten;
- ein Zug antwortet mit Betriebslage und FIS derselben Liveprojektion;
- Störungen verändern Karte, Prognosen und nächste Handlungen konsistent;
- Sprache verwendet verständliche Eisenbahnbegriffe, RIL 100, Zugnummern,
  Soll-/Ist-Zeit und klare Statusübergänge;
- Auswahl, Detail und Zurück-Navigation bleiben räumlich stabil.

Animation dient ausschließlich einer Zustandsänderung oder Bewegung.
`prefers-reduced-motion` reduziert Übergänge, ohne Zeit, Position oder
Betriebszustand zu verbergen. Signalfarben werden nicht dekorativ eingesetzt;
ein neutrales Icon behauptet weder Fahrt- noch Haltstellung.

## Begründung

Die Karte trägt damit das, was Tabellen allein nicht leisten: soziale Präsenz,
räumliche Orientierung und unmittelbare betriebliche Lage. Gleichzeitig
verringert das Spielerprofil die kognitive Last. Der Spieler wählt einen Zug,
einen Bahnhof oder eine Strecke und erhält genau die Auskunft, die zu diesem
Gegenstand gehört, statt die Struktur der Importpipeline kennenlernen zu
müssen.

Die Trennung zwischen Artefakt und Darstellung erhält die fachliche
Vollständigkeit. Kein Infrastrukturdatum wird gelöscht und keine
Konfliktlogik vereinfacht; nur die normale Projektion folgt E19s Regel, dass
Realismus einer interessanten Spielerentscheidung dienen muss.

## Konsequenzen

- **Erleichtert:** ruhige Karte, weniger Fehlklicks, verständliche Deep Links,
  klare Stations- und Streckenmentalmodelle sowie ein tragfähiges Zentrum für
  Nachfrage-, Auslastungs-, Güter- und Replay-Layer späterer Milestones.
- **Kostet:** Der Releasecompiler benötigt eine geprüfte Stationsgruppierung;
  Werkstattmarker brauchen einen eigenen Karten-/Readmodelvertrag und
  Bahnhofsstatistik ein zeitgebundenes Summary-Readmodel. KBS verlangt eine
  zusätzliche autoritative Quelle und Zuordnung. Das technische
  Diagnoseprofil muss getrennt gepflegt werden.
- **Bewusst akzeptierter Betrieb:** Basiskarten-PMTiles verursachen Speicher,
  Range-Traffic und Cachepflege, obwohl sie keine fachliche Wahrheit tragen.
  Dieser Aufwand wird akzeptiert, weil der räumliche Kontext Weltpräsenz,
  soziale Zugehörigkeit und Lageverständnis erzeugt. Statisches Caching und
  progressives Laden begrenzen den Payload, ohne Spielzustand auszulagern.
- **Invarianten:** Sichtbarkeit bedeutet nicht Spielbarkeit. Freigegebener
  Korpus und Spielerartefakte enthalten nur A/B; Simulation und Planner lesen
  dasselbe vollständige, releasegebundene Modell. Ein offener Pflichtbefund
  darf keine dritte öffentliche Objektklasse erzeugen.
- **Abnahme:** Standardprofil enthält ausschließlich A-/B-Geometrie und keine
  technischen Punktlayer; Signalicons bleiben achromatisch; ein Stationsklick
  öffnet Grunddaten und eine gruppierte Tafel mit RIL 100, ein Zugklick das
  FIS, und eine Strecke zeigt höchstens die fünf genannten Hauptfakten.
  Werkstätten erscheinen erst aus dem eigenen autoritativen Vertrag, dann aber
  als markantes Symbol. Technische Details sind geschlossen und eine
  KBS-Bezeichnung erscheint nur mit autoritativem Beleg.

## Verworfene Alternativen

1. **Alle Artefaktlayer standardmäßig zeigen:** verworfen, weil technische
   Vollständigkeit keine Spielerfrage beantwortet und Auswahlrauschen erzeugt.
2. **Die Karte zur Nebenansicht machen:** verworfen, weil damit die gemeinsame,
   weiterlaufende Welt und die räumliche Störungslage ihren stärksten Ausdruck
   verlieren.
3. **Unvollständige Objekte nur visuell abschwächen:** verworfen, weil ein
   ungeklärter Pflichtbefund kein Spielerartefakt sein darf und stattdessen die
   Releasefreigabe blockiert.
4. **Bahnhöfe im Browser heuristisch zusammenfassen:** verworfen, weil Namen
   und räumliche Nähe keine belastbare Betriebsstellenbeziehung beweisen.
5. **VzG- oder Streckenkurzname als KBS ausgeben:** verworfen, weil damit
   unterschiedliche Ordnungen falsch gleichgesetzt würden.
