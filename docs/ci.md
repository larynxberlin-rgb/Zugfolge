# Tests und CI

Zugfolge ist ein Hobbyprojekt. Die normale CI soll Fehler im Spiel zuverlässig
finden und im Alltag überschaubar bleiben. Große Lastnachweise, Kartenbuilds
und Betriebsdrills werden bei Bedarf gestartet.

## Regulärer Prüflauf

[`ci.yml`](../.github/workflows/ci.yml) führt bei Pull Requests und auf `main`
vier Jobs aus. Ein neuer Commit beendet einen noch laufenden älteren Prüflauf
derselben Branch.

| Job | Inhalt |
|---|---|
| Rust und Determinismus | Formatierung, Clippy, Rust-Tests einschließlich Konflikt-Properties und Golden-Master, Rust-Lizenzen |
| TypeScript | Workspace-Build, Typprüfung und reguläre Paket-/App-Tests einschließlich API-Autorisierung, Weltisolation und LiveMap |
| Native Runtime ABI (Linux, echtes NAPI) | Echte Rust/Node-Anbindung, gezielte PostgreSQL-Integration und Browser-Smokes |
| Waechter (harte Invarianten) | Repository-Invarianten, Node-Lizenzen und bekannte Schwachstellen |

Die normalen API-Tests laufen einmal. Der PostgreSQL-Teil wählt nur Tests,
die den echten Datenbankdienst benötigen; der native Teil aktiviert gezielt
die Fälle mit echten Addons und Browsern. Referenzkorpus und Betriebswerkzeuge
gehören zum erweiterten Prüflauf.

M15 ergänzt den vorhandenen nativen Job um die originale M5-/M10-/Betriebsquelle,
private Sitzungs-/Releaseintegration und die tatsächliche PixiJS-Oberfläche
mit Desktop, Touch, Verbindungsverlust und Wiederaufnahme. Er benötigt das
wirklich gebaute NAPI-Addon; die Fixture erzeugt fachliche Testdaten mit
denselben Rust-Kernen. Testsignaturen autorisieren ausschließlich diesen
gekennzeichneten Korpus. Die vier regulären Jobs bleiben erhalten; ein grüner
Testkorpus ersetzt keine produktive Release- oder Deutschlandabnahme.
Der native Job erhält für die zusammenhängenden Browserfahrten und die
zusätzlichen Regionswechsel-/Ledgernachweise eine Höchstdauer von 45 Minuten.
Der gemessene Zwischenlauf benötigte bereits 27 Minuten bis zur verbundenen
Abnahmefahrt; deren vollständiger Netzabschluss und der anschließende
Einstiegsnachweis müssen innerhalb desselben Jobs ausgeführt werden können.
Die dateibasierten Szenen-/Evidenzpackerprüfungen und die Regression für den
nativen Ereigniskalender des Browsertreibers laufen im TypeScript-Job;
sie benötigen keinen zusätzlichen Browser oder Job.
Die nativen Browserfahrten prüfen zusätzlich Dokumentkontrolle, spätere
Nachweise, Zahlungen, Polizei und Tagesbericht sowie den vollständigen
220-Personen-Doppelstockkorpus. Die Manifestfahrt prüft tatsächlichen
Fahrgastwechsel über mehrere Halte und eine Infrastruktursperre. Die gemeinsame
Abnahmefahrt verbindet Originaldialoge, Polizeihalt, Netz- und Vertragsfolgen;
ihre Quelle und der einzelne Abnahmevertrag bleiben ausdrücklich fiktiv.
Der gesonderte Einstiegsbeleg verwendet dieselbe Zugdetailkomponente wie die
LiveMap mit tatsächlichen Verfügbarkeits-, Berechtigungs- und Resume-Antworten.
Der Evidenzpacker bindet sämtliche sieben positiven Browserberichte, den
separaten Originaldialog-HTTP-Beleg und die zugehörigen
Screenshots an den tatsächlichen CI-Commit. Die zusätzliche
Dialog-CLI liefert ausschließlich private Auswahlbelege aus Originaldialogen;
die Sitzungs- und Kontrollkommandos verwenden unter Linux das echte NAPI-Addon.

## Lokal arbeiten

