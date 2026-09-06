# M15.3 — Pixelart-Korpus und ArtAtlasManifestV1

Vertragsversionen: `conductor-art-catalog/v1` und die ergänzende Fassung
`conductor-art-catalog/v2`. Der Atlas konkretisiert den
[Schaffnervertrag](schaffnermodus.md) 5.1 und die gemeinsame Gestaltung aus
[Design](design.md) und [ADR-0035](adr/0035-deutschlandweite-spieleroberflaeche.md).
Er enthält eigenständig erzeugte Grafiken und deren prüfbare Herkunft. Er
erzeugt weder Fahrgäste noch Fahrzeuginnenräume oder Betriebszustände.

M15.3 liefert den vollständigen visuellen Korpus, seine technische Prüfung
und die dokumentierte Freigabe. Ein generierter Kandidat oder ein grüner
Dateitest allein ist keine Freigabe. Der [Abnahmestand](#8-abnahme-und-grenzen)
trennt diese Schritte. Maßgebliches Arbeitspaket ist
[#213](https://github.com/larynxberlin-rgb/Zugfolge/issues/213).

## 1. Kamera, Raster und Bildsprache

Die Kamera zeigt eine orthogonale Draufsicht. Objekte liegen auf derselben
Ebene; perspektivische Fluchtpunkte, isometrische Schrägansichten und gemalte
Seitenansichten erfüllen diesen Vertrag nicht. Graphitfarbene Innenräume,
eigene rote Akzente und deutliche Konturen verbinden Zug, Figuren und Station.
Kleidung, Haut, Vegetation und Gebäude dürfen zusätzliche konsistente Farben
verwenden. Betriebszustände benötigen ergänzend Text, Symbole oder Muster.

Die native Dichte beträgt genau 32 Pixel pro Meter. Atlasrechtecke, Pivots,
Frameabmessungen und Laufzeitzoom sind ganzzahlig. Laufzeitpositionen bleiben
Integer-Millimeter aus dem autoritativen Zustand; die Darstellung verändert
sie nicht. Für jede logische Bildabmessung gilt
`logicalPixels * 1000 = physicalMillimeters * 32`.
Ein technisch auf 64 × 64 Pixel gepaddeter Figurenframe beschreibt eine
2 × 2 Meter große Bildfläche, keinen zwei Meter breiten Menschen. Der sichtbare
Figurenkörper belegt ungefähr 24 Pixel; der Rest hält transparenten Abstand
für Bewegung und Zubehör. Der Pivot bindet alle Posen an dieselbe Position.

`sourceScale` darf 1, 2, 3 oder 4 sein. Höher aufgelöste Quelldateien sind nur
dann echte Pixelgrafik, wenn jeder zu einem logischen Pixel gehörige
`sourceScale × sourceScale`-Block identische RGBA-Werte besitzt. Eine bloß
pixelartig gemalte, intern geglättete Kante erfüllt das Rastergate nicht.
Rechtecke und Pivots müssen vollständig auf diesem Raster liegen. Zur Anzeige
werden ausschließlich ganzzahlige Zoomstufen und Nearest Neighbor verwendet;
Canvas-Glättung und lineare Texturfilter sind ausgeschaltet.

Das Manifest enthält eine explizite Palette mit höchstens 64 RGBA-Farben.
Pflichtfarben sind `#101419ff`, `#181e25ff`, `#202830ff` und `#e5233dff`.
Weitere Farben werden als Bestandteil dieser Palette gepinnt, nicht pro
Bild heimlich ergänzt. Pixelalpha ist ausschließlich 0 oder 255; transparente
Ränder enthalten keine sichtbaren Farbsäume. Palettenmitgliedschaft beweist
keinen Kontrast: Konturen, Interaktionszeichen und Beschriftungen werden
zusätzlich im zusammengesetzten Bild geprüft.

## 2. Vollständiger Motivekatalog

Der versionierte Pflichtkatalog ist die Mindestmenge eines M15.3-Releases.
Ein Manifest darf zusätzliche freigegebene Motive aufnehmen, aber keine
Pflichtkennung durch einen leeren Frame, einen Farbfleck, ein mehrfach
umbenanntes Bild oder ein unpassendes Ersatzmotiv erfüllen. Jede Pflichtkennung
muss in der Kontaktübersicht mit ihrer tatsächlichen Grafik sichtbar sein.

### 2.1 Figuren und Animationen

Die erste Fassung enthält vier unterschiedliche Fahrgastsets
`passenger-01`, `passenger-02`, `passenger-03`, `passenger-04` und das eigene
Schaffnerset `conductor-01`. Kleidung, Gepäck und Kontur unterscheiden die
Fahrgastsets. Keine Variante, Körperform, Hautfarbe, Kleidung oder Hilfsmittel
steht für eine Fahrberechtigung, Kooperation oder einen Dialogausgang.

Für **jedes** der fünf Sets und **jede** Richtung `north`, `east`, `south`,
`west` sind folgende Animationen vollständig erforderlich:

| Zustand | Frames je Richtung | Visueller Nachweis |
|---|---:|---|
| `idle` | 1 | Ruhige Pose mit erkennbarer Blickrichtung und passendem Pivot |
| `walk` | 4 | Vier tatsächlich unterschiedliche Bewegungsphasen mit konsistentem Körper, Maßstab, Kleidung und loopfähigem Übergang |
| `sitting` | 1 | Sitzpose, die denselben Körper und dieselbe Blickrichtung auf einem Innenraumsitz zeigt |

Das sind 24 Frames pro Set und **120 Figurenframes** insgesamt. Ein Wechsel
der Blickrichtung oder wiederholte Kopien desselben Bilds ersetzen keine
vier Gehphasen. Der Manifestvalidator prüft den vollständigen Bezug; die
visuelle Prüfung beurteilt Bewegung, Anatomie, Maßstab und Übergänge.
Framedauern sind positive ganzzahlige Millisekunden. Reduzierte Bewegung
verwendet den passenden Ruheframe statt einer blinkenden Animationsfolge.

M15.2 liefert `appearanceVariant` im Bereich 0 bis 255. Der Atlas bildet alle
256 Werte explizit und deterministisch auf die vier Fahrgastsets ab. Viele
Werte dürfen dasselbe Set verwenden; es werden keine 256 einzigartigen
Figuren behauptet. `conductor-01` wird ausschließlich für die Spielerfigur
verwendet. Fehlende Zuordnung darf keine unsichtbaren Fahrgäste erzeugen.

### 2.2 Statische Motive des v1-Grundkatalogs

Die folgenden Platzhalter in Kennungen bezeichnen jeweils das vollständige
kartesische Produkt, keine frei wählbare Teilmenge.

| Familie | Pflichtkennungen | Anzahl |
|---|---|---:|
| Innenraum | `interior.floor`, `interior.wall`, `interior.window`, `interior.door-closed`, `interior.door-open`, `interior.seat`, `interior.standing`, `interior.multipurpose`, `interior.wc`, `interior.cab`, `interior.gangway` | 11 |
| Wagen | `vehicle.body`, `vehicle.front`, `vehicle.roof` | 3 |
| Station | `station.{small,medium,large}.{platform,roof,hall,stairs,underpass}` | 15 |
| Umgebung | `environment.{rural,suburban,urban}.{vegetation,road,building}` | 9 |
| Signalbild | `signal.stop`, `signal.proceed` | 2 |
| Zubehör | `accessory.{wheelchair,bicycle,stroller}.{north,east,south,west}` | 12 |
| **Gesamt** | Vollständige statische Pflichtmenge | **52** |

Der Gesamtkorpus umfasst somit mindestens **172 zugeordnete Motive/Frames**.
Ein Atlas darf sie auf mehrere PNG-Dateien verteilen. Die Anzahl von Dateien
ist kein Vollständigkeitsmaß. Der ausführbare Katalog steht in
[`catalog.ts`](../packages/conductor-art/src/catalog.ts).

### 2.3 Generische Wagenfamilien in Katalog v2

Katalog v2 behält die vollständige Pflichtmenge von v1 und ergänzt die folgenden
**14 Fahrzeugteile**. Damit verlangt v2 insgesamt **186 Motive/Frames**, darunter
66 statische Motive und unverändert 120 Figurenframes in 60 Animationen.
Ein v1-Manifest bleibt mit seinem bisherigen Pflichtumfang gültig; ein als v2
bezeichneter Atlas muss jede neue Kennung enthalten. Keine fehlende Oberetage
darf durch Unteretage, Dach oder einen einstöckigen Wagen ersetzt werden.

| Wagenfamilie | Kennung | Innenebenen | Pflichtteile |
|---|---|---|---|
| Regionaler Doppelstockwagen | `regional-double` | `lower`, `upper` | `lower`, `upper`, `roof` |
| Einstöckiger Fernverkehrswagen | `intercity-single` | `body` | `body`, `roof` |
| Einstöckiger Regionalwagen | `regional-single` | `body` | `body`, `roof` |
| Fernverkehrs-Doppelstockwagen | `intercity-double` | `lower`, `upper` | `lower`, `upper`, `roof` |
| Speisewagen | `dining` | `body` | `body`, `roof` |
| Schlafwagen | `sleeper` | `body` | `body`, `roof` |

Die Assetkennung lautet `vehicle.{Wagenfamilie}.{Pflichtteil}`. Dieser Namensraum
ist in v2 auf die angegebenen Kombinationen beschränkt: Ein `body` ersetzt bei
einem Doppelstockwagen kein Deck; `upper` oder `lower` sind bei den einstöckigen
Familien ungültig. Die bisherigen Kennungen `vehicle.body`, `vehicle.front` und
`vehicle.roof` bleiben zusätzlich erhalten. `VEHICLE_VARIANTS` exportiert die
Tabelle als `id`, deutsches `label`, `decks` und `parts`; die Galerie und spätere
Ansichten können ihre Auswahl daraus ableiten.

Jedes der 14 neuen Teile besitzt einen Rahmen von **96 × 864 logischen Pixeln**
und damit eine gepinnte generische Bildfläche von **3000 × 27000 Millimetern**.
`sourceScale` gilt unverändert. Decks und Dach einer Familie haben denselben
Pivot, damit ein Ansichtswechsel den Wagen nicht verschiebt. Diese Maße und
grafischen Einrichtungen beschreiben keine reale Baureihe, keine M5-Konfiguration
und keine Sitz-, Steh-, Schlafplatz- oder Bewirtungskapazität. Solche Fachwerte
kommen weiterhin ausschließlich aus den zuständigen Fahrzeugdaten und dem
Betrieb. Die Auswahl in einer Grafikprüfung erzeugt keine begehbare Ebene.

Die sechs eigenen Generierungen gehen auf das vorhandene Original `train`
zurück. Ihre Quellkennungen lauten `vehicle-{Wagenfamilie}`. Fünf verwenden
`train` direkt; der gezielt korrigierte Regionaldoppelstockwagen verwendet
`vehicle-regional-double-initial`, dessen tatsächliche Referenz wiederum
`train` ist. Alle Stufen bewahren eigene Prompts, Originale und Herkunftsbelege.
Die Erweiterung vergibt keine Rechte- oder Bildfreigabe.

Innenraummodule zeigen begehbare Flächen, eindeutige Türen, Sitze, Steh- und
Mehrzweckbereiche, WC, Führerstand und Wagenübergang. Fenster und Außenhülle
passen zum selben Wagenmaßstab. Diese Grafiken sind generische Bauteile;
ihre Anordnung, Kapazität und Begehbarkeit werden erst aus M5-Konfigurationen
in M15.4 erzeugt. Eine eingezeichnete Tür oder ein Sitz ist keine neue
betriebliche Kapazität und kein eigenständiger Kollisionsbeleg.

Die drei Stationsklassen besitzen sichtbar unterschiedliche Größen und
Ausstattung. Eine kleine Halle darf als kleiner geschützter Wartebereich
ausgeführt sein; sie ist keine große Bahnhofshalle im verkleinerten Maßstab.
Plattform, Dach, Hallenbereich, Treppe und Unterführung müssen jeweils
kombinierbar sein. Es werden keine realen Bauwerke nachgebildet. Bahnhofsnamen
und Bahnsteigbezeichnungen werden außerhalb der Rastergrafik aus den
autorisierten Daten als lesbarer Text gesetzt. Fantasiebuchstaben oder feste
reale Stationsnamen im generierten Bild bestehen das Schriftgate nicht.

Umland, Vorstadt und Stadt enthalten eigene Vegetations-, Straßen- und
Gebäudemotive und lassen sich ohne harte Stilwechsel kombinieren. Ein
Standbild beweist noch keinen fließenden Urbanitätswechsel. Tag/Nacht kann
dieselben freigegebenen Motive mit einer geprüften Beleuchtungsprojektion
verwenden; zusätzliche neue Nachtmotive sind keine Voraussetzung des Katalogs.
Geschwindigkeit, Stillstand, Signalzustand und Tageszeit stammen aus dem
laufenden Betrieb. Die beiden Signalbilder sind ausschließlich Darstellung;
sie erteilen kein Fahrrecht und ersetzen keine releasegebundene Signallogik.

Jedes der drei Zubehörsets besitzt alle vier Richtungen. `accessoryBindings`
ordnet es vollständig den vier Fahrgastsets und dem entsprechenden
`spaceNeeds` zu. Pivots, Sitz-/Stehpose und Zubehör müssen zusammenpassen;
keine abgeschnittenen Räder, schwebenden Hände oder doppelte Körper. Die
Bindung beschreibt visuelle Kompatibilität, keine zusätzliche Fahrgastperson.

## 3. Manifest und Dateibindung

`ArtAtlasManifestV1` ist ein versionierter Vertrag aus `packages/conductor-art`.
Die [Typdefinitionen](../packages/conductor-art/src/types.ts) legen die genaue
JSON-Feldform fest; dieses Dokument definiert ihren fachlichen Zweck und die
Freigaberegeln. Unbekannte Schemas, zusätzliche unbekannte Felder und ungültige
Referenzen werden abgelehnt. Kennungen sind innerhalb ihres Namensraums eindeutig.

| Feld | Erforderlicher Inhalt und Prüfung |
|---|---|
| `schemaVersion`, `releaseId`, `status` | `art-atlas-manifest/v1`, stabile Releasekennung und `candidate`, `approved` oder `rejected` |
| `catalogVersion`, `pixelsPerMetre`, `rendering` | `conductor-art-catalog/v1` oder `/v2` mit jeweils eigenem Pflichtumfang, genau 32, orthogonale Draufsicht, ganzzahlige Zoomstufen und `nearest_neighbor` |
| `palette` | Stabile Kennung und vollständige RGBA-Allowlist |
| `files` | Lokaler relativer Pfad, SHA-256 der exakten PNG-Bytes, tatsächliche `widthPx`/`heightPx` und `sourceScale`; keine externen Laufzeit-URLs |
| `assets` | `id`, `category`, `fileId`, ganzzahliges `rect`, `worldWidthMm`/`worldHeightMm`, `pivot`, `generation` und getrennte `review`-Ergebnisse |
| `animations` | `role`, `appearanceId`, `direction`, `state`, vollständige geordnete Framereferenzen und positive `durationMs` |
| `appearanceVariants`, `accessoryBindings` | Vollständige Zuordnung der 256 Erscheinungswerte und kompatible Zubehörbindungen |
| `references`, `evidence` | Tatsächlich eingesetzte Referenzen und lokal überprüfbare Belegbytes mit Pfad, Medientyp und SHA-256 |
| `releaseReview` | Ergebnis der Sichtung des vollständigen zusammengesetzten Korpus mit tatsächlichem Prüfer und Beleg |

Die PNG-Prüfung dekodiert die tatsächlich vorliegenden Bildbytes und prüft
RGBA, Abmessungen, Palette, Raster, Transparenz, Rechtecke und Frameinhalt.
Ein im JSON behaupteter Hash oder eine angegebene Bildgröße ersetzt diese
Prüfung nicht. Unterschiedliche Framekennungen mit identischen Bildinhalten
können keinen geforderten Bewegungsablauf beweisen. Verschobene Crops dürfen
keinen Nachbarframe oder Beschriftungsrest in das Motiv übernehmen.

`ArtAtlasWorldPinV1` bindet `worldId`, `releaseId` und `manifestSha256` an
exakt die geprüften Manifestbytes. Der Pin kommt vom autorisierten Weltserver;
er wird nicht aus einem ungeprüften Manifest übernommen. Die getrennte
`ArtAtlasSignatureV1` führt `algorithm = ed25519`, `keyId`, `signedHash`
und `valueBase64`. Signiert werden die UTF-8-Bytes des hexadezimalen
SHA-256-Strings der **exakten** Manifestbytes. Das Manifest wird vor der
Hashbildung nicht neu serialisiert. Die Prüfung verwendet einen unabhängig
vertrauten öffentlichen Schlüssel.
Ein mit dem Manifest eingeschleuster Schlüssel ist keine Vertrauensgrundlage.
Ein Hash erkennt Veränderungen, authentifiziert aber keine Freigabe.
Eine Signatur authentifiziert den Inhalt, ersetzt aber kein fehlendes
Bild-, Herkunfts- oder Freigabegate. Die Prüffunktion schafft keine neuen
Schlüssel und keine neue Schlüsselverwaltung.

Der Node-Dateisystemeinstieg für den Weltserver ist
`loadArtAtlasFromDirectory({ directory, worldId, expectedPin, signature, trustedKeys })`
aus `@zugfolge/conductor-art`. Er liefert asynchron `LoadedArtAtlas` und liest
ausschließlich `manifest.json` sowie dessen streng geparste relative PNG- und
Belegpfade. Jede Pfadkomponente muss lokal und frei von symbolischen Links oder
Junctions sein; Verzeichnisausbruch, externe URLs und nichtreguläre Dateien
werden abgelehnt. Der Releaseordner ist ein vom Betreiber unveränderlich
bereitgestelltes Verzeichnis. Größen und Dateistabilität werden beim Lesen
geprüft: maximal 32 MiB Manifest, je 64 MiB PNG/128 MiB PNG gesamt und je
16 MiB Beleg/64 MiB Belege gesamt. Bei Fehlern erscheinen nur stabile
Fehlerkennungen, keine lokalen Pfade oder Dateiinhalte.

Dieser Einstieg liest weder einen beigelegten Vertrauensschlüssel noch einen
Weltpin oder eine Signatur automatisch ein. Diese drei Werte sind ausdrückliche,
unabhängig bereitgestellte Servereingaben. Die geladenen Bytes durchlaufen
unverändert `loadArtAtlasForWorld` mit sämtlichen Inhalts-, Freigabe-, Ed25519-
und Weltpinprüfungen. Der Dateieinstieg erzeugt keine Ersatzbilder oder
Freigaben. Seine Integrationstests lesen den wirklichen freigegebenen Korpus;
ihre temporären Testschlüssel und Testweltpins sind keine Produktivsignatur.

Der konkrete Signiereinstieg ist `tools/art-atlas/release.mjs`:

```sh
node tools/art-atlas/release.mjs --directory assets/conductor-art/v1 \
  --private-key /extern/art-private.pem --key-id art-release-key \
  --trusted-keys /extern/trusted-art-keys.json \
  --world-pin /extern/art-world-pin.json --world-id bestehende-welt \
  --output /ausgabe/art-signature.json
```

Die Pfade und Kennungen sind Eingabeplatzhalter, keine vorhandene
Produktionskonfiguration. Das unabhängig bereitgestellte Vertrauensverzeichnis
verwendet das bestehende JSON-Mapping `{ "Schlüsselkennung": "öffentlicher PEM" }`.
Der private Schlüssel muss extern vorliegen, Ed25519 verwenden und zu diesem
Eintrag passen. Der ebenfalls bestehende `ArtAtlasWorldPinV1` muss dieselbe
Weltkennung, Releasekennung und die exakten Manifestbytes pinnen. Vor dem
Signieren werden der aktuelle Builder-/Reviewstand und sämtliche tatsächlichen
Manifest-, Bild- und Belegbytes streng geprüft. Offene Freigaben, falsche Pins,
fremde Schlüssel und veränderte Inhalte erzeugen keine Signaturdatei.

Die CLI schreibt ausschließlich eine neue getrennte `ArtAtlasSignatureV1`;
bestehende Ausgabedateien werden nicht überschrieben. Sie erzeugt keine Schlüssel,
ändert kein Vertrauen, legt keinen Weltpin an und aktiviert keine Welt. Ihre
Ausgabe enthält nur öffentliche Kennungen und den Manifesthash. Private
Schlüssel bleiben außerhalb der Ausgabe und der Freigabebelege. Die zugehörigen
Tests verwenden ausdrücklich synthetische Inhalte und temporäre Testschlüssel;
sie sind kein Produktionssignaturnachweis.

## 4. Herkunft ohne erfundene Metadaten

`generation.prompt` bewahrt die tatsächlich gesendete Generierungsanweisung
wortgetreu. Der Generierungsbeleg enthält außerdem die tatsächlich verwendeten
Einstellungen und die konkrete Toolausgabe. Eine nachträglich geschriebene
Inhaltsbeschreibung ersetzt den Prompt nicht. Belege referenzieren die
vorliegenden Originalbytes samt SHA-256. Keine Referenz heißt eine ausdrücklich
leere `referenceIds`-Liste; unbenutzte Quellen werden nicht nachträglich als
Inspiration eingetragen.

Jede verwendete Referenz braucht Identität, konkrete Datei beziehungsweise
Quelle, Inhaltsprüfsumme, Nutzungsumfang und einen vorhandenen Rechtebeleg.
Fremde Spielgrafiken, reale Logos, reale Personen und ungeklärte Bildkopien
sind keine erlaubten Referenzen. Ein eigener Zugfolge-Asset ist nur dann eine
belegte Referenz, wenn genau diese Datei vorliegt und tatsächlich verwendet
wurde. Das [Rechte-Gate](rechte.md) und der [Rechteschutz](rechteschutz.md)
gelten weiter; ein neuer Atlas überschreibt keine Lizenzentscheidung.

`generation.model` trennt `provider`, `name`, `revision`, `verification`
und `evidenceId`. Nur eine in der realen Toolantwort, den unveränderten
Originalbildmetadaten oder einer konkreten Anbieterbescheinigung enthaltene
Modellversion darf als `provider_declared` erscheinen. Der Beleg hält
Originalbytes, Extraktionsweg und die wortgetreue Deklaration fest.
Eine `softwareAgent`-Angabe aus C2PA-Metadaten ist eine Anbieterdeklaration;
ohne eigene Vertrauenskette wird keine kryptografische C2PA-Verifikation
behauptet. Ebenso wird keine interne Modellrevision oder ein Gewichtehash
behauptet, den diese Angabe nicht enthält.
Gibt der Anbieter die Revision nicht aus, wird `provider_undisclosed`
mit `null` für die unbekannten Werte und dem tatsächlichen Befund dokumentiert.
Keine erfundene Datumsrevision, kein geratener Modellname, kein Hash des
Werkzeugnamens als vorgeblicher Modell-Digest: Ein Hash des Ausgabebilds
pinnt das Bild, nicht die Gewichte des Bildmodells.

Eine nicht belegte Modellrevision verhindert die vollständige
Herkunftsfreigabe. Sie verhindert nicht, einen Kandidaten zu erzeugen,
seine Bildbytes zu prüfen und visuell zu beurteilen. Der Releasebericht
benennt die verbleibende Grenze ausdrücklich.

## 5. Zulässige Nachbearbeitung

Freistellung, Crop auf vollständig vorhandene Motive, Rasterausrichtung,
Palettenquantisierung, ganzzahlige Größenprüfung, Pivot-/Kollisionsmetadaten,
Atlaspackung und verlustfreie Kompression sind technische Nachbearbeitung.
Jeder Schritt referenziert seine Eingabe- und Ausgabebytes, Werkzeugversion
und Parameter im Generierungsbeleg. Die Ableitung bleibt vom Original bis
zum ausgelieferten PNG nachvollziehbar. Das Manifest beschreibt die
**finalen** Bytes, kein früheres Vorschaubild.

Neue Gliedmaßen, Bewegungsphasen, Türen, Gebäudeteile, Schrift oder
Innenraummotive dürfen nicht als angebliche Rasterkorrektur hineingezeichnet
werden. Falsche oder unvollständige Motive werden neu generiert und erhalten
neue Herkunftsbelege. Keine zur Laufzeit erzeugte Ersatzfigur, kein externes
Bildmodell und keine automatisierte Netzabfrage schließen eine Korpuslücke.

## 6. Getrennte Freigabegates

Die vier Assetprüfungen `visual`, `logoAndText`, `contrast`, `provenance`
verwenden jeweils `pending`, `approved` oder `rejected`, außerdem
`reviewerId` und `evidenceId`. Ein Prüfer wird nur genannt, wenn er diese
Prüfung tatsächlich durchgeführt hat. Eine Prüfung durch Codex benennt
Codex; sie wird nicht als menschliche Sichtung ausgegeben. Prompt, Dateiname
und grüne Tests sind keine redaktionelle oder rechtliche Freigabe.

| Gate | Erforderlicher Nachweis |
|---|---|
| Struktur und Bytes | Schemas, vollständiger Pflichtkatalog, eindeutige Bindungen, PNG-Decodierung, Hashes, Rechtecke, Weltmaße, Palette und Raster |
| Figuren und Bewegung | Alle fünf Sets in allen Richtungen und Zuständen; vier unterschiedliche Gehphasen, lesbare Silhouette, konsistente Pivots und Zubehör |
| Module und Komposition | Vollständiger zusammengesetzter Zug mit Fahrgästen, kleine/mittlere/große Station sowie Umland/Vorstadt/Stadt; keine leeren oder falsch bezeichneten Kacheln |
| Logos und Schrift | Keine fremden Logos, Marken, realen Personen oder erfundenen Beschriftungen im Bild; Stationsnamen bleiben dynamischer Text |
| Kontrast und Zugänglichkeit | Figuren und Interaktionen auf Graphit, Plattformen und Umwelt lesbar; 3:1 für grafische Bedienhinweise, 4,5:1 für normalen Text; Zustand zusätzlich durch Text/Symbol |
| Herkunft | Vollständige Prompts, reale Referenz- und Modellbelege, dokumentierte erlaubte Ableitung und tatsächlich ausgeführte Herkunftsprüfung |
| Auslieferung | `approved`, übereinstimmender Welt-/Releasepin, gültige Signatur und lokale Dateien; beschädigte, unvollständige oder abgelehnte Releases werden nicht aktiviert |

Ein automatischer Validator kann Vollständigkeit und Inkonsistenzen
nachweisen, aber nicht aus eigener Kraft die Bildqualität oder Rechte
bestätigen. Fehlende oder abgelehnte Pflichtgates schließen eine wirksame
Freigabe aus. Eine bildlich vollständige, technisch korrekte Lieferung bleibt
Kandidat, solange ein erforderlicher Herkunfts- oder Freigabebeleg fehlt.
`ArtAtlasReportV1.activationEligible` bleibt in diesem Fall `false` und
seine `issues` nennen die tatsächlichen fehlenden Voraussetzungen.
Ein positives Inhaltsprüfergebnis ersetzt nicht die zusätzliche Signatur-
und Weltpinprüfung des Runtime-Laders.

## 7. Reproduzierbare visuelle Prüfung

Die Prüfansicht lädt die wirklichen finalen PNG-Dateien und Manifestdaten.
Sie zeigt eine beschriftete Kontaktübersicht aller Pflichtmotive, die fünf
Figuren in vier Richtungen und Animationszuständen, Zubehörkombinationen und
eine Komposition aus Zug, Fahrgästen, den drei Stationsklassen und den drei
Umgebungstypen. Es gibt kein stilles Ersatzmotiv bei Ladefehlern.

Mindestens eine native Ansicht bei Zoom 1 sowie ganzzahlige Vergrößerungen
zeigen das Pixelraster. Die Browserprüfung hält auch eine schmale Ansicht
bei 390 Pixeln fest; die Prüfansicht erlaubt Zugang zum ganzen Katalog durch
bedienbare Navigation oder Scrollen. Das ist eine Assetabnahme, keine
Behauptung des späteren spielbaren Touch-Schaffnermodus. Reduzierte Bewegung
stoppt Animationen auf den passenden Ruheposen. Alle Screenshots nennen
Releasehash, Ansicht und verwendeten Zoom im zugehörigen Prüfbericht.

Sinnvolle Negativprüfungen sind fehlende Pflicht-ID, doppelte Personenzuordnung,
fehlende Richtung oder Gehphase, identische Gehphasen, falscher Dateihash,
PNG-/JSON-Größenabweichung, Rechteck außerhalb des Bilds, falsches Weltmaß,
gebrochener Rasterblock, unerlaubte Farbe/Alpha, ungeklärte Modellversion,
fehlende Referenzfreigabe und `approved` trotz ausstehender Prüfungen.

## 8. Abnahme und Grenzen

Der Auftraggeber hat den gelieferten v2-Korpus mit **186 Motiven/Frames und
acht Referenzen** einschließlich Asset-, Referenzrechte- und Releasefreigaben
ausdrücklich freigegeben. Diese Entscheidungen sind an den geprüften Inhalt
gebunden und mit ihrem tatsächlichen Beleg in der Lieferung dokumentiert.
Die strenge Inhaltsprüfung ist grün: `activationEligible: true`, `issues: []`.
Reproduzierbare Befehle und tatsächlich gemessene Ergebnisse stehen im
Atlas-Prüfbericht. Eine erneute allgemeine Freigabe wird dafür nicht benötigt.

Der [Prüfnachweis des vorhandenen Korpus](art-atlas/README.md) verlinkt
den vollständigen Korpus, Herkunftsbelege, die lokale Galerie und tatsächliche
Browserbilder. Für den produktiven Abschluss fehlen noch der extern
bereitgestellte Art-Signierschlüssel, sein unabhängig vertrauter öffentlicher
Eintrag, ein bestehender passender Weltpin und die damit erzeugte gültige
Signatur. Diese Eingaben werden weder aus anderen Releases übernommen noch
automatisch erzeugt. Der vorbereitete Signiereinstieg ist ein prüfbares Werkzeug;
er behauptet keine bereits erfolgte Signierung oder Aktivierung.

M15.4 [#214](https://github.com/larynxberlin-rgb/Zugfolge/issues/214) bleibt
für die aus Fahrzeugkonfigurationen abgeleitete begehbare Innenraumgeometrie
zuständig. M15.5 [#215](https://github.com/larynxberlin-rgb/Zugfolge/issues/215)
bindet Stationen und Umgebung an Weltrelease, Urbanität, Tageszeit und
tatsächliche Bewegung. M15.6 [#216](https://github.com/larynxberlin-rgb/Zugfolge/issues/216)
liefert den Dialogkorpus; M15.7/M15.8 liefern Sitzung und Spielerbedienung.
Ein vollständig sichtbarer Atlas ersetzt keine dieser Integrationen.

Die unverändert offenen M10-Haltquittungen und M15.2-Spielnachweise stehen in
der [M15.1/M15.2-Teilabnahme](m15-abnahme.md). Die gemeinsame UI aus
[#531](https://github.com/larynxberlin-rgb/Zugfolge/pull/531) und deren
Dokumentationsgrafiken ersetzen keinen der 172 Pflichtbestandteile.
