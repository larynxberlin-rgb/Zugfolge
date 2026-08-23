# Lastnachweis der autoritativen Betriebsengine

Stand: 23. August 2026. Vertrag: E31 / `operational-core-benchmark/v1`.

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

Der Kernbenchmark belegt das 20.000/s-Ziel für die neue fachliche
Ausführungsschicht. Er belegt ausdrücklich noch nicht:

- 5.000 Ereignisse/s über zehn Minuten mit PostgreSQL-Persistenz und Stream;
- 4.000–5.000 gleichzeitig fahrende Züge und 120.000–180.000 materialisierte
  Läufe in einem gemeinsamen Weltzustand;
- Queue-p99, Commit-zu-Client-p99, CPU im Normalbetrieb oder 50-faches Catch-up;
- 200 gefilterte Clientabonnements und reale Netzwerkbandbreite.

Diese Werte benötigen den vollständigen produktiven v2-Single-Writer, ein
qualifiziertes deutschlandweites operatives InfraRelease und den Zielnode.
Solange diese Nachweise fehlen, bleibt das Cutover-Gate geschlossen. Der alte
synthetische M4-Ereignisbenchmark wird dafür nicht angerechnet.
