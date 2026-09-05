# Technische Sichtung des Grafikkandidaten

Prüfer: Codex, im Auftrag zur Bearbeitung von M15.3, 06.09.2026.
Dies dokumentiert ausgeführte Prüfungen und ist keine produktive Signierfreigabe.

## Herkunft

Alle verwendeten Originalbilder wurden für diesen Auftrag mit dem integrierten
Werkzeug `image_gen.imagegen` erzeugt. Keine externen Spielgrafiken wurden als
Vorlagen importiert. Die tatsächlichen Prompts stehen neben den Originalen in
`sources/`; eigene Referenzbilder sind im Manifest einzeln mit Hash benannt.

Die Original-PNGs deklarieren in `c2pa.actions.v2` den Software-Agenten
`gpt-image`, Version `2.0`. `prepare.py` liest diesen Eintrag aus den vorhandenen
CBOR-Bytes. Die Generierungsbelege enthalten Originalhash, Metadatenhash,
dekodierten Eintrag und Prompt. Das ist eine belegte Providerdeklaration,
keine Prüfung der C2PA-Zertifikatskette oder Aussage über interne Modellgewichte.

Die technische Aufbereitung per Skript wurde vom Auftraggeber ausdrücklich
bestätigt: „Ja, technisch aufbereiten“. Motive werden weder gezeichnet noch
inhaltlich ergänzt. Originale bleiben unverändert.

## Tatsächlich geprüfte und korrigierte Bildfehler

- Der erste Innenraumentwurf `sources/interior.png` zeigte ungeeignete
  Frontansichten. Er ist ein verworfener Entwurf und wird nicht im Atlas genutzt.
  `sources/interior-topdown.png` wurde neu erzeugt und zeigt Grundriss-Motive.
- Uneinheitliche Figurenabstände führten zunächst zu angeschnittenen Köpfen.
  Quellausschnitte folgen jetzt den transparenten Lücken je Spalte; die
  aufbereiteten fünf Figurenbögen wurden anschließend vollständig gesichtet.
- Die Sitzrichtungen wurden nach den tatsächlich gelieferten Bildern zugeordnet:
  Süd, West, Nord, Ost. Es wurden keine Richtungen durch Spiegeln ersetzt.
- Die ungleichen Bahnhofsspalten haben geprüfte eigene Quellrechtecke.
  Umgebungsausschnitte wurden von Dachkanten benachbarter Zeilen getrennt.
- Unklare Nord-/Südansichten von Rollstuhl und Kinderwagen wurden neu erzeugt.
  Auch deren ungleiche Zeilenabstände werden vor der Aufbereitung erkannt.
  Abschließend wurden alle zwölf Zubehörausschnitte auf Nachbarfragmente geprüft.

Die aufbereiteten Figuren, Sitzposen, Innenraummodule, Wagen, Bahnhofsklassen,
Umgebungen und Zubehör wurden als echte PNG-Ausschnitte gesichtet. In dieser
Sichtung wurden keine erkennbaren fremden Logos oder lesbaren Markenschriftzüge
gefunden. Das Mobilitätssymbol im Wagen ist ein grafischer Hinweis, kein
betrieblicher Zustandsbeleg. Signalbilder unterscheiden sich zusätzlich durch
Strich bzw. Winkel; der spätere Betrieb benötigt weiterhin seine Textauskunft.

## Grenzen und anschließende Freigabe

Die technische Pipeline prüft den vollständigen Katalog aus 172 Motiven und
60 Animationssequenzen, unveränderte Bytes/Hashes, PNG-Struktur, Alpha, feste
Palette und das logische 32-Pixel/Meter-Raster. Die Browsergalerie rendert diese
Dateien und bleibt ausdrücklich eine Grafikprüfung ohne laufende Spielwelt.

Die expliziten Manifestfreigaben, Referenzrechtefreigaben und produktive
Ed25519-Signatur bleiben ausstehend. Es wurde kein Produktionsschlüssel erzeugt,
kein Weltpin verändert und kein Kandidat als freigegeben aktiviert. Ein
berechtigter Release-Review muss die vorgesehenen Einträge in `review.json`
mit Belegen ausfüllen; anschließend wird das Manifest neu gebaut, streng geprüft
und über seinen exakten Dateihash signiert. Die vorhandene Weltladegrenze lehnt
den Kandidaten bis dahin ab.

## Bindung der gesichteten Dateien

Prepared-SHA256: 77fcbfefe8d20c67f24a2f356cdca9a0c9dbf0e4e373f74a398c30c7f720fc4e

- atlases/passenger-red.png: 7f0cd9c264bc5404d957675bc84ed886039dc84f2faab54b8e8d8a1e72b4b346
- atlases/passenger-teal.png: 3aaadd3f90131877bd5f482c6d96b292b8f42471ef699bf4c4ea0e8cdd9c33ad
- atlases/passenger-amber.png: e781ead10d891f00ea99b744c2232441311bb70b8b53b1a5ab3c99fb7653ad04
- atlases/passenger-slate.png: c1807f78b0318d07ec1000004a4035600f82640f211c6455e04acec2ee998480
- atlases/conductor.png: e42490973eb0ea458a500b0b5278382d48fdbcdd1ed83424263151d1422a8c4a
- atlases/modules.png: 9ddda097bed0c264600f1416cf3b7ce708e56201096be699cbb6e316ded1eb3c
