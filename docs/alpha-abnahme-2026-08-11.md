# Erweiterte Alpha — Implementierungs- und Abnahmebericht 2026-08-12

## Ergebnis

M14.1 und der dafür erforderliche Eigenbetriebs-Weltstart M9.2 sind vollständig
abgenommen. Variante B besitzt einen qualifizierten, echt signierten
InfraRelease, einen gepinnten GTFS-Planungssnapshot, PMTiles, einen
serverautoritativen Eigenbetrieb und einen echten PostgreSQL/PostGIS-/Linux-
NAPI-Startpfad. **Die erweiterte Alpha insgesamt ist trotzdem noch nicht
startbereit.** Insbesondere Odoo 19, der gemischte 50-Konten-Soak und die reale
Abnahme durch 20–50 externe Teilnehmende fehlen weiterhin.

## Verbindlicher Ausgangspunkt

- geprüfter Ausgangs-Head von `main`:
  `d46842702cd642317c323fc74b6fa36016dc95a5`;
- Arbeitsbranch: `codex/m9-expanded-alpha`;
- PR 198 ist im Ausgangs-Head enthalten. Seine Commerce-/Game-Anteile wurden
  lokal gebaut und im Node-Gesamtlauf getestet; die echten Odoo-19-Add-on-Tests
  wurden mangels lokalem Odoo-/Containerdienst **nicht** ausgeführt;
- PR 199 ist im Ausgangs-Head enthalten. Der vorhandene
  `manual_disruption_create`-Handler, der regionale Single Writer, der
  Provider-Consumer, Ersatzplanung und das M8-Eventmodell werden weitergenutzt.
  Es wurde kein zweiter Störungskern eingeführt.

## E24 und Variante B

E24/ADR-0024 zieht nur M12.1, M12.2 und M14.1 vor. M10, M11, M12.3,
M12.4 und M14.2–M14.4 bleiben Ausbau. Die ausgewählte Variante B wird durch
die Gateway-Grenze Eisenach Hbf, Nordhausen, Magdeburg Hbf, Lutherstadt
Wittenberg Hbf, Riesa, Chemnitz Hbf, Zwickau Hbf und Saalfeld (Saale)
bestimmt. Entscheidung und Auswahl sind mit GitHub-Issue #201 und dem
M14.1-Issue #192 verknüpft.

E25/ADR-0025 ergänzt für Linien über den Spielbereich hinaus eine durchgehende
`JourneyChain`. Der GTFS-Compiler erzeugt qualifizierte Grenzportale,
serverseitige Ein-/Ausfahrfenster und nicht disponierbare Außenläufe. Rust
prüft die Fenster im echten Planning-Pfad; die `ExternalZone` übernimmt den
Zug erst nach bestätigter Übergabe und gibt ihn erst nach Ressourcenprüfung
zurück. Bildfahrplan und Livemap erklären den Außenstatus ohne erfundene
Kartenposition. Spieler reichen nur eine opaque Fensterkennung ein, nie
Release-Zeitwerte.

## Statusmatrix

