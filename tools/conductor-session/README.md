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
320 Pixel Breite. Ein Touch-fähiger Browserkontext sendet zusätzlich einen
tatsächlichen Touch auf die Bewegungsschaltfläche; der Bericht hält die
nativ bestätigte Positions- und Hashänderung fest. Der Szenenfall prüft eine gepinnte Nachtkonfiguration und
einen tatsächlichen Infrastruktur-Sperrbefehl, dessen native Projektion
Stillstand und rote Signalbegriffe liefert. Der Browser erzeugt selbst
keine Signale, Geschwindigkeiten oder Haltebelege.

Der Basisadapter weist sämtliche Kontrolleffekte ab. Forderungen, Zahlungen
und Polizei benötigen den gesonderten echten Kontrolladapter. Die aktuelle
Basisformation besitzt drei Wagenkästen auf einem Hauptdeck; sie behauptet
keinen Doppelstock-Sitzungsnachweis. Die gesonderten M15.4-Nachweise bleiben
die Quelle für die dort tatsächlich geprüften Treppen und Oberdecks.

## Zusammenhängende Kontrollfahrt

`control-browser-proof.mjs` verwendet zusätzlich die wirkliche M6-Wirtschaft,
den nativen Kontrollkern, den Produktionsscheduler und den nativen
Polizeihaltadapter in derselben Sitzung:

```sh
CONDUCTOR_CONTROL_BROWSER_TEST=1 node --test tools/conductor-session/control-browser-proof.mjs
```

Ohne NAPI ist zusätzlich `ZUGFOLGE_FARE_CONTROL_TEST_BINARY` auf
`fare_control_json` zu setzen. `CONDUCTOR_CONTROL_REPORT_PATH` steuert den
eigenen Kontrollbericht. Die private Kandidatenauswahl liest ausschließlich
die tatsächlichen M10-Fakten im Node-Testprozess und prüft mögliche
Dokument-/Identitätsergebnisse isoliert durch denselben nativen Kern. Diese
Probe verändert keinen gespeicherten Zustand. Sie überträgt weder diese
Fakten noch ein vorhergesagtes Ergebnis an den Browser. Jede berichtete
Kontrolle beginnt anschließend über den wirklichen UI-Button und erhält
ihre tatsächlichen Belege aus dem autorisierten Sitzungs- und Kontrollpfad.
Die erste Kontrolle verwendet echte Touch-Ereignisse bei 320 Pixel Breite.
Vor jeder Kontrolle muss die tatsächliche Spielerposition den nativen
Interaktionsknoten erreicht haben; ein aktivierter Button beweist keine Nähe.
Reguläre Forderung, vorläufige Forderung mit späterem Nachweis und Polizeihalt
werden getrennt anhand der öffentlich bestätigten Ergebnisse geprüft.

Ein angeforderter Polizeihalt folgt den bereits gespeicherten nativen
Betriebsereignissen bis zu seiner Aktivierung. Danach laufen kurze tatsächliche
Scheduler-Schritte. Der Nachweis erzeugt weder Ankunft noch Polizeireaktion.
Ein tatsächliches Sitzungsende, auch nach Ablauf der Lease, lässt den
unabhängigen Kontrollbericht weiter zugänglich. Die Gesamtabnahme prüft zusätzlich
die bis zum tatsächlichen Endhalt aktive Fahrt. Der native Tagesabschluss benötigt keinen neuen
Fahrgastmanifest; ein aktualisierter Bericht zeigt die bestätigten Buchungen.

Der Kontrolllauf liest außerdem den tatsächlichen Accessibilitybaum des
Browsers: Die öffentliche Äußerung, sämtliche angebotenen Antworten und der
bestätigte Prüf- und Fahrtstatus müssen darin vorkommen. Die kurzen Snapshots
stehen im Bericht. Dies ist eine Prüfung der konkreten semantischen Oberfläche,
kein vollständiger WCAG-Audit und keine Screenreader-Nutzerstudie.

Die Gesprächsüberschrift bindet die vom Server bestätigte aktive Person.
Nach einem echten Neuladen und der Auswahl einer anderen Person muss diese
Zuordnung in DOM, Accessibilitybaum und Sitzung unverändert bleiben. Alte
V1-Antworten ohne Zuordnungsfeld werden als noch nicht bestätigt bezeichnet;
die lokale Auswahl ersetzt keinen serverseitigen Beleg.

## Voll besetzter Doppelstockzug

`capacity-browser-proof.mjs` verwendet die zweite originale M5-Konfiguration
mit drei Doppelstockkästen und allen 220 tatsächlich von M10 erzeugten
Fahrgästen. Die wirkliche Sitzungsoberfläche zeigt Unter- und Oberdeck; der
serverbestätigte Weg benutzt eine reale Treppenkante. Fahrzeug-/Deckauswahl
und Touch-Kamerabewegung verändern die Spielerposition nicht. Alle Personen
bleiben in DOM und logischer Renderprojektion auch bei 320 Pixel Breite.

