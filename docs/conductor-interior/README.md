# M15.4 – Begehbare Innenräume aus M5

Der [Innenraumvertrag](../conductor-interior.md) wird durch den Rust-Kern
`zugfolge-conductor`, die strikte TypeScript-Nativegrenze und den
[autorisierten Plattformdienst](../conductor-interior-platform.md) umgesetzt.
Der Beweis verwendet den echten Fahrzeugkatalogcompiler, native
Flottenkommandos, die regulären Datenbankmigrationen und gespeicherte
FleetProducer-Checkpoints. Alle Fahrzeuge sind ausdrücklich fiktive
Spielkonfigurationen im öffentlichen Testkorpus.

| Konfiguration | Sitzplätze | Stehplätze | Türen je Seite | WCs, davon barrierefrei | Fahrrad / Rollstuhl / Kinderwagen |
|---|---:|---:|---:|---:|---|
| Einstöckiger Nahverkehr, Reihensitze | 120 | 40 | 4 | 2 / 1 | 12 / 2 / 4 |
| Doppelstock-Nahverkehr, Gegenübersitze | 200 | 20 | 6 | 3 / 1 | 12 / 2 / 2 |
| Einstöckiger Nahverkehr, Klappsitze | 96 | 48 | 8 | 1 / 1 | 12 / 2 / 8 |

Jede Formation besitzt drei explizit konfigurierte Kästen mit zusammen
70.000 mm Länge und 3.000 mm Innenbreite. Die Kasten-, Deck- und
Treppenanordnung ist ein versioniertes generisches Spielprofil. Sie wird
nicht aus einem Fahrzeugbild oder einer Baureihenkennung abgeleitet.

Ein vierter, unabhängig kompilierter und gespeicherter Fall besitzt keinen
`vehicleConfiguration`-Beleg. Die Spiel-API verweigert dessen Einstieg mit
`interior_configuration_missing` und der bereits autorisierten eigenen
Fahrzeugkennung. Überfüllte Geometrien bleiben eigene Negativfälle.

## Reproduzieren

Voraussetzung sind die dokumentierte Rust-/Node-Werkzeugkette und ein
installierter Edge-, Chrome- oder Chromium-Browser. Es wird kein Browser
heruntergeladen. Zuerst die tatsächlichen Abhängigkeiten bauen:

```bash
pnpm install --frozen-lockfile
pnpm --filter @zugfolge/game-api... build
cargo build --locked -p zugfolge-fleet --bin zugfolge-vehicle-catalog
cargo build --locked -p zugfolge-conductor --example interior_json
cargo build --locked -p zugfolge-runtime --example fleet_json
```

Unter Linux verwendet die CI das echte NAPI-Addon aus
`ZUGFOLGE_RUNTIME_NATIVE_PATH`. Lokal kann insbesondere unter Windows der
unveränderte Rust-Kern über die JSON-Einstiege angesprochen werden:

- `ZUGFOLGE_VEHICLE_CATALOG_TEST_BINARY`: absoluter Pfad zum Katalogcompiler.
- `ZUGFOLGE_INTERIOR_TEST_BINARY`: absoluter Pfad zu `examples/interior_json`.
- `ZUGFOLGE_FLEET_TEST_BINARY`: absoluter Pfad zu `examples/fleet_json`.

Die Dateinamen tragen unter Windows die Endung `.exe`. Der Flotteneinstieg
ist nur ohne gesetzten NAPI-Pfad nötig. Diese Programme führen dieselben
Rust-Funktionen aus; es gibt keinen JavaScript-Geometrieersatz.

```bash
node tools/conductor-interior/native-backend.mjs
```

Die lokale Prüfung öffnet unter `http://127.0.0.1:4187` drei begehbare
Konfigurationen und die konkrete Fehlermeldung des unvollständigen Falls.
Pfeiltasten, Zielpunktwahl und der Übergangsknopf bewegen die Prüffigur über
serverseitig geprüfte Wege. Ein reiner Ansichtswechsel bewegt sie nicht.
Die Kollisionsprüfung versucht ausdrücklich eine gesperrte Bewegung.

Die API-, Restore- und Browserabnahme wird so ausgeführt:

```bash
pnpm --filter @zugfolge/game-api exec vitest run --no-file-parallelism src/conductor-interior.native.integration.test.ts
CONDUCTOR_INTERIOR_BROWSER_TEST=1 node --test tools/conductor-interior/server.test.mjs tools/conductor-interior/preview.test.mjs
```

PowerShell setzt Umgebungsvariablen mit `$env:NAME='Wert'`. Der Browserpfad
kann über `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` angegeben werden.
`CONDUCTOR_INTERIOR_SCREENSHOT_DIR` und `CONDUCTOR_INTERIOR_REPORT_PATH`
legen die Ausgabepfade fest. Bericht und Screenshots binden den tatsächlichen
Grafikhash, jede Formation, Revision, Kapazität und jeden Layouthash.

## Darstellung und Auslieferungsgrenze

Die Ansicht zeigt die tatsächlichen Sitz-, Steh-, Tür- und Sonderflächen
sowie Sitzrichtungen und den geprüften Weggraphen. Sie verwendet die echte
freigegebene Bodentextur und Schaffnerfigur. Ein vorgezeichnetes Wagenbild
ersetzt keine Konfiguration und bestimmt keine Kapazität.

