# M14.1 — Auswahl der Alpha-Region Mitteldeutschland

**Status: M14.1 am 12.08.2026 technisch und fachlich abgenommen; Variante B
und produktive Release-Verantwortung ausdrücklich freigegeben.** M14.2–M14.4
und damit M14 insgesamt bleiben offen. Der reale Start der geschlossenen Alpha
ist weiterhin die gesonderte Abnahme M9.9.

Dieses Dokument macht die bislang unbestimmte Bezeichnung
„Mitteldeutschland“ für M14.1 entscheidbar. Es ersetzt weder den späteren
Coverage-/Rechtebericht noch die Messung des fertigen Imports. Die Vorziehung
in die Alpha ist mit [ADR-0024](adr/0024-erweiterter-alpha-schnitt.md) bindend;
die konkrete Variante wurde als Mitteldeutsches Metropol-Korridornetz gewählt.

## Verbindliche Auswahl

Für die geschlossene Alpha gilt **Variante B — Mitteldeutsches
Metropol-Korridornetz**. Die freigegebene äußere Grenze wird als versioniertes
GeoJSON durch die Grenzbetriebsstellen Eisenach Hbf, Nordhausen, Magdeburg
Hbf, Lutherstadt Wittenberg Hbf, Riesa, Chemnitz Hbf, Zwickau Hbf und Saalfeld
(Saale) festgeschrieben. Innerhalb liegen ausschließlich zusammenhängende
EBO-SPNV-Strecken. Grenzüberschreitende Fahrten wechseln ausschließlich an
einem im Release benannten Grenzportal in die deterministische `ExternalZone`;
ein nur am ersten Außenknoten erkannter Schnitt bleibt Klasse C und ist nicht
bestellbar. Eine nachträgliche Erweiterung dieses Polygons ist ein eigener
Scope- und Release-Wechsel und nicht Teil derselben Freigabe.

## Gemeinsame Regeln

Unabhängig von der Variante gelten E14, E22 und E25: ausschließlich EBO-Netz, ein
jährlich gepinnter Offline-Import, Klasse C sichtbar aber nicht bestellbar und
keine externe Quelle im heißen Pfad. Der GTFS-Compiler erhält den vollständigen
Zuglauf und erzeugt eine `JourneyChain` aus regionalen Abschnitten,
Grenzportalen und Außenläufen. Fahrzeug, Personaldienst, Zugfahrt, Anschluss,
Trasse und Event behalten dabei `world_id` und einen eindeutigen
Übergabeverweis. Spieler planen nur die regionalen Abschnitte gegen sichtbare,
unveränderliche Grenzfenster des gepinnten Release.

Die Region wird nach Freigabe als versioniertes GeoJSON aus Verwaltungsgrenzen,
Korridorpuffern und Grenzbetriebsstellen festgeschrieben. Eine Bounding Box
dient nur der nachstehenden Vorabschätzung und niemals als Importfreigabe.

## Varianten

### A — Revierkern mit Thüringer Achsen

Messbare Grenze: Vereinigung der neun Gebietskörperschaften des
„Mitteldeutschen Reviers“ — Anhalt-Bitterfeld, Mansfeld-Südharz, Nordsachsen,
Saalekreis, Landkreis Leipzig, Burgenlandkreis, Altenburger Land sowie die
Städte Halle (Saale) und Leipzig — mit einem 5-km-Korridorpuffer um die
EBO-Strecken Naumburg Hbf–Weimar Hbf–Erfurt Hbf und
Leipzig Hbf–Zeitz–Gera Hbf–Jena-Göschwitz–Weimar Hbf. Der Puffer nimmt nur
verbundene Eisenbahninfrastruktur auf, keine zusätzliche flächige Region.

- **Betriebsstellen/Grenzen:** Köthen Hbf, Dessau Hbf, Lutherstadt Wittenberg
  Hbf, Torgau, Oschatz, Altenburg, Gera Hbf, Jena-Göschwitz, Erfurt Hbf und
  Sangerhausen; Kernknoten Leipzig Hbf, Halle (Saale) Hbf, Bitterfeld,
  Merseburg, Naumburg (Saale) Hbf und Weimar Hbf.
- **Korridore:** Leipzig–Halle, Leipzig/Halle–Bitterfeld–Köthen,
  Halle–Sangerhausen, Halle–Naumburg–Erfurt, Leipzig–Naumburg,
  Leipzig–Zeitz–Gera, Leipzig–Altenburg, Gera–Jena–Weimar sowie die SPNV-Äste
  innerhalb der neun Gebietskörperschaften.
