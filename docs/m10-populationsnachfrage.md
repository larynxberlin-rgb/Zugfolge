# M10.5 – Einwohnerbasierte Stationsnachfrage

Status: implementierte Spezifikation v1 zu #173. Der Nutzerauftrag vom 06.09.2026 ersetzt die bisherige Abnahme anhand gemessener SPNV-/SPFV-Holdouts durch eine ausdrücklich ungefähre, einwohnerbasierte Nachfrage. Historische Kalibrierberichte bleiben unverändert als Diagnose erhalten.

## Fachlicher Vertrag

Ortsbevölkerung bildet das Nachfragebudget. Bahnhöfe und Haltepunkte erhalten Anteile der Bevölkerung ihres Einzugsgebiets. Mehrere Stationen dürfen dieselben Einwohner nicht vervielfachen. Tagesquoten, Reisezwecke, Tagesgang und Saison des gemeinsamen Nachfragekerns bleiben wirksam. Beide Verkehrsarten konkurrieren um denselben Nachfragepool.

`DemandReleaseV1.populationModel` ist optional und trägt `schemaVersion: zugfolge-station-population-demand/v1`. Ohne dieses Feld bleiben Verhalten und kanonische Hashes bestehender Releases erhalten. Das Modell ist ausschließlich `balanced`: Einwohner sind Quellenfakten, Einzugsgebiete, Reisequoten und Wunschziele Modellannahmen.

Der Modellblock enthält `settlements` mit `id`, `name`, `population`, `sourceId`; `stationAreas` mit `zoneId`, `stationId`, `populationAllocations` (`settlementId`, `population`) und `demandClass`; `referenceTimetable` mit `id`, `artifactSha256`, `sourceIds`, `serviceDates`; sowie gerichtete `destinationPreferences` mit `originZoneId`, `destinationZoneId`, `referenceConnections`. Alle Quellen müssen im Release enthalten und rechtegeprüft sein. Die Listen werden kanonisch sortiert; doppelte oder fremde Verweise sind ungültig.

Jeder Ort verteilt seine Bevölkerung vollständig und genau einmal innerhalb des Releases. Jede Stationszone enthält genau eine bestehende Stationskennung; ihre Einwohnerzahl entspricht der Summe ihrer Zuteilungen. Die Stationskennungen sind eindeutig. Ein Importbericht weist zusätzlich nicht erfasste Orte aus. Ein begrenzter regionaler Release ist keine deutschlandweite Vollabdeckung; spätere parallele Pools benötigen eine übergreifende Prüfung gegen Doppelzählung.

Die nativen Grenzen betragen 200 Stationszonen, 20.000 Orte, 40.000 Einwohnerzuteilungen und 39.800 gerichtete Zielpräferenzen. Das Modell verlangt genau sieben unterschiedliche, gültige und aufeinanderfolgende ISO-Verkehrstage. Die vorhandenen Laufzeitgrenzen von 100.000 Reisenden und einer Million Suchschritten bleiben erhalten.

## Import und Einzugsgebiete

Der [Offline-Importer](../tools/population-demand/README.md) verbindet amtliche BKG-Ortsmittelpunkte mit explizit ausgewählten Original-GTFS-Stationskennungen. Die ausgewählten Gemeinden und Stationen, ein Radius und sieben Referenztage sind Konfiguration mit Inhaltsbindung. Eine Gemeinde ist kein behaupteter feinräumiger Wohnstandort. Das v1-Distanzproxy verwendet ausschließlich ganze Zahlen: `dx = abs(deltaLongitudeE7) × 7000 / 1000` mm, `dy = abs(deltaLatitudeE7) × 11132 / 1000` mm, jeweils abgerundet; Distanz ist die ganzzahlige Quadratwurzel aus `dx² + dy²`. Das ist eine Näherung für Deutschland, keine Routingentfernung.

Innerhalb des gepinnten Radius gilt `Gewicht = max(1, RadiusMm − DistanzMm)`. Die vollständige Bevölkerung eines Orts wird nach diesen Gewichten mit größtem Rest verteilt, bei Gleichstand nach Stationskennung. Ohne erreichbare Station wird der Ort vollständig ausgeschlossen und im Abdeckungsbericht genannt. Bereits bestehende Zugfrequenzen verändern diese Bevölkerungszuteilung nicht. Administrative Zugehörigkeit wird aus der räumlichen Nähe nicht abgeleitet.

