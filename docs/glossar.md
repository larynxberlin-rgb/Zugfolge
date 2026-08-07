# Domänenglossar

Die verbindliche Zuordnung zwischen deutschem Fachbegriff und Bezeichner im
Code. Ergebnis von **M0.2**.

**Warum es das gibt.** Die Spezifikation ist deutsch, der Code englisch. Ohne
festgelegte Zuordnung entstehen innerhalb weniger Wochen drei Namen für
dieselbe Sache — `Trasse`, `Slot` und `Path` — und danach weiß niemand mehr,
ob zwei Codestellen dasselbe meinen. Fachbegriffe des Eisenbahnbetriebs sind
keine Beschreibungen, sondern Definitionen: „Betriebsstelle" ist nicht
dasselbe wie „Bahnhof", und „Sperrzeit" ist nicht „Belegungszeit".

**Regeln.**

- Öffentliche Bezeichner sind englisch und stehen hier.
- Ein Bezeichner bedeutet genau eine Sache. Doppelbelegung ist ein Fehler.
- Wo es keinen tragfähigen englischen Begriff gibt, bleibt das deutsche Wort
  stehen — ein erfundenes Wort wäre schlechter als ein fremdes.
- Neue Einträge werden alphabetisch eingeordnet, umlautunabhängig sortiert.

Der Wächter `glossary` prüft Aufbau, Eindeutigkeit und Sortierung. Er kann
nicht prüfen, ob ein Eintrag stimmt — dafür steht die Quelle daneben.

---

