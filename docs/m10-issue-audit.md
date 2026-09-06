# M10 — Audit der offenen Issues und Pull Requests

Prüfstand: 05.–06.09.2026, GitHub CLI. Alle offenen Issue-Titel und -Beschreibungen
wurden gesichtet; M10, fachlich einschlägige Issues sowie sämtliche offenen
PRs mit Review-, Inline- und Diskussionskommentaren wurden vertieft gelesen.
Die Bestandsliste unten dokumentiert den Eingangsstand. Es wurden keine
Issues als Ersatz für eine noch fehlende Abnahme geschlossen.

Erneuter GitHub-Abgleich am 06.09.2026: 91 offene Issues, darunter unverändert
alle acht M10-Issues, und sechs offene PRs (#531–#536), sämtlich Entwürfe.
Alle derzeit offenen Issues sind bereits im unten dokumentierten Bestand
enthalten; es kam kein weiterer Issue-Titel hinzu. Die Aktualisierung prüft
Status, PR-Basen, Dateiumfang, Checks und schließende Referenzen; sie behauptet
keine erneute vollständige Prüfung jedes historischen Issue-Kommentars.

## Umfang und Stackbasis

Der bestätigte Auftrag bezeichnet M10 — Personenverkehrsnachfrage und SPFV
(GitHub-Milestone 11), nicht GitHub-Milestone 10/M9. Die acht M10-Issues sind
#169, #170, #171, #172, #173, #210, #361 und #379. Implementierung, Nachweise
und verbleibende Grenzen stehen in [m10-abnahme.md](m10-abnahme.md).

Die gemeinsame Gestaltungsbasis ist PR #531, Branch
codex/livemap-ui-redesign, Stand fa5ee169c2d13fed166d2b21d95fe64fe2d13a02.
Sie baut auf #530 auf. #530 wurde während dieser Arbeit bereits als
cab1db7 in main gemergt; #531 ist weiterhin ein Entwurf. Sein Inhalt und
seine Reviewzuständigkeit bleiben erhalten. Bei der Bestandsprüfung gab es
keine unbeantworteten Review- oder Inlinekommentare auf diesen PRs.

Der neue M10-Stack baut darauf in dieser Reihenfolge auf:
[#532](https://github.com/larynxberlin-rgb/Zugfolge/pull/532) (Nachfragekern),
[#533](https://github.com/larynxberlin-rgb/Zugfolge/pull/533) (Trassenplanung),
[#534](https://github.com/larynxberlin-rgb/Zugfolge/pull/534) (API, Oberfläche,
freie Kalibrierungsdaten und gemeinsame Abnahmematrix), ergänzt um
[Einwohnernachfrage und direkte Odoo-Datenpflege #537](https://github.com/larynxberlin-rgb/Zugfolge/pull/537)
auf `codex/m10-population-demand` mit Basis `codex/m10-passenger-demand`.
Dieser vierte Teil wurde nach dem oben beschriebenen Sechs-PR-Refresh
veröffentlicht; damit sind sieben PRs offen. Die abschließenden CI- und Odoo-Läufe sind am PR mit dem jeweils geprüften
Commit verknüpft.

Der Nutzer hat #173 am 06.09.2026 ausdrücklich auf Einwohnernachfrage,
Stationsklassen und ungefähre Wunschziele sowie direkte Odoo-Datenkorrekturen
umgestellt. Die neue [Spezifikation](m10-populationsnachfrage.md) und
[Issue-Verkabelung](m10-issue-verknuepfung.md) sind maßgeblich. Historische
Holdoutberichte bleiben unverändert und behaupten weiterhin keine bestandene
empirische Abnahme. Per GitHub-API sind am Head `f7dabd5` von #534 genau
#169, #170, #171, #172, #210, #361 und #379 als schließend verknüpft;
#173 ist dem vierten PR #537 zugeordnet.

Während der Abschlussprüfung kam
[#535](https://github.com/larynxberlin-rgb/Zugfolge/pull/535) hinzu. Dieser
M15-Entwurf baut auf #534 auf und übernimmt M10-Manifeste ausschließlich mit
tatsächlichen Haltbelegen. Die ergänzte M10-Haltbelegkette liefert diesen
bestehenden Vertrag. Deployments ohne gebundene Haltpläne bleiben für die
Ist-Projektion ungeeignet. Der M10-Stack erhält additive Commits;
der Manifestvertrag wird für den nachgelagerten PR nicht umgeschrieben.

Der historische Anschlussabgleich von #535 (Head `a13fbc5`) bestätigt den gemeinsamen
Manifesttyp, die Ablehnung von Prognosen und eine datensparsame Projektion.
Die verbesserte native Flottenfixture wurde in #534 übernommen; der
Textkonflikt ist beseitigt. Ein konkreter M15-Prüfpunkt bleibt:
`apps/game-api/src/conductor-projection.ts` prüft Weltstatus und Eigentümer,
aber noch nicht `operators.lifecycle === "active"`. Vor der öffentlichen
Sitzungseinbindung braucht dieser interne Dienst die Aktivitätsprüfung samt
Negativtest. Das gehört zur M15-Abnahme und wird durch M10 nicht geschlossen.

Der erneute Codevergleich gegen #535, Head `e00165b`, bestätigt weiterhin
kompatible Manifest- und Fortschrittsfelder. Seine Projektion liest nur den
jüngsten abgeschlossenen Nachfragecheckpoint aus dem privaten Store; zusätzliche
Poolanfänge, Zwischenrevisionen und Cursor ändern den M15-Vertrag nicht.
Die M10-API zeigt Fahrgäste während eines aktiven Abschnitts, während M15
zusätzlich den belegten Ausstieg am Halt projizieren darf. Die gemeinsame
Glossardefinition der M15-Projektion und die Datenschutzbeschreibung sind
textgleich vorgelagert, damit die ergänzte M10-Dokumentation beim Merge keine
redaktionellen Konflikte erzeugt. Die Implementierung der Innenraumprojektion
bleibt Bestandteil von #535.

#530 entfernt Tutorialwelten, erzwingt eine Welt je Server und verwendet
Schema 35. M10 führt diese alten Konzepte nicht erneut ein. Die ausdrücklich
abgenommene M9.1-Hinweisfunktion bleibt erhalten. #531 liefert Layout,
Navigation und Gestaltungsregeln; seine Beispieldaten sind keine Nachfragequelle.

Die frühere Prüfung vom 06.09.2026 umfasste auch
[#536](https://github.com/larynxberlin-rgb/Zugfolge/pull/536),
„M15.3: Pixelartkorpus, geprüfter Atlaszugriff und Browsergalerie“, Head
`0a614ed2184f15033fba54828daca6575d855775`. Er baut auf #535 (`e00165b`) auf.
Titel, vollständiger PR-Text und Dateiumfang wurden geprüft: Grafikartefakte,
Atlasloader und Galerie ersetzen keine M10-Manifeste oder Haltbelege. Die
schließenden Referenzen sind leer; #213 bleibt wegen ausstehender formaler
Freigaben ausdrücklich offen. Seine zusätzlichen CI-Schritte und
Roadmap-/Glossarergänzungen sind beim Stack-Abgleich zu bewahren.

Der aktuelle Refresh ersetzt den zuletzt genannten #536-Stand: Der Titel
lautet jetzt „M15.3: Pixelartkorpus mit sechs Wagenfamilien und Browsergalerie“,
Head `db2242986511b0f3606fc3f5161b413bb7fe3586`, weiterhin auf
`codex/m15-manifest-projection`. Sein Umfang ergänzt insbesondere sechs
Wagenfamilien, Quellen-/Freigabebelege und Browserbilder. Die schließenden
Issue-Referenzen sind weiterhin leer. Zum Abruf waren Rust, natives NAPI und
Wächter grün; TypeScript lief noch. #535 heißt unverändert „M15.1/15.2:
Schaffnervertrag und belegte Fahrgastprojektion“, Head `e00165b`, Basis
`codex/m10-passenger-demand`, mit vier grünen CI-Jobs seines eigenen Stands.
Das ist kein Integrationsnachweis des neuen vierten M10-Teils. Beide M15-PRs
bleiben eigenständige offene Abhängigkeiten; ihre Manifest-/Haltverträge und
ihre CI-Ergänzungen sind beim späteren Zusammenführen zu bewahren.

Die übrigen offenen PRs bleiben #531 („UI/UX neu aufbauen: Deutschlandweite
LiveMap als Spielzentrum“), #532 („[M10 1/3] Gemeinsamer Nachfragekern und
SPNV-Fahrgastmanifeste“), #533 („[M10 2/3] Begrenzte SPFV-Trassen,
Bestandskapazität und Linienänderungen“) und #534 („[M10 3/3] Nachfrage und
SPFV in API, LiveMap und Spielerplanung“). Ihre Basen bilden weiterhin den
oben angegebenen Stack. Für den neuen M10-Teil werden die finalen vier
CI-Jobs und die echten Odoo-19-ORM-/HTTP-Prüfungen separat nachgetragen.

## Fachliche Abhängigkeiten

| Offene Arbeit | Konsequenz für M10 |
|---|---|
| #517, #518 | Queue, tatsächliche Betriebsaktivierung und Ist-Abschlussbeleg sind verschiedene Zustände; keine erfundenen Haltbelege oder Erlösbuchungen |
| #504 | Plätze und Kosten werden aus nativ geprüfter Flotte abgeleitet, nicht aus beliebigen Spielerversprechen |
| #509, #393, #398, #194 | Begrenzte Fenster, Kandidaten, Manifeste und Pagination; exakte indizierte Fahrplanabfragen; keine behauptete nationale Lastabnahme |
| #419 | Dauerhafte Queuebelege und Weltjournal sichern Wiederholung über Neustarts; kein begrenzter RAM-Cache als alleiniger Nachweis |
| #350, #394 | Vorhandene Zugnummern-, Laufweg- und Weltbindung wiederverwenden; keine frei erfundenen Spielerzugnummern |
| #502, #520 | Aggregat-/Eigentümerprojektionen trennen; keine realen Kontomerkmale im Fahrgastmodell, keine privaten JSON-Parameter in Fehlerlogs |
| #161, #193, #365, #382 | Nachfragebelegung ist keine Infrastrukturkapazität; Deutschlandkarte und Quellen-/Lastabnahme bleiben eigenständige Nachweise |
| #212, #211, #222, #366, #383 | M15 projiziert M10-Manifeste 1:1; keine zweite Nachfrage, Fahrberechtigung oder Kontrolle innerhalb M10 |
| #389, #390, #392, #395, #420–#425, #428, #432, #297, #294 | Bestehende Deploy-, Signatur-, Rollback- und Wiederherstellungsgrenzen werden nicht umgangen |
| M9 und #491 | Ein technischer M10-Stack ersetzt weder die externe Spielerabnahme noch andere offene Alpha-Nachweise |

Nicht zu M10 gehörende Zukunftsissues wurden berücksichtigt, aber nicht
pauschal in diesen fachlich zusammenhängenden Stack aufgenommen.

## Vollständig gesichteter Eingangsbestand

Die Angaben in eckigen Klammern stammen aus dem Milestonestatus bei Beginn
der Arbeit. Spätere upstream Abschlüsse (insbesondere #159/#530) werden
dadurch nicht wieder geöffnet.

- #520 [unassigned] [Datenschutz] Weltarchiv-Fence blockiert fälligen Konto- und Postfach-Purge
- #518 [unassigned] [Anbindung] Native Betriebsabschlüsse fehlen für Tagesberichte und Vertragsabrechnung
- #517 [unassigned] [Anbindung] Betriebsprogramm-Kommandos haben im produktiven Operational-v2-Pfad keinen Consumer
- #516 [unassigned] [Störungen] Selbstgenerierter La-Tagesgenerator ist nicht an den produktiven Weltbetrieb angeschlossen
- #509 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Audit][Performance] Globale Scans pro Bewegungsereignis reduzieren und realistisch vermessen
- #504 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Audit][Vergabe] Unbelegte Qualitätszusagen dominieren Wertung und fehlen im Vertrag
- #502 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Audit][Datenschutz] Definierte Postfach-Aufbewahrung technisch durchsetzen
- #491 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Audit 2026-09-04] Befunde, Reproduktionen und Maßnahmenübersicht
- #432 [unassigned] V2: Runner, Validator und Native-Receipt atomar provenancebinden
- #428 [unassigned] [P0][Trust] .4-Evidence verlangt verworfenen .3-Map-Schlüssel trotz Staging-Verbot
- #425 [unassigned] [P0][Signatur] Signed-Plan kann veraltete Delivery-v2 mit aktuellem Artefaktinventar kombinieren
- #424 [unassigned] [P0][Cutover] Nach Rollback-Reseal kann derselbe V2-Stand nicht erneut freigegeben werden
- #423 [unassigned] [P0][Rollback] Attestierter Legacy-Rückweg ist nach erstem Schreibvorgang nicht restartfähig
- #422 [unassigned] [P1][Rollback] Schema-29-Odoo-Drill prüft keinen echten Filestore-Schreibzugriff
- #421 [unassigned] [P0][Cutover] Recovery-CLI lehnt den kanonischen prepared-Gate-Modus ab
- #420 [unassigned] [P0][Deutschland-Release] Strecken-Zugsicherung wird als gleichzeitige Fahrzeugpflicht modelliert
- #419 [unassigned] [P0][Operational-v2] Begrenztes Receipt-Fenster erlaubt alte Kommando-ID erneut
- #398 [unassigned] [P1][Robustheit] Einzelne Operational-/GeoJSON-Datensätze können Releasebuilder bis OOM aufblasen
- #395 [unassigned] [P0] Operational-v2-Kartenpaket akzeptiert Legacy-Runtime-v1
- #394 [unassigned] [P0] Weltgebundene GTFS-IDs verhindern neue Welten mit signiertem InfraRelease
- #393 [unassigned] [P0] Deutschland-Operational-v2 kann weder gebaut noch als kompakter Zustand betrieben werden
- #392 [unassigned] [Bug][Produktion] Regionaler Scheduler und LiveMap-Readiness flappen bei realem Stillstand
- #390 [unassigned] [P0] Migration 0029 verhindert Laufzeit-Rollback auf den vorherigen Stand
- #389 [unassigned] [P0] Signiertes Alpha-Deployment v1 blockiert Upgrade auf Deployment-Schema v2
- #383 [M15 — Schaffnermodus] [UI M15] Schaffnermodus mit Bahnflair und klarem Rückweg gestalten
- #382 [M14 — Netzausweitung] [UI M14] Deutschlandkarte, Zugübersicht und Datenzustände skalierbar gestalten
- #381 [M13 — Odoo und Monetarisierung] [UI M13] Kontobereich, Mehrfenster und Exporte klar vom Spielgeld trennen
- #380 [M12 — Kooperation, Wirtschaftstiefe, Sekundärmarkt] [UI M12] Markt und Zusammenarbeit mit kompakten Listen und Details ausbauen
- #379 [M10 — Personenverkehrsnachfrage und SPFV] [UI M10] Nachfrage, Auslastung und Fahrgastinformation lesbar ergänzen
- #378 [M11 — SGV] [UI M11] Gütermarkt, Wagen und Terminals im neuen Design verbinden
- #377 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [UI M9] Einstieg, Unternehmen gründen und Spielhinweise responsiv gestalten
- #376 [M8 — Störungen, Baustellen, Ersatzverkehr] [UI M8] Störungen und Ersatzverkehr in LiveMap und Betrieb darstellen
- #366 [M15 — Schaffnermodus] [UX M15] Aus dem eigenen Zug in den Schaffnermodus und sicher zurück wechseln
- #365 [M14 — Netzausweitung] [UX M14] Die deutschlandweite LiveMap bei großer Datenmenge übersichtlich halten
- #364 [M13 — Odoo und Monetarisierung] [UX M13] Vorlagen, Mehrfenster und Kontofunktionen verständlich ergänzen
- #363 [M12 — Kooperation, Wirtschaftstiefe, Sekundärmarkt] [UX M12] Aufträge, Fahrzeuge und Zusammenarbeit mit klaren Entscheidungen ausbauen
- #362 [M11 — SGV] [UX M11] Güteraufträge, Wagen und Zugbildung spielerfreundlich verbinden
- #361 [M10 — Personenverkehrsnachfrage und SPFV] [UX M10] Nachfrage und Kapazität aus der deutschlandweiten LiveMap heraus planen
- #360 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [UX M9] Einstieg, Spielhinweise und Fehlerzustände der neuen Oberfläche abnehmen
- #359 [M8 — Störungen, Baustellen, Ersatzverkehr] [UX M8] Störungen von der LiveMap bis zum Ersatzkonzept verständlich bearbeiten
- #350 [unassigned] [Fachlichkeit][Zugnummern] Vergabe nach DB-InfraGO-System modellieren
- #343 [unassigned] [Verbesserung][Alpha-Abnahme] Echte Ausschreibungs- und Fahrzeugmarkt-Testvorfälle aus Odoo auslösen
- #297 [unassigned] [Bug][Release] Evaluationsbundle serialisiert Fleet- und Planning-Authority falsch
- #294 [unassigned] [Bug][Startup] Regionaler Cold Catch-up überschreitet Healthvertrag trotz Fortschritt
- #222 [M15 — Schaffnermodus] [Roadmap 15.12] Performance-, Determinismus- und Gesamtannahme
- #221 [M15 — Schaffnermodus] [Roadmap 15.11] Forderungen, Ausfälle und gedeckelte Kontrollprämie
- #220 [M15 — Schaffnermodus] [Roadmap 15.10] Polizeireaktion, EBE-Fallabschluss und Verspätungsursache
- #219 [M15 — Schaffnermodus] [Roadmap 15.9] Kontrollhalt über Konfliktengine und virtuelle Fahrdienstleiter
- #218 [M15 — Schaffnermodus] [Roadmap 15.8] Browserintegration für Bewegung, Touch und Barrierefreiheit
- #217 [M15 — Schaffnermodus] [Roadmap 15.7] Autoritative Schaffnersitzung, Berechtigung und Replay
- #216 [M15 — Schaffnermodus] [Roadmap 15.6] Versionierter Sprechblasen-Dialogkorpus
- #215 [M15 — Schaffnermodus] [Roadmap 15.5] Fließende Umgebung und modulare Bahnhofsszenen
- #214 [M15 — Schaffnermodus] [Roadmap 15.4] Konfigurationsgetreue begehbare Fahrzeuginnenräume
- #213 [M15 — Schaffnermodus] [Roadmap 15.3] Pixelart-Designsprache und freigegebener Asset-Korpus
- #212 [M15 — Schaffnermodus] [Roadmap 15.2] M10-Fahrgastmanifeste und deterministische 1:1-Projektion
- #211 [M15 — Schaffnermodus] [Roadmap 15.1] E29, ADR und Fachvertrag des Schaffnermodus
- #210 [M10 — Personenverkehrsnachfrage und SPFV] [Roadmap 10.3a] Autoritative SPNV-Fahrgastmanifeste und Fahrberechtigungsstatus
- #195 [M14 — Netzausweitung] [Roadmap 14.4] Weltenstart-Kadenz und Migrationsregeln
- #194 [M14 — Netzausweitung] [Roadmap 14.3] Lastprofile, horizontale Regionenverteilung, Kapazitätsplanung
- #193 [M14 — Netzausweitung] [Roadmap 14.2] Deutschlandweiter InfraCorpus und Karte als Spielzentrum: vollständiger Deutschland-Import unabhängig von der spielbaren Maske, dimensionsweiser Qualitätsreport, selbst gehostete Welt-Basiskarte und Deutschland-PMTiles, anklickbare Fachobjekte, Bahnhofstafel/FIS, jährlicher KI-Neubau und Odoo-Paketimport
- #191 [M13 — Odoo und Monetarisierung] [Roadmap 13.9] SLO 99,9 % nachweisen — baut auf der Betriebsreife aus M9.5 auf
- #190 [M13 — Odoo und Monetarisierung] [Roadmap 13.8] Erweiterte Automatisierung ausschließlich in privaten Welten (E13)
- #189 [M13 — Odoo und Monetarisierung] [Roadmap 13.7] Archiv- und Auswertungstiefe jenseits des entscheidungsrelevanten Zeitraums
- #188 [M13 — Odoo und Monetarisierung] [Roadmap 13.6] Exporte: Bildfahrplan, Umlauf- und Dienstpläne, Geschäftsberichte, Replay-Filme
- #187 [M13 — Odoo und Monetarisierung] [Roadmap 13.5] Sammelbearbeitung und Vorlagenverwaltung für die Handplanung
- #186 [M13 — Odoo und Monetarisierung] [Roadmap 13.4] Planungsarbeitsplatz: mehrere Bildfahrplanfenster, Layouts, Vergleichsansichten
- #185 [M13 — Odoo und Monetarisierung] [Roadmap 13.3] Entitlements, Zugfolge Plus, Kosmetik, Weltplätze, Odoo-Weltauswahl, kommerziell freigegebene Weltteilnahmen und private Welten
- #184 [M13 — Odoo und Monetarisierung] [Roadmap 13.2] Game-Outbox → Bridge → Odoo, signierter Webhook-Receiver, nächtlicher Reconciler
- #183 [M13 — Odoo und Monetarisierung] [Roadmap 13.1] Odoo Community selbst gehostet, strikt getrennt, OCA-Module versionsgepinnt
- #182 [M12 — Kooperation, Wirtschaftstiefe, Sekundärmarkt] [Roadmap 12.4] Öffentliche Qualitätsrankings mit Wirkung auf Ausschreibungswertung
- #181 [M12 — Kooperation, Wirtschaftstiefe, Sekundärmarkt] [Roadmap 12.3] Bietergemeinschaften, Kooperationstarife
- #180 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 12.2] Persistenter Fahrzeug-Sekundärmarkt mit Fristenstand, mehrdimensionalem Zustand, Lebenslauf, Wertverfall und Rücklauf nach Leasingende, Betriebsaufgabe oder Insolvenz; Neukäufe gehen bei Verwertung als dieselben Assets in diesen Markt
- #179 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 12.1] EVU-zu-EVU-Verträge: Traktion, Vermietung, Anschluss, Ersatzverkehr
- #178 [M11 — SGV] [Roadmap 11.5] Gefahrgut, Lademaß, Streckenklassen, Bremshundertstel
- #177 [M11 — SGV] [Roadmap 11.4] Wagenumläufe, Leerfahrten, Ganzzug gegenüber Einzelwagenverkehr
- #176 [M11 — SGV] [Roadmap 11.3] Verladerverträge — Spot und langfristig, Lieferqualität, Pönale
- #175 [M11 — SGV] [Roadmap 11.2] Wagen als eigene Assets, Zugbildung, Behandlungszeiten — Rangieren bleibt automatisiert (E12)
- #174 [M11 — SGV] [Roadmap 11.1] Warenstrom- und Industriemodell, Terminals, Anschlussgleise, Häfen
- #173 [M10 — Personenverkehrsnachfrage und SPFV] [Roadmap 10.5] Einwohnerbasierte Stationsnachfrage und direkte Odoo-Datenpflege
- #172 [M10 — Personenverkehrsnachfrage und SPFV] [Roadmap 10.4] SPFV-spezifische Linien-, Halte- und Taktplanung
- #171 [M10 — Personenverkehrsnachfrage und SPFV] [Roadmap 10.3] Tarif, Vertrieb, Kapazität und Fahrberechtigungen
- #170 [M10 — Personenverkehrsnachfrage und SPFV] [Roadmap 10.2] Verkehrsmittel-, Verbindungs- und Zugwahl im Personenverkehr
- #169 [M10 — Personenverkehrsnachfrage und SPFV] [Roadmap 10.1] Gemeinsames Zonen- und Reisenachfragemodell für SPNV und SPFV
- #168 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.10] Jährliche Infrastrukturaktualisierung (E22): InfraRelease-Neubau aus den jährlich gepinnten, rechtlich freigegebenen OSM-, DB-InfraGO-Open-Data-, GTFS-, Copernicus-DEM- und OpenStation-Ständen; Übernahmeverfahren für eine laufende Welt zum nächsten Periodenwechsel, ohne Invariante 1 zu verletzen
- #167 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.9] Geschlossene Alpha mit 20–50 externen Spielern in der deutschlandweiten Spieleroberfläche und dem ausdrücklich freigegebenen Spielnetz, einschließlich M12.1/M12.2
- #166 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.8] Weltende (E18): letzte Periode ohne Ausschreibung, reguläres Vertragsende ohne Insolvenzfolge, Schlusswertung mit mehreren Ranglisten, Archiv und Replay-Export
- #165 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.7] Telemetrie, Balancing-Dashboards, Feedbackkanal
- #164 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.6] Rate Limits, Anti-Bot-Prüfungen, Anomalieerkennung für Trassenfenster und Märkte
- #163 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.5] Betriebsreife: Observability, Backup und Restore, Incident-Runbooks. Gehört vor die erste Welt mit echten Spielern, nicht in die Monetarisierungsphase. Der Health-Check-Vertrag (packages/health, seit M2) liegt bereits — M9.5 baut Alarmierung, Dashboards und Backup darauf, zieht ihn nicht mehr nachträglich ein
- #162 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.4] Admin- und Auditwerkzeuge, Vier-Augen-Prinzip bei Hochrisikoaktionen
- #161 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.3] Onboarding in der öffentlichen Welt: tatsächliche StartingCapitalPolicy, Kapazitäts-Heatmap, Glossar-Layer und Betriebsassistent; keine automatische Startausstattung
- #159 [M9 — Onboarding, Betriebsreife, geschlossene Alpha] [Roadmap 9.1] Neue Tooltipps an den echten Bedienelementen; per Tastatur und Touch erreichbar, lokal abschaltbar

## Abschließender M15-Verbundnachweis

M10-Code `8d20f7e` und #536 `db224298` einschließlich #535 wurden in einem
isolierten Worktree konfliktfrei zusammengeführt, ohne die M15-Zweige zu ändern.
Der Mergebaum `26a9999c6146b61f2df9eb3fc33acbcf33a4fde6` besteht
`cargo test --locked -p zugfolge-conductor` mit zehn Tests sowie den Glossar-
und Diffcheck. Getrennte CI-Schritte im vorhandenen NAPI-Job erhalten sowohl
die neue Odoo-Datenprüfung als auch die M15-Projektionsprüfung; es entsteht
kein fünfter regulärer CI-Job.
