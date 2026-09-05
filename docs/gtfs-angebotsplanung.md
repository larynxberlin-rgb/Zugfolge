# Spielgenerierte Linien- und Angebotsplanung mit GTFS-Referenzen

GTFS ist eine Referenz für Linie, Laufweg, Fahrzeiten, Frequenz und Bezeichnung.
Das Spiel erzeugt eigene Fahrten innerhalb des gepinnten Spielgebiets (E33).
Der versionierte, gehashte `GtfsPlanningSnapshot` hält die Herkunft des Angebots
fest; verbindlich sind die erzeugten Spiel-Linien, -Fahrten und deren interne
Infrastrukturbindung. Ausschreibungen, Fahrzeugbedarf und Leistungsmenge werden
aus demselben erzeugten Fahrplan abgeleitet. Der Client referenziert nur
Planungsrevision, Snapshot-Hash und Los-ID.

Der regionale Produktionsweg ist `build-gtfs-region.mjs` → qualifizierter
innerer Gleisgraph und Fahrtrouten → `build-alpha-world.mjs` → signiertes
Deployment → Wirtschaft und Betrieb. Der Weltstart bindet den vollständigen
Angebotsplan und die automatische Ausschreibungserzeugung. Ein nacktes Los mit
einem GTFS-Dateihash ist keine ausreichende Angebotsgrundlage.

## Ableitungskette

| Stufe | Eingabe | Ergebnis und harte Prüfung |
|---|---|---|
| Capture | statischer GTFS-Feed | Feed-URL, Lizenz, Attribution, Abrufzeit und SHA-256 von ZIP und Tabellen |
| Referenzangebot | `calendar.txt`, `calendar_dates.txt`, optional `frequencies.txt` | aktive Referenzfahrten mit Bedienungszeitraum, Frequenz und Abschnittszeiten; Zeiten über 24 Uhr bleiben beim Verkehrstag |
| Spiel-Linie | Referenzhalte, Spielgebiet, reales Gleisnetz und belegte Endpunkte | zusammenhängende Innenabschnitte zwischen zwei geeigneten Bahnhöfen mit Wendemöglichkeit; tatsächlicher Endbahnhof als Ziel, keine Außenfahrt oder Grenzfenster |
| Spiel-Fahrplan | Innenabschnitte, Taktreferenz, Seed und versionierte Erzeugungsregel | eigene reproduzierbare Fahrten mit ganzzahligen Fahr-/Haltezeiten und eigenen IDs |
| Infrastrukturbindung | explizite Stop→Knoten- und Varianten→Kanten-Zuordnung | nur aktive, gerichtete, zusammenhängende Kanten; Halte müssen in korrekter Reihenfolge auf dem Pfad liegen |
| Fahrtenbild | interne Linien-ID, Richtung, Halte- und Kantenfolge | stabile `ServicePattern`-ID, Fahrten, Taktmedian, Betriebszeit, Zugmeter, Halte, Fahrzeit und Energie |
| Losbildung | Linien und gemeinsamer Betriebsgraph | deterministische Gruppen bis zur konfigurierten Maximalgröße; Linien ohne gemeinsamen Knoten bleiben getrennt |
| Ausschreibung | Losreferenz und `WorldProfile` | Zug-km, Halte, Betriebs-/Anlagenstunden, Energie, Fahrzeugbedarf und Mindestanforderungen werden serverseitig skaliert |

Externe `route_id`, `trip_id` und Plattform-`stop_id` sind nur
Herkunftsbelege. Stabile Spielobjekte verwenden interne Linien-, Knoten- und
Kanten-IDs. Eine Feed-Aktualisierung wird als neue Revision erzeugt und nicht
stillschweigend in eine laufende Welt geschrieben.

## Fachliche Regeln

- Es werden nur die in der Planungsregel freigegebenen GTFS-`route_type`-Werte
  verarbeitet.
- Außenhalte entfallen durch Aufteilen und Kürzen, nicht durch Überspringen in
  derselben Fahrt. Wiedereintritt erzeugt eine getrennte Linie. Der gesamte
  Gleisweg muss intern bleiben; ein Außenweg zwischen zwei Innenhalten ist
  ebenfalls unzulässig. Unvollständige Infrastrukturbelege werden abgewiesen.
- Jeder Abschnitt wird auf das längste zusammenhängende Intervall zwischen
  unterschiedlichen Bahnhöfen mit belegter Wendemöglichkeit gekürzt. Maßgeblich
  ist die Zahl erhaltener Halteabschnitte, bei Gleichstand der frühere Beginn.
  Haltepunkte bleiben Zwischenhalte. Unbekannte
  Betriebspunktarten und unbelegte Wendemöglichkeiten eignen sich nicht als
  Linienenden; ohne zwei unterschiedliche geeignete Bahnhöfe entfällt der
  Abschnitt. Die Regel gilt auch für ursprüngliche GTFS-Endhalte innerhalb der
  Karte. Im Markt erscheinen Linienname, tatsächliche Endbahnhöfe und die
  Anpassung gegenüber dem Referenzlaufweg.
