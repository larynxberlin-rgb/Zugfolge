# ADR-0028: Tutorialstart und öffentlicher Markteintritt sind getrennte Weltverträge

- **Status:** Angenommen — bindend (entspricht E28)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../produkt.md](../produkt.md) · [../wirtschaft.md](../wirtschaft.md) · [../architektur.md](../architektur.md)
- **Betrifft Milestones:** M9.1, M9.3
- **Verwandte ADRs:** [ADR-0002](0002-betriebsprogramm-als-kern-loop.md), [ADR-0005](0005-rust-kern-typescript-plattform.md), [ADR-0019](0019-realismus-dient-dem-spiel.md), [ADR-0023](0023-odoo-als-administrativer-kontrollpunkt.md)

## Kontext

Der geführte Einstieg muss Ausschreibung, Fahrzeugleasing, Trassenwahl,
Betriebsprogramm und Disposition in wenigen Minuten erfahrbar machen. Eine
öffentliche persistente Welt kann dafür weder beschleunigt noch zurückgesetzt
werden. Eine gemeinsam genutzte statische Tutorialwelt würde Spielerzustände
vermischen; ein vorab vollzogenes Startpaket würde genau die Lernhandlungen
vorwegnehmen, die das Tutorial nachweisen soll.

Der öffentliche Markteintritt hat ein anderes Ziel: Er beginnt im Wettbewerb
ohne automatisch zugeteilten Vertrag, Fahrzeug, Trasse, Personal oder aktives
Betriebsprogramm. Sein Startkapital ist eine Eigenschaft des signierten
Weltentwurfs und keine Tutorialausstattung. Odoo bleibt für diese öffentliche
Freigabe der administrative Kontrollpunkt, darf aber keine kurzlebigen
Tutorialversuche verwalten oder projiziert bekommen.

## Entscheidung

**Jeder Tutorialstart erzeugt aus einem unveränderlichen, versionierten und
gehashten Minimaltemplate eine eigene, genau einem Spieler gehörende,
beschleunigte, ungewertete und kurzlebige Welt; öffentlicher Markteintritt und
Tutorialstart bleiben vollständig getrennte Weltverträge.**

Die Tutorialwelt besitzt ausschließlich vorbereitetes Szenario-Inventar: ein
neues EVU, Präqualifikation, endliches Integer-Cent-Kapital, einen kleinen
Personalpool sowie offene Ausschreibung, Leasingangebote, Trassenalternativen,
Betriebsprogrammvorlagen und eine deterministische spätere Störung. Fahrzeug,
Trasse und Betriebsprogramm werden erst durch die autoritativ belegten
Spielerhandlungen wirksam. Die Domänen verwenden ihre regulären Writer,
Ledger, Events und Zustandsübergänge; es gibt keine Tutorial-Sonderwirtschaft.

Ein Browser-Reload setzt dieselbe aktive Sitzung fort. Ein Neustart archiviert
die bisherige Welt und erzeugt eine neue UUID samt nicht vorhersagbarer
`tut_`-Sitzungsreferenz. Abschluss, Schonfrist, maximale Dauer oder Idle-TTL
führen über einen expliziten Lifecycle zur automatischen Schließung. Nach
`closing` werden Kommandos abgelehnt. Erhalten bleiben die minimalen
Auditmetadaten, Telemetrie und der finale Zustandshash. Die Keine-Wipes-Regel
gilt weiterhin uneingeschränkt für öffentliche persistente Welten; diese
kurzlebigen, privaten Tutorialwelten sind die ausdrücklich abgegrenzte
Ausnahme.

Tutorialwelten erzeugen weder Odoo-Weltprojektionen noch Weltstartanträge,
Startkapitalkonfigurationen oder Tutorialereignisse in der Odoo-Outbox. Das
Game ist allein autoritativ. Öffentliche Welten erhalten kein Startpaket. Ihr
Geldstart folgt ausschließlich der signierten `StartingCapitalPolicy` mit
endlichen nichtnegativen Integer-Cent, `0` oder dem expliziten nichtnumerischen
Modus `unlimited` (`∞`). Diese Policy wird separat implementiert und nicht im
Tutorialpfad nachgebaut.

Der feste, versionierte Dialogkatalog führt den fiktiven Infrastrukturmitarbeiter
Lutz als Tutorialbegleiter. Es gibt keine generative Laufzeit-KI und keinen
Bezug zu realen Unternehmen. M9.1 bleibt offen, bis ein externer Browserlauf
gegen eine neu erzeugte Instanz und die reale 90-Prozent-unter-15-Minuten-
Messung vorliegen.

## Begründung

Die isolierte Welt macht Beschleunigung, deterministische Ereignisse, Neustart
und automatische Bereinigung möglich, ohne öffentliche Wettbewerbszustände zu
verändern. Das unveränderliche Template hält Lernpfad und Beweis reproduzierbar;
die regulären Domänenpfade verhindern eine zweite fachliche Wahrheit. Eine
weltgebundene Zuordnung zum öffentlichen Konto und genau eine aktive Sitzung
begrenzen Missbrauch und verhindern globale Identitätssuchen.

Die Odoo-Ausnahme ist keine Aufweichung von E23: Ein persönlicher Tutoriallauf
ist weder menschliche Game-Administration noch eine freizugebende öffentliche
Welt. Seine Projektion würde hochkardinale, kurzlebige Betriebsdaten ohne
kaufmännischen Zweck erzeugen. Aggregierte Game-Telemetrie genügt für Produkt-
und Betriebsbeobachtung.

## Konsequenzen

- **Erleichtert:** reproduzierbares Lernen, echte fachliche Nachweise,
  Spielerisolation, Reload/Restart und ehrliche Echtzeit-Telemetrie.
- **Kostet / schränkt ein:** Factory, Sitzungs-Lifecycle, Rate Limit, Reaper,
  finale Hashbildung und Bereinigungsbetrieb müssen eigenständig zuverlässig
  bleiben; externe Zeitabnahme kann nicht durch automatisierte Tests ersetzt
  werden.
- **Invarianten:** Jede persistierte Zeile und jedes Event bleibt UUID-
  weltgebunden; Geld bleibt Integer-Cent; Simulation erhält explizite Zeit und
  keinen Datenbankzugriff. Kein externer Dienst liegt im heißen Pfad.
- **Odoo:** keine Tutorialwelt, kein Versuch, kein Event und keine
  Startkapital-Policy einer Tutorialinstanz werden projiziert.
- **Milestones:** M9.1 liefert den geführten Ablauf, bleibt aber bis zum externen
  Browser- und Zeitnachweis `in Arbeit`; M9.3 integriert später ausschließlich
  die tatsächliche öffentliche `StartingCapitalPolicy`.

## Verworfene Alternativen

1. **Statische gemeinsame Tutorialwelt:** verworfen wegen fehlender Isolation,
   Reset-Rennen und wachsender Altzustände.
2. **Vollständig vollzogenes Startpaket:** verworfen, weil es Fahrzeug-,
   Trassen- und Betriebsprogrammkapitel vorab erfüllt.
3. **Tutorial-Sonderbuchhaltung oder Mock-Domänen:** verworfen, weil daraus kein
   belastbarer Nachweis für den späteren Spielbetrieb entsteht.
4. **Odoo-Projektion pro Versuch:** verworfen, weil sie keinen administrativen
   Zweck erfüllt und kurzlebige hochkardinale Daten erzeugt.
