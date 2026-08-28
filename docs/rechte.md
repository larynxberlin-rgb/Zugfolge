# Rechte-Gate — Freigabestatus je Datenquelle

Ergebnis von **M0.4**. Setzt die harte **Invariante 8** durch: *Kein Import ohne
dokumentierte Rechtefreigabe.* Ohne geklärte Rechte darf kein Import beginnen —
deshalb steht dieser Schritt vor M1.

Dieses Dokument trägt die Herleitung und den Prozess. Die maßgebliche, von der
CI geprüfte Wahrheit ist das maschinenlesbare **Quellenregister**
[`tools/guards/quellenregister.json`](../tools/guards/quellenregister.json).
Bei Widerspruch gilt das Register; dieses Dokument erklärt es.

> Verwandte Dokumente: [`daten.md`](daten.md) (was die Quellen liefern, ODbL),
> [`rechteschutz.md`](rechteschutz.md) (die eigene Lizenz, Marke und
> Schichtentrennung — die andere Richtung: was wir schützen, statt was wir
> nutzen dürfen).

---

## 1. Wie das Gate funktioniert

Das Gate hat zwei Hälften, und der Wächter `rights-gate` prüft beide.

**Erste Hälfte — das Register muss halten, was es verspricht.** Jede Quelle
trägt einen Freigabestatus. Ein Status `freigegeben` ist nur dann eine Freigabe,
wenn Lizenz, Bereitstellungsweg **und eine datierte Entscheidung** (Datum,
Prüfer) danebenstehen. Fehlt eines davon, ist „freigegeben" ein Wort ohne
Deckung, und der Wächter schlägt an. Diese Hälfte greift ab heute.

**Zweite Hälfte — kein Import zieht an einer nicht freigegebenen Quelle.** Ein
Import kennzeichnet seine Herkunft mit einem Marker im Code oder in der
Konfiguration:

```text
zugfolge:quelle=osm-pbf-lhe
```

Der Wächter sammelt jeden solchen Marker im Arbeitsbaum und prüft, dass die
genannte Quelle im Register steht **und** dort `freigegeben` ist. Ein Marker auf
eine unbekannte oder nicht freigegebene Quelle bricht die CI.

Diese zweite Hälfte griff bis M1.2 ins Leere — es gab noch keinen Import. Seit
der Import-Pipeline OSM-PBF → Rohgraph trägt der Marker in
`crates/zugfolge-infra/src/import/pipeline.rs`; der Wächter prüft ihn bei
jedem Lauf gegen das Register. Genau wie der Wächter `world-id`, der schon vor
der ersten Tabelle stand, hat sie so die Rechtefrage unumgehbar gemacht, bevor
der erste Import entstand, statt sie nachträglich einzuziehen.

---

## 2. Das Statusmodell

| Status | Bedeutung | Import erlaubt? | Was der Wächter verlangt |
|--------|-----------|-----------------|--------------------------|
| `freigegeben` | Import und Nutzung sind entschieden erlaubt | **ja** | Lizenz **und** datierte Entscheidung (Datum, Prüfer) |
| `entwicklung` | nur als Kalibrier-, Validierungs- oder Interpretationsreferenz der Entwicklung, nie als Laufzeit- oder Importquelle | nein | Entscheidung und Hinweis |
| `pruefung` | in Prüfung, noch nicht nutzbar | nein | Hinweis mit den offenen Punkten |
| `gesperrt` | bis zu einer schriftlichen Entscheidung oder einem Vertrag blockiert | nein | Hinweis mit der Bedingung |
| `ausgeschlossen` | durch Entscheidung ausgeschlossen | nein | Entscheidung und Hinweis mit Begründung |

Der Unterschied zwischen `entwicklung` und `freigegeben` ist der Kern der
Trennung: Eine `entwicklung`-Quelle darf ein Mensch beim Bauen ansehen, aber
keine Zeile Import darf sie ziehen. So bleibt der Trassenfinder ein
Kalibrierwerkzeug (E10) und wird nie eine Laufzeitabhängigkeit.

---

## 3. Die Quellen

Vollständig mit Bereitstellungsweg, Attribution und Hinweis im Register. Hier
der Überblick; die Spalte `id` ist die Kennung, die auch der Importmarker nennt.

