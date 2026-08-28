# Deutschland-InfraCorpus und jährlicher InfraRelease

## Verbindlicher Zielzustand

Der Server lädt den vollständigen EBO-Infrastrukturkorpus Deutschlands. Die
Grenze einer Spielwelt schneidet diesen Korpus nicht ab, sondern ist eine
separate, versionierte **Spielbarkeitsmaske**. Dadurch bleiben außerhalb des
Alpha-Gebiets liegende Infrastruktur, Bahnhöfe und Züge auf der Karte sichtbar,
ohne ungeprüfte Konfliktressourcen bestellbar zu machen.

Die drei Mengen dürfen nicht vermischt werden:

1. **sichtbar:** das gesamte freigegebene deutschlandweite EBO-Netz der
   Qualitätsklasse A oder B im `InfraCorpus`;
2. **betrieblich modelliert:** alle vollständig konservativ geschlossenen
   `orderable`-Abschnitte dieses Korpus;
3. **spielbar:** die Schnittmenge aus modelliertem Netz und der vom jeweiligen
   `WorldRelease` gepinnten Spielbarkeitsmaske.

Eine Erweiterung des Spielgebiets veröffentlicht daher eine neue Maske und
keinen neu zugeschnittenen Infrastrukturdatensatz.

## Betriebswahrheit und Qualitätsklassen

Klasse A bedeutet nicht „sieht plausibel aus“, sondern: Alle für den
Objekttyp erforderlichen Dimensionen sind unabhängig fachlich validiert. Der
Gleislayer 2026.1 prüft dafür Topologie, Höchstgeschwindigkeit, Neigung,
Elektrifizierung, Gleisanzahl, Signale, Blöcke und Konfliktressourcen. Klasse B
besitzt ein geschlossenes, konservatives Betriebsmodell. Ein fehlender Wert ist
dort nicht bloß `assumed`, sondern Ergebnis einer benannten, vollständigen
Offline-Ableitung mit `provenance=derived`. Spielbar wird A oder B erst zusammen
mit `orderable=true` und der Weltmaske. Eine gewöhnliche Annahme oder eine
ungelöste Pflichtdimension bleibt Klasse C und ist nicht bestellbar. Sie
blockiert den Operational-Kandidaten, wenn sie zu dessen Pflichtscope gehört.
Ein getrenntes sichtbares Karten-Evidenzobjekt darf C bleiben, sofern das
Operational-v2-Artefakt seine betriebliche Funktion unabhängig vollständig als
Derived/B schließt; das Kartenobjekt wird dadurch weder umklassifiziert noch
entfernt. `rail_context` bleibt unabhängig von seiner Qualität immer Kontext
und nicht bestellbar.

Fehlende Werte werden nur durch benannte, versionierte Sicherheitsregeln
geschlossen. Der Regelsatz `synthetic-operational-b/v2` erhält die beobachtete
E7-Gleisgeometrie, begrenzt unbekannte Fahrparameter restriktiv und erzeugt
offline ein zusammenhängendes, kapazitätsärmeres Sicherungsmodell. Ein
  SHA-gebundenes Closure-Receipt-v2 muss Policy, Jahresspezifikation, sechs
  operative Kartenlayer sowie die drei freien Fahrwegeingaben `gtfs-snapshot`,
  `timetable-route-report` und `timetable-routes` binden. Der Routenbericht muss
  den CC-BY-4.0-Snapshot samt Datei-, internem Snapshot- und Archiv-SHA, die
  vollständige ausgewählte Segmentmenge und das Verbot externer
  Operational-Network-Provenienz nachweisen. Das Receipt bindet außerdem Candidate,
Ableitungsbericht, native Validierungen, materialisiertes Operational-v2-
Artefakt und Zustand sowie `unresolvedRequired=0` belegen. Ohne dieses Receipt bleiben
Einzelannahmen Klasse C. Die synthetischen Signalgrenzen, Weichen-/Knotensperren,
Fahrstraßen, Schutzressourcen und Bahnsteigintervalle sind interne
Simulationswahrheit und dürfen nicht als reale Stellwerksfakten angezeigt
werden.

Der Qualitätsbericht wird je Release erzeugt und weist mindestens aus:

- Länge und Abschnittszahl je Klasse A/B;
- Länge je Qualitätsdimension und Evidenzzustand;
- Länge und Abschnittszahl je Abwertungsursache;
- `unresolvedRequired=0` für sämtliche Objekte und Pflichtdimensionen des
  verbindlichen Korpusscopes; jeder positive Wert blockiert den Kandidaten;
- Hash von Korpus und Qualitätsbericht. Der Hash des internen Evidenzledgers
  bleibt ausschließlich im nicht auszuliefernden Buildnachweis.

