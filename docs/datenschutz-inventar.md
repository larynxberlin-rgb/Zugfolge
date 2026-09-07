# Datenschutzinventar

Inventarversion `zugfolge-personal-data-inventory/v3`, Exportversion
`zugfolge-personal-data-export/v4`. Jede neue unmittelbar oder mittelbar
kontobezogene Tabelle erfordert eine explizite Entscheidung in diesem Inventar
und einen Test ihres Exportwegs. Das Weltkonto ist der autorisierte
Einstiegspunkt; sein Subject stammt ausschliesslich aus dem verifizierten Token.
Aktiver Spielzugang ist fuer die Selbstauskunft nicht erforderlich.

| Kategorie | Zuordnung und Export |
|---|---|
| Konto und Rollen | `account`, einschliesslich urspruenglichem Loeschzeitpunkt und eigenen Rollen |
| Weltzugang und Vertragsbestaetigung | `worldAccess`, einschliesslich Erteilung, Widerruf, Vertrags-Hash, Startkapitalregel und Annahmezeit |
| Gegruendete EVU | `operators`, auf Gruenderkonto und Welt begrenzt |
| Postfach | `mailboxMessages`, auf eigenen Empfaenger und Welt begrenzt; geraeumte Inhalte sind nicht mehr vorhanden |
| Kommerzielle Berechtigungen | `commerceEntitlements`, alle eigenen globalen Berechtigungen anhand des authentifizierten Subjects; keine fremden Vertragsanbieter-/Kundendaten |
| Berechtigungsverwendung | `commerceWorldClaims`, eigene Entitlements ausschliesslich in der angefragten Welt |
| Kaufmaennische Weltteilnahme | `worldParticipations`, eigene Teilnahme in der angefragten Welt |
| Private Schaffnersitzungen | `conductor`: `conductor_owners` über eigenes Weltkonto, `conductor_leases` über dieselbe Welt/Konto-ID, `conductor_command_receipts` und `conductor_snapshots` ausschließlich über den tatsächlich zugeordneten eigenen `ownerRef`; keine fremden Zugpersonal-Snapshots |
| Archivredaktionsaufträge | `archivePrivacy.requests`: `archive_privacy_requests` nur in der eigenen Welt; Kontovorgänge über `objectId = account.id`, Postfachvorgänge über den tatsächlich vorhandenen Nachrichtendatensatz mit derselben Welt und `recipientAccountId = account.id`, einschließlich bereits geräumter Zustellbelege |
| Archivredaktions-Hashzeilen | `archivePrivacy.requests[].rows`: `archive_privacy_rows` ausschließlich über Welt und Kennung eines eigenen exportierten Auftrags; enthalten nur gespeicherte Vorher-/Nachher-Hashes, keine rekonstruierten Altinhalte oder fremden Aufträge |
| Synthetische Schaffnerfachzustände | `conductor_train_states` und `conductor_control_states` enthalten synthetische Zug-/Kontrollfälle ohne Konto-/Keycloak-Zuordnung; keine vollständige Ausgabe fremder Zugzustände im persönlichen Export |
| Keycloak-Anmeldedaten | Verantwortungsbereich Identitaetsdienst; Passwoerter, Tokens und Sitzungsgeheimnisse werden niemals im Game-Export gesammelt |
| Odoo-Rechnung und Zahlungsdaten | Verantwortungsbereich kaufmaennischer Auskunft; das Game exportiert nur seine eigenen gespeicherten Berechtigungs-/Teilnahmereferenzen |
| Weltjournal, Ledger und Betriebsberichte | EVU-/Weltverlauf, kein pauschaler Export fremder Spielzustaende; pseudonyme Autoritaetsbelege bleiben nach dem Konto-Purge bestehen |
| Abuse-/Feedback-Pseudonyme | Erfordern eine gesonderte administrative Zuordnung ueber den serverseitigen Pseudonymisierungsschluessel; dafuer existiert noch kein automatischer Auskunftsendpunkt. Der Selbstexport erhaelt weder globale Geheimnisse noch Daten anderer Identitaeten |

