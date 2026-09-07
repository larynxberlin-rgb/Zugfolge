# M15: integrierter Implementierungs- und Prüfstand

Stand: 07.09.2026. Dieser Bericht ergänzt die historische
[M15.1/M15.2-Teilabnahme](m15-abnahme.md) und die abgeschlossene
[M15.4-Innenraumabnahme](conductor-interior/README.md).

## Zusammenspiel

Der reguläre M5-Katalogcompiler liefert Fahrzeugbestand und konfigurierten
Innenraum. Tatsächliche Operational-v2-Haltbelege gelangen durch Domain-Event-
Journal und M10-Kern in persistierte Fahrgastmanifeste. Die autorisierte
Schaffnersitzung restauriert alle nativen Zustände im selben Weltwriter und
liefert eine öffentliche Projektion an die wirkliche LiveMap-Oberfläche.

Die Oberfläche verwendet PixiJS/WebGL mit den sieben geprüften Atlanten und
allen logischen Fahrgästen. Gehen, Übergänge, Kontrollen und Gesprächsoptionen
werden nativ bestätigt. Die aktuelle Umgebung folgt den gespeicherten
analytischen Betriebsabschnitten, ursprünglichen Bahnsteigbezügen und dem
gepinnten Szenenkalender. Bewegungspräferenz, Tastatur, Touch, private
SSE-Nachlieferung, Verbindungsverlust und Wiederaufnahme sind Teil des
Browsernachweises.

Kontrollfolgen verwenden dieselben regionalen Worker und Konfliktressourcen
wie normale Zugfahrten. Ein aktiver Polizeihalt verhindert Abfahrtsrechte
und terminale Anschlussbewegungen; die Freigabe fordert eine neue normale
Fahrdienstleiterentscheidung an. Die Fallintegration erzeugt Geldfolgen im
nativen Kontrollkern und übernimmt ausgeglichene Buchungen in das vorhandene
M2/M6-Ledger. Bestätigte M6-Periodenabrechnungen liefern den tatsächlichen
Bruttoerlös vor Pönalen als Grundlage des täglichen Prämienlimits.
Der private Tagesbericht bleibt nach Sitzungsende abrufbar. Eine abgewiesene
Ledgerbuchung rollt die gesamte Welttransaktion einschließlich Fall und
Sitzung zurück; derselbe unveränderte Befehl kann danach erneut angenommen
werden.

## Verträge und Prüfpfade

| Teil | Implementierung und reproduzierbarer Nachweis |
|---|---|
| 15.2 | `conductor-session.native.integration.test.ts`: echter M5-Compiler, native Betriebshaltquittung, M10-Checkpoint und vollständige 160-Personen-Projektion |
| 15.5 | [Szenenvertrag](conductor-scenes.md), [Quellencompiler](../tools/conductor-scenes/README.md), native Zwischenzeit-/Restoretests und Szenenadapter |
| 15.6 | [Dialogvertrag](conductor-dialogue.md), 156 Bäume, 624 Äußerungen, zwölf Familien, native Validierung, redaktionelle Gegenprüfungen und unabhängiger Signatur-/Weltpinloader |
| 15.7 | [Sitzungskern](conductor-session.md), [Plattform](conductor-session-platform.md), tatsächliche DB-/HTTP-/Autorisierungs-, Replay-, Lease- und Widerrufsprüfung |
| 15.8 | [Browservertrag](conductor-browser.md), [wirkliches DOM und WebGL im Browser](../tools/conductor-session/README.md) |
| 15.9 | [Kontrollhaltvertrag](conductor-hold.md), native Mehrzug-, Frist-, Abbruch-, Übergabe-, Terminal- und Restoretests |
| 15.10/15.11 | [Kontrollfälle und Wirtschaft](fare-inspection-cases.md), native Beleg-/Polizei-/Forderungs-/Deckeltests und tatsächliche DB-/Ledgerintegration |
| 15.12 | Zusammenführung der vorstehenden Nachweise; signierter vollständiger Abnahmekorpus und maximale freigegebene Formation bleiben eigenständige Abnahmebedingungen |

Der zusätzliche Originaldialogbeleg erzeugt mit dem festen M10-Testseed 138
eine vollständige neue Testfahrt vor allen Nachfragepins. Sechs tatsächliche
HTTP-Kontrollen zeigen freundliches Zugeben, echtes und falsches Handyproblem,
unfreundliche Reaktion, kooperative Betrunkenheit und Verweigerung. Die
gleichlautende Handybehauptung aus `empty_phone-12` führt je nach tatsächlich
von M10 erzeugtem Fahrschein zu unterschiedlichen bestätigten Befunden.
Wiederherstellung mitten im Dialog und Wiederholung desselben Prüfkommandos
behalten den Zustand; Texte, Fahrgäste und Fahrscheinfakten werden nicht ersetzt.

Weg und Grafikzugriff besitzen einen gezielten HTTP-Regressionstest unmittelbar
nach echtem M10-Fortschritt ohne vorherige Snapshotanforderung. Der zusätzliche
Doppelstock-Browserbeleg verwendet alle 220 Fahrgäste der größten vollständig
vorhandenen M5-Spielkonfiguration, beide Decks und eine tatsächlich bestätigte
Treppenbewegung. Seine DB-/HTTP- und Framezeiten werden beschreibend erfasst;
die Windows-Test-CLIs und der Linux-NAPI-Lauf sind getrennte Messumgebungen.

