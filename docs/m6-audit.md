# M6-Abschlussaudit — SPNV: Ausschreibung, Vertrag, Geld

Stand: 9. August 2026. Dieses Audit prüft nicht, ob ein Typname vorhanden ist,
sondern ob ein fachlicher Zustandsübergang ausgeführt, seine Wirkung an Ledger
oder Postfach übergeben und der Übergang getestet wird.

| M6 | Ausführbarer Nachweis | Negativ-/Integrationsbeweis |
|----|-----------------------|-----------------------------|
| 6.1 | `buildEconomyRelease`, kanonische Prüfsumme, `pinEconomyRelease` | falsche Pinnung stoppt den Workflow |
| 6.2 | Klassifizierte Journalposten werden in `ledger_entries.cost_type` und `cost_centre_id` dauerhaft gespeichert | Migration 0004; PGlite-Test liest beide Werte zurück |
| 6.3 | `deriveWorldProfile` liefert alle vier veröffentlichten Zuschnitte; Vertragsende verwendet reale Periodendauer | Tests für 6/12/18 Monate und unbefristet |
| 6.3a | `createTenderCalendar` verteilt eine geschichtete Permutation, veröffentlicht sie beim Weltstart und prüft Erst-/Wiedervergabe-Überlappung | umgekehrte Eingabereihenfolge ergibt denselben Kalender |
| 6.4 | `announceTender` bindet Los, Leistungsbeschreibung, Profil, Fristen und Vertragslaufzeit zu einem echten Workflowzustand | unbekanntes Los, falsche Welt und falscher Release werden abgewiesen |
| 6.4a | `deterministicProfileOrder` weist Profile aus `tender_profile` zu; Anforderungsfokus, Pönalefokus und vier parametrisierte Sonderauflagen wirken auf Wertung beziehungsweise Vertrag | Katalogvalidierung und Angebotsprüfung weisen ungültige Auflagen zurück |
| 6.5 | `calculateViabilityThreshold` rechnet alle neun Kostentreiber ausschließlich aus dem gepinnten Release | null Zugkilometer und negative Releasesätze werden abgewiesen |
| 6.6 | `openTender`, `submitBid`, `closeTender`, `scoreBid` und `assistBid` bilden Frist, Angebotsbestand, Vorschau und sofortigen Zuschlag ab | zu frühes Öffnen/Schließen, verspätete, doppelte oder unauskömmliche Angebote scheitern |
| 6.6a | `validateVehicle` prüft Sitzplätze, Klassenanteil, Barrierefreiheit, Fahrrad-/Rollstuhlplätze und Ausstattung an der Formation | jeder fehlende Wert erscheint als erklärbarer Befund |
| 6.7 | `completeMobilization` prüft Fahrzeuge, Personal und Trassen exakt am Fahrplanstichtag; Erfolg erzeugt Vertrag, Scheitern atomar Eigenbetrieb, Pönale und Eignungsschaden | beide Pfade laufen im Workflowtest |
| 6.8 | `settleContractPeriod` prüft Nachweise und rechnet Zugkilometer, Bonus und vier profilgewichtete Pönalen; Ergebnis geht ins Ledgerjournal | fehlender Nachweis und falscher Zeitraum werden abgewiesen |
| 6.9 | `startPublicOperation` trägt Pool, Mindestbedienung, konservatives Regelwerk, nachrangige Trassen, Bonusverbot und Livemap-Marker | Übernahme entfernt den Spieler-Vertrag |
| 6.10 | `advancePublicOperation` beendet die Notvergabe nach exakt zwei Perioden und erzeugt das verbesserte Wiedervergabepaket | Test beweist Retender statt endlosem Eigenbetrieb |
| 6.11 | `commitAuthorityBudget` reserviert die Vertragsbelastung in der richtigen Periode beim Zuschlag | Überziehung wird vor Zuschlag abgewiesen |
| 6.12 | `calculateProfitAndLoss`, Liquiditätsplan, Kreditaufnahme, ganzzahlige Verzinsung, Tilgung und Restrukturierung | ungedeckte Tilgung/Kreditaufnahme und negative Werte scheitern |
| 6.13 | `escalateOperator` aktiviert Stufe 1–5, erzeugt Postfach- und Berichtsmeldungen; Stufe 5 beendet Verträge und startet Eigenbetrieb | Test durchläuft alle Stufen und die vollständige Liquidation |
| 6.14 | `submitBid` erzwingt weltgebundene Präqualifikation; Mobilisierungsfehler und Insolvenz verschlechtern sie, Insolvenz beschränkt große Lose, Weltende löscht sie | Weltisolations-, Reset-Sperren- und Weltende-Test |

## Durchgängiger Beweis

`workflow.test.ts` startet eine Welt mit öffentlichem Kalender, kündigt ein
profiliertes Los an, öffnet das Fenster, präqualifiziert und wertet ein Angebot,
belastet das Aufgabenträgerbudget, mobilisiert zum Stichtag und rechnet die
Betriebsperiode ab. Zwei weitere Pfade beweisen fehlgeschlagene Mobilisierung
und Insolvenz jeweils mit nahtloser Übernahme. Der Plattformtest schreibt die
Abrechnung in den echten PostgreSQL-Ledger und die Warnung in das echte
Postfachschema.

Damit sind die M6-Regeln nicht bloß Modelle oder Traits: Sie besitzen einen
weltisolierten, idempotenten Zustandsautomaten, persistente Ledgerwirkung,
konkrete Postfachwirkung und ausführbare Erfolgs- wie Fehlerpfade.
