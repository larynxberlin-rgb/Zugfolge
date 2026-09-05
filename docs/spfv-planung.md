# Fernverkehrsplanung — Plattformvertrag v1

Schema: `zugfolge-spfv-preview/v1`. M10.4 verwendet die gemeinsame Nachfrage
aus [Wirtschaft](wirtschaft.md) und die vorhandene Rust-Trassenautorität.
Eine Nachfrageprognose ist keine Trassenzuteilung und kein Betriebsnachweis.

## Eingaben und fachliche Grenzen

Eine Linie enthält Name, geordnete eindeutige Halte, Formation, Takt,
Fahrpreis sowie ein halboffenes Zeitfenster `[validFromS, validUntilS)`.
Die optionale `referenceTrainId` bezeichnet eine im aktiven Fahrplan belegte
Referenzfahrt aus dem gepinnten Nachfragekorpus. Neu beantragte oder bestätigte
Spielerangebote sind keine Referenzquelle. Ohne explizite Kennung wählen
Vorschau und bestätigte Projektion dieselbe passende Fahrt in aufsteigender
Kennungsreihenfolge. Der Fahrpreis ist ein Betrag in Cent **je
befahrenem Abschnitt zwischen zwei gewählten Halten**. Er wird als Dezimaltext
übertragen; der Browser liefert keine Zugnummer, Physik, Kapazität oder Erlöse.

Versionierte Eingabegrenzen:

- Zwei bis 64 verschiedene Halte in Laufwegreihenfolge eines freigegebenen
  Korridors; keine Lücken oder mehrdeutigen Kantenbindungen.
- Takt zwischen 60 und 86.400 ganzzahligen Sekunden; höchstens 256 gewünschte
  Abfahrten pro Vorschau. Die erste Abfahrt liegt nach der Simulationszeit.
- Alle beantragten Abfahrten liegen innerhalb einer Fahrplanperiode. Eine
  später endende Fahrt bleibt im bisherigen Nachfragepool bis zu ihrem
  wirksamen Ende erhalten. Alle Zeiten sind Sekunden seit der Weltepoche;
  Journalzeitstempel addieren diese Epoche.
- Geld ist nichtnegativer Centtext bis 1.000.000.000 Cent je Abschnitt;
  dieser Bereich entspricht dem ganzzahligen Nachfragevertrag.
- Zwischenhalte werden mit mindestens 60 Sekunden Aufenthalt beantragt.
  Der echte Planner prüft die Betriebsfähigkeit und kann den Antrag ablehnen.

Die Formation stammt aus dem letzten atomaren M5-Checkpoint. Die native
Revalidierung bindet Welt, Revision, Zustandszeit, Authority-Hash, Zustands-Hash
und Mobilisierungssnapshot. Halterbindung, Lieferstatus und Verfügbarkeit
müssen das ganze Eingabefenster decken. Erstklassplätze stammen aus den
tatsächlichen Assets; Kapazität und Kostensatz aus der gebundenen Projektion.

## Vorschau und Anzeige

Die API liefert `source` als `forecast`, `observed` oder `assumption`.
Der ausführliche Herkunftsbeleg steht getrennt in `provenance`. Ein
`balanced`-Korpus erscheint als Annahme. Fehlende Referenz- oder Nachfragedaten
bleiben `null` und verhindern die Bestätigung.

`requestedPassengers` bezeichnet die relevante Korridornachfrage,
`servedPassengers` die Reisenden auf der vorgeschlagenen Linie und
`unservedPassengers` die danach unbediente relevante Nachfrage. Die Differenz
kann Bestandszüge oder andere Verkehrsmittel benutzen. Kosten und Erlöse sind
Prognosen; sie erzeugen keine Ledgerbuchung.

Vorschau-ID und Inhalt sind kanonisch gehasht und im weltgebundenen Journal
gespeichert. Die Vorschau gilt höchstens 300 Simulationssekunden und höchstens
bis zur Sekunde vor der ersten gewünschten Abfahrt. Die Vorschau vergibt
keine Zugnummer und erzeugt keinen Trassenantrag.

Bei Linienänderungen enthält die Vorschau neben internen
`replacementTrainIds` auch `replacementTrips`: belegte Zugnummer,
Abfahrtssekunde und Stationsnamen der zu ersetzenden Fahrten. Die Fakten
stammen aus eigenen verarbeiteten Anträgen und den nativen Reservierungen;
höchstens 256 Fahrten gehören in eine gemeinsame Änderung. Der Vorschauhash
bindet auch diese Angaben. Die Bestätigung verlangt bei unveränderten
Kennungen erneut dieselben Zeiten, Nummern und Stationsangaben. Die
Spieleransicht zeigt lesbare Zugnummern, Weltzeiten und Strecken sowie die
geprüften `capacityFacts`; der frühere Katalog ersetzt diese Fakten nicht.

Eine über die Karten-URL ausgewählte Fahrt bleibt Navigationskontext und
wird nicht als ungeprüfte Modellreferenz in einen neuen Entwurf übernommen.
Eine gespeicherte Linie kann ihre gepinnte Referenz weiterverwenden; sonst
wählt der Server sie aus dem freigegebenen Korpus.

