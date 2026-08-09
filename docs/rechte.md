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
| `openrailwaymap-doku` | OpenRailwayMap — Tagging- und Signaldokumentation | `entwicklung` | M1.6 |
| `openstation` | OpenStation — Stationsdaten | `freigegeben` | M1.8 |
| `stada` | StaDa — Stationsdaten | `freigegeben` | M1.8 |
| `dem-hoehenmodell` | Digitales Höhenmodell der Pilotregion | `freigegeben` | M1.5 |
| `trassenfinder` | Trassenfinder — Trassenpreis- und Fahrzeitstruktur | `entwicklung` | M1.13 |
| `gtfs-de-rv` | GTFS.DE/DELFI — Schienenregionalverkehr Deutschland | `freigegeben` | M1.13 |
| `trassenfinder-infrastruktur-api` | Trassenfinder-Infrastruktur-API — Betriebsstellen-/Streckensegment-Stammdaten | `freigegeben` | M9 |
| `entgeltregeln-tps-sps-aps-inb` | Entgeltregeln (TPS, SPS, APS, INB, Anlagen-/Stationspreise) | `gesperrt` | M6.1 |
| `baustellen-stoerungsfeeds` | reale Baustellen- und Störungsfeeds | `gesperrt` | M8.12 |
| `rinf` | RINF — Register of Infrastructure | `gesperrt` | — |
| `pathos` | pathOS | `ausgeschlossen` | — |
| `tpn` | TPN — Trassenportal Netz | `ausgeschlossen` | — |
| `oeffentliche-tiles-nominatim` | öffentliche OSM-/ORM-Tiles und öffentliches Nominatim | `ausgeschlossen` | M4.7 |

**Was heute trägt.** `osm-pbf-lhe` ist `freigegeben` — die ODbL erlaubt Nutzung
mit Namensnennung und Share-alike, und mehr braucht die Pilotregion für
Geometrie und Railway-Tags nicht. Das ist Absicht: `daten.md` verlangt, dass die
Region **allein mit OSM-Extract und eigenen Regeln** spielbar ist. Ergänzend
sind `openstation` (CC0), `stada` (CC BY 4.0) und `dem-hoehenmodell` (Copernicus
DEM Data Access and Use Terms) seit dem 2026-08-08 `freigegeben` — die Rechte
sind geklärt, konkreter Bezugsweg, Version, Prüfsumme, Attributionstext und
Feldmapping werden erst beim jeweiligen Import (M1.8 beziehungsweise M1.5) im
`InfraRelease` festgehalten, wie schon bei `osm-pbf-lhe`. Ebenfalls seit dem
2026-08-08 `freigegeben`: `trassenfinder-infrastruktur-api`, die
`/infrastrukturen`-Stammdatenressource der öffentlichen, ohne
Nutzungsbedingungen zugänglichen Trassenfinder-API — als jährliche,
ergänzende Importquelle für Betriebsstellen und Streckensegmente (E22,
ADR-0022). Streng abgegrenzt vom bestehenden Eintrag `trassenfinder`: Die
berechneten Fahrzeit- und Trassenpreiswerte der Routensuche bleiben davon
unberührt auf `entwicklung`.

Für M1.13 ist außerdem `gtfs-de-rv` freigegeben. GTFS.DE veröffentlicht den aus
DELFI-NeTEx-Daten erzeugten Feed „Schienenregionalverkehr Deutschland“
kostenfrei und tagesaktuell unter CC BY 4.0. Zugfolge nutzt den Feed
ausschließlich offline, wahrt Namensnennung und Änderungskennzeichnung und
versioniert Feed-URL, Abrufkonfiguration, Abrufzeit sowie Hash von ZIP und jeder
verwendeten Tabelle. P20, Median und Mittelwert sind als eigene Bearbeitung
und ausdrücklich als **Fahrplanwerte** gekennzeichnet. Sie sind ein Holdout,
keine technische Mindestfahrzeit. Details stehen in
[`referenzkorpus.md`](referenzkorpus.md).

**Was blockiert bleibt.** `rinf`, `entgeltregeln-tps-sps-aps-inb` und
`baustellen-stoerungsfeeds` warten auf eine schriftliche Entscheidung
beziehungsweise einen Vertrag. `pathos`, `tpn` und `oeffentliche-tiles-nominatim`
sind ausgeschlossen — teils rechtlich, teils weil ein externer Dienst im heißen
Pfad ohnehin Invariante 6 verletzt.

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

Dieser Prüfpunkt betrifft ausschließlich die **berechneten** Werte der
Routensuche (Fahrzeit, Trassenpreis). Die **Stammdatenressource**
`/infrastrukturen` derselben API ist ein eigener, davon unabhängig geprüfter
Registereintrag (`trassenfinder-infrastruktur-api`, Status `freigegeben`,
Abschnitt 3) — öffentlich ohne Nutzungsbedingungen zugänglich, jährlich
einmalig abgegriffen und offline gehalten (E22). Beides bleibt strikt
getrennt: Kein automatisierter Abruf der Routensuche, aber ein jährlicher,
dokumentierter Import der Infrastruktur-Stammdaten.

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
