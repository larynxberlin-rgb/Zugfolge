# M15.7 – Sitzungen in der gemeinsamen Spielwelt

Vertrag: `zugfolge-conductor-session-platform/v1`. Ergänzt den kanonischen
[Schaffnervertrag](schaffnermodus.md) und den reinen
[Sitzungskern](conductor-session.md). Diese Spezifikation wird vor der
Plattformimplementierung angelegt; Abnahmen folgen erst mit ihren Belegen.

## Ein konsistenter Weltübergang

Jeder Einstieg, jedes Kommando und jede Wiederaufnahme laufen in einer
Datenbanktransaktion mit exklusiver Sperre auf der vorhandenen Weltzeile.
Dies ist dieselbe Serialisierungsgrenze wie M5, M10 und der regionale Betrieb.
Innerhalb der Sperre prüft der Dienst aktiven Weltzugang, Konto, eigenes
aktives Unternehmen und aktuelle Nutzungsrechte an allen Fahrzeugen erneut.
Ein HTTP-Erfolg wird erst nach Commit gesendet. Abgelehnte Befehle verändern
weder Fachzustand noch Ressourcen oder Ledger.

Unabhängig fällige Sitzungsenden werden vor dem Benutzerbefehl in einem eigenen
Weltwriter-Commit aufgeräumt. Eine danach abgewiesene Anfrage rollt einen bereits
entzogenen Zugang oder abgelaufenen Lease nicht zurück. Die regionale Kennung
bleibt am gespeicherten Zugzustand, damit auch eine entfallene Fahrt anhand des
ursprünglich signiert gebundenen Regionalstands beendet werden kann. Das Sweep
verwendet die private alte Ownerzuordnung ausschließlich für die erneute
Rechteprüfung; sie autorisiert niemals den neuen Aufrufer.

Der Dienst liest die signiert gebundenen regionalen Checkpoints und lässt
den betreffenden Zustand durch die vorhandene Operational-v2-Runtime
restaurieren. Initialisierungspin, Zustandshash, Revision, Welt und Region
müssen mit dem gespeicherten Kopf übereinstimmen. Aus dem restaurierten
`OperationalWorld` stammen Zugzustand, explizite Zeit, Formationsversion und
geordnete Fahrzeugliste. Genau eine aktuelle eigene M5-Formation muss dieselbe
Fahrzeugliste besitzen. Gleiche Namen, Kapazitäten oder vom Client übermittelte
Formationskennungen ersetzen diese Bindung nicht.

Der M5-Checkpoint wird nativ verifiziert. Daraus und aus dem gepinnten
Innenraumdeployment entsteht das vollständige `BuildInteriorLayoutInputV1`.
Der neueste M10-Checkpoint wird gegen seine Eingänge nativ nachgerechnet;
nur `progress_bound` mit bestätigten Haltbelegen ist zulässig. Der Sitzungskern
vergleicht diese Belege mit dem tatsächlichen Zugzustand. Kein Planzeitablauf
und keine Browseruhr erzeugt einen Einstieg oder Fahrgastwechsel.

## Private Persistenz und Wiederholung

Die kontobezogene Sitzung und ihre privaten Kommandoquittungen sowie
Snapshotsequenzen werden getrennt vom allgemeinen Betriebsjournal gespeichert.
Alle Primär-, Fremd- und Suchschlüssel enthalten die Weltkennung. Partiell
eindeutige Indizes sichern höchstens eine reservierte Sitzung je Zug und Konto,
auch bei zwei Browsern oder konkurrierenden Prozessen. Getrennte Sitzungen
reservieren beide bis zum expliziten Lease-Ende.

Der Idempotenzschlüssel gilt innerhalb einer Welt und Sitzung. Eine kanonische
Prüfsumme bindet ihn an den vollständigen akzeptierten Befehl. Gleicher Inhalt
liefert die damalige Quittung, geänderter Inhalt wird abgewiesen. Berechtigung
wird auch vor einer solchen Wiederholung erneut geprüft. Veraltete Revisionen
und beim Offlinebleiben überholte Manifestbindungen erfordern einen neuen
Snapshot. Der Client sendet ausschließlich Absichten, niemals private
Manifeste, Layouts, Dialogbäume, Fallausgänge oder Geldbeträge.

Snapshot und SSE verwenden dieselbe native öffentliche Projektion. Jede
Nachlieferung prüft die aktuelle Berechtigung. Eine fehlende, zu alte oder
unpassende Sequenz wird durch einen vollständigen Snapshot ersetzt; sie darf
keine Deltafolge über einen unbekannten Grundzustand legen. Die Oberfläche
beendet ihre lokale Interaktion bei Verbindungsverlust und lädt vor weiteren
Befehlen den aktuellen Stand.

