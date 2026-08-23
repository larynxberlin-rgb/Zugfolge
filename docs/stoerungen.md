# Störungen, Baustellen und Ersatzverkehr

Diese Spezifikation ist der versionierte Fachvertrag für M8. Sie ergänzt
`betrieb.md`; Code darf ihre Regeln nicht durch einen globalen
Prioritätswert ersetzen.

## 1. Richtlinie je Welt

`DisruptionPolicy` trennt geplante Baustellen und ungeplante
Betriebsstörungen. Beide wählen genau einen Modus: `REALISTIC`, `SIMULATED`
oder `MANUAL`. Jede Version bindet `world_id`, Provider-Set, Generatorprofil,
Regelversion, Gültigkeitsfenster, Antragsteller, Veröffentlichung und
Begründung. Eine neue Version wird während einer Fahrplanperiode nur
vorgemerkt und exakt am veröffentlichten Fahrplanstichtag aktiv.

`REALISTIC` ist für externe Ereignisse fail-closed: Ein Provider-Set wird erst
bei dokumentierter Rechtefreigabe aktiviert. Bei Ausfall bleibt der letzte
sichere, mit Abrufzeitpunkt gekennzeichnete Stand sichtbar. Es gibt keinen
automatischen Wechsel auf `SIMULATED`.

Die tagesaktuelle Einschränkungsschicht ist davon getrennt. Weil dafür kein
maschinenlesbarer Zugang besteht, erzeugt auch `REALISTIC` sie aus dem offen
ausgewiesenen, gepinnten `daily_restriction`-Modell. Das ist kein
Provider-Fallback. Jedes Ereignis trägt Modell-, Kalibrier-, Seed-,
InfraRelease- und Regelversion.

Der Infrastrukturfeed deckt keine internen Fahrzeug- und Haltevorgänge eines
Verkehrsunternehmens ab. Deshalb ergänzt `REALISTIC` deterministisch genau
diese Feed-Lücke: technische Fahrzeugereignisse mit Bezug auf angebotene
Zugfahrten sowie Haltverlängerungen mit Bezug auf angebotene Fahrgasthalte.
Sie tragen die Herkunft `SimulatedRealisticGap`. Infrastrukturereignisse
werden in diesem Kanal ausdrücklich nicht noch einmal gezogen; dadurch gibt es
keine Doppelzählung mit dem Provider. Personalausfälle, Fahrzeugverfügbarkeit
oder andere Ursachen, die bereits aus einem autoritativen Spielzustand
entstehen, bleiben dessen Ereignisse und werden ebenfalls nicht dupliziert.

## 2. Entstehung und Wirkung

Der Generator verwendet ausschließlich die benannten Seed-Substreams
`disruption` und `daily_restriction`. Geplante Baustellen, spontane
Betriebsstörungen und die tagesaktuelle Einschränkungsschicht sind drei
getrennte Ereigniskanäle. Häufigkeit, Schwere, Dauer und Vorlauf sind
ganzzahlig. Die Auswahl berücksichtigt Ressourcenart und Belastung; alle
Ergebnisse beziehen sich auf bestehende Konfliktressourcen. Der Generator
erzeugt Primärursachen. Die vorhandene Simulation propagiert deren Folgen;
Zugfolge wird nie als Primärereignis gezogen.

Spontane Störungen werden nicht aus der La abgeleitet. Infrastrukturstörungen
beziehen ihre Rate auf die Tage des abgebildeten Netzes und werden an eine
belastungsgewichtet ausgewählte Konfliktressource gebunden. Fahrzeugstörungen
beziehen ihre Rate auf tatsächlich angebotene Zugfahrten, verlängerte Halte auf
tatsächlich angebotene Fahrgasthalte. Beide tragen genau einen betroffenen
`train_run_id`. Damit kann eine Türstörung weder das gesamte Netz treffen noch
als wirkungsloser allgemeiner Kartenhinweis erscheinen.

Simuliert werden nur Einträge mit einer im aktuellen Spiel tatsächlich
abgebildeten Wirkung:

