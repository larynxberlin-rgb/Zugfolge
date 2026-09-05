# Datenschutzinventar

Inventarversion `zugfolge-personal-data-inventory/v2`, Exportversion
`zugfolge-personal-data-export/v2`. Jede neue unmittelbar oder mittelbar
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
| Tutorialfortschritt | `tutorialProgress`, eigenes Konto in der angefragten Welt |
| Tutorialinstanzen | `tutorialSessions`, ausschliesslich die direkt an oeffentliche Welt und Konto gebundenen Instanzen |
| Tutorialtelemetrie | `tutorialTelemetry`, nur ueber diese eigenen Instanzen und ihre jeweilige Tutorialwelt |
| Kommerzielle Berechtigungen | `commerceEntitlements`, alle eigenen globalen Berechtigungen anhand des authentifizierten Subjects; keine fremden Vertragsanbieter-/Kundendaten |
| Berechtigungsverwendung | `commerceWorldClaims`, eigene Entitlements ausschliesslich in der angefragten Welt |
| Kaufmaennische Weltteilnahme | `worldParticipations`, eigene Teilnahme in der angefragten Welt |
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

Der Writer-Fence archivierter Welten sperrt derzeit auch personenbezogene
Konten- und Postfachaenderungen. Solche Faelle bleiben als expliziter
Aufbewahrungsrueckstand protokolliert; andere Konten/Welten werden weiter
verarbeitet. Die Trennung personenbezogener Daten vom unveraenderlichen
Archiv-Seal ist ein offener Implementierungsbefund; der Purge umgeht den
Archivschutz nicht.

Der [geprüfte Archivvertrag](datenschutz-archivgrenze.md) trennt die
kryptografische Grenze bereits attestierter Cutover-Vorgänger vom möglichen
künftigen Purge normaler fachlicher Archive und nennt den ausführbaren
Integrationstest. Issue #520 bleibt offen.

Ein geraeumter Nachrichtendatensatz enthaelt eine leere Payload, einen neutralen
Typ und den Raeumzeitpunkt. Kennung, Empfaenger, Idempotenzschluessel und
unveraenderlicher Inhaltshash bleiben als Zustellbeleg erhalten. Ein spaeter
Outbox-Retry liefert diesen Beleg und erzeugt keinen neuen Postfachinhalt.
Gleicher Schluessel mit anderer Payload, anderem Typ oder anderer Frist ist ein
Konflikt. Ein technischer Retry-Versandzeitpunkt verschiebt weder Originalversand
noch Aufbewahrung. Postfach- und Datenschutzansichten filtern geraeumte Belege.
