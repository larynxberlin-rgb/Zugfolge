# Personenverkehr: Nachfrage, Zugwahl und Fahrgastmanifest

Version: `zugfolge-demand/v1` (M10.1–M10.3a). Der implementierte Rust-Vertrag
erweitert [Wirtschaft](wirtschaft.md) 2 und liefert die Grundlage für
[Schaffnermodus](schaffnermodus.md) 3. Die operative Haltbelegkette und ihr
Nachweisstand sind in [M10-Haltbelege](m10-haltbelege.md) dokumentiert.

## 1. Autorität und Grenzen

`zugfolge-demand` ist ein reiner Rust-Kern. Eine Auswertung erhält Welt,
Fahrplanperiode, explizite Weltzeit, Nachfragefenster, Weltseed, Revision,
gepinnten `DemandReleaseV1` und aktuelle Angebotsfakten. Sie erzeugt Kohorten,
erklärte Entscheidungen, Belegung, Haltströme und verdeckte Manifeste. Datenbank,
Systemuhr, Netzwerk und reale Personen sind kein Teil dieses Vertrags.
Alle Zeitwerte sind ganzzahlige Millisekunden, Geldwerte ganzzahlige Cent.
JSON-Zahlen müssen im sicheren Ganzzahlbereich liegen; der Weltseed ist ein
kanonischer Dezimalstring. Unbekannte Felder und ungültige Referenzen werden
abgelehnt. Der Plattformadapter prüft und pinnt die vollständigen Releasebytes
und ihre SHA-256-Prüfsumme; der Kern liefert eine kanonische Releaseprüfsumme.

Eine Auswertung ist eine komplette, atomar ersetzbare Projektion eines
Nachfragefensters. Sie bucht keine Fahrgelder und verändert keinen Zuglauf.
`nowMs` bezeichnet den expliziten Stand der zugeführten Betriebsfakten. Bei
Ausfall, Verspätung, Haltausfall oder Kapazitätsänderung werden nur noch nicht
abgeschlossene Nachfragefenster neu ausgewertet. Bereits abgeschlossene
Fenster bleiben im Eventlog. Die Plattform erzwingt Revision, Idempotenz,
Periodenbindung und atomaren Commit. Eine laufende Reisekette behält ihren
Release auch über einen Periodenwechsel; neue Fenster erhalten den neuen Pin.

Ohne Betriebsquittungen ist `projectionMode = forecast`: Das Manifest ist eine
Nachfrageprognose und darf nicht als bereits eingestiegener Fahrgastbestand
veröffentlicht werden. Der optionale Vertrag `DemandOperationalProgressV1`
trägt Welt, Quittungskennung, expliziten Stand und tatsächlich bestätigte
Ankunfts-/Abfahrtszeiten je Zughalt. Fahrplanzeit und zurückgelegte Zeit sind
keine Quittung. `previousEvaluation` pinnt das letzte Ergebnis samt vorherigen
Angebotsfakten. Welt, Seedhash, Periode, Fenster, Releasehash, Zustandsprüfsumme
und monotone Revision werden vor jeder Fortschreibung erneut geprüft.

Mit diesen Quittungen bleibt ein bereits befahrener oder begonnener
Zugteilweg einschließlich Fahrgastschlüssel, Sitz und gebuchtem Tarif erhalten.
Nur die anschließende noch nicht begonnene Teilreise wird neu gewählt. Bestätigt
abgefahrene Halte akzeptieren keine neuen Einsteiger. Ein verpasster Anschluss
wird aus tatsächlicher Ankunft plus Mindestumsteigezeit gegenüber tatsächlicher
Abfahrt bewiesen. Fehlt eine zulässige Fortsetzung, bleibt die begonnene Reise
als `stranded` sichtbar; `totals.stranded` ist eine Teilmenge von `totals.rail`
und wird nicht zusätzlich zur Erhaltungssumme addiert. `journeySeats` hält auch
SPFV-Sitze serverseitig vor, damit ein weiterer Restore Reservierungen nicht
umverteilt. Spätere Tarifänderungen ändern kein bereits gebuchtes Teilstück.
Eine während der Fahrt gekürzte oder gestrichene Zugteilreise benötigt zunächst
eine bestätigte Ausstiegslage; der Kern lehnt eine Fortschreibung ohne diese
Quittung ab. Er erfindet keinen Ausstieg und verlagert keine bereits Reisenden.

