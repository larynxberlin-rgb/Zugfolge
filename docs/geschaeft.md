# Plattform, Geschäft und Recht

## 1. Odoo Community

Odoo Community läuft selbst gehostet und vollständig getrennt vom Spiel.

**Odoo verwaltet:** Kontakte und Rechnungsempfänger; Produkte, Zahlungen und
Erstattungen; Support, CRM und Helpdesk; freiwillige Abonnements und
Kosmetikprodukte; read-only Projektionen von Spielern und Welten; auditierte
administrative Befehle.

**Das Game-System verwaltet:** Loginberechtigungen und Spielerstatus; Welten,
EVUs, Fahrzeuge und Verträge; Fahrpläne, Trassen und Simulation; Wirtschaft,
Credits und Entitlements; operative Historie und Auditlog.

**Integration:** Game-Outbox → Odoo-Bridge → Odoo; Odoo-Webhook → signierter
Receiver → Queue → Game-Command/Entitlement-API; ein nächtlicher Reconciler
erkennt verlorene oder doppelte Nachrichten.

- Odoo schreibt **niemals** direkt in Game-Tabellen.
- Odoo-Ausfälle beeinträchtigen weder Login, Simulation, Livemap noch bestehende
  Entitlements.
- OCA-Module werden versionsgepinnt und geprüft.
- Ein minimales eigenes Add-on kapselt Webhooks und Adminbefehle.
- Es entsteht keine Abhängigkeit von einer extern nicht verfügbaren
  Enterprise-/Custom-API.

## 2. Monetarisierung ohne Pay-to-win

**Kostenlos:** vollständiger Zugang zu SPFV, SGV und SPNV; ein EVU in einer
gleichzeitig aktiven öffentlichen Welt; alle entscheidungsrelevanten Daten,
Solver, Exporte, Warnungen und Automationen; gleiche Trassen-, Gebots-, Markt-
und Berechnungsregeln; keine Werbung in der Betriebsoberfläche.

**Zugfolge Plus**, Startpreis 7,99 € monatlich beziehungsweise 79 € jährlich:

- bis zu drei gleichzeitig aktive Weltplätze, aber niemals mehrere eigene EVU in
  derselben Welt;
- zusätzliche rein visuelle Dashboard-Anordnungen und Kartenstile;
- erweiterte Firmenprofile, Lackierungen, Logos und kosmetische Marker;
- filmische Replay- und Präsentationsexporte derselben Daten;
- zusätzliche externe Zustellkanäle für zeitgleich auch kostenlos verfügbare
  Meldungen;
- automatisch formatierte PDF-Geschäftsberichte;
- bevorzugter Helpdesk ohne Bevorzugung spielinterner Vorgänge.

**Weitere Erlöse:** direkt kaufbare Kosmetikpakete für 2,99–12,99 €; private,
ungewertete Welten ab 19,99 € monatlich für den Host; Gründer- und
Supporterpakete mit kosmetischem Abzeichen, Soundtrack und Namensnennung.

**Nie:** Lootboxen, Echtgeld-Spielwährung, Energie, Wartezeitverkürzung,
handelbare Premiumobjekte.

## 3. Monetarisierungsgrenze (E13)

**Der Automatikmodus bleibt in öffentlichen Welten kostenlos.**

> **Der prüfbare Test:** Bezahlung darf beeinflussen, **wie angenehm** eine
> Entscheidung getroffen wird — niemals, **welche** Entscheidung möglich ist oder
> **wie gut** sie ausfällt.

Sammelbearbeitung, gespeicherte Fensteranordnungen und Exporte bestehen diesen
Test. Ein besserer Solver, größerer Automatikumfang oder tiefere
entscheidungsrelevante Daten bestehen ihn nicht.

**Warum die Automatik nicht darunterfallen darf.** Sie ist keine Bequemlichkeit,
sondern der Boden, auf dem Kurzzeitspieler überhaupt stehen. Wird sie
kostenpflichtig, bleibt einem freien Spieler nur die Handplanung — derselbe
Betrieb bei einem Vielfachen an Zeitaufwand. In einer persistenten
Wettbewerbswelt ist Zeit eine Wettbewerbsressource; das wäre nicht
pay-for-convenience, sondern **pay-to-win über den Umweg Zeit**.

**Das geschäftliche Gegenargument wiegt schwerer als das moralische.** Die
Automatikstufe bedient den Spieler mit der geringsten Zeit und der niedrigsten
Zahlungsbereitschaft. Sie zu verkaufen heißt, das schwächste Segment zu
monetarisieren und gleichzeitig den Einstiegstrichter zu verengen, durch den
alle späteren Abonnenten kommen müssen. Der zahlungsbereite Spieler ist der
Detailverliebte — und der nutzt die Automatik am wenigsten.

| Angebot | Warum unbedenklich |
|---------|--------------------|
| Planungsarbeitsplatz: mehrere Bildfahrplanfenster, gespeicherte Layouts, Vergleichsansichten, Mehrmonitorbetrieb | reine Darstellung, identisches Ergebnis |
| Sammelbearbeitung und Vorlagenverwaltung für die Handplanung | spart Klicks, nicht Erkenntnis |
| Exporte: Bildfahrplan, Umlauf- und Dienstpläne, Geschäftsberichte, Replay-Filme | Präsentation derselben Daten |
| Archiv- und Auswertungstiefe jenseits des entscheidungsrelevanten Zeitraums | der für Backtesting nötige Zeitraum bleibt vollständig frei |
| Zusätzliche Weltplätze, Kosmetik, Lackierungen, Zustellkanäle | Bestandsmodell |
| Erweiterte Automatisierung in privaten, ungewerteten Welten | kein Wettbewerb, also keine Fairnessfrage |

