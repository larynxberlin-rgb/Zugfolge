# Fahrzeugregister und Sekundärmarkt (M12.2)

Fachvertrag `zugfolge-vehicle-register/v1`. Ergänzt [Betrieb 3.6](betrieb.md#36-persistenter-fahrzeugmarkt-und-weltstartbestand)
und [Wirtschaft 5](wirtschaft.md#5-insolvenz-als-totalverlust-e8).

## Identität und Aufbewahrung

Jedes konkrete Fahrzeug bleibt während der gesamten Spielzeit erhalten. Das
gilt gleichermaßen für Neufahrzeuge, gebrauchte Startbestände, Spielerfahrzeuge
und Fahrzeuge öffentlicher Betreiber. Die Identität ist das Paar aus Welt und
Fahrzeugkennung; ein Angebots-, Eigentümer- oder Halterwechsel erzeugt kein
neues Fahrzeug.

Der Lebenslauf beginnt mit dem ersten autoritativen Welteintritt. Er wächst
ausschließlich durch neue Ereignisse beziehungsweise bestätigte
Zustandsrevisionen. Frühere Einträge werden weder überschrieben noch beim
Verkauf, Vertragsende, Betreiberende oder nach einer Ausmusterung gelöscht.
Eine Ausmusterung beendet die Nutzbarkeit, nicht die Identität oder Sichtbarkeit.
Neustart und Wiederholung einer bereits bestätigten Revision erzeugen keine
doppelten Fahrzeuge oder Historieneinträge.

## Öffentlicher Fahrzeugpass

Alle Spieler mit Zugang zur jeweiligen Welt können das Fahrzeugverzeichnis,
den Fahrzeugpass und die gesamte erfasste Historie jedes Fahrzeugs lesen.
Ein eigenes Unternehmen, Eigentum am Fahrzeug oder ein aktives Marktangebot
ist dafür nicht erforderlich. Der Zugriff auf eine andere Welt bleibt gesperrt.

Der Fahrzeugpass ist unabhängig von Angeboten auffindbar und direkt verlinkbar.
Markt und Unternehmensflotte führen zum selben Fahrzeug. Er erklärt Herkunft,
Eigentümer und Halter, aktuelle Konfiguration, Fristen sowie die belegten
Zustandsänderungen. Aus Datenschutzgründen enthält er Spielweltidentitäten,
keine Kontokennungen oder Authentifizierungsdaten.

Unbekannte Werte sind als unbekannt auszuweisen. Ein Zähler seit der letzten
Wartung ist keine Gesamtlaufleistung. Ein technischer Zustand ist kein
Innenraumzustand. Fehlende Kauf- oder Bewertungsgrundlagen dürfen nicht durch
einen erfundenen Nullwert ersetzt werden. Bestätigte Änderungen nennen die
explizite Weltzeit; ein Wiederaufbau darf keine frühere Historie behaupten,
die in den vorhandenen Belegen nicht enthalten ist.

## Markt und Rücklauf

Ein Angebot referenziert ein bereits existierendes Fahrzeug und einen
unveränderlichen Offenlegungsstand. Vor einer verbindlichen Übernahme prüft
der Server Eigentum, Halter, Zustand, Fristen, Reservierung, Liquidität und
betriebliche Bindungen erneut. Eine geänderte Offenlegung verlangt eine neue
Entscheidung. Geld bleibt ganzzahliges Cent-Ledger; ein ausgewiesener Restwert
folgt einer versionierten Bewertungsregel und ist vom Angebotspreis getrennt.

Ein reguläres Leasingende darf nicht vor der vereinbarten Weltzeit erfolgen.
Es übergibt dasselbe Fahrzeug mit aktuellem Zustand an den Eigentümer zurück.
Eine Insolvenz oder Betriebsaufgabe verwendet denselben Identitätserhalt:
gemietete Fahrzeuge gehen zurück, eigene Fahrzeuge werden nach der zulässigen
Verwertung erneut angeboten. Eine noch aktive betriebliche Bindung darf durch
eine Marktaktion nicht stillschweigend entfernt werden. Fehlgeschlagene
Übergaben verändern weder Flotte noch Register, Historie oder Ledger.

## Abnahmekriterien

| Fall | Erwartung |
| --- | --- |
| Neues und gebrauchtes Fahrzeug treten in die Welt ein | Jeweils genau eine dauerhafte Identität mit Herkunftsbeleg |
| Weltteilnehmer ohne EVU öffnet einen fremden Fahrzeugpass | Fahrzeug und erfasste Historie sind lesbar |
| Marktangebot fehlt oder endet | Fahrzeugpass bleibt erreichbar |
| Eigentum, Nutzung oder Zustand wechseln | Alte und neue bestätigte Fakten bleiben zeitlich geordnet lesbar |
| Identische Revision wird wiederholt / Server startet neu | Keine Duplikate, keine verschwundenen Fahrzeuge |
| Andere Welt wird angefragt | Kein Zugriff auf fremden Bestand oder Lebenslauf |
| Rückgabe wird vor Leasingende versucht | Ablehnung ohne Zustandsänderung |
| Übergabe eines betrieblich gebundenen Fahrzeugs | Ablehnung ohne Teilbuchung oder gelöschte Bindung |
| Fahrzeug wird ausgemustert | Nicht mehr handelbar, Identität und Historie bleiben erhalten |

Der Implementierungs- und Testnachweis wird getrennt von einer Abnahme auf der
Alpha-Zielumgebung geführt. Ein lokaler Browser mit Beispieldaten ersetzt
keinen externen Zwei-Spieler-Lauf.

## Persistenz und Wiederaufbau

Migration `0036_persistent_vehicle_registry.sql` trennt das vollständige
Weltregister von handelbaren EVU-Beständen. Auch öffentliche Betreiber ohne
EVU-Konto erhalten Registereinträge. Datenbanktrigger verhindern das Löschen
von Fahrzeugen und das Ändern oder Löschen bestehender Historienereignisse.
Aktuelle Registerfakten werden zusammen mit jedem bestätigten Fleet-Commit
geschrieben; Zustandshash und verkettete Historienhashes binden die Belege.

Bereits bestehende Welten werden vor dem ersten neuen Fleet-Commit und beim
Registerzugriff aus ihren gespeicherten Fleet-Checkpoints chronologisch
nachgeführt. Die bestätigten Revisionen bleiben die Quelle; es werden keine
vermuteten Zwischenereignisse ergänzt. Die Register- und Historienendpunkte
verwenden weltgebundene Cursor und liefern alle Seiten ohne Abschneiden alter
Einträge. Der direkte Spielerlink lautet `#vehicle-<kodierte Fahrzeugkennung>`.

Der Rust-Marktvertrag heißt nun `persistent-vehicle-market/v2`: Sein Hash
bindet zusätzlich die vollständigen ursprünglichen Fahrzeugfakten. Der
bestehende Fleet-Snapshotvertrag und dessen Golden-Master bleiben unverändert.

## Freigegebene Bewertungsgrundlagen

Der optionale Serverparameter `ZUGFOLGE_VEHICLE_VALUATION_CATALOG_PATH`
verweist auf eine absolute, reguläre UTF-8-JSON-Datei. Das Wurzelobjekt hat
`schemaVersion: "zugfolge-vehicle-valuation-catalog/v1"` und ein Array
`entries`. Jeder Eintrag bindet eine konkrete Welt mit `worldId`,
`authorityReleaseId`, `economyReleaseChecksum` und `vehicles`.

| Feld je Fahrzeug | Bedeutung |
| --- | --- |
| `vehicleId` | Bereits in der Fleet-Authority vorhandene Fahrzeugkennung |
| `atS` | Weltsekunde, ab der die belegte Bewertung gilt |
| `odometerMetres` | Belegte Gesamtlaufleistung, ganzzahlig als Dezimalstring |
| `conditionBasisPoints` | Belegter Bewertungszustand von 0 bis 10.000 |
| `basis.baseValueCents` | Freigegebener Grundwert in Cent als Dezimalstring |
| `basis.ageYears` | Alter in vollständigen Jahren am Bewertungszeitpunkt |
| `basis.spec` | Versionierte Regel mit `specId`, jährlicher Abschreibung, Laufleistungsschritten, Schadensabschlägen und Mindestrestwert |

Die Regel verwendet die Felder `annualDepreciationBasisPoints`,
`mileageStepMetres` (Dezimalstring), `mileageDepreciationBasisPoints`,
`maximumMileageSteps`, `damageDeductionsBasisPoints` und
`minimumResidualBasisPoints` des bestehenden `VehicleValuationSpec`-Vertrags.
Geld- und Zählerwerte werden ganzzahlig verarbeitet. Die tatsächlich in der
Welt gepinnten Fleet- und Economy-Releases müssen passen. Die erstmalige
Anwendung pinnt zusätzlich den gesamten Weltkatalog-Hash; ein nachträglicher
Austausch wird abgelehnt.

Dieser Serverpfad materialisiert einen unveränderlichen Bewertungsbeleg und
ergänzt die Grundlage an demselben bereits bestehenden Fahrzeug. Spieler
können keine Bewertungsbelege einstellen. Alterung verwendet weiterhin den
ursprünglichen Bewertungszeitpunkt; Verkauf setzt das Fahrzeugalter nicht
zurück. Verspätete Fortschrittsaufrufe dürfen eine bereits bestätigte
Abschreibung nicht zurückdrehen. Ein geänderter Offenlegungsstand löst alte
Reservierungen und verlangt vor dem Kauf eine erneute Entscheidung.
Ein Bewertungsjahr umfasst im v1-Vertrag genau 31.536.000 Weltsekunden
(365 Tage); der Kalender des Serverrechners beeinflusst die Berechnung nicht.

Ohne freigegebene Grundlage bleiben Restwert und Gesamtlaufleistung unbekannt.
Der Eigentümer kann einen eigenen Verkaufspreis angeben; eine automatische
Insolvenzverwertung wartet auf belastbare Werte und meldet die offene
Voraussetzung. Diese Änderung liefert keine erfundenen Fahrzeugpreise oder
produktiven Bewertungsfreigaben mit. Die echte Zielwelt benötigt den zu ihren
Releases passenden, freigegebenen Katalog.

## Prüfpfade und offene Abnahme

Gezielte Tests decken neue und gebrauchte Bestände, Replay, chronologischen
Wiederaufbau, Eigentümerwechsel, Ausmusterung, öffentliche Betreiber,
Weltisolation, Schutz vor Löschung, verspätete Abschreibung, Mietrücklauf und
Betriebsaufgabe ab. Ein einzelner noch gebundener Mietrücklauf blockiert nicht
den Fortschritt anderer Verträge. Neue Betriebsaufträge eines beendeten EVU
werden auch im Fleet-Commit unter der Weltsperre abgewiesen.

Die UI-Prüfung enthält Marktfilter, Fristen, Registersuche, paginierte
Historie, direkte Fahrzeugpässe und die ausdrückliche Bestätigung einer
Betriebsaufgabe. Screenshots und reproduzierbare Befehle stehen im
[UI-Nachweis](ui-redesign/README.md). Die reguläre
[CI](ci.md) prüft zusätzlich Linux, echtes NAPI und PostgreSQL.

M12.2 bleibt bis zur externen Abnahme in Arbeit: Auf der Alpha-Zielumgebung
sind zwei getrennte Spieler, echte freigegebene Fahrzeugbewertungen und ein
vollständiger Kauf-/Miet-/Rücklauflauf einschließlich Neustart nachzuweisen.
Die automatisierten Prüfungen ersetzen diesen Zielbetriebsnachweis nicht.
