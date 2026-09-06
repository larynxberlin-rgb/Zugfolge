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

Die reguläre [CI](ci.md) behält vier Jobs. Der native Linux-Job baut das
wirkliche NAPI-Addon und die originale Domänenfixture, führt die neuen
Integrationstests aus und bewahrt Browserbelege als Artefakt auf. Ein
übersprungener Test ist kein positiver Nachweis. Lokale Windows-Prüfungen
verwenden dieselben Rust-Funktionen über explizite Test-CLIs; die Produktion
besitzt diesen Ersatztransport nicht.

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

M15 wird erst vollständig geschlossen, wenn der zusammenhängende
Mehrzug-/Browser-/Ledgernachweis, die maximal freigegebene SPNV-Formation,
der signierte Abnahmekorpus und die vier CI-Jobs für denselben abschließenden
Stand vorliegen. Die offenen Issues #213, #215, #216 und #222 behalten ihre
entsprechenden konkreten Gates.