| `id` | Quelle | Status | ab |
|------|--------|--------|----|
| `osm-pbf-lhe` | OSM-PBF-Extract Leipzig–Halle–Erfurt | `freigegeben` | M1.2 |
| `osm-pbf-mitteldeutschland-b` | OSM-PBF-Extract der freigegebenen Alpha-Variante B | `freigegeben` | M14.1 |
| `osm-pbf-deutschland` | OSM-PBF-Extract Deutschland | `freigegeben` | M14.2 |
| `osm-planet-basemap` | OSM Planet PBF für die selbst gehostete Welt-Basiskarte | `freigegeben` | M14.2 |
| `protomaps-daily-basemap` | gepinnter Protomaps-OSM-Tagesbuild für die selbst gehostete Welt-Basiskarte | `freigegeben` | M14.2 |
| `noto-glyphs` | selbst gehostete Noto-Sans-Glyphen aus Protomaps basemaps-assets (OFL-1.1) | `freigegeben` | M14.2 |
| `protomaps-sprites` | selbst gehostete Protomaps-v4-Sprites aus Tangrams-Icons (MIT) | `freigegeben` | M14.2 |
| `apn-validierung` | APN-Skizzen, nur interne Topologievalidierung | `entwicklung` | M9.10/M14.2 |
| `db-infrago-infrastrukturdaten-open-data` | offizieller DB-InfraGO-Infrastrukturdatenbestand | `freigegeben` | M9.10/M14.2 |
| `openrailwaymap-doku` | OpenRailwayMap — Tagging- und Signaldokumentation | `entwicklung` | M1.6 |
| `openstation` | OpenStation — Stationsdaten | `freigegeben` | M1.8 |
| `stada` | StaDa — Stationsdaten | `freigegeben` | M1.8 |
| `dem-hoehenmodell` | Digitales Höhenmodell der Pilotregion | `freigegeben` | M1.5 |
| `trassenfinder` | Trassenfinder — Trassenpreis- und Fahrzeitstruktur | `entwicklung` | M1.13 |
| `gtfs-de-rv` | GTFS.DE/DELFI — Schienenregionalverkehr Deutschland | `freigegeben` | M1.13 |
| `trassenfinder-infrastruktur-api` | Trassenfinder-Infrastruktur-API — historische interne Lineageprüfung | `entwicklung` | M9 |
| `entgeltregeln-tps-sps-aps-inb` | Entgeltregeln (TPS, SPS, APS, INB, Anlagen-/Stationspreise) | `gesperrt` | M6.1 |
| `baustellen-stoerungsfeeds` | reale Baustellen- und Störungsfeeds | `gesperrt` | M8.12 |
| `strecken-info-public` | öffentliche Infrastruktur-Einschränkungen | `freigegeben` | M8.12 |
| `tages-la-referenz-2026-08-09` | fünf private Tagesausgaben, nur aggregierte Entwicklungsreferenz | `entwicklung` | M8 |
| `einschraenkungsliste-referenz-2026-08-11` | private Einschränkungsliste, nur Wirkungstaxonomie | `entwicklung` | M8 |
| `bundesnetzagentur-marktuntersuchung-eisenbahnen-2025` | amtliche Marktuntersuchung, nur eigene statistische Ableitung | `entwicklung` | M8 |
| `db-infrago-ril-420-9001` | Ril 420.9001, nur Haupt-/Feincode-Referenz | `entwicklung` | M8 |
| `bundestag-20-6736-spnv-stoerungsquoten` | amtliche technische Störungsquoten je SPNV-Zugfahrt | `entwicklung` | M8 |
| `bundestag-21-29-pilotregion-infrastrukturstoerungen` | amtliche Infrastrukturfallzahlen regionaler Netze | `entwicklung` | M8 |
| `bundestag-20-3024-haltezeitueberschreitungen` | amtliche Halte- und Zusatzverspätungsmengen im SPNV | `entwicklung` | M8 |
| `fahrdienstvorschrift-408-inb-2026` | Fahrdienstvorschrift 408, nur eigene ausführbare Regelauslegung | `entwicklung` | M8 |
| `rinf` | RINF — Register of Infrastructure | `gesperrt` | — |
| `pathos` | pathOS | `ausgeschlossen` | — |
| `tpn` | TPN — Trassenportal Netz | `ausgeschlossen` | — |
| `oeffentliche-tiles-nominatim` | öffentliche OSM-/ORM-Tiles und öffentliches Nominatim | `ausgeschlossen` | M4.7 |

