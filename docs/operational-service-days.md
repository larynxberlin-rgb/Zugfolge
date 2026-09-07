# Vollständige native Tagespläne und Tagesabschlüsse

Der additive Vertrag `zugfolge-operational-service-day-policy/v1` ergänzt
die Einzelbelege aus `operational-service-outcomes-v1.json`. Ohne diesen
optionalen Startvertrag bleiben alte Initialisierungen und Zustandshashes
unverändert. Eine Liste bereits gestarteter Fahrten beweist keinen Tagesplan.

## Tagesmenge und Abschluss

Die signierte Policy enthält den Epochen-Betriebstag, den festen vorhandenen
24-Stunden-Wiederholungstakt und **jede** Basis-Personenfahrt der bestehenden
ServiceOutcome-Allowlist. Jede Vorlage bindet physische Zuglaufkennung,
Betreiber, ersten möglichen Tagesindex, Abfahrt und den vollständigen
ServiceOutcome-Vertrag. Der erste Tagesindex bildet den bereits vorhandenen
tagesübergreifenden Umlauf ab; er entfernt keine später bestellte Fahrt.

`open-service-day` öffnet einen Tagesindex aus dieser Policy. Der Kern
instanziiert die gesamte Menge selbst; das Kommando akzeptiert weder eine
Fahrtliste noch Vollständigkeitsflags. Vorab eingereihte Fortsetzungen öffnen
ihren gebundenen Tag ebenfalls, einschließlich der dazwischenliegenden Tage.
Eine Materialisierung muss der erwarteten Instanz genau entsprechen.
Fehlende oder andere Betreiber-, Los-, Zeit-, Kapazitäts- und
Anschlussbindungen werden abgelehnt. Ein gepinnter ursprünglicher Betreiber
ist kein Beleg für eine spätere Vergabe; dafür ist eine gesonderte Bindung an
den tatsächlichen OperatingTransition- und Fleet-Zustand erforderlich.

`service-day-planned` enthält die erwarteten Tagesinstanzen gruppiert nach
Betreiber und Los. Der Kern erzeugt `service-day-closed` genau einmal, sobald
die Tageszeitgrenze erreicht ist und **alle** erwarteten Instanzen einen
tatsächlichen terminalen Fahrtabschluss besitzen. Eine verspätete Fahrt hält
ihren ursprünglichen Tag offen. Fehlende Materialisierung, SafeStop und bloßer
Haltplanabbruch werden nicht zu einem erfundenen Ausfall. Ohne eigenen
terminalen Ausfallbeleg bleibt der Tag dann offen. Der offene Zustand wird
restauriert; abgeschlossene Tageslisten werden entfernt, die monotone
Öffnungsgrenze verhindert Wiedereröffnung. Ein begrenztes Fenster offener
Tage verhindert unbegrenzte Zustandsvergrößerung bei dauerhaft fehlenden
Belegen. Ein Regionswechsel ohne vollständigen Tagesbelegtransfer kann den
Quelltag nicht schließen und ist damit kein pauschaler Vollständigkeitsbeweis.

## Vorhandene Kostenbasis und Buchungsgrenze

M5 bindet `operatingCostCentsPerTrainKm` an die Fahrzeugtypen des
EconomyRelease und summiert ihn über die tatsächlichen Fahrzeuge. Das
bestehende M6-Settlement bucht den zugesagten Wet-Lease-Satz bereits separat
als `vehicle`. Die neue native Quittung berechnet deshalb ausschließlich den
kategorisierten Nachweis `formation-operating-cost` aus tatsächlichen
Millimetern und den gepinnten Fahrzeugkostensätzen. Formationswechsel teilen
die tatsächlich gefahrene Strecke auf die jeweils eingesetzten Fahrzeuge
auf. Ganzzahlige Cent entstehen erst nach Summierung der ungerundeten
Millimeter-mal-Cent-Beträge; keine Fließkommazahl und keine geplante Strecke
ersetzt den Messwert. Fehlende Kostensätze bleiben ausdrücklich unbekannt.

Diese Quittung wird **nicht** zusätzlich nach `settlements.costCents`
übernommen: Sonst würde M6 dieselbe Fahrzeugkostenbasis zweimal buchen.
Der aktuelle Wirtschaftsvertrag führt Trasse, Station, Personal, Energie,
Anlagen und fixe Periodenkosten getrennt. Der Fahrzeugkostensatz wird daher
nicht nachträglich als unbelegter All-inclusive-Vertrag ausgelegt. Eine
vollständige Kostenrechnung darf vorhandene autoritative pauschale
Mengen-mal-Satz-Regeln nutzen; reale Verbrauchsmessungen werden hier nicht
als zusätzliche Anforderung eingeführt.

## Bericht und reguläre Abrechnung

Die Plattform übernimmt die nativen Plan-, Abschluss- und Kostenquittungen
atomar im vorhandenen Regionsjournal. Der Tagesprojektor vergleicht die
erwartete Menge mit Original-Einzelabschlüssen und dem nativen Day-Close.
`dayPlanComplete` kann dadurch wahr werden; fehlende Kosten- oder aktuelle
Vertragsbindung lässt die übergeordnete `evidenceComplete` weiterhin falsch.
Die reguläre HTTP-Vertragsabrechnung behält ihre bestehenden Gates. Ein
Transporttest oder eine direkte Fixtureabrechnung darf diese nicht ersetzen.

Die versionierte ausführbare Regeldatei steht in
`crates/zugfolge-sim/specifications/operational-service-days-v1.json`.