Die native Betriebsengine liefert mit `OperationalPassengerStopReceipt`
gebundene Ankunfts- und Abfahrtsbelege für Züge mit signiertem `stopPlan`.
Der Compiler erhält dazu Originalanker und bindet sie an die tatsächliche
gerichtete Route, eine eindeutige Plattform und die vollständige Formation.
Zwei bis 100 geordnete Halte werden nativ geprüft. Alte Korpora ohne diese
Evidenz erhalten keinen nachträglich geschätzten Haltplan. Kartenpositionen,
Sollzeiten, gewöhnliche Signalhalte und Bewegungsereignisse ersetzen keinen
Beleg. Die Betriebsengine erzeugt Ankunft erst an der exakten Haltlage bei
Stillstand und Abfahrt erst beim tatsächlichen Beginn eines freigegebenen
Bewegungsabschnitts nach Mindestaufenthalt und frühester Sollabfahrt.

Der regionale Worker speichert Belege und Betriebszustand atomar.
`DemandProgressConsumer` prüft Welt, Region, Initialisierungspin, Commit,
native Ereignissequenz und Haltidentität. Er übergibt die Fakten dem Rust-Kern
in ihrer tatsächlichen Reihenfolge. Der persistente `DemandProgressCursor`
behält auch noch nicht vollständig bestätigte Belege vorauslaufender Regionen.
Erst Zeiten strikt vor dem kleinsten bestätigten Regionszeitpunkt werden
übernommen; gleichzeitige Fakten werden gemeinsam ausgewertet. Ein
Angebotsendsnapshot darf frühere Abfahrten nicht rückwirkend beeinflussen.

`loadDemandOfferHistory` rekonstruiert dafür bestätigte SPFV-Angebote aus dem
atomaren Paar `planning.runtime-state`/`planning.diagram` bis zur jeweiligen
Weltsequenz. Ihre wirksame Zeit ist die bestätigte Commitzeit seit Weltepoche,
nicht die Bestell- oder Vorschauzeit. Höchstens 256 Angebotsrevisionen werden
mit den Haltbelegen zeitlich fortgeschrieben; bei gleicher Zeit entscheidet
die dauerhafte Weltsequenz. Noch vorauseilende Angebote bleiben im privaten
Cursor. Unbelegte Cancel-/Delay- oder Betreiberänderungen eines aktuellen
Kartensnapshots werden im autoritativen Pfad abgelehnt. Ist-Zeiten und daraus
abgeleitete Folgeprognosen stammen dort ausschließlich aus den Haltbelegen.

Der serverseitige Regionalzyklus bereitet Nachfrage vor dem Advance vor und
holt die Belege danach nach. Die neue Integration führt Importbinder, echte
native Bewegung, Workerjournal, Consumer, native Nachfrage, Restore und HTTP
zusammen. Ihr lokaler Rust-Lauf ist bestanden; die vollständige Linux-NAPI-CI
steht noch aus. Kern- und Transporttests mit synthetisch zugeführten Belegen
bleiben als solche gekennzeichnet und ersetzen diesen Addonnachweis nicht.

Laufende Reiseketten enden nicht mit dem Ende ihres Erzeugungsfensters.
Der Kern erlaubt `nowMs` nach `windowEndMs`, damit ein vorhandenes Fenster bis
zum Ende seiner Reiseketten fortgeschrieben werden kann.

