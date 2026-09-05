# Freie Nachfragebeobachtungen, Vertrag v1

Dieses Paket enthält echte, getrennt lizenzierte Zähldaten. Es ist ein
Beobachtungspaket für die Entwicklung und keine behauptete bestandene
Deutschlandkalibrierung. Quellenrechte und Prüfsummen stehen in
`sources/manifest.json`; die datierte Rechteentscheidung steht im
`tools/guards/quellenregister.json`. Herkunft: `zugfolge:quelle=nvbw-fahrgastzaehlung-2025`,
`zugfolge:quelle=hvv-sbahn-fahrgastzahlen-2025`, `zugfolge:quelle=nahsh-querschnittsbesetzung`.

## Auswahl vor dem Modellvergleich

NVBW RE 7, Dienstag 14.01.2025 ist Training, Dienstag 21.01.2025 ist Holdout.
Die Auswahl erfolgt vor einem Modelllauf, anhand von Linie und Kalender,
ohne Prüfung oder Optimierung eines Modellfehlers. Beide Tage werden vollständig
aus dem gepinnten Halbjahresbestand gelesen. Die Beobachtungen sind auf
`Zählfahrt AFZS` begrenzt; `Fahrplanfahrt (mit Fahrgastzahl)` und `Zählfahrt RES`
werden mit Ausschlusszähler erhalten, aber nicht als direkte AFZS-Beobachtung benutzt.
Ein reines Messfahrtenprofil repräsentiert die gemessenen Fahrten, nicht automatisch
die ganze Linie. Der spätere Modellvergleich muss dieselbe Fahrtenmaske anwenden.

`daily_profile` summiert Einsteiger je Stunde für die gemessenen Fahrten.
`cross_section` summiert abgehende Besetzung je gerichteter Folge zweier
aufeinanderfolgender Stationen derselben Fahrt. Die letzte Station liefert
keinen Streckenabschnitt. Fehlende Werte bleiben fehlend und werden nie zu Null.
Original-Dezimalwerte werden exakt als ganzzahlige Zehntel verarbeitet; erst
die aggregierte Passagierzahl wird kaufmännisch auf ganze Personen gerundet.
Originalwerte, Quellzeilen und Stichprobenanzahl bleiben prüfbar. DHID und
Zugnummer sind Quellkennungen, keine erfundenen Weltkennungen.

Das JSON `observations.json` verwendet `zugfolge-demand-observation-pack/v1`.
Es enthält `observations` mit `id`, `split`, `sourceId`, `mode`, `metric`,
`provenance`, `observedPassengers`, `observedPassengerTenths` und räumlicher/
zeitlicher `scope`. `sampleRows` referenzieren die Auswahlzeilen. Das Feld
`simulatedPassengers` wird absichtlich nicht erzeugt: Es muss aus einem
releasegebundenen nativen Modelllauf mit identischer Raum-/Zeit-/Fahrtenmaske kommen.

Die Nutzung der Daten in der Simulation erfordert außerdem eine überprüfte
DHID-zu-InfraRelease-Zuordnung, passende Verkehrsangebote und getrennte
Kalibrierparameter. Beobachtete Ein-/Aussteiger liefern keine eindeutige OD-Matrix.
Umstiege lassen sich daraus nicht als beobachtete Zahl rekonstruieren.

## Reproduktion

Mit Python 3 (Standardbibliothek, kein Netzzugriff):

```sh
python tools/demand-calibration/build_observations.py
```

Optional kann mit `--nvbw-original /pfad/2025_1.HJ_20241215-20250614.csv.gz`
der gesamte gepinnte Originalbestand erneut geprüft und die Auswahldatei
neu erzeugt werden. Der Download-URL steht im Manifest; der vollständige
457-MB-Bestand gehört in einen lokalen Cache, nicht in Git. Jede Hashabweichung
bricht die Verarbeitung ab. Ausgabe und Auswahl sind deterministisch.

Die unveränderten kleinen hvv-/NAH.SH-Originale dienen weiteren eigenständigen
Stations-/Jahresprüfungen. Sie werden nicht still in das AFZS-Profil gemischt.
Das Vollabnahme-Gate `zugfolge-demand-calibration/v1` bleibt streng: SPNV und
SPFV brauchen jeweils unabhängige Tagesprofil-, Querschnitts- und
Umstiegsbeobachtungen. Der Quellenbericht erklärt die noch fehlende Abdeckung.

## Native Vergleichsrechnung v1