**Was heute trägt.** `osm-pbf-lhe` und die davon rechtlich gleichartigen, aber
artefaktseitig getrennt geführten Quellen `osm-pbf-mitteldeutschland-b`,
`osm-pbf-deutschland`, `osm-planet-basemap` und der tatsächlich für das
2026er Kartenpaket verwendete `protomaps-daily-basemap` sind
`freigegeben` — die ODbL erlaubt Nutzung
mit Namensnennung und Share-alike, und mehr braucht die Pilotregion für
Geometrie und Railway-Tags nicht. Der Mitteldeutschland-Eintrag bindet die am
11.08.2026 ausgewählte Variante B an die drei versionierten
Geofabrik-Länderextrakte und führt abgeleitete Daten außerhalb des
Projektquelltextes. Das ist Absicht: `daten.md` verlangt, dass die
Region **allein mit OSM-Extract und eigenen Regeln** spielbar ist. Ergänzend
sind `openstation` (CC0), `stada` (CC BY 4.0) und `dem-hoehenmodell` (Copernicus
DEM Data Access and Use Terms) seit dem 2026-08-08 `freigegeben` — die Rechte
sind geklärt, konkreter Bezugsweg, Version, Prüfsumme, Attributionstext und
Feldmapping werden erst beim jeweiligen Import (M1.8 beziehungsweise M1.5) im
`InfraRelease` festgehalten, wie schon bei `osm-pbf-lhe`. Der frühere
Freigabeclaim für `trassenfinder-infrastruktur-api` ist mit dem
2026.3-Jahresvertrag zurückgenommen: Öffentliche Erreichbarkeit ohne
veröffentlichte Nutzungsbedingungen trägt weder Import noch Auslieferung.
Die Quelle bleibt nur `entwicklung` für historische Lineage- und
Altbestandsprüfung; freigegebene Betriebspunkte stammen ausschließlich aus
dem offiziellen DB-InfraGO-Open-Data-Datensatz.

Seit dem 2026-08-12 ist außerdem der offizielle Open-Data-Datensatz
`db-infrago-infrastrukturdaten-open-data` freigegeben. GovData weist ihn als
CC BY 4.0 aus; GeoPackage und CSV enthalten das Streckennetz der DB InfraGO,
Betriebsstellen, Bahnübergänge, Brücken, Tunnel und wesentliche Attribute.
Diese amtliche Ebene verbessert Kilometrierung und Streckenattribute, ersetzt
aber weder OSMs Einzelgleisgeometrie noch die eigene Regelableitung von
Blöcken, Fahrstraßen und Konfliktressourcen.

Der Deutschland-Extract baut den vollständigen semantischen `InfraCorpus`; die
Spielgebietsmaske schränkt davon nur die Bestellbarkeit, niemals Import oder
Kartensichtbarkeit ein. Der Planet-Extract erzeugt davon getrennt die dunkle
Welt-Basiskarte. Stil, Schriften, Sprites und PMTiles werden selbst gehostet,
und der Browser weist Kartenadressen außerhalb des eigenen Ursprungs ab. So
werden die Community-Kachelserver weder als Produktionsbackend noch als
Quelle für einen Massendownload missbraucht.

Die selbst gehosteten Noto-Glyphen und Protomaps-v4-Sprites stammen aus dem
auf Commit `028c18f713baecad011301ff7a69acc39bcc2ae7` gepinnten
`protomaps/basemaps-assets`-Stand; die Sprite-Vorlage aus `tangrams/icons` ist
zusaetzlich auf Commit `92510779634f4a006c61ea70e50cb8c52c765a81`
gebunden. Das Karten-Quellenmanifest liefert OFL- beziehungsweise MIT-Text,
Dateizahl, Bytezahl und kanonischen Baum-Hash mit aus. Damit bleiben beide
Asset-Lizenzen getrennt von der ODbL-Basemap und exakt an die ausgelieferten
Dateien gebunden.

**APN-Entwicklungsfreigabe, Stand 2026-08-12.** Der Projektverantwortliche hat
die freie Verwendung der APN-Skizzen für diesen Arbeitsprozess ausdrücklich
bestätigt und zugleich entschieden, dass daraus keine Quellenangabe im
ausgelieferten Datensatz entsteht. Das Register bildet beide Grenzen ab:
`apn-validierung` darf automatisiert im jährlichen, internen KI-Prüflauf zur
Plausibilisierung von Bahnhofsgleisen, Weichen und Signalen herangezogen werden;
Skizzen, OCR-Rohdaten und APN-Provenienz werden vor dem öffentlichen Release
technisch entfernt. Weil keine allgemeine Wiederveröffentlichungslizenz belegt
ist, bleibt APN dennoch `entwicklung`: Es ist nie alleiniger A-Nachweis und
trägt keinen freigegebenen Importmarker. Der reproduzierbare Jahres-Prompt und
das interne Evidenzprotokoll nennen die Quelle; die Laufzeitdaten nicht.