Der öffentliche Qualitätsbericht darf den Policy- und Closure-Hash des
synthetischen Modells nennen. Das ausgelieferte Operational-v2-Artefakt enthält
die synthetischen Betriebsobjekte und führt sie zusammen mit beobachteten
Objekten in denselben Laufzeit-Collections
(`syntheticOperationalDetailsShipped=true`,
`observedAndSyntheticObjectsShareRuntimeCollections=true`). Es liefert jedoch
keine objektweise Lineage aus (`objectLevelProvenanceShipped=false`) und trägt
ausdrücklich `realInterlockingFactsClaimed=false`. Das ist eine
Reproduzierbarkeitsbindung, keine Behauptung über reale Stellwerksausrüstung.

Karten- und Betriebsqualität sind deshalb zwei SHA-gebundene Artefakte. Die
öffentliche `zugfolge-static-map-quality/v2` darf A/B/C enthalten und verneint
Operational-Release sowie Produktionsaktivierung; sie bindet den detaillierten
`visible-map-quality-evidence`-Bericht. Der
`zugfolge-operational-infrastructure-quality-report/v1` bindet dessen Bytes,
weist die sichtbaren Karten-C-Zahlen weiterhin aus und führt daneben exakt ein
geschlossenes Operational-Artefakt als B mit operativem C=0. Seine
`operationalQualityEligible=true`-Aussage impliziert weder Signatur noch
Aktivierung.

Die ausführbare Spezifikation liegt unter
`tools/region-import/germany/release.config.json`; der Compiler und seine Tests
liegen im selben Verzeichnis. `run-germany-import.mjs` prüft das extern
gespeicherte Deutschland-PBF bytegenau gegen das Capture-Manifest, erzeugt den
EBO-Extract, einen GeoJSON-Sequenzexport und den bestehenden Rust-Nachweis für
Topologie, virtuelle Blöcke und konservative Fahrstraßen. Es lädt selbst keine
Quelle herunter; Beschaffung und Releasebau bleiben getrennte, auditierbare
Schritte.

## Quellen- und Evidenztrennung

Der jährliche Lauf besitzt zwei Manifeste:

- Das **öffentliche Release-Manifest** nennt jede auslieferungspflichtige Quelle
  mit Lizenz, Attribution, Version, Änderungskennzeichnung und Hash.
- Das **interne Evidenzledger** bindet Prüfbelege an Abschnitte. Es wird
  gehasht und ausschließlich im internen Buildnachweis gehalten; weder sein
  Hash noch Rohbestand oder interne Quellennamen werden ausgeliefert.

Vor dem öffentlichen Manifestlauf erzeugt
`run-finalize-source-capture.mjs` aus dem allgemeinen Quellcapture, dem
verifizierten Copernicus-Kachelsatz und dem abgeschlossenen internen
Prüfledger einen vollständigen Buildbeleg. Der Ledgerhash dient nur dem
internen Reproduzierbarkeitsnachweis; `buildPublicInfraRelease` übernimmt ihn
weder direkt noch indirekt in das öffentliche Manifest.

Falls APN-Skizzen im jeweiligen Jahreslauf rechtmäßig und tatsächlich verfügbar
sind, sind sie ausschließlich optionale interne Validierungsevidenz. Ihr
Fehlen blockiert weder den kostenlosen Basiskorpus noch die synthetische
Klasse-B-Schließung. PDFs, OCR-Text,
Bildkoordinaten, Abrufadresse und der Quellenname gelangen nicht in
`InfraCorpus`, `InfraRelease`, PMTiles oder Client-API. Ein ausgelieferter
Abschnitt trägt nur Qualitätsklasse A oder B und Modellzustand, aber weder Beleg-ID noch
Beleg-Hash. Andere Quellen behalten ihre
jeweils vorgeschriebene Attribution; die APN-Ausnahme ist keine allgemeine
Unterdrückung von Quellenangaben. Ein APN-Beleg kann Unsicherheit reduzieren,
aber aus rechtlichen und fachlichen Gründen niemals allein eine Dimension auf
Klasse-A-Niveau heben; dafür ist ein davon unabhängiger, zur Auslieferung
freigegebener Beleg erforderlich.

## Jährlicher, KI-gestützter Build

KI darf Quellen zuordnen, Pläne auslesen, Widersprüche vorschlagen und
Validierungsbelege vorbereiten. Sie veröffentlicht jedoch keinen Release
direkt. Der deterministische Compiler, das Rechte-Gate, die
Invariantenprüfung, der vom Kalibrierbestand getrennte Holdout und die
Release-Signatur bleiben zwingend. Gleiche gepinnte Eingaben, Regeln und
akzeptierte Belege müssen denselben Korpus-Hash erzeugen.

