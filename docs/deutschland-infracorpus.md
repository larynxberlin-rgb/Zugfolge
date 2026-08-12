# Deutschland-InfraCorpus und jährlicher InfraRelease

## Verbindlicher Zielzustand

Der Server lädt den vollständigen EBO-Infrastrukturkorpus Deutschlands. Die
Grenze einer Spielwelt schneidet diesen Korpus nicht ab, sondern ist eine
separate, versionierte **Spielbarkeitsmaske**. Dadurch bleiben außerhalb des
Alpha-Gebiets liegende Infrastruktur, Bahnhöfe und Züge auf der Karte sichtbar,
ohne ungeprüfte Konfliktressourcen bestellbar zu machen.

Die drei Mengen dürfen nicht vermischt werden:

1. **sichtbar:** das gesamte deutschlandweite EBO-Netz im `InfraCorpus`;
2. **betrieblich modelliert:** alle `orderable`-Abschnitte der
   Qualitätsklasse A oder B;
3. **spielbar:** die Schnittmenge aus modelliertem Netz und der vom jeweiligen
   `WorldRelease` gepinnten Spielbarkeitsmaske.

Eine Erweiterung des Spielgebiets veröffentlicht daher eine neue Maske und
keinen neu zugeschnittenen Infrastrukturdatensatz.

## Betriebswahrheit und Qualitätsklassen

Klasse A bedeutet nicht „sieht plausibel aus“, sondern: Alle für den
Objekttyp erforderlichen Dimensionen sind unabhängig fachlich validiert. Der
Gleislayer 2026.1 prüft dafür Topologie, Höchstgeschwindigkeit, Neigung,
Elektrifizierung, Gleisanzahl, Signale, Blöcke und Konfliktressourcen. Klasse B
besitzt ein geschlossenes, konservatives Betriebsmodell, verwendet aber für
mindestens eine Dimension einen beobachteten, abgeleiteten oder ausdrücklich
angenommenen Wert. Spielbar wird A oder B erst zusammen mit `orderable=true`
und der Weltmaske. Klasse C bleibt sichtbar und ist nie bestellbar;
`rail_context` bleibt unabhängig von seiner Darstellungsqualität immer
Kontext und nicht bestellbar.

Fehlende Werte werden nur durch benannte, versionierte Sicherheitsregeln
geschlossen. Der erste Regelsatz begrenzt unbekannte Hauptgleise auf 20 km/h,
unbekannte Nebengleise auf 10 km/h, behandelt unbekannte Elektrifizierung als
nicht elektrifiziert, nutzt einen konservativen Neigungskorridor und erzeugt
virtuelle Festblöcke sowie kantenexklusive Konfliktressourcen. Diese Annahmen
sind bewusst restriktiv; sie dürfen nicht als reale Infrastrukturfakten
angezeigt werden.

Der Qualitätsbericht wird je Release erzeugt und weist mindestens aus:

- Länge und Abschnittszahl je Klasse A/B/C;
- Länge je Qualitätsdimension und Evidenzzustand;
- Länge und Abschnittszahl je Abwertungsursache;
- Klasse-C-Länge sowie den Beweis, dass jedes C-Objekt
  `orderable=false` trägt; die Releasekonfiguration hält zusätzlich
  `classCPlayable=false` fest;
- Hash von Korpus und Qualitätsbericht. Der Hash des internen Evidenzledgers
  bleibt ausschließlich im nicht auszuliefernden Buildnachweis.

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

APN-Skizzen sind ausschließlich interne Validierungsevidenz. PDFs, OCR-Text,
Bildkoordinaten, Abrufadresse und der Quellenname gelangen nicht in
`InfraCorpus`, `InfraRelease`, PMTiles oder Client-API. Ein ausgelieferter
Abschnitt trägt nur Qualitätsklasse und Modellzustand, aber weder Beleg-ID noch
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

`release-artifacts.annual-2026.json` und `run-release-artifacts.mjs` erfassen
die finale Infrastruktur-PMTiles, den Detailkatalog, die konservative
Zugpositionsprojektion und den Qualitätsbericht mit ihren tatsächlichen
Bytezahlen und SHA-256-Werten. Dieses Inventar ist die einzige Eingabe für den
öffentlichen Artefaktabschnitt des `InfraRelease`; manuell übertragene
Prüfsummen sind nicht zulässig.

## Realer Jahreskandidat 2026.1

Der vollständige Deutschlandlauf wurde mit den gepinnten Großquellen
ausgeführt. Sein öffentlicher Qualitätsbericht umfasst zehn semantische Layer
und 1.600.662 sichtbare Objekte:

| Klasse | Objekte | Bedeutung im Kandidaten |
|---|---:|---|
| A | 0 | keine pauschale oder nur automatisch begründete Hochstufung |
| B | 1.489.960 | beobachtet, abgeleitet oder durch eine versionierte konservative Regel geschlossen |
| C | 110.702 | sichtbar, aber nicht bestellbar |

Der Gleislayer enthält 609.242 Abschnitte und 83.491.261.974 mm. Davon sind
609.237 Abschnitte mit 83.491.089.540 mm B; fünf Abschnitte mit insgesamt
172.434 mm bleiben wegen ungültiger Topologie C. Der Bericht weist Annahmen und
Widersprüche dimensionsweise aus: Beispielsweise werden fehlende
Geschwindigkeiten auf 20 km/h am Hauptgleis beziehungsweise 10 km/h am
Nebengleis begrenzt, fehlende Elektrifizierung als nicht elektrifiziert
behandelt, Neigungslücken mit dem konservativen Korridor geschlossen und
unbelegte Signalgrenzen nicht erfunden.

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
| releasegebundene Exact-/Estimate-Zugkartenprojektion | 29.003.776 | `61a99693dad47bf21423ed9bf9b1547a0cbdcdeeb7717dd5daabc36375d61bde` |
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