Der optionale Eingang `generationWindows` bündelt bis zu 256 disjunkte
Erzeugungsfenster derselben Welt, Periode, Release- und Seedbindung. Bei dieser
Form ist das äußere `daySliceId` genau `pooled`; äußeres Start-/Ende sind Minimum
und Maximum der vollständigen Liste. Jedes innere Fenster pinnt Start, Ende und
seinen echten Tagesgangnamen. Die Eingabereihenfolge ist irrelevant. Der Kern
erzeugt dieselben stabilen Kohorten wie für einzelne Fenster, bewirtschaftet
aber sämtliche Reisenden in einem gemeinsamen Abschnittskapazitätszustand.
Die vollständige Liste ist vor Betriebsbeginn zu pinnen und bleibt während
einer Fortschreibung gleich. Zwei isoliert ausgewertete Fenster dürfen nicht
addiert und als gemeinsam kapazitätsgeprüfte Belegung veröffentlicht werden.
Gesamtgrenzen für Reisende, Sucharbeit und Manifestgröße gelten für den ganzen
Pool, nicht jeweils erneut pro Fenster.

`pinDemandPoolSeeds` persistiert vor dem ersten Regional-Advance alle
freigegebenen Pools, einschließlich zukünftiger Fenster, als private
`demand.pool-initialized`-Einträge. `DemandPoolSeed` bindet die vollständige
Vorlage, native Anfangsauswertung, Deployment-/Eingabe-/Ergebnishashes,
Regionsstände und tatsächliche Journalgrenze. Eine bereits vorhandene
passende Abfahrt verhindert einen neuen Seed, auch bei Weltzeit null.
Wiederanlauf prüft den gespeicherten Anfang nativ und berechnet keine
historische Anfangsbelegung mit dem heutigen Angebot. Zwischenfortschritte
stehen in privaten `demand.pool-progressed`-Einträgen; nur der finale
`demand.evaluated`-Kopf wird zur aktuellen Nachfrageprojektion. Cursor und
Auswertung werden unter Weltmutex atomar committet. Seeds/Checkpoints sind
auf 16 MiB, Regionen auf 256 und Haltbelege pro Pool auf 40.000 begrenzt.

Die Plattform hält den bisherigen Pool bis zum Maximum aus Fensterende und
wirksamen Fahrtenden seiner Dienste verfügbar. Dabei berücksichtigt sie bereits
gespeicherte Betriebsfakten, aktuelle bestätigte Verspätungen und neu native
zugeteilte SPFV-Fahrten vor der Poolwahl. Ein angrenzender Release wird bis zu
diesem Ende zurückgestellt; danach beginnt er mit seinem eigenen Pin. Statisch
überlappende Releasekorpora bleiben unzulässig. Ein Kaltstart prüft höchstens 256
bereits begonnene Pools mit jeweils zeitlich begrenzter SPFV-Projektion; deren
Cache hält höchstens 256 Einträge. Nach Restore beginnt die Suche beim zuletzt
gespeicherten Pool und öffnet abgeschlossene Releases nicht erneut. Mit
operativen Belegen hält sie zusätzlich sämtliche begonnenen Reiseketten
bis zur bestätigten Zielankunft im alten Pool, auch während eines Umstiegs.
Eine prognostizierte Endzeit beendet keine laufende oder gestrandete Reise.
Der bereits gepinnte Folgepool holt seine historischen Belege beim Übergang
nach; die öffentlich sichtbare Nachfragezeit geht dabei nicht zurück.

Die eigentümergeprüfte, paginierte SPNV-Manifestroute zeigt Fahrgastkennungen, Ein-/Ausstiegsbezeichnungen,
Sitzklasse und Platzbedarf. `fareFact`, Tarifpolicy, interne Sitznummern und
Reiseketten bleiben im geschützten serverseitigen Manifest.

Für ein tatsächliches Abschnittsmanifest müssen die Abfahrt am Ausgangshalt
und die noch ausstehende Ankunft am Folgehalt belegt sein. Nur dann trägt die
Ansicht `source: confirmed`. Ein Signalhalt ändert den Abschnitt nicht;
am Fahrgasthalt, vor Beginn und nach Ende antwortet die Route mit 409.
Künftige Belegungen und nachgeführte Fahrplanzeiten bleiben Prognosen, auch
wenn die Gesamtauswertung `projectionMode = progress_bound` verwendet.

## 2. Release und gemeinsame Kohorten

