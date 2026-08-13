# ADR-0030: Odoo-Weltkatalog und kommerzielle Teilnahme an Game-autoritativen Welten

- **Status:** Vorgeschlagen – technische Ausgestaltung von E23 und E28; die Aktivitätsgrenzwerte sind noch nicht angenommen
- **Bezug:** [ADR-0023](0023-odoo-als-administrativer-kontrollpunkt.md) · [ADR-0028](0028-getrennter-tutorial-und-wettbewerbsstart.md) · [../odoo-betrieb.md](../odoo-betrieb.md)
- **Betrifft Milestones:** M9.3, M9.6, M9.7, M13.1, M13.2, M13.3
- **Verwandte ADRs:** ADR-0005, ADR-0018, ADR-0023, ADR-0028

## Kontext

Websitebesucher brauchen vergleichbare öffentliche Weltdaten, Portalnutzer einen nachvollziehbaren Kauf- und Teilnahmezustand. Odoo ist für Angebot, Bestellung, Zahlung und Rechnung geeignet, darf aber weder Weltzustand noch EVU-Mitgliedschaft erfinden. Das Game besitzt bereits den signierten Odoo-Receiver, die persistente Command-Queue, Game-Outbox, Replay-Receipts und Reconciliation. Diese Grenze soll erweitert und nicht durch direkte Datenbankzugriffe oder Browseraufrufe zum Game umgangen werden.

Die Kennzahl „stark aktiv“ ist fachlich noch nicht definiert. Login, Online-Präsenz und eine geöffnete Browserseite belegen keinen tatsächlichen Betrieb. Eine veröffentlichte Zahl ohne genehmigte Policy wäre daher ein Fantasiewert.

## Entscheidung

Odoo speichert einen signiert empfangenen, ausschließlich aggregierten `zugfolge-public-world-snapshot/v1` als Website-Cache. Öffentliche und Portal-Seiten lesen nur diesen Cache. Ein begrenzter Odoo-Endpunkt aktualisiert Builder-Snippets höchstens einmal pro Minute; es gibt keine Game-Adresse und kein Geheimnis im Browser. Fehlende oder mehr als 180 Sekunden alte Snapshots werden sichtbar als fehlend beziehungsweise möglicherweise veraltet markiert.

Nach bestätigter Zahlung sendet Odoo `world.participation.change` in der vorhandenen HMAC-Hülle `zugfolge-odoo/v1`. Der Payload bindet `world_id`, Keycloak-`sub`, Partner-, Bestell- und Zahlungsreferenz, fachlichen Idempotency-Key, Zeitstempel und `zugfolge-world-participation/v1`. Der Game-Worker serialisiert Kapazitäts- und Phasenprüfung je Welt, erzeugt erst dann den Weltzugang und projiziert `active`, `rejected`, `cancelled` oder `refunded` zurück. Keycloak-Rollen werden dabei nicht gelesen. Doppelte Event-IDs und neue Event-IDs mit demselben fachlichen Payment-Key wirken höchstens einmal.

Neue öffentliche Weltverträge erweitern den vorhandenen `zugfolge-alpha-world-blueprint/v2`. `StartingCapitalPolicy`, Aufnahmevertrag, öffentliche Metadaten und eine explizite `ActivityPolicy | null` sind Teil des gehashten und extern Ed25519-signierten Blueprints. Damit bleibt die parallel vorhandene Welt-Deployment-Architektur maßgeblich; es entsteht kein zweiter Weltstartpfad. Blueprints ohne den vollständigen Katalogvertrag werden nicht als öffentliche Website-Snapshots ausgegeben.

`StartingCapitalPolicy` ist ausschließlich `{mode:"finite", amountCents: bigint}` oder `{mode:"unlimited"}`; Wire-Beträge sind kanonische Dezimalstrings. Blueprint v2 verlangt die Policy explizit, und neue öffentliche Welten verwenden standardmäßig den signierten Nullstart. Bei der EVU-Gründung wird nur diese Geldregel atomar angewandt; Fahrzeuge, Strecken, Personal und andere Startpakete werden nicht angelegt. Tutorialwelten behalten ihren getrennten geführten Startpaketvertrag.

Die Aktivitätsberechnung ist versioniert, weltgebunden und deterministisch gegen autoritative Weltzeit. Sie zählt ausschließlich freigegebene Game-Ereignistypen mit direkter EVU-Bindung in einem rollierenden Fenster und schließt System-EVU, Bots, ausgeschiedene und gelöschte EVU aus. Solange die Policy `null` ist, lautet der öffentliche Zustand `unconfigured` und die Zahl ist `null`, niemals `0`.

## Noch offene fachliche Entscheidung: Aktivitätsgrenzwerte

Keine der folgenden Varianten wird durch dieses ADR aktiviert:

1. **Variante A – kurze Betriebswoche:** 7 Tage, Mindestscore 10; vorhandener Zugleistungsbeleg `operations.train-outcome` mit Gewicht 2, vorhandener wirtschaftlicher Beleg `economy.settlement` mit Gewicht 1. Reagiert schnell, kann saisonale oder wochenendlastige EVU früh als inaktiv behandeln.
2. **Variante B – robuste Zweiwochenbetrachtung:** 14 Tage, Mindestscore 12; `operations.train-outcome` mit Gewicht 3, `economy.settlement` mit Gewicht 1. Stabiler gegen kurze Abwesenheit, reagiert langsamer auf tatsächlich aufgegebene EVU.

Vor produktiver Freigabe ist eine Variante anhand realer Alpha-Ereignisverteilungen zu kalibrieren und ausdrücklich anzunehmen. Gewichte und Grenzwerte werden danach im signierten Welt-Blueprint fixiert; ein laufender Weltvertrag ändert sie nicht still.

## Konsequenzen

- Odoo-Ausfall stoppt Website-Aktualität und neue kaufmännische Freigaben, aber weder Login noch bestehende Mitgliedschaften, Simulation oder Livemap.
- Bannerdateien bleiben Odoo-Attachments. Alt-Text, Quelle, Urheber, Lizenz, Attribution und Brennpunkt sind Pflicht; ohne Rechtefreigabe wird ausschließlich das Repository-Fallback veröffentlicht.
- Öffentliche Snapshots enthalten keine Namen, Subjects, Odoo-IDs, individuellen Aktivitätsverläufe, Zahlungs- oder Bestellreferenzen.
- Polling wird SSE vorgezogen: Snapshotdaten ändern sich nur im 30-/60-Sekunden-Takt; begrenztes HTTP-Caching ist einfacher zu betreiben und erzeugt keine dauerhaften Besucher-Verbindungen.
- Eine echte Odoo-19-, Browser-, Payment-Provider- und getrennte Game-Abnahme bleibt ein externer Release-Gate. Repository- und PGlite-Tests ersetzen sie nicht.

## Verworfene Alternativen

1. Direkte Odoo-Abfragen der Game-Datenbank oder Besucherabfragen an das Game: verletzen E23 und koppeln Last sowie Ausfall.
2. Keycloak-Rolle als Weltmitgliedschaft: verwechselt Identität mit Game-Berechtigung und umgeht Kapazitätsregeln.
3. „Stark aktiv“ aus Login/Online/Browserstatus: misst Präsenz statt Betrieb und ist manipulierbar.
4. `Infinity`, `null`, negative Werte oder Float-Geld: nicht deterministisch und nicht verlustfrei über JSON/PostgreSQL/Rust.
5. SSE pro Websitebesucher: für minutenaktuelle Aggregationen unnötige Verbindungs- und Betriebsdauer.
