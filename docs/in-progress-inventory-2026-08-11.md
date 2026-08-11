# Inventur der beim Start laufenden Roadmap-Arbeit

Stand der Inventur: `main` bei
`eb5831edefa6f430395492b5675cc9a341f3abbd` (11. August 2026). Die Tabelle ist
die Scope-Grenze des Abnahmeauftrags. M7, M8 und andere zuvor offene
Teilabschnitte werden nicht begonnen.

Ein Status wird erst nach einem ausgefuehrten, reproduzierbaren Beweis
geaendert. Externe Voraussetzungen werden weder durch Testdaten noch durch
einen lokalen Ersatznachweis als erfuellt dargestellt.

## Direkt als `in Arbeit` gefuehrte Teilabschnitte

| Teilabschnitt | Restluecke beim Start | Abnahmebeweis | Implementierungsplan |
|---|---|---|---|
| M1.13 | Der Pilot ist nur gegen denselben technischen Wert kalibriert, der anschliessend verglichen wird. Belastbare Detailprofile, ein davon disjunkter eingefrorener Validierungssatz, die benannte Release-Identitaet und deren echte Signatur fehlen. Die bestehende Hashkette beweist zudem noch nicht jeden Uebergang von Capture bis Bundle. | Ein Dritter reproduziert Capture/Normalisierung, Modell und Report aus unveraenderlichen Artefakten. Das Gate beweist die Disjunktheit von Kalibrierung und Validierung, sperrt negative oder unzureichende Ergebnisse und verifiziert ein durch die benannte Verantwortung signiertes Bundle. | Die maschinelle Hash- und Disjunktheitskette vervollstaendigen und negativ testen. Nur freigegebene externe Profile/Referenzen verwenden. Datenfreigabe und private Signatur als externe Blockade dokumentieren, solange sie fehlen. |
| M3.10 | Der Client liest eine persistierte Projektion, aber kein Produktionsadapter erzeugt sie aus einem echten Rust-`PlanningRun`. Die Alternative ist nicht versionsgebunden, wird nach `202 Accepted` nicht serverautoritaer neu geladen und besitzt keinen Browser-E2E-Beweis. | Zwei authentifizierte Antragsteller erzeugen konkurrierende Trassen. Rust entscheidet mit festem Seed, API und Client zeigen Ressource, Fenster, beide Fahrten, Konfliktart, Begruendung und Alternative. Das Anwenden erzeugt eine neue konfliktfreie Projektion; Replay ist hashgleich. | Einen versionierten Projektions-/Kommandokontrakt und den napi-rs-Runtimepfad bauen, serverseitige Projektionsrevision und stabile Angebots-ID erzwingen, Client neu laden und den kompletten HTTP-/Clientpfad testen. |
| M4.6 | Snapshot/SSE sind nicht authentifiziert; Feed und Replay leben nur im API-Prozess; Snapshot-Subscribe besitzt ein Race. Der Rust-Publisher hat keinen Produktionsaufrufer. Luecken-, Backpressure- und Reconnecttests enden an Testdoubles; die sichtbare Karte enthaelt feste Zuglaufdaten. | Ein echter Rust-Lauf liefert einen weltisolierten Snapshot und Deltas. Ein automatisierter Clientfall prueft Abbruch, Resume, Luecke, Reset/Re-Snapshot, Queuegrenze, Heartbeat/Cleanup und den abschliessenden sichtbaren Zustand gegen den autoritativen Snapshot. | Den gemeinsamen Rust-Runtimepfad an Eventlog und Feed binden, Snapshot/Stream autorisieren, Resume restartfest machen, stillen Leerfallback entfernen, Interpolation vom Fachzustand trennen und HTTP-/Client-E2E ergaenzen. |
| M6.7 | Der revisionierte TypeScript-Wirtschaftsablauf persistiert und liefert Ledger/Postfach, aber er ist der autoritative Entscheider. Es gibt weder einen Rust-Befehl fuer den Betriebsuebergang noch einen realen napi-rs-Single-Writer. Der eingespielte M5-Snapshot beweist nur JSON-Integritaet, nicht seine Ableitung aus kanonischem Rust-Zustand. Eigenbetrieb wird nicht bis zu ersatzweise materialisierten Fahrten und Livemap projiziert. | Ein realer Runtimefall zeigt Altbetreiberpflicht bis zum Stichtag, Wiedergewinn, erfolgreichen Wechsel und Mobilisierungsfehler. Rust nimmt das Kommando an und emittiert pruefbare Events; Zustand, Ledger, Postfach, Livemap und Ersatzfahrten sind persistent, idempotent und nach Replay hashgleich. | Flottennachweis aus dem Rust-Zustand ableiten, Betriebsuebergang als Rust-Kommando/Event modellieren, Kommando und Events lueckenlos persistieren und deren Projektionen in Wirtschaft und Livemap integrieren. TypeScript bleibt Adapter/Projektion, nicht Ersatzentscheider. |