Kontolöschung entfernt die private Kontozuordnung, Lease und den privaten
Quittungs-/Snapshotbestand. Der native Zugzustand verwendet ausschließlich
eine zufällige, danach nicht mehr kontozuordenbare `ownerRef`; er darf die
fehlende Zuordnung nicht aus Historien wiederherstellen. Auskunft enthält den eigenen privaten Bestand.
Bereits verbindliche betriebliche Halte und wirtschaftliche Fallbelege
referenzieren synthetische Fall- und Zugkennungen und bleiben von dieser
Löschung unabhängig. Sie enthalten keine Konto- oder Keycloakkennung.

## API und Darstellung

Die Basis ist
`/worlds/:worldId/operators/:operatorId/trains/:trainRunId/conductor-sessions`.
Einstieg und Befehle benutzen authentifizierte POST-Anfragen; Status, Snapshot,
Atlaszugriff und SSE bleiben privat authentifiziert. Antworten werden nicht
öffentlich gecacht. Fehler enthalten verständliche feste Codes und Texte,
keine nativen Rohfehler oder SQL-Parameter. Allgemeine Telemetrie enthält nur
Welt, Vorgangsart, Ergebnis, Revision und Laufzeit; keine Konto-, Fahrgast-
oder Dialogdaten.

Die Hauptoberfläche öffnet den Modus aus dem eigenen aktiven SPNV-Zugdetail.
Rückweg, Welt, Unternehmen, Zug und bestätigter nächster Halt bleiben sichtbar.
Eine fehlende Freigabe oder Datenbindung erklärt den nicht verfügbaren Einstieg.
Die vollständige Desktop-/Touch- und Zugänglichkeitsabnahme gehört zu M15.8;
der signierte Mehrzugnachweis einschließlich Netz- und Ledgerfolgen zu M15.12.

## Betriebliche Polizeifolgen

Die Kontrollintegration ruft den vorhandenen RegionalSimulationWorker innerhalb
der bereits gesperrten Welttransaktion mit einem transaktionsgebundenen
Datenbankhandle auf. Seine bestehenden nativen Übergänge, Savepoints,
Compare-and-set-Prüfungen, dauerhaften Quittungen und Ereignisadapter bleiben
unverändert maßgeblich. Eine ausschließlich private LiveMap-Registry nimmt
vorläufige Veröffentlichungen auf; vor dem äußeren Commit wird kein
öffentlicher Spielstrom verändert. Der reguläre Regionalwriter liest bei seinem
nächsten Übergang den tatsächlich committed Kopf und veröffentlicht diesen.
Ein fehlender Policy-/Modellpin wird nicht durch eine Browserregel ersetzt.

Nach jedem angenommenen Kontrolleffekt lädt die Sitzung den Kontext im selben
Commit erneut. Ihr Betriebs-, Manifest- und Szenenstand kann deshalb keinen
bereits angenommenen Kontrollhalt übersehen. Der unabhängige Weltzyklus schreibt
auch Fälle ohne aktive Schaffnersitzung fort.

## Produktionsbindung und unabhängiger Fortschritt

Das optionale Schaffnerdeployment wird nur vollständig aktiviert: Innenraum mit
signiertem Atlas, Sitzungsregeln mit unabhängigem Dialogschlüsselring,
Szenenrelease und Kontrollkonfiguration mit M6-Releasepin. Jeder lokale Pfad
besitzt einen unabhängigen SHA-256-Konfigurationspin. Teilkonfigurationen
brechen den Serverstart ab. Bestehende Welten ohne dieses Deployment können
weiter starten. Testsignaturen und fiktive Szenen bleiben auf Testaufrufe
begrenzt.

Nach dem regulären regionalen Commit und der M10-Fortschreibung sperrt der
Kontrollzyklus die Weltzeile. Er restauriert die originalen Regionalzustände
gegen ihre Initialisierungspins und verlangt dieselbe bestätigte Weltzeit in
allen erwarteten Regionen. Erst diese Zeit darf Polizei, Nachweisfristen und
Tagesabrechnung fortschreiben. Eine fehlende oder auseinanderlaufende Region
erzeugt keinen erfundenen Zeitfortschritt. Anschließend übernimmt M10 neue
betriebliche Belege; Sitzungsbereinigungen besitzen einen unabhängigen Commit.
