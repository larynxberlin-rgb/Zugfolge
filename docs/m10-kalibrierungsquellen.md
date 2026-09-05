# M10.5 — Frei nutzbare Kalibrierungsquellen

Recherche und tatsächlicher Datenabruf: **5. September 2026**. Das
[Quellenpaket](../tools/demand-calibration/README.md) enthält echte SPNV-Zählwerte,
Originaldateien, Lizenzbelege und einen reproduzierbaren Vergleich mit dem
Rust-Kern. Eine vollständige Abnahme von #173 wird damit nicht behauptet:
freie beobachtete SPFV-Stunden-/Abschnittsdaten und tatsächliche Umsteigeströme
sind noch nicht nachgewiesen. Fehlende Beobachtungen werden nicht erfunden.

## NVBW: SPNV-Zählfahrten mit Uhrzeit und Streckenlast

Die NVBW veröffentlicht halbjährliche Fahrgast-Zähldaten über MobiData BW
unter **Datenlizenz Deutschland – Namensnennung – Version 2.0**. Das Portal
beschreibt automatische Türzählung (AFZS), ergänzende manuelle Erfassung
(RES) und mögliche Zuordnungsfehler. Datensatz angelegt 10.02.2026, Metadaten
geändert 30.04.2026. Der abgerufene H1-Download meldet als Dateiänderung
21.08.2026; für die Reproduktion zählt der Bytehash.
[Offizieller Datensatz](https://mobidata-bw.de/dataset/automatische-fahrgast-zahldaten-baden-wurttemberg),
[Lizenztext](https://www.govdata.de/dl-de/by-2-0).

Der tatsächlich geladene
[`2025_1.HJ_20241215-20250614.csv.gz`](https://mobidata-bw.de/portal/opnv/afzs/2025_1.HJ_20241215-20250614.csv.gz)
hat **457.658.999 Bytes**, SHA-256
`74de5f8b36d8b9819d30cfc2a435cf26595bdae49d09c184375a2e45b6af63ff`.
Er enthält Datum, Tagtyp, Vertrag, Zugnummer, Linie, Stationsfolge,
Abfahrtszeit, Stationsname/DHID, Einsteiger, Aussteiger, abgehende Besetzung,
Ist-/Soll-Sitzplätze, Auslastung, Fahrgastzahlenart, Personenkilometer und
Zugkilometer. `Zählfahrt AFZS`, `Zählfahrt RES` und
`Fahrplanfahrt (mit Fahrgastzahl)` sind unterscheidbar.

Vor dem Modellvergleich wurde **RE 7**, **14.01.2025 Training** und
**21.01.2025 Holdout**, festgelegt. Die Auswahl umfasst 1.710 Quellzeilen
und 48 Stationskennungen, einschließlich Basel SBB/Bad Bf. Dieser reale
grenzüberschreitende Korridor ist keine deutschlandweite Stichprobe.

| Auswahl | AFZS-Zeilen | ergänzte Zeilen | gemessene Fahrten | ausgeschlossene Fahrten | Stundenwerte | Querschnitte |
|---|---:|---:|---:|---:|---:|---:|
| Training 14.01.2025 | 462 | 376 | 22 | 18 | 21 | 115 |
| Holdout 21.01.2025 | 247 | 625 | 12 | 30 | 21 | 105 |

Die 262 Beobachtungen verwenden ausschließlich vollständig als AFZS markierte
Fahrten. Stundenwerte summieren Einsteiger; Querschnitte summieren die
abgehende Besetzung zwischen aufeinanderfolgenden DHIDs derselben Fahrt.
Zehntelwerte bleiben exakt; gerundet wird erst das Aggregat. Die gezählten
Einsteiger summieren sich auf 16.046 im Training und 9.198 im Holdout.
Wegen der unterschiedlichen Messabdeckung ist das keine belastbare
Nachfragerückgangsquote. Der Modellvergleich muss dieselbe Messfahrtenmaske verwenden.

Originalzeilen- und Zugnummern stehen in
[`observations.json`](../tools/demand-calibration/observations.json).
Die Quellauswahl erhält alle gelieferten Spalten, ergänzt nur die
Originalzeilennummer und konvertiert Windows-1252 zu UTF-8. Der volle GZip
bleibt im Downloadcache; die Auswahl ist daraus hashgeprüft neu erzeugbar.
Es werden keine personenbezogenen Sensorrohdaten verarbeitet.

## Hamburg: durchschnittliche Stationswerte der S-Bahn

**hvv Fahrgastzahlen 2025**, veröffentlicht 02.06.2026: Die S-Bahn-XLSX wurde
tatsächlich geladen, **22.196 Bytes**, SHA-256
`b5657e0047e9e923151a8bb77ceea4a20291b6d5a2881071d949aa338220b85f`.
Lizenz **dl-de/by-2-0**, vorgeschriebene Namensnennung **Freie und Hansestadt
Hamburg**. Metadaten bestätigen freie Nutzung ausdrücklich.
[Quelle und Lizenz](https://suche.transparenz.hamburg.de/dataset/hvv-fahrgastzahlen-2025).

Die hochgerechneten durchschnittlichen Montag–Freitag-Tageswerte gelten je
Station, Linie und Richtung; die AFZS-Ausstattung beträgt laut Portal
mindestens 20 Prozent. Geprüftes Beispiel: Rissen/S1 Richtung Poppenbüttel,
2.762 Einsteiger und 527 Aussteiger (`Tabelle1!B7:C7`). Stationssummen sind
prüfbar, Tagesstunden, ODs und echte Umstiege daraus nicht ableitbar.
Bus, Fähre und U-Bahn werden nicht als EBO-SPNV übernommen.

## NAH.SH: historische Streckenquerschnitte

**Querschnittsbesetzung** ist laut offiziellem CKAN-Metadatum und GovData
unter **CC BY 4.0** nutzbar. Die geladene CSV hat **333.942 Bytes**, SHA-256
`f8a709bcc68fafd6489fa2ad9fbc657abc97aae0eb8cb6d9ef7975b6e85c48e1`:
13.343 Zeilen, 306 Abschnittskennungen, Jahre 2010–2019.
[Offizieller Datensatz](https://opendata.schleswig-holstein.de/dataset/querschnittsbesetzung),
[GovData-Lizenzbeleg](https://data.gov.de/suche/daten/querschnittsbesetzung?ids=2a6f7793-c174-4c2a-9c01-28f881f59ef1),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Die Werte mitteln stichprobenartige Zählungen über das Jahr, getrennt nach
Mo–Fr, Samstag, Sonntag/Feiertag und Mo–So. `np_str_id` braucht eine geprüfte
Zuordnung zum InfraRelease. Die Datei bleibt ein eigenständiger historischer
Querschnittsnachweis und wird nicht still mit der RE7-Erhebung vermischt.

## Destatis: nationale Größenordnung für SPNV und SPFV

Pressemitteilung Nr. 120 vom 08.04.2026 nennt für 2025 vorläufig
**2,8 Milliarden** Fahrgäste im Eisenbahnnahverkehr und **146 Millionen**
im Eisenbahnfernverkehr. Seit Q1 2025 ist der SPFV-Berichtskreis erweitert.
Beförderungsfälle sind keine eindeutigen Personen. Nationale Aggregate
belegen keine Tagesstunden oder Bahnhofsumstiege.
[Amtliche Pressemitteilung](https://www.destatis.de/DE/Presse/Pressemitteilungen/2026/04/PD26_120_461.html).

GENESIS 46181-0005 enthält Quartalswerte unter dl-de/by-2-0. Die aktuelle
öffentliche Tabelle nennt Q1 2025/Q1 2026 gerundet 674/670 Millionen SPNV-
und 33/31 Millionen SPFV-Fahrgäste. Der Berichtskreis änderte sich 2026
erneut. Der direkte API-Export ohne individuelle Zugangsdaten antwortete
bei diesem Abruf mit HTTP 401; ein exakter GENESIS-Rohdatenhash wird nicht behauptet.
[Amtliche Tabelle](https://www.destatis.de/DE/Themen/Branchen-Unternehmen/Transport-Verkehr/Personenverkehr/Tabellen/personenverkehr-pressemitteilung-halbjahr.html),
[GENESIS-Rechte](https://www.destatis.de/DE/Service/OpenData/genesis-api-webservice-oberflaeche.html),
[Destatis-Veröffentlichungsrechte](https://www.destatis.de/DE/Service/Impressum/_inhalt.html).

## Ausgeschlossene oder fachlich ungeeignete Kandidaten

| Kandidat | Ergebnis |
|---|---|
| [NVV MobileDataFusion](https://data.europa.eu/data/datasets/527118512982720512?locale=de) | Quell-Ziel-Matrizen interessant, aber GovData nennt [CC BY-NC 4.0](https://data.gov.de/suche?format=json&groups=tran&licence=http%3A%2F%2Fdcat-ap.de%2Fdef%2Flicenses%2Fcc-by-nc%2F4.0&openness=has_closed&sort=title_desc&type=dataset). Wegen der nichtkommerziellen Einschränkung nicht importiert. |
| [MiD 2023 Mikrodatensätze](https://www.mobilitaet-in-deutschland.de/pdf/MiD2023_Vortrag_Datennutzung.pdf) | BMV-Unterlage, Seite 10: kein Open Data; eingeschränkte Nutzungszwecke/Zugänge. Keine freie Spielnutzung unterstellt. |
| [UBA Klimatisierung von Zügen](https://www.umweltbundesamt.de/sites/default/files/medien/1410/publikationen/2019-10-14_texte_119-2019_klimatisierung-zuege.pdf) | Verweist auf historische ICE-T-Belegungsmatrizen. Publikationen grundsätzlich [CC BY-NC-ND](https://www.umweltbundesamt.de/datenschutz-haftung-urheberrecht); eindeutige freie Lizenz der zugrunde liegenden DB-Matrizen fehlt. Keine Übernahme. |
| [SBB Belegungsprognosen](https://opentransportdata.swiss/de/cookbook/realtime-prediction-cookbook/belegungsprognose/) | Prognosekategorien, keine beobachteten deutschen SPFV-Personenzahlen. Kein Mess-Holdout. |
| DB/DELFI GTFS, RIS Stations und Umsteigezeiten | Angebotsdaten und mögliche Wege messen keine tatsächlich umgestiegenen Personen. |

Einwohner-/Arbeitsplatzgewichte, modellierte OD-Matrizen und auf Stunden
verteilte Tageswerte können der Balance dienen, bleiben aber abgeleitete
Annahmen. Doppelt gezählte Ein-/Aussteiger identifizieren keinen konkreten Umstieg.

## Reproduktion und offene Abnahme

Das [Manifest](../tools/demand-calibration/sources/manifest.json) bindet kleine
Rohdateien und Metadaten bytegenau. Die Quellenrechte stehen datiert im
Register; Attribution und Änderungsvermerk begleiten die Daten unabhängig
von der Softwarelizenz. Die [Vergleichsspezifikation](../tools/demand-calibration/README.md)
beschreibt die nur aus Training geschätzten Zonenmarginalen und Stundengewichte
sowie vereinfachte Angebotsannahmen.

[`run_native.py`](../tools/demand-calibration/run_native.py) führt beide Tage
mit dem Rust-Kern und identischer Messfahrtenmaske aus, prüft den Replay und
schreibt jede Abweichung. Ein Verhaltenstest verändert alle Holdout-Zählwerte
und belegt, dass dies weder Modellparameter noch Eingangsangebot verändert.
Die Diagnosegrenze `max(20 Personen, 25 Prozent)` wird vor dem Vergleich gesetzt.
Fehlgeschlagene Beobachtungen und Rechenlimits bleiben sichtbar.

Die volle M10.5-Abnahme bleibt offen, bis alle sechs Kombinationen aus
SPNV/SPFV und Tagesprofil/Querschnitt/echtem Umstieg unabhängig beobachtet
und innerhalb begründeter Toleranzen durch den gemeinsamen Kern belegt sind.

## Tatsächlich ausgeführter nativer Vergleich

Der [native Bericht](../tools/demand-calibration/native-report.json) enthält
den vollständigen RE7-Ausschnitt mit 48 Stationen und 40 beziehungsweise
42 Fahrten. Das Trainingsmodell enthält 29.577 tägliche Einheiten effektiver
Zonenmasse, verteilt über 24 ausschließlich aus Training gewichtete Stunden.
Nach der ganzzahligen Erzeugung pro Zone und Stunde entstehen im Kern
je Tag 29.166 Reisende; diese Modellwerte sind keine beobachteten Tageszählungen.
Alle Stunden teilen sich eine einzige native Kapazitätsvergabe. Zwei
Wiederholungen liefern jeweils bitgleiche Ergebnisse. Eingaben, Parameter,
Quellartefakte, Evaluator-Binary und Ergebniszustände sind durch Hashes gebunden.

| Datensatz | Metrik | innerhalb der Diagnosegrenze | gewichteter absoluter Fehler |
|---|---|---:|---:|
| Training | Stundenweise Einsteiger | 7 / 21 | 39,94 % |
| Training | gerichtete Abschnittsbesetzung | 40 / 115 | 48,90 % |
| Holdout | Stundenweise Einsteiger | 6 / 21 | 52,20 % |
| Holdout | gerichtete Abschnittsbesetzung | 31 / 105 | 45,06 % |

Der gewichtete absolute Fehler ist `Summe absoluter Fehler / Summe der
Beobachtungswerte`, im Bericht auf ganze Basispunkte abgerundet. Die Summe
von Abschnittsbesetzungen zählt dieselbe Person auf mehreren Abschnitten;
sie ist keine Zahl eindeutiger Reisender. Alle Einzelabweichungen sind erhalten.

**Auch der eingeschränkte SPNV-Holdout ist nicht bestanden.** Die Schätzung
aus Ein-/Aussteigermarginalen identifiziert keine wirklichen OD-Ketten. Die
vereinfachten Annahmen zu Tarif, Stehplätzen und Haltezeiten erklären weitere
Modellgrenzen. Der Bericht setzt `spnvMeasuredSubsetAccepted=false` und
`fullM10CalibrationAccepted=false`. Es wurde kein Holdout-Zielwert als
Modellvorhersage übernommen und keine Toleranz nachträglich erweitert.

Der erste vollständige Rechenversuch erreichte die feste Suchgrenze.
Eine durch Äquivalenztests abgesicherte Kernoptimierung überspringt jetzt
nachweislich unmögliche Endhalte, sobald keine weiteren Umstiege zulässig
sind. Dadurch wurde derselbe vollständige Korpus innerhalb unveränderter
Suchgrenzen rechenbar; die Daten wurden nicht zur Ergebnisverbesserung verkleinert.
