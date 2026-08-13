# ADR-0028: Tutorialstart und öffentlicher Markteintritt sind getrennte Weltverträge

- **Status:** Angenommen — bindend (entspricht E28)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../produkt.md](../produkt.md) · [../wirtschaft.md](../wirtschaft.md) · [../odoo-betrieb.md](../odoo-betrieb.md)
- **Betrifft Milestones:** M9.1, M9.2, M9.3, M9.4, M9.9, M12.2
- **Verwandte ADRs:** [ADR-0007](0007-eigenbetrieb-bei-gescheiterter-ausschreibung.md), [ADR-0018](0018-weltlaufzeit-und-skalierende-perioden.md), [ADR-0019](0019-realismus-dient-dem-spiel.md), [ADR-0023](0023-odoo-als-administrativer-kontrollpunkt.md), [ADR-0024](0024-erweiterter-alpha-schnitt.md)

## Kontext

Ein Tutorial muss komplexe Abläufe schnell und reproduzierbar vorführen. Dafür
sind ein vorbereiteter Verkehrsvertrag, ein konkretes Leasingfahrzeug, Personal,
eine Trasse und ein Betriebsprogramm sinnvoll. In einer öffentlichen
Wettbewerbswelt wären dieselben Zuteilungen jedoch keine didaktische Probe,
sondern echte Kapazität, Vermögen und Vertragsposition. Ein Startpaket pro neuem
EVU würde den veröffentlichten Vergabekalender, den persistenten Fahrzeugmarkt
und die Gleichbehandlung der Teilnehmer umgehen.

Gleichzeitig braucht jede öffentliche Welt eine ausdrückliche Antwort auf die
Frage, mit welchem Kapital ein neues EVU seine Bücher eröffnet. Ein im Code
verdrahteter Betrag wäre weder weltgebunden noch im Replay nachweisbar. Ein als
Zahl gespeichertes „unendlich“ würde außerdem die Integer-Cent-Invariante
verletzen und könnte weder korrekt gebucht noch plattformunabhängig gehasht
werden. Ein Start mit null Cent darf andererseits nicht in eine Sackgasse führen,
die nur durch ein verborgenes Geschenk aufgelöst wird.

Die Weltanlage beginnt gemäß E23 in Odoo, während der private
Release-Signaturschlüssel bewusst außerhalb von Odoo und Repository verwahrt
wird. Die HMAC-Signatur des Odoo-Webhooks schützt den Transport eines
Administrationskommandos, ist aber keine Ed25519-Freigabe eines Weltbestands.
Ohne ausdrückliche Trennung bestünde die Gefahr, beide Vertrauensgrenzen
gleichzusetzen oder Odoo zur fachlichen Weltwahrheit zu machen.

## Entscheidung

**Tutorialstart und öffentlicher Markteintritt sind zwei getrennte,
weltgebundene Verträge.** Ein `StarterPackage` darf ausschließlich in einer
laufenden Tutorial-Welt vergeben werden. Diese Welt besitzt ein eigenes
signiertes Deployment, `profileKind=tutorial`, ist privat und ungewertet und
darf beschleunigt laufen. Ihr Paket kann einen vorbereiteten Vertrag,
Leasingfahrzeug, Personal, Trasse und Betriebsprogramm enthalten, weil diese
Ressourcen nur den didaktischen Ablauf dieser Tutorial-Welt betreffen.

Eine öffentliche Wettbewerbswelt vergibt bei der EVU-Gründung **kein**
Startpaket: keinen Vertrag, kein Fahrzeug, keine Trasse, kein Personal und kein
Betriebsprogramm. Die Gründung legt stattdessen idempotent die EVU-Bücher an und
wendet genau die `StartingCapitalPolicy` des signierten Weltentwurfs an:

