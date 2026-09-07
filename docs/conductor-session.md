# M15.7: Autoritative Schaffnersitzung

Vertragsversion: `conductor-session/v1`. Die reine Rust-Crate
`zugfolge-conductor-session` erhält explizite committed Quellen und erzeugt
Zustand, Quittung, private Darstellungsereignisse und typisierte Kontrollabsichten.
Sie greift weder auf Datenbanken noch auf Uhr, Netz, Betriebsressourcen oder
Ledger zu. Die Plattform serialisiert Zugang, Zugreservierung, Kontoreservierung,
Zustandswechsel und Ereigniscommit unter demselben Weltmutex und DB-Commit.

## 1. Private Zustände und Autorisierung

Ein `ConductorTrainStateV1` gehört genau zu Welt und Zuglauf. Er hält höchstens
eine aktive oder getrennte Sitzung. `active` und `detached` reservieren den Zug
bis zum expliziten Lease-Ende. Nur derselbe berechtigte Spieler darf dieselbe
Sitzung wiederaufnehmen; `ended` ist endgültig. Ein erneuter Einstieg erzeugt
eine neue Sitzungskennung und setzt abgeschlossene Fälle nicht zurück.

Der Kern führt nur einen zufälligen privaten `ownerRef`. Die zugehörige
Kontoverknüpfung liegt separat und löschbar bei der Plattform. Account-ID und
ownerRef erscheinen in keinem öffentlichen Snapshot, Betriebs- oder Ledgerbeleg.
`ConductorSessionAccessV1` enthält servergeprüfte Zugangs-/EVU-/Nutzungsrechte und
die gegebenenfalls andere aktive Kontoreservierung. Diese ist kein Browserfeld.
Die Plattform erzwingt zusätzlich atomar höchstens eine aktive oder getrennte
Sitzung je Konto, auch über verschiedene Züge. Jeder Befehl, Reconnect und jede
SSE-Nachlieferung prüft Zugang und Eigentum erneut.

## 2. Echte Quellenbindung

`ConductorSessionSourceV1` enthält den vollständigen typisierten
`OperationalWorld` und seinen unabhängigen erwarteten Domainhash. Die Plattform
restauriert vorher den tatsächlichen Regionalcheckpoint gegen DB-Kopf,
Initialisierung und Infrastruktur. Ein vom Client selbst genannter Hash ist
keine Autorisierung. Im Kern gilt:

- OperationalWorld, Sitzung, M5, M10 und Releasepins gehören derselben Welt.
- Der wirkliche Zug ist eine eigene Personen-Zugbewegung mit tatsächlichem
  Fahrgasthaltplan; M10 benennt SPNV und dasselbe EVU.
- `trains[trainRunId].formationVersionId` verweist auf die tatsächliche
  Operational-Formation. Deren geordnete Fahrzeugliste entspricht exakt der
  ausgewählten M5-Formation. Die beiden Formationskennungen dürfen verschieden
  sein; Namensheuristiken und `TrainServiceV1` allein sind keine Bindung.
- Der Kern baut das M15.4-Layout erneut aus dem vollständigen M5-Beleg und
  projiziert über M15.2/V2 ausschließlich das echte M10-Ergebnis.
- Ist-Haltquittungen aus M10 stimmen mit dem tatsächlichen Operational-Haltplan
  und dessen quittierten Ankünften/Abfahrten überein. Prognosen sind unzulässig.
- Weltzeit kommt ausschließlich als ganzzahliger Zeitstand der committed
  Betriebswelt. Terminale Ankunft, entfallene Fahrt oder entzogene Nutzung
  beendet die Sitzung kontrolliert. Historische Außenlaufabschlüsse dürfen nur
  über einen ausdrücklich belegten historischen Replay-Eingang erfolgen.

## 3. Befehle, Lease und Revision

Die Native-Einstiege heißen `initializeConductorSessionState`,
`applyConductorSessionCommand`, `synchronizeConductorSession`,
`restoreConductorSessionState`, `projectConductorSessionSnapshot` und
`replayConductorSession`. Die exakten DTOs stehen in
`crates/zugfolge-conductor-session/src/types.rs`.

