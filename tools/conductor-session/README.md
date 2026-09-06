# Browsernachweis der Schaffnersitzung

`browser-proof.mjs` lädt die produktive `conductor-mode.ts` über Vite. Die
HTTP-Routen, Sitzungsdatenbank, M5-Kompilierung, Betriebsfortschritte,
M10-Auswertung und Pixi-WebGL-Darstellung laufen unverändert durch ihre echten
Implementierungen. Die lokale Anmeldung verwendet einen flüchtigen Prüftoken
für den tatsächlich in der Testdatenbank berechtigten Spieler.

Die Quellfahrt und Fahrzeuge sind ausdrücklich fiktive Spielkonfigurationen.
Die Infrastruktur, Bahnsteigzuordnung und Szenenreferenzen werden trotzdem
über die echten Compiler und nativen Prüfer gebunden. Signaturen verwenden
ausschließlich temporäre Testschlüssel. Dies ist keine Aktivierung einer
produktiven Welt und keine Aussage über reale deutsche Bahnhofsklassen.

## Ausführung

Nach dem Build von `@zugfolge/runtime-native`, `@zugfolge/game-api` und den
nativen Beispielprogrammen:

```sh
CONDUCTOR_SESSION_BROWSER_TEST=1 node --test tools/conductor-session/browser-proof.mjs
```

Linux-CI verwendet das bereits gebaute Addon über
`ZUGFOLGE_RUNTIME_NATIVE_PATH` und den installierten Chromium. Zusätzlich
werden `ZUGFOLGE_SESSION_FIXTURE_BINARY` (`session_fixture`) sowie
`ZUGFOLGE_VEHICLE_CATALOG_TEST_BINARY` (`zugfolge-vehicle-catalog`) benötigt.
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` kann ein ausdrücklich installiertes
Chromium wählen. Windows verwendet Microsoft Edge; alternativ läuft jeder
Fachaufruf über die vorhandenen echten Rust-CLIs:

- `ZUGFOLGE_FLEET_TEST_BINARY`: `fleet_json`
- `ZUGFOLGE_OPERATIONAL_TEST_BINARY`: `operational_json`
- `ZUGFOLGE_INTERIOR_TEST_BINARY`: `interior_json`
- `ZUGFOLGE_DEMAND_TEST_BINARY`: `evaluate_json`
- `ZUGFOLGE_SESSION_TEST_BINARY`: `session_json`
- `ZUGFOLGE_DIALOGUE_TEST_BINARY`: `dialogue_json`
- `ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY`: `scene_json`; standardmäßig neben
  dem expliziten `session_json`-Pfad gesucht.

Der Nachweis startet seine HTTP- und Vite-Server ausschließlich auf
`127.0.0.1` mit freien Ports und schließt Browser, Streams und Datenbank
anschließend. Er ersetzt weder produktive Endpunkte noch Spielzustände im
Browser. Die native Uhr wird mit tatsächlichen `advance-to`-Kommandos
fortgeschrieben. Ein tatsächlicher Socketabbruch prüft Wiederverbindung und
die schreibgeschützte Darstellung des letzten bestätigten Standes.

## Belege und Grenzen

`CONDUCTOR_SESSION_SCREENSHOT_DIR` und `CONDUCTOR_SESSION_REPORT_PATH`
bestimmen das Ausgabeziel. Standard ist `outputs/M15-Sitzung`; CI verwendet
ein temporäres Verzeichnis. Der ergänzende `scene-browser-report.json`
liegt neben dem Hauptbericht. Berichte enthalten geprüfte Hashes und die
tatsächlichen Screenshots, deren SHA-256-Hashes ebenfalls erfasst werden.
Sie entstehen erst nach erfolgreichen Assertions des jeweiligen Falles.

Der Basisfall prüft vollständige Fahrgastliste, sieben Atlasdateien,
Ansichtswechsel ohne Positionsänderung, serverbestätigte Bewegung und
Wagenübergang, reduzierte Bewegung, Trennen/Wiederaufnahme sowie 390 und
320 Pixel Breite. Der Szenenfall prüft eine gepinnte Nachtkonfiguration und
einen tatsächlichen Infrastruktur-Sperrbefehl, dessen native Projektion
Stillstand und rote Signalbegriffe liefert. Der Browser erzeugt selbst
keine Signale, Geschwindigkeiten oder Haltebelege.

Der Basisadapter weist sämtliche Kontrolleffekte ab. Forderungen, Zahlungen
und Polizei benötigen den gesonderten echten Kontrolladapter. Die aktuelle
Basisformation besitzt drei Wagenkästen auf einem Hauptdeck; sie behauptet
keinen Doppelstock-Sitzungsnachweis. Die gesonderten M15.4-Nachweise bleiben
die Quelle für die dort tatsächlich geprüften Treppen und Oberdecks.