- **GTFS-Vorabschätzung:** 525 Parent-Stationen und 2.679 aktive Fahrten, die
  am Mittwoch, 12.08.2026, den rechteckigen Vorfilter 10,90–13,30° Ost und
  50,75–51,95° Nord berühren. Der exakte GeoJSON-Clip wird kleiner oder gleich
  dieser flächigen Obergrenze gemessen.
- **Daten/Importkosten:** voraussichtlich 220–320 MB OSM-PBF vor dem
  EBO-Filter, etwa 45–60 % des Drei-Länder-Imports bei CPU, RAM und
  Kartenbau. Tatsächliche Werte werden nach Auswahl gegen Leipzig–Halle–Erfurt
  gemessen.
- **Eignung:** behält die bestehende Pilotachse, erzeugt zwei belastbare
  Thüringer Übergaben und genügend parallele Märkte für 20–50 Spieler, ohne
  Dresden, Magdeburg und das gesamte Randnetz bereits mitzutragen.

### B — Mitteldeutsches Metropol-Korridornetz (ausgewählt)

Messbare Grenze: ein versioniertes Polygon durch die äußeren
Grenzbetriebsstellen Eisenach Hbf, Nordhausen, Magdeburg Hbf, Lutherstadt
Wittenberg Hbf, Riesa, Chemnitz Hbf, Zwickau Hbf, Saalfeld (Saale), ergänzt um
alle innerhalb liegenden zusammenhängenden EBO-SPNV-Strecken. Linien werden an
diesen Betriebsstellen oder am ersten Knoten außerhalb übergeben.

- **Betriebsstellen/Korridore:** zusätzlich zu A insbesondere
  Magdeburg–Halle/Leipzig, Wittenberg–Bitterfeld/Leipzig,
  Leipzig–Riesa, Leipzig–Chemnitz, Leipzig–Zwickau,
  Gera–Saalfeld, Erfurt–Eisenach und Erfurt–Nordhausen.
- **Ausgeführter Snapshot:** 1.819 aktive Services und 42.567 aktive Fahrten
  am 12.08.2026; davon berühren 2.690 das Polygon. Nach Service-Scope- und
  Rechtefilter bleiben 2.480 spielbare Segmente, 1.931 Außenläufe und 1.675
  grundsätzlich bestellbare Fahrtketten an 426 GTFS-Parent-Stationen. Die
  Infrastrukturqualifizierung gibt davon 1.634 Fahrtketten tatsächlich frei.
- **Daten/Importkosten:** voraussichtlich 360–470 MB OSM-PBF vor Filter,
  etwa 70–85 % des Drei-Länder-Imports. Mehr Grenzübergaben und deutlich mehr
  Eigenbetriebsformationen als A.
- **Eignung:** breiter und anschaulicher, aber für 20–50 Alpha-Spieler bereits
  weniger dicht besetzt und bei Weltstart, Soak, PMTiles und manueller
  Datenqualifizierung teurer.

### C — vollständiges Drei-Länder-Gebiet

Messbare Grenze: die amtlich/geografisch veröffentlichten Ländergrenzen von
Sachsen, Sachsen-Anhalt und Thüringen. Das entspricht der Satzungsdefinition
der Europäischen Metropolregion Mitteldeutschland; regionale Übergaben liegen
an jedem EBO-Grenzschnitt zu Brandenburg, Berlin, Niedersachsen, Hessen,
Bayern, Tschechien und Polen.

- **Betriebsstellen/Korridore:** sämtliche EBO-SPNV-Knoten der drei Länder,
  darunter Dresden, Görlitz, Plauen, Zwickau, Chemnitz, Leipzig, Halle,
  Magdeburg, Stendal, Erfurt, Eisenach, Nordhausen, Jena, Gera und Saalfeld.
- **GTFS-Vorabschätzung:** 1.414 Parent-Stationen und 4.829 aktive Fahrten am
  12.08.2026, punkt-in-Polygon gegen die drei Geofabrik-Länderpolygone.
- **Daten/Importkosten:** die Upstream-PBFs vom 10.08.2026 umfassen zusammen
  599.256.750 Byte (Sachsen 266.912.848, Sachsen-Anhalt 173.361.775,
  Thüringen 158.982.127). Das ist der 100-%-Vergleich für Import, Filter und
  Kartenbau und erzeugt die meisten Grenzübergaben.
- **Eignung:** begrifflich am eindeutigsten und später wiederverwendbar, für
  20–50 Alpha-Spieler aber voraussichtlich zu groß und zu teuer vollständig zu
  qualifizieren und mit dichtem Eigenbetrieb zu betreiben.

## Quellen, Rechte und Datenqualität