| Punkt | Implementierung | Ausgeführter Nachweis | Fehlender Abnahmebeweis | Status |
|---|---|---|---|---|
| M9.1 | je Spielerstart eine private, kurzlebige Tutorialwelt aus gehashtem Minimaltemplate; fünf echte Kapitel, Lutz-Coach, Session-Lifecycle, Reaper und reale Uhrtelemetrie | PGlite-Tests für Isolation, Parallelstart, Resume, Prozessneustart, Neustart, TTL, Abschluss und Telemetrie; Linux-NAPI-Integrationsfall durch Economy/Fleet/Planning/Operating/Disruption/Ledger; Routen- und Web-Tests | externer Browserlauf gegen eine frisch erzeugte Sitzung und gemessener Nachweis Median ≈ 12 min, 90 % unter 15 min, erste Entscheidung unter 90 s fehlen | in Arbeit |
| M9.2 | deterministischer Blueprint, Release-Pins, gestaffelte Lose und vollständiger Eigenbetrieb | echter PostgreSQL/PostGIS-/Linux-NAPI-Weltstart mit 49 Losen und 1.634 Zugfahrten; Livemap, Betriebszentrale und Odoo-Outbox vollständig; Wiederanlauf idempotent | — | erledigt |
| M9.3 | öffentlicher Einstieg ohne Startpaket; tatsächliche `StartingCapitalPolicy`, Heatmap, Assistentenwarnungen und Glossar | Negativtests belegen fehlende Startpaketrouten und dass Odoo-Einladungen nur die öffentliche Zielwelt provisionieren; Tutorialzustand bleibt isoliert | Integration der parallelen Startkapital-Policy sowie externer Browserlauf gegen signierten Weltbestand fehlen | in Arbeit |
| M9.4 | typisierter Katalog, Begründung/Risiko/Vorschau, Vier-Augen-Trennung, signierter Webhook, Game-Queue, Reautorisierung, Ergebnisprojektion und Game-Audit; Kontenentzug deaktiviert Keycloak und entzieht den Weltzugang ausschließlich über den Hochrisikopfad; direkte Produktionseinstiege gesperrt | Commerce-/Game-API-Tests einschließlich Hochrisikoablehnung und Odoo/Game-E2E; Browser-Rendering | Odoo-19-Add-on-Testdienst und realer Webhook-/Queue-/Vier-Augen-Run des neuen `alpha:phase3`-Drills nicht ausgeführt | in Arbeit |
| M9.5 | Korrelations-IDs, strukturierte Logs, Metriken, Traceparent, Healthzustände, Alerts, Live-Dashboard, getrennte Backup-/Restore-Skripte mit Fachzustands- und Filestore-Baumhash sowie reproduzierbarer Restore-/Alert-Drill | echter PostgreSQL-16.14-Restore mit identischem Zustands-Hash; unabhängiger Validierungssatz und echte InfraRelease-Signatur; Odoo-Backupmechanik mit DB-/Filestorefixture; Repository-Vertragstests des Phase-3-Drills | echter Odoo-19-Restore mit Modulupgrade/Test/Anhangsstichprobe und produktive Alert-/Dashboard-Abnahme fehlen | blockiert |
| M9.6 | persistenter Guard nach Identität/Welt/Endpunkt/Aktion, Replay-/Massen-/Koordinationssignale, abgestufte Reaktionen, Einspruch, schwere Sanktion nur über Odoo | Game-API- und Alpha-Tests; produktiv an Gebote, Trassenfenster und Kooperationsmärkte gebunden | gemischter 50-Konten-Anti-Bot-Lastfall und operative Einspruchsabnahme fehlen | in Arbeit |
| M9.7 | read-only Welt-/Simulation-/Queue-/Bridge-/Marktprojektion, Drill-down-Verweise, Datenalter und pseudonymisiertes Feedback; Feedback und Odoo-Outbox entstehen atomar, Odoo-Inhalt bleibt unveränderlich und nur die Triage bearbeitbar; Live-Metriken sind registriert | Browsergerenderte Monitoringansicht; Alpha-/Game-/Commerce-Tests für atomare Pseudonymprojektion und begrenzte Metriklabels | keine laufende Odoo-19-Instanz und kein realer Alpha-Feedback-/Monitoringbetrieb des `alpha:phase3`-Drills | in Arbeit |
| M9.8 | letzte Periode ohne neue Ausschreibung, getrennte Ranglisten, Archiv, Rollen-Replay, Aufbewahrung und Abschluss-Hash; autorisierte Replay-Exportroute produktiv registriert | 3 Tests für kurze, lange und unbefristete Profile sowie Game-API-Routentest | kein kompletter Weltlauf und keine operative Archiv-/Datenschutzabnahme | in Arbeit |
| M9.9 | Deployment-/Rollback-Bausteine, Datenschutz-/Feedbackmodell und Monitoringgrundlagen | Kernlast 180.000 Fahrten / 3.960.000 Events, Restore-Nachweis | kein gemischter Mehrperioden-Soak mit 50 Konten, kein Failover-Gesamtlauf und keine 20–50 realen externen Spieler | blockiert |
| M9.10 | qualifizierter jährlicher InfraRelease, Odoo-Vier-Augen-Antrag, erneute Game-Sicherheitsprüfung, exakter Periodenwechsel, Abbruch/Rollback/Audit | fünf Originalquellen und sechs Artefakte bytegenau geprüft; echte Ed25519-Signatur; 2 Infra-Update-Tests einschließlich Klasse-C-Sperre | echter Odoo-19-Durchlauf und vollständiger Periodenwechsel einer laufenden Alpha fehlen | in Arbeit |
| M12.1 | Traktion, Fahrzeugmiete, Anschlusswartezeit und Ersatzverkehrshilfe; vollständige dunkle Spieleroberfläche für Angebot/Annahme/Ablehnung, Fristen und Vertragsende; Cent-Ledger, Postfach, Audit, Events, Welt- und Konfliktprüfungen | Kooperation 7 Tests; Game-Web-Render-, Integer-Cent-, Client- und Klickverdrahtungstests; Fastify/PGlite-Zwei-Spieler-E2E beweist getrennte Tokens, Angebot, Annahme, zwei Ledgertransaktionen/vier Buchungen mit Nullsumme, Postfach und Audit | externer Zwei-Browser-Lauf gegen die Alpha-Zielumgebung fehlt | in Arbeit |
| M12.2 | Spieleroberfläche für Angebot/Suche/Reservierung/Übergabe/Rückabwicklung; Verkauf/Vermietung, unveränderliche Identität und Historie, Zustand/Schäden/Fristen, Bindungen und Doppelbindungs-Schutz | Game-Web-Tests rendern und verdrahten alle Marktaktionen sowie 50 suchbare Angebote; Fastify/PGlite handelt 20 konkrete Fahrzeuge parallel mit Rust-Flotten-Single-Writer, Cent-Ledger, Historienkette und stale-revision-Abwehr; Kooperation-, Economy-/Runtime-Tests bleiben grün | externer Browserlauf und reale Marktlast in der Alpha-Zielumgebung fehlen | in Arbeit |
| M14.1 | Variante-B-Grenze, Rechtequelle, PBF-/GTFS-Pipeline, Qualitätsreport A/B/C; E25-Fahrtketten, Grenzfenster, ExternalZone, Spielerprojektion, PMTiles und Eigenbetrieb | signierter Release `9c44c17c…c37e17`; 12.505 Validierungen; echter Weltstart, Tageslauf, Backup/Restore, Last-/Speichervergleich und tägliche Wiederholung von 1.634 Zügen/909 Grenzkommandos | —; M14.2–M14.4 und reale Alpha bleiben ausdrücklich außerhalb dieses Teilabschlusses | erledigt |