## Im Manifest als `in_progress` gefuehrte Ebenen

| Milestone/Ebene | Konkreter Startbefund | Abschluss- oder Blockierkriterium |
|---|---|---|
| M1 Kern, Integration | Werkzeug und Kalibrierlauf stehen; unabhaengige Qualifikation und signierter Pilot-Release fehlen. | Kern nach vollstaendiger maschineller Qualifikationskette pruefen; Integration bis zu freigegebenem Validierungssatz und echter Signatur blockieren. |
| M2 Betrieb, Abnahme | Weltisolation, Ledger, Postfach und Datenschutz besitzen Datenbanktests. Ein aktueller Gesamtlauf und ein externer Betriebsnachweis fehlen; GitHub Actions ist wegen Account-Abrechnung blockiert. | Lokale PGlite-/API-Abnahme ausfuehren. Externen CI-/Betriebsstatus getrennt und mit realem Workflowlauf belegen. |
| M3 Integration | Der fachliche Rust-Kern steht, der echte Planner-Clientpfad nicht. | M3.10-E2E ueber Rust, Persistenz, API und Client. |
| M4 Integration | Kern, Eventlog- und SSE-Bausteine stehen, der reale Rust-Produktionspfad und die robuste Clientabnahme nicht. | M4.6-E2E und restartfester Replay-/Resume-Beweis. |
| M5 Integration, Abnahme | Flottenregeln und Tests stehen, aber kein produktiver Rust-Lebenszyklus erzeugt den Mobilisierungsnachweis oder Zusatzfahrten fuer API/Livemap. | Derselbe Single-Writer-E2E wie M6.7 muss M5-Zustand, Mobilisierung und materialisierte Fahrten benutzen. |
| M6 Integration | TypeScript-Persistenz ist integriert; der verbindliche Rust-Uebergang fehlt. | M6.7-E2E ueber den echten Single-Writer. |
| M9 Kern, Integration | Alle direkten M9-Teilabschnitte stehen noch auf `offen`; vorhanden ist nur die vorgezogene Health-Grundlage. M7 und M8 sind nicht begonnen und laut Auftrag ausserhalb des Scopes. | Den Manifestwiderspruch korrigieren. M9 darf weder als begonnen noch als abgeschlossen gelten; externe CI-, Ruleset-, Monitoring-, Backup-/Restore- und Alpha-Nachweise bleiben getrennt. |

## Ergebnis auf PR #66

