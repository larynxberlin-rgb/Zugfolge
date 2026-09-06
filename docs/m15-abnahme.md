# M15.1/M15.2 — Lieferumfang und Abnahmegrenzen

Prüfstand: 06.09.2026. Diese Teilabnahme trennt den versionierten Fachvertrag
von der technischen Fahrgastprojektion und vom späteren spielbaren Modus.
Sie schließt M15 insgesamt und seine nachgelagerten Arbeitspakete nicht ab.

## M15.1: nachprüfbarer Fachvertrag

[E29/ADR-0029](adr/0029-schaffnermodus-als-serverautoritative-betriebsvertiefung.md)
ist in Entscheidungsliste, ADR-Index und Agenteneinstieg lückenlos eingeordnet.
Der kanonische [Fachvertrag](schaffnermodus.md) trägt die Version
`zugfolge-conductor/v1`. Er definiert Nachfrage-/Projektionsgrenze, Sitzung,
Grafik, Dialog, Kontrollfall, `FareControlPolicyV1`, Betriebshalt, Wirtschaft,
Datenschutz und die späteren Abnahmeszenarien.

Abschnitt 2.1 ordnet jede sichtbare Aktion ihrer Source of Truth, dem Kommando,
Domain-Ergebnis, Ressourcenübergang und der Buchung zu. Querschnittsdokumente
verweisen auf diesen Vertrag. Die vorgesehenen M15.7–M15.11-Ereignisse sind
eine Spezifikation; ihre produktive Erzeugung wird hier nicht behauptet.
Insbesondere bleiben folgende Gegenbeispiele verboten:

| Gegenbeispiel | Verbindliche Grenze |
|---|---|
| Planabfahrt ist vorbei, daher Fahrgäste anzeigen | Nur `progress_bound` mit passender tatsächlicher Haltquittung liefert einen belegten Abschnitt |
| Fahrgastverlust durch Animationsbudget oder doppelte Schlüssel | Ganze M10-Menge bleibt erhalten; ungültige Eingänge werden abgelehnt |
| Fahrausweis oder Dialogton aus dem Aussehen ableiten | Getrennte Autorität und getrennte Hash-Teilströme; keine geschützten Merkmale als Kontrollsignal |
| Client ändert Manifest, Layout, Revision oder Fallausgang | Ausschließlich committed Servereingänge und autorisierte Kommandos |
| Gespräch, Reload oder Sitzungsende stoppt/startet den Zug | Nur bindende M15-Anforderung und die bestehenden M8/M4-Übergänge dürfen betrieblich wirken |
| Polizeihalt endet und überschreibt die neue Konfliktlage | Erneute normale Abfahrtsprüfung ohne Sondervorrang |
| Offene Forderung oder Nachfrageprognose gilt als Zahlung | M6 bucht nur den jeweils belegten Übergang; Prognosen sind kein Ledgerbeleg |
| Fachvertrag oder Beispielscreenshot schließt den Spielbeweis | M15.4/M15.7/M15.8/M15.12 besitzen eigene Nachweise |

Der bestehende `decision-consistency`-Wächter prüft zusätzlich die lokalen
Markdown-Verweise aller zugeordneten ADRs. Seine Negativfälle erfassen
fehlende kanonische Dokumente und Verweise außerhalb des Repositorys.
Glossarwächter und M0–M15-Synchronisierung prüfen die vorhandenen zentralen
Verzeichnisse. Diese Dokumentprüfungen beweisen keine Laufzeitautorisierung.

## M15.2: technische Liefergrenze

`crates/zugfolge-conductor` projiziert ein vorhandenes M10-Ergebnis mit
`projectionMode = progress_bound` und serverseitig belegtem Platzinventar.
Welt, Zug, EVU, Periode, Release, Nachfragezustand, Betriebsquittung und Layout
müssen zusammenpassen. Vor der ersten bestätigten Abfahrt, bei Prognosen,
fehlenden Belegen oder widersprüchlichen Manifestsummen gibt es keinen
erfundenen Innenraumzustand. Am Halt markiert die Projektion beginnende
Ausstiege; die nächste bestätigte Abfahrt übernimmt den neuen Abschnitt.

Die strikte native JSON-Grenze und der TypeScript-Adapter liefern nur die
sichtbare `PassengerProjectionV1`. `ConductorProjectionService` liest den
bestehenden `DemandStore`, prüft aktiven Weltzugang und eigenes aktives EVU und
erwartet den bekannten Nachfragehash. Layout und vorheriger Snapshot sind
interne Serverparameter. Eine neue HTTP-Route oder Schaffnersitzung ist kein
Teil dieser Lieferung; deren Berechtigungs-, Lease- und Streamvertrag bleibt
M15.7. Der Service erfindet keine Innenraumgeometrie.

