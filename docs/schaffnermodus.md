# M15 — Schaffnermodus

Der Schaffnermodus ist eine optionale, serverautoritative Vertiefung des
regulären SPNV-Betriebs. Der Spieler betritt einen eigenen aktiven Zug in einer
orthogonalen Top-down-Pixelart-Ansicht, bewegt sich durch dessen Innenraum und
kontrolliert die tatsächlich aus dem Personenverkehrsmodell stammenden
Fahrgäste. Der Modus ist Teil des Hauptspiels und keine getrennte Spielwelt.

Diese Datei ist der kanonische Fachvertrag für M15. Die Querschnittsdokumente
verweisen hierher und wiederholen die Regeln nicht. Grundsatzentscheidung:
[ADR-0029](adr/0029-schaffnermodus-als-serverautoritative-betriebsvertiefung.md).

## 1. Produktziel und Grenzen

Der Modus soll Betrieb erlebbar machen und Entscheidungen mit sichtbaren
Folgen erzeugen. Er ist weder ein Fahrsimulator noch eine wirtschaftliche
Pflichtschleife.

- Einstieg erfolgt aus der privaten Zugdetailansicht eines eigenen, aktiven
  SPNV-Zuges. Geleaste Fahrzeuge zählen als eigene Betriebsleistung.
- Fremdverkehre, Eigenbetrieb, Leerfahrten, Güterverkehr, SPFV und Außenläufe
  sind in M15 nicht betretbar.
- Der Spieler fährt den Zug nicht, stellt keine Signale und kann ihn nicht
  physisch verlassen.
- Die Weltzeit pausiert nicht. Fahrt, Halte, Verspätungen und Störungen laufen
  serverautoritativ weiter.
- Normale Gespräche und Kontrollen halten den Zug nicht auf. Nur eine
  serverseitig bindend angenommene Polizeianforderung kann am nächsten
  planmäßigen Fahrgasthalt
  einen zusätzlichen Betriebshalt auslösen.
- Nichtteilnahme erzeugt keinen Malus und keinen versteckten
  Wettbewerbsnachteil. Die positive Belohnung bleibt klein und gedeckelt.
- M15 ist Ausbau nach dem Alpha-Schnitt. Die erste Fassung gilt nur für SPNV;
  ein späterer SPFV-Schaffnermodus braucht einen eigenen Milestone-Schnitt.

## 2. Autoritäts- und Datenfluss

```text
M10 Personenverkehrsnachfrage
  -> PassengerManifestV1
  -> M15 sichtbare 1:1-Innenraumprojektion und Fahrgastdialog
  -> typisierte Spielerkommandos
  -> FareInspectionCaseV1 / FareControlHoldV1
  -> M8 Konfliktengine und virtuelle Fahrdienstleitung
  -> M4 Verspätungsfortpflanzung und Replay
  -> M10 neue Reise- und Anschlusslage
  -> M6 EconomyRelease und Ledger
```

Der Browser erhält nur eine Projektion. Er entscheidet weder über Fahrgastzahl
und Fahrberechtigung noch über Dialogausgang, EBE-Höhe, Betriebshalt,
Ressourcenbelegung, Abfahrtsrecht, Polizeireaktion oder Buchung.

Jeder Vertrag, jedes Kommando und jedes Event trägt `world_id`, explizite
Simulationszeit, Schema- beziehungsweise Releaseversion und eine stabile
Kausalitätskennung. Im Simulationskern gibt es kein `now()`, keine
Gleitkommazahl im zustandsrelevanten Pfad und keinen Datenbankzugriff.

## 3. Erweiterung des Personenverkehrsmodells M10

M10 wird vom reinen SPFV-Ausbau zu einem gemeinsamen
Personenverkehrsnachfragemodell für SPNV und SPFV erweitert. Es bleibt die
einzige fachliche Quelle für Reisen, Zugwahl, Ein- und Aussteiger, Auslastung
und objektiven Fahrberechtigungsstatus. M15 darf keine zusätzlichen Fahrgäste
oder Fälle ohne Fahrberechtigung erfinden.

### 3.1 PassengerManifestV1

