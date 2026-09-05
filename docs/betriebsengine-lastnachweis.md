# Lastnachweis der autoritativen Betriebsengine

Stand: 5. September 2026. Historischer Einzelzyklusvertrag: E31 /
`operational-core-benchmark/v1`; aktuelle Mehrzugdiagnose:
`operational-shared-world-benchmark/v1`.

## Reproduktion

```powershell
cargo run -p zugfolge-sim --release --example operational_load -- --cycles 20000
```

Der Benchmark führt abwechselnd Zug- und Rangierbewegungen aus. Er lässt die
operative InfraRelease-Prüfung, Fahrzeug- und Formationsableitung, exakte
Intervallbelegung, Stellwerkssicherung einschließlich Durchrutschweg und
Flankenschutz, den lexikographischen FDL, den virtuellen Lokführer, die
automatische Rangierbeauftragung, analytische Bewegung, zugschlussbezogene
Auflösung und die vollständige Invariantenprüfung aktiv. Er zählt die dabei
committeten fachlichen Ereignisse, nicht Schleifendurchläufe oder leere Ticks.

Referenzlauf auf Commit-Basis `f0ad8bedb992a7788098e35c594ab5040bffc212`
zuzüglich der E31-Arbeitskopie:

| Messgröße | Ergebnis |
|---|---:|
| Zyklen | 20.000 |
| vollständige fachliche Ereignisse | 150.000 |
| Laufzeit | 140 ms |
| Durchsatz | 1.069.081 Ereignisse/s |
| Kernziel | mindestens 20.000 Ereignisse/s |
| Zielreserve | 53,5-fach |

Messsystem: Windows, AMD Ryzen 7 9850X3D, 8 Kerne/16 Threads, 30,88 GiB RAM,
Rust/Cargo 1.94.1, optimiertes Releaseprofil. Der Benchmark ist single-threaded.

## Abgrenzung der Evidenz

Die enge Einzelzyklus-Fixture überschreitet 20.000 Ereignisse/s. Daraus
folgt keine Kapazitätsabnahme für einen gemeinsamen Mehrzugzustand. Sie
belegt insbesondere noch nicht:

- 5.000 Ereignisse/s über zehn Minuten mit PostgreSQL-Persistenz und Stream;
- 4.000–5.000 gleichzeitig fahrende Züge und 120.000–180.000 materialisierte
  Läufe in einem gemeinsamen Weltzustand;
- Queue-p99, Commit-zu-Client-p99, CPU im Normalbetrieb oder 50-faches Catch-up;
- 200 gefilterte Clientabonnements und reale Netzwerkbandbreite.

Diese Werte benötigen den vollständigen produktiven v2-Single-Writer, ein
qualifiziertes deutschlandweites operatives InfraRelease und den Zielnode.
Solange diese Nachweise fehlen, bleibt das Cutover-Gate geschlossen. Der alte
synthetische M4-Ereignisbenchmark wird dafür nicht angerechnet.

## Gemeinsamer Weltzustand: Diagnose zu Issue #509

Der neue Benchmark verwendet einen gemeinsamen autoritativen Weltzustand mit
250, 1.000 oder 5.000 gleichzeitig gestarteten Fahrten. Jede Formation ist
120 m lang und fährt auf einem 1 km langen Laufweg mit 20 m/s Obergrenze.
Weitere 10 % tatsächlich materialisierte Konkurrenten beantragen dieselben
Fahrstraßen; alle konkurrierenden Locks müssen abgewiesen werden. 75 Sekunden
Simulationszeit werden in 75 extern angeforderten Zeitrevisionen verarbeitet.
Gezählt werden ausschließlich dabei entstandene fachliche Events. Nach jeder
Revision läuft die vollständige Sicherheitsinvariante und ein Zustandscommit
per kanonischem Hash. Jeder Hauptzug muss sein echtes Laufwegende erreichen.

```powershell
cargo build --release --locked -p zugfolge-sim --example operational_shared_load
./target/release/examples/operational_shared_load.exe 250
./target/release/examples/operational_shared_load.exe 1000
./target/release/examples/operational_shared_load.exe 5000
```

Unter Linux heißt die ausführbare Datei ohne `.exe`. Die Ausgabe ist JSON;
`movementNs`, `fullInvariantNs` und `stateCommitNs` trennen Ereignisverarbeitung,
vollständige Referenzprüfung und Hashcommit. Kollisionsprüfung sowie Lock- und
Signalpflege sind innerhalb der Ereignisverarbeitung noch gemeinsam gemessen.
Eine feinere Profilierung dieser drei Kosten und der echte DB-Commit bleiben
Teil des offenen Nachweises. `eventfulRevisionP95Ns/P99Ns` messen ganze
eventhaltige Revisionen, keine einzelnen Events und keine Queue-/Clientlatenz.
Die synchrone Startfixture bündelt viele Ereignisse am selben Zeitpunkt;
deshalb fallen p95 und p99 hier auf dieselbe teuerste Revision.

