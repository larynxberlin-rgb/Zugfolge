# M10.5 – Freie Quellen für Einwohner und Wunschziele

Der Nutzerauftrag vom 06.09.2026 ersetzt für #173 die empirische Kalibrierabnahme durch eine ausdrücklich ungefähre Nachfrage aus Einwohnern, Stationsklassen und bestehenden Verbindungen. Der [Modellvertrag](m10-populationsnachfrage.md) trennt amtliche Einwohnerfakten von eigenen Einzugsgebiets- und Reiseannahmen. Frühere Messreihen und ihre fehlgeschlagenen Holdout-Ergebnisse bleiben unverändert.

Die Quellenprüfung erfolgte am 06.09.2026 durch Codex im ausdrücklichen Nutzerauftrag, ausschließlich frei nutzbare Daten zu verwenden. Die Freigaben stehen im [Quellenregister](../tools/guards/quellenregister.json). Keine der folgenden Quellen benötigt einen Account, ein kostenpflichtiges Abo oder einen externen Dienst während der Simulation.

## Amtlicher Einwohnerbestand

Verwendet wird **BKG / Statistisches Bundesamt, Verwaltungsgebiete 1:250.000 mit Einwohnerzahlen (VG250-EW), Stand 31.12.2024**. Die [offizielle Produktseite](https://gdz.bkg.bund.de/index.php/default/verwaltungsgebiete-1-250-000-mit-einwohnerzahlen-stand-31-12-vg250-ew-31-12.html) nennt Deutschland als Abdeckung und **Datenlizenz Deutschland – Namensnennung 2.0** als freie Lizenz. Der Download ist auf das konkrete Jahr festgelegt, nicht auf `aktuell`.

- Quelle: [`bkg-vg250-ew-2024`](../tools/guards/quellenregister.json).
- Original: [Excel-ZIP 31.12.2024](https://daten.gdz.bkg.bund.de/produkte/vg/vg250-ew_ebenen_1231/2024/vg250-ew_12-31.ee.excel.ebenen.zip).
- ZIP-SHA-256: `d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3`.
- Enthaltenes XLSX: `vg250-ew_12-31.ee.excel.ebenen/vg250-ew_ebenen_1231/verwaltungsgebiete.xlsx`.
- XLSX-SHA-256: `dc5f921d312f696e6d18c768966c7cf45ca210c8d73dd7a6a3c8ed228c0dd9fc`.

Der [Standardbibliothek-Importer](../tools/population-demand/import_population.py) verbindet die Gemeindezeilen (`ADE=6`) aus `VGTB_ATT_VG` über den zwölfstelligen `ARS` mit den Ortskernpunkten aus `VG250_PK`. Er erhält achtstellige `AGS` einschließlich führender Nullen als `settlements[].id`. `EWZ` wird zur ganzzahligen Bevölkerung; `LON_DEZ` und `LAT_DEZ` werden mit dezimaler Rundung einmal in ganzzahlige E7-Koordinaten umgerechnet. Die [BKG-Dokumentation](https://sgx.geodatenzentrum.de/web_public/gdz/dokumentation/deu/vg250.pdf) erläutert diese Verwaltungsschlüssel, Tabellen und Ortskernpunkte.

Die reale Normalisierung erhält **10.956 Gemeinden beziehungsweise gemeindefreie Gebiete** mit **83.577.140 Einwohnern**. Alle Gemeindepunkte lassen sich eindeutig verbinden. 202 Gebiete besitzen ausdrücklich null Einwohner; ein fehlender, unbekannter oder negativer Wert wird abgewiesen und niemals durch null ersetzt. Beispielsweise enthält der Snapshot für Leipzig 611.850, Halle (Saale) 226.767 und Erfurt 218.793 Einwohner. Diese Zahlen stammen aus der tatsächlich gehashten Quelltabelle; sie sind keine Nachfrageparameter.

Das Ausgabeformat ist `zugfolge-settlement-population/v1`, mit Quellen-ID, URL, Lizenz, Originalhash, Rechtefreigabe, Referenzdatum und nach AGS sortierten Ortsfakten. Der Importer akzeptiert ausschließlich den geprüften Quellenpin. Eine beliebige Datei mit dazu passendem selbst gewählten Hash erhält keine amtliche Herkunft oder Rechtefreigabe. Eine neue Quellversion benötigt eine erneute explizite Quellen- und Schemaqualifizierung.

```sh
curl -L --fail -o vg250-ew-2024-excel.zip \
  https://daten.gdz.bkg.bund.de/produkte/vg/vg250-ew_ebenen_1231/2024/vg250-ew_12-31.ee.excel.ebenen.zip
python tools/population-demand/import_population.py \
  --input vg250-ew-2024-excel.zip --output population-2024.json \
  --expected-sha256 d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3
python -m unittest discover -s tools/population-demand -p test_import_population.py -v
```

Die kanonische vollständige JSON-Ausgabe des gezeigten Imports hat SHA-256 `46388da8822295a15df02c9fc11f04c54f15bbf4c4be5cc3879925b63c030fa6`. Das große vollständige Quellenarchiv und diese Arbeitsausgabe bleiben außerhalb des Git-Quelltextbestandes. Regionale Auswahl, Stationszuordnung und nachfolgende Modellableitungen sind gesonderte Pipeline-Schritte und ändern diesen Quellenhash nicht.

### Attribution und archivierter Lizenzbeleg

Die [BKG-Nutzungsbedingungen](https://sgx.geodatenzentrum.de/web_public/gdz/lizenz/deu/nutzungsbedingungen_vg250.pdf) gelten ausdrücklich für VG250 und VG250-EW ab Produktstand 31.12.2023. Die [Datenlizenz](https://www.govdata.de/dl-de/by-2-0) erlaubt kommerzielle Nutzung und Bearbeitung unter Namensnennung und verlangt die Kennzeichnung von Änderungen. Der Quellenvermerk muss bei öffentlicher Darstellung auch als solcher sichtbar sein; auf Webseiten werden BKG und Lizenz verlinkt.

Der mit den abgeleiteten Einwohnerdaten mitzuführende Vermerk lautet:

> © [BKG](https://www.bkg.bund.de) 2026 [dl-de/by-2-0](https://www.govdata.de/dl-de/by-2-0), [Datenquellen](https://sgx.geodatenzentrum.de/web_public/gdz/datenquellen/datenquellen_vg_nuts.pdf); Auswahl, Normalisierung und einwohnerbasierte Modellableitung durch Zugfolge.

Das unveränderte Original-ZIP archiviert seine Lizenz- und Herkunftsbelege selbst. Unter `vg250-ew_12-31.ee.excel.ebenen/dokumentation/` sind enthalten:

| Datei | SHA-256 |
|-------|---------|
| `nutzungsbedingungen_vg250.pdf` | `7bff83846fa104debbfa5ab57bfec353e3c0dbd26799b7c62047a2fad43e7a72` |
| `datenquellen_vg_nuts.pdf` | `09dadbbfe68d2b85a8c63adb3af266b8b35f133a40259e250b7b69e972bbf5ce` |
| `vg250.pdf` | `e16edf8be71ef0154f44f41bd3a651800aae247a8ba757f06aff5a3c8c32d7ef` |

Die allgemeine Lizenzfreigabe betrifft weder geschützte Fremdbeobachtungen noch eine Übernahme gesperrter Fahrplandaten. Unabhängig lizenzierte Einwohnerfakten behalten ihre eigene Herkunft auch dann, wenn der nachfolgende Modellbau sie mit Infrastruktur- oder GTFS-Kennungen verbindet.

### Räumliche Aussagegrenze

Ein Gemeindemittelpunkt beschreibt den Ortskern; er ist keine feine Verteilung aller Einwohner auf Ortsteile oder Rasterzellen. Der nächste Ortskern ist kein Beweis, dass eine Station administrativ zu dieser Gemeinde gehört. Einzugsgebiete, die Verteilung eines Ortes auf mehrere Stationen und die Anbindung von Orten ohne eigenen Bahnhof sind deshalb ausdrücklich gekennzeichnete Modellannahmen. Nicht einbezogene Orte müssen im Importbericht erscheinen. Ein Regionalbeispiel darf keine deutschlandweite Stationsabdeckung behaupten.

## Freie Referenzverbindungen

Die [offizielle Übersicht von GTFS.DE](https://gtfs.de/de/feeds/) stellt kostenlose statische Feeds mit etwa 30 Tagen Fahrplanhorizont bereit und verlinkt **CC BY 4.0**. Die Quelle liefert veröffentlichte Sollverbindungen, keine beobachteten Fahrgäste, Wunschziele oder Umstiegsströme. Für den Import gelten Attribution, konkrete ZIP- und Tabellenhashes, Abrufdatum und ein expliziter Satz aktiver Verkehrstage.

| Quellen-ID | Produkt und Abruf | SHA-256 des am 06.09.2026 geladenen ZIPs |
|------------|------------------|---------------------------------------|
| `gtfs-de-rv` | [Regionalverkehr](https://gtfs.de/de/feeds/de_rv/), [freies ZIP](https://download.gtfs.de/germany/rv_free/latest.zip) | `8ff77cb6bed7375d4cce5aa8f2027bfffe7e74bbc4bccd859237a96f2da24162` |
| `gtfs-de-fv` | [Fernverkehr](https://gtfs.de/de/feeds/de_fv/), [freies ZIP](https://download.gtfs.de/germany/fv_free/latest.zip) | `5e3efe3b3be69fb4bbbed0efc3fd8c2d8a0481c6a102a901ab1dc68219e45d40` |

Die frühere Regionalverkehrsfreigabe für den M1.13-Holdout wird um diesen ausdrücklich beauftragten Offline-Nachfragezweck erweitert. Der freie Fernverkehrsfeed erhält einen eigenen Registereintrag. Die Feedrolle beschreibt die Herkunft; sie beweist keine konkrete Zugcharakteristik oder Verkehrskategorie jeder enthaltenen Fahrt. Der Pipeline-Bericht muss Überschneidungen und ausgeschlossene Datensätze ausweisen. Ein `route_type` oder ein Linienname erteilt keine technische Freigabe für Fahrzeuge oder Infrastruktur.

Attribution: **Datenquelle: DELFI e.V. / GTFS.DE**, mit Link auf die jeweilige Produktseite und [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); **durch Zugfolge gefiltert, normalisiert und für ungefähre Zielpräferenzen ausgewertet**. Diese Lizenz erlaubt ausdrücklich auch kommerzielle Weitergabe und Bearbeitung. Neue Hashes von `latest.zip` benötigen einen neuen gepinnten Snapshot, keine stille Änderung eines bestehenden DemandRelease.

## Gestaltungsreferenz

Die [offizielle Dokumentation zur Aufkommensberechnung](https://handbook.airlinesim.aero/de/docs/advanced/bookings/demand/) beschreibt Nachfragebalken als ungefähre Größenordnung und trennt sie von exakten Streckenmengen. Die [offizielle Vorschau zur ortsbasierten Nachfrage](https://forums.airlinesim.aero/t/feature-preview-location-based-demand/27370) beschreibt Bevölkerung und Reisequoten als Ausgangspunkt sowie Verkehrsknoten als Zugänge zu diesen Orten. Sie kennzeichnet diesen Ansatz selbst als experimentell.

Diese Seiten sind ausschließlich eine vom Nutzer benannte Gestaltungsreferenz. Es werden weder fremde Nachfragewerte, Klassengrenzen, Tabellen, Programmcode, Texte, Bilder noch proprietäre Algorithmen importiert. Zugfolge definiert die zehn Stationsnachfrageklassen, die einwohnererhaltende Verteilung und den begrenzten Verbindungsbonus selbst im [eigenen Modellvertrag](m10-populationsnachfrage.md). Der Vergleich ersetzt weder die Quellenfreigabe noch eine empirische Messbestätigung.
