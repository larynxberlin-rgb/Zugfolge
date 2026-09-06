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
