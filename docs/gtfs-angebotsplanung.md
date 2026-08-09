# GTFS-basierte Linien- und Angebotsplanung

Die SPNV-Ausschreibungen werden nicht mehr aus frei eingegebenen Linien oder
technischen Clientwerten aufgebaut. Ein versionierter, gehashter
`GtfsPlanningSnapshot` leitet aus einem statischen GTFS-Capture die aktiven
Fahrtenbilder ab, bindet sie an den internen Betriebsgraphen und erzeugt daraus
reproduzierbare Linien, Lose und Mengengerüste. Der Client referenziert bei der
Ausschreibung nur noch Planungsrevision, Snapshot-Hash und Los-ID.

## Ableitungskette

| Stufe | Eingabe | Ergebnis und harte Prüfung |
|---|---|---|
| Capture | statischer GTFS-Feed | Feed-URL, Lizenz, Attribution, Abrufzeit und SHA-256 von ZIP und Tabellen |
| Verkehrstage | `calendar.txt`, `calendar_dates.txt`, optional `frequencies.txt` | exakt aktive Fahrten; GTFS-Zeiten über 24 Uhr bleiben demselben Verkehrstag zugeordnet |
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
- Eine Fahrt kann auf einen explizit konfigurierten Teilkorridor einer längeren
  GTFS-Fahrt abgebildet werden. Mehrdeutige gleich spezifische Zuordnungen und
  unvollständige Pfade werden abgewiesen.
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

## Pilot Leipzig–Halle

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

## Reproduktion und Aktualisierung

```bash
pnpm --filter @zugfolge/gtfs build
node tools/reference-corpus/cli.mjs plan-gtfs \
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