**Verworfene Alternative:** kostenlose Automatik in Standardgüte plus eine
bezahlte *zweite Meinung* — ein Vorschlagsdienst, der Alternativen aufzeigt, die
der Spieler selbst umsetzen muss. Verworfen, weil auch ein Hinweis eine
entscheidungsrelevante Information ist und der Test damit gerissen wäre.

**Durchsetzung.** Die Trennlinie ist keine Selbstverpflichtung, sondern eine
Struktureigenschaft: Planner, Nachfrage, Wirtschaft, Trassenvergabe und
Live-Disposition erhalten technisch **kein Payment-Tier-Feld**. Ein CI-Wächter
prüft das ab M0.2, damit der Fehler nicht möglich ist statt nur unerwünscht.

## 4. Lizenz (E16)

**Zielkonflikt.** Die Open Source Definition verlangt ausdrücklich, dass
abgeleitete Werke erlaubt sind und dass niemand nach Einsatzzweck ausgeschlossen
wird. Eine Lizenz, die eigene Projekte auf Basis von Zugfolge verbietet — auch
abgewandelt — ist damit **nicht Open Source**, so offen das Repository auch sein
mag. Der zutreffende Begriff lautet **Source Available**. Diese Bezeichnung wird
konsequent verwendet; ein Projekt, das sich Open Source nennt und es nicht ist,
zieht verlässlich öffentliche Kritik auf sich.

**PolyForm Shield 1.0.0** erlaubt alles — ansehen, nutzen, ändern, weitergeben,
beitragen — außer Produkten, die mit der Software oder mit Produkten des
Lizenzgebers konkurrieren. Drei passende Eigenschaften:

- Konkurrenz zählt **auch, wenn sie kostenlos angeboten wird**;
- sie zählt **über Plattformen und Schnittstellen hinweg**;
- sie schützt **die Produkte des Lizenzgebers**, nicht nur den Code. Das ist der
  Unterschied zur verwandten PolyForm Perimeter, die zu schwach wäre.

Praktisch: GitHubs Lizenz-Assistent bietet nur eine kuratierte, überwiegend
OSI-approbierte Liste. Die `LICENSE`-Datei wird von Hand angelegt. Dass GitHubs
Auto-Erkennung sie eventuell nicht identifiziert, ist kosmetisch — rechtlich
gilt die Datei, nicht das Abzeichen.

**Schichten getrennt behandeln** — hier liegt der eigentliche Kopierschutz:

| Schicht | Behandlung |
|---------|------------|
| Quellcode | PolyForm Shield 1.0.0 |
| Marke „Zugfolge“, Logo, Wortbildmarke | Markenrecht, alle Rechte vorbehalten, nie mitlizenziert |
| `EconomyRelease`, Fahrzeugkatalog, Balancing | proprietär, nicht im öffentlichen Repository |
| Weltdaten und Betriebshistorie | proprietär, nie öffentlich |
| OSM-abgeleitete Daten | ODbL — **nicht durch die Projektlizenz überschreibbar** |

Eine Eisenbahnsimulation ohne Infrastruktur-Release, ohne Balancing und ohne
Marke ist kein Produkt, sondern ein Motor ohne Fahrzeug. Diese Trennung schützt
zuverlässiger als jeder Lizenztext.

**Contributor License Agreement ab dem ersten Tag.** Ohne CLA behalten
Beitragende das Urheberrecht an ihrem Code. Dann ist weder Relizenzierung noch
kommerzielle Lizenzvergabe noch eine spätere Lizenzänderung möglich — „es bleibt
meins“ wäre schon nach dem ersten fremden Pull Request nicht mehr wahr.

**ODbL sticht die Projektlizenz.** Ist der `InfraRelease` eine abgeleitete
Datenbank im Sinne der ODbL, greifen deren Share-alike-Pflichten unabhängig vom
Lizenztext.

**Abhängigkeitsprüfung.** Copyleft-Bibliotheken im Abhängigkeitsbaum können eine
proprietäre Weitergabe unmöglich machen. Rust und Node sind überwiegend
MIT/Apache-2.0, das Risiko ist gering — aber ein Lizenz-Scan in CI ab M0.2 macht
aus „vermutlich in Ordnung“ ein geprüftes Ergebnis.

> Begründete technische Einschätzung, keine Rechtsberatung. CLA,
> ODbL-Abgrenzung und Markenanmeldung gehören vor Veröffentlichung anwaltlich
> geprüft.

## 5. Marken und Fahrzeugnamen (E6)

| Kategorie | Behandlung |
|-----------|------------|
| Baureihennummern, technische Daten, Achsfolgen, Leistungswerte | **real übernehmen** — sachliche Angaben, keine geschützten Zeichen |
| Herstellerproduktnamen | **ersetzen** durch eigene Typbezeichnungen |
| EVU-Marken und Zuggattungsmarken | **ersetzen** — eigene, generische Systematik |
| Lackierungen und Logos | **eigener Editor**, mit Filter gegen den 1:1-Nachbau geschützter Zeichen |

Der Fahrzeugkatalog trägt zwei Ebenen: eine **technische**, die real und prüfbar
ist und in Fahrdynamik, Kompatibilität und Wirtschaft einfließt, und eine
**benennende**, die vollständig eigen ist. Nur die technische Ebene ist
spielmechanisch relevant — die Umbenennung kostet keinen Realismus.

Praktische Folge für M5.1: getrennte Felder für Baureihenbezeichnung und
Handelsname von Beginn an. Ein nachträgliches Auseinanderziehen wäre teuer.