Neben `start_session`, `detach_session` und `resume_session` trägt der
Kommandotransport die fachlichen Aktionen `move`, `start_inspection`,
`choose_dialogue_option`, `request_police` und `end_session`. Alle Kommandos
binden Welt, Zug, Sitzung, erwartete Revision und Idempotenzschlüssel.
Releasegebundene Weltparameter begrenzen Lease, Befehlsrate, Gehgeschwindigkeit,
Bewegungsvorrat und Kontrollreichweite; fehlende Parameter haben keinen Default.
Bewegung verwendet die tatsächliche Ausgangsposition aus dem Zustand und die
M15.4-Kollisions-/Übergangsprüfung. Ein Millimeter-Bewegungsvorrat wächst mit
expliziter Weltzeit und ist gedeckelt. Gleichzeitige Kommandos schaffen keinen
zusätzlichen Gehweg. Treppen und Wagenübergänge brauchen ihre konkrete Kante.

Gleicher Schlüssel und gleicher Commandinhalt liefern die ursprüngliche
Quittung ohne erneute Mutation. Wiederholung verlangt weiterhin gültigen Zugang.
Abweichender Inhalt unter demselben Schlüssel wird abgewiesen. Der ursprüngliche
Commandhash bindet die Spielerabsicht, nicht eine später erneut gelesene
Serverzeit. Veraltete Revision oder Manifestbindung erfordert einen neuen
Snapshot; Offline-Aktionen werden nicht auf eine inzwischen andere Belegung
übertragen. Synchronisation der Weltquellen ist ein eigener deterministischer
Übergang und kann Fahrt-/Lease-Ende auch ohne Browserkommando feststellen.

## 4. Dialog, Fälle und Betriebshalt

Eine neue Kontrolle verlangt einen tatsächlich vorhandenen, noch nicht
aussteigenden Fahrgast und einen erreichbaren Interaktionspunkt in Reichweite.
Es läuft höchstens eine Begegnung zugleich. Der Dialogzustand kommt aus
`zugfolge-conductor-dialogue`; der sichtbare Zustand ausschließlich aus dessen
`PassengerEncounterV1`. Private Fahrberechtigung, Baumwahl und Zukunftsknoten
werden nicht in den Sitzungssnapshot übernommen. Während eines offenen Dialogs
wird keine neue Kontrolle begonnen und keine Bewegung ausgeführt.

Frisch erzeugte öffentliche Snapshots enthalten außerdem das Feld
`activePassengerKey`, wenn `activeEncounter` gesetzt ist. Es stammt
ausschließlich aus der tatsächlich aktiven Begegnung im
nativen Zugzustand. Der Schlüssel muss im selben autorisierten Snapshot zu
einem noch an Bord befindlichen Fahrgast gehören. Der Snapshot-Hash bindet
diese Zuordnung; private Fahrberechtigung oder Dialogbaumdaten werden nicht
mitgegeben. Reload, Detach und Resume erhalten dieselbe Zuordnung. Eine rein
lokale Listenauswahl darf weder den Gesprächspartner wechseln noch dessen
Sprechblase einer anderen Person zuordnen. Gesprächsende, Ausstieg oder
Sitzungsende setzen `activeEncounter` auf `null` und lassen `activePassengerKey`
weg. Die native Projektion weist fehlende oder widersprüchliche Zuordnungen
ab. Bereits gespeicherte V1-Quittungen und SSE-Snapshots ohne das neue Feld
bleiben unverändert lesbar und behalten ihre ursprünglichen Bytes und Hashes.
Der Transport ergänzt keinen Standardwert. Eine alte aktive Begegnung ohne
dieses Feld besitzt ausdrücklich noch keine öffentliche Personenzuordnung;
die Oberfläche wartet dafür auf einen frischen nativen Snapshot. Ein
vorhandenes Feld muss zur aktiven Begegnung und sichtbaren Person passen;
explizites `null` ist nur ohne aktive Begegnung zulässig.
Ein alter privater V1-Zustand, der eine Begegnung noch während des Ausstiegs
enthält, bleibt ohne Hashumschreibung restaurierbar. Die nächste native
Synchronisation schließt sie anhand der tatsächlichen M10-Aktivität, bevor
ein neuer zugeordneter Snapshot ausgegeben wird.

Fallbelege und offenbarte Evidence stammen aus dem serverautoritativen
Kontrollfall. Der Dialog erzeugt Absichten; Forderung, Geldbetrag und Polizeihalt
werden ausschließlich von ihren jeweiligen Domänen entschieden. Bindend
übernommene Kontrollfolgen bleiben zuglaufweit gespeichert und werden durch
`end_session`, Disconnect, Lease-Ende oder Eigentumsentzug niemals gelöscht.
Eine laufende Begegnung behält ihre Releaseversion über Periodenwechsel.
Verlässt der Fahrgast den Zug, endet ein noch offener Dialog ohne neue Forderung;
bereits bindende Fälle und Betriebshalte bleiben bestehen.