| Wirkung | Spielwirkung |
|---|---|
| Sperrung | betroffene Konfliktressourcen nicht belegbar |
| eingleisiger Betrieb | beide Richtungen reservieren dieselbe Restkapazität |
| Langsamfahrstelle | Fahrdynamik mit ganzzahliger Höchstgeschwindigkeit neu rechnen |
| Bahnsteigwechsel | Ersatzgleis erneut als echte Ressource reservieren |
| Halt vor Ressource | explizite, begrenzte Warteentscheidung |
| abweichender Laufweg | Restkapazität aller Alternativressourcen erneut prüfen |
| Fahrzeugbeschränkung | Achslast und Zuglänge gegen den Zugverband prüfen |
| verkürzte Bahnsteignutzlänge | nutzbare Kante gegen die Zuglänge prüfen |

Reine Hinweise ohne Spielwirkung werden vollständig herausgefiltert. Ein
Funkausfall erzeugt im aktuellen Simulationsstand insbesondere weder Ereignis,
Marker, Verspätung, Kapazitätsverbrauch noch Dispositionsmaßnahme. Dasselbe
gilt für bloße Regelhinweise und Strombegrenzungen, solange kein
zustandsrelevantes Traktionsmodell ihre Wirkung belastbar abbildet.

Jedes Ereignis besitzt einen Geltungsbereich für Richtung, Verkehrsart und
optional konkrete Zugläufe. Einschränkungen für Regel-/Gegengleis sowie Reise-
oder Güterzüge gelten dadurch nicht pauschal für alle Fahrten.

Jede Baustelle veröffentlicht Beginn, Ende, Ressourcen, Restkapazität und
Vorlauf. Manuelle Ereignisse benötigen Hauptursachencode, dazu passende
Feinkennung und freien Audittext. Sie durchlaufen dieselben Konflikt-,
Fahrzeug-, Personal-, Vertrags- und Durchführbarkeitsgrenzen.

## 3. Haupt- und Feincodes

Referenz für die Katalogstruktur ist die 2023 gültige Ril 420.9001 samt
Beispiel-Feinkodierungen, gültig ab 10.12.2023. Zugfolge speichert die
zweistellige Hauptkennung sowie eine getrennt versionierte Feinkennung mit
eigenem, knappem Einordnungstext. Firmen- und Produktnamen sind aus allen
Laufzeitkennungen und -texten entfernt; der Quellenname steht ausschließlich
im Rechte- und Herkunftsnachweis.

Die Feinkodierungen der Referenz sind beschreibende Beispiele, keine weitere
amtliche Zahl unterhalb des Hauptcodes. Zugfolge vergibt deshalb stabile
semantische IDs. Für die Hauptcodes 19, 29, 40, 49, 59, 69–71, 80 und 91–95
sieht der Referenzprozess keine Feinkodierung vor; der Spielkatalog erfindet
dort keine.

- 00, 02 und 06 sind Prozesskennungen, keine abschließenden Ursachen.
- 10 bis 85 sind unmittelbar wirkende Primärgründe.
- 90 kennzeichnet zunächst ein gefährliches Ereignis.
- 91 bis 95 sind Folgen einer bestehenden Verspätung.
- 96 ist ein befristeter Prüfstatus, keine dauerhafte Ursache.
- Kodiert wird der am Zug unmittelbar wirkende Umstand, keine beliebig
  rückwärts rekonstruierte Kausalkette.
- Zuständigkeit bleibt vom Code getrennt: Infrastruktur, Partner, EVU,
  Nachbarinfrastruktur, Nachbar-EVU, extern, abgeleitet oder in Prüfung.

Jeder der 199 Feincodes besitzt zusätzlich eine maschinenlesbare
Simulationsdisposition. Sie unterscheidet geplantes Modell, spontane
Infrastrukturursache, interne spontane Ursache, endogene Spielursache,
Szenario/Provider, wirkungslosen Ausschluss und vorläufigen Prüfstatus. Für
`REALISTIC` ist separat festgehalten, ob der Code aus Infrastrukturquelle,
interner Lückensimulation oder autoritativem Spielzustand stammt. Damit gilt
„vollständig“ nicht fälschlich als „jeder Code wird zufällig gezogen“:
Fahrplanfehler entstehen aus einem fehlerhaften Fahrplan, Folgestörungen aus
der Verspätungsfortpflanzung und Prüfkennungen werden nie als Primärereignis
erzeugt.