M10 erzeugt pro Zuglaufabschnitt ein unveränderliches `PassengerManifestV1`:

| Feld | Bedeutung |
|---|---|
| `worldId` | Weltbindung |
| `demandReleaseId` | gepinnter M10-Release |
| `trainRunId` / `segmentId` | konkreter Zuglaufabschnitt |
| `revision` | monotone Revision nach Betriebsänderungen |
| `passengerKey` | stabile, pseudonyme Identität innerhalb der Reisekette |
| `boardingStopId` / `alightingStopId` | Ein- und Ausstieg |
| `journeyChainId` | Verbindung über mögliche Umstiege |
| `demandSegment` | Reiseanlass und Nachfragekohorte ohne Realpersonenbezug |
| `comfortClass` | gebuchte Komfortklasse |
| `spaceNeeds` | Rollstuhl-, Kinderwagen-, Fahrrad- oder sonstiger Platzbedarf |
| `fareFact` | gültig, gültig aber momentan nicht vorzeigbar oder ungültig |
| `farePolicyProvenance` | `observed` oder `balanced` |

M10 darf die Gesamtnachfrage als Kohorten berechnen. Einzelne
`passengerKey`-Werte werden für einen konkreten Zuglauf deterministisch aus
Kohorte und laufender Nummer materialisiert; Millionen dauerhafte
Personendatensätze sind nicht erforderlich. Sobald eine Kontrolle beginnt,
entsteht ein persistenter `FareInspectionCaseV1`.

Ausfälle, geänderte Halte, Kapazitätsgrenzen und verpasste Anschlüsse werden
zuerst im Betrieb und danach in M10 verarbeitet. M15 erhält eine revidierte
Manifestprojektion. Ein bereits begonnener Fall bleibt über den
`passengerKey` konsistent.

### 3.2 FareCompliancePolicyV1

Eine `FareCompliancePolicyV1` ist Teil des gepinnten `DemandRelease`. Sie legt
die Verteilung der Fahrberechtigungszustände deterministisch nach Tarif- und
Vertriebszugang fest. Belastbare, rechtlich freigegebene Daten werden als
`observed` ausgewiesen; ersatzweise verwendete Spielwerte heißen sichtbar
`balanced` und dürfen nicht als reale Schwarzfahrerstatistik bezeichnet
werden. Erscheinungsbild, Alter, Geschlecht, Herkunft, Behinderung oder andere
geschützte Merkmale beeinflussen den Status nie.

## 4. Zug, Sitzung und Fahrgastprojektion

### 4.1 Berechtigung und Exklusivität

- Je Zug existiert höchstens eine aktive `ConductorSessionV1`.
- Je Spieler ist höchstens eine Schaffnersitzung gleichzeitig zulässig.
- Zuschauer und Koop sind nicht Teil von M15.
- Der Server prüft bei jedem Kommando Weltzugang, EVU, Zuglauf und fortbestehende
  Nutzungsberechtigung erneut.
- Reconnect und Seitenneuladen stellen Spielerposition, Zugzustand,
  Manifestrevision und aktiven Dialog wieder her.
- Endet die Fahrt oder wechselt sie in einen `ExternalLeg`, endet die Sitzung
  kontrolliert. Ein bereits bindender Betriebshalt bleibt bestehen.

### 4.2 1:1-Darstellung

Jeder im Manifest enthaltene Fahrgast ist logisch vorhanden, besitzt einen
deterministischen Innenraumplatz und bleibt kontrollierbar. Bei hoher Belegung
dürfen Renderanimationen, Überlagerung und Detailstufe vereinfacht werden; die
Personenzahl und fachlichen Fälle werden nie reduziert. Sichtbare Merkmale und
Spritevarianten werden unabhängig vom `fareFact` erzeugt.

Beginnt ein Fahrgast seinen Ausstieg, kann keine neue Kontrolle gestartet
werden. Verlässt ein noch nicht abgeschlossener Fahrgast den Zug ohne bindenden
Polizeifall, endet die Kontrolle ohne Forderung. Das erzeugt den Zeitdruck des
Minigames, ohne den Betrieb künstlich anzuhalten.

## 5. Bildsprache, Asset-Korpus und Innenräume

