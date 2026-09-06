# M10 — Implementierung und Abnahmegrenzen

Stand: 06.09.2026. Gemeint ist **M10 — Personenverkehrsnachfrage und SPFV**,
GitHub-Milestone 11. Die technische Implementierung ist als PR-Stack auf der
Gestaltungsbasis #531 veröffentlicht. #530 wurde während der Arbeit in `main`
übernommen. Es werden keine Issues oder Milestones durch diesen Bericht
automatisch geschlossen.

Reihenfolge: [Gestaltungsbasis #531](https://github.com/larynxberlin-rgb/Zugfolge/pull/531)
→ [Nachfragekern #532](https://github.com/larynxberlin-rgb/Zugfolge/pull/532)
→ [Trassenplanung #533](https://github.com/larynxberlin-rgb/Zugfolge/pull/533)
→ [API, Oberfläche und ursprüngliche Datenprüfung #534](https://github.com/larynxberlin-rgb/Zugfolge/pull/534)
→ [Einwohnernachfrage und direkte Odoo-Datenpflege #537](https://github.com/larynxberlin-rgb/Zugfolge/pull/537).
Der vierte Teil liegt auf `codex/m10-population-demand`. Die vier regulären
CI-Ergebnisse und der tatsächliche Odoo-19-Installationsnachweis werden direkt
am [PR #537](https://github.com/larynxberlin-rgb/Zugfolge/pull/537) dem geprüften Commit zugeordnet.

Der ergänzende [Abgleich aller acht Issue-Anforderungen mit Code und Tests](m10-issue-verknuepfung.md)
unterscheidet die vollständig implementierten Fachumfänge #169–#172,
#210, #361 und #379 von der ausdrücklich geänderten Anforderung in #173.
Die sieben bisherigen Issues sind schließend mit #534 verknüpft; #173 ist
nach den abschließenden Tests dem vierten Stack-PR zugeordnet.

## Fachlicher Umfang

| Issue | Implementierung und reproduzierbarer Nachweis | Abnahmegrenze |
|---|---|---|
| #169 | `zugfolge-demand`: versionierte Zonen, Stationsanbindung, Profile, Saison, Tagesgang, deterministische Kohorten; Pilot-Golden und Poolingtests | Datenparameter bleiben sichtbar `balanced`, solange sie nicht beobachtet und belegt sind |
| #170 | Lexikographische Verkehrsmittel-/Verbindungs-/Zugwahl, Kapazitätsalternativen, Zugausfall, Anschlussverlust, Preis und Komfort; Permutations-/Replayszenarien | Nationale Laufzeit- und Abdeckungstests sind keine Folge des kleinen Pilotnachweises |
| #171 | Abschnittspreise, Vertriebsverfügbarkeit, Komfort-/Sonderplätze, durchgehende Reservierungen und Stehplätze; gemeinsame Kapazität über Generationfenster | Prognostizierte Erlöse lösen keine tatsächlichen Einnahmebuchungen aus |
| #210 | Deterministische SPNV-Manifeste, versteckte Fahrberechtigungen, stabile Schlüssel; tatsächliche Haltbelege frieren bereits gereiste Abschnitte, Sitze und gebuchte Preise ein | Signierte Zwischenhaltbindungen, native Belege und persistenter Consumer sind implementiert; endgültiger Linux-NAPI-Lauf ist der Integrationsnachweis. Ohne genehmigten Haltplan entsteht kein Ist-Manifest |
| #172 | Linien-/Halte-/Takt-/Preis-/Formationsvorschau; bestehende Flotten-/Zugnummernautorität; atomare Anträge und Batchkoordinierung; Ablaufgrenzen und sichere künftige Ersetzung; bestätigte Reservierungen fließen zurück in die Nachfrage | Aktivierung im Betriebsprogramm, Umlaufvollständigkeit und Ist-Erlöse brauchen die vorhandenen Betriebsproducer |
| #361, #379 | Nachfrageoverlay, gestufte Details, Planung und Rücknavigation; echte MapLibre-/PMTiles-Karte mit 5.400 synthetischen Stationen, 5.000 Zügen, dichtem Knoten, Live-Deltas, Kartenklick und Listenalternative bei 1366/390/320 px | UI-/UX-Abnahme im dokumentierten synthetischen Lastumfang erfüllt. Produktiver Deutschland-Release und externe Produktabnahme bleiben eigenständige Nachweise |
| #173 | Amtliche Ortsbevölkerung, konservierende Stationszuteilung, Klassen 0–10, ungefähre Wunschziele aus freien Referenzverbindungen; normal editierbare Odoo-Daten, signierte Übernahme und zeitlich gebundenes natives Replay | Geänderter Nutzerumfang vom 06.09.2026; bewusst `balanced`, keine empirische Genauigkeitsbehauptung. Maßgeblich sind die am PR verlinkten finalen CI- und Odoo-Nachweise |

## Geänderter Umfang von #173

Der ausdrückliche Nutzerauftrag vom 06.09.2026 ersetzt das bisherige
empirische Kalibrierungsgate durch eine einwohnerbasierte Schätzung mit
Stationsklassen und groben Wunschzielen sowie direkte Datenbankkorrekturen
aus Odoo. Verbindlich ist [M10-Populationsnachfrage](m10-populationsnachfrage.md).
Die Analogie zu AirlineSim betrifft das Grundprinzip; Klassen, Einzugsgebiete
und Gewichtungen sind eigene, offengelegte Modellannahmen.

Der [reproduzierbare Offlinekorpus](../tools/population-demand/README.md)
verwendet BKG-Einwohner zum 31.12.2024 unter `dl-de/by-2-0` und GTFS.de-RV-/FV-
Verbindungen unter CC BY 4.0. Der Release erfasst zwölf originale
GTFS-Stationskennungen und acht Orte mit genau 1.245.193 Einwohnern;
Querfurts 10.007 Einwohner bleiben wegen fehlender Radiusabdeckung ausdrücklich
außerhalb. Leipzigs Einwohner werden auf drei Stationen verteilt und nicht
dreimal gezählt. Die Referenzwoche 07.–13.09.2026 liefert 58 gerichtete
Stationspaare; Datums-, Quellen- und Inhaltsbindungen sind geprüft.

Der echte Rust-Kern erzeugt im dokumentierten Beispiel 3.729 Reisewünsche,
davon 2.562 bediente Bahnreisen und 1.167 unbediente Wünsche. Die 18 aktiven
Beispielzüge sind deklarierte synthetische Testangebote. Der Referenzfahrplan
erzeugt keine aktiven Spielzüge. Die gespeicherten
[Ergebnisse](../tools/population-demand/example/report.json) belegen
Reproduzierbarkeit und Summenerhaltung im regionalen Testumfang.

Nach der Erstbefüllung speichert die bestehende Odoo-Adminrolle Einwohner,
Stationsanteile und Verbindungswerte in normalen Tabellen. Speichern erzeugt
automatisch `demand.data.update`; es braucht keinen manuellen Export und
keine Freigabe. HMAC, Akteurs-/Weltbindung und Queue schützen die Übernahme.
Der Game-Consumer validiert mit Rust und persistiert Datenrevision, Wirkzeit,
Queueabschluss und `demand.data.result` atomar. Bereits gestellte Wünsche und
begonnene Teilreisen behalten ihre Vergangenheit; zukünftige Wünsche verwenden
den passenden neuen Datenstand. Die Oberfläche zeigt Klassen, Einwohnerbasis,
geschätzte Ziele und freie Quellen. Private Fahrgast- und Tarifdaten bleiben privat.

Die früheren [AFZS-Holdoutberichte](../tools/demand-calibration/README.md)
bleiben unverändert als historische Diagnose erhalten. Ihre verfehlten
Toleranzen werden weder nachträglich zu Erfolgen erklärt noch als
Abnahmebedingung des geänderten Auftrags weitergeführt.

## Betriebs- und Datenschutzgrenze

`ZUGFOLGE_DEMAND_DEPLOYMENT_PATH` und
`ZUGFOLGE_DEMAND_DEPLOYMENT_SHA256` aktivieren einen lokalen, bytegenau
gepinnten Korpus für die konfigurierte Welt und Infrastruktur. Ohne Korpus
antworten die fachlichen Routen mit Nichtverfügbarkeit; Nullwerte werden nicht
als leere Züge dargestellt. Es gibt keinen JavaScript-Ersatz für die native
Nachfrageberechnung und keinen automatisch aktivierten Beispielkorpus.

Alle Generationfenster einer Periode werden unter einem Release und Seed in
einem Kapazitätspool ausgewertet. Innerhalb des Pools müssen doppelte
Fahrtkennungen identische Fakten besitzen; zwischen Pools sind wiederverwendete
Fahrtkennungen unzulässig. Die statische Fahrplanbindung nutzt exakte indizierte
Halteabfragen. Vor dem ersten Betriebsadvance werden sämtliche genehmigten
Poolanfänge privat gepinnt, auch für spätere Tage. Bereits vergangene Abfahrten
können ohne einen solchen Anfang nicht nachträglich materialisiert werden.

Vor und nach dem bestätigten Betriebsschritt konsumiert der Scheduler die
nativen Haltbelege. Nur Zeitpunkte strikt vor dem Stand sämtlicher gebundener
Regionen gelten als abgeschlossen. Verschiedene Abfahrtszeitpunkte führen
das vorherige native Ergebnis weiter; gleichzeitige Belege werden gemeinsam
verarbeitet. Ein begonnener Fahrgastfall bleibt bis zur belegten Zielankunft
im alten Pool. Leere Züge, ein noch nicht begonnenes erstes Fenster und das
Ende des letzten Fensters blockieren den Weltfortschritt nicht. Restore kann
mehrere vorab gepinnte Tagespools kausal nachholen, ohne öffentliche Zeit oder
Revision zurückzusetzen. Unveränderte Eingaben erzeugen keinen weiteren
Checkpoint.

`demand.pool-initialized`, `demand.pool-progressed`, `demand.evaluated`,
`spfv.preview`, `spfv.submitted` und `spfv.confirm` nutzen das vorhandene
Weltjournal beziehungsweise die Kommandoqueue. Der Cursor und private
Zeitgrenzen werden gemeinsam mit dem finalen Checkpoint unter Weltmutex
committet. Archivfence, monotone Revision, Freigabepin, Inhaltskonflikt und
natives Replay werden geprüft. Öffentlicher Ingest kann diese Fachbelege und
die nativen Ankunfts-/Abfahrtsquittungen nicht erzeugen; generische
Ereignisprojektionen geben sie ebenfalls nicht heraus. Neue Datenbanktabellen
oder konkurrierende Migrationsnummern werden nicht benötigt.

Öffentliche Abfragen liefern Aggregate. Die separate Manifestansicht prüft
aktiven Weltzugang und Unternehmenseigentum bei jeder Anfrage und paginiert
höchstens 50 synthetische Fahrgastkennungen. `fareFact`, Herkunft der
Fahrberechtigung, Seeds und vollständige Reise-/Sitzplatzjournale bleiben privat.
Auch Datenbankfehler werden ohne Queryparameter oder rohe Exceptiondetails
protokolliert. Diese Kennungen sind keine Identitäten realer Menschen.

## Reproduzieren

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm guards
pnpm licenses list --json | node tools/guards/dist/licenses-cli.js
cargo test --locked -p zugfolge-demand -p zugfolge-conflict -p zugfolge-planner -p zugfolge-planning-runtime
cargo build --locked -p zugfolge-demand --example evaluate_json
ZUGFOLGE_DEMAND_TEST_BINARY="$PWD/target/debug/examples/evaluate_json" python -m unittest discover -s tools/population-demand -p 'test_*.py'
python -m unittest discover -s tools/demand-calibration -p 'test_*.py'
node .github/scripts/sync-milestones.mjs check
```

Der reguläre Linux-NAPI-Job führt `demand-service.test.ts` und die
Halt-/Pool-/Journaltests mit dem echten Addon aus.
`demand-operational-native.integration.test.ts` verbindet signierte Haltanker,
native Bewegung, Signalstörung, Anschlussverlust, persistente Nachfrage,
Manifest-HTTP und Restore; `spfv-native.integration.test.ts` verbindet zusätzlich echte Flotte,
HTTP, Trassenkonkurrenz und Nachfrage-Restore. `demand-browser.e2e.test.ts`
und `demand-map-browser.e2e.test.ts` laufen mit den gebauten Browserclients.
Lokal wurde zusätzlich der echte Rust-JSON-CLI mit PGlite und API-Projektion
komponiert (`ZUGFOLGE_DEMAND_TEST_BINARY`); das ist ein Testtransport und kein
Produktionsfallback. Native Planung prüft bestehende Trassen, tägliche
Verkehrstage, absolute Gültigkeit, Zwischenhalte und atomare Ersetzungen.

Browsernachweise verwenden explizite Beispieldaten bei Breiten von 1920,
1366, 768, 390 und 320 Pixeln. Sie prüfen auch verlorene Bestätigungsantworten
und verspätete Vorschauergebnisse. Sie ersetzen keine produktiven Fahrgastdaten.
Die drei zusätzlichen [MapLibre-Lastfälle](m10-kartenabnahme.md) prüfen eine
synthetische Deutschlandkarte und einen dichten Knoten mit tatsächlich
gerenderten Tiles, Kartenklicks, Live-Deltas und kollisionsfreier Legende.
Mit dem zusätzlichen Einwohnerfall sind neun M10-Browserfälle vorhanden.

![Fernverkehrsplanung mit gekennzeichneten Beispieldaten](screenshots/m10/spfv-desktop.png)

Die schmalen Ansichten sind als [Fernverkehr auf Mobilgeräten](screenshots/m10/spfv-mobile.png)
und [Nachfrageliste auf Mobilgeräten](screenshots/m10/demand-mobile.png) dokumentiert.

Historischer Basisnachweis vor dem vierten Stack-Teil: 835 Rust-Workspace-Tests (ohne die beiden
Linux-NAPI-Crates) sowie drei ergänzte Issue-Akzeptanztests. Die neue Haltbelegkette wurde
zusätzlich mit 148 Sim-/Runtime-Rust-Tests, 52 Import-/Bindungstests,
Infrastruktur-Negativfällen und den API-/Pool-Lebenszyklustests geprüft. Die
Nachfrageprüfung umfasst damit 17 Kerntests einschließlich Golden und
Properties; hinzu kommen 13 native
Planning-Runtime-Tests sowie die fokussierten API-, Privacy-, Planner- und
Browsernachweise sowie sechs Python-Tests zu freien Originalquellen,
Trainings-/Holdout-Trennung und bytegenauen JSON-Pins. Clippy, Typprüfung und 15 Repositorywächter sind Bestandteil
der Prüfung. Der vollständige Windows-TypeScript-Lauf wurde wegen Zeitlimits
in unveränderten PGlite-Bestandstests unter paralleler Compilerlast abgebrochen;
er wird nicht als grün ausgegeben.

Für den vierten Teil sind lokal Build, Typprüfung und Repositorywächter grün,
ebenso 21 Python-Tests einschließlich drei echter Rust-Integrationen,
fünf Odoo-Vertragshelfer, sieben UI-Tests und sechs Browserfälle. Die
Einwohnerinitialisierung, signierte Odoo-Übernahme und der Fortschrittslebenszyklus
sind zusammen mit 17 nativen Integrationsfällen geprüft. Die Commerce-Regression
und sieben gezielte Datenkommando-Tests prüfen insbesondere Welt-/Akteursbindung,
Replay, Transaktionsrollback und minimale Ergebnisbelege. Acht Odoo-ORM- und
zwei HTTP-Tests sind für den echten Odoo-19-Dienst vorbereitet; der
[Odoo-Lauf](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/34025161638)
und die regulären vier CI-Jobs wurden gestartet, ihre Ergebnisse stehen noch aus.
Der breitere API-Lauf wurde lokal ebenfalls geprüft; die einzig angepasste
Privacy-Erwartung berücksichtigt den zusätzlichen privaten Datenrevisionsbeleg,
und die betreffende Testdatei besteht anschließend vollständig.
Frühere grüne CI-Läufe werden nicht als Nachweis der neuen Änderungen verwendet.

Die echten Quelldaten und den wiederholbaren nativen Vergleich beschreibt
[tools/demand-calibration](../tools/demand-calibration/README.md).
Die vollständige Quellen-/Lizenzentscheidung und ausgeschlossene Datensätze
stehen in [M10-Kalibrierungsquellen](m10-kalibrierungsquellen.md).

## Berücksichtigte offene Abhängigkeiten

Der [Issue-/PR-Audit](m10-issue-audit.md) enthält den gesichteten Gesamtbestand
und die fachliche Zuordnung. Besonders relevant bleiben #517/#518
(Betriebsprogramm und Abschluss-/Abrechnungsanbindung), #509/#393/#398 (Skalierung), #350
(Zugnummernautorität), #419 (dauerhafte Kommandowiederholung), #504
(belegte Kapazitätszusagen), #502/#520 (Datenschutz) sowie die unabhängige
M9-/Deutschland-/Produktionsabnahme. M15 erhält ausschließlich den M10-Vertrag;
der Schaffnermodus erzeugt keine zweite Nachfrage oder Fahrberechtigung.

Der geänderte M10-Fachumfang ist zur abschließenden Prüfung implementiert.
Vor einer vollständigen Abnahme fehlen noch die genannten finalen CI- und
Odoo-Nachweise. Produktive Betriebs-, Deutschlandlast- und externe
Spielerabnahmen verbleiben bei ihren bestehenden Release-/Betriebsissues.