## 5. Restore, SSE und Replay

Der private Zustand und jede Quittung sind versioniert und gehasht. Restore
prüft den unabhängigen erwarteten Hash und die Struktur, bevor Daten sichtbar
werden. Sichtbare Snapshots besitzen einen eigenen Hash über ihre Whitelist;
privater Zustand wird nie als API-Snapshot verwendet. SSE-Sequenzen steigen
monoton je Zug. Die Plattform liefert ausschließlich eigene private Deltas nach;
bei fehlendem Journalbereich erfolgt ein vollständiger Snapshot.

Ein Replay erhält Initialzustand und dieselbe explizite Folge aus Kommandos,
Weltquellen und Synchronisationen. Es berechnet dieselben Quittungen und denselben
Zustandshash. Die dafür benötigten privaten Quellen bleiben releasegebunden in
der autorisierten Aufbewahrungsgrenze; Kontoentkopplung bleibt separat.

## 6. Gepinnte Sitzungs- und Dialogkonfiguration

`loadConductorSessionDeployment({path, expectedSha256, trustedKeysPath,
worldId, runtime, validator})` lädt ein unabhängig bytegepinntes
`conductor-session-deployment/v1`-Dokument mit `worldId`, `periods` und
`dialogueReleases`. Eine Periode enthält `periodId`, das halboffene
Millisekundenintervall `validFromMs`/`validUntilMs`, die vollständige
`ConductorSessionPolicyV1` einschließlich `contentHash` und
`currentDialogueReleaseHash`. Welt und Periode müssen mit der Policy
übereinstimmen; Perioden überlappen sich nicht.

Ein Dialogeintrag enthält ausschließlich `directory`, `pin` und `signature`.
Aus dem lokalen Verzeichnis werden `release.json` und
`editorial-review.json` begrenzt, ohne Symlinks oder Netzwerkpfade gelesen.
Der tatsächliche Loader aus `@zugfolge/conductor-dialogue` prüft anschließend
die Originalbytes, unabhängigen Welt-/Reviewpin, externe Ed25519-Signatur,
redaktionellen Beleg und vollständige native Korpusvalidierung. Der getrennte
`trustedKeysPath` stammt aus der Betreiberkonfiguration und enthält die
Zuordnung von Schlüsselkennung zu Ed25519-Public-Key-PEM. Das Deployment kann
keine eigenen vertrauenswürdigen Schlüssel mitliefern; der Loader erzeugt
weder Schlüssel noch Signaturen oder Freigaben.

`policyHash` serialisiert und hasht die Policy im Rust-Kern, validiert aber
nicht ihre Wertebereiche. Deshalb prüft die Transportgrenze vor dem Hashaufruf
zusätzlich die unveränderten nativen Grenzen: Lease 5.000–600.000 ms,
Befehlsfenster 100–60.000 ms, 1–1.000 Befehle pro Fenster,
Mindestabstand 0–1.000 ms, Gehgeschwindigkeit 100–3.000 mm/s,
Bewegungsvorrat 1–10.000 mm, Reichweite 500–2.500 mm und
Quittungslimit 128–262.144. Revision ist positiv; alle Werte sind sichere
Ganzzahlen. Fehlende oder zusätzliche Felder sind unzulässig.

Der verifizierte Catalog implementiert `resolve(worldId, periodId, nowMs)`.
Er gibt ausschließlich den passenden Periodenstand und immer sämtliche
geprüften Dialogreleases des Deployments zurück. Ein neuer aktueller
Dialogrelease verdrängt damit keine alte, weiterhin für laufende Fälle
benötigte Version. Jeder aktuelle Hash muss im geprüften Katalog vorkommen.
Unbekannte Welt, Periode oder Zeit liefern keinen impliziten Ersatzstand.

## 7. Abnahme

Pflichtnachweise sind tatsächliche M5-/Operational-/M10-Bindung, fremde Welt,
fremdes EVU, zweiter Spieler/Zug, doppelte und veraltete Kommandos, geänderte
Idempotenzinhalte, Bewegungslimit und Kollision, Reload mitten im Dialog,
Disconnect/Lease/Reconnect, Periodenwechsel, Fahrtende, Rechteentzug und
zuglaufweit fortbestehende Kontrollfolgen. Gleiche Quellen und Commandfolge
erzeugen bitgleiche Hashes. Tabellen, SSE, Log- und Metrikgrenzen werden zusätzlich
im tatsächlichen Plattformpfad geprüft.