Der reale regionale Nachweis verwendet zwölf Stationen, acht erfasste Gemeinden und 1.245.193 Einwohner; 10.007 Einwohner aus Querfurt sind wegen fehlender Station im gewählten Radius ausdrücklich nicht erfasst. Leipzigs 611.850 Einwohner werden einmal auf Hbf, tiefen Bahnhof und Messe verteilt. Die Quellenfreigaben und vollständigen Namensnennungen stehen in [M10-Populationsquellen](m10-populationsquellen.md).

## Nachfrageklassen

`StationDemandClass` ist eine eigene Größenklasse von 0 bis 10, unabhängig von der Infrastrukturkategorie. Klasse 0 bezeichnet null zugeteilte Einwohner. Die unteren Einwohnergrenzen der Klassen 1 bis 10 sind 1, 1.000, 2.500, 5.000, 10.000, 25.000, 50.000, 100.000, 250.000 und 500.000. Die Klasse wird aus dem zugeteilten Budget abgeleitet und vergrößert es nicht nochmals. Die Anzeige nennt Klasse, Einwohnerbasis und den Schätzcharakter.

## Wunschziele und bestehende Verbindungen

Der Import pinnt einen datierten, frei nutzbaren Referenzfahrplan. Eine gerichtete Direktverbindung wird je eindeutiger Quellfahrt und Verkehrstag höchstens einmal gezählt, unabhängig von Teilsegmenten oder wiederholten Halten. SPNV und SPFV dürfen gemeinsam Belege liefern. Fahrten nach 24 Uhr bleiben ihrem GTFS-Verkehrstag zugeordnet. Umstiege bewertet weiterhin der bestehende Verbindungssucher; v1 behauptet keine beobachteten Umsteigeströme.

Für ein anderes Ziel gilt im neuen Rust-Pfad:

```text
Zielgewicht = max(1, bisherige profilbezogene Zielattraktivität)
              × (10.000 + min(30.000, referenceConnections × 250))
```

`referenceConnections` ist die Summe über die explizit gepinnten Verkehrstage; der Import verwendet für vergleichbare Releases sieben aufeinanderfolgende Tage. Der Bonus ist maximal Faktor vier. Auch Ziele ohne bestehende Direktverbindung behalten positives Gewicht. Die bisherige ganzzahlige Größte-Reste-Verteilung erhält die erzeugte Gesamtmenge. Gewichte, Summen und Produkte verwenden `u128`. Die häufigsten Wunschziele werden aus den tatsächlich erzeugten Kohorten aggregiert, nicht durch einen zweiten TypeScript-Nachfragekern berechnet.

Aktuelle Spielerangebote beeinflussen Verbindungswahl, Kapazität und Bedienung, niemals dieses gepinnte exogene Budget oder die Zielpräferenzen. Eine neue Referenzgrundlage benötigt einen neuen Releasehash. Welt, Periode, Seed, Restore, Angebotsrevision und begonnene Teilreisen behalten ihre bestehenden Bindungen.

## Plattform und Anzeige

Der unveränderte Produktionsweg lädt das SHA-256-gepinnte `zugfolge-demand-deployment/v1`, wertet dessen Release im nativen Kern aus und persistiert ihn im privaten Weltjournal. `DemandService` prüft die Stationskennungen zusätzlich gegen genau die aktive Planungsinfrastruktur. Andere Releases derselben Welt dürfen weder Koordinaten noch Stationsnamen überschreiben. GTFS liefert hier ausschließlich die Referenzpräferenzen; es erzeugt keinen aktiven Spielzug.

## Direkte Datenpflege in Odoo

Die ergänzte ausdrückliche Nutzerentscheidung vom 06.09.2026 verlangt direkt editierbare Datenbankinhalte. Die Odoo-Administration speichert Einwohnerzahlen, Orts-/Stationsanteile und gerichtete Verbindungswerte in normalen Tabellen. Speichern überträgt die Änderung automatisch über die bestehende signierte Bridge. Es gibt weder einen manuellen Releaseexport noch eine Freigabe oder einen Periodenwechsel als Voraussetzung. Nachfrageklassen werden aus der wirksamen Einwohnerbasis berechnet. Originalwerte und Änderungshistorie bleiben nachvollziehbar; korrigierte Zahlen sind keine neuen amtlichen Messwerte.