### 5.1 Eigene Pixelart

- orthogonale Draufsicht mit 32 Pixeln pro Meter;
- ganzzahlige Zoomstufen und Nearest-Neighbor-Skalierung;
- dunkle, überwiegend achromatische Zugfolge-Palette;
- Betriebsfarben ausschließlich für betriebliche Zustände;
- keine Übernahme fremder Figuren, Karten, Fahrzeuge, Gebäude, Logos oder
  Marken.

Die externe historische Top-down-Referenz dient nur der Kamera- und
Lesbarkeitsidee. Produktionsdokumente, Assetnamen und Generierungsanweisungen
beschreiben ausschließlich die eigenständige Zugfolge-Gestaltung.

Alle sichtbaren Motive werden als finale Grafiken erzeugt: Fahrgäste und
Bewegungsphasen, Innenraummodule, Türen, Sitze, Mehrzweckbereiche, WCs,
Führerstände, Bahnsteige, Dächer, Hallen, Treppen, Unterführungen, Vegetation,
Straßen, Gebäude, Signale und Umgebungsobjekte. Zur Laufzeit findet keine
Bildgenerierung statt.

`ArtAtlasManifestV1` pinnt je Asset Generierungsanweisung, erlaubte Referenzen,
Modellversion, Prüfsumme, Abmessungen und Freigabestatus. Zulässige technische
Nachbearbeitung beschränkt sich auf Freistellung, Rasterausrichtung,
Palettenquantisierung, Größenprüfung, Pivot- und Kollisionspunkte,
Atlasbildung und Kompression. Ein inhaltlich ungeeignetes Motiv wird neu
erzeugt statt manuell umgezeichnet.

### 5.2 InteriorLayoutV1

`InteriorLayoutV1` beschreibt die begehbare Geometrie in Millimetern und wird
deterministisch aus der tatsächlichen Formation und Fahrzeugkonfiguration
abgeleitet:

- Wagenkästen, Übergänge und Türen;
- Sitz-, Steh-, WC-, Fahrrad-, Mehrzweck- und Barrierefreiheitsbereiche;
- Begehbarkeitsnetz, Kollisionen und Interaktionspunkte;
- Kapazitätsnachweis gegen das Manifest.

Die Innenräume sind konfigurationsgetreu, aber keine exakte Nachbildung realer
Baureihen. Ein Fahrzeug mit unvollständiger Konfiguration ist nicht betretbar
und nennt den fehlenden Konfigurationsnachweis.

## 6. Fahrt, Umgebung und Stationen

Ein releasegebundener ganzzahliger `urbanityBasisPoints`-Wert mischt Umland,
Vorstadt und Stadt kontinuierlich. Die Umgebung bewegt sich relativ zur
tatsächlichen Geschwindigkeit. Tageszeit beeinflusst Beleuchtung und Fenster;
Wetter ist nicht Teil von M15. Planmäßige Halte, Signalhalte und zusätzliche
Betriebshalte stoppen die Bewegung entsprechend dem Simulationszustand.
Signalbilder sind reine Darstellung und nicht bedienbar.

`StationSceneV1` kennt drei Klassen:

| Bahnhofskategorie | Szene |
|---|---|
| 1–2 | groß |
| 3–5 | mittel |
| 6–7 | klein beziehungsweise Haltepunkt |

Fehlt eine freigegebene Kategorie, wird die Klasse aus Betriebsstellenart,
Bahnsteigzahl und Bedienumfang abgeleitet und als `derived` gekennzeichnet.
Stationen werden aus generierten Modulen zusammengesetzt; die Betriebsstellen-ID
wählt stabile Varianten. Es wird keine reale Architektur behauptet. Der
Stationsname ist die einzige ortsspezifische grafische Identität. Eine
Bahnsteigbezeichnung darf als betrieblicher Text erscheinen. Lange Namen,
Umlaute und mehrzeilige Beschriftungen müssen vollständig lesbar bleiben.

## 7. Dialoge und Sprechblasen

### 7.1 Bedienung

- Die aktive Fahrgastäußerung erscheint als Sprechblase oberhalb der Figur.
- Antwortmöglichkeiten erscheinen als sprechblasenförmige Schaltflächen nahe
  der Spielerfigur.
