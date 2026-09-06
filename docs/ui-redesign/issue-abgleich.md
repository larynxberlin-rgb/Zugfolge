# Dokumentation und Issue-Abnahmen zum neuen Design

Stand: 5. September 2026. [PR #531](https://github.com/larynxberlin-rgb/Zugfolge/pull/531)
baut auf #530 auf. Die neue Produktvorgabe ist in
[ADR-0035](../adr/0035-deutschlandweite-spieleroberflaeche.md) festgehalten:
deutschlandweite LiveMap, dunkle Bahnatmosphäre, eine eigene rote Gleismarke,
verständliche Spielertexte und kompakte Arbeitsbereiche.

## Welche Quelle beantwortet welche Frage?

| Frage | Quelle |
| --- | --- |
| Wie sieht das Spiel aus und wie spricht es Spieler an? | [Design](../design.md) |
| Welche Aufgaben, Navigation und Daten sind bereits umgesetzt? | [Spieleroberfläche](../ux-spieler-shell.md) und [Produkt](../produkt.md) |
| Wie funktioniert die Hilfe aus #530? | [Spielhinweise](../spielhinweise.md) |
| Welche Zeichen und Bilder kann ich verwenden? | [Marke und Symbole](../brand/README.md), [Bildherkunft](images.md) |
| Wie sehen die tatsächlichen Frontends aus? | [Browserbilder und Vorschauprüfung](README.md) |
| Was bleibt fachlich oder betrieblich offen? | [Milestones](../milestones.md) und die Abnahmen unten |

## UI und UX von M8 bis M15

Die bisherigen „UI-/UX-Leitplanken“ werden in ihren bestehenden Issues
inhaltlich ersetzt. UI-Issues prüfen Lesbarkeit, Darstellung und Bedienung;
UX-Issues prüfen den zusammenhängenden Spielerweg. Sie verweisen gegenseitig
aufeinander und verwenden die neue Gestaltung als Grundlage.

| Bereich | UX-Abnahme | UI-Abnahme |
| --- | --- | --- |
| Störungen und Ersatzverkehr | [#359](https://github.com/larynxberlin-rgb/Zugfolge/issues/359) | [#376](https://github.com/larynxberlin-rgb/Zugfolge/issues/376) |
| Einstieg, Hilfe und Alpha | [#360](https://github.com/larynxberlin-rgb/Zugfolge/issues/360) | [#377](https://github.com/larynxberlin-rgb/Zugfolge/issues/377) |
| Nachfrage und Fahrgäste | [#361](https://github.com/larynxberlin-rgb/Zugfolge/issues/361) | [#379](https://github.com/larynxberlin-rgb/Zugfolge/issues/379) |
| Güterverkehr | [#362](https://github.com/larynxberlin-rgb/Zugfolge/issues/362) | [#378](https://github.com/larynxberlin-rgb/Zugfolge/issues/378) |
| Markt und Zusammenarbeit | [#363](https://github.com/larynxberlin-rgb/Zugfolge/issues/363) | [#380](https://github.com/larynxberlin-rgb/Zugfolge/issues/380) |
| Komfort und Kontofunktionen | [#364](https://github.com/larynxberlin-rgb/Zugfolge/issues/364) | [#381](https://github.com/larynxberlin-rgb/Zugfolge/issues/381) |
| Deutschlandweite LiveMap | [#365](https://github.com/larynxberlin-rgb/Zugfolge/issues/365) | [#382](https://github.com/larynxberlin-rgb/Zugfolge/issues/382) |
| Schaffnermodus | [#366](https://github.com/larynxberlin-rgb/Zugfolge/issues/366) | [#383](https://github.com/larynxberlin-rgb/Zugfolge/issues/383) |

Die fünf aktuellen Navigationsziele sind LiveMap, Fahrplan, Betrieb, Markt
und Unternehmen. Künftige Aufgaben dürfen weitere oder anders gegliederte
Ansichten erhalten, wenn dies den Spielerweg vereinfacht und die Orientierung
zur LiveMap erhält. Die alten Verbote zusätzlicher Seiten oder die Pflicht
zu einem bestimmten Dialog-/Seitenaufbau entfallen.

## Fachissues mit direktem Gestaltungsbezug

| Issue | Aktualisierte Einordnung |
| --- | --- |
| [#159 — M9.1](https://github.com/larynxberlin-rgb/Zugfolge/issues/159) | Bereits mit #530 aktualisiert und fachlich abgeschlossen: Spielhinweise an echten Bedienelementen; Abschlussnachweis unverändert übernommen |
| [#161 — M9.3](https://github.com/larynxberlin-rgb/Zugfolge/issues/161) | „Spiel starten“ und „Unternehmen gründen“; Kapitalregel und verbleibende Heatmap-/Assistentenabnahme |
| [#167 — M9.9](https://github.com/larynxberlin-rgb/Zugfolge/issues/167) | Externe Alpha mit deutschlandweiter Orientierung und ausdrücklich qualifiziertem Spielnetz |
| [#179 — M12.1](https://github.com/larynxberlin-rgb/Zugfolge/issues/179) | Zusammenarbeit im Markt; verständliche Leistungen und Vertragsfolgen |
| [#180 — M12.2](https://github.com/larynxberlin-rgb/Zugfolge/issues/180) | Fahrzeugmarkt und eigene Flotte; Zustand, Preis, Fristen und Eigentumsübergang |
| [#193 — M14.2](https://github.com/larynxberlin-rgb/Zugfolge/issues/193) | Deutschland-Korpus und Karte als Spielzentrum; getrennte Release- und Lastnachweise |
| [#213 — M15.3](https://github.com/larynxberlin-rgb/Zugfolge/issues/213) | Graphit/Rot statt alter achromatischer Markenpflicht; vollständiger Schaffner-Assetkorpus bleibt Ausbau |

## Nachweise und Status

Ein neues Layout schließt keine fachliche Abnahme ab. Bestehende technische
Invarianten, Berechtigungen, Release-, Betriebs- und Datenschutznachweise bleiben
erforderlich. Die offenen Gestaltungsabnahmen bleiben bis zu ihren jeweils
verlinkten Nachweisen offen. Die abgeschlossene Tooltip-Abnahme M9.1/#159
bleibt erhalten; Nutzerbeobachtung in der externen Alpha gehört zu M9.9.
Die Screenshotdaten sind ausdrücklich illustrative Fixtures.

Regionale Abnahmeberichte wie M14.1/Variante B dokumentieren ihren damaligen
Release. Sie sind keine aktuelle Grenze der Gestaltung und übertragen keine
Freigabe auf zusätzliche Deutschlandabdeckung. Geschlossene historische Issues
und Protokolle bleiben als Nachweise erhalten.

Roadmap-Titel und markierte Syncblöcke folgen weiterhin
`docs/milestones.md` über `.github/scripts/sync-milestones.mjs`.
Fachliche Beschreibungen außerhalb dieser Blöcke werden bewusst gepflegt.
Solange #531 ein Entwurf ist, verweisen die neuen Designlinks auf seinen
Branch; der PR hält die zugehörige Änderung dauerhaft nachvollziehbar.