Die nativen Integrationsszenarien verbinden echten Rust-Nachfragekern,
persistierten `DemandStore`, Rust-Projektor, API-Service und PGlite-Restore.
Ihre feste Testgeometrie und synthetischen Haltquittungen sind ausdrücklich
Testeingänge. Sie sind weder Fahrzeugrelease noch produktiver Haltproducer,
Browserfahrt oder Deutschland-Lastnachweis.

## Reproduzieren

```sh
pnpm --filter @zugfolge/guards build
pnpm --filter @zugfolge/guards test
pnpm guards
pnpm --filter @zugfolge/glossary generate
node --test .github/scripts/sync-milestones.test.mjs
node .github/scripts/sync-milestones.mjs check
cargo test --locked -p zugfolge-conductor
pnpm --filter @zugfolge/runtime-native test
```

Den vollständigen API-/Restorebeweis unter Linux mit echtem NAPI ausführen:

```sh
pnpm --filter @zugfolge/game-api... build
cargo build --release --locked -p zugfolge-runtime-napi --features node-addon
cp target/release/libzugfolge_runtime_napi.so target/release/zugfolge_runtime_napi.node
ZUGFOLGE_RUNTIME_NATIVE_PATH="$PWD/target/release/zugfolge_runtime_napi.node" \
  pnpm --filter @zugfolge/game-api exec vitest run src/conductor-projection.native.integration.test.ts
```

Der reguläre Linux-Job für die native Runtime verwendet das echte NAPI-Addon.
Ein lokaler Rust-JSON-Prozesstransport ist ausschließlich ein Testweg und kein
Fallback bei fehlendem Produktionsaddon. Ein wegen fehlender nativer Runtime
übersprungener Test gilt nicht als erfolgreicher Integrationsbeweis.

Der [CI-Lauf auf `363b120`](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/33997523580)
bestand alle vier Jobs: Rust/Determinismus, TypeScript, Linux-NAPI und
Repositorywächter. Danach wurde der additive M10-Stand `76f3ba2` einschließlich
der Kartenabnahme aus `32dfcf3` übernommen;
die CI führt sowohl den neuen M10-Kartenlasttest als auch die bestehende
Conductor-Integration jeweils einmal aus. Der im M10-Anschlussaudit genannte
Aktivitätscheck für Unternehmen ist ergänzt: `exited` und `deleted` werden
bereits vor Nachfragejournal und Rust-Kern abgewiesen. Der vorhandene
Autorisierungstest deckt beide Zustände ab. Der frühere grüne CI-Lauf ist
kein Prüfnachweis dieser späteren Änderungen.

Der lokale Prozessnachweis baut `evaluate_json` aus `zugfolge-demand` und
`project_json` aus `zugfolge-conductor` über `cargo build --locked -p <crate>
--example <example>`. Vor dem Integrationstest werden deren absolute Pfade in
`ZUGFOLGE_DEMAND_TEST_BINARY` und `ZUGFOLGE_CONDUCTOR_TEST_BINARY` gesetzt.
Unter Linux genügt alternativ `ZUGFOLGE_RUNTIME_NATIVE_PATH` zum tatsächlich
gebauten Runtime-Addon. Die beiden Transportschemata sind identisch; die
Platz- und Nachfrageentscheidung bleibt in beiden Fällen in Rust.

Am Prüfstand lokal bestanden: 140 Wächtertests, alle 15 Repositorywächter,
12 Milestone-Synchronisierungstests sowie der M0–M15-Manifestabgleich.
Der native API-/Datenbanknachweis hat drei grüne Tests einschließlich echtem
Rust-Aufruf, voller Sechsplatz-Testbelegung über mehrere Halte und
Wiederherstellung aus einem vollständig geschlossenen und neu geladenen
PGlite-Datenbankabbild. Die feste kleine Testformation ist kein Lastnachweis.

Zusätzlich bestanden 24 Rust-Tests (10 neue Conductor- und 14 M10-Tests),
55 Tests des nativen TypeScript-Adapters, Workspace-Build und Typprüfung,
Rust-Formatprüfung sowie Clippy mit `-D warnings`. Die Rust-Nachweise
umfassen 48 Seeds mit echten M10-Auswertungen, Angebots-/Layoutpermutation,
Haltwechsel, Störung und Restore; 256 Zuordnungs- und Fortschreibungsfälle
werden mit einer unabhängigen vollständigen Suche verglichen. Ein
synthetischer Zug mit 4.096 Fahrgästen, davon 1.024 stehend, beweist, dass
auch bei hoher Belegung keine logischen Personen entfernt werden.
Das ersetzt weder reale Fahrzeugkonfiguration noch Systemlastabnahme.