Ein Release enthält mindestens zwei eindeutige `DemandZoneV1`, Nachfrageprofile,
Saisonfaktor, Tagesgang mit insgesamt 10.000 Basispunkten, Kapazitäts- und
Suchgrenzen sowie `FareCompliancePolicyV1`. Jeder importierte Quellenverweis
enthält URL, Lizenz, Artefaktprüfsumme und explizite Rechtefreigabe. `observed`
erfordert mindestens eine freigegebene Quelle. Spielwerte bleiben `balanced`.
Beide Provenienzen sind auch bei Tarifkontrollwerten sichtbar.

Ein Profil benennt Reiseanlass, Tagesreisequote je 10.000 Einwohner,
Zielgewichte für Arbeitsplätze, POIs und Bevölkerung, gewünschte Komfortklasse,
Platzbedarf und Reservierungsbedarf. Das sind sachliche Reisebedürfnisse,
keine geschützten Personenmerkmale. Pro Herkunft, Profil und Tagesgangfenster
gilt mit genau einer abschließenden Abrundung:

```text
Reisende = Bevölkerung × Tagesreisequote × Saisonfaktor × Tagesgang / 10^12
Zielgewicht = Arbeitsplätze × Arbeitsplatzgewicht
            + POIs × POI-Gewicht + Bevölkerung × Bevölkerungsgewicht
```

Die exakte Herkunftssumme wird proportional auf andere Zonen verteilt.
Ganzzahlige Reste erhalten die größten Nachkommarestwerte; Gleichstände löst
ein benannter, seedgebundener Hash und danach die Zonenkennung auf. Es entstehen
keine Reisen in die Herkunftszone. Fehlen attraktive Ziele, wird der Release
abgelehnt. Die Summe aller `JourneyDemandV1` entspricht exakt der Erzeugung.
Tagesgangfenster sind explizit benannt; der Aufrufer gibt das dazu passende,
gleich lange Weltzeitfenster an. Jahreszeitenfaktoren sind releasegebunden.

`StationTransitAccessV1` enthält Station, Zugangszeit, statischen ÖPNV-Takt und
stufenfreie Erreichbarkeit. Die Zugangsdauer ist Zugangszeit plus halber Takt.
Damit beeinflusst die statische Anbindung die tatsächliche Reisekette und die
Erreichbarkeit für entsprechenden Platzbedarf. Zonen können ohne Bahnhof sein;
alternative Verkehrsmittel bleiben verfügbar.

Kohortenkennungen werden ausschließlich aus Welt, Periode, Release, Fenster,
Herkunft, Ziel und Profil abgeleitet. `passengerKey` und `journeyChainId`
verwenden benannte getrennte SHA-256-Teilströme und die laufende Kohortenordinalzahl.
Angebotsreihenfolge, Betreiberkennung, Kapazität und Störung ändern diese
Kennungen nicht. Es existieren keine dauerhaften Individualdatensätze der Welt.

## 3. Verbindungs- und Zugwahl

Die Suchgrenze des Releases erlaubt höchstens zwei Umstiege. Der Kern durchsucht
die aktuellen Zughalte nach direktem Weg und zulässigen Umsteigeketten. Ein- und
Ausstieg müssen Fahrgasthalte sein; Ausfälle und ausgelassene Halte scheiden aus.
Ein Anschluss muss einschließlich der veröffentlichten Mindestumsteigezeit
erreichbar sein. Ausgangs- und Zielzugang sind Teil der Reisezeit. Tarifprodukte
müssen für die gewünschte Komfortklasse gelten; ein intakter Verkaufskanal oder
der veröffentlichte Bordverkauf muss verfügbar sein. Alternative Verkehrsmittel
(`car`, `coach`, `local_transit`, `walk`) tragen ebenfalls Preis, Zeit, Takt,
Zuverlässigkeit, Komfort und Kapazität.

Es gibt keinen Gesamtpunktwert. Jedes Nachfrageprofil veröffentlicht eine
vollständige, eindeutige Reihenfolge der sechs Dimensionen `fare`, `time`,
`transfers`, `frequency`, `reliability`, `comfort`. Verglichen wird streng
lexikographisch; Preis, Reisezeit, Umstiege und Takt werden minimiert,
Zuverlässigkeit und Komfort maximiert. Bei vollständigem Gleichstand entscheidet
ein seedgebundener Kohorten-/Verbindungshash, danach die Verbindungskennung.
Jede Wahl enthält sämtliche Dimensionswerte, Rangfolge, ausgewählte Zugabschnitte
und verworfene Alternativen mit maschinenlesbarem Grund. Die Reihenfolge der
eingelieferten Angebote beeinflusst weder Wahl noch Kapazitätszuteilung.