`run_native.py --binary /absolut/evaluate_json` verwendet den echten Rust-Kern.
Die Schätzregel wird vor dem Holdout-Vergleich festgelegt: je Station werden
Einsteiger und Aussteiger ausschließlich aus AFZS-Training am 14.01.2025
übernommen und mit `alle Trainingshalte / gezählte Trainingshalte` auf die
Linie hochgerechnet. Einsteiger bilden die effektive nachfrageerzeugende
Zonenmasse im Feld `population`, Aussteiger die Zielattraktion im Feld
`workplaces`. Diese Felder sind hier bewusst balancierte Schätzparameter,
keine behaupteten Einwohner- oder Arbeitsplatzstatistiken. Stationen ohne
Trainingszählung erhalten Null Masse/Attraktion. Die konkrete OD-Verteilung
erzeugt der Kern aus diesen Marginalen; sie bleibt eine unvalidierte Hypothese.

Der Lauf verwendet je Tag das komplette tatsächlich ausgewählte RE7-Angebot.
Auch Fahrten mit imputierten Fahrgastzahlen dürfen ihr beobachtungsunabhängiges
Zeit-/Stationsangebot liefern; ihre Fahrgastzahlen gehen nicht in den Holdout ein.
Jeder DHID wird identisch in eine ausdrücklich isolierte Kalibrierwelt übernommen.
Die Daten enthalten auch Basel SBB/Bad Bf; das Gebiet ist daher ein
grenzüberschreitender RE7-Ausschnitt, keine reine Deutschland-Maske.

Nur Abfahrtszeiten sind verfügbar: Ankunft wird für diesen Vergleich auf dieselbe
Zeit gesetzt, Haltezeit Null. Sitzplätze sind die kleinste positive gemeldete
Ist-Sitzplatzzahl einer Fahrt (sonst Soll), unbekannte Stehplätze Null. Alle
Sitze werden als Standardklasse behandelt. Tarif Null, volle Modellzuverlässigkeit
und keine Umstiege/Alternativmodi isolieren den Nachfragemengenvergleich; sie
sind balancierte Annahmen, keine gemessenen Angebotsattribute. Stundengewichte
werden ausschließlich aus den AFZS-Trainingseinsteigern gebildet und mit
`alle Trainingshalte der Stunde / gezählte Trainingshalte der Stunde`
hochgerechnet. Fehlende Stunden erhalten kein erfundenes Volumen. Die
Gewichte werden per größtem Rest exakt auf 10.000 Basispunkte aufgeteilt;
innerhalb jeder Stunde sind die Abfahrtswünsche gleichverteilt. Alle 24
`generationWindows` werden in **einem** nativen Lauf mit gemeinsamer
Kapazitätsvergabe gerechnet. Getrennte, später aufsummierte Stundenläufe
wären fachlich falsch und werden nicht verwendet.

Die vor dem Vergleich festgelegte Diagnose-Toleranz beträgt pro Beobachtung
`max(20 Fahrgäste, 25 % des Beobachtungswerts)`. Sie ist eine Entwicklungsgrenze,
keine amtliche Qualitätsvorgabe. Der native Lauf wird zweimal ausgeführt und
auf denselben Ergebnishash geprüft. Das Ergebnis berichtet jede Abweichung
einschließlich Fehlern; es enthält keine volle M10.5-Freigabe. Holdout-Messwerte
werden erst nach abgeschlossener Parameterbildung zum Vergleich gelesen.

```sh
python -m unittest discover -s tools/demand-calibration -p 'test_*.py'
cargo build --release -p zugfolge-demand --example evaluate_json
python tools/demand-calibration/run_native.py --binary target/release/examples/evaluate_json
```

Unter Windows endet der Binarypfad auf `.exe`. Der gespeicherte
`native-report.json` weist für den Holdout 6/21 Stundenbeobachtungen und
31/105 Querschnitte innerhalb der Grenze aus; gewichtete absolute Fehler
52,20 % beziehungsweise 45,06 %. Der eingeschränkte Vergleich und die
Vollabnahme sind deshalb ausdrücklich nicht bestanden. Die vier tatsächlich
ausgeführten nativen Rechnungen (beide Tage plus jeweils ein Replay) und
ihre Hashbindungen sind im Bericht nachvollziehbar.

Alle erzeugten JSON-Dateien verwenden explizit UTF-8 ohne BOM und LF-Zeilenenden,
auch unter Windows. Die SHA-256 im Bericht beziehen sich auf diese gespeicherten
Bytes; ein Checkout unter Linux verändert sie nicht. Ein Regressionstest prüft
Parameter-, Eingabe- und Beobachtungshashes gegen die Rohbytes sowie das genaue
JSON-Ausgabeformat. Archivierte Dateien in `sources/` bleiben davon unberührt
und behalten durch `.gitattributes` ihre originalen Bytes.