## Berücksichtigte Issues und offene PRs

Die GitHub-Issues [#211](https://github.com/larynxberlin-rgb/Zugfolge/issues/211)
und [#212](https://github.com/larynxberlin-rgb/Zugfolge/issues/212) definieren
den Auftrag. Die unten genannten Beschreibungen und offenen PRs wurden am
Prüfstand gelesen. Der Bestand ist ein Auditzeitpunkt, kein dauerhaft aktueller
GitHub-Status.

| Issue / PR | Konsequenz für diese Lieferung |
|---|---|
| [#530](https://github.com/larynxberlin-rgb/Zugfolge/pull/530) | E28/ADR-0028 ist seit Merge `cab1db7` auf `main` veröffentlicht; die frühere explizite M15.1-Vorbedingung ist erfüllt |
| [#531](https://github.com/larynxberlin-rgb/Zugfolge/pull/531) | Offener UI-Entwurf trägt ADR-0035 und die gemeinsame Gestaltung; seine Beispiele sind keine Fahrgast-/Assetabnahme |
| [#532](https://github.com/larynxberlin-rgb/Zugfolge/pull/532), [#533](https://github.com/larynxberlin-rgb/Zugfolge/pull/533), [#534](https://github.com/larynxberlin-rgb/Zugfolge/pull/534) | Offener M10-PR-Stack liefert Nachfrage, Planung und Plattformintegration; M15 baut darauf auf, ersetzt dessen Review und Merge nicht |
| [#210](https://github.com/larynxberlin-rgb/Zugfolge/issues/210) | Der produktive M10-Refresh liefert derzeit `forecast`; echte Haltquittungen müssen vor einer tatsächlich spielbaren M15-Ansicht angebunden werden |
| [#214](https://github.com/larynxberlin-rgb/Zugfolge/issues/214) | Ableitung und Freigabe wirklicher begehbarer Innenräume bleibt M15.4; Testplätze ersetzen diesen Producer nicht |
| [#213](https://github.com/larynxberlin-rgb/Zugfolge/issues/213), [#215](https://github.com/larynxberlin-rgb/Zugfolge/issues/215), [#216](https://github.com/larynxberlin-rgb/Zugfolge/issues/216) | Finale Grafik-, Stations- und Dialogreleases bleiben offen |
| [#217](https://github.com/larynxberlin-rgb/Zugfolge/issues/217), [#218](https://github.com/larynxberlin-rgb/Zugfolge/issues/218), [#366](https://github.com/larynxberlin-rgb/Zugfolge/issues/366), [#383](https://github.com/larynxberlin-rgb/Zugfolge/issues/383) | Sitzung, sicherer Einstieg/Rückweg, Browser, Touch und Barrierefreiheit bleiben eigene Arbeitspakete |
| [#219](https://github.com/larynxberlin-rgb/Zugfolge/issues/219), [#220](https://github.com/larynxberlin-rgb/Zugfolge/issues/220), [#221](https://github.com/larynxberlin-rgb/Zugfolge/issues/221) | Kontrollhalt, Polizeireaktion und Ledgerfolgen sind hier spezifiziert, nicht implementiert |
| [#517](https://github.com/larynxberlin-rgb/Zugfolge/issues/517), [#518](https://github.com/larynxberlin-rgb/Zugfolge/issues/518) | Wartende Betriebsprogrammkommandos und fehlende Ist-Abschlüsse sind keine Betriebsquittungen oder Einnahmenbeweise |
| [#502](https://github.com/larynxberlin-rgb/Zugfolge/issues/502), [#520](https://github.com/larynxberlin-rgb/Zugfolge/issues/520) | Personenbezogene Sitzungsdaten müssen von unveränderlichen Betriebsbelegen getrennt bleiben; die offene Archiv-Purge-Grenze wird nicht umgangen |
| [#222](https://github.com/larynxberlin-rgb/Zugfolge/issues/222), [#509](https://github.com/larynxberlin-rgb/Zugfolge/issues/509), [#393](https://github.com/larynxberlin-rgb/Zugfolge/issues/393) | Voller Verband, gemeinsame Netzlast, bitgleiches Gesamt-Replay und spielbare Desktop-/Touchfahrt bleiben offen |

Die technische Teilprüfung erlaubt das Review von M15.1 und des M15.2-Kerns.
Der in #212 verlangte spielbare Mehrhaltbeweis bleibt bis zu den echten
Betriebs- und Layoutquellen sowie der Browserintegration offen. Die
M15-Gesamtabnahme bleibt unverändert bei M15.12.