Der Wirkungsausschluss umfasst gegenwärtig insbesondere Telekommunikation,
reine Fahrgastinformation, Schallschutz, Strombegrenzung ohne Traktionsmodell,
fahrzeugseitigen Zugfunk und Prüfstatus 96. Sobald eine dieser Klassen eine
konkrete Spielmechanik erhält, muss ihre Disposition zusammen mit einem
fehlschlagenden Test geändert werden; ein bloßer Kartenhinweis reicht nicht.

Der Reisendeninformationscode 78 „Ersatzverkehr mit Bus ist eingerichtet“ ist
eine Qualitätsabweichung in einem getrennten RIS-Katalog, kein betrieblicher
Verspätungsursachencode.

## 4. Statistische Kalibrierung

Die Primärursachenverteilung `primary-cause-minutes/de-2024-v1` basiert auf
den klassifizierten Verspätungsminuten der Marktuntersuchung Eisenbahnen 2025.
Nach Herausnahme der nur fortgepflanzten Gruppe Zugfolge werden die sieben
Primärgruppen ganzzahlig auf 10.000 Basispunkte normiert:

| Gruppe | Basispunkte |
|---|---:|
| Bauarbeiten | 761 |
| Betrieb | 6.861 |
| externe Einflüsse | 891 |
| Fahrplanung | 57 |
| Fahrzeuge | 309 |
| Infrastruktur | 690 |
| Personal | 431 |

Der beobachtete Zugfolgeanteil von 3.449 Basispunkten an allen klassifizierten
Verspätungsminuten ist ein Kalibrierziel für M4.3, kein Generatorgewicht.
Quelle:
<https://www.bundesnetzagentur.de/SharedDocs/Mediathek/Berichte/2025/marktuntersuchungeisenbahnen2025.pdf?__blob=publicationFile&v=3>.

### 4.1 Spontane Betriebsstörungen

`spontaneous-incidents/de-spnv-2022-2024-v1` trennt Inzidenz und Wirkung. Die
Primärursachenverteilung oben beschreibt Verspätungs**minuten** und darf daher
nicht als Ereigniswahrscheinlichkeit missbraucht werden.

| Bezug | veröffentlichter Anker | Generatorrate |
|---|---:|---:|
| Leit-/Sicherungstechnik und Weichen in der Pilotregion | 436 + 122 Fälle im 2. Halbjahr 2024 | 303 je 100 Netztage |
| technische Fahrzeugstörungen im SPNV | 0,22 % der Zugfahrten | 22 je 10.000 Fahrten |
| Überschreitung der Haltezeit im SPNV | 156.000 Minuten bei 9,7 Mio. Halten im Juni 2022 | 9.649 Zusatzsekunden je 10.000 Halte |

Die Pilotregionszahlen stammen aus
<https://dserver.bundestag.de/btd/21/000/2100029.pdf>. Die fahrtenbezogenen
Fahrzeugquoten und Untergruppen stammen aus
<https://dserver.bundestag.de/btd/20/067/2006736.pdf>. Die Halte- und
Verspätungsmengen stammen aus
<https://dserver.bundestag.de/btd/20/030/2003024.pdf>.

Die Quellen veröffentlichen nicht jede benötigte Unterteilung. Folgende Werte
sind deshalb ausdrücklich Modellannahmen und keine behaupteten amtlichen
Fallzahlen:

- Die 436 Fälle der Leit-/Sicherungstechnik werden gleichmäßig auf Stellwerk,
  Signal und Gleisfreimeldung verteilt; die 122 Weichenfälle bleiben separat.
