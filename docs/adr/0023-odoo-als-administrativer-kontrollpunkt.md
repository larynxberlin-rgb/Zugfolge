# ADR-0023: Odoo ist administrativer Kontroll- und Freigabepunkt, nie fachliche Source of Truth

- **Status:** Angenommen — bindend (entspricht E23)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../geschaeft.md](../geschaeft.md) · [../odoo-betrieb.md](../odoo-betrieb.md) · [GitHub-Decision-Issue #197](https://github.com/larynxberlin-rgb/Zugfolge/issues/197)
- **Betrifft Milestones:** M8.3, M9.4, M9.7, M9.10, M10.5, M13.1, M13.2, M13.3
- **Verwandte ADRs:** [ADR-0005](0005-rust-kern-typescript-plattform.md), [ADR-0013](0013-automatikmodus-kostenlos.md), [ADR-0022](0022-jaehrliche-infrastrukturaktualisierung.md)

## Kontext

Zugfolge benötigt für Kontakte, Rechnungen, Zahlungen, Erstattungen, Support und administrative Freigaben eine kaufmännische Oberfläche. Gleichzeitig sind Welten, Accounts, EVU, Entitlements, Fahrpläne, Simulation, Wirtschaft, Betriebshistorie und Auditlog Game-Fakten. Ein Odoo-Zugriff auf Game-Tabellen oder eine synchron aufgerufene Odoo-Entscheidung im Spielbetrieb würde Weltisolation, Determinismus, Verfügbarkeit und nachvollziehbare Autorisierung gefährden.

M9.4, M9.7 und M9.10 brauchen eine nutzbare Administrationsoberfläche: Anträge mit Vier-Augen-Prinzip, nachvollziehbare Betriebs- und Balancingprojektionen sowie den Freigabeprozess eines InfraRelease. M8.3 ergänzt künftig die autorisierte manuelle Störungserstellung mit Beginn, Ende, Ursache, betroffenen Ressourcen und deklarierter Wirkung. Keiner dieser Zwecke rechtfertigt eine zweite fachliche Wahrheit oder eine Übersteuerung von Konflikt-, Sicherheits-, Berechtigungs- oder Simulationsprüfungen.

## Entscheidung

**Odoo ist der administrative Kontroll- und Freigabepunkt, aber niemals die fachliche Source of Truth.** Es läuft selbst gehostet und getrennt; lediglich das eigene Add-on liegt im Zugfolge-Repository. Game → Odoo ist eine asynchrone, idempotente und datenminimierte Projektion aus einer nach Commit geschriebenen Outbox. Odoo → Game ist ausschließlich ein signiertes, versioniertes und typisiertes Kommando an die Game-API; der Receiver prüft Signatur, Zeitfenster, Replay, Schlüssel-ID, Mandant, Akteur und Inhalt und schreibt erst dann in eine persistente Game-Queue.

Die Zielarchitektur lässt jede menschliche Game-Administration in Odoo beginnen; eine direkte Spiel-Adminroute ist dann kein alternativer Wirkungspfad. Die bestehenden M0–M7-Entwicklungs- und Bootstraprouten werden bis zu ihrer produktiven Freigabe einzeln auf diesen Pfad überführt. Spieler-eigene, regelgebundene Dispositionsentscheidungen sind keine Administration und bleiben im Game. Die Game-Queue materialisiert Entitlements und administrative Anträge nur nach einer zweiten serverseitigen Autorisierungs- und Fachprüfung. Sensible Aktionen besitzen Antragsteller, Begründung, Risikoklasse, Wirkungs-Vorschau, Korrelation und Auditverweis. Hochrisikoaktionen verlangen einen anderen Freigeber. Der Zustand lautet in Odoo `draft → submitted → approved/rejected → dispatched → accepted/rejected by game → completed/failed`; ein Game-Ergebnis wird nur als Projektion zurückgespielt.

Das Add-on führt einen kleinen, versionskontrollierten Aktionskatalog. Für einen noch nicht implementierten Game-Milestone zeigt es die Aktion als **vorbereitet**, erlaubt Entwurf und Vier-Augen-Prüfung, aber keine Auslieferung. Erst eine signierte Game-Projektion einer tatsächlich registrierten Fähigkeit macht sie **ausführbar**. Das Game lehnt einen dennoch eintreffenden nicht registrierten Befehl nachvollziehbar ab und erzeugt keine fachliche Wirkung. Für M8.3 ist `manual_disruption_create` deshalb bereits ein hochriskanter Antrag mit den spezifizierten Pflichtfeldern, aber noch keine Störung im Simulationszustand.

Odoo steuert beim jährlichen InfraRelease ausschließlich Antrag, Prüfung und Freigabe für den nächsten zulässigen Periodenwechsel. Die Game-seitige Vorabprüfung bleibt allein zuständig für Invariante 1, laufende Zugfahrten, Trassen, Umläufe und Vertragspflichten; Odoo kann keinen Release aktiv setzen. Monitoring ist lesend und kann nur bestehende Anträge vorbereiten oder verlinken. Entitlements bleiben Game-Zustand; ihre Produkte liefern keine Spielwerte, Informationsvorsprünge oder Automatisierung in öffentlichen Welten.

Für den jährlichen Deutschland-Korpus führt das Add-on einen eigenen
Importdatensatz. Ein `InfraReviewer` lädt Manifest und sämtliche Teile hoch;
die Hintergrundprüfung verifiziert das exakte Inventar gestreamt und überträgt
jedes Teil HMAC-gebunden in einen getrennten Game-Stagingbereich. Upload,
Verifikation und Staging sind keine Freigabe. Ein unsignierter Kandidat bleibt
`activationEligible=false`, und die Reviewer-Rolle verleiht weder
Approver-Rechte noch die Fähigkeit, eine Welt umzuschalten. Erst ein signierter,
vom Game erneut qualifizierter Kandidat darf den bestehenden hochriskanten
Vier-Augen-Antrag für einen Periodenwechsel vorbereiten.

### Präzisierung: normale Nachfrage-Stammdatenpflege

Gemäß ausdrücklicher Produktvorgabe werden Einwohnerzahlen, Stationszuweisungen
und gerichtete Verbindungshinweise aus M10 als normale Odoo-Datenbankinhalte
gepflegt. Berechtigte Administratoren ändern sie direkt in den nativen Tabellen.
Speichern überträgt automatisch einen signierten, weltgebundenen
`demand.data.update`-Befehl; dafür gibt es keinen Antrag, Freigabestatus,
Korrekturexport oder Periodenwechsel als Voraussetzung. Diese Stammdatenpflege
ist eine ausdrücklich begrenzte Ausnahme vom administrativen Antragsworkflow.

Odoo verwaltet die eingegebenen Zahlen und unveränderliche Änderungsbelege;
amtliche Originalwerte und Quellpins bleiben getrennt erhalten. Das Game prüft
die Datenbindung und Konsistenz und bleibt allein autoritativ für Simulation,
wirksame Nachfrage und persistierte Snapshots. Der Transportstatus dokumentiert
Zustellung und Game-Ergebnis, keine zusätzliche Freigabe. Sensible andere
Aktionen behalten die bestehenden Antrags-, Vier-Augen- und Periodenregeln.

## Begründung

Die Trennung verbindet Odoos ausgereifte, native Funktionen — Nutzer/Gruppen, Kontakte, CRM, Rechnungen, Zahlungen, Aktivitäten, Mail-Thread und Standardansichten — mit einem kleinen eigenen Add-on für die Zugfolge-spezifische Grenze. Das reduziert selbst geschriebenen kaufmännischen Code, ohne fachliche Macht in das Fremdsystem zu verlagern.

Die asynchrone Outbox verhindert verlorene Projektionen zwischen Game-Commit und Fanout. Idempotente IDs, persistente Receipts, Retry und ein nächtlicher Reconciler verhindern Doppelwirkungen und machen Abweichungen sichtbar, statt sie still zu überschreiben. Eine Odoo-Störung lässt die Outbox wachsen und degradiert nur die Sichtbarkeit der Projektion; Login, Simulation, Livemap und bereits gültige Entitlements bleiben lokal verfügbar.

Datenschutz verlangt, Odoo nur die für kaufmännische Prozesse und einen konkreten Administrationsvorgang nötige Projektion zu geben. Wettbewerbs- und Personaldaten, Simulationseingaben und nicht erforderliche Game-Historie sind nicht Teil des Vertrags. Signierte, rotierbare Schlüssel und kurze Zeitfenster begrenzen die Maschine-zu-Maschine-Grenze; Geheimnisse stehen nie im Repository.

## Konsequenzen

- **Erleichtert:** native kaufmännische Odoo-Prozesse, überprüfbare Freigaben, Fehlersicht, Telemetrie-Drill-down und einen klaren Datenschutz-Schnitt.
- **Kostet / schränkt ein:** Odoo-Änderungen sind nie synchron sichtbar; Betrieb benötigt Schlüsselrotation, Queue-Beobachtung, Backup/Restore und den nächtlichen Reconciler. Das Add-on darf keine SQL- oder RPC-Verbindung zum Game-Schema erhalten.
- **Fähigkeiten und Ausfall:** Eine Aktion darf nicht per Umgebungsvariable eingeschaltet werden. Fehlt ihr Game-Handler oder ihre signierte Fähigkeitsprojektion, bleibt sie in Odoo vorbereitet; ein direkter Webhook wird im Game abgelehnt und als Ergebnis zurückprojiziert. Damit kann das Odoo-Modul vor M8/M9-Teilimplementierungen installiert und benutzt werden, ohne einen Schattenpfad zu schaffen.
- **Ausfall und Wiederherstellung:** Der Bridge-Health-Check wird bei Stau `degraded`, nicht spielblockierend. Nicht zugestellte Outbox-Einträge werden erneut versucht; Reconciliation erzeugt auditierte Korrekturaufgaben, niemals stille Überschreibungen.
- **Sicherheit und Datenschutz:** Jede sensible Aktion wird serverseitig autorisiert, validiert und auditiert; hohe Risiken unterliegen vier Augen. Odoo-Projektionen tragen Frische und Quellenverweis und enthalten nur die jeweils autorisierte Minimalmenge.
- **Invarianten:** Invariante 1 bleibt ausschließlich im Game prüfbar; Invariante 4 gilt für weltbezogene Queue-, Outbox- und Antragsdaten. Die globalen kaufmännischen Vertrags- und Replay-Belege sind sichtbar begründete Ausnahme ohne Simulation, Wirtschaft oder Weltfakten. Invariante 5 bleibt durch den getrennten `commerce`-Pfad und den CI-Wächter erzwungen.
- **Milestones:** M13 liefert Bridge und Entitlements; M9.4/M9.7/M9.10 erhalten nur die Odoo-seitige Steuerungs- und Auditoberfläche. M9 ist dadurch nicht insgesamt abgeschlossen.

## Verworfene Alternativen

1. **Direkter Odoo-Zugriff auf Game-Tabellen:** verworfen, weil er Weltisolation, Auditgrenze und Ausfalltoleranz zerstört.
2. **Synchroner Odoo-Aufruf im API-, Planner- oder Simulationspfad:** verworfen, weil Verfügbarkeit und Determinismus des Spiels dann von Odoo abhängen.
3. **Odoo als Entitlement- oder InfraRelease-Wahrheit:** verworfen, weil Kauf- und Freigabestatus keine Berechtigung zur Umgehung fachlicher Game-Prüfungen geben.
4. **Eigenbau von CRM, Rechnung, Zahlung und Benutzerverwaltung im Game:** verworfen, weil Odoo Community diese kaufmännischen Grundfunktionen nativ anbietet und zusätzliche Eigenentwicklung keine fachliche Spieltiefe schafft.
5. **Administrationsaktion allein durch Odoo-Konfiguration aktivieren:** verworfen, weil eine UI-Konfiguration keinen Game-Handler, keine Simulationsprüfung und keine Weltisolation nachweisen kann.