Große Eingaben und abgeleitete Daten liegen außerhalb der Git-Historie. Der
Jahreslauf verwendet standardmäßig `var/source-cache/annual-<jahr>/` und
`var/derived/germany-<jahr>/`; interne Rohbelege liegen zusätzlich in einem
nicht auszuliefernden Evidenzspeicher. Im Repository verbleiben nur
Konfiguration, Quellkatalog, Prompt, Pipeline, kleine Testfixtures und
Nachweisschemata. Der feste Arbeits-Prompt steht in
[`prompts/infrarelease-deutschland-jahreslauf.md`](prompts/infrarelease-deutschland-jahreslauf.md).

## Kartenartefakte

Die weltweite dunkle Vektorkarte und das semantische Deutschlandnetz sind zwei
getrennte, immutable PMTiles-Dateien und werden ausschließlich von Zugfolge
selbst ausgeliefert. Der Browser greift weder auf öffentliche OSM-Kachelserver
noch auf OpenRailwayMap-Kachelserver zu. Die Basemap kann unabhängig vom
jährlichen `InfraRelease` generalisiert und ausgetauscht werden; Objekt-IDs,
Qualitätsklassen, Gleise, Signale, Weichen und Betriebszustände bleiben im
Infrastrukturartefakt.

`tools/tiles/build-map-release.mjs` prüft vor Veröffentlichung Quellfreigaben,
Quell- und Artefakthashes, PMTiles-Kennung, getrennte Layer, stabile Objekt-IDs,
immutable URLs und die Verpflichtung zur HTTP-Range-Auslieferung. Der
Produktivserver muss den getesteten `206 Partial Content`-Vertrag erfüllen;
sonst würde schon ein Kartenausschnitt unnötig das gesamte Archiv übertragen.

Der zugehörige anklickbare Objekt- und Fahrplankatalog wird nicht in die
Kacheln dupliziert. Er liegt als öffentliche, releasegebundene SQLite-Datei
neben den PMTiles und wird nur bei einem konkreten Klick oder einer
Bahnhofstafel-/FIS-Abfrage gelesen. Der ausführbare Jahresvertrag und der reale
2026-Nachweis stehen in
[`livemap-detailkatalog.md`](livemap-detailkatalog.md).

Ab dem Operational-v2-Vertrag 2026.3 erfassen die jeweilige
Jahres-Artefaktspezifikation und `run-release-artifacts.mjs` die finale
Infrastruktur-PMTiles, den Detailkatalog, den Qualitätsbericht und genau ein
weltfreies statisches `operational-infrastructure-v2`-Artefakt mit ihren
tatsächlichen Bytezahlen und SHA-256-Werten. Dieses typisiert erzeugte
Inventar ist die einzige Eingabe für den öffentlichen Artefaktabschnitt des
`InfraRelease`; manuell übertragene Prüfsummen sind nicht zulässig. Die
historischen Verträge 2026.1 und 2026.2 bleiben unverändert v1 und enthalten
stattdessen ihre damalige statische Exact-/Estimate-Zugpositionsprojektion.
Diese Projektion ist kein Operational-v2-Laufzeitartefakt. Ab dem v2-Cutover
projizieren LiveMap und RZÜ ausschließlich denselben committed v2-Zustand und
frieren bei fehlendem Nachweis ein, statt auf `mapEstimate` zurückzufallen.

## Historischer Jahreskandidat 2026.1

Der vollständige Deutschlandlauf wurde mit den gepinnten Großquellen
ausgeführt. Sein damaliger Qualitätsbericht umfasst zehn semantische Layer und
1.600.662 Objekte:

| Befund | Objekte | Bedeutung im historischen Kandidaten |
|---|---:|---|
| A | 0 | keine pauschale oder nur automatisch begründete Hochstufung |
| vollständig konservativ geschlossen | 1.489.960 | beobachtet, abgeleitet oder durch eine versionierte konservative Regel geschlossen |
| ungelöste Pflichtdimension | 110.702 | nach heutigem Vertrag ein Releaseblocker |

Der Gleislayer enthält 609.242 Abschnitte und 83.491.261.974 mm. Davon sind
609.237 Abschnitte mit 83.491.089.540 mm B; fünf Abschnitte mit insgesamt
172.434 mm hatten eine ungültige Topologie. Der Bericht weist Annahmen und
Widersprüche dimensionsweise aus: Beispielsweise werden fehlende
Geschwindigkeiten auf 20 km/h am Hauptgleis beziehungsweise 10 km/h am
Nebengleis begrenzt, fehlende Elektrifizierung als nicht elektrifiziert
behandelt, Neigungslücken mit dem konservativen Korridor geschlossen und
unbelegte Signalgrenzen nicht erfunden.