```sh
CONDUCTOR_CAPACITY_BROWSER_TEST=1 node --test tools/conductor-session/capacity-browser-proof.mjs
```

Der Bericht misst zwölf authentifizierte lokale Snapshotrundläufe und je
24 tatsächliche Deckwechsel bis zum nächsten Browserframe auf Desktop,
390 und 320 Pixel Breite. Die Zeiten umfassen den lokalen DB-/HTTP-/nativen
Transport beziehungsweise den Vite-Entwicklungsbuild; sie behaupten weder
ein bestandenes Produktionsbudget noch eine weltweit maximal freigegebene
SPNV-Formation. `CONDUCTOR_CAPACITY_REPORT_PATH` steuert die Berichtdatei.

## Zusammenhängende Gesamtabnahme

`acceptance-browser-proof.mjs` verwendet denselben tatsächlichen DOM-/API-
Treiber wie die Kontrollregression (`browser-driver.mjs`). Die sechs
Originalsituationen werden vorab im exakten verbundenen M10-Korpus geprüft;
der Browser läuft zu den wirklichen Interaktionspunkten und betätigt die
angebotenen Antworten. Ein siebter kontrollierter Fahrgast liefert den
eigenständigen nativen Identitätsbefund für die Polizeianforderung.

Der Netzkorpus und der ausdrückliche fiktive Einfahrtenvertrag entstehen vor
allen Releasepins. Eine wirkliche Infrastruktur-Sperre hält den Zug vor dem
Mittelhalt. Erst ihre quittierte Freigabe und eine neue FDL-Prüfung lassen
die Fahrt weiterlaufen. Der Treiber liest alle gespeicherten Ereigniskalender,
einschließlich `fareControlState.scheduled`, sowie die nativ geprüften
Kontrollfälligkeiten. Bereits zum aktuellen Zeitpunkt fällige Betriebsereignisse
durchlaufen ein echtes `advance-to` derselben Zeit. Vor der frühestmöglichen
Halteaktivierung darf der native Kern seine kurzen Bewegungsereignisse bis
zur gepinnten planmäßigen Zielabfahrt intern abarbeiten. Eine tatsächliche
Ankunft wird daraus nicht abgeleitet. Längere Wartezeiten benutzen bestätigte UI-Gehschritte
hin und zurück zur Sitzungserhaltung; der Bericht führt die Positionen und
Leasequittungen auf. Es gibt keine direkte Lease-Änderung.

Nach Betriebs- und Kontrollkommandos werden die echten Nachfrage- und
Kontrollproduzenten in ihrer bestätigten Reihenfolge ausgeführt. Eine im
Nachfragecursor tatsächlich ausstehende Haltquittung dieser Fahrt darf einen
zusätzlichen nativen Zeitschritt genau auf `actualTimeMs + 1` auslösen: Der
Nachfrage-Watermark muss strikt hinter der Ereigniszeit liegen. Der Bericht
bindet vorherigen Cursor, originale Quittungskennung, Zeit und Nachfragehashes
in `demandFinalitySteps`. Ohne eine solche gespeicherte Quittung wird keine
Zeit hinzugefügt; die letzte Millisekunde einer tatsächlichen Anfahrt bleibt
als eigenständige Szenenprobe erhalten.

```sh
CONDUCTOR_ACCEPTANCE_BROWSER_TEST=1 node --test tools/conductor-session/acceptance-browser-proof.mjs
```

`CONDUCTOR_ACCEPTANCE_REPORT_PATH` bestimmt die Berichtdatei. Ein Beleg wird
erst nach den gemeinsamen UI-, Betriebs-, Nachfrage- und Ledgerassertions
geschrieben. Die nach der Fahrt tatsächlich abgerechnete M6-Pönale und der
bestätigte Vertragsumsatz bleiben an denselben Tagesfahrtabschluss gebunden.
Die allgemeine Tagesplan-Vollständigkeit aus Issue #518 bleibt ausdrücklich
gesperrt. Der gesonderte Originaldialog-HTTP-Nachweis bindet die sechs
Situationen zusätzlich an ihren unveränderten nativen Korpus.

Nach erfolgreichen Läufen lassen sich die sieben Browserberichte (Basis,
Nacht, Kontrolle, Kapazität, Manifest, Gesamtabnahme und Einstieg), der Originaldialog-
HTTP-Bericht und sämtliche referenzierten Bilder reproduzierbar zusammenfassen:

```sh
node tools/conductor-session/package-evidence.mjs outputs/M15-Sitzung <40-stellige-git-revision> [ci-run-url]
```

`evidence-manifest.json` bindet die unveränderten Bericht-/PNG-Bytes an den
angegebenen Quellstand. Der Packer weist fehlende Berichte, Browserfehler,
fremde Dateipfade und abweichende Bildhashes zurück. Das Ergebnis bleibt ein
ausdrücklich als `testOnly` bezeichneter Nachweis und ist keine produktive
Releasefreigabe. Während eines laufenden oder fehlgeschlagenen Tests werden
Zwischenstände nicht als fertiges Paket veröffentlicht.