## PR-198-Prüfung

Ausgeführt wurden Build, Typecheck und Tests des Commerce-Pakets sowie der
Game API. Der produktive Pfad verarbeitet einen signierten Odoo-Webhook nur
über die persistente Game-Queue, prüft Akteur, Capability, Welt und Fachregel
erneut und bindet Ergebnis sowie Auditereignis unveränderlich aneinander.
`adminControl: "odoo"` exponiert keine direkten produktiven Game-Adminrouten.

Nicht nachgewiesen sind die Python-Tests des Add-ons unter Odoo 19. Dafür ist
ein getrennter CI-Job mit `odoo:19.0-20260723`,
`postgres:16.14-trixie` und dem gepinnten OCA-Queue-Commit
`d2c1759102f1e0bc8f6244629b5b38c7b7882f36` ergänzt, aber für diesen lokalen
Branch noch nicht gelaufen. Vor einem Merge darf dieses offene Kästchen nicht
als grün ausgegeben werden.

## Wiederverwendung aus PR 199

Der Admin-Handler `manual_disruption_create` ruft weiterhin den vorhandenen
regionalen Simulations-Worker auf. Providerabgleich, Störungswirkung,
Ersatzplanung, Livemapprojektion und M8-Auditereignisse bleiben die
autoritativen PR-199-Pfade. M12.1 verknüpft lediglich die neue
EVU-Ersatzverkehrshilfe mit einer vorhandenen Störungskennung; es entsteht
keine konkurrierende Störungszustandsmaschine.

## Variante-B-Datenbeweis

Die historischen Geofabrik-PBFs für Sachsen (266.912.848 Byte),
Sachsen-Anhalt (173.361.775 Byte) und Thüringen (158.982.127 Byte), das
GTFS-Original sowie sämtliche abgeleiteten Daten liegen im getrennten
Evidenzspeicher. Der vollständige Release-Prüfer las fünf Quellen und sechs
Artefakte bytegenau:

```text
releaseId=infra-mitteldeutschland-b-2026.1
releaseHash=9c44c17c887f0960402ea01ece7c08127cfb802efcf9c43ecd6d02c381c37e17
signatureValid=true sources=5 artifacts=6
```

Snapshot v2 enthält 2.480 spielbare Segmente, 1.931 Außenläufe und 1.675
grundsätzlich bestellbare Fahrtketten; die Netzqualifizierung gibt 1.634 frei.
47.614 Blöcke, 51.066 Fahrstraßen und 1.654 Konfliktressourcen sind
reproduzierbar gehasht. Klasse C ist sichtbar und nicht bestellbar. Details,
Rechteabweichungen und Spielerplanung stehen in
`docs/mitteldeutschland-alpha.md`. Die getrennte Datenebene liegt unter
`C:\Users\laryn\Zugfolge-Alpha-Evidence\mitteldeutschland-b\2026-08` und
wird wegen E16/ODbL nicht in den Projektquelltext aufgenommen.

## Backup-/Restore-Beweis

Ein echter PostgreSQL-16.14-/PostGIS-3.4.2-Dienst startete den signierten
Variante-B-Weltbestand. Der 820.099-Byte-Custom-Dump hat SHA-256
`622ba1e1ba889a1d9df38ac01042c472c01d057390343ba7c25a4ff46dd92d48`.
Quelle und isolierte Restore-Datenbank enthalten jeweils 46 Tabellen und
10.143 Zeilen mit identischem autoritativem Hash
`04563c570d0943f7c8a43d0f3cc4c789a31a80e18575563c24345dfbf4e57531`.

Die getrennte Odoo-Backupmechanik wurde mit demselben echten PostgreSQL-Dienst
und einem realen Filestore-Fixture geprüft. DB-Dump und Filestore-Archiv wurden
jeweils gehasht und isoliert restauriert. Das beweist die Mechanik, **nicht**
den Restore einer echten Odoo-19-Produktionsdatenbank.

## Integrierter Alpha-Abnahmefall

| Schritt | Ergebnis |
|---|---|
| 1. Variante-B-Welt startet vollständig im Eigenbetrieb | bestanden: 49 Lose, 1.634 Zugfahrten, 487 Umläufe/Fahrzeuge/Dienste und 1.634 Trassen; alle produktiven Projektionen bereit |
| 2. Spieler absolviert das Tutorial | Repositorytests erzeugen eine eigene Welt, führen fünf Kapitel über echte APIs/Fachwriter aus, zeigen die Rechnung und archivieren; externer Browser- und Zeitnachweis offen |
| 3. Öffentlicher Einstieg | Odoo-Einladung erzeugt nur öffentliche Identität/Zugang; keine Startausstattung und keine statische Tutorialwelt. Anzeige/Abnahme der parallelen `StartingCapitalPolicy` bleibt offen |
| 4. Zwei Spieler schließen Vertrag | Repository-E2E mit zwei getrennten Tokens besteht Angebot und Annahme einschließlich Ledger, Postfach und Audit; Klickoberfläche und Clientvertrag getestet; externer Zwei-Browser-Lauf offen |
| 5. Sekundärmarktübertragung | Repository-E2E handelt 20 Fahrzeuge parallel über Angebot, Reservierung und Rust-Single-Writer-Übergabe; Historie und Doppelbindungs-Schutz grün; externer Browser-/Marktlastlauf offen |
| 6. Störung und EVU-Hilfe | PR-199-Störungspfad und Hilfsvertrag vorhanden, kombinierter E2E fehlt |
| 7. Odoo-Monitoring | Projektionscode und Browserrendering vorhanden, echter Odoo-Lauf fehlt |
| 8. Hochrisiko-Vier-Augen-Fall | Game-/Commerce-Test vorhanden, echter Odoo-Lauf fehlt |
| 9. Backup/Restore | Game-PostgreSQL/PostGIS bitgleich erfüllt; echter Odoo-19-Restore offen |
| 10. Weltende | Kernfälle getestet, kompletter Weltlauf offen |
| 11. InfraRelease über Odoo | Release qualifiziert und signiert; Game-Sicherheits-/Periodenlogik getestet, echter Odoo-19-Periodenlauf offen |

