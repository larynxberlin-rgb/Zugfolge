# Kontrollfälle, Polizeifeststellung und gedeckelte Forderungswirtschaft

Implementierungsvertrag M15.10 / #220 und M15.11 / #221, Version 1. Maßgeblich
sind [schaffnermodus.md](schaffnermodus.md), Abschnitte 8–10, und der bestehende
M6-EconomyRelease-/Ledgervertrag. Die aktuelle amtliche Fassung von
[§ 6 EVO](https://www.gesetze-im-internet.de/evo_2023/__6.html) wurde am
2026-09-06 geprüft: doppelte belegte gewöhnliche Fahrtkosten, mindestens 60 Euro;
7 Euro bei rechtzeitigem Nachweis einer bereits zur Kontrolle gültigen Fahrkarte;
eigenständige Erwerbsausnahme bei fehlendem beziehungsweise nicht verfügbarem
Schalter und Automaten. Der Spielvertrag beschränkt sich auf belegte Teilreisen.

## Autoritative Eingänge und verborgene Fakten

Die neue Rust-Crate `zugfolge-fare-control` verarbeitet explizite Weltzeit,
Kommandos und verifizierte Belege ohne I/O. `FareInspectionCaseV1` pinnt bei
Eröffnung Welt, EVU, Zuglauf, Begegnung, Fahrgast, tatsächliche M10-Teilreise,
Manifestrevision/-hash, M10-FareFact, Dialogrelease, Kontrollbeginn, Tarif- und
Erwerbsbeleg, Prüfmodell und vollständigen EconomyRelease. Fehlen notwendige
Tarif-/Erwerbsfakten, bleibt der Fall ohne Forderung. Neue Perioden ersetzen
keinen bereits gepinnten Fallbeleg.

`FareJourneyEvidenceV1` belegt die gewöhnlichen Fahrtkosten genau der
vorliegenden Zugteilreise und die tatsächliche Erwerbslage am Einstiegshalt.
Erwerbsausnahme ist `proven`, wenn sowohl Schalter als auch Automat nach dem
gepinnten Quellenbeleg nicht verfügbar waren; `excluded`, wenn wenigstens eine
dieser Möglichkeiten verfügbar war; andernfalls `unknown`. Eine Dialogäußerung,
ein Kaufversuch oder eine fehlende private Zahlungsmöglichkeit setzt diese
Erwerbsfakten nicht. Die Plattform lädt Belege ausschließlich aus unabhängig
hashgepinnten Deploymentdaten und gleicht sie mit dem echten M10-Manifest ab.

`FareInspectionPolicyV1` definiert ein hashgepinntes lokales Prüfmodell für
Vorzeigbarkeit, synthetische Identitätsreaktion und konkrete Gefahr. Die Auswahl
nutzt den benannten Teilstrom `fare_inspection` mit Welt/Zug/Fahrgast/Seed, ohne
geschützte Merkmale. Ein akzeptierter Dokumentprüfschritt protokolliert erst
die beobachtete Antwort. Vorher zeigen Text und Autorenprofil keine
Identitätsverweigerung oder Gefahr als bewiesene Tatsachen an. Ein nicht
vorzeigbares Dokument wird nicht durch bloßes Nachfragen als ungültig entlarvt:
gültiges Handyproblem und falsche Ausrede können dieselbe zunächst vorläufige
Feststellung ergeben. Erst ein echter präsentierter beziehungsweise später
eingegangener Dokumentnachweis wird gegen den gepinnten M10-Sachverhalt geprüft.

Es werden keine wirklichen Namen, Adressen, Ausweis- oder Bankdaten gespeichert.
Öffentlich erscheinen nur bereits erhobene Hinweise, Fallstatus und zulässige
nächste Schritte. Vollständige Fallsammlung, Ticketwahrheit, Zahlungsmodell und
künftige Ausgänge bleiben privat. Fehler und normale Telemetrie verwenden feste
Kennungen ohne Dialogtexte oder Fahrgastschlüssel.

## Forderung und Nachweise

Status: `open`, `closed_without_claim`, `claim_open`, `settled`. Eine reguläre
Forderung verlangt verifiziert ungültigen Fahrausweis; eine vorläufige verlangt
fehlende Vorzeigbarkeit. Beide benötigen festgestellte synthetische Identität,
belegten Tarif und ausgeschlossene Erwerbsausnahme. Eine fehlende Feststellung
macht keine Forderung werthaltig. Ungerechtfertigte Forderungen werden nicht
als sicherer Erlös behandelt und können Korrektur-/Bearbeitungskosten auslösen.

Der erste Anspruch ist `max(minimumClaimCents, ordinaryFareCents * multiplier)`.
Die betreffenden Werte liegen ausdrücklich im vorhandenen `EconomyRelease` als
optionales versioniertes `fareInspection`-Modul. Der bestehende kanonische
M6-Checksum umfasst das gesamte Modul; ohne Modul bleibt der alte Releasebyte-
und Hashvertrag erhalten, Schaffnerforderungen werden jedoch nicht aktiviert.
Die Rust-Validierung begrenzt die gesetzlichen beziehungsweise vertraglichen
Maximalregeln; kein Runtime-Default ergänzt fehlende Felder.

Die Nachweisfrist basiert auf expliziter Welttagslänge und Tagesbeginn der
Feststellung. Maßgeblich ist der belegte Eingang des gültigen Nachweises,
nicht die spätere Verarbeitungszeit. Der gepinnte Nachweis reduziert eine
vorläufige Forderung auf den freigegebenen 7-Euro-Satz; nachweislich falsche
Unterlagen bewirken keine Reduzierung. Rechnung, Zahlung, Reduzierung,
Bearbeitungskosten und Abschreibung bleiben getrennte Ereignisse.

## Polizei und Betrieb

M15.9 besitzt den einzigen tatsächlichen `FareControlHoldV1` im bestehenden
Operational-Kern. Der Kontrollfall liefert nur geeignete Fallkennungen mit
beobachteter Identitätsverweigerung oder konkreter Gefahr. Eine Anforderung
bezieht sich auf den nächsten tatsächlich noch nicht erreichten planmäßigen
Fahrgasthalt. Der Betrieb pinnt Zuständigkeit, Modell, einmaliges Zuglaufbudget,
Aktivierung nach normaler Abfahrbereitschaft und Höchstwartezeit.

`police_response` bestimmt aus einem gepinnten lokalen Modell Verfügbarkeit,
Reaktionsdauer und synthetisches Feststellungsergebnis. Zu spät, nicht verfügbar,
abgebrochener Zielhalt und gescheiterte Feststellung erzeugen keine bestätigte
Identität. Nur der tatsächliche gebundene betriebliche Abschlussbeleg darf
gebündelte Fälle fortschreiben. Sitzungsschluss kann den Betriebshalt nicht
aufheben. Öffentliche Ursache bleibt ausschließlich „behördliche Maßnahme“;
interne Feinursache ist `authority.police.fare-control`.

## Ledger und gemeinsamer Tagesdeckel

Der private `FareControlWorldStateV1` aggregiert alle Fälle eines EVU über
Zugläufe und Sitzungen hinweg. Die Plattform speichert ihn unter
`conductor_control_states(world_id, operator_id)` und schreibt ihn unter dem
bestehenden Weltwriter sowie dem M6-EVU-Cashwriter fort. Native Zustandshashes,
Revisionen und Kommandoreceipts werden mit Ledgertransaktionen gemeinsam
committed; doppelte Anforderungen erzeugen keine zweite Buchung.

Das bestehende unveränderliche M2-Ledger erhält getrennte ausgeglichene
Transaktionen für offene Forderung, Zahlung, Reduzierung, Kosten, Abschreibung,
Prämie und Deckelausgleich. Alle Geldwerte sind geprüfte `i64`-Centbeträge; an
der JSON-Grenze stehen sie als kanonische Dezimalstrings. Es entsteht weder
ein zweiter Zahlungsdienst noch eine parallele EVU-Kasse.

Für einen expliziten Welttag gilt `netto = Zahlungen - Bearbeitungskosten -
Abschreibungen`, `Prämie <= 4 * max(0, netto)` und `Deckel =
floor(max(0, belegte SPNV-Vertragserlöse) * 50 / 10000)`. Die Bezugsgröße kommt
aus echten M6-Abrechnungsbelegen desselben Welt-/EVU-/Tages vor Kontrollfolgen.
Fehlen diese Belege, wird kein positiver Tagesbeitrag freigegeben. Negative
Kosten und betriebliche Pönalen bleiben vollständig wirksam. Der getrennte
Deckelausgleich begrenzt den positiven Kontrollbeitrag, ohne Kosten zu erstatten.
Spätere Korrekturen sind zusätzliche ausgeglichene Buchungen; ältere Belege
werden niemals überschrieben.

Die vorhandene M6-Abrechnung liefert Periodenbelege. Das optionale Modul pinnt
deshalb ausdrücklich `revenueAllocation = uniform_settled_service_interval/v1`:
Erst nach tatsächlicher Periodenabrechnung wird das belegte Bruttoentgelt vor
Pönalen gleichmäßig auf das zugehörige Leistungsintervall abgegrenzt. Der
Tagesanteil ist die Differenz zweier ganzzahliger kumulierter Anteile an den
Intervallgrenzen. So entspricht die Summe aller Tage exakt dem tatsächlichen
Abrechnungsbetrag; es entstehen keine Rundungsgewinne. Bereits abgerechnete
Bonusse zählen, ein wegen Leistungsausfall nicht verdienter Bonus wird nicht
hinzuerfunden. Ohne abgewickelten M6-Journalbeleg plus tatsächlicher zugehöriger
Ledgertransaktion bleibt die Grundlage null. Die spätere Periodenabrechnung
kann ältere Tagesabschlüsse durch zusätzliche Korrekturbuchungen freigeben.
Diese Abgrenzung ist eine explizite Spielabrechnungsregel, keine Prognose aus
Nachfrage oder geplanten Kilometern.

## Abnahme

Gezielte native Tests prüfen gültige/nicht vorzeigbare/ungültige Fahrkarten,
echte und falsche Handyprobleme, Erwerbsausnahme und fehlende Fakten,
festgestellte/verweigerte/nicht feststellbare Identität, gebündelte Polizeifälle,
rechtzeitige und verspätete Nachweise, Zahlung/Teilzahlung/Ausfall, Korrektur,
negative Folgen, Tagesdeckel über mehrere Züge sowie Überläufe und identische
Replays. Die Plattformprobe nutzt echte M10-, Session-, Kontroll- und
Operational-Kerne mit dem bestehenden Ledger und Datenbankrestore; reine
Mock-Callbacks gelten nicht als positiver Fachnachweis.