| Begriff | Bezeichner | Bedeutung | Quelle |
|---------|------------|-----------|--------|
| Abstellgleis | `StablingTrack` | Gleis zum Abstellen nicht eingesetzter Fahrzeuge; Konfliktressource wie jedes andere Gleis | `betrieb.md` 4 |
| Ad-hoc-Trasse | `AdHocPath` | Trasse aus der Restkapazität einer laufenden Fahrplanperiode | `infrastruktur.md` 2 |
| Anlage | `Facility` | Werkstatt, Waschanlage, Tankstelle, Entsorgungs- oder Abstellanlage mit Kapazität, Öffnungszeit, Nutzlänge und Baureihenkompetenz | `betrieb.md` 4 |
| Annäherungsabschnitt | `ApproachSection` | Abschnitt vor einem Hauptsignal — der Vorsignalabstand; seine Durchfahrzeit gehört zur Sperrzeit des folgenden Abschnitts | `infrastruktur.md` 1 |
| Anschluss | `Connection` | geplanter Übergang von Fahrgästen zwischen zwei Zugfahrten | `betrieb.md` 1 |
| Aufgabenträger | `TransportAuthority` | simulierter Besteller im SPNV; schreibt aus, zahlt, sanktioniert — betreibt aber selbst keine Züge außer im Eigenbetrieb | `wirtschaft.md` 2 |
| Auskömmlichkeitsgrenze | `ViabilityThreshold` | vor Angebotsöffnung veröffentlichter Höchstwert; deterministisch aus dem `EconomyRelease` berechnet | `wirtschaft.md` 4 |
| Ausschreibung | `Tender` | Vergabeverfahren über ein Los, mit Leistungsbeschreibung, Frist, Wertung und Zuschlag | `wirtschaft.md` 3 |
| Bahnsteig | `Platform` | Fahrgastanlage an einem Gleis; Nutzlänge und Höhe begrenzen die zulässige Formation | `infrastruktur.md` 1 |
| Bahnstromsystem | `PowerSystem` | Spannung und Frequenz der Fahrstromversorgung; entscheidet, ob ein Triebfahrzeug den Strom nutzen kann | `betriebsgraph.md` 2 |
| Bandprofil | `BandProfile` | lückenlose, überschneidungsfreie Folge von Bändern eines Gleisattributs über die volle Gleislänge | `betriebsgraph.md` 1 |
| Baustelle | `PlannedWorks` | angekündigte Einschränkung mit Vorlauf, Planungsfenster und Ersatzkonzept | `betrieb.md` 6 |
| Belegungskonflikt | `OccupationConflict` | Überschneidung zweier Sperrzeiten auf derselben Konfliktressource; verletzt die harte Invariante 1 | `infrastruktur.md` 1 |
| Belegungsprofil | `OccupationProfile` | relative Belegung der Konfliktressourcen eines Laufwegs, unabhängig vom konkreten Verkehrstag | `infrastruktur.md` 5 |
| Bestellerentgelt | `OrderingFee` | Zahlung des Aufgabenträgers je Zugkilometer; der zentrale Hebel im Angebot | `wirtschaft.md` 3.5 |
| Betriebsgraph | `OperatingGraph` | das Netz als geprüftes Ganzes: Betriebsstellen, Kanten, Gleise und Bahnsteige mit ihren Attributen | `betriebsgraph.md` 2 |
| Betriebsprogramm | `OperatingProgram` | priorisierte Regelmenge eines EVU, die der Kern auch ohne den Spieler ausführt | `betrieb.md` 1 |
| Betriebsstelle | `OperatingPoint` | betrieblich benannter Punkt des Netzes — Bahnhof, Haltepunkt, Abzweigstelle, Überleitstelle | `infrastruktur.md` 1 |
| Betriebsübergang | `OperatorTransition` | Wechsel des Betreibers eines Verkehrsvertrags, ausschließlich zum Fahrplanstichtag | `wirtschaft.md` 3 |
| Bildfahrplan | `TimeDistanceDiagram` | Weg-Zeit-Darstellung der Zugfahrten; Träger der Sperrzeitentreppe | `milestones.md` M3.10 |
| Blockabschnitt | `BlockSection` | Streckenabschnitt, den zur selben Zeit nur ein Zug befahren darf | `infrastruktur.md` 1 |
| Durchrutschweg | `OverlapPath` | Weg hinter dem Zielsignal, der bei Bremsversagen frei bleiben muss | `infrastruktur.md` 1 |
| Eigenbetrieb | `PublicOperator` | Ausfallsicherung des Aufgabenträgers; fährt die Mindestbedienung, bewusst mittelmäßig, sichtbar gekennzeichnet | `wirtschaft.md` 4 |
| Einspruchsfenster | `ObjectionWindow` | Frist nach der Koordinierung, in der ein Trassenangebot beanstandet werden kann | `infrastruktur.md` 3 |
| Eisenbahnverkehrsunternehmen (EVU) | `Operator` | das Unternehmen eines Spielers; Träger von Fahrzeugen, Personal, Trassen und Verträgen | `wirtschaft.md` 5 |
| Elektrifizierung | `Electrification` | Bauart der Fahrstromversorgung — Oberleitung, Stromschiene oder keine — samt Bahnstromsystem; als Bandprofil je Gleis geführt | `betriebsgraph.md` 2 |
| Ersatzkonzept | `ReplacementPlan` | eigener kleiner Planungslauf gegen die Restkapazität einer Baustelle | `betrieb.md` 6 |
| Fahrplanperiode | `SchedulePeriod` | Saison aus Anmeldung, Koordinierung, Veröffentlichung und Betrieb; Länge ist Weltparameter, 3 bis 8 Wochen | `infrastruktur.md` 3 |
| Fahrplanstichtag | `ScheduleChangeDate` | Beginn einer Fahrplanperiode; einziger zulässiger Zeitpunkt für Betriebsübergänge und Releasewechsel | `infrastruktur.md` 3 |
| Fahrstraße | `InterlockingRoute` | gesicherter Fahrweg durch einen Bahnhofskopf, aus Weichenlage und Signalstandort abgeleitet | `infrastruktur.md` 1 |
| Fahrstraßenauflösezeit | `RouteReleaseTime` | letzter Anteil der Sperrzeit: das Auflösen des Fahrwegs, nachdem der Zug geräumt hat | `infrastruktur.md` 1 |
| Fahrstraßenbildezeit | `RouteSettingTime` | erster Anteil der Sperrzeit: Stellen und Festlegen des Fahrwegs, bevor das Signal Fahrt zeigen kann | `infrastruktur.md` 1 |
| Fahrzeugkonfiguration | `VehicleConfiguration` | Sitzaufteilung, Bestuhlung, Mehrzweckbereiche, Türen und Ausstattung eines Fahrzeugs | `betrieb.md` 3 |
| Formation | `Formation` | konkrete Zusammenstellung von Fahrzeugen für eine Zugfahrt | `betrieb.md` 2 |
| Gegenfahrt | `OpposingMove` | Belegungskonflikt zweier Zugfahrten entgegengesetzter Richtung auf demselben eingleisigen Abschnitt | `infrastruktur.md` 1 |
| Gleichstand | `Tie` | exakte Punktgleichheit im Planungslauf; wird über den veröffentlichten Seed aufgelöst | `infrastruktur.md` 2 |
| Gleis | `Track` | das, worauf gefahren wird; liegt auf einer Kante oder in einer Betriebsstelle und trägt Vmax, Neigung, Elektrifizierung und Zugsicherung | `betriebsgraph.md` 2 |
| Herkunft | `Provenance` | Quelle und Vertrauensgrad eines importierten Attributwertes; hängt am einzelnen Band, nicht am Gleis | `daten.md` 2 |
| Infrastruktur-Release | `InfraRelease` | unveränderliches, versioniertes Netzartefakt mit Herkunft, Lizenz, Prüfsumme und Confidence je Attribut | `architektur.md` 3 |
| Insolvenz | `Insolvency` | Stufe 5 der Eskalationsleiter; das EVU endet vollständig, der Account bleibt | `wirtschaft.md` 5 |
| Kante | `TrackEdge` | Verbindung zweier Betriebsstellen im Betriebsgraph; trägt die Gleise und die Kilometrierung, aber selbst keine Fahrt | `betriebsgraph.md` 2 |
| Konfliktressource | `ConflictResource` | alles, worum zwei Zugfahrten konkurrieren können — Block, Fahrstraße, Bahnsteig, Anlage | `infrastruktur.md` 1 |
| Längsneigung | `Gradient` | Steigung oder Gefälle eines Gleisabschnitts in Zehntel Promille, bezogen auf die Kilometrierung; kehrt sich in der Gegenrichtung um | `betriebsgraph.md` 4 |
| Laufweg | `Itinerary` | die Folge von Betriebsstellen und Kanten, die eine Zugfahrt befährt | `infrastruktur.md` 2 |
| Livemap | `LiveMap` | öffentliche Echtzeitkarte des Verkehrs; vollständig transparent nach E9 | `produkt.md` |
| Los | `Lot` | ausgeschriebenes Leistungspaket eines Aufgabenträgers | `wirtschaft.md` 3.3 |
| Mindestzugfolgezeit | `MinimumHeadway` | kleinster zeitlicher Abstand zweier Zugfahrten derselben Richtung; folgt aus den Sperrzeiten, ist kein eigener Parameter | `infrastruktur.md` 1 |
| Mobilisierungsphase | `MobilisationPhase` | Zeit zwischen Zuschlag und Betriebsaufnahme; nachweispflichtig auf Fahrzeuge, Personal und Trassen | `wirtschaft.md` 3 |
| Netzfahrplan | `NetworkTimetable` | das veröffentlichte Ergebnis eines Planungslaufs für eine Fahrplanperiode | `infrastruktur.md` 3 |
| Notvergabe | `EmergencyAward` | auf zwei Perioden befristete Übernahme durch den Eigenbetrieb nach gescheiterter Ausschreibung | `wirtschaft.md` 4 |
| Nutzlänge | `usable_length` | der Teil eines Gleises oder Bahnsteigs, auf dem Fahrzeuge stehen dürfen; begrenzt die zulässige Formation | `betriebsgraph.md` 2 |
| Planungslauf | `PlanningRun` | deterministische, gemeinsame Behandlung aller Trassenanträge eines Planungsfensters | `infrastruktur.md` 2 |
| Pönale | `Penalty` | vertragliche Sanktion für Qualitätsmängel; wirkt bis zum letzten Tag der Vertragslaufzeit | `wirtschaft.md` 3 |
| Präqualifikation | `Prequalification` | Eignungsnachweis eines Spielers aus seiner Betriebshistorie in dieser Welt | `wirtschaft.md` 5 |
| Quellenregister | `SourceRegister` | maschinenlesbares Verzeichnis aller Datenquellen mit Freigabestatus, Lizenz und Bereitstellungsweg; die geprüfte Wahrheit des Rechte-Gates | `rechte.md` 1 |
| Rahmenvertrag | `FrameworkAgreement` | mehrperiodige Kapazitätszusage, gedeckelt zum Schutz gegen Landgrab | `infrastruktur.md` 4 |
| Rangieren | `Shunting` | Fahrzeugbewegung ohne Zugfahrt; ausschließlich automatisiert, als Zeitbedarf und kurze Belegung verrechnet | `betrieb.md` 4 |
| Räumfahrzeit | `ClearingTime` | Anteil der Sperrzeit, in dem der Zug mit voller Länge den Abschnitt und den Durchrutschweg räumt | `infrastruktur.md` 1 |
| Rechte-Gate | `RightsGate` | Durchsetzung von Invariante 8: kein Import ohne dokumentierte Freigabe der Datenquelle | `rechte.md` 1 |
| Regionsübergabe | `RegionHandover` | Übergang einer Zugfahrt zwischen zwei regionalen Single-Writer-Prozessen, mit Bestätigung | `architektur.md` 3 |
| Schichtentrennung | `LayerSeparation` | Trennung von Code, Daten und Marke; die proprietären Schichten bleiben aus dem öffentlichen Repositorium | `rechteschutz.md` 3 |
| Schienenersatzverkehr | `RailReplacementService` | vertragliche Ersatzleistung bei Sperrung; Kostenposten und Bewertungsfaktor, kein eigener Fuhrpark | `betrieb.md` 6 |
| Signalsichtzeit | `SignalSightingTime` | Anteil der Sperrzeit zwischen dem Erkennen des Vorsignals und dem Vorsignal selbst | `infrastruktur.md` 1 |
| Simulationszeit | `SimTime` | Sekunden seit Weltepoche; expliziter Wert, niemals aus der Systemuhr gelesen | `architektur.md` 4 |
| Sperrzeit | `BlockingTime` | Zeitspanne, in der eine Konfliktressource für eine Zugfahrt gesperrt ist — Fahrstraßenbildung, Annäherung, Fahrzeit, Räumung, Auflösung | `infrastruktur.md` 1 |
| Sperrzeitentreppe | `BlockingTimeStaircase` | die treppenförmige Darstellung aufeinanderfolgender Sperrzeiten im Bildfahrplan | `milestones.md` M0.3 |
| Spurweite | `TrackGauge` | Abstand der Schienen in Millimetern; das Spielnetz führt ausschließlich Regelspur (E14), der Netzfilter braucht die Angabe zum Aussortieren | `betriebsgraph.md` 2 |
| Startpaket | `StarterPackage` | Anfangsausstattung eines neuen EVU in der öffentlichen Welt | `produkt.md` 3 |
| Störung | `Disruption` | ungeplantes Ereignis mit Wirkung auf den Betrieb; Entstehung und Fortpflanzung sind getrennt modelliert | `betrieb.md` 5 |
| Substream | `Substream` | benannter Teilstrom des Weltseeds; ein neuer Strom verändert die bestehenden nicht | `architektur.md` 4 |
| Tagesbericht | `DailyReport` | asynchrone Rückmeldung an den Spieler: was ist passiert, welche Regel hat wann was getan | `betrieb.md` 1 |
| Trasse | `TrainPath` | zugewiesenes Recht, einen Laufweg zu einer Zeitlage zu befahren | `infrastruktur.md` 2 |
| Trassenantrag | `PathRequest` | Antrag auf eine Trasse mit Zugcharakteristik, Verkehrstagen, Halten, Wunschzeiten und zulässigen Abweichungen | `infrastruktur.md` 2 |
| Umlauf | `VehicleRotation` | die Folge von Zugfahrten, die ein Fahrzeug oder eine Formation nacheinander leistet | `betrieb.md` 2 |
| Vergabekalender | `TenderCalendar` | beim Weltstart erzeugte, veröffentlichte Verteilung der Erstvergaben über die erste Welthälfte | `wirtschaft.md` 3.3 |
| Verkehrstage | `OperatingDays` | die Tage, an denen ein wiederkehrendes Verkehrsangebot tatsächlich fährt | `infrastruktur.md` 2 |
| Verkehrsvertrag | `ServiceContract` | Vertrag zwischen Aufgabenträger und EVU über ein Los, mit Entgelt, Bonus, Pönale und Nachweisen | `wirtschaft.md` 3 |
| Verspätung | `Delay` | Abweichung von der Soll-Zeitlage; propagiert regelbasiert über Anschlüsse und Umläufe | `infrastruktur.md` 5 |
| Vertrauensgrad | `Confidence` | wie belastbar ein Attributwert ist — erfasst, abgeleitet oder angenommen; Grundlage der Qualitätsklassen | `daten.md` 5 |
| Vmax-Band | `SpeedLimit` | die zulässigen Geschwindigkeiten eines Gleisabschnitts — Regel, Neigetechnik, Güterzug; als Band eines Bandprofils geführt | `betriebsgraph.md` 2 |
| Weiche | `Switch` | Fahrwegverzweigung; Konfliktressource, weil kreuzende Bewegungen sich ausschließen | `infrastruktur.md` 1 |
| Weltprofil | `WorldProfile` | die Parameter einer Welt: Laufzeit, Periodenlänge, Vertragslaufzeit, Ausschreibungsvorlauf | `wirtschaft.md` 3 |
| Weltseed | `WorldSeed` | Seed einer Welt für eine Fahrplanperiode; Grundlage aller benannten Substreams | `architektur.md` 4 |
| Wendezeit | `TurnaroundTime` | Mindestzeit zwischen Ankunft und Abfahrt derselben Formation am Endpunkt | `betrieb.md` 2 |
| Wirtschafts-Release | `EconomyRelease` | versioniertes, je Welt gepinntes Artefakt mit allen Entgelten und Kostensätzen | `wirtschaft.md` 1 |
| Zugcharakteristik | `TrainCharacteristics` | Masse, Länge, Vmax, Anfahr- und Bremsvermögen, Antriebsart, Zugsicherung — entkoppelt die Planung vom Fahrzeugkatalog | `infrastruktur.md` 2 |
| Zugfahrt | `TrainRun` | die einzelne, materialisierte Fahrt eines Zuges an einem Verkehrstag | `infrastruktur.md` 5 |
| Zugkilometer | `TrainKilometre` | Leistungseinheit der Verkehrsverträge und Bezugsgröße des Bestellerentgelts | `wirtschaft.md` 3.5 |
| Zugkreuzung | `TrainCrossing` | Begegnung zweier Zugfahrten entgegengesetzter Richtung auf eingleisiger Strecke; nur in einer Betriebsstelle mit Kreuzungsmöglichkeit zulässig | `infrastruktur.md` 1 |
| Zugsicherung | `TrainProtection` | streckenseitige und fahrzeugseitige Sicherungstechnik; begrenzt, welche Formation wo fahren darf | `infrastruktur.md` 1 |
| Zusatzfahrt | `SupplementaryRun` | Zuführungs-, Werkstatt-, Versorgungs- oder Abstellfahrt; ein echter Zug mit Trasse, Personal und Kosten | `betrieb.md` 4 |
| Zuschlag | `Award` | Entscheidung über eine Ausschreibung; fällt deterministisch sofort bei Fristende | `wirtschaft.md` 3.5 |
| Zustands-Hash | `StateHash` | kanonischer, plattformunabhängiger Hash eines Simulationszustands | `architektur.md` 4 |