Der finale Implementierungsstand ist Commit
[`e289511`](https://github.com/larynxberlin-rgb/Zugfolge/commit/e289511bf12832b320b5c18718939de6df2e9e92)
auf [PR #66](https://github.com/larynxberlin-rgb/Zugfolge/pull/66). Run
[`31482747553`](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/31482747553)
lief auf genau diesem Head vollständig grün. Dazu gehören der echte
Linux-NAPI-Pfad, der mit PGlite komponierte Planning-Worker, der M6-End-to-End-
Fall, Postgres/API-Integration, Rust und Determinismus, TypeScript, Wächter,
Lastziel, Referenzkorpus, beide Lizenzprüfungen und der Node-Sicherheits-Scan.

| Bereich | Erreichter Stand | Ausgeführter Beleg | Endstatus |
|---|---|---|---|
| M1.13 | Durchgehende Hashkette von Capture und Normalisierung über disjunkte Kalibrierungs-/Validierungsbestände bis Report, Release und Signaturbundle; negative Qualifikationen und Manipulation bleiben gesperrt | 24 fokussierte Tests lokal und Referenzkorpus-Job in Run 31482747553 grün; reale Trassenfinder-Kalibrierung +3 s innerhalb ±63 s und getrennter 85-Fahrten-GTFS-Holdout | erledigt / nachgewiesen im M1-Abnahmeschnitt; produktive unabhängige Qualifikation und Signatur bleiben getrennt in #48 |
| M2 Betrieb/Abnahme | Weltisolation, Authentifizierung, Ledger, Postfach, Datenschutz und Replay gemeinsam geprüft | lokaler Vollstack sowie Postgres/API-Job in Run 31482747553 grün | nachgewiesen |
| M3.10 | Zwei kontogebundene Trassenanträge, echter Rust-PlanningRun, atomarer Worker, revisionsgebundene Alternative und echter Client | Planning-NAPI-Smoke, PGlite-Worker, TypeScript und API-Job in Run 31482747553 grün | erledigt / nachgewiesen |
| M4.6 | Persistenter Regional-Single-Writer, Commit-vor-Fanout, authentifiziertes Snapshot/SSE, restartfester `streamId:sequence`-Cursor und Client-Re-Snapshot/Interpolation | echter Regional-NAPI-Smoke, API-/Clienttests und Lastjob in Run 31482747553 grün | erledigt / nachgewiesen |
| M5 Integration/Abnahme | Rust friert Authority-Fakten ein und leitet Mobilisierung nur aus Intent-Kommandos ab; Checkpoint, Replay-Beleg und Snapshot werden atomar persistiert | produktive M5-HTTP-Routen und historischer Replay im M6-Native-End-to-End von Run 31482747553 grün | nachgewiesen |
| M6.7 | Rust-Single-Writer für Stichtag, Wiedergewinn, Wechsel und Mobilisierungsfehler; atomare Events mit Ledger-, Postfach- und Livemap-Projektion | echter M5→M6-NAPI-/PGlite-End-to-End in Run 31482747553 grün | erledigt / nachgewiesen |
| M9 Kern/Integration | Keine M9-Arbeit begonnen; die vorhandene Health-Grundlage beginnt keinen direkten M9-Teilabschnitt | Manifestwiderspruch gegen die weiterhin offenen M9-Zeilen korrigiert | nicht begonnen; Betrieb/Abnahme durch Abhängigkeiten blockiert |

## Nachgelagerte Betriebsreife-Arbeit

- Issue #48 bleibt als eigenständiger M9-Folgepunkt offen: Eine produktive
  Release-Freigabe braucht unabhängig freigegebene
  Infrastruktur-/Fahrzeugprofile, einen nicht zur Kalibrierung verwendeten
  technischen Validierungssatz und die Signatur der benannten
  Release-Verantwortung. Kein synthetischer Test ersetzt diesen Nachweis; die
  fehlende Produktivfreigabe blockiert den fachlich abgenommenen M1-Milestone
  jedoch nicht.

Die früheren Voraussetzungen #29, #55 und #56 sind geschlossen. GitHub Actions
läuft wieder; Ruleset und Milestone-Synchronisierung sind daher keine aktuellen
Blocker mehr. Issue #34 wurde mit der auf PR #66 grün nachgewiesenen M4.6-
Implementierung geschlossen. Die Roadmap-Tracking-Issues für M1.13, M3.10,
M4.6 und M6.7 werden durch den korrigierten Synchronisierer zusammen mit den
zugehörigen GitHub-Milestones abgeschlossen.
