# M15.4: Autorisierte Innenraumprojektion der Spiel-API

Vertrag: `conductor-interior-deployment/v1`. Ein lokales serverseitiges
Deployment nennt `worldId` und `periods`. Jeder Periodeneintrag führt
`periodId`, `validFromMs`, `validUntilMs`, `geometryPolicy`,
`geometryPolicyHash`, `artPin`, `artSignature` und `artDirectory`.
Periodenkennungen sind eindeutig; Zeitintervalle sind nicht überlappend und
gelten einschließlich Beginn, ausschließlich Ende. Zeiten sind explizite
nichtnegative sichere Ganzzahlen seit Weltepoche. M5 erhält keine erfundene
Periodenkennung.

Das Deployment kommt aus `ZUGFOLGE_CONDUCTOR_INTERIOR_DEPLOYMENT_PATH` und
wird gegen `ZUGFOLGE_CONDUCTOR_INTERIOR_DEPLOYMENT_SHA256` geprüft. Die
öffentlichen Ed25519-Schlüssel stammen unabhängig davon aus
`ZUGFOLGE_CONDUCTOR_ART_TRUSTED_KEYS_PATH`; weder Deployment noch Atlas dürfen
Vertrauen ergänzen. Dateien und Atlasverzeichnisse sind lokale absolute Pfade.
Die vollständige M15.3-Prüfung lädt bei Serverstart die exakten Manifest-,
Grafik- und Belegbytes unter dem bestehenden Weltpin und der getrennten
Signatur. Sie erzeugt keine Schlüssel, Weltpins oder Produktivfreigaben.
Fehlende optionale Konfiguration deaktiviert den Einstieg sichtbar; eine
teilweise oder fehlerhafte Konfiguration bricht den Start ab.

Der lesende Endpunkt lautet
`GET /worlds/:worldId/operators/:operatorId/fleet/formations/:formationId/interior`.
Er verlangt Keycloak-Authentifizierung und exakt die Queryparameter
`expectedFleetStateHash` und `periodId`. Zusätzliche Daten, insbesondere
Geometrie, Zeit, Fahrgäste, Konfiguration oder Releasepins aus dem Browser,
werden abgelehnt. Seine Antwort ist das vollständige `InteriorLayoutV1`;
der Aufruf eröffnet keine Schaffnersitzung und verändert keine Formation.

Der Dienst prüft Weltzugang, aktive Welt und eigenes aktives EVU gemeinsam mit
dem aktuellen M5-Checkpoint in einer Datenbanktransaktion. Native
`verifyFleetWorldState` muss Welt, Revision, explizite Zustandszeit,
Authority-Releasehash, Zustandshash und Mobilisierungshash exakt bestätigen.
Die ausgewählte Formation muss zur eigenen Mobilisierungsprojektion gehören,
dieselbe geordnete Assetliste wie der gespeicherte Intent besitzen und durch
die aktuellen Halterrechte gedeckt sein. Ein späterer Halterwechsel entzieht
den Zugriff. Alte Zustands- oder Periodenpins werden abgelehnt.

Die aktuelle Periode wird ausschließlich mit dem serverseitigen,
bereits committed Regionalzustand bestimmt. Der Produktionseinstieg verlangt
für alle erwarteten Regionen der Welt einen bereiten Zustand mit gleichem
explizitem `nowMs`. Fehlender, widersprüchlicher oder noch nicht restaurierter
Betriebszustand liefert keinen Ersatzwert. Clientzeit und Systemuhr sind
keine Periodenquelle dieses Dienstes.

Der Rust-Generator bekommt ausschließlich diese autorisierten M5-Daten und
das gepinnte Periodenprofil. Fahrzeugkonfigurationen müssen vollständig
vorliegen. Die konkrete fehlende Konfiguration wird mit der Kennung des
bereits autorisierten eigenen Assets gemeldet. Sonstige DB-/Native-Fehler
geben keine Quellparameter, privaten Zustände oder Dateipfade aus. Die
benötigten Innenraum- und Fahrzeugmotive werden am geladenen Weltatlas geprüft.

Der Route-Logger schreibt strukturierte `conductor_interior_result`-Ereignisse
mit festem Ergebnis und Fehlercode. Weltkennung erscheint erst nach eigenem
autorisiertem EVU, Revision erst nach Native-Verifikation und Periodenkennung
erst nach erfolgreicher serverseitiger Periodenbindung. Erfolgsereignisse
enthalten diese drei Bezüge. Abgelehnte Zugriffe und ungültige Anfragen
enthalten keine privaten Kontextfelder. Tokens, Personen, Fahrzeugquellfakten,
Dateipfade und freie DB-/Native-Fehlertexte sind keine Logfelder.

Automatisierte Nachweise führen fiktive, ausdrücklich konfigurierte M5-
Spielassets durch den echten Katalogcompiler, native Initialisierung und
Formationskommandos, DB-Commit, native Verifikation und Geometrieableitung.
Der Grafikbeweis verwendet den tatsächlich freigegebenen M15.3-Korpus mit
einer separat benannten temporären Testsignatur; diese ist keine produktive
Signeridentität. Zugriffsentzug, fremde Welt, veraltete Revision und Periode,
fehlende Konfiguration, manipulierte Dateien und Datenbankrestore bleiben
eigene Negativ- beziehungsweise Wiederherstellungsbeweise.