Dieser historische Kandidat erfüllt den heutigen A-/B-only-Vertrag nicht und
bleibt `activationEligible=false`. Die folgenden Hashes dokumentieren nur den
damaligen Build; ein freigabefähiger Neubau muss alle Pflichtdimensionen
schließen und erzeugt neue Artefakte mit neuen Hashes.

Die interne Planvalidierung erfasste alle 7.667 bekannten
Betriebsstellenkennungen: 3.296 Pläne waren verfügbar, 4.371 nicht. Für alle
verfügbaren Pläne wurden Struktur- und Semantikprüfung abgeschlossen; 3.295
enthielten auswertbaren Vektortext, einer nicht. Die semantische Prüfung
klassifizierte 258 Ergebnisse als hoch, 2.344
als mittel und 694 als niedrig belastbar und erzeugte 5.351
Widerspruchsfälle. Sie bewirkte bewusst **keine** A-Hochstufung, keine Änderung
der Bestellbarkeit und keine direkte Korpusmutation. Rohpläne, interne Hashes,
Abrufbelege und Quellenbezeichnungen bleiben ausschließlich im internen
Buildnachweis.

Die zentralen Laufzeitartefakte vor Transportverpackung sind:

| Artefakt | Byte | SHA-256 |
|---|---:|---|
| Welt-Basemap, Welt z0–10 und Deutschland z11–15 | 11.545.162.669 | `c766073e55b99b213276328e504cbb7a69b0b65db0546adf484539c3bd319aed` |
| Deutschland-Infrastruktur, z4–18 | 1.536.379.722 | `65af6dbe8c517666c83941468c0f52b37fa30d866b8e402f6977aa4a599d3de6` |
| anklickbares ReadModel mit Bahnhofstafel und FIS | 1.291.001.856 | `c7e56cecb3db9aaae7994877894312ade91c536e7c5027e10e63045d7303ad21` |
| historische, mit Operational-v2 abgelöste Exact-/Estimate-Zugkartenprojektion | 29.003.776 | `61a99693dad47bf21423ed9bf9b1547a0cbdcdeeb7717dd5daabc36375d61bde` |
| dunkler MapLibre-Stil | 268.406 | `1f4292eab8f40faf0d1a2eff5a410a5943ab260278e84918c0a19f0fc8cc54da` |
| öffentlicher Qualitätsbericht | 13.336 | `189758347185102a573e1ed89c618b7ef61a88d7af61d95fa71e61a2fe2f6303` |

PMTiles-Header, MVT-Kacheltyp und exakte Layerinventare wurden geprüft. Die
Basemap enthält neun Basiskartenlayer; das Infrastrukturartefakt enthält exakt
die zehn im Qualitätsbericht bilanzierten Fachlayer. ReadModel und
Zugprojektion bestehen SQLite-Header-, Schema-, Fremdschlüssel-,
`quick_check`- und Integritätsprüfungen.

Der daraus erzeugte öffentliche Deliveryvertrag `release.json` enthält 1.034
inventarisierte Artefakte und acht freigegebene öffentliche Quellen. Er ist
268.160 Byte groß und besitzt den SHA-256
`a775d79bbed8f9e355e77d8da84481f260f13213c34b8a1768bb366fbd8775c1`.
Sein Qualitäts- und Rechtegate ist bestanden; `signature` bleibt `null` und
das Signaturgate steht mit dokumentiertem Grund auf `missing`.

Das daraus gepackte Transportartefakt umfasst 1.172 Teile mit
14.419.864.896 Byte. Sein 606.870 Byte großes `manifest.json` besitzt den
SHA-256
`b12f607c959992d29ea9e7dcc2e963b01717b117d8614b5938fcc437dece8e9c`.
Packen, vollständige Verifikation, atomare Erstinstallation und ein zweiter
idempotenter Installationslauf mit Status `reused` sind erfolgreich. Der
produktive Odoo-Import und Periodenwechsel sind damit nicht vorweggenommen.

## Abnahmegrenze

Die kleinen Fixtures beweisen nur den Vertrag. Für 2026.1 sind darüber hinaus
die realen Eingaben gepinnt, der vollständige Deutschlandlauf ausgeführt, die
Qualitätslängen bilanziert, die selbst gehosteten Kartenartefakte erzeugt und
die getrennte interne Planprüfung abgeschlossen. Dieser Stand ist ein realer
Jahreskandidat, aber noch kein aktivierbarer Jahresrelease: Seine Signatur
fehlt, deshalb bleibt `activationEligible=false`. Namentliche Freigabe, echte
Signatur, erneute Game-Qualifizierung und der produktive Odoo-/Periodenlauf
bleiben offen. M14.2 steht folglich auf **in Arbeit**, nicht auf erledigt.