- Von 22 Fahrzeugfällen entfallen gemäß Quelle 7 auf Bremsen und 9 auf
  fahrzeugseitige Zugbeeinflussung. Die sechs übrigen Fälle werden auf
  sonstige betriebswirksame Fahrzeugtechnik (4) und Türüberwachung (2)
  verteilt. Innerhalb der sonstigen Fahrzeugtechnik wählt das Modell passend
  zu Reisezugwagen, Güterwagen oder Triebfahrzeug; es wird keine zusätzliche
  Türquote auf die Gesamtquote aufgeschlagen.
- Weil für verlängerte Halte nur Minuten, aber keine Fallzahl veröffentlicht
  sind, modelliert der Generator 40 Fälle je 10.000 Halte mit einer
  ganzzahligen Dauerverteilung um rund 241 Sekunden. Hohes
  Reisendenaufkommen, barrierefreier Ein-/Ausstieg, Verhalten/Hilfeleistung und
  Abfertigung teilen dieses Zeitbudget.

Alle Klassen erzeugen eine heute vorhandene Spielwirkung: einen begrenzten
Halt vor einer Ressource beziehungsweise eine konkrete zusätzliche Haltezeit.
Weichen-, Stellwerks-, Signal-, Gleisfreimelde-, Brems-, Zugbeeinflussungs-,
Tür- und Fahrgastwechselstörungen sowie Störungen sonstiger Fahrzeugtechnik
sind damit außerhalb
der La eigenständig simuliert. Die Parameter bleiben je Welt versioniert und
werden gegen reale Fahrten und Halte materialisiert, nicht gegen eine frei
erfundene pauschale Ereigniszahl.

Im Modus `SIMULATED` werden Infrastruktur-, Fahrzeug- und Haltklassen aus
ihren getrennten Bezugsgrößen gezogen. Im Modus `REALISTIC` werden aus diesem
Generator nur Fahrzeug- und Haltklassen materialisiert; Stellwerk, Signal,
Gleisfreimeldung und Weiche kommen dort ausschließlich aus dem freigegebenen
Infrastrukturfeed. Tür-, Brems-, sonstige Fahrzeug- und Haltzeitstörungen
bleiben somit auch realistisch vorhanden, obwohl sie auf Strecken-Info nicht
veröffentlicht werden.

### 4.2 Manueller Administrationspfad

Eine manuelle Störung ist eine Hochrisikoaktion. Die vorbereitete
Odoo-Administration sendet sie ausschließlich als signiertes, typisiertes
`admin.manual_disruption_create`-Kommando über die persistente Game-Queue. Das
Game veröffentlicht die Capability erst, wenn der M8.3-Handler initialisiert
ist, und prüft Antragsteller gegen zweiten Freigeber, Welt, Weltepoche,
Zeitraum, Ressourcen, Haupt-/Feincode sowie eine konkrete, nicht leere
Wirkung erneut. Odoo ist weder Simulationskern noch Source of Truth.

Das deklarierte Wirkungsschema `zugfolge-manual-disruption-effect/v1` enthält
Wirkungsart, Hauptcode, Feincode, ganzzahlige Verzögerung und je Ziel die
Region, Kartenposition, stabile Konfliktressource und betroffenen Zugläufe.
Mehrere Ziele erhalten stabile Teilkommandos; ein Retry bleibt durch Ereignis-
und Teilkennung idempotent. Erfolgreiche Ausführung liefert einen
autoritativen Game-Auditverweis zurück. Wirkungslose Werte wie
`radio-unavailable`, Selbstfreigabe, unbekannte Ressourcen oder bereits
abgelaufene Zeitfenster werden vor dem Single Writer abgelehnt.

Die bereitgestellte aktuelle Einschränkungsliste dient als Wirkungstaxonomie:
Neben Total- und Teilsperrung treten Fahrzeitverlängerung,
Fahrplanabweichung, Gegengleisbetrieb, Halt, Ausfall/Teilausfall, Umleitung,
Geschwindigkeits-, Achslast-, Längen- und Bahnsteigbeschränkungen auf. Sie ist
kein Laufzeitfeed.