## Bestätigung, Wiederholung und Persistenz

Unter dem Weltmutex werden Eigentümer, Weltstatus, Frist, Vorschauhash,
aktueller Flottenstand, Infrastruktur und Nachfrage-/Kostenprognose erneut
geprüft. Erst dann vervollständigt
`resolveAuthoritativePlanningPathRequest` die Anträge. Die Queue verwendet
`queuePlanningPathRequest`; es gibt keine zweite Physik- oder Zugnummernquelle.

Alle Anträge, Nummernreservierungen, der Koordinationsbatch, `spfv.submitted` und der bereits
verarbeitete `spfv.confirm`-Wiederholungsbeleg bilden eine Transaktion.
Ein später Fehler rollt auch vorherige Anträge und Nummern zurück. Gleiche
Kommandokennung mit abweichender Vorschau ist ein Konflikt. Eine bereits
bestätigte Vorschau erzeugt auch nach Neustart oder Fristablauf keine zweite
Antragsserie. Öffentliche Event-Ingests dürfen diese Belege nicht herstellen.

## Nachgewiesener Umfang und offene Betriebsgrenze

Die Verhaltenstests prüfen Welt-/Kontogrenzen, Integer- und Batchgrenzen,
fehlende Nachfrage, unveränderte Wiederholung, Frist-/Kostenkonflikte und
atomaren Rollback nach einem fehlgeschlagenen zweiten Queue-Write.

Der optionale `serviceWindow` in Planning-v4 und im Rust-ServicePattern bindet
eine Fahrt an absolute Gültigkeit. SPFV beantragt jede Abfahrt als
`[departureS, departureS + 1)` mit Null Verschiebungstoleranz. Hash,
Verkehrstageprüfung und Materialisierung berücksichtigen dieses Fenster;
ältere Zustände ohne Zusatzfeld behalten ihr Serialisierungsformat.

`planning.coordinate/v2` koordiniert 1 bis 256 Anträge gemeinsam, auch desselben
Kontos. Der Worker reicht ausschließlich den letzten atomar bestätigten
nativen Zustand als `previousState` ein. Rust bindet Infrastruktur und Revision,
restauriert bestehende sechphasige Sperrzeiten und prüft neue Fahrten dagegen.
Legacy-v1 behält seinen Vertrag mit genau zwei verschiedenen Konten.
Moderne Bestandsreservierungen bleiben auch bei einer v1-Folgekoordination
erhalten. Ein verzögert verarbeiteter Batch prüft Neu- und Ersatzabfahrten gegen
die aus Weltepoche und expliziter Verarbeitungszeit abgeleitete Weltzeit.
Fachliche Ersatzkonflikte beenden die Queuearbeit dauerhaft; technische Fehler
werden dadurch nicht als Fachkonflikt maskiert.

Linienänderungen erzeugen neue Antragskennungen. Die API löst ausschließlich
eigene verarbeitete Fahrten dieser Linie ab dem neuen Gültigkeitsbeginn auf.
Rust akzeptiert `replaceTrainIds` nur für gespeicherte, begrenzte und noch nicht
begonnene Fahrten nach `effectiveFromS`. Sobald eine Ersatzfahrt nicht gewährt
werden kann, wird die gesamte Ersetzung verworfen; bestehende Rechte bleiben
erhalten. Historische Belege und schon begonnene Fahrten werden nicht geändert.
Die Nachfragevorschau entfernt genau denselben gehashten Satz abzulösender
Fahrten vor der Gegenrechnung. Eine Preisänderung wird somit nicht als
zusätzliches konkurrierendes Alt- und Neuangebot prognostiziert.

`submitted` bedeutet weiterhin eingereicht. Erst verarbeitete Koordinierung
und echte native Reservierungen mit `passengerStops` werden in die nächste
Nachfrageprognose übernommen. Deren Haltezeiten stammen aus dem bestätigten
Fahrprofil, Preise und Plätze aus der gehashten Vorschau. Bloß eingereichte,
abgelehnte oder abgelöste Fahrten erhöhen das Angebot nicht. Referenzkomfort
und Zuverlässigkeit bleiben ausdrücklich Prognoseannahmen.

Die Übernahme dieser Planung in das produktive Betriebsprogramm, vollständige
Fahrzeugumläufe und Abrechnungsanbindung bleiben eigene Betriebsaufgaben
(#517/#518). Native Fahrtabschlussbelege existieren bereits; für #210 fehlen
dagegen signierte Zwischenhaltbindungen, native Haltquittungen und ihr
persistenter Nachfrageconsumer. Das ist keine Produktionsfreigabe oder
Fahrgelderlösbuchung; siehe [M10-Abnahmebericht](m10-abnahme.md).

Vorschau und Bestätigung lesen den Nachfragecheckpoint über dieselbe
Datenbanktransaktion, die den Weltmutex hält. Die native Verifikation dieses
Lesezugriffs verwendet keinen transaktionsübergreifenden Cache. Dadurch
bleiben Flotte, Nachfrage und Vorschau zusammen gebunden; auch eine einzelne
Datenbankverbindung wartet nicht auf eine zweite Abfrage außerhalb ihrer
eigenen Transaktion.
