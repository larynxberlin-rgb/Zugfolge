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

## Lokal arbeiten

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