Der Test lädt den vollständigen freigegebenen M15.3-Korpus über dieselbe
Datei-, Hash-, Rechte- und Signaturprüfung wie der Server. Sein kurzlebiger
Schlüssel heißt ausdrücklich `temporary-integration-test-only`. Er erzeugt
keine produktive Signeridentität und aktiviert keine laufende Spielwelt.
Produktive Auslieferung erfordert die unabhängig bereitgestellten
Deploymentpins und vertrauenswürdigen Art-Schlüssel gemäß Plattformvertrag.
Die ausstehende produktive M15.3-Signatur ist separat in
[Issue #213](https://github.com/larynxberlin-rgb/Zugfolge/issues/213) erfasst.

M15.4 liefert den formationsbezogenen Innenraum einschließlich V2-Plätzen
für echte M10-Manifeste. Zuglaufzuordnung, persistente Schaffnersitzung,
Kontrollentscheidung und die vollständige Spieleroberfläche gehören zu den
nachfolgenden M15-Teilpunkten. Diese Grenzen verändern weder Formation noch
Abfahrtsrecht oder betriebliche Kapazität.

## Gemessener Browsernachweis

Die native Rust-Suite ist mit 20 Tests grün, darunter zehn neue
Innenraumtests mit einer Matrix aus 52 Konfigurationsvarianten.
Sie prüfen Dichte, Sitztyp, Ausrichtung, alle sechs Artfamilien, exakte
Kapazitäten, Türen, Übergänge, Kollisionen und bitgleiche Wiederholung.
Tatsächliche M10-Vollmanifeste belegen die drei Formationen einschließlich
separater exklusiver Sonderflächen; Rollstuhlfahrgäste behalten sowohl mit
als auch ohne Sitznummer ihren von M10 bestimmten Status. Haltfortschritt,
kalter Einstieg, Restore und Fahrausweis-unabhängiges Aussehen sind geprüft.

Die Plattformabnahme umfasst sechs grüne Tests mit echten Compilerausgaben,
FleetProducer-Commits und HTTP über `buildApp`, einschließlich Halterwechsel,
Welt-/EVU-Zugriff, Periodengrenzen und bitgleichem Datenbankrestore.
Die vorhandenen API-/Flottenregressionen (62 Tests), die strikte
Runtime-Native-Transportsuite (65 Tests), Workspace-Build und Typprüfung
sowie alle 15 Repository-Wächter sind grün. Clippy behandelt Warnungen als
Fehler. Die Linux-CI baut zusätzlich die aktivierten echten NAPI-Exporte.

Der [Browserbericht](browser-report.json) vom 6. September 2026,
20:20:41 UTC, dokumentiert den tatsächlich ausgeführten Edge-Durchlauf
mit Version 153.0.4234.19. Drei vollständige Konfigurationen und der
unabhängig kompilierte unvollständige Fall wurden geprüft. Die Browserwege
umfassten **158 nativ freigegebene Bewegungsabschnitte**, darunter die
überprüften Zielwege über fünf Wagenübergänge und einen ausdrücklich
bedienten Treppenwechsel. Drei Bewegungen in wirkliche Kollisionsflächen
wurden abgewehrt; die Prüffigur blieb jeweils am bestätigten Punkt.
Der stufenfreie Weg zum Oberdeck wurde abgelehnt. Ein reiner Ansichtswechsel
veränderte die tatsächliche Position nicht.

Der Durchlauf prüfte 390 und 320 Pixel breite Ansichten ohne äußeren
horizontalen Überlauf, Tastaturfokus, reduzierte Bewegung, sämtliche sieben
ausgelieferten PNG-Hashes und elf Screenshotdateien. Es traten keine
Browser-Skriptfehler auf. Der Negativfall bindet seinen eigenen Compiler-,
Authority- und Zustandshash; er übernimmt keinen Beleg des vollständigen
Korpus. Die abschließende Ausführung dauerte lokal 38,6 Sekunden; diese
einzelne Messung ist kein Lastnachweis.

Die elf Bilder wurden durch Codex einzeln gesichtet. Sie zeigen die
tatsächlichen Sitzflächen samt Lehnenrichtung, Türen, Sonderflächen,
Unter-/Oberdecks, geprüfte Figurpositionen und die konkrete Einstiegssperre.
Der beim ersten Sichtdurchgang gefundene alte Untertitel im gesperrten
Fall ist korrigiert und durch den abschließenden Browsertest abgesichert.

| Ansicht | Einstieg | Begangener Zielpunkt / weitere Ansicht |
|---|---|---|
| Nahverkehr mit Reihensitzen | [Einstieg](screenshots/regional-row-entry.png) | [Dritter Kasten nach Wagenübergängen](screenshots/regional-row-walked.png) |
| Doppelstock | [Unterdeck](screenshots/regional-double-entry.png) | [Oberdeck](screenshots/regional-double-upper.png), [benutzte Treppe](screenshots/regional-double-stairs.png), [dritter Kasten](screenshots/regional-double-walked.png) |
| Nahverkehr mit Klappsitzen | [Einstieg](screenshots/regional-folding-entry.png) | [Dritter Kasten nach Wagenübergängen](screenshots/regional-folding-walked.png) |
| Fehlender Konfigurationsbeleg | [Einstieg gesperrt](screenshots/configuration-missing-blocked.png) | Kein Ersatzlayout |
| Mobile Darstellung | [390 Pixel](screenshots/mobile-390.png) | [320 Pixel](screenshots/mobile-320.png) |