`demand.data.update` (`zugfolge-demand-data-update/v1`) bindet `worldId`, `baseReleaseId`, monotone `sourceRevision`, `populationModel` und abgeleitete `zonePopulations`. Der vorhandene HMAC-/Akteurs-/Weltzugang begrenzt die Übertragung; die direkte Bearbeitung bleibt der bestehenden Odoo-Adminrolle vorbehalten. Speicherung und automatische Übertragungsbelege sind atomar, Wiederholung verwendet denselben Inhalt. Fehler bleiben in der Datenpflegemaske sichtbar und wiederholbar.

Der Game-Prozess validiert die Zahlen mit dem echten Rust-Kern und übernimmt die Änderung automatisch am bestätigten Simulationsstand. Datenbankzugriffe bleiben außerhalb des Simulationskerns. Der interne optionale Input-/Resultblock `populationRevision` (`zugfolge-demand-population-revision/v1`) enthält `worldId`, `revision`, `effectiveAtMs`, `populationModel` und `zonePopulations`. Das ist ein automatischer Replaybeleg, kein Nutzerworkflow. Die ursprüngliche Releasebindung, Quell- und Stationsidentitäten, Referenztage, Profile und Tarifpolitik bleiben stabil.

Neue Zahlen wirken auf zukünftige Reisewünsche. Vor der Wirkzeit bereits gestellte Wünsche behalten ihre Ziele und Identitäten; begonnene Reisen behalten zusätzlich Plätze, Tarif und belegte Teilstrecke. Weitere Datenänderungen erhalten diese Vergangenheit ebenfalls. Gegenwart und Zukunft verwenden jeweils die zeitlich passende Datenrevision. Restore verarbeitet Datenkorrekturen zusammen mit Angebotsänderungen und Haltbelegen in ihrer bestätigten Reihenfolge. Je Pool werden höchstens 256 noch auszuwertende Datenstände gleichzeitig verarbeitet. Bei Rückstau bleibt die weitere Übertragung automatisch wiederholbar in der Queue; sie wird erst nach Aufholen des Consumers in das Weltjournal übernommen. Vor einem vollständig zukünftigen Erzeugungsfenster genügt der letzte frühere Datenstand.

`zugfolge-demand-overview/v1` ergänzt optional `populationBasis` und je Station `populationDemand`: Nachfrageklasse, zugeteilte Einwohner, geschätzte Reisen und höchstens fünf Wunschziele mit nativer Kohortenmenge und Zahl der Referenzdirektfahrten. Keine personenbezogenen Quellen, privaten Fahrgastschlüssel oder Tarifmerkmale werden veröffentlicht. Die bestehende Seitengrenze von 50 Stationen gilt weiter, auch unbediente Zugänge sind enthalten. Einsteiger bleiben getrennt ausgewiesen. Die Oberfläche nennt den Schätzcharakter, die Referenzwoche und freie Quellen samt Namensnennung und Lizenz.

## Abnahme

Ein reproduzierbarer Import mit amtlichen Einwohnern und freien SPNV-/SPFV-Referenzverbindungen muss einen gültigen Release und nachvollziehbare Klassen/Wunschziele erzeugen. Fachliche Tests prüfen Einwohnererhaltung, Mehrstationsorte, Klassenränder, Quellen- und Stationsbindung, gerichtete/deduplizierte Verbindungen, positive latente Ziele, fehlenden Spielerangebots-Feedback, Ganzzahllimits, Permutationen, Restore und unveränderte Altreleases. Der echte Rust-Kern und die API-/Kartenintegration müssen denselben Modellblock verwenden. Die bestehenden vier CI-Jobs bleiben erhalten.

Gemessene Tagesgänge, Streckenbelastungen und Umstiege werden dadurch nicht als empirisch bestätigt ausgegeben. Die bisherigen fehlgeschlagenen Holdout-Berichte bleiben Entwicklungsdiagnosen; sie sind keine Abnahmebedingung dieses geänderten Nutzerauftrags.

## Herkunft des Gestaltungsprinzips

Die offizielle Vorschau zu [ortsbasierter Nachfrage](https://forums.airlinesim.aero/t/feature-preview-location-based-demand/27370) beschreibt Bevölkerung und Reisequoten als Ausgangspunkt sowie Flughäfen als Zugänge. Für Zugfolge werden eigene, veröffentlichte Bahnparameter verwendet; keine fremden Nachfragewerte oder Algorithmen werden übernommen.