- Losgröße ist die auf die Stichprobentage normierte Verkehrsleistung in
  Zug-km/Tag. Attraktivität wird aus Fahrtenzahl und erschlossenen internen
  Knoten abgeleitet; die Schwelle für kleine Lose ist versioniert.
- Ohne belastbare `block_id`-/Umlaufdaten werden keine Fahrzeugübergänge
  zwischen Linien oder Gegenrichtungen erfunden. Die Richtungsspitzen werden
  konservativ addiert. Das vermeidet einen zu kleinen Fahrzeugbedarf, kann ihn
  aber gegenüber einem später nachgewiesenen Umlauf überschätzen.
- Energie, Behandlungszeit, Abstellung, Zugsicherung und
  Fahrzeugmindestanforderungen stammen aus einer versionierten Linienregel,
  nicht aus GTFS. GTFS beschreibt das Angebot, nicht die technische
  Befahrbarkeit oder ein Fahrzeug.
- Die API akzeptiert keine vom Client gelieferte `ServiceSpecification`.
  Zusätzliche Felder werden mit HTTP 400 abgewiesen; Welt, Los, Mengen,
  Fahrzeuganforderungen, Vertragsdauer, Losklasse und Altbetreiber werden auf
  dem Server ermittelt.

## Produktionsaufbau

Der endgültige regionale Snapshot benötigt die Netzbindung als sechstes
CLI-Argument. Der Aufruf ohne Netzbindung liefert nur eine Referenzvorstufe,
die nicht für einen neuen Weltstart ausreicht:

```sh
node tools/region-import/build-gtfs-region.mjs WORLD-IDENTITY.json \
  GTFS-DIRECTORY YYYYMMDD ARCHIVE-SHA256 game-timetable.json NETWORK-BINDING.json
```

Die [Erzeugungsregel und Eingabeformate](../tools/region-import/specifications/game-timetable-v1.md)
beschreiben Gleisdateien, gerichtete Freigaben und den Endpunktkatalog. Die
Bahnhofseigenschaft und Wendemöglichkeit benötigen jeweils belastbare
Betriebsbelege. GTFS-Namen und `location_type` genügen dafür nicht. Dieselben
gehashten Netzdateien werden anschließend im Routecompiler verwendet.

## Historischer Pilot Leipzig–Halle

Die folgenden Werte und Hashes dokumentieren den früheren GTFS-Replay-Piloten.
Sie sind kein Nachweis für einen mit E33 neu erzeugten Weltfahrplan.

Der reale Pilot unter
[`tools/reference-corpus/pilot/2026-08`](../tools/reference-corpus/pilot/2026-08)
verwendet den GTFS.DE-Regionalverkehrsfeed vom 9. August 2026 für die
Verkehrstage 10.–14. August. Sein ZIP-Hash lautet
`0c30da4378f24e287df5cdda9fa1fc12e982318f9353dca3d114642777702650`, der
Planungssnapshot-Hash
`cadf60a49aaf2753e34a0d3ab29ed71917debb1c06017ee588ce3afc08663a7f`.

| Ergebnis | Wert |
|---|---:|
| Fahrtenbilder | 4 (S5 und S5X, je Richtung) |
| ausgewertete Fahrten | 401 |
| Korridorlänge je Fahrt | 36,4 km |
| Los | S5 + S5X |
| mittlere Verkehrsleistung | 2.920 Zug-km/Tag |
| konservativer Spitzenbedarf | 6 Fahrzeuge |

Die drei Kantenlängen und Linienregeln in `planning-config.json` sind
transparent versionierte **Planungsannahmen des Projekts**. Sie sind kein aus
GTFS gewonnener Infrastrukturbeweis. Vor einem Produktiv-Release müssen sie
gegen den tatsächlichen, signierten `InfraRelease` ersetzt beziehungsweise
bestätigt werden. GTFS liefert insbesondere keine belastbare
Streckenkapazität, Elektrifizierung, Zugsicherung, Zulassung oder
Instandhaltungsfreigabe.

## Historische Reproduktion und Aktualisierung

Der frühere Pilotnachweis verwendet den expliziten Legacy-Replay-Compiler.
Der aktuelle Standardcompiler erzeugt ein neues Spielangebot und folglich neue
Fahrten, Mengen und Hashes. Alle Folgeartefakte sind gemeinsam neu zu bauen.

```bash
pnpm --filter @zugfolge/gtfs build
node tools/reference-corpus/cli.mjs plan-gtfs-reference-replay \
  tools/reference-corpus/pilot/2026-08/config.json \
  tools/reference-corpus/pilot/2026-08/planning-config.json \
  tools/reference-corpus/pilot/2026-08/capture-manifest.json \
  artifacts/gtfs-raw artifacts/planning-envelope.json
```

`artifacts/gtfs-raw` muss die Tabellen enthalten, deren Hashes im
Capture-Manifest stehen. Der vollständige Snapshot ist ein Release-Artefakt;
im Repository liegt mit `planning-summary.json` nur der kompakte, überprüfbare
Pilotnachweis. Für eine neue Fahrplanperiode werden Feed und Tabellen neu
erfasst, die Zuordnung bewusst geprüft, die Revision erhöht und der neue Hash
in einer neuen Welt beziehungsweise an einem vorgesehenen Periodenübergang
gepinnt.