- Die ausgewählte Antwort wird kurz als eigene Blase gezeigt, danach folgt die
  Reaktion des Fahrgasts.
- Es gibt höchstens ein aktives Gespräch. Andere Fahrgäste zeigen nur ein
  Interaktionssymbol und erzeugen kein Ambient-Blasenrauschen.
- Es gibt keinen Freitext, keine Spracheingabe und kein Laufzeit-Sprachmodell.
- Ein Gespräch umfasst normalerweise zwei bis drei Blasenwechsel.
- Bei `prefers-reduced-motion` erscheint Text sofort. Screenreader erhalten
  denselben Dialog über Live-Region und reguläre Auswahlschaltflächen.

### 7.2 Verdeckter Sachverhalt

Der Server hält vier voneinander getrennte Merkmale:

| Merkmal | Beispiele |
|---|---|
| `FareFact` | gültig, gültig aber nicht vorzeigbar, ungültig |
| `Presentation` | leeres Handy, technische Störung, Zugeben, Ausrede, Schweigen, Verweigerung, Betrunkenheit |
| `Tone` | freundlich, neutral, ungeduldig, unfreundlich |
| `Cooperation` | kooperativ, ausweichend, Identitätsverweigerung, konkrete Gefahr |

Betrunkenheit beeinflusst Sprache, Reaktionszeit und Kooperation, ist aber
weder Beweis für eine fehlende Fahrberechtigung noch alleiniger Grund für eine
Polizeianforderung. Nachfragen verbrauchen Zeit und liefern Hinweise, decken
den objektiven Sachverhalt aber nicht automatisch auf.

Kontextabhängige Spielerentscheidungen sind erneutes Nachfragen oder ein
technischer Wiederholungsversuch, Beenden ohne Maßnahme, reguläre oder
vorläufige EBE und — ausschließlich bei Identitätsverweigerung oder konkreter
Gefahr — eine Polizeianforderung.

### 7.3 DialogueReleaseV1

Der erste signierte `DialogueReleaseV1` enthält mindestens 150 vollständige
Dialogbäume und 600 unterschiedliche Fahrgastäußerungen in mindestens zwölf
Situationsfamilien. Dazu gehören unter anderem leeres oder defektes Handy,
technisches Problem, freundliches Zugeben, Missverständnis, Ausrede,
Geldmangel, Schweigen, unfreundliche Reaktion, vollständige Verweigerung,
kooperative Betrunkenheit und sicherheitsrelevante Eskalation.

Die Texte werden offline erzeugt, strukturell vollständig validiert und
redaktionell stichprobenartig abgenommen. Gates verhindern diskriminierende
Zuschreibungen, reale Personen oder Marken, Kopplung geschützter Merkmale an
den Ticketstatus, grundlose Polizeieskalation, ungültige Platzhalter,
überlange Blasen und unerreichbare Dialogenden.

Die Auswahl erfolgt über den Seed-Teilstrom `fare_dialogue` aus Welt, Periode,
Zuglauf und `passengerKey`. Reload und Replay liefern denselben Dialog. Eine
laufende Begegnung behält ihren gepinnten Release über einen Periodenwechsel.

## 8. Kontrolle, EBE und Fallabschluss