Die fünf bereitgestellten Tagesausgaben vom 09.08.2026 umfassen 540 Seiten.
Eine konservative strukturierte Extraktion ergab 367 Einschränkungszeilen,
darunter 114 numerische Langsamfahrstellen. Deren häufigste Werte waren 70,
20, 40, 30, 60, 120 und 50 km/h. Das Tagesmodell verwendet diese ganzzahlige
Verteilung, weist sie wegen des einzelnen Referenztags aber als Momentaufnahme
`daily-restrictions/de-2026-08-09-v1` aus. Wirkungslose Zeilen werden beim
Erzeugen verworfen. Rohdaten, Originaltexte und PDF-Seiten werden nicht
ausgeliefert.

Der Betreiberbericht 2025 stützt die Modellklassen schlechter Anlagenzustand,
Langsamfahrstellen, intensive und kurzfristige Bautätigkeit, hohe
Verkehrsdichte, Personalengpässe und externe Einzelereignisse:
<https://zbir.deutschebahn.com/2025/de/puenktlichkeit/>. Diese Quelle kalibriert
keine Feincodes und ersetzt keine unabhängige Statistik.

## 5. Abfahrtsrechte

Jede Fahrt besitzt je Halt oder Betriebsstelle ein explizites Fenster
`earliest <= scheduled <= latest`. Vor jeder Entscheidung gelten in dieser
Reihenfolge harte Grenzen: Welt, Zeitfenster, Mindesthaltezeit, Fahrstraße,
Personal/Fahrzeug und Konfliktressourcen.

| Fahrttyp | vor Plan | planmäßig oder später |
|---|---|---|
| Personenzug | nie pauschal; `earliest = scheduled` | Anschlüsse und Fahrgastwirkung nach harten Grenzen prüfen |
| Leerfahrt | im ausdrücklichen Fenster | darf warten, wenn kein notwendiger Umlauf gefährdet wird |
| Güterzug | im ausdrücklichen Fenster | Vertragsfolge und Netzstabilität erklären; kein pauschaler Nachrang |
| Zusatzfahrt | im ausdrücklichen Fenster | wie die zugewiesene betriebliche Aufgabe |
| Rangierfahrt | im ausdrücklichen Fenster, weiterhin automatisiert | notwendige Fahrzeug-/Versorgungsarbeit darf nicht verhungern |

Eine spätere Abfahrt braucht eine protokollierte Ursache: Ressourcenkonflikt,
Sperrung, fehlende Freigabe, notwendige Koordination oder autorisierte
Disposition.

## 6. Virtuelle Fahrdienstleiter

Kalibriergrundlage ist die zum Weltstand 2026 gültige Fahrdienstvorschrift,
insbesondere die Grundsätze „Sicherheit vor Pünktlichkeit“, die Zustimmung zur
Abfahrt auf einem Bahnhof und die fahrstraßenbezogene Fahrwegprüfung. Öffentliche
Fassung und Gültigkeit stehen im
<https://www.dbinfrago.com/web/schienennetz/netzzugang-und-regulierung/regelwerke/betrieblich-technisch_regelwerke/betrieblich_technisches_regelwerk-13174542>;
die für Zugfahrten maßgeblichen Module 408.21–27 sind unter
<https://www.dbinfrago.com/resource/blob/13175008/b7ee5ccbe188a51429cdb6d52427e7c7/Ril-408-21-27-INB-2026-data.pdf>
gepinnt.

Der virtuelle Fahrdienstleiter ist kein lernendes Sprachmodell. Er führt die
kalibrierten Regeln `virtual-dispatcher/rule-408-2025-v2` deterministisch aus.
Vor jeder Priorisierung müssen für genau diese Bewegung alle harten Nachweise
vorliegen:

1. Fahrstraße eingestellt und gegen Umstellen gesichert;
2. Fahrweg frei geprüft;
3. erforderlicher Durchrutschweg frei geprüft;
4. erforderlicher Flankenschutz hergestellt;
5. individuelle Zustimmung durch Hauptsignal, Führerraumsignalisierung,
   zulässiges Ersatzsignal, Befehl oder örtlich zulässige mündliche Zustimmung;
6. Mindesthaltezeit sowie Personal- und Fahrzeugbereitschaft erfüllt.

