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
Feststellung. Nach [§187 BGB](https://www.gesetze-im-internet.de/bgb/__187.html)
zählt der Ereignistag nicht; [§188 BGB](https://www.gesetze-im-internet.de/bgb/__188.html)
bestimmt das Fristende. Der exklusive Grenzwert ist deshalb
`Tagesbeginn(Kontrolle) + (proofWindowDays + 1) * dayLengthMs`.
Maßgeblich ist der belegte Eingang des gültigen Nachweises,
nicht die spätere Verarbeitungszeit. Der gepinnte Nachweis reduziert eine
vorläufige Forderung auf den freigegebenen 7-Euro-Satz; nachweislich falsche
Unterlagen bewirken keine Reduzierung. Rechnung, Zahlung, Reduzierung,
Bearbeitungskosten und Abschreibung bleiben getrennte Ereignisse.
Die tatsächliche einmalige Reduzierung verursacht den ausdrücklich gepinnten
EVU-Aufwand `proofHandlingCostCents`. Er wird nicht dem Fahrgastbetrag
zugeschlagen und ist keine Sanktion für eine zulässige vorläufige Forderung.
Ein unbegründeter Anlageversuch wird vollständig zurückgewiesen.

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
Eine Rücknahme einer Abschreibung korrigiert ausschließlich den ursprünglichen
Abschreibungstag desselben Falls. Sie ist am späteren Nachweistag kein neuer
Zahlungseingang und erzeugt dort keine positive Prämiengrundlage.

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

`nextFareControlWakeup` bestimmt im Rust-Kern die nächste tatsächlich relevante
Nachweis-, Zahlungs- oder Abschreibungsgrenze. Ein 250-ms-Worker erzeugt keine
dauerhaften Zeitquittungen ohne fällige Wirkung. Polizeifortschritt liest weiter
den bestätigten betriebsseitigen Hold; Tageskorrekturen deduplizieren die
zugrunde liegenden tatsächlichen Journalbelege.

Der Plattformloader akzeptiert ausschließlich eine lokal und unabhängig
SHA-256-gepinnte `conductor-control-deployment/v1`-Datei mit Welt und Perioden.
Jede Periode benennt Gültigkeitsintervall, `economyReleaseHash`, vollständige
`inspectionPolicy`, `policeResponseModel` und exakt gebundene `journeys`.
Symlinks, mehr als 16 MiB, mehr als 256 Perioden, mehr als 100000 Teilreisebelege
je Periode, unsichere Zahlen und unbekannte Felder werden abgelehnt.
Die tatsächliche M6-Datenbankpinnung muss denselben EconomyRelease bestätigen.
Weder Clientzeit noch Browserpolicy kann diese Eingänge ersetzen.

`ConductorControlService` ist eine interne Grenze hinter dem bestehenden
Account-/Welt-/EVU-/Zugzugriff und dem exklusiven Weltwriter. `publicStatus`
liefert nur die native Whitelist eigener Zugfälle und tatsächlichen Holdstatus.
Private native Effektquittungen pinnen den resultierenden Fachzustand aus
Fällen, Polizeiplänen, Tagen und Journal; ihre Hashes bleiben bei späteren
Fortschreibungen unverändert. Lebenszyklusabschluss beendet ausschließlich
bereits bestehende ungebundene Fälle. Forderungen und Holds laufen nach
Sitzungsende über den Produktionsscheduler weiter.

## Abnahme

Gezielte native Tests prüfen gültige/nicht vorzeigbare/ungültige Fahrkarten,
echte und falsche Handyprobleme, Erwerbsausnahme und fehlende Fakten,
festgestellte/verweigerte/nicht feststellbare Identität, gebündelte Polizeifälle,
rechtzeitige und verspätete Nachweise, Zahlung/Teilzahlung/Ausfall, Korrektur,
negative Folgen, Tagesdeckel über mehrere Züge sowie Überläufe und identische
Replays. Die Plattformprobe nutzt echte M10-, Session-, Kontroll- und
Operational-Kerne mit dem bestehenden Ledger und Datenbankrestore; reine
Mock-Callbacks gelten nicht als positiver Fachnachweis.

Nachweisstand 2026-09-07:

- `cargo test -p zugfolge-fare-control --offline`: vierzehn native Fachtests;
  `cargo clippy -p zugfolge-fare-control --all-targets --offline -- -D warnings`
  ohne Warnungen. Enthalten sind auch unabhängige Mehrzug-Tagesdeckel,
  gebündelte erfolglose/nicht verfügbare/abgebrochene Polizeifälle, die
  Abschreibungskorrektur ohne neue Prämie und extreme zulässige Centwerte.
  Eine tatsächlich als ungültig geprüfte Fahrkarte führt zur regulären
  Forderung mit Zahlung/Replay. Beobachtete konkrete Gefahr erlaubt einen
  Polizeivorgang auch bei gültiger Fahrkarte; daraus entsteht keine EBE.
- `packages/economy/src/fare-revenue.test.ts`: tatsächlicher M6-Periodenproducer,
  persistente Outbox und bestehender Ledgeradapter. 10000 Cent Brutto und
  1700 Cent Pönale ergeben tatsächlich 8300 Cent Kasse; der gebundene
  Bruttobeleg wird erst nach bestätigter Journalbuchung freigegeben.
- `apps/game-api/src/conductor-control.native.integration.test.ts`: echte
  M5-/Operational-/M10-/Dialog-/Sitzungs-/Kontrollkerne mit PGlite,
  Forderung/Zahlung, Fremdzugriff, Restore, Replay und No-op-Worker. Eine
  absichtlich abgewiesene zweite echte Ledgerbuchung beweist die atomare
  Rücknahme der ersten Buchung und des Kontrollzustands; derselbe Befehl
  funktioniert nach Beseitigung der Teststörung ohne Doppelbuchung. Windows
  verwendet die unveränderten Adapter mit echten Rust-CLI-Prozessen;
  die native Linux-CI verwendet das NAPI-Addon. Vier zusätzliche reine
  Negativtests laufen auch ohne native Bibliothek.
- `conductor-control.native-fixture.ts` enthält ausschließlich fiktive
  Tarif-/Erwerbsbelege und temporäre Testidentitäten. Seine isolierte
  `inspectionCandidates`-Probe ist nur eine Node-seitige Auswahlhilfe für
  tatsächliche UI-Kontrollen, kein Nachweis einer ausgeführten Kontrolle.
  `advanceControl` delegiert an den produktiven Welt-Scheduler. Die
  zusammenhängende Browserfahrt wird separat in deren Abnahmebericht belegt.

Der native öffentliche Tagesbericht liefert ausschließlich `dayStartMs`,
`contractRevenueCents`, `netCents`, `premiumCents`, `capAdjustmentCents`,
`contributionCents` und `settlementRevision`, chronologisch sortiert. Der Kern
berechnet den Beitrag aus Netto plus Prämie minus Deckelkorrektur mit geprüfter
Ganzzahlarithmetik. Private Journal-IDs, Tarif-/Modellpins und Passagierfakten
verlassen die Projektion nicht. Tage gelten gemeinsam für das eigene EVU über
alle Züge; die Fallliste bleibt auf den angefragten Zug beschränkt. Die interne
Lesemethode `publicHistory(tx, {worldId, operatorId, trainRunId})` benötigt
keinen aktiven Fahrgastmanifest- oder Sitzungskontext. Ihre Aufrufer müssen
vorher den aktuellen Konto-, Welt-, EVU- und Zugzugriff autorisieren.

Der zusätzliche Pönalen-Nachweis verwendet einen ausdrücklich fiktiven Vertrag
für genau eine Tagesfahrt. Der vorhandene native `ServiceOutcomePolicy` bindet
die Kapazität aus dem tatsächlichen M5-Compilerergebnis; seine konkrete
`ServiceOutcomeBinding` erklärt die bestellten Sitze und ausdrücklich keine
vertraglichen Anschlüsse. Ein Lauf ohne Halt bildet die Vergleichsbasis zum
gleichen nativen Lauf mit Polizeihalt. Nur tatsächlich persistierte
`operations.train-outcome`-Ereignisse und daraus erzeugte Tagesberichte dürfen
die M6-Periodenabrechnung dieser expliziten Einfahrtenprobe speisen.

`conductor-control-penalty.native.integration.test.ts` belegt diesen Weg mit
einem fiktiven 50-Minuten-Fahrplan und einem tatsächlichen Zwischenhalt bis zur
gepinnten 60-Minuten-Höchstfrist: unveränderte Kilometer und Kapazität,
gegenüber dem Vergleichslauf gemessener Pünktlichkeitsverlust, genau ein
Regionsabschluss, 9000 Cent M6-Pünktlichkeitspönale und genau eine ausgeglichene
Ledgertransaktion nach Outbox-Retry. Die Probe erfindet keine Betriebskosten;
sie prüft ausdrücklich diesen abgegrenzten Vertrags- und Pönalenbestandteil.

Für den zusammenhängenden M15-Abnahmebrowser darf derselbe explizite
Einfahrtenvertrag bereits vor der nativen Betriebsinitialisierung gepinnt
werden. `conductor-acceptance.native-fixture.ts` besitzt ausschließlich
Testkonfiguration: ursprünglicher M10-Seed, unveränderter Dialogkorpus,
vollständige M5-Kapazität, Fahrt-/Tagesidentität und bereits vergebener
fiktiver M6-Vertrag. Eine tatsächliche Ressourcensperre vor dem Zwischenhalt
hält dessen Ist-Ankunft offen, bis die normalen Kontrollhandlungen beendet
sind. Vergleichs- und Kontrolllauf verwenden dieselbe Sperre und Freigabe;
nur der tatsächliche zusätzliche Polizeihalt unterscheidet sie.

Der nachgelagerte Testhelfer zur Abrechnung verlangt genau den nativen
Abschluss der vorher benannten Fahrt, den dazu erzeugten Tagesbericht und
den tatsächlichen M6-Zustand. Er ruft die bestehenden Abrechnungs-,
Persistenz-, Outbox- und Ledgerproduzenten auf. Er verändert keine
Fahrtfakten, Kosten oder allgemeinen Vollständigkeitsflags. Der zurückgegebene
Nachweis nennt Bruttoentgelt, konkrete Pönale, bestätigten Kassenunterschied
und den tatsächlichen Journalbezug; die private Kontrolltagesansicht wird
danach ausschließlich durch ihren regulären Scheduler aktualisiert.

Der fiktive Zuschlag verwendet das wirkliche M5-Fahrzeugkonzept und die
bestehende Gebotsprüfung. Sein Vertragsstart ist an die tatsächliche
Verfügbarkeit der Formation gebunden; `settlementReadyAtMs` nennt das Ende
der ersten 24-Stunden-Periode. Der Preis von 10000 Cent je tatsächlich
gefahrenem Kilometer ist eine explizite Testvertragsregel.
`nextAcceptanceWakeup()` liest ausschließlich restaurierte Operational- und
Kontrollzustände: Betriebskalender, Holdfrist, native Zahlungs-/Nachweisfrist
und die gespeicherte Antwortdauer ab tatsächlicher Holdaktivierung. Die
native Polizeiprüfung muss die Antwort am vorgeschlagenen Zeitpunkt zulassen.
Diese Node-Auswahlhilfe ist kein öffentlicher Zeit- oder Polizeipolicy-Eingang.

Der gemeinsame Netzkorpus verwendet ausdrücklich den globalen Testseed 167
vor den ersten Nachfragepins. Die frische Producer-Auswahl in
`outputs/M15-Sitzung/acceptance-network-candidates.json` bestätigt originale
Dialoge `admission-03` (ungültig, Identität bestätigt), `empty_phone-10`
(gültig, momentan nicht vorzeigbar, Identität bestätigt), `empty_phone-02`
(ungültig, Identität bestätigt) und einen gesonderten Polizeikandidaten
`defective_phone-09` (ungültig, Identität tatsächlich verweigert). Ebenso sind
unfreundliche, kooperativ alkoholisierte und verweigernde Originaldialoge
vorhanden. Diese private Node-Vorprüfung erzeugt keine Kontrollfälle und ist
noch kein zusammenhängender Browsernachweis. Der bestehende Sechsfall-HTTP-
Nachweis behält seinen eigenständigen Einzugkorpus mit Testseed 138.

Dies schließt die allgemeine Basisabhängigkeit #518
nicht: Der produktive Abschluss eines vollständigen Tagesplans samt
Kosten-/Vertrags-/Anschlussbelegen bleibt gesondert erforderlich. Der
Pönalen-Nachweis setzt weder `dayPlanComplete` noch `evidenceComplete` der
allgemeinen Tagesberichte auf wahr und gibt die dort gesperrte HTTP-Abrechnung
nicht frei. Fehlende Anschlussfakten werden niemals als ausgefallener Anschluss
erfunden; hier wird die tatsächliche Pünktlichkeitsfolge bewertet.