Für M1.13 ist außerdem `gtfs-de-rv` freigegeben. GTFS.DE veröffentlicht den aus
DELFI-NeTEx-Daten erzeugten Feed „Schienenregionalverkehr Deutschland“
kostenfrei und tagesaktuell unter CC BY 4.0. Zugfolge nutzt den Feed
ausschließlich offline, wahrt Namensnennung und Änderungskennzeichnung und
versioniert Feed-URL, Abrufkonfiguration, Abrufzeit sowie Hash von ZIP und jeder
verwendeten Tabelle. P20, Median und Mittelwert sind als eigene Bearbeitung
und ausdrücklich als **Fahrplanwerte** gekennzeichnet. Sie sind ein Holdout,
keine technische Mindestfahrzeit. Details stehen in
[`referenzkorpus.md`](referenzkorpus.md).

**Was blockiert bleibt.** `rinf`, `entgeltregeln-tps-sps-aps-inb` und der
generische Sammelposten `baustellen-stoerungsfeeds` warten auf eine schriftliche Entscheidung
beziehungsweise einen Vertrag. `pathos`, `tpn` und `oeffentliche-tiles-nominatim`
sind ausgeschlossen — teils rechtlich, teils weil ein externer Dienst im heißen
Pfad ohnehin Invariante 6 verletzt.

**M8-Entwicklungsreferenzen.** Die fünf privaten Tagesausgaben vom 09.08.2026
und die private Einschränkungsliste vom 11.08.2026 werden weder importiert
noch ausgeliefert. Zulässig sind nur eigene aggregierte Wirkungsklassen und
ganzzahlige Kalibriergewichte; Originalzeilen, Texte und Seitenbilder bleiben
außerhalb des Repositories. Die Marktuntersuchung Eisenbahnen 2025 dient nur
zur eigenen Ableitung von Primärursachen-Gewichten. Die Ril-Referenz mit Stand
10.12.2023 wurde auf ausdrückliche Projektentscheidung zur Struktur von Haupt-
und Beispiel-Feincodes herangezogen; Zugfolge verwendet eigene stabile IDs und
markenneutrale Texte. Die drei Parlamentsdrucksachen liefern getrennte
Bezugsgrößen für spontane Störungen: Netztage, Zugfahrten und Fahrgasthalte.
Zugfolge übernimmt weder Tabellen noch Originaltexte, sondern nur eigene
ganzzahlige Raten; nicht veröffentlichte Unterteilungen, insbesondere die
Türquote und der Mix verlängerter Halte, bleiben ausdrücklich
Modellannahmen. Die Fahrdienstvorschrift 408 wird weder kopiert noch als
ML-Trainingsbestand verwendet. Sie dient der eigenen, versionierten und
getesteten Regelauslegung für Fahrwegprüfung, Fahrstraßensicherung,
Flankenschutz, Durchrutschweg und Zustimmung zur Abfahrt. Keine dieser Quellen
ist ein Laufzeitfeed.

**M8.12-Entscheidung, Stand 2026-08-11.** Der Projektverantwortliche hat nach
der Kandidatenprüfung ausdrücklich bestätigt, dass die Daten der öffentlichen
Weboberfläche `strecken.info` genutzt werden dürfen. Der eigene Eintrag
`strecken-info-public` gibt deshalb automatisierten kommerziellen Abruf,
Speicherung, Ableitung, Kartendarstellung, Replay und Audit frei. Die Quelle
wird alle 30 Minuten außerhalb des heißen Pfads abgefragt; Rohsnapshot und
markenfreie Normalisierung werden mit Revision, Abrufzeit und Hash getrennt
archiviert. Die fremden Namen erscheinen nur in Provenienz und Attribution,
nicht in Ursachen- oder Feincodes.

Die früher zusätzlich geprüften Alternativen bleiben davon getrennt. Ein vertraglicher
Störungsfeed sowie fahrtenbezogene `Boards`-/`Journeys`-Daten wurden als
mögliche Bezugswege geprüft. Beide verlangen Zugangsprüfung und gesonderte
vertragliche Nutzungsrechte; ein allgemeiner Marketplace-Zugang genügt nicht.
Die öffentliche Timetables-API ist bahnhofs- und fahrtbezogen und ersetzt
keine ressourcenscharfe Tages-La. Bis zur ausdrücklichen Auswahl und einer
schriftlichen Rechteprüfung bleiben diese Alternativen im Sammelposten
`baustellen-stoerungsfeeds` gesperrt. Sie sind nicht Teil des produktiven
Adapters.

---

## 4. Trassenfinder-Nutzungsbedingungen (E10)

M0.4 nennt den Trassenfinder ausdrücklich, deshalb hier der eigene Prüfpunkt.