Die reguläre [CI](ci.md) behält vier Jobs. Der native Linux-Job baut das
wirkliche NAPI-Addon und die originale Domänenfixture, führt die neuen
Integrationstests aus und bewahrt Browserbelege als Artefakt auf. Ein
übersprungener Test ist kein positiver Nachweis. Lokale Windows-Prüfungen
verwenden dieselben Rust-Funktionen über explizite Test-CLIs; die Produktion
besitzt diesen Ersatztransport nicht.

Die zusätzliche Manifestfahrt besteht lokal mit dem aktualisierten Kern:
160 Personen bleiben über eine echte Infrastruktursperre vollständig erhalten.
Am mittleren Halt steigen 16 aus und fünf ein; alle 144 weiterreisenden
Identitäten behalten ihre Plätze. Fünf tatsächliche Haltquittungen binden
Journal, nativen Haltplan und M10-Fortschritt. Am Endhalt steigen die zuletzt
149 Reisenden aus. Der beendete Sitzungsstand bleibt sichtbar eingefroren;
die spätere Szene ist leer und behauptet keine fortgesetzte Fahrt.
Der Beleg umfasst fünf visuell geprüfte Browserbilder. Den endgültigen
Linux-NAPI-Nachweis liefert der entsprechende Lauf von PR #539.

Der zusätzliche verbundene Service-/M6-Beleg besteht lokal mit zwei Tests.
Eine tatsächliche Identitätsverweigerung fordert den mittleren Kontrollhalt
an. Nach technischer Sperrenfreigabe und neuer FDL-Prüfung folgt die native
Polizeireaktion nach 59 Minuten auch bei bereits beendeter Schaffnersitzung.
Der tatsächliche verspätete Fahrtabschluss ergibt im ausdrücklich fiktiven
Einzelfahrtvertrag 9.000 Cent Pönale und 1.000 Cent Auszahlung. Die
ausgeglichene Ledgerbuchung bleibt beim Retry einmalig. Der Vergleichszweig
derselben ursprünglichen Fahrt mit identischer Infrastruktursperre und
Freigabe ohne Polizeianforderung bleibt innerhalb der Pünktlichkeitstoleranz.
Dieser Servicebeleg ist vom Mehrzugvergleich abzugrenzen, der ausschließlich
die zusätzliche Dauer eines bereits aktiven Polizeihalts vergleicht.

Der erste vollständige Integrationsstand `3d2b6fd` besteht alle vier Jobs in
[CI-Lauf 34066385323](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/34066385323),
einschließlich echter Linux-NAPI-, PostgreSQL-, Sitzungs-/Ledger- und
Browserprüfungen. Der Lauf bewahrt die vollständige Basisfahrt sowie
Nacht-/Signalszenen mit ihren Bildhashes im Artefakt
`conductor-session-browser-evidence` auf. Er behauptet noch keine vollständige
Kontrollfahrt oder spätere Ergänzungen an Regionswechsel und Touchdialogen.

Migration 36 ergänzt sechs weltgebundene private Tabellen und ihre
Writer-Fences. Kontolöschung entfernt die private Kontozuordnung, Leases,
Quittungen und Snapshots. Bereits verbindliche synthetische Betriebs- und
Fallfolgen laufen unabhängig weiter. Schema-36-Sicherungen besitzen eigene
Rollback-/Historiensealversionen; ältere Schema-35-Belege dürfen neue
Sitzungsdaten nicht verdecken.

## Verbleibende Release- und Gesamtannahmebedingungen

Die Asset-, Referenz- und Releasefreigabe des Auftraggebers liegt vor. Für die
produktive kryptografische Auslieferung fehlen weiterhin die tatsächlich
autorisierten Signierschlüssel und die unabhängige Schlüsselzuordnung der
Zielwelt. Temporäre Testschlüssel gelten ausschließlich für Testkorpora.

Der Szenencompiler verarbeitet amtliche, belegte Stations- und
Gemeindequellen. Der vollständige ursprüngliche Operational-InfraRelease
der Deutschlandwelt aus M14.2 ist noch nicht angehängt. Eine ausdrücklich
fiktive Abnahmefahrt beweist die technische Bindung, keine vollständige
Deutschlandabdeckung und keine Freigabe realer Stationsarchitektur.

Die reguläre Vertragsabrechnung besitzt mit
[Issue #518](https://github.com/larynxberlin-rgb/Zugfolge/issues/518) eine
bereits dokumentierte offene Basisabhängigkeit: vollständiger Tagesplan mit
Day-Close, native Kostenbelege und aktuelle Vertragsbindung. Das vorhandene
Vollständigkeitsgate bleibt unverändert. Einzelne vollständig definierte
Abnahmeverträge und deren echte M6-/Ledgerfolgen ersetzen diesen fehlenden
allgemeinen Produktionsproducer nicht.

M15 wird erst vollständig geschlossen, wenn der zusammenhängende
Mehrzug-/Browser-/Ledgernachweis, die maximal freigegebene SPNV-Formation,
der signierte Abnahmekorpus und die vier CI-Jobs für denselben abschließenden
Stand vorliegen. Die offenen Issues #213, #215, #216 und #222 behalten ihre
entsprechenden konkreten Gates.