Nach der endgueltigen Entkopplung des Weltkontos liefert dessen bisheriges
Subject `404` mit dem bestehenden Fall „keine zuordenbaren Daten“. Globale
kommerzielle Vertraege sind von der Loeschung eines einzelnen Weltkontos
getrennt; deren kaufmaennischer Auskunftsweg bleibt zustaendig.

## Aufbewahrung und Wiederholung

Der erste Loeschantrag setzt `erasedAt` atomar. Weitere Antraege erhalten diesen
Zeitpunkt und geben ihn zurueck. Ein Ruecknahmepfad ist nicht implementiert.
Nach 90 Tagen entkoppelt der taegliche Kontopurge den externen Identifier; die
fachliche Konto-ID bleibt als Bestandteil der unveraenderlichen Betriebshistorie.

Postfachinhalte verfallen 365 Tage nach dem urspruenglichen Versand, unabhaengig
von Lesen oder Quittieren. Eine zukuenftige fachliche Frist haelt den Inhalt bis
zum Fristende fest. Andere Aufbewahrungsausnahmen sind nicht implementiert;
rechtlich bzw. fachlich unabhaengige Originalbelege liegen im zustaendigen Journal.
Der taegliche Serverlauf raeumt hoechstens 500 Inhalte je Welt und protokolliert
Anzahl, Fehler und Welten mit weiterem Rueckstand.

Der [geprüfte Archivvertrag](datenschutz-archivgrenze.md) erlaubt ab Schema 37
ausschließlich fest definierte Konten- und Postfachredaktionen unter dem
Weltlock. Die vier privaten Schaffnersitzungstabellen werden bereits bei der
Löschvormerkung entfernt. Hashbelege erhalten die Prüfbarkeit originaler
Historien-/Cutover-Siegel, ohne gelöschte persönliche Inhalte zu behalten.
Die Aufträge und Hashzeilen bleiben unveränderlich als Redaktionsbelege
bestehen; vor der endgültigen Subjectentkopplung sind die eigenen Belege im
Selbstexport enthalten. Nach dem Kontopurge ist über das frühere Subject
keine Zuordnung und damit keine persönliche Auskunft mehr möglich.
Wiederherstellung verlangt einen unabhängig gepinnten vollständigen
Redaktionsstand. Andere Archivschreibvorgänge bleiben gesperrt.

Ein geraeumter Nachrichtendatensatz enthaelt eine leere Payload, einen neutralen
Typ und den Raeumzeitpunkt. Kennung, Empfaenger, Idempotenzschluessel und
unveraenderlicher Inhaltshash bleiben als Zustellbeleg erhalten. Ein spaeter
Outbox-Retry liefert diesen Beleg und erzeugt keinen neuen Postfachinhalt.
Gleicher Schluessel mit anderer Payload, anderem Typ oder anderer Frist ist ein
Konflikt. Ein technischer Retry-Versandzeitpunkt verschiebt weder Originalversand
noch Aufbewahrung. Postfach- und Datenschutz-Inhaltsansichten filtern geräumte
Belege; die neue Auskunftskategorie für Archivredaktionen darf ihren weiterhin
tatsächlich eigenen Zustellbeleg ausschließlich zur Zuordnungsprüfung nutzen.

Die Verhaltenstests in `packages/privacy/src/conductor.test.ts` belegen den
privaten Sitzungs-Selbstexport und die Löschgrenze. Die erweiterten
`archive-redaction.test.ts` prüfen eigene Konto- und Postfachredaktionen vor
der endgültigen Entkopplung, fremde Konten/Welten und den anschließenden
Fall `PersonalDataNotFoundError` (HTTP 404). Text- oder Kennungsvermutungen
ersetzen keine tatsächlich gespeicherte Welt-/Empfängerzuordnung.
