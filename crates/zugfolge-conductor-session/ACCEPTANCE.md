# M15.12: reproduzierbarer Kernnachweis

Der Mess- und Gegenlauf konkretisiert docs/schaffnermodus.md §13 und
Issue #222. Er ersetzt weder Browser-/Touchabnahme noch Signaturen, CI oder
die Datenschutz-/Ledgerprüfung im tatsächlichen Plattformpfad.

Der größte vollständig vorhandene M5-Innenraumkorpus umfasst drei fiktive
70-m-Spielkonfigurationen; Typ 102 besitzt drei Doppelstockkästen, 200 Sitze,
20 Stehplätze und die vollständig reservierten Sonderflächen. Der Nachweis
verwendet alle 220 aus dem echten M10-Kern entstandenen Personen. Es gibt
keinen vollständig belegten längeren, begehbar gekuppelten Verband in diesem
Korpus. Das ist keine Freigabe einer global maximalen SPNV-Formation.

Der Mehrzug-Gegenlauf verwendet dieselbe native Strecke, Formation,
Fahrgastfahrpläne und FDL-Anfragen ohne beziehungsweise mit zusätzlichem
Kontrollhalt. Die 600.000 Millisekunden beginnen erst an tatsächlicher
Abfahrbereitschaft. Ein zweiter Personenzug wartet an denselben echten
Fahrstraßen-/Belegungsressourcen. Erst tatsächliche Zugschlussfreigaben und
reguläres Retirement öffnen diese Ressourcen. Jeder Bewegungsschritt prüft
die globale Invariante 1; ein Wiederherstellungslauf halbiert die Zeitschritte
und muss dieselben Ist-Haltquittungen und denselben Endhash ergeben.

M10 erhält anschließend ausschließlich die erzeugten Istquittungen und
effektiven Zugzeiten. Ein zunächst erreichbarer Anschluss wird verpasst,
während der bereits gefahrene Fahrgastpräfix unverändert bleibt. Ein späteres
veröffentlichtes Angebot übernimmt den künftigen Reiseteil. Dieses Angebot
bleibt ausdrücklich eine Prognose; der Nachweis erfindet keine tatsächliche
Abfahrt des Anschlusszugs.

acceptance_json ist ein lokaler JSONL-Messadapter. Sein Konfigurationsargument
ist 1, 2 oder 3. Aufträge: source, layout, demand, projection, start,
restore, network, quit. Der Host misst die Zeit zwischen Auftrag und
vollständiger Antwort; Rust liest keine Rechneruhr. Der Prozess wird vorher
kompiliert, die vollständige Quelle einmal aufgebaut und jede Messreihe
aufgewärmt. Gemessene Zeit umfasst den jeweiligen Kernaufruf und lokalen
JSONL-Transport, ohne Datenbank, HTTP, Grafik oder Netzwerk. Es werden keine
fehlenden produktionellen Budgets nachträglich als bestanden deklariert.

Reproduktion: cargo build --release -p zugfolge-conductor-session --example
acceptance_json; Kernprüfungen: cargo test -p zugfolge-conductor-session
--test acceptance sowie cargo test -p zugfolge-sim --test
operational_fare_control.

## Gemessener Stand vom 7. September 2026

Der Release-Lauf mit Rust 1.94.1 auf Windows x64 (acht logische Prozessoren)
misst 15 Antworten je Phase nach einer Aufwärmantwort. Die P95-Werte in
Millisekunden und die tatsächlichen sichtbaren Snapshotgrößen sind:

| Fiktiver M5-Typ | Personen | Layout | M10 | Fahrgastprojektion | Sitzungsstart | Restore | Snapshotbytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 101 | 160 | 7,574 | 8,829 | 5,062 | 20,349 | 3,419 | 60.135 |
| 102 | 220 | 9,237 | 14,362 | 5,982 | 20,747 | 5,715 | 81.903 |
| 103 | 144 | 6,264 | 8,770 | 4,557 | 14,948 | 3,266 | 54.539 |

Alle Wiederholungen ergeben je Konfiguration dieselben Fachhashes. Rohwerte,
Binärhash und Quellpins stehen in
[core-measurement-v1.json](evidence/core-measurement-v1.json).
[measure-acceptance.ps1](examples/measure-acceptance.ps1) erzeugt den Nachweis
mit `-Binary <Release-Binary> -OutputDirectory <Nachweisordner>` neu. Diese
einzelne lokale Messung ist keine Lastzusage für einen Produktionsserver.

Der reale Kontrollhalt verschiebt Führungszug und Folgezug jeweils um
600.000 Millisekunden. 20 M10-Reisende verpassen den zunächst erreichbaren
Anschluss und wählen das spätere Angebot; niemand bleibt in diesem Gegenlauf
gestrandet. Der tatsächliche Fahrgastpräfix bleibt einschließlich Plätze,
Identitäten und privater Fahrschein-Fakten unverändert. Alle erzeugten
Haltquittungen, Betriebsereignisse und Hashes stehen in
[network-consequence-v1.json](evidence/network-consequence-v1.json). Der
Regressionstest vergleicht den vollständigen Bericht mit diesem Golden-Beleg,
einschließlich Restoregleichheit und tatsächlicher Ressourcenereignisse.

Die Szenarien sind ausdrücklich synthetische Testdaten. Insbesondere ist der
Artpin im nativen Innenraumfixture ein als Test gekennzeichneter Platzhalter;
hieraus folgt keine Art-Releasefreigabe. Die signierte Art-/Dialogfreigabe und
der volle Datenbank-, Browser-, Touch-, Polizei- und Ledgerpfad müssen in den
separaten Plattformnachweisen bestehen. Der zweite Zug ist eine echte native
Fahrzeug-/Formationsmaterialisierung auf derselben Strecke; der Kapazitäts-
und Innenraumbeweis gehört den drei vom M5-Compiler erzeugten Konfigurationen.
[input-manifest-v1.json](evidence/input-manifest-v1.json) bindet deren
Eingabedateien, den vollständigen lokalen Rust-Abhängigkeitsbaum und den
Messadapter mit SHA-256 über UTF-8 mit LF. Die Messung wurde nach dem
Einpunkt-Bremsrest, der nativen Regionsübergabequittung, der Auswahl aller
drei M5-Konfigurationen und dem ursachenbelegten Wiederanlauf nach
Infrastruktursperren einschließlich beider Kontrollhalt-Freigabereihenfolgen
im Plattformfixture neu erzeugt;
die Betriebs- und M10-Golden-Hashes bleiben unverändert.