Fehlt ein Fahrstraßennachweis oder die individuelle Zustimmung, fährt der Zug
auch mit hoher Verspätung oder vielen gefährdeten Anschlüssen nicht. Bei
mehreren am selben Signal bereitstehenden Zügen wird eine Zustimmung nicht auf
den zweiten Zug übertragen. Ersatz- und Befehlsfahrten sind als eigene
Zustimmungsform protokolliert; ihre weiteren örtlichen Geschwindigkeits- und
Befehlssonderregeln werden nur dort ausgeführt, wo der Simulationskern sie
konkret abbildet.

Erst nach diesen Sicherheitsgrenzen erfolgt die regionale,
serverautoritative Auswahl lexikographisch und nicht gewichtet:

1. Sicherheit, Konfliktfreiheit und alle Restriktionen;
2. bereits gesicherte Fahrstraßen;
3. Fahrgast- und Anschlusswirkung;
4. Vertragsfolgen;
5. Netzstabilität;
6. Umlauf-, Fahrzeug- und Personalfolgen;
7. Wiederherstellbarkeit;
8. Verhungerungsschutz notwendiger Rangier- und Versorgungsarbeiten;
9. stabile Kennung als letzte Gleichstandsauflösung.

Die Kriterien 3 bis 9 sind eine veröffentlichte Spiel- und
Dispositionsabstraktion gemäß E11 und E19. Das Regelwerk gibt dafür keine
universelle kommerzielle Zugrangfolge vor; diese Kriterien werden deshalb
nicht fälschlich als Vorschrift ausgegeben.

Alle Fahrten konkurrieren über denselben `CapacityLedger`. Eine Erklärung
nennt Ressource, Zeitfenster, betroffene Fahrten, Regel, Alternativen und
Ablehnungsgrund. Nach Störungsende steigt die Logik kontrolliert hoch.

### 6.1 Kontrollbedingter Betriebshalt (M15.9)

Eine bindende Polizeianforderung aus dem Schaffnermodus erzeugt unter der
Feinursache `authority.police.fare-control` am nächsten noch nicht erreichten
planmäßigen Fahrgasthalt einen `FareControlHoldV1`. Sie bremst den Zug nicht auf
freier Strecke. Der zusätzliche Halt beginnt erst, wenn Mindesthaltezeit und
Fahrgastwechsel erfüllt sind und der Zug sonst abfahrbereit wäre.

Das belegte Bahnsteig- oder Bahnhofsgleis und alle noch nicht sicher geräumten
Fahrstraßen- und Ausschlussressourcen bleiben im gemeinsamen `CapacityLedger`
belegt. Bereits geräumte Ressourcen werden nicht erneut reserviert. Der Halt
endet nach abgeschlossenem Polizeivorgang oder nach der weltvertraglichen
Höchstwartezeit. Pro Zuglauf ist im ersten Release höchstens ein solcher Halt
zulässig; mehrere offene geeignete Fälle werden gebündelt.

Nach Freigabe entsteht kein automatisches Abfahrtsrecht. Der virtuelle
Fahrdienstleiter prüft Fahrweg, Zustimmung und Konfliktlage neu und reiht die
Fahrt ohne Sondervorrang gemeinsam mit Personen-, Güter-, Leer-, Zusatz- und
Rangierfahrten ein. Folgeverspätungen, Anschlüsse, Umläufe, M10-Nachfrage und
Pönalen tragen dieselbe Kausalitätskennung. Fremde EVU und öffentliche
Projektionen sehen datensparsam „behördliche Maßnahme“, nicht den Fahrgastfall.
Details: [`schaffnermodus.md`](schaffnermodus.md) 9.

## 7. Ersatzplanung und Wirtschaft

Ein Ersatzkonzept ist ein eigener `PlanningRun` gegen die Restkapazität.
Umleitungen prüfen Ressourcen, Streckenkenntnis, Zugsicherung,
Elektrifizierung, Zuglänge und Fahrzeugeignung. Vorzeitige Wende prüft
Wendemöglichkeit und Gleis. Taktausdünnung und Linienzusammenlegung prüfen
Vertrag, Fahrzeug, Personal und Umlauf. SEV ist nur Verpflichtung,
Kostenposten und Qualitätsfaktor.