Der Rust-Job führt außerdem den tatsächlichen `operational_json`-CLI-Einstieg
in isolierten Kindprozessen aus. Erfolg und fachliche Ablehnung nach Restore
müssen den temporären Infrastrukturindex beim Prozessende freigeben. Dieser
Ressourcentest verändert keine Betriebs- oder Replayregeln und benötigt keinen
zusätzlichen CI-Job.

Die Toolchain steht in [`monorepo.md`](monorepo.md#2-werkzeugkette).
Einmal installieren und den Workspace bauen:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Danach die zur Änderung passenden Prüfungen ausführen, beispielsweise:

```bash
cargo test -p zugfolge-disruption --locked
pnpm --filter @zugfolge/game-api test
pnpm --filter @zugfolge/livemap test
```

Für den regulären TypeScript-Testumfang und die Rust-Suite:

```bash
pnpm test
cargo test --workspace --locked
```

`pnpm test` führt App-, Paket- und Wächtertests Workspace für Workspace aus.
Das begrenzt gleichzeitig laufende Datenbankinstanzen. Die datenbanklastigen
API- und Alpha-Suiten verwenden jeweils höchstens zwei Test-Worker.

Tests mit PostgreSQL, nativen Addons oder Browsern benötigen deren Umgebung.
Die vollständigen Aufrufe und Umgebungsvariablen stehen im jeweiligen
Workflow, damit es nur eine gepflegte Beschreibung des Runner-Setups gibt.

## Erweiterte Prüfungen

[`extended.yml`](../.github/workflows/extended.yml) wird ausdrücklich über
**Actions → Run workflow** gestartet. Er enthält die Tests für Import-,
Karten-, Release- und Betriebswerkzeuge samt Referenzkorpus sowie das
48h-Offlineszenario, Lastnachweise, Produktionsimage, Odoo und
Keycloak-/Backup-/Restore-Drills. Diese Prüfungen sind bei Änderungen an den
jeweiligen Bereichen oder vor einer Veröffentlichung sinnvoll.

Die Werkzeugsuite lässt sich auch lokal starten. Sie benötigt zusätzlich
Python und die Rust-Toolchain. `test:full` ergänzt die regulären Tests um
dieselbe Werkzeugsuite und das 48h-Offlineszenario:

```bash
pnpm test:tools
pnpm test:full
```

`test:full` richtet keine PostgreSQL-, Browser- oder Produktionsdienste ein;
deren Integration wird durch die entsprechend eingerichteten CI-Jobs geprüft.

[`infrastructure-acceptance.yml`](../.github/workflows/infrastructure-acceptance.yml)
enthält die manuelle Deutschland-Realabnahme mit großen externen Korpora und
den dafür vorgesehenen Self-hosted Runnern. Sie wird auf einem bewusst
ausgewählten, bereits geprüften Ref gestartet. Ein Pull Request startet keine
Arbeit auf diesen Hosts.

Ein grüner regulärer Prüflauf belegt den dort getesteten Code. Eine reale
Betriebsabnahme wird mit ihrem eigenen Prüflauf und Protokoll dokumentiert.

M15.4 wird im bestehenden Native-ABI-Job über den echten Katalogcompiler,
M5-Checkpoints in PGlite, das Linux-NAPI-Addon und den installierten Browser
geprüft. Der [reproduzierbare Innenraumbeweis](conductor-interior/README.md)
umfasst drei Konfigurationen, Deck- und Wagenübergänge, Kollisionen und den
konkret abgelehnten unvollständigen Beleg. Seine temporäre Testsignatur
belegt die Auslieferungsprüfung; sie aktiviert keinen Produktivschlüssel.

## Welche Tests bleiben sinnvoll?

- Konfliktfreiheit, Determinismus, Autorisierung, Weltisolation und korrekte
  Zugdarstellung werden über ihr Verhalten geprüft.
- Ein behobener Fehler erhält möglichst einen kleinen Regressionstest im
  passenden bestehenden Testmodul.
- Wiederholte Testläufe mit derselben Umgebung entfallen. Neue Varianten
  müssen ein anderes Verhalten oder eine andere Integrationsgrenze prüfen.
- Reine Prüfungen auf Wortlaut in Dokumentation, Quelltextfragmente oder die
  genaue Anordnung eines Workflows sind kein Ersatz für Verhaltenstests.
- Für Formatierung, Dokumentation und kleine Refactorings reichen vorhandene
  Prüfungen, sofern sich kein neues Verhalten ergibt.
