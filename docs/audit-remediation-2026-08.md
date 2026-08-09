# Audit-Nacharbeiten vom 9. August 2026

Dieses Dokument ist die prüfbare Zuordnung zwischen dem vollständigen
Repository-Audit, den GitHub-Issues #28–#60 und dem Remediation-PR. Ein Issue
gilt nur dann als erledigt, wenn sein Nachweis im Repository reproduzierbar
ist. Externe Daten, GitHub-Abrechnung und Repository-Adminregeln werden nicht
als Quellcode-Fix ausgegeben.

## Umgesetzte Fehlerkorrekturen

| Issues | Umsetzung und Nachweis |
|---|---|
| #28 | `zugfolge-fleet` strukturell repariert; M5.13-Freigabeprüfung ergänzt; alle Fleet-Tests kompilieren und laufen. |
| #30–#32 | Widerrufene Weltzugänge werden an jeder Kontogrenze abgewiesen; öffentliche Roster enthalten kein Keycloak-Subject; der 90-Tage-Purge entkoppelt Subjects und Rollen idempotent. |
| #33 | Atomare, lückenlose Event-Batches mit per-world Zeilensperre; persistente Ingest- und begrenzte Replay-API. |
| #35–#36 | Livemap-Registry mit TTL, LRU und hartem Limit; unbekannte Welten erzeugen keinen Feed; dynamische Inhalte werden ausschließlich über DOM-/SVG-Textknoten geschrieben. |
| #37–#39 | Harte Check-Timeouts/Abort, sanitisiertes öffentliches Fehlerformat und Readiness für Schema, Keycloak-JWKS, Eventlog-Fortschritt, M6-Outbox und Livemap-Frische. |
| #40–#42 | Transaktionale M6-Outbox sowie eindeutige, weltgebundene Idempotenzschlüssel in Ledger und Postfach; stabile Notice-IDs; Fachzeitpunkt wird als `sent_at` erhalten. |
| #43–#46 | Anforderungsschwerpunkt fließt gedeckelt in die Wertung; Periode nur einmal abrechenbar; negative Leistungswerte abgewiesen; Insolvenzfolgen ab der jeweiligen Stufe zentral durchgesetzt. |
| #47 | Verwundbares `esbuild` wird auf 0.25.12 überschrieben; `pnpm audit --audit-level=moderate` ist ohne Befund. |
| #49 | TypeScript nutzt bytegleich die Rust-Substreams; gemeinsame Golden-Vektoren prüfen SHA-256-Ableitung und ersten RNG-Wert. |
| #50 | M5.10-Güte wird aus tatsächlich geplanten Automatik-/Handvarianten gleicher Leistung ermittelt, nicht aus fest codierten Summen. |
| #59 | Zusammengesetzte Welt-Fremdschlüssel bis Konto, EVU, Ledger, Postfach und Simulationskommando; negative Cross-World-DB-Tests. |
| #60 | SSE-Heartbeat, begrenzte Queue, Backpressure, Cleanup, `Last-Event-ID`-Replay und Reset bei zu altem Ringpuffer. |

## Umgesetzte Integrations- und Qualitätsverbesserungen

| Issues | Umsetzung und Nachweis |
|---|---|
| #34 | Geschützter, validierter Simulations-Ingest-Pfad zur Livemap und End-to-End-API-Test. Der reale Rust-Dienst muss diesen Vertrag im Deployment noch aufrufen; das Issue bleibt bis zu diesem Betriebsnachweis offen. |
| #51 | Revisionierter M6-Weltzustand in JSONB mit BigInt/Map/Set-Codec, optimistischer Konkurrenzkontrolle, transaktionaler Outbox und authentifizierter Lese-API. Der periodische Produktiv-Worker bleibt bis zur Runtime-Verdrahtung offen. |
| #52 | Mobilisierung akzeptiert keine boolesche Selbstauskunft mehr, sondern konkrete M5-Formations-, Dienst- und Trassenreferenzen samt Fleet-Revision. Der End-to-End-Nachweis mit dem laufenden Rust-Single-Writer bleibt offen. |
| #53 | Der Produktivclient verwendet keinen automatischen Beispieldatensatz mehr: Planner-Projektionen kommen aus dem Eventlog über die authentifizierte API; Alternativen werden als idempotente, persistente Simulationskommandos eingereiht. `?demo=1` bleibt ausdrücklich als Demo. |
| #54 | Persistentes Eventlog, lückenlose Batch-Annahme, authentifiziertes Replay sowie poll-/quittierbare Simulationskommandos. |
| #57 | Eigene CI-Jobs für API-Integration, M4.11-Lastziel und Node-Sicherheitsaudit; harte Zeitlimits für alle Jobs. |
| #58 | README und Milestone-Status unterscheiden wieder Implementierung, reproduzierbaren Beweis und externe Restarbeit. |

## Nicht durch Quellcode abschließbar

| Issue | Restarbeit und Abschlussbedingung |
|---|---|
| #29 | GitHub sperrt Workflow-Starts wegen der Abrechnung des Kontos/der Organisation. Abrechnung entsperren und den PR vollständig neu laufen lassen. |
| #48 | Reale, lizenzgeprüfte LHE-Referenzfahrzeiten beschaffen, Release-Verantwortlichen benennen und das reale Artefakt extern signieren. Synthetische Daten oder eine von der Software selbst erzeugte „Freigabe“ wären kein Beweis. |
| #55 | Branch-Protection/Ruleset mit den neuen Pflichtchecks im Repository-Admin setzen; die verbundene GitHub-App stellt dafür keinen Schreibendpunkt bereit. |
| #56 | GitHub-Milestones M0–M14 anlegen und Issues zuordnen; die verbundene GitHub-App stellt dafür keinen Milestone-Schreibendpunkt bereit. `docs/milestones.md` bleibt bis dahin die kanonische Matrix. |

## Reproduzierbare Verifikation

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets --locked -- -D warnings`
- `cargo test --workspace --locked`
- `cargo run --release --locked -p zugfolge-load`
- `pnpm -r --stream build`
- `pnpm -r --stream typecheck`
- `pnpm -r --stream test`
- `pnpm guards`
- `pnpm audit --audit-level=moderate`

Gemessener Lastlauf dieser Nacharbeit: 180.000 Zugläufe, 3.960.000 Ereignisse,
2.421.772 Ereignisse/s; Ziel erfüllt.
