# M15.5 — Releasegebundene Stations- und Umgebungsszenen

Vertrag: `conductor-scene-projection/v1`. Dieses Dokument konkretisiert
[E29](schaffnermodus.md#6-fahrt-umgebung-und-stationen) und
[Issue #215](https://github.com/larynxberlin-rgb/Zugfolge/issues/215) vor der
Implementierung. Es verändert weder Betrieb noch die M15.4-Innenraumgeometrie.

## 1. Quellen und Autorität

| Inhalt | Verbindliche Quelle |
|---|---|
| Zug, EVU, Region, Zeit, Position, Geschwindigkeit, Bewegungszustand und Signalbegriffe | Tatsächliche `OperationalProjection` aus dem committed Operational-v2-Kern |
| Zwischenzeitliche Bewegung | Ausschließlich dessen unveränderlicher `MotionSegment` innerhalb seiner Gültigkeit; dieselben `position_at`-/`speed_at`-Funktionen des Betriebskerns |
| Laufweg, Station-/Bahnsteigintervalle und Signalbezüge | Zum selben InfraRelease gehörende, offline geprüfte Szenenreferenzen |
| Stationsname, Betriebsstellenart, Kategorie, Bahnsteigzahl und freigegebener Bedienumfang | SHA-gepinnte, rechtegeprüfte Infrastruktur-/Stationsquellen; unbekannte Kategorien bleiben unbekannt |
| Urbanität | Offline aus konkreten räumlichen Daten erzeugtes und gehashtes visuelles Profil; keine zur Laufzeit geschätzte Betriebsinformation |
| Tageszeit | Explizite Simulationszeit plus gepinnte lokale Tageszeitzuordnung der Welt |
| Bildmotive | Unabhängig freigegebener M15.3-Atlas unter dem Weltpin |

Die Stationsanreicherung aus M1.8 besitzt bereits `StationCategory` und
feldweise Herkunft. Das vorhandene öffentliche Karten-ReadModel führt
Stationsnamen und Identitäten, bietet aber noch keinen vollständigen
`urbanityBasisPoints`-Vertrag. Eine fertige Deutschlandkarte beweist daher
weder die vollständige M15.5-Anreicherung noch eine gültige Produktionsfreigabe.

Der Plattformdienst liest die Betriebsprojektion nach Welt-/EVU-/Zugprüfung
aus derselben committed Quelle wie LiveMap und RZÜ. Er prüft Periode,
Release- und Zustandspins und stellt nur einen tatsächlichen Zug bereit.
Browserparameter dürfen keine Betriebsprojektion, Geschwindigkeit,
Signalstellung, Ortskategorie, Urbanität oder Ortsnamen ersetzen.

## 2. SceneRelease als rein visuelle Ableitung

`ConductorSceneReleaseV1` verwendet `conductor-scene-release/v1`. Er enthält
`releaseId`, `infraReleaseId`, `infraReleaseHash`, `policyId`, `sources`,
`stations`, `routes`, `calendar` und `coverage: test-fixture | release-subset |
release-complete`. Die Kennzeichnung einer Testquelle wird niemals zu einer
Produktionsabdeckung hochgestuft. Ein SHA-256 über seine kanonische
Serialisierung bindet die gesamte Ableitung. Die eigentliche Welt-/Perioden-
und Artbindung kommt unabhängig aus dem serverseitigen Deployment.

Jeder Quellbeleg nennt `sourceId`, `sourceSha256`, `rightsEvidenceSha256` und
`provenance: observed | derived`. Eine Ableitung benennt ihre versionierte
Policy und die tatsächlich eingesetzten Quellhashes. Eine Stationskategorie
aus einer Annahme wird nicht als beobachtete Kategorie ausgegeben.
Ein visueller Urbanitätswert ist auch bei Verwendung beobachteter Geodaten
eine gekennzeichnete visuelle Ableitung und keine Dichtemessung oder
betriebliche Qualitätsklasse.

Ein Stationsdatensatz führt `operatingPointId`, vollständigen `name`,
`kind: station | halt`, optionale `category` von 1 bis 7, `platformCount`,
`dailyCalls`, `sourceIds` und bei bekannter Kategorie `categorySourceId`.
Die Kategoriequelle muss als beobachtet belegt sein. `dailyCalls` darf bei
bekannter Kategorie ausdrücklich `null` bleiben; die abgeleitete
Ersatzklassifikation verlangt dagegen einen belegten Bedienumfang. Der Bedienumfang ist eine
releasegebundene Klassifikationsgrundlage; er behauptet keine bereits
ausgeführten Zugfahrten.

Ein Laufwegprofil führt `routeVersionId`, `lengthMm`, eine geordnete Folge
`urbanity` aus `routeMm` und `urbanityBasisPoints`, örtliche
`sourceIds`, `stations` mit Betriebsstellenkennung, `platformId`, optionaler Bahnsteigbezeichnung und
`fromRouteMm`/`toRouteMm`, sowie `signals` mit `signalId` und `routeMm`.
Die Referenzen werden offline gegen denselben autoritativen InfraRelease
geprüft. Eine neue Laufwegversion verlangt ein passendes Profil; eine
unbekannte Umleitung verwendet kein altes Profil unter neuer Kennung.

Das Urbanitätsprofil deckt den vollständigen betreffenden Laufweg von
0 bis `lengthMm` ab. Stützpunkte sind eindeutig und streng aufsteigend;
alle Werte liegen zwischen 0 und 10.000. Zwischen zwei Punkten wird mit
Ganzzahlen linear interpoliert. Stations- und Signalreferenzen müssen
innerhalb desselben Laufwegs liegen. Fehlende Pflichtdaten schließen das
betroffene Profil; sie erzeugen keine Nullurbanität oder Ersatzstation.

`calendar` bindet `epochUtcTimeOfDayMs` (UTC-Tageszeit der Weltepoche,
0 bis 86.399.999 ms) und explizite
`offsets` aus `fromMs`, `untilMs` und `utcOffsetMinutes`. Die Zeitintervalle
sind eindeutig und lückenlos für den freigegebenen Periodenscope. Sommerzeit
oder ein anderer lokaler Tagesbeginn werden damit ohne Systemuhr und ohne
veränderliche Zeitzonendatenbank nachvollziehbar. Diese Daten sind
Weltkalenderdaten, keine vom Browser gemeldete Uhrzeit.
Die lokale Tageszeit ist die euklidische Modulo-Summe aus Weltepoche,
Simulationszeit und dem genau einmal angewendeten UTC-Offset.

`validate_scene_release_infrastructure` prüft offline die Releasekennung,
Laufweglängen, tatsächlichen Plattformintervalle und Signalbezüge gegen den
unveränderten `OperationalInfraRelease`. Ein Plattformintervall muss exakt
zum referenzierten Kantenintervall passen. Ein Signal muss zu einer
Fahrstraßenvorlage derselben Laufwegvorlage und deren Beginn gehören. Hash-
und Rechtefreigabe der Quelldateien bleiben unabhängige Compiler-/Deployment-
Eingänge; diese Prüffunktion erteilt selbst keine Freigabe.

### 2.1 Offline-Produzent und echte Quellenauswahl

`tools/conductor-scenes/source-compiler.mjs` übernimmt die bestehenden
InfraGO-/OpenStation-Adapterausgaben und den unveränderten BKG-Einwohnerimport.
`buildSceneSourceCatalog` verknüpft Stationen ausschließlich über gemeinsame
RL100-Kennungen. Mehrdeutige Stationsbezüge, fehlende Kategorien oder fehlende
Plattforminventare werden im Ausschlussbericht genannt; Namensähnlichkeit ist
kein Ersatzschlüssel. Das erzeugte `conductor-scene-source-catalog/v1` ist
eine überprüfbare Zwischenstufe, noch kein operativer Release.

`compileSceneRelease` erhält zusätzlich den vollständigen tatsächlichen
Operational-InfraRelease, dessen unabhängig erwarteten Bytehash, explizite
Station-/Plattformzuordnungen und den Weltkalender. Es übernimmt ausschließlich
vorhandene Laufwegversionen und Plattformintervalle. Fehlt diese Bindung,
bleibt nur der Quellenkatalog auslieferbar; der Compiler konstruiert weder
eine fiktive Gleisgeometrie noch eine Fahrstraße aus Ortsnamen.
Der Dateihash prüft die ursprünglichen Eingangsbytes. `infraReleaseHash`
trägt dagegen den vorhandenen kanonischen `operational-infrastructure-v2`-
Zustandshash aus `operationalInfrastructureV2StateHash`; genau diesen Wert
restauriert die Betriebsplattform aus ihrer Infrastrukturbindung. Die beiden
Hasharten sind getrennt und werden nicht gegeneinander ausgetauscht.

Die Policy `conductor-urbanity-population/v1` ist ein grobes visuelles Modell
aus Ortskernkoordinaten und Einwohnerzahlen: Radius je Ort
`clamp(isqrt(Einwohner)*15, 500, 12000)` Meter, Mittelpunktgewicht
`min(10000, isqrt(Einwohner)*70)` Basispunkte, linear bis Radius null. Das
Maximum der Ortsbeiträge ergibt die Urbanität. Entfernungen verwenden eine
ausdrücklich grobe, ganzzahlige Deutschlandprojektion mit 11.132 mm je
E7-Breiteneinheit und Faktor 0,61 für die Länge. Diese Distanz ist keine
betriebliche Vermessung. Ein Profil wird alle 100.000 mm und an allen
Geometriestützpunkten aus der tatsächlichen Laufweggeometrie abgetastet.
Die BKG-Auswahl muss den geprüften Routenscope mit mindestens 12 km Rand
vollständig abdecken; fehlende Gemeinden sind keine unbewohnte Fläche.

Damit werden keine feinräumigen Siedlungsgrenzen, Ortsgebietszugehörigkeiten,
Gebäudezahlen oder tatsächlichen Beleuchtungen behauptet. Ein späterer
Flächendatenproduzent benötigt eine neue versionierte Policy und einen neuen
Releasehash. Ursprüngliche Geodaten und die Ableitung behalten ihre getrennten
Attributionen; das Spiel arbeitet ausschließlich mit dem fertigen lokalen
Release.

## 3. Öffentliche Projektion und Zeitgrenze

Die reine Rust-Crate `zugfolge-conductor-scenes` exportiert
`project_conductor_scene` und `project_conductor_scene_json`.
`ProjectConductorSceneInputV1` enthält `schemaVersion`, `binding`,
`sceneRelease`, die tatsächliche `operational`-Projektion und `sampleAtMs`.
Das Eingangsschema heißt `conductor-scene-input/v1`.

`ConductorSceneBindingV1` führt `worldId`, `periodId`, `operatorId`,
`trainRunId`, `regionId`, `infraReleaseId`, `infraReleaseHash`,
`sceneReleaseHash`, `artReleaseId`, `artManifestHash`,
`operationalStateHash`, `commitSequence`, `validFromMs` und `validUntilMs`.
Der Zustandshash authentifiziert sich nicht selbst: Seine native
Verifikation und Kontozugriffsprüfung gehören an die Plattformgrenze.

`sampleAtMs` darf nicht vor dem committed Projektionszeitpunkt und nicht
außerhalb dessen `staleAfterMs`, des Periodenintervalls oder eines vorhandenen
Bewegungssegments liegen. Bei Bewegung werden Position und Geschwindigkeit
direkt mit den unveränderten Betriebskernmethoden berechnet. Der veröffentlichte
Segmentzustand muss mit den gespeicherten Position-/Geschwindigkeitswerten
am Segmentanfang übereinstimmen. Diese diskreten Werte werden vom Betriebskern
erst beim nächsten Segmentende materialisiert; sie sind keine zweite Messung
am aktuellen Projektionszeitpunkt. Die aktuelle Position und Geschwindigkeit
kommen deshalb auch innerhalb eines bereits laufenden Segments ausschließlich
aus `position_at(sampleAtMs)` und `speed_at(sampleAtMs)`. Es gibt keinen zweiten
Beschleunigungsansatz.

Im bestätigten Stillstand bleiben Routeposition und Scrollphase unverändert.
Zeitabhängige Beleuchtung darf sich trotzdem ändern. `standing`, `moving`
und `safe-stop` werden aus dem tatsächlichen Zustand übernommen. Eine
positive Geschwindigkeit ohne passenden Bewegungsabschnitt ist ein Fehler.
Ein fehlendes, widersprüchliches oder abgelaufenes Zeugnis liefert keine neue
Tatsachenszene. Die spätere Oberfläche friert ihren letzten gültigen Stand
mit erkennbarer Unsicherheit ein, statt weiterzufahren.

`SceneProjectionV1` verwendet `conductor-scene-projection/v1` und enthält
die Bindung, `atMs`, `routeVersionId`, `routeMm`, `speedMmps`, `motionState`,
`environment`, `lighting`, optional `station`, sichtbare `signals` und
`stateHash`. Der Hash bindet sämtliche Felder mit leerem `stateHash` in der
festen Rust-Feldfolge; mengenartige Eingänge werden vor der Verwendung
kanonisch nach Kennung geordnet. Identische Eingänge liefern identische Bytes.

Die Ausgabe ist ausdrücklich `visualOnly: true`. Sie enthält keine
Fahrberechtigung, Konfliktfreigabe, Trassenentscheidung, Stehplatzzahl oder
abgeleitete Ankunftsquittung. Der Compiler darf visuelle Ableitungen nicht
zurück in das Operational-Modell schreiben. Auch eine plausible Szene bleibt
eine Ansicht; ein tatsächlicher Signalbegriff stammt allein aus dem Stellwerk.

## 4. Kontinuierliche Mischung und Tageszeit

Für `u = urbanityBasisPoints` gelten die ganzzahligen Gewichte:

- Umland: `max(0, 10000 - 2*u)`;
- Stadt: `max(0, 2*u - 10000)`;
- Vorstadt: `10000 - Umland - Stadt`.

Die Summe ist immer 10.000. Am Mittelpunkt besteht ausschließlich Vorstadt;
es gibt keinen sprunghaften Kategorienwechsel. Die Darstellung mischt
dieselben freigegebenen Vegetations-, Straßen- und Gebäudemotive über diese
Gewichte. Alle drei Familientypen bleiben räumlich am tatsächlichen
Laufwegfortschritt verankert. Eine monotone Routeposition erzeugt monotone
Umgebungsverschiebung; tatsächlicher Stillstand verschiebt keinen Pixel.
Eine Umlaufanimation ohne Fortschritt des Zuges ist unzulässig.

`conductor-scene-lighting/v1` ist eine ausdrücklich generische
Beleuchtungspolicy: Nacht vor 06:00 und ab 20:00 lokaler Weltzeit,
Dämmerung 06:00–08:00 und 18:00–20:00, Tag dazwischen. Die Helligkeit
wechselt kontinuierlich zwischen 2.500 und 10.000 Basispunkten; beleuchtete
Fenster verwenden das Gegenstück zur Tageshelligkeit. Diese Gestaltung
behauptet keinen astronomischen Sonnenaufgang. Wetter und reale
Gebäudebeleuchtungszustände sind nicht Bestandteil von M15.5.

## 5. StationSceneV1 und Signalbilder

Die bekannte, freigegebene Bahnhofskategorie bestimmt ausschließlich die
Größenklasse: 1–2 `large`, 3–5 `medium`, 6–7 `small`.
Fehlt diese Kategorie, gilt die offen benannte visuelle Policy
`conductor-station-derived/v1`: mindestens acht Bahnsteige oder mindestens
300 tägliche Bedienungen ergeben `large`; ein Haltepunkt mit höchstens zwei
Bahnsteigen und höchstens 96 Bedienungen ergibt `small`; alle übrigen
vollständigen Datensätze ergeben `medium`. Das Ergebnis trägt dann
`classificationProvenance: derived`; die fehlende Kategorie bleibt `null`.
Diese Schwellen sind versionierte visuelle Spielregeln und keine neue
amtliche Bahnhofskategorie.

`StationSceneV1` enthält Betriebsstellenkennung, unveränderten Namen,
Bahnsteigtext, Größenklasse, Klassifikationsherkunft, stabile visuelle
`variant`, Sichtbarkeitsgewicht und die zugehörigen Modulkennungen.
Die Variantenwahl verwendet einen getrennten SHA-256-Teilstrom aus
Releasekennung und Betriebsstellenkennung. Sie verändert weder Namen noch
Stationseigenschaften. Wiederverwendete Grafikmodule sind zulässig;
eine Variantenkennung behauptet keine zusätzliche einzigartige Bilddatei.

Die Pflichtmodule sind `station.{small,medium,large}.{platform,roof,hall,
stairs,underpass}`. Eine fehlende Modulkennung erzeugt keine Ersatzgrafik.
Das Aussehen ist generisch; ausschließlich der vollständige Stationsname
stellt eine ortsspezifische grafische Identität her. Die Bahnsteigbezeichnung
ist gesonderter betrieblicher Text. Name und Umlaute bleiben als Text erhalten;
sie werden nie in die Rasterdatei geschrieben oder auf ein festes Zeichenlimit
gekürzt. Schmale Ansichten erlauben mehrzeilige Beschriftung.

Stationen erscheinen anhand ihrer tatsächlichen Laufwegintervalle mit einer
linearen Ein-/Ausblendzone von 100.000 mm. Bei Überlappung entscheidet die
Nähe zum Intervall, danach die stabile Betriebsstellenkennung. Eine sichtbare
Station und Geschwindigkeit null beschreiben einen Halt dort; sie behaupten
ohne entsprechenden Betriebsbeleg keinen konkreten Halteanlass.

Signalreferenzen innerhalb der nächsten 200.000 mm lesen ihren Begriff
ausschließlich aus `operational.signals`. `stop` und `proceed` wählen die
gleichnamigen freigegebenen Assets. `failed` und `shunting-proceed` bleiben
eigene textlich benannte Zustände ohne erfundenes Ersatzsignalbild.
Die Betriebsengine führt ihre Signalmap ausdrücklich dünn besetzt: Für ein
gegen den InfraRelease geprüftes Signal bedeutet ein fehlender dynamischer
Eintrag den statischen Grundzustand `stop`. Dies ist die unveränderte
Operational-Regel. Eine unbekannte Signalreferenz scheitert bereits an der
Infra-Prüfung; sie wird nicht durch diese Regel legitimiert. Kein Signalbild
ist bedienbar oder erteilt ein Fahrrecht.

## 6. Gepinnte Plattformkonfiguration

`loadConductorSceneDeployment({path, expectedSha256, worldId, runtime})`
lädt ausschließlich ein vom Betreiber unabhängig gepinntes lokales
`conductor-scene-deployment/v1`-Dokument. Es enthält `worldId` und `periods`.
Jede Periode führt `periodId`, das halboffene Millisekundenintervall
`validFromMs`/`validUntilMs`, `artReleaseId`, `artManifestHash` und `regions`.
Jede Region bindet `regionId`, `infraReleaseId`, `infraReleaseHash`, den
absoluten lokalen `sceneReleasePath`, `sceneFileSha256` über die Originalbytes
und `sceneReleaseHash` aus dem unveränderten nativen Hashverfahren.
Perioden überlappen sich nicht; Regionen sind je Periode eindeutig.

Der Loader prüft die unabhängig erwarteten Konfigurationsbytes, anschließend
Dateigrenzen, UTF-8, das vollständige Schema, Originaldateihash, nativen
Releasehash, ursprüngliche Infrastrukturbindung und die Zeitabdeckung.
Externe URLs, Netzwerkpfade, Pfadaufstiege, Symlinks und fehlende Dateien
scheitern geschlossen. Er erzeugt keine Freigaben und übernimmt keine
Vertrauenskonfiguration aus dem Browser. `test-fixture` ist standardmäßig
unzulässig; ausschließlich ein expliziter lokaler Test-Caller darf
`allowTestFixtures: true` übergeben. Dies ist kein Deploymentfeld.

Die Abfrage `period(worldId, periodId, regionId, nowMs, infraReleaseId,
infraReleaseHash)` liefert nur eine exakt passende Kopie. Welt und EVU
stammen aus der autorisierten Sitzung, die aktuelle Periode aus der
gepinnten Serverkonfiguration; Region, Infrastruktur, Commitnummer,
Zugposition und Zeit stammen aus dem restaurierten Betriebscheckpoint.
Der HTTP-Handler darf diese Werte nicht durch Browserparameter ersetzen.
Ein Szenenrelease für eine andere Infrastruktur wird auch dann nicht
umgebunden, wenn einzelne Stations- oder Streckennamen übereinstimmen.

`ConductorSceneRuntime.project` führt ausschließlich den nativen Export
`projectConductorScene` aus; `releaseHash` verwendet
`hashConductorSceneRelease`. Die TypeScript-Grenze akzeptiert nur die genaue
öffentliche Whitelist und prüft Ergebnisintegrität, Mischgewichtssummen,
Zeit, Laufweg und sämtliche Eingangsbindungen. Rohfehler, Pfade und
zusätzliche private Felder gelangen nicht in die öffentliche Szene.

## 7. Abnahme und bislang offene Datenabdeckung

Die Tests müssen reale Kernbewegung, Stillstand, Signalbegriffe, Replay und
Restore mit der Szene verbinden. Positive Betriebsprojektionen werden durch
den tatsächlichen `OperationalWorld` erzeugt, nicht als handgeschriebene
Zeitreihe. Kleine, mittlere und große Stationen, lange Namen/Umlaute,
kontinuierliche Mischgewichte, Beleuchtungsgrenzen sowie fremde Welt,
Periode, Release, Zug und veraltete Bewegungssegmente sind eigene Fälle.

Der öffentliche Testkorpus darf ausdrücklich fiktive Spielorte und
Szenenprofile verwenden. Dies beweist die echte Native-/Renderintegration,
aber keine Deutschlandabdeckung. Soweit konkrete reale freigegebene lokale
Quellen vorliegen, werden deren Hashes und der tatsächlich verwendete
Offline-Ableitungsweg zusätzlich nachgewiesen.

[M14.2](https://github.com/larynxberlin-rgb/Zugfolge/issues/193) bleibt eine
explizite Voraussetzung vollständiger Stations-/Umgebungsabdeckung. Der
[Readiness-Bericht 2026.4](infrarelease-deutschland-2026.4-readiness.md)
beschreibt einen signierten und lokal qualifizierten Deutschland-Kandidaten,
keine vollständig abgeschlossene Produktionsaktivierung. Fehlende lokale
Quellbytes oder Releasefreigaben werden nicht durch behauptete Messdaten,
geratene Stationswerte oder neue Vertrauensschlüssel ersetzt.

Der konkrete [Quellenbeleg und Offline-Produzent](../tools/conductor-scenes/README.md)
enthält neun tatsächlich verknüpfte Betriebsstellen und 112 Gemeinden in
einem ausdrücklich begrenzten Ausschnitt. Originaldateihashes und
freigegebene Quellen werden mitgeführt. Ein originaler produktiver
`OperationalInfraRelease` ist lokal weiterhin nicht an diesen Ausschnitt
angehängt; dieser offene Anschluss wird als `operationalReleaseAttached:
false` ausgewiesen. Die getrennten nativen Integrationstests verwenden
echte `OperationalWorld`-Bewegung auf ausdrücklich fiktiver Infrastruktur.

Ausgeführt sind drei Rust-Tests einschließlich der 10.001 möglichen
Urbanitätswerte, tatsächlicher Halt-/Signalbewegung und Restore, vier
Offline-Compiler-Tests sowie fünf TypeScript-Transporttests und drei
Deploymenttests. Der Native-Transporttest verwendet lokal
`ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY` für `scene_json`; im bestehenden
Linux-ABI-Job verwendet er alternativ `ZUGFOLGE_RUNTIME_NATIVE_PATH`.
Die eingecheckten Transportdaten stammen aus `scene_fixture_json` und
`scene_json`, nicht aus einer handgeschriebenen positiven Betriebszeitreihe.