- `{ "mode": "finite", "amountCents": "…" }` enthält einen nichtnegativen,
  kanonischen Dezimalstring im vorzeichenbehafteten 64-Bit-Centbereich. Der
  Fachpfad parst ihn ohne `Number` als `bigint`. Der Standard für eine neue
  Wettbewerbswelt ist `amountCents: "0"`. Auch null wird als ausgeglichene
  Eröffnungsbuchung festgehalten.
- `{ "mode": "unlimited" }` ist eine Weltregel ohne Zahlenwert und ohne
  `amountCents`. Sie erzeugt keinen Ersatzbetrag und keine
  Pseudo-`Infinity`-Buchung. Nur die Darstellung darf dafür `∞` zeigen.

Die Policy ist Bestandteil des kanonischen Blueprints, des Blueprint-Hashes,
des signierten Deployments, der Weltstartprojektion und des Replays. Sie gilt
für jedes in dieser Welt gegründete EVU gleich und ist nach erfolgreichem
Weltstart unveränderlich. Eine andere Policy verlangt eine neue Welt; weder
Odoo noch ein Game-Adminbefehl darf die laufende Welt umschreiben.

Der öffentliche Nullstart nutzt einen veröffentlichten, weltgebundenen
`award-contingent-wet-lease`-Vertrag. Vor dem Zuschlag darf ein EVU damit ein im
signierten Losbestand vorhandenes Eigenbetriebs-Fahrzeugkonzept kalkulieren;
es erhält dabei weder Asset, Nutzungsrecht noch Buchung. Erst der reguläre
Zuschlag aktiviert die Betriebsbereitstellung. Formation, Personal und Trasse
werden am Mobilisierungsstichtag erneut gegen denselben M5-Snapshot geprüft,
und die Kostenbasis bleibt der endliche `formation-operating-cost`-Wert. Die
Regel gilt für alle EVU der Welt gleich, ist im Blueprint sichtbar und ersetzt
weder Vergabewettbewerb noch spätere Kredit-, Leasing- und Sekundärmarktwege.
Fehlt ein so belegter erster Vergabeweg, ist der Weltentwurf nicht
freigabefähig. Kostenlose Assets, Beitrittsverträge oder nur für Neueinsteiger
sichtbare Guthaben sind ausgeschlossen.

Die administrative Weltanlage ist zweiphasig:

1. Odoo erfasst und prüft Weltdefinition und `StartingCapitalPolicy` und stellt
   diese erste Phase als exakte JSON-Signierkonfiguration bereit. Ein externer
   Generator übernimmt sie unverändert in den vollständigen Blueprint- und
   Deployment-Kandidaten. Das ist Konfiguration und Staging, noch kein Weltstart.
2. Ein externer Prozess signiert den exakt gehashten vollständigen Kandidaten mit dem außerhalb
   von Odoo verwahrten Ed25519-Schlüssel. Das signierte Deployment wird dem
   Odoo-Antrag beigefügt und über den typisierten, HMAC-geschützten
   `world_deploy`-Befehl zugestellt. Das Game prüft Ed25519-Signatur,
   Deployment- und Blueprint-Hash, Weltbindung, Release-Pins und identische
   Policy erneut. Nur das Game persistiert und startet die Welt.

Odoo zeigt die Game-Projektion von Profil, Policy und Hashes lesend an. Eine
Abweichung zwischen Odoo-Konfiguration, signiertem Deployment und
Game-Projektion ist ein harter Konflikt und wird nicht automatisch angeglichen.

## Begründung

Die Trennung erhält den didaktischen Wert eines sofort spielbaren Tutorials,
ohne in einer dauerhaften Wettbewerbswelt knappe Ressourcen außerhalb ihrer
Märkte zu verteilen. Neue und bestehende EVU unterliegen denselben
Ausschreibungs-, Kredit- und Fahrzeugregeln; der Zeitpunkt der Einladung erzeugt
kein zusätzliches Vermögen.