## 4. Tarif, Vertrieb und Kapazität

`FareProductV1` pinnt Tarifkennung, Komfortklasse, Preis pro befahrenem Abschnitt,
Vertriebszugang und gegebenenfalls Reservierungspflicht. Der Gesamtpreis einer
Reisekette ist die ganzzahlige Summe ihrer Abschnitte. Ungültige Fahrausweise
entstehen ausschließlich aus der veröffentlichten Tarifkontrollpolicy; ein
Vertriebsausfall erzeugt keine versteckte Ersatzverteilung von Fahrberechtigungen.

Kapazität gilt auf jedem befahrenen Abschnitt und je Komfortklasse. Sitze und
Stehplätze werden getrennt gezählt; Premium- und reservierungspflichtige Reisen
erhalten ausschließlich Sitze. Rollstuhl-, Fahrrad- und Kinderwagenplätze
sind zusätzliche harte Kontingente. Alle Nachfrageprofile konkurrieren in einer
seedgebundenen, vor der Angebotswertung festen Kohortenreihenfolge. Innerhalb
einer Kohorte entscheidet die Ordinalzahl. Die Zuteilung einer vollständigen
Reisekette ist atomar: Passt ein Umsteigeabschnitt nicht, werden vorherige
Abschnitte nicht belegt. Dann wird die nächste zulässige Verbindung geprüft.
Reservierungen werden atomar pro Abschnitt zugeteilt und mit stabiler
Reservierungskennung ausgegeben; zwei Reisende können keinen Sitzplatz desselben
Abschnitts erhalten. Eine hohe Nachfrage überschreitet niemals die harte
Gesamtkapazität. Überbelegung bedeutet hier Reisende oberhalb der Sitzplatzanzahl
innerhalb der zulässigen Stehplatzkapazität.

Zurückbleibende Reisende bleiben explizit als `unserved` erhalten. Eine spätere
Alternative kann sie aufnehmen, ohne die Herkunftssumme zu verändern. Getrennte
Summen für Schiene, alternative Verkehrsmittel und unbediente Nachfrage ergeben
exakt die erzeugte Nachfrage. Revenue-Projektionen sind Prognosen, keine
Ledgerbuchungen und kein Beweis eines Zahlungseingangs.

## 5. Autoritatives SPNV-Manifest

Jeder SPNV-Zugabschnitt besitzt ein `PassengerManifestV1` mit Welt, Release,
Zuglauf, Abschnitt, Revision und exakt den zugeteilten Fahrgästen. Jede Person
trägt Ein-/Ausstieg ihrer aktuellen Zugteilreise, stabile Reisekette, Profil,
Komfort, Platzbedarf und verdeckten `fareFact`. Die Policy teilt im separaten
Hash-Teilstrom `fare_compliance` in `valid`, `valid_unpresentable`, `invalid`
auf; sie sieht ausschließlich Weltseed, Reisekette und Fahrgastordinalzahl.
Komfort, Platzbedarf und Aussehen fließen niemals in diese Ziehung ein.
Ein begonnener M15-Fall pinnt seinen ursprünglichen Sachverhalt dauerhaft.

Revidierte Auswertungen behalten unveränderte Personenkennungen. Umsteigen
erzeugt keinen zweiten Reisenden. Je Zugabschnitt sind Personenkennungen eindeutig.
`StopPassengerFlowV1` beweist je Halt `vorher + Einsteiger − Aussteiger = nachher`;
die Abschnittsbelegung stimmt mit Manifest und Kapazitätszuteilung überein.
Die öffentliche Projektion enthält ausschließlich aggregierte Auslastung,
Ein-/Aussteiger und erklärbare Nachfragegründe. `fareFact` bleibt ausschließlich
serverseitig. Individuelle Personenschlüssel bleiben außerhalb der
autorisierten privaten Zugansicht serverseitig. Die eng begrenzte Weitergabe
synthetischer Schlüssel an M15
folgt [Schaffnermodus](schaffnermodus.md) 3.3 und 11.1.