Damit ist der integrierte Alpha-Abnahmefall als Ganzes **nicht bestanden**.

## Tatsächlich ausgeführte Prüfungen

| Befehl/Prüfung | Echtes Ergebnis |
|---|---|
| `cargo fmt --all --check` | nach einer mechanischen Formatkorrektur grün |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | grün |
| `cargo test --workspace --all-targets` | 519 Tests aufgelistet und vollständig grün |
| `cargo test --workspace --all-targets --all-features` | Windows-GNU-NAPI-Testbinärlink scheitert an Node-ABI-Symbolen; kein Linux-NAPI-Beweis |
| `pnpm build` | grün für 27 Workspace-Projekte |
| `pnpm typecheck` | grün für 27 Workspace-Projekte |
| `pnpm test` | 513 bestanden, 5 bedingt übersprungen; die bedingten nativen/DB-Fälle wurden zusätzlich gegen echtes Linux-NAPI und PostgreSQL ausgeführt |
| echter PostgreSQL-/PostGIS-Weltstart | Schema gesund; 49 Lose und 1.634 Zugfahrten; Livemap/Betriebszentrale/Odoo-Outbox vollständig; Wiederanlauf idempotent |
| `pnpm guards` | 13 Regeln / 587 Dateien, keine Befunde |
| Node-Lizenzscan | 126 Abhängigkeiten, 0 offen, 2 begründete MPL-Ausnahmen |
| `pnpm audit --prod --audit-level high` | keine bekannte Schwachstelle |
| `cargo-deny 0.20.2 check` | advisories/bans/licenses/sources grün; sieben ungenutzte Allowlist-Hinweise |
| `cargo-audit 0.22.2 audit --deny warnings` | 62 Lockfile-Abhängigkeiten, kein Befund |
| `cargo run --release --locked -p zugfolge-load -- 180000` | 3.960.000 Events, 2.624.221 Events/s, Ziel erfüllt |
| Game-Backup/Restore und Hashvergleich | erfüllt, Hash bitgleich |
| Odoo-Backupmechanik | DB-/Filestorefixture bitgleich; kein echter Odoo-App-Restore |
| `node --test .github/scripts/sync-milestones.test.mjs` | 7/7 grün |
| `node .github/scripts/sync-milestones.mjs check` | M0–M14, 65 Arbeitspakete und Statusmatrix konsistent |
| `node tools/region-import/verify-release.mjs …` | 5 Originalquellen und 6 externe Artefakte bytegenau grün; Releasehash `9c44c17c…c37e17`; Ed25519-Signatur gültig |
| `actionlint 1.7.12` | alle GitHub-Actions-Workflows ohne Befund |
| Action-Tag-Prüfung per offiziellem Git-Remote | checkout/setup-node/upload-artifact v7, pnpm/setup v6, cargo-deny-action v2.1.1, rust-cache v2.9.2 und rust-toolchain stable vorhanden |
| Odoo-19-Add-on-Testdienst | nicht lokal ausführbar; neuer CI-Job noch nicht gelaufen |
| echter Linux-NAPI-Smoke | Release-Build und Smoke unter Ubuntu 24.04/Node 24.14.0 grün; Fleet-, Regional- und Betriebsruntime samt idempotentem Replay |
| Historischer v1-Rekurrenznachweis (mit dem harten E31-Cutover entfernt) | 1.634 Materialisierungen, 909 Grenzkommandos, 1 Cleanup und 2.544 eindeutige Kommandos im damaligen ersten Wiederholungsfenster; kein v2-Abnahmebeleg |
| M14-Tageslauf | 909 Grenzübergänge ohne Ressourcenkonflikt; Restore-Hash `25b65c6f…da6be` bitgleich |
| Phase-2-Paketläufe | Economy 42, Alpha 6, Game API 103 und Game Web 23 Tests grün; darunter beide PGlite-E2Es, OIDC-PKCE, Reset/Späteinladung und Projektion nach Commit |
| Phase-4-Paketläufe | Game Web 40 Tests grün; Kooperation 7 Tests grün; Game-API-M12-E2E 4 Tests grün, darunter Zwei-Spieler-Ledger/Postfach/Audit und 20 parallele Fahrzeugübertragungen |
| Phase-2-Web-/Static-Smoke | Vite-Produktionsbuild grün; SPA-Root und injizierte Runtime-Konfiguration jeweils HTTP 200 |
| gemischter 50-Konten-Mehrperioden-Soak | nicht ausgeführt |
| reale geschlossene Alpha | nicht gestartet und nicht behauptet |