Eine explizite, gehashte Policy macht verschiedene Weltkonzepte möglich, ohne
Geldarithmetik zu verbiegen. Endliches Kapital bleibt echtes Integer-Cent im
Ledger. `unlimited` bleibt eine benannte Regel und kann deshalb weder überlaufen
noch versehentlich als sehr großer, aber doch endlicher Betrag behandelt werden.
Die Unveränderlichkeit schützt Replay, Ranking und wirtschaftliche
Vergleichbarkeit.

Die zweiphasige Anlage bewahrt die Grenzen aus E23: Odoo bietet den
administrativen Dialog und Vier-Augen-Nachweis, hält aber weder den privaten
Release-Schlüssel noch fachliche Weltmacht. Die externe Ed25519-Signatur bindet
den freigegebenen Bestand; die Odoo-HMAC-Signatur authentifiziert lediglich das
Kommando. Die erneute Game-Prüfung verhindert, dass ein korrekt transportierter,
aber fachlich abweichender Antrag eine Welt startet.

## Konsequenzen

- **Erleichtert:** klare Spielerkommunikation, reproduzierbare
  Eröffnungsbilanzen, mehrere bewusst verschiedene Weltkonzepte und ein
  Tutorial, das ohne Wettbewerbsvorteil sofort handlungsfähig ist.
- **Kostet / schränkt ein:** Tutorial und öffentliche Welt benötigen getrennte
  signierte Deployments. Jeder öffentliche Weltentwurf braucht vor Freigabe
  einen dokumentierten Nullstart-Nachweis gegen echte Ausschreibungs-, Fleet-
  und Mobilisierungsdaten.
- **Betrieb:** Weltdefinition und signiertes Deployment müssen als zwei
  unterschiedliche Artefakte auditiert werden. Der externe Ed25519-Schritt ist
  ein bewusstes Freigabe-Gate und darf nicht durch den Odoo-HMAC-Schlüssel
  ersetzt werden.
- **Wirtschaft:** `finite` wird genau einmal ausgeglichen im EVU-Ledger gebucht;
  `unlimited` bleibt Policy. Der zuschlagsgebundene Betriebsbereitstellungsvertrag
  darf vor Zuschlag kein Asset zuteilen; alle späteren Kosten bleiben endlich.
- **Invarianten:** Geld bleibt `i64` Cent, jede Buchung und Policy ist
  weltgebunden, Odoo bleibt außerhalb des heißen Pfads, und derselbe signierte
  Blueprint erzeugt denselben Hash und Startzustand.
- **Abnahme:** Repositorytests für Parser, Hashbindung, Ledger-Idempotenz,
  Tutorial-Guard, öffentlichen Negativfall und Odoo-Vertrag sind nötig. Sie
  ersetzen weder einen realen Ed25519-signierten Doppelweltstart noch den echten
  Odoo-19-/Browserlauf mit einem externen Konto.

## Verworfene Alternativen

1. **Dasselbe Startpaket in Tutorial und öffentlicher Welt:** verworfen, weil
   ein Lehrmittel im Wettbewerb zu Vermögen, Kapazität und Vertragsvorsprung
   wird.
2. **Ein globaler Startkapitalbetrag im Anwendungscode:** verworfen, weil er
   weder Weltkonzept noch signiertes Replay bindet und nur durch Deployment des
   Codes geändert werden könnte.
3. **„Unbegrenzt“ als maximaler Integer oder Gleitkomma-`Infinity`:** verworfen,
   weil beides fachlich falsch ist; der erste Wert ist endlich, der zweite
   verletzt die Zustandsinvariante und ist nicht ledgerfähig.
4. **Odoo signiert und startet die Welt allein:** verworfen, weil Transport-HMAC
   und Release-Signatur verschiedene Aufgaben haben und Odoo keine fachliche
   Source of Truth ist.
5. **Nullstart durch ein unsichtbares Guthaben oder Gratis-Leasing retten:**
   verworfen, weil dies das Startpaket nur umbenennt. Spielbarkeit muss aus
   veröffentlichten, für alle geltenden Markt- und Finanzierungsregeln folgen.