Wertvoll ist die **Struktur**, nicht die Zahl: welche Parameter eine
Trassenanfrage definieren (Regellokbezeichnung, Kupplungsart, Achslastgrenzen,
Zuglänge, Masse) und welche Kostenkategorien real existieren (Trassenpreis,
Stationsentgelt, Anlagenpreise, Energiebedarf). Das ist eine fertige
Modellierungscheckliste für `PathRequest` und `EconomyRelease`.

Zwei Grenzen gelten unabhängig von den Nutzungsbedingungen:

- **Kein Laufzeitdienst.** Determinismus und Replay verlangen, dass jede
  Kostenberechnung aus dem gepinnten `EconomyRelease` der Welt kommt (Invariante
  6). Deshalb steht der Trassenfinder im Register auf `entwicklung`, nie auf
  `freigegeben` — er darf nie ein Import werden.
- **Keine Präzisionswahrheit.** Der Betreiber weist die Werte selbst als
  unverbindliche Richtwerte aus vereinfachter Berechnung aus. Für einen
  Größenordnungsabgleich richtig, als Referenzwahrheit nicht.

**Die verbindliche Projektgrenze.** Der Disclaimer der OpenAPI gestattet die
API nur zur einzelnen Routenermittlung und schließt insbesondere Analyse oder
Rekonstruktion der zugrunde liegenden Verfahren sowie Speicherung ohne
zeitlich unmittelbare Nutzung aus. Deshalb ruft Zugfolge die Routensuche nicht
automatisiert ab. Bis zu einer ausdrücklichen Betreiberfreigabe gilt:

- nur manuelle Einzelabfragen in der öffentlichen Weboberfläche;
- nur unmittelbar für eine benannte Entwicklungs-Kalibrierung;
- im Repository höchstens ein eigenes minimales Ergebnisprotokoll mit
  Abfrageparametern, gerundeten Kennzahlen, Zeitpunkt und Einschränkungen;
- keine Rohantwort, kein Screenshot-Archiv und keine systematische Sammlung.

Das Pilotprotokoll für Issue #48 erfüllt diese enge Grenze und ist per Hash an
genau den Kalibrierlauf gebunden. Es wird nicht als freigegebener Datensatz
oder Referenzwahrheit dargestellt. Diese konservative Auslegung ist keine
Rechtsberatung; eine systematische Nutzung bleibt bis zur schriftlichen
Klärung gesperrt.

Dieser Prüfpunkt betrifft die **berechneten** Werte der Routensuche
(Fahrzeit, Trassenpreis). Auch die **Stammdatenressource** `/infrastrukturen`
derselben API ist mangels veröffentlichter Nutzungsbedingungen nur
Entwicklungs- und Lineagereferenz. Weder Routensuche noch Stammdaten werden im
freien 2026.3-Jahresrelease als Import- oder Infrastruktur-Faktenquelle
verwendet.

---

## 5. ODbL und Schichtentrennung

Der `osm-pbf-lhe`-Extract steht unter ODbL. Deren Share-alike-Pflicht trifft den
abgeleiteten `InfraRelease`, nicht den Projektquelltext, und die ODbL kann die
Projektlizenz nicht überschreiben. OSM-abgeleitete Daten bleiben deshalb eine
**getrennte Datenebene** und liegen nicht im öffentlichen Repositorium. Das ist
zugleich ein Daten- und ein Lizenzthema; die Antwort steht in
[`rechteschutz.md`](rechteschutz.md) (Schichtentrennung) und
[`daten.md`](daten.md) 2.

---

## 6. Eine Quelle aufnehmen oder ihren Status ändern

1. Eintrag in [`tools/guards/quellenregister.json`](../tools/guards/quellenregister.json)
   anlegen oder ändern — mit allen Feldern, die der Status verlangt (siehe
   Abschnitt 2).
2. Die Quelle in Abschnitt 3 dieses Dokuments aufführen; der Wächter meldet ein
   Register, dessen Quelle hier fehlt.
3. Für einen Wechsel auf `freigegeben`: Lizenz und datierte Entscheidung
   eintragen. Erst danach darf ein Import den Marker `zugfolge:quelle=<id>`
   tragen.
4. `pnpm guards` läuft grün, wenn Register, Beschreibung und Importe
   zusammenpassen.

> Begründete Rechteeinschätzung, keine Rechtsberatung. ODbL-Abgrenzung und die
> Nutzungsbedingungen jeder in Prüfung stehenden Quelle gehören vor dem ersten
> Import fachlich beziehungsweise anwaltlich bestätigt.