M15.2 übernimmt den vorhandenen Vertrag direkt. Eine `PassengerProjectionV1`
ist eine abgeleitete Innenraumansicht eines tatsächlich quittierten Abschnitts;
sie ist weder ein neues Manifest noch ein neuer Beleg über eingestiegene
Personen. `forecast` und fehlende Haltquittungen bleiben ausdrücklich
ungeeignet. Nachfragezustand, Betriebsquittung, Zug und Release müssen
zusammenpassen. Revidierte M10-Fakten ändern ausschließlich die zugehörige
Projektion; ein begonnener Kontrollfall behält seinen ursprünglichen Pin.

## 6. Kalibrierung und Abnahmegrenze

`DemandCalibrationV1` prüft externe Beobachtungen getrennt für SPNV und SPFV.
Ein eingefrorener Plan enthält disjunkte Trainings- und Holdoutkennungen sowie
Toleranzen für `daily_profile`, `cross_section` und `transfer_flow`. Beobachtungen
tragen Quellenkennungen; jede Quelle benötigt Rechtefreigabe, Lizenz und
Artefaktprüfsumme. Ein Datensatz darf nie zugleich Training und Holdout sein.
Für jeden Vergleich gilt `Abweichung = |Simulation − Beobachtung|`; akzeptiert
wird höchstens das Maximum aus absoluter Toleranz und ganzzahliger relativer
Toleranz. Nullbeobachtungen verwenden nur die absolute Toleranz.
Der Report muss beide Verkehrsarten und alle drei Messgrößen nachweisen und
weist jede Abweichung separat aus. Fehlende, unfreigegebene oder ausschließlich
synthetische Beobachtungen können keine reale Kalibrierungsabnahme bestehen.

Die mitgelieferten Szenarien sind ausdrücklich synthetische, als `balanced`
gekennzeichnete Pilotregion-Regressionen. Sie beweisen Tagesgang, Erhaltung,
mehrere Halte, gemeinsame SPNV-/SPFV-Wahl, Kapazität, Reservierung, Vertriebsstörung,
Anschlussverlust, Welttrennung, Eingabepermutation und JSON-Restore.
Ein echter freigegebener SPNV-/SPFV-Holdout ist ein gesonderter Abnahmebeleg.

Der dokumentierte reale RE7-Vergleich ist noch nicht bestanden:
Holdout-WAPE **52,38 %** für stündliche Einsteiger und **45,34 %** für
gerichtete Abschnittsbesetzung; nur 6/21 beziehungsweise 31/105 Vergleiche
liegen innerhalb der Diagnosegrenze. Freie Vergleichsdaten für SPNV-Umstiege
sowie SPFV-Tagesgang, -Querschnitt und -Umstiege fehlen weiterhin.
Diese historische Diagnose bleibt unverändert; Quelle und reproduzierbarer
Vergleich stehen in [M10-Kalibrierungsquellen](m10-kalibrierungsquellen.md).

Der Nutzerauftrag vom 06.09.2026 ändert den Umfang von
[#173](https://github.com/larynxberlin-rgb/Zugfolge/issues/173):
Die [einwohnerbasierte Stationsnachfrage](m10-populationsnachfrage.md)
verwendet frei nutzbare amtliche Ortsbevölkerung, konservierte Einwohneranteile,
eigene Nachfrageklassen und ungefähr geschätzte Wunschziele aus bestehenden
Referenzverbindungen. Der optionale Releaseblock wird im selben Rust-Kern
ausgewertet und bleibt `balanced`. Die API und Karte zeigen Einwohnerbasis,
Klasse und häufigste Wünsche auch für unbediente Stationen. Aktuelle Spielerzüge
vergrößern das exogene Budget nicht. Gemessene Holdouts sind für diesen
ausdrücklich geänderten Modellumfang keine Abschlussbedingung; die Methode
behauptet keine empirische Kalibrierung.
