# Spieleroberfläche: deutschlandweit, mit der LiveMap im Zentrum

Stand: 5. September 2026. Umsetzung auf Grundlage von PR #530.
Die neue Produktvorgabe ersetzt das frühere regionale UX-Zielbild und dessen
Gestaltungsgrenzen. Siehe [Design](design.md), [ADR-0035](adr/0035-deutschlandweite-spieleroberflaeche.md)
und [Screenshots](ui-redesign/README.md).

## Hauptnavigation

| Ziel | Aufgabe | Umsetzung |
| --- | --- | --- |
| LiveMap | Deutschland erkunden, eigene Züge und Abweichungen finden | `apps/livemap` |
| Fahrplan | Zugfahrten und zeitliche Konflikte verstehen | `game-web`, `view=diagram` |
| Betrieb | Meldungen beurteilen, Automatik steuern, Tagesberichte lesen | `operations-center` |
| Markt | Aufträge, Fahrzeuge und Zusammenarbeit | `game-web`, `section=markets` |
| Unternehmen | Geld, Flotte und Einstieg | `game-web`, `section=company` / `world` |
| Postfach im Kopf | Nachrichten lesen und zur Entscheidung springen | `game-web`, `section=mailbox` |

Fahrtanmeldung, Leerfahrt und Werkstatt bleiben über die Aktionen der LiveMap
und des Unternehmens erreichbar (`section=operations`). Die Hauptnavigation
führt bei „Betrieb“ in die Betriebszentrale. Beides hat eine verständliche,
eigene Aufgabe.

## LiveMap

Der Startausschnitt umfasst Deutschland. „Gesamtes Spielnetz“ folgt den
serverseitigen Netzgrenzen. Die geografische Darstellung, das Gleisbild und
die Zugübersicht nutzen dieselben öffentlichen Zugdaten. „Meine Züge“ filtert
nach der tatsächlichen Unternehmenskennung. Die Suche berücksichtigt Zugnummer,
Unternehmen und nächsten Halt.

Die Kennzahlen zählen die empfangenen Fahrten und berücksichtigen den aktiven
Filter. Sie behaupten keine Vollständigkeit außerhalb des Streamstands.
Bestätigte Ausfälle, Störungen und Verspätungen stehen im Überblick zuerst.
Die Zugliste lädt zunächst 80 Einträge und lässt sich erweitern.

Klickbare Züge öffnen Details über die vorhandene API. Bekannte bestätigte
Positionen können zentriert werden. Unbestätigte Bewegungen werden weiterhin
eingefroren; die UI erzeugt keine eigenen Betriebsbewegungen.

## Arbeitsbereiche

Gemeinsame Kopfzeile und Navigation verbinden alle drei Anwendungen. Der
verfügbare Geldbetrag berücksichtigt bereits vorgemerkte Ausgaben. Ein
Unternehmenswechsel bleibt in Links erhalten. Register teilen große Seiten
in konkrete Aufgaben; Formulare zum Erstellen sind zunächst geschlossen.

Auf Desktop scrollen Karte und äußerer Rahmen nicht. Auf Mobilgeräten bleibt
die Hauptnavigation unten stehen. Lange Fachinhalte scrollen im jeweiligen
Arbeitsbereich; das Karten-Infopanel wird bei Bedarf eingeblendet.

## Einstieg und Hilfe

Der Einstieg erklärt Spielername, Startkapital und Spielregeln. Danach heißt
die Hauptaktion „Unternehmen gründen“. Nach der Gründung führt die Oberfläche
zur gemeinsamen LiveMap. Es gibt keine zusätzliche Tutorialwelt und keine
automatisch abgesendeten Spielkommandos.

Die Spielhinweise von PR #530 wurden sprachlich und hinsichtlich ihrer
Zielelemente an die neue Oberfläche angepasst. Bestätigungen für verbindliche
Spielentscheidungen und serverseitige Berechtigungen bleiben wirksam.

## Nachweis

`tools/ui-preview` rendert die tatsächlichen Oberflächen mit ausdrücklich
gekennzeichneten Beispieldaten. Die Vorschau enthält keine Produktionsdaten.
Sie prüft Layout, Navigation, Register, Fokus und Kartendetails. Fachliche
Kommandos und Berechtigungen werden weiterhin durch die bestehenden Tests
abgesichert; die Vorschau ist kein Produktions- oder Lasttest.