Alle EVU werden deterministisch nach veröffentlichtem Antragszeitpunkt und
stabiler Kennung koordiniert. Verliert ein Antrag die Umleitung, wird die
nächste zulässige Alternative gewählt oder jede Ablehnung erklärt. Ein
fristgerechtes plausibles Konzept mindert die Vertragsfolge. Nichtstun löst
ein sicheres, konfliktfreies und bewusst teureres Standardkonzept aus. Geld
läuft ausschließlich als Integer-Cent über EconomyRelease und Ledger.

## 8. Projektion, Karte und Replay

Jede Veröffentlichung, Frühfahrt, Warteentscheidung, Verspätung, Umleitung,
Streichung, Ersatzwahl, Vertragsfolge und Providerstörung trägt `world_id`,
Sequenz, explizite Simulationszeit, Ursache und Erklärung im append-only
Event-Log. Daraus entstehen Livemap, EVU-gefilterte Betriebszentrale,
Push-Stream, Postfachhinweis, Tagesbericht sowie Replay/Resume mit identischem
Zustandshash.

Infrastrukturereignisse sind eigenständige Kartenobjekte und nicht an einen
gerade sichtbaren Zug gebunden. Geplante Einschränkungen erscheinen als
blaues, hohles Rautensymbol; vor Beginn gestrichelt. Ungeplante Störungen
erscheinen als gefülltes gelbes Warndreieck. Beide zeigen Wirkung,
Haupt-/Feincode, Ressource und Gültigkeit. Farbe ist nie das einzige
Unterscheidungsmerkmal.

## 9. Realistische Provider

Das produktive Provider-Set heißt intern
`public-infrastructure-restrictions/de-v1`. Der Name der Quelle gehört nur in
Provenienz und Quellenregister; Ursache, Haupt-/Feincode und Kartentext bleiben
markenfrei. Aktivierung ist je Welt nur zulässig, wenn
`disruption_provider_states` zugleich `approved`, `enabled` und einen
Rechtebeleg enthält. Die Game-API prüft dieses Gate auch beim Veröffentlichen
einer `REALISTIC`-Policy.

### 9.1 Abrufvertrag

Stand 11.08.2026 ist `https://strecken-info.de/` ausdrücklich freigegeben.
Der Adapter führt außerhalb des Simulationskerns folgenden Zyklus aus:

1. öffentlicher WebSocket-Handshake auf `/api/websocket`, um Revision,
   Quellversion und Datenstände zu erhalten;
2. je ein JSON-POST gegen `/api/baustellen`, `/api/stoerungen` und
   `/api/streckenruhen`, jeweils mit derselben Revision und dem vollständigen
   Deutschlandfilter;
3. strikte Strukturprüfung, Wirkungsgate und Abbildung auf die markenfreien
   Haupt-/Feincodes von 2023;
4. append-only Archivierung von Rohantwort, Normalisierung, Abrufzeitpunkt,
   Quellversion, Revision und kanonischem SHA-256 je `world_id`;
5. erst danach Übergabe der geprüften, ganzzahligen Daten an die
   Simulationsschicht.

Der rollierende Quellfilter und das interne Sichtfenster umfassen jeweils
**mindestens 360 Stunden (15 Tage)**. So erscheinen angekündigte Bauarbeiten
rechtzeitig zur Umplanung, soweit die Quelle sie in diesem Vorlauf liefert.
Der Standardtakt beträgt **30 Minuten**. Das sind drei Datenrequests je Lauf,
also höchstens 144 Datenrequests pro Tag zuzüglich der kurzen Handshakes. Eine
Stunde wäre für geplante Baustellen ausreichend, würde spontane Störungen aber
unnötig spät sichtbar machen. Doppelte unveränderte Antworten erzeugen dank
Snapshot-Hash keinen neuen Archivstand.

### 9.2 Normalisierung und Wirkungsgate