### Ergänzender Tutorial-Session-Vorabbeweis (2026-08-13)

Dieser Abschnitt ergänzt den historischen Phase-2-Stand oben, ohne damalige
Ergebnisse umzudeuten. Auf dem Tutorial-Branch wurden lokal ausgeführt:

| Prüfung | Ergebnis |
|---|---|
| `pnpm -r --stream typecheck` | 27 Workspace-Projekte grün |
| `pnpm -r --stream build` | 27 Workspace-Projekte grün, einschließlich Game-Web-Produktionsbuild |
| `pnpm -r --stream test` | alle unbedingten Workspace-Suiten grün; native Tutorial-/Browser-Suiten lokal mangels Node-Addon-Artefakten bedingt übersprungen |
| `cargo fmt --all -- --check` | grün |
| `cargo test --locked -p zugfolge-rules -p zugfolge-runtime-napi` | grün; acht Rules-Tests plus 48-Stunden-Replay |
| `cargo clippy --locked -p zugfolge-rules -p zugfolge-runtime-napi --all-targets -- -D warnings` | grün |
| Repository-Wächter | 13 Regeln / 745 Dateien, keine Befunde |
| Node-Lizenzscan | 152 Abhängigkeiten, 0 offen, 2 bestehende begründete MPL-Ausnahmen |
| Odoo-Vertragstest plus Python-/XML-Syntaxprüfung | grün; kein Startpaketfeld und kein Tutorial-Reset im Add-on-Vertrag |
| Milestone-Synchronität | 7/7 Tests und M0–M14 / 65 Arbeitspakete konsistent |
| `git diff --check` | grün |

Der CI-Job `Native Runtime ABI (Linux, echtes NAPI)` baut zusätzlich beide
Node-Addons und führt `tutorial-world-factory.native.integration.test.ts` sowie
`tutorial-browser.e2e.test.ts` aus. Der Browser-E2E benutzt Chrome/Chromium,
den Game-Web-Produktionsbuild und echte HTTP-APIs; Kapitel werden nicht per
Datenbankmanipulation abgeschlossen. Sein PR-Ergebnis ist erst nach dem Push
ein CI-Beleg. Die externe 90-Prozent-unter-15-Minuten-Abnahme bleibt davon
unverändert offen.

## Gerenderte Odoo-Ansichten

Die folgenden Bilder sind browsergerenderte, barrierefrei beschriftete
Testprojektionen der Add-on-Oberflächen. Sie sind kein Screenshot einer
laufenden Odoo-19-Instanz:

- `docs/screenshots/odoo-monitoring-preview.png`;
- `docs/screenshots/odoo-admin-four-eyes-preview.png`.

## Externe Blockaden und nächste Freigaben

1. Der Odoo-19-CI-Job und ein echter Odoo-19-Backup-/Restore- sowie
   Periodenwechsel-Lauf müssen für den Liefercommit real grün laufen.
2. Der gemischte 50-Konten-Mehrperioden-Soak samt Ausfällen von Odoo,
   Provider, Worker und Clientverbindungen ist noch auszuführen.
3. Das spielergebundene Tutorial besitzt zusammenhängende Repository- und
   native CI-E2Es. Offen bleiben der externe Browserlauf gegen frisch erzeugte
   Sitzungen, die gemessene 15-Minuten-Abnahme sowie
   die integrierten Spieler-E2Es für Kooperationsmarkt und Weltende; diese
   Nachweise sind für die Gesamtalpha weiterhin erforderlich.
4. Vor einem realen Alpha-Start sind Freigabe, Teilnehmerkreis und
   Betriebsumgebung ausdrücklich festzulegen. Ein Bot- oder Lasttest ersetzt
   diesen Nachweis nicht.