- OSM-Geometrie: die aktuellen Geofabrik-Extrakte für
  [Sachsen](https://download.geofabrik.de/europe/germany/sachsen.html),
  [Sachsen-Anhalt](https://download.geofabrik.de/europe/germany/sachsen-anhalt.html)
  und [Thüringen](https://download.geofabrik.de/europe/germany/thueringen.html),
  ODbL; der konkrete Extract, Zeitstempel und SHA-256 werden im InfraRelease
  gepinnt.
- Planungsfahrplan: [GTFS.DE Regionalverkehr](https://www.gtfs.de/de/feeds/de_rv/),
  bereitgestellt von DELFI e.V. unter CC BY 4.0. Der produktive Snapshot pinnt
  den am 10.08.2026 erzeugten Feed mit
  SHA-256 `c0cba1cfdbf6179b18e529b13613644e861f1ea6159fa5788c2045de82bea738`;
  Original-ZIP und normalisiertes Ergebnis sind getrennt archiviert.
- Begriffsvarianten: Der
  [Revierkompass](https://www.mitteldeutschland.com/wp-content/uploads/2022/06/strategiepapier_irmd_revierkompass.pdf)
  benennt die neun Gebietskörperschaften aus Variante A. Die
  [Vereinssatzung](https://www.mitteldeutschland.com/wp-content/uploads/2022/10/140317-emmd_satzung_neues_cd.pdf)
  definiert Mitteldeutschland im Vereinszweck als Sachsen, Sachsen-Anhalt und
  Thüringen und stützt Variante C.
- Stationsstammdaten stammen ausschließlich aus der gepinnten
  Trassenfinder-Infrastruktur 7 für das Fahrplanjahr 2026. Ein versionierter
  Copernicus-DEM-Snapshot wurde nicht importiert; deshalb werden keine Höhen
  geraten und kein Abschnitt als Klasse A behauptet.
- Qualitätsklasse A/B/C wird abschnittsweise aus Quellenübereinstimmung,
  Pflichtattributen, Topologie-, Coverage- und Fahrplanprüfung abgeleitet.
  Keine Variante erhält pauschal eine bessere Klasse. Klasse C bleibt sichtbar,
  aber nicht bestellbar.

## Umsetzung von Linien über die Spielgrenze

Eine GTFS-Linie wird an der Grenze nicht gekürzt und auch nicht als zweite
Zugfahrt erfunden. Der Import erzeugt eine stabile `JourneyChain`. Im
Spielbereich enthält sie voll planbare regionale Abschnitte; außerhalb liegt
ein deterministischer `ExternalLeg` derselben Zugfahrt. Das Fahrzeug, der
Personaldienst, die Anschlussbindungen und die wirtschaftliche Verantwortung
bleiben während des Außenlaufs gebunden.

Für den Spieler ist die Planung damit logisch:

1. Im Bildfahrplan und Bestellformular erscheinen das letzte beziehungsweise
   erste Grenzportal, das verbindliche Ausfahrts- und Rückkehrfenster sowie
   die außerhalb nicht editierbare Fahrzeit.
2. Der Spieler bestellt nur die qualifizierten Innenabschnitte. Außerhalb
   werden weder Trassen noch Betriebsstellen vorgetäuscht; Kosten,
   Mindestwende und Bindungen kommen aus dem gepinnten Release.
3. Beim Ausfahren wird der Zug aus der regionalen Konfliktbelegung genommen,
   bleibt aber als Außenlauf in Livemap und Betriebszentrale sichtbar. Die
   Rückkehr reserviert zuerst die benannte Übergaberessource und wird erst
   danach materialisiert.
4. Ist ein Portal nicht eindeutig oder nur Klasse C, bleibt die Fahrt sichtbar,
   aber nicht bestellbar. Eine Verspätung außerhalb verschiebt die Rückkehr
   erklärbar innerhalb des Release-Fensters; sie erzeugt niemals heimlich
   Kapazität im Spielbereich.

Der Tageskatalog wiederholt für jeden Betriebstag 1.634 Materialisierungen,
909 Grenzkommandos und genau einen Bereinigungspunkt mit eindeutigen
Tageskennungen. Damit bleiben auch mehrtägige Spielerplanungen konsistent.

## Qualifizierter InfraRelease und Abnahme

Der freigegebene Release
`tools/region-import/releases/mitteldeutschland-b-2026-08.release.json` bindet
fünf Originalquellen, alle Pipeline-Skripte und sechs Ergebnisartefakte. Die
drei historischen Geofabrik-PBFs vom 10.08.2026 und das GTFS-Original sind im
getrennten Evidenzspeicher dauerhaft archiviert. Der vollständige Prüfer hat
alle Quellen und Artefakte erneut bytegenau gelesen:

- Release: `infra-mitteldeutschland-b-2026.1`
- SHA-256: `9c44c17c887f0960402ea01ece7c08127cfb802efcf9c43ecd6d02c381c37e17`
- Ed25519-Schlüssel: `zugfolge-alpha-2026`; Signatur gültig
- Verantwortung: Sebastian Barowski, ausdrücklich freigegeben am 12.08.2026
- Validierung: 12.505 von 12.505 Prüfungen bestanden, getrennt vom
  Kalibrierungsbestand; Hash
  `536ae6978dd2dc46eee287f2368f269e75385bb578b4fc81d71c5132d740dfcd`

Der EBO-Filter enthält 45.440 Knoten und 47.614 konservative Blöcke. Aus
51.066 Fahrstraßen und 1.654 Konfliktressourcen entstehen 2.373 betriebliche
Klasse-B- und 107 sichtbare, nicht bestellbare Klasse-C-Segmente. Die rohe
Abschnittsklassifikation umfasst 27.315 B- und 20.299 C-Abschnitte; Klasse A
bleibt wegen des bewusst fehlenden Höhen-/Neigungsnachweises null. 18.732
nicht-EBO- oder unzulässige Kanten, darunter 11.932 Straßenbahnobjekte, wurden
ausgeschlossen.

Der signierte öffentliche Weltentwurf besitzt den Hash
`15037068cebd8997346d27c79fdbfc8e5367e86c2516683cb358632b73a9b6b4`.
Er startet 49 Lose, 1.634 Zugfahrten, 487 Umläufe, 487 Fahrzeuge, 487
Personaldienste und 1.634 Trassen im Eigenbetrieb. Ein echter Start gegen
PostgreSQL 16.14, PostGIS 3.4.2 und das Linux-NAPI-Addon erreichte `running`;
Livemap, Betriebszentrale und Odoo-Outbox waren vollständig und der zweite
Start idempotent. Backup und Restore enthielten jeweils 46 Tabellen und 10.143
Zeilen mit identischem Gesamtzustands-Hash
`04563c570d0943f7c8a43d0f3cc4c789a31a80e18575563c24345dfbf4e57531`.

Der vollständige 24-Stunden-Simulationslauf verarbeitete alle 909
Grenzübergänge ohne Ressourcenkonflikt und lieferte nach Restore denselben
Zustands-Hash
`25b65c6ff5c06013bb52ad37ba57ff6e08d9831af471d27e7f8121d38cfda6be`.
Die 4.596.259 Byte große PMTiles-Datei (Zoom 5–14, 5.339 Tiles) hat SHA-256
`b893c7a36ea9169229ee305efeace9a93f5816b033ec6f6b6f660c82a1581965`.

## Last- und Speichervergleich

Der gleiche Release-Build des Simulationskerns wurde mit durchschnittlich
zwölf Wegpunkten je Zug gemessen. Der bisherige Pilot mit 85 Zügen erzeugte
2.210 Ereignisse in 702 µs bei 966.192 Byte Peak-Heap. Variante B mit 1.634
Zügen erzeugte 42.484 Ereignisse in 14.655 µs bei 16.803.906 Byte Peak-Heap.
Der Durchsatz sank von 3.148.148 auf 2.898.942 Ereignisse/s; Zugzahl und
Speicher stiegen um etwa Faktor 19 beziehungsweise 17,4. Diese Messung ist
eine technische Lastabnahme, kein Ersatz für die reale 20–50-Spieler-Abnahme
aus M9.9.

## Abweichungs- und Rechtebericht

- OSM/Geofabrik: ODbL 1.0, Attribution im Release und in der Karte.
- GTFS.DE/DELFI: CC BY 4.0, Originalfeed und Normalisierung gepinnt.
- Trassenfinder-Infrastruktur: ausschließlich die in E22 freigegebene jährliche
  Stammdatennutzung; kein Zugriff im heißen Pfad.
- Kein Höhenartefakt im Release, daher keine behauptete Klasse A.
- 12 Stationszuordnungen bleiben außerhalb der Matching-Toleranz; 107
  betroffene betriebliche Segmente sind deshalb Klasse C und nicht bestellbar.
- 1.157 GTFS-Grenzfälle bleiben im Planungssnapshot sichtbar, werden aber
  nicht in die 1.634 bestellbaren Fahrtketten übernommen.
- Der ODbL-abgeleitete Datenbestand und die proprietäre Fleet-Quelle liegen
  getrennt vom Source-Available-Repository; Manifest, Code, Hashes und
  Rechtebericht bleiben versioniert im Repository.
