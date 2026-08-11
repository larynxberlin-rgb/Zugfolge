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

## Bereits bekannte externe Voraussetzungen

- GitHub Actions startet wegen des Account-/Billing-Locks nicht (Issue #29).
- Das `main`-Ruleset mit Pflichtchecks braucht Repository-Administration
  (Issue #55).
- Die erste GitHub-Milestone-Synchronisierung braucht einen lauffaehigen
  Actions-Lauf (Issue #56).
- M1.13 braucht freigegebene, belastbare Infrastruktur-/Fahrzeugprofile, einen
  nicht zur Kalibrierung verwendeten technischen Validierungssatz und die
  Signatur der benannten Release-Verantwortung (Issue #48).

Diese Punkte koennen Code-Abnahmen nicht ersetzen und werden nur nach einem
wirklich ausgefuehrten externen Nachweis geschlossen.
