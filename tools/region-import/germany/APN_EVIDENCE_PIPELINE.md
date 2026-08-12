# Interne APN-Evidenzpipeline

Diese Pipeline erfasst und analysiert Bahnhofsskizzen ausschließlich als
internen, sekundären Validierungsbestand für den jährlichen Deutschlandlauf.
Die Nutzung wurde für das Projekt am 12. August 2026 ausdrücklich freigegeben;
das Rechte-Gate und die Erreichbarkeit werden trotzdem vor jedem Jahreslauf
erneut geprüft. Die Skizzen sind keine Laufzeitabhängigkeit und keine alleinige
Grundlage für Qualitätsklasse A.

## Harte Grenze zum Release

- PDF-Dateien, interne Metadaten, erkannter Text, Abrufadressen, Dateinamen und
  Dokumenthashes liegen nur in einer **absoluten Evidenzwurzel außerhalb des
  Git-Repositories**. Der Code verweigert eine Evidenzwurzel im Repository,
  auch wenn ein bestehender Pfad über einen Link dorthin zeigt.
- Die Rohdateien werden weder committed noch in `InfraCorpus`, `InfraRelease`,
  PMTiles oder eine Client-API übernommen.
- Ein automatisch erzeugter Validierungsbeleg hat immer `status=draft`,
  `classAEligible=false` und zunächst keine `validatedDimensions`. Er benötigt
  eine semantische Extraktion, eine eindeutige Kanten-/Wegezuordnung und eine
  fachliche Prüfung.
- `createReleaseSafeValidationMarker` erzeugt bei Bedarf einen minimalen
  auslieferbaren Marker. `assertReleaseSafeValidationMarker` sperrt darin
  Abrufadressen, interne Evidenzbegriffe, PDF-/OCR-/Dateifelder und
  Dokument-SHA-256. Der Markerhash wird ausschließlich aus dem bereits
  bereinigten Marker gebildet und ist kein Rohdateihash.
- Ein intern akzeptierter Sekundärbeleg bleibt `classAEligible=false`. Eine
  Dimension darf erst durch eine davon unabhängige, freigegebene Evidenz auf
  Klasse-A-Niveau wechseln.

## Eingabevertrag

Die RL100-Liste stammt ausschließlich aus dem vorab normalisierten
DB-InfraGO-Betriebsstellenkatalog. Der CLI liest direkt die vom
`infrago-gpkg-adapter.mjs` erzeugte Datei
`db-infrago-operating-places.jsonseq`. Jeder Record besitzt mindestens:

```json
{
  "schema": "zugfolge-infrago-operating-place/v1",
  "operatingPlaceId": "db-infrago:rl100:LL",
  "rl100": "LL"
}
```

`operatingPlaceId` ist die stabile Zielkennung des normalisierten Korpus.
Programmgesteuert wird zusätzlich ein Wrapper mit dem Schema
`zugfolge-normalized-infrago-operating-points/v1` akzeptiert; er enthält je
Eintrag `objectId` oder `stationId` sowie `rl100`. Unnormalisierte Tabellen oder
eine manuell zusammengestellte URL-Liste werden nicht akzeptiert. RL100 wird
NFKC-normalisiert, getrimmt, in Großbuchstaben überführt, gegen denselben
Zeichen-/Längenvertrag wie der Adapter geprüft, dedupliziert und für den Abruf
mit `encodeURIComponent` kodiert. Der interne Dateiname wird dagegen aus einem
Hash abgeleitet und enthält keine RL100.

Der reale Abruf folgt dem Muster
`https://trassenfinder.de/apn/{URL-kodierte-RL100}`. Eine abweichende
Basisadresse ist nur für einen kontrollierten Test oder nach einer jährlichen
Erreichbarkeitsprüfung vorgesehen.

## Schonender, wiederaufnehmbarer Abruf

Der CLI-Einstieg ist `run-apn-evidence.mjs`. Ein Jahreslauf wird getrennt von
der öffentlichen Release-Wurzel gestartet:

```text
node tools/region-import/germany/run-apn-evidence.mjs capture \
  --catalog <NORMALISIERTER_KATALOG.json> \
  --evidence-root <ABSOLUTE_EXTERNE_EVIDENZWURZEL> \
  --concurrency 1 \
  --delay-ms 1000 \
  --user-agent "Zugfolge InfraRelease <JAHR> (<KONTAKT>)"
```

Für einen gemeinsamen Erfassungs- und Analyselauf wird `capture` durch `run`
ersetzt. `analyze --evidence-root ...` arbeitet ausschließlich auf den schon
erfassten Bytes und benötigt keinen Netzzugriff.

Der Abrufvertrag ist absichtlich restriktiv:

- ein Worker als Standard, technisch höchstens zwei;
- globaler Mindestabstand zwischen Request-Starts, bei nicht-lokalen Zielen
  mindestens 250 ms;
- maximal drei Versuche mit exponentiellem Backoff als Standard;
- Request-Timeout gilt für Header **und den vollständigen Body**;
- identifizierender User-Agent, `Accept: application/pdf`;
- nur erfolgreiche Antworten mit `Content-Type: application/pdf` und
  `%PDF-` am Dateianfang;
- Größenprüfung über `Content-Length` und erneut beim Streaming, standardmäßig
  höchstens 64 MiB;
- Bytezahl und SHA-256 werden nach dem Download erfasst, atomar geschrieben und
  bei jeder Wiederaufnahme erneut gegen die Datei geprüft. Der atomare
  Indexaustausch wiederholt unter Windows ausschließlich die kurzzeitig durch
  Leser oder Virenscanner möglichen Fehler `EPERM`, `EBUSY` und `EACCES` in
  einem eng begrenzten Backoff; alle anderen Dateisystemfehler bleiben
  fail-fast.

HTTP 404/410 wird als dauerhaft `unavailable` gespeichert und bei einer
Wiederaufnahme übersprungen. Netzwerkfehler, Timeout, 408/429/5xx, falscher
Content-Type oder ungültige PDF-Magic werden ebenfalls `unavailable`, bleiben
aber erneut prüfbar. `--retry-unavailable` ist für die bewusst freigegebene
jährliche Neubewertung auch dauerhaft fehlender Pläne vorgesehen. Ein Wechsel
der Basisadresse erzwingt einen neuen Capture und verwendet keine alten Bytes
stillschweigend weiter.

## Interne Artefakte

Unter der externen Evidenzwurzel entstehen:

```text
capture-index.json     resumierbarer Status einschließlich RL100, URL,
                       Bytezahl, Dokument-SHA-256 und Fehlergrund
pdf/<stationKey>.pdf   unveränderte Antwortbytes
analysis-index.json    deterministische Strukturstatistik und Receipt-Drafts
```

`capture-index.json` und `analysis-index.json` sind interne Ledgers und dürfen
genauso wenig wie die PDFs ausgeliefert werden. Der öffentliche Release darf
nur den dafür vorgesehenen nicht rückauflösenden Ledger-Bezug aus dem
Release-Compiler sowie bereinigte Marker enthalten.

## Analyseumfang und Aussagegrenze

`analyzePdfBytes` arbeitet deterministisch und ohne externen Dienst. Erfasst
werden mindestens:

- PDF-Version, Seiten-/Objekt-/XRef-Zahlen, linearisierter oder verschlüsselter
  Zustand und vorhandene Info-Metadaten;
- Anzahl und Dekodierbarkeit der Content-Streams einschließlich Flate-Streams;
- Textobjekt-, Textoperator-, Font- und Stringstatistik, aber kein Text im
  auslieferbaren Marker;
- Vektorpfad-, Rechteck-, Clipping-, Zeichen-, Formular- und Bildstatistik.

Diese Statistiken zeigen, ob ein Dokument technisch für eine nachgelagerte
semantische Vektor-/Textanalyse geeignet ist. Sie beweisen weder eine
Gleisverbindung noch ein Signal. Deshalb kennzeichnet der Entwurf nur mögliche
Prüfdimensionen und validiert noch keine davon. Verschlüsselte PDFs,
unbekannte Streamfilter, Dekodierfehler und bildbasierte Pläne bleiben im
internen Bericht sichtbar und gehen in eine OCR-/Review-Folgearbeit.

Nach semantischer Extraktion wird ein Entwurf erst dann in das bestehende
`quality-model.mjs` übernommen, wenn ein Prüfschritt mindestens ergänzt hat:

- `status: "accepted"`;
- genau eine stabile `edgeId` oder `sourceWayId`;
- die tatsächlich belegten `validatedDimensions`;
- einen Widerspruchscheck gegen OSM, InfraGO und das konservative Betriebsmodell;
- unverändert `classAEligible: false`.

Mehrdeutige Zuordnungen bleiben Reviewfälle. Es gibt keinen automatischen
„sieht plausibel aus“-Übergang in den Release.

## Vektortext-Semantik und Abweichungsprüfung

`apn_semantic_extract.py` wertet vorhandenen Vektortext mit `pdfplumber`
deterministisch aus. OCR, Bildklassifikation und externe KI-Dienste werden
nicht verwendet. Der Extraktor beobachtet ausschließlich eng gebundene
lexikalische Kandidaten mit Seiten- und Bounding-Box-Bezug:

- Gleisnummern nur nach einem ausdrücklichen `Gleis`-/`Gl.`-Präfix;
- Weichennummern nur mit `Weiche`-/`W`-Präfix;
- eng begrenzte Hauptsignalbezeichnungs-Kandidaten; Vorsignal-,
  Zusatzsignal- und Lichtsymbole werden nicht zu Hauptsignalen umgedeutet;
- Streckennummer und Kilometrierung nur nach ausdrücklichem Kontext;
- Bahnsteigbezeichnung nur nach `Bahnsteig`;
- Nutz-/Bahnsteiglängen nur als ausdrückliches `NL/BL`-Wertepaar.

Eine Zahl ohne Kontext bleibt als unklassifizierte Zahl gezählt. Jeder Treffer
trägt `semanticAssertion=false`; auch ein exakt gleichlautender OSM-`ref`
beweist keine Objektidentität oder Gleiszuordnung.

Der Node-Orchestrator `run-apn-semantic-audit.mjs` bindet jedes Ergebnis erneut
an Bytezahl und SHA-256 des Capture-Index, lädt die normalisierten
Betriebsstellen sowie die Signal-, Weichen- und Bahnsteiglayer und bildet um
die eindeutige RL100-Koordinate einen konfigurierten Prüfumkreis. Er
protokolliert Objektzahlen, Qualitätsklassen und exakte Referenzgleichheiten
und erzeugt `semantic-review-index.json` in der externen Evidenzwurzel. Der
Vergleich ist nur eine Review-Priorisierung: Er mutiert den Korpus nicht und
erzeugt weder validierte Dimensionen noch Bestellbarkeit oder Klasse A.

Beispiel für eine kleine, rein lokale Realprobe:

```text
node tools/region-import/germany/run-apn-semantic-audit.mjs \
  --evidence-root <ABSOLUTE-EXTERNE-EVIDENZWURZEL> \
  --operating-points <OPERATING-POINTS.geojsonseq> \
  --signals <SIGNALS.geojsonseq> \
  --switches <SWITCHES.geojsonseq> \
  --platforms <PLATFORMS.geojsonseq> \
  --python <GEBUENDELTES-PYTHON> \
  --rl100 LH --max-records 1 --batch-size 1
```

Ohne `--rl100` verarbeitet der Lauf alle bereits verfügbaren Capture-Einträge
kanonisch nach RL100. Bereits gebundene Ergebnisse werden nur bei identischen
Dokument-, Betriebsstellen- und Semantiklayer-Hashes sowie identischem Radius
wiederverwendet. `--batch-size` begrenzt die Zahl neuer Extraktionen je Aufruf;
der Index wird nach jedem Batch atomar fortgeschrieben und der nächste Aufruf
setzt beim ersten noch offenen Dokument fort. Ein Prozessabbruch kann damit
höchstens den aktiven Batch zur erneuten Auswertung stellen. `unavailable`-Einträge
werden gezählt, aber nicht als Parserfehler behandelt. Ein einzelner
Parserfehler wird RL100-bezogen unter `failures` als hoch priorisierter,
nicht freigabefähiger Reviewfall festgehalten und bricht den Batch nicht ab;
`--retry-failed` versucht solche Fälle nach einer bewussten Korrektur erneut.

`--max-records` begrenzt nur eine Probe; der produktive Jahreslauf verwendet
keine solche Begrenzung. Das interne Ledger darf wegen der enthaltenen
Roh-Tokens, Dokumenthashes und Evidenzherkunft nicht in einen öffentlichen
Release, Tilebuild oder ein Manifest kopiert werden. Die erzwungene absolute
Evidenzwurzel außerhalb des Repositorys verhindert insbesondere eine Ausgabe
unter `var/` oder `map-release`. Der Release-Sanitizer in `apn-evidence.mjs`
bleibt die einzige zulässige Grenze.

## Tests und sicherer Probelauf

```text
node --test tools/region-import/germany/apn-evidence.test.mjs
node --test tools/region-import/germany/apn-semantic-audit.test.mjs
python -m unittest discover -s tools/region-import/germany -p apn_semantic_extract_test.py
```

Die Tests verwenden ausschließlich synthetische PDF-Bytes und einen lokalen
HTTP-Server. Sie prüfen URL-Kodierung, maximal zwei parallele Requests,
User-Agent, Retry, Wiederaufnahme, 404, falschen Content-Type, Größenlimit,
PDF-Magic, einen während des Bodys auslösenden Timeout, Byte-/Hashbindung,
deterministische Analyse, Klasse-A-Sperre und den Release-Sanitizer. Sie führen
keinen echten Abruf und insbesondere keinen Massenabruf aus.