Baustellen bleiben geplante Einschränkungen; Störungen bleiben ungeplant;
Streckenruhen werden als geplante, wiederkehrende Haltefenster geführt.
Mehrmonatige Hüllen werden nicht fälschlich als Dauersperrung interpretiert:
Einzelgültigkeiten mit Wochentag und Uhrzeit werden erst für das konkrete
Materialisierungsfenster in Berliner Zeit expandiert. Koordinaten werden vor
dem zustandsrelevanten Pfad von Metern auf ganzzahlige Millimeter gerundet.

Nur konkrete Wirkungen werden übernommen: Totalsperrung/Ausfall,
Gegengleisbetrieb, Umleitung/Fahrplanabweichung, Fahrzeitverlängerung,
Zurückhalten und Teilausfall. `SONSTIGES`, eine Abweichung ohne Laufwegwirkung,
unbekannte Wirkungen sowie Ursachen ohne belastbare 2023-Codezuordnung werden
mit Grund gezählt, aber nicht simuliert. Originaltexte sind Auditdaten und
werden weder als Spielcode noch als markenbehafteter Kartentext ausgegeben.

Für die nächsten 360 Stunden gleicht die Game-API den neuen sicheren Snapshot
mit dem zuletzt übernommenen Stand ab. Nur Einschränkungen, deren Strecken- oder
Betriebsstellenbezug zu einer Fahrt der aktiven Regional-Simulation auflösbar
ist, werden beim regionalen Single-Writer registriert und dadurch in der
Livemap sichtbar und betrieblich wirksam. Geänderte oder entfallene Einträge
werden vor der Neuregistrierung explizit entfernt. Ein weltgebundenes
Abgleichregister hält den tatsächlich übergebenen Sollstand fest, sodass auch
bei unverändertem Snapshot neu in das rollierende 360-Stunden-Fenster kommende
Einträge übernommen werden. Nicht auflösbare Einträge bleiben ausschließlich
im Audit-Snapshot. Die erste Wirkungsstufe verwendet
deterministische, nach Eingriffsart abgestufte Verzögerungen. Damit erzeugt der
Adapter weder Phantomstörungen noch wirkungslose Kartenmarker.

### 9.3 Ausfall und Tagesmodell

Fehlerhafte Revisionen, unbekannte Schemas, HTTP-Fehler oder ein fehlender
Rechtebeleg sind fail-closed. Der letzte sichere Snapshot bleibt mit Alter und
Hash sichtbar; nach 60 Minuten ist der Zustand veraltet. Es gibt niemals einen
stillen Wechsel auf `SIMULATED`. Health unterscheidet Anlauf, aktuellen Stand,
letzten sicheren Stand und veralteten/ausgefallenen Provider.

Das eigene tagesaktuelle La-Modell bleibt auch in `REALISTIC` zusätzlich
notwendig, weil der öffentliche Feed nicht die vollständige Tages-La ersetzt.
Es ist kein Provider-Fallback, sondern eine offen ausgewiesene,
versionierte Simulationsschicht aus eigenen aggregierten Regeln.

## 10. Konkrete Wirkung in der Betriebsengine v2 (E31)

Policies, Ursachen-/Feincodes, Provider-Normalisierung, Kalibrierung und Audit
bleiben bestehen. Ersetzt ist ausschließlich die Wirkungsschicht:
`delay_seconds`, `ApplyDisruption` als Verspätungsaufschlag und angelieferte
Sicherheits-Booleans sind keine Betriebswirkung mehr. Ein aktivierter Vorfall
ändert eine konkrete Infrastrukturressource oder ein konkretes physisches
Fahrzeug. Die Formation wird danach neu bewertet; Verspätung entsteht nur aus
dem folgenden realen Lauf.

Der nächste Fahrzeugereigniskandidat wird ereignisbasiert aus der einmaligen
Grundquote, Zustand, Laufleistung, Betriebsstunden, Beobachtungen, Wartung und
Beanspruchung terminiert. Sofortmaßnahme, technischer Endzustand und erst danach
die Spielerregel sind getrennte Ereignisse. Aufhebung verlangt eine konkrete
Providerrevision oder technische Freigabe. Der vollständige Vertrag steht in
[`betriebsengine.md`](betriebsengine.md) 7.