Messgerät am 05.09.2026: Intel Core i5-1135G7, 4 Kerne/8 Threads, 8.393.850.880
Byte physischer RAM, Windows 11 Home Insider Preview 10.0.26220, Rust 1.94.1,
Windows-GNU mit LLVM-mingw 20260826/UCRT, Releaseprofil, ein Benchmarkthread.
Das ist ein Entwicklungsrechner, keine festgelegte M9-Zielhardware. Der
Windows-Prozesszähler `PeakWorkingSet64` wurde extern im 200-ms-Raster gelesen;
er ersetzt keinen Linux-cgroup-RSS-Nachweis. Rohwerte, Fixture-/Binaryhashes und
Messgrenzen stehen in
[`benchmarks/operational-shared-world-2026-09-05.json`](benchmarks/operational-shared-world-2026-09-05.json).

| Züge + Konkurrenten | Stand | Bewegungszeit | Vollinvariante | Hashcommit | Events/s¹ | Revision-p95/p99 | Catch-up² | Peak Working Set |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 250 + 25 | vorher | 0,416 s | 1,337 s | 0,136 s | 3.609 | 0,180 s | 39,729× | 9,10 MiB |
| 250 + 25 | optimiert | 0,201 s | 0,060 s | 0,107 s | 7.474 | 0,154 s | 203,968× | 9,27 MiB |
| 1.000 + 100 | vorher | 9,695 s | 24,535 s | 0,633 s | 618 | 5,030 s | 2,151× | 20,64 MiB |
| 1.000 + 100 | optimiert | 3,168 s | 0,269 s | 0,460 s | 1.893 | 2,938 s | 19,244× | 20,45 MiB |
| 5.000 + 500 | optimiert | 102,318 s | 1,691 s | 2,735 s | 293 | 99,081 s | 0,702× | 83,25 MiB |

¹ Ausschließlich Ereignisverarbeitung, ohne die separat gezeigten
Referenz-/Hashkosten. ² 75 Sekunden Simulationszeit geteilt durch die Summe
aller drei gemessenen Phasen, ohne Aufbau. Der optimierte Aufbau dauerte
89 ms, 1.377 ms beziehungsweise 49.909 ms. Der dynamische Zustand benötigte
350.904, 1.407.281 beziehungsweise 7.104.481 JSON-Bytes.

Die 5.000-Zug-Baseline wurde nach **1.072,124 s ohne Abschluss** budgetbegrenzt
beendet. Zu diesem Zeitpunkt waren 966,422 CPU-Sekunden und 82.067.456 Byte
Peak Working Set beobachtet; es gibt keinen fertigen Endhash oder Durchsatz.
Die Baseline lief teilweise parallel zu Builds, der optimierte Lauf ohne
parallele Cargo-Builds. Diese Zeitverhältnisse sind daher diagnostische
Einzelmessungen und keine kontrollierte Speedup-Abnahme. Alle optimierten
Größen beendeten den Lauf innerhalb des vorgegebenen 180-Sekunden-Budgets.

Bei 250 und 1.000 Zügen sind Ereigniszahl, dynamische Bytezahl und vollständiger
Endzustandshash vor/nach der Optimierung exakt gleich. Die inkrementelle
Ressourcenpflege wird zusätzlich gegen eine vollständige Neuberechnung
geprüft, einschließlich geteilter Locks und Schutzbelegung. Sicherheitsprüfungen
wurden nicht entfernt. Die Vollinvariante nutzt für Blockbesitzer und gesicherte
Signale nun Indizes; Ereignisse aktualisieren nur betroffene Ressourcen und
berechnen Signale nur bei tatsächlich freigegebenen Locks neu. Übrige globale
Scans, insbesondere beim terminalen Freigabebündel, bleiben sichtbar teuer.

**Issue #509 und das M9-Lastgate bleiben offen.** Auf diesem Entwicklungsrechner
liegt der 5.000-Zug-Lauf sogar unter Echtzeit. Es fehlen weiterhin der reale
Zielhardwarelauf, feinere Kostenprofile, PostgreSQL-/Streamlast über zehn
Minuten, Queue-/Commit-zu-Client-p99, gefilterte Abonnements und der geforderte
Catch-up-Nachweis. Weder der historische Einzelzykluswert noch diese Diagnose
dürfen als abgeschlossene Produktionsabnahme verwendet werden.