Das erhöhte Beförderungsentgelt wird als EBE beziehungsweise Forderung
bezeichnet, nicht als Bußgeld. Die Grundforderung beträgt das Doppelte des
Fahrpreises, mindestens 60 Euro. Wird ein bei der Kontrolle gültiger
persönlicher Fahrausweis innerhalb einer Woche nachgewiesen, wird die Forderung
automatisiert auf 7 Euro reduziert. Grundlage ist
[§ 6 EVO](https://www.gesetze-im-internet.de/evo_2023/__6.html).

Eine EBE wird zunächst als offene Forderung gebucht. Zahlung, Reduzierung,
Bearbeitungskosten und Zahlungsausfall folgen später deterministisch aus dem
gepinnten `EconomyRelease`. Eine vorschnell ausgestellte oder nicht feststellbare
Forderung kann reduziert, abgeschrieben oder mit Bearbeitungskosten belastet
werden.

## 9. FareControlHoldV1 und betriebliche Wirkung

### 9.1 Anforderung und Bündelung

`request_police` erzeugt keinen Halt auf freier Strecke. Der Server bestimmt
als Ziel den nächsten planmäßigen Fahrgasthalt, den der Zug noch nicht erreicht
hat. Die Aktion ist nur verfügbar, wenn ein offener Fall eine konkrete
Identitätsverweigerung oder Gefahr trägt, der Zielhalt innerhalb des
spielbaren Laufabschnitts liegt und die Welt einen zuständigen Anbieter sowie
eine maximale Wartezeit definiert.

Der erste Release erlaubt höchstens einen Polizeihalt je Zuglauf. Mehrere bis
zum Zielhalt offene, geeignete Fälle werden in diesem Halt gebündelt. Diese
Grenze schützt das gemeinsame Netz vor absichtlicher Kettenblockade und liegt
versioniert in `FareControlPolicyV1`.

Nach Bestätigung entsteht ein bindendes `FareControlHoldV1` mit `worldId`,
Zuglauf, Fallkennungen, Zielhalt, Anforderungszeit, Ursache
`authority.police.fare-control`, maximaler Wartefrist, deterministischem
Polizeiergebnis, Zustandsrevision und Kausalitätskennung. Sitzungsende,
Reconnect oder Browserabbruch heben ihn nicht auf.

### 9.2 Aktivierung und Ressourcen

Der Zug fährt regulär bis zum Zielhalt. Der zusätzliche Halt beginnt erst,
wenn der Zug nach Mindesthaltezeit und Fahrgastwechsel normalerweise
abfahrbereit wäre. Während des Halts:

- bleibt das tatsächlich belegte Bahnsteig- oder Bahnhofsgleis belegt;
- bleiben Fahrstraßen- und Ausschlussressourcen belegt, deren Freigabe das
  Räumen durch den Zug voraussetzt;
- werden bereits sicher geräumte Ressourcen nicht erneut belegt;
- erhält der Zug wegen der autorisierten Warteentscheidung kein
  Abfahrtsrecht;
- wird keine Infrastrukturstörung oder Streckensperrung erfunden.

Der Halt endet nach abgeschlossenem Polizeivorgang oder beim Erreichen der
weltvertraglichen Höchstwartezeit. Eine nicht erfolgreiche Feststellung macht
die betroffenen Forderungen nicht werthaltig. Die zuständige Stelle wird in
der Oberfläche allgemein als Polizeiaktion bezeichnet; wo sachlich passend,
kann die Bundespolizei als vorgesehener Leistungsträger erscheinen. Deren
Bahnaufgaben sind unter
[Bundespolizei — Bahnpolizei](https://bundespolizei.de/unsere-aufgaben/bahnpolizei)
dokumentiert.

### 9.3 Virtuelle Fahrdienstleitung und andere Züge

Nach Freigabe fährt der Zug nicht automatisch los. Er stellt eine neue normale
Abfahrtsanfrage; erst ein neu erteiltes Abfahrtsrecht erlaubt die Weiterfahrt.
Der virtuelle Fahrdienstleiter prüft Welt und Zeitfenster,
Mindesthaltezeit, Betriebsbereitschaft, Fahrstraße, Fahrweg, Durchrutschweg,
Flankenschutz, individuelle Zustimmung und sämtliche Konfliktressourcen.

Hat der Zug seine ursprüngliche Fahrplanlage verloren, besitzt er keinen
Sondervorrang. Die vorhandene lexikographische M8-Regel entscheidet gemeinsam
mit allen anderen Fahrten. Eine inzwischen gesicherte Fahrstraße, ein belegter
Folgeblock oder eine kreuzende Bewegung kann deshalb nach Ende des
Polizeihalts weitere Wartezeit erzeugen.

Die verlängerte Ist-Belegung läuft durch denselben regionalen `CapacityLedger`
und dieselbe Konfliktengine wie der übrige Betrieb. Mögliche Folgen sind:

- wartende Folge- oder Einfahrzüge;
- neu geordnete Kreuzungen, Wenden und Rangierbewegungen;
- Auswirkungen auf alle Zugarten, darunter Personen-, Güter-, Leer- und
  Zusatzfahrten aller EVU;
- gebrochene oder neu bewertete Anschlüsse;
- verschobene Fahrzeug- und Personalumläufe;
- revidierte M10-Reiseketten und Auslastungen;
- verursachungsgerechte Verspätungen, Vertragsfolgen und Pönalen.

M15 verspätet keine fremde Fahrt direkt. Es erzeugt ausschließlich den
autorisierten Halt des eigenen Zuges; alle Netzfolgen entstehen aus den
bestehenden Ressourcen- und Dispositionsregeln.

### 9.4 Ereignisse und Sichtbarkeit

Mindestens folgende typisierte Ereignisse werden benötigt:

- `FareControlHoldRequested`
- `FareControlHoldActivated`
- `DepartureAuthorityWithheld`
- `PoliceResponseResolved`
- `FareControlHoldReleased`

Bestehende Abfahrts-, Ressourcen- und Verspätungsereignisse tragen dieselbe
Kausalitätskennung. Das eigene EVU sieht in der Betriebszentrale den vollen
Grund. Öffentliche Livemap und fremde EVU sehen nur den datensparsamen
Betriebsgrund „behördliche Maßnahme“ und die resultierende Verspätung, niemals
Dialog- oder Falldaten.

## 10. Wirtschaft

Für abgeschlossene Fälle gilt:

```text
nettoEBE = Zahlungseingänge - Bearbeitungskosten - Abschreibungen
Kontrollprämie <= 4 * positive nettoEBE
```

Der gesamte positive Tagesbeitrag aus Netto-EBE und Kontrollprämie ist auf
0,5 Prozent der relevanten täglichen SPNV-Vertragserlöse begrenzt. Negative
Bearbeitungskosten, Polizeihaltfolgen und Pönalen bleiben vollständig wirksam.
Alle Werte liegen als Integer-Cent im `EconomyRelease`; es gibt keinen externen
Dienst im heißen Pfad.

## 11. Öffentliche Verträge und API

M15 führt mindestens folgende versionierte Verträge ein:

- `PassengerManifestV1`
- `FareCompliancePolicyV1`
- `FareInspectionCaseV1`
- `FareControlPolicyV1`
- `FareControlHoldV1`
- `ArtAtlasManifestV1`
- `InteriorLayoutV1`
- `StationSceneV1`
- `DialogueReleaseV1`
- `PassengerEncounterV1`
- `ConductorSessionSnapshotV1`
- `ConductorCommandV1`

Die autorisierte API liegt unter
`/worlds/{worldId}/operators/{operatorId}/trains/{trainRunId}/conductor-sessions`.
Snapshots und sequenzierte SSE-Deltas enthalten Zugzustand, Spielerposition,
Manifestrevision, sichtbare Fahrgäste, aktive Begegnung, Umgebung,
Bahnhofsszene und gegebenenfalls den Betriebshalt.

`ConductorCommandV1` kennt `move`, `start_inspection`,
`choose_dialogue_option`, `request_police` und `end_session`. Jedes Kommando
trägt Sitzungs-ID, erwartete Revision und Idempotenzschlüssel.

`PassengerEncounterV1` enthält nur bereits sichtbare Äußerungen, zulässige
Antworten und offenbarte Hinweise. Verdeckter Ticketstatus, Gewichte und
zukünftige Dialogknoten verlassen den Server nicht.

## 12. Nichtfunktionale Anforderungen

- Der vollständig ausgelastete längste zugelassene SPNV-Verband muss im
  bestehenden Browser- und Serverbudget bleiben, ohne logische Fahrgäste zu
  entfernen.
- Rendering darf degradiert werden, fachlicher Zustand und Eingaben nicht.
- Der Server begrenzt Bewegungs- und Dialogkommandos, lehnt veraltete
  Revisionen ab und verarbeitet Wiederholungen idempotent.
- Gespräch, Betriebshalt, Fall und Ledger müssen nach Restore bitgleich
  fortgesetzt werden.
- Asset- und Dialogrelease sind signiert, gehasht und zur Laufzeit lokal
  verfügbar. Externe KI-, Bild- oder Textdienste sind im Laufzeitpfad verboten.
- Datenschutzmetriken sind niedrig-kardinal; Fahrgastschlüssel und Dialogtexte
  erscheinen nicht in allgemeinen Logs oder Metriklabels.

## 13. Tests und Abnahme

### 13.1 Automatisierte Nachweise

- Gleicher Seed und gleiche Kommandofolge erzeugen identische Manifeste,
  Innenraumplätze, Dialoge, Polizeireaktionen, Belegungen, Buchungen und
  Zustands-Hashes.
- Die Summe individueller Fahrgäste entspricht an jedem Halt exakt M10-
  Auslastung, Ein- und Aussteigern.
- Verdeckte Sachverhalte erscheinen vor ihrer Offenlegung nicht in API,
  Browserzustand, Log oder Telemetrie.
- Mindestens 150 Dialogbäume und 600 Fahrgastäußerungen sind vorhanden; jeder
  Pfad ist erreichbar und terminiert.
- Defektes-Handy-Fälle decken sowohl späteren gültigen Nachweis mit
  7-Euro-Reduzierung als auch eine falsche Ausrede mit regulärer EBE ab.
- Betrunkenheit wird unabhängig vom `fareFact` getestet; Polizei ist ohne
  Verweigerung oder Gefahr nicht anforderbar.
- Property-Tests beweisen Invariante 1 für zufällige Polizeihaltdauern,
  Bahnhofslagen und konkurrierende Fahrten.
- Ein Mehrzug-Golden-Master enthält den kontrollierten SPNV-Zug, einen
  Folgepersonenzug, einen kreuzenden Zug sowie eine Güter-, Leer- oder
  Rangierfahrt. Er beweist Weiterbelegung, Neuordnung, Höchstwartezeit, erneute
  Abfahrtsprüfung und vollständige Kausalitätskette.
- Sprechblasen funktionieren bei dichter Belegung, langen Texten, Touch,
  Tastatur, Screenreader und reduzierter Bewegung.
- Forderung, Zahlung, Abschreibung, Kontrollprämie, Tagesdeckel, Verspätung und
  Pönalen werden ledgergenau geprüft.

### 13.2 Spielbarer Gesamtbeweis

Eine zusammenhängende Fahrt zeigt:

1. aus M10 entstandene SPNV-Auslastung und exakte 1:1-Projektion;
2. Bewegung durch den konfigurationsgetreuen Innenraum;
3. fließenden Wechsel von Umland über Vorstadt zu Stadt;
4. Signalhalt, kleinen Haltepunkt und großen Bahnhof mit Namen;
5. freundliches Zugeben und reguläre EBE;
6. defektes Handy mit vorläufiger EBE und späterer Reduzierung;
7. einen unfreundlichen oder betrunkenen, aber gültig reisenden Fahrgast ohne
   Sanktion;
8. Identitätsverweigerung und Polizeianforderung für den nächsten Halt;
9. verlängerte Bahnsteigbelegung und Reaktion virtueller Fahrdienstleiter auf
   mehrere andere Zugfahrten;
10. Verspätungs-, Anschluss-, M10-, Umlauf- und Pönalenfolgen;
11. Freigabe, neue Abfahrtsprüfung und gegebenenfalls weiteres Warten wegen
    verlorener Fahrplanlage;
12. Forderungsbuchung und gedeckelte Kontrollprämie;
13. Reload und Replay mit identischem Ergebnis auf Desktop und Touchgerät.

## 14. Ausdrücklich nicht Teil von M15

SPFV- und Güterkontrollen, manuelles Fahren, Signalbedienung, Verlassen des
Zuges, direkte Disposition anderer Züge, Gewaltmechaniken, Verfolgungen,
Freitext, Spracheingabe, Laufzeit-KI, lange Rollenspieldialoge, Wetter, reale
Bahnhofsarchitektur, exakte reale Fahrzeuginnenräume, Mehrspieler im selben Zug
und ein allgemeines Einspruchsportal außerhalb des automatisierten späteren
Fahrausweisnachweises.
