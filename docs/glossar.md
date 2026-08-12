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
| Abdeckungsmessung | `CoverageReport` | Bericht je Attribut und Streckenabschnitt, wie viel Länge welchen Vertrauensgrad trägt und welche Qualitätsklasse ein Abschnitt datenseitig höchstens erreichen kann | `betriebsgraph.md` 9 |
| Abstellgleis | `StablingTrack` | Gleis zum Abstellen nicht eingesetzter Fahrzeuge; Konfliktressource wie jedes andere Gleis | `betrieb.md` 4 |
| Abweichungsreport | `DeviationReport` | stellt je Referenzlauf die aus dem Release berechnete Fahrzeit der realen gegenüber und prüft sie gegen die Toleranz | `betriebsgraph.md` 18 |
| Ad-hoc-Trasse | `AdHocPath` | Trasse aus der Restkapazität einer laufenden Fahrplanperiode | `infrastruktur.md` 12 |
| Administrationsantrag | `AdminCommandPayload` | typisierter, begründeter und korrelierter Antrag aus Odoo; das Game prüft und auditiert ihn erneut, bevor irgendeine Wirkung entsteht | `adr/0023-odoo-als-administrativer-kontrollpunkt.md` |
| Alpha-Feedbackprojektion | `AlphaFeedbackProjectionPort` | atomare, bereits pseudonymisierte Outbox-Grenze vom autoritativen Game-Feedback zur bearbeitbaren Odoo-Triage; enthält kein Keycloak-Subject | `alpha-betrieb.md` |
| Anlage | `Facility` | Werkstatt, Behandlungs- oder Waschanlage, Tankstelle, Entsorgungsanlage oder als Anlage geführtes Abstellgleis mit Kapazität, Öffnungszeit, Nutzlänge und Baureihenkompetenz | `betrieb.md` 4 |
| Anlagenkataster | `FacilityCatalog` | geprüfte Sammlung aller Anlagen einer Welt, gegen den Betriebsgraphen validiert — welches Gleis, welche Kapazität, welche Baureihenkompetenz | `betriebsgraph.md` 14 |
| Annäherungsabschnitt | `ApproachSection` | Abschnitt vor einem Hauptsignal — der Vorsignalabstand; seine Durchfahrzeit gehört zur Sperrzeit des folgenden Abschnitts | `infrastruktur.md` 1 |
| Anschluss | `Connection` | geplanter Übergang von Fahrgästen zwischen zwei Zugfahrten | `betrieb.md` 1 |
| Antriebsart | `TractionType` | Diesel, Akku oder elektrisch unter einem oder mehreren Bahnstromsystemen; entscheidet, welche Elektrifizierung ein Zug nutzen kann | `betriebsgraph.md` 15 |
| Aufbewahrungsfrist | `RetentionPeriod` | wie lange eine Datenkategorie nach ihrem Bezugsereignis aufbewahrt wird; `null` heißt unbefristet | `weltgeruest.md` 10 |
| Aufgabenträger | `TransportAuthority` | simulierter Besteller im SPNV; schreibt aus, zahlt, sanktioniert — betreibt aber selbst keine Züge außer im Eigenbetrieb | `wirtschaft.md` 2 |
| Auskömmlichkeitsgrenze | `ViabilityThreshold` | vor Angebotsöffnung veröffentlichter Höchstwert; deterministisch aus dem `EconomyRelease` berechnet | `wirtschaft.md` 4 |
| Auskunft (Datenschutz) | `PersonalDataExport` | vollständiges, maschinenlesbares Bündel aller Personendaten, die das Spielsystem über ein Konto in einer Welt führt | `weltgeruest.md` 10 |
| Ausschlussmenge | `exclusion_set` | Menge der Fahrstraßen, die nicht gleichzeitig mit einer gegebenen gestellt werden dürfen, weil sie ein Fahrwegelement oder eine Weiche teilen | `infrastruktur.md` 1 |
| Ausschreibung | `Tender` | Vergabeverfahren über ein Los, mit Leistungsbeschreibung, Frist, Wertung und Zuschlag | `wirtschaft.md` 3 |
| Außenlauf | `ExternalLeg` | Teil einer Fahrtkette außerhalb des freigegebenen Netzes, ohne erfundene Topologie und ohne Spieler-Disposition; bindet Fahrzeuge und Dienste bis Rückkehr oder Außenende | `infrastruktur.md` 10.4 |
| Bahnhofskategorie | `StationCategory` | Einstufung einer Betriebsstelle mit Fahrgastwechsel nach Größe und Ausstattungsniveau, Kategorie 1 bis 7; künftige Bemessungsgrundlage des Stationsentgelts | `betriebsgraph.md` 13 |
| Bahnhofskopf | `StationHead` | der Weichenbereich einer Betriebsstelle; aus Weichenlage und Signalstandort werden hier Fahrstraßen und Durchrutschwege abgeleitet | `betriebsgraph.md` 12 |
| Bahnhofstafel | `StationBoard` | weltzeitgebundene öffentliche Projektion geplanter und erwarteter Ankünfte/Abfahrten; die fallblattartige Ansicht ist nur ihre Darstellung | `adr/0026-karte-als-spielzentrum.md` |
| Bahnsteig | `Platform` | Fahrgastanlage an einem Gleis; Nutzlänge und Höhe begrenzen die zulässige Formation | `infrastruktur.md` 1 |
| Bahnstromsystem | `PowerSystem` | Spannung und Frequenz der Fahrstromversorgung; entscheidet, ob ein Triebfahrzeug den Strom nutzen kann | `betriebsgraph.md` 2 |
| Bandprofil | `BandProfile` | lückenlose, überschneidungsfreie Folge von Bändern eines Gleisattributs über die volle Gleislänge | `betriebsgraph.md` 1 |
| Baureihenkompetenz | `FleetCompetence` | Menge der Baureihen, die eine Anlage behandeln kann | `betrieb.md` 4 |
| Baustelle | `PlannedWorks` | angekündigte Einschränkung mit Vorlauf, Planungsfenster und Ersatzkonzept | `betrieb.md` 6 |
| Belegungsbuch | `OccupationLedger` | nach Konfliktressource gruppierte Sammlung aller Sperrzeiten einer Welt; nimmt über `try_insert` nur konfliktfreie Fahrten auf und hält Invariante 1 dadurch durch Konstruktion | `infrastruktur.md` 8 |
| Belegungskonflikt | `OccupationConflict` | Überschneidung zweier Sperrzeiten auf derselben Konfliktressource; verletzt die harte Invariante 1 | `infrastruktur.md` 1 |
| Belegungsprofil | `OccupationProfile` | relative Belegung der Konfliktressourcen eines Laufwegs, unabhängig vom konkreten Verkehrstag | `infrastruktur.md` 5 |
| Beschleunigungsvermögen | `Acceleration` | Anfahr- oder Bremsvermögen eines Zuges, in Millimetern je Sekunde zum Quadrat; ein vorzeichenloser Fähigkeitswert, den die Fahrdynamik richtungsabhängig einsetzt | `betriebsgraph.md` 15 |
| Bestellerentgelt | `OrderingFee` | Zahlung des Aufgabenträgers je Zugkilometer; der zentrale Hebel im Angebot | `wirtschaft.md` 3.5 |
| Betriebsentscheidung | `DecisionExplanation` | vollständiger Auditdatensatz einer automatischen oder manuellen Dispositionsentscheidung mit Regel, Bedingungen, Grenzen, Alternativen, Ursache und Auswirkungen | `betriebsprogramm.md` 2 |
| Betriebsgraph | `OperatingGraph` | das Netz als geprüftes Ganzes: Betriebsstellen, Kanten, Gleise und Bahnsteige mit ihren Attributen | `betriebsgraph.md` 2 |
| Betriebshalt | `operational_stop` | vom Planner eingelegter Halt ohne Fahrgastwechsel, in einer kreuzungsfähigen Betriebsstelle; seine Dauer wird aus dem Prüfbericht errechnet, nicht geraten | `infrastruktur.md` 9 |
| Betriebsmetrik | `AlphaOperationsMetrics` | begrenzt beschriftete Prometheus-Sicht auf den bereits materialisierten Alpha-Monitoringsnapshot mit Datenalter, Queue, Bridge und Markt; liest beim Scrape keinen Fachzustand | `alpha-betrieb.md` |
| Betriebsprogramm | `OperatingProgram` | priorisierte Regelmenge eines EVU, die der Kern auch ohne den Spieler ausführt | `betrieb.md` 1 |
| Betriebsprojektion | `OperationsProjection` | je EVU gefilterte Sicht auf Dispositionsentscheidungen, Ausfälle, manuelle Eingriffe und Großereignisse aus dem Event-Log | `betriebsprogramm.md` 4 |
| Betriebsstelle | `OperatingPoint` | betrieblich benannter Punkt des Netzes — Bahnhof, Haltepunkt, Abzweigstelle, Überleitstelle | `infrastruktur.md` 1 |
| Betriebsübergang | `OperatorTransition` | Wechsel des Betreibers eines Verkehrsvertrags, ausschließlich zum Fahrplanstichtag | `wirtschaft.md` 3 |
| Bildfahrplan | `TimeDistanceDiagram` | Weg-Zeit-Darstellung der Zugfahrten; Träger der Sperrzeitentreppe | `milestones.md` M3.10 |
| Blockableitung | `derive_block_sections` | Verfahren, das ein Gleis aus Signalpositionen, Zugbeeinflussung und Topologie in seine Blockabschnitte zerlegt — mit virtuellen Blöcken bei Lücken und reinen LZB-/ETCS-Blöcken bei durchgehender Überwachung | `betriebsgraph.md` 11 |
| Blockabschnitt | `BlockSection` | Streckenabschnitt, den zur selben Zeit nur ein Zug befahren darf | `infrastruktur.md` 1 |
| Bremsprobe | `BrakeTest` | vereinfachte oder vollständige Prüfung der Zugbremse nach Bildung oder Änderung eines Zugverbandes | `betrieb.md` 3 |
| Datenminimierung | — | Entwurfsregel, kein eigener Programmpfad: nur erheben und aufbewahren, was das Spielsystem tatsächlich braucht | `weltgeruest.md` 10 |
| Durchrutschweg | `OverlapPath` | Weg hinter dem Zielsignal, der bei Bremsversagen frei bleiben muss | `infrastruktur.md` 1 |
| Eigenbetrieb | `PublicOperator` | Ausfallsicherung des Aufgabenträgers; fährt die Mindestbedienung, bewusst mittelmäßig, sichtbar gekennzeichnet | `wirtschaft.md` 4 |
| Einspruchsfenster | `ObjectionWindow` | Frist nach der Koordinierung, in der ein Trassenangebot beanstandet werden kann | `infrastruktur.md` 10 |
| Eisenbahnverkehrsunternehmen (EVU) | `Operator` | das Unternehmen eines Spielers; Träger von Fahrzeugen, Personal, Trassen und Verträgen | `wirtschaft.md` 5, `weltgeruest.md` 7 |
| Elektrifizierung | `Electrification` | Bauart der Fahrstromversorgung — Oberleitung, Stromschiene oder keine — samt Bahnstromsystem; als Bandprofil je Gleis geführt | `betriebsgraph.md` 2 |
| Entitlement | `EntitlementRecord` | revisionssicherer Game-Zustand für Laufzeit und Umfang eines kaufmännisch ausgelösten Produkts; enthält keine Spielwerte oder Plannerrechte | `odoo-betrieb.md` |
| Ersatzkonzept | `ReplacementPlan` | eigener kleiner Planungslauf gegen die Restkapazität einer Baustelle | `betrieb.md` 6 |
| Event-Log | `DomainEvent` | append-only Eintrag im Ereignisprotokoll einer Welt (`domain_events`); Wahrheit des Betriebsverlaufs, Träger von Replay und Audit | `architektur.md` 2 |
| Exakte Zugkartenposition | `PublicMapPosition` | releasegebundene Kartenlage mit bestätigter Ressource, `trackId`, gleisscharfem ganzzahligem Offset und daraus abgeleiteter E7-Koordinate; bleibt die einzige betriebliche Positionswahrheit | `zugkartenprojektion.md`, `adr/0027-geschaetzte-zugkartenposition-nur-visuell.md` |
| Fahrgastinformationsanzeige | `PassengerInformationDisplay` | öffentliche, zuggebundene Projektion von Ziel, nächstem Halt, Folgehalten, Verspätung und Meldungen; Grundlage des generischen FIS-Monitors | `adr/0026-karte-als-spielzentrum.md` |
| Fahrplanperiode | `SchedulePeriod` | Saison aus Anmeldung, Koordinierung, Veröffentlichung und Betrieb; Länge ist Weltparameter, 3 bis 8 Wochen | `infrastruktur.md` 11 |
| Fahrplanstichtag | `ScheduleChangeDate` | Beginn einer Fahrplanperiode; einziger zulässiger Zeitpunkt für Betriebsübergänge und Releasewechsel | `infrastruktur.md` 3 |
| Fahrstraße | `InterlockingRoute` | gesicherter Fahrweg durch einen Bahnhofskopf, aus Weichenlage und Signalstandort abgeleitet | `infrastruktur.md` 1 |
| Fahrstraßenableitung | `derive_interlocking_routes` | Verfahren, das aus Weichenlage und Signalstandort die Fahrstraßen, Durchrutschwege und Ausschlussmengen eines Bahnhofskopfs erzeugt | `betriebsgraph.md` 12 |
| Fahrstraßenauflösezeit | `RouteReleaseTime` | letzter Anteil der Sperrzeit: das Auflösen des Fahrwegs, nachdem der Zug geräumt hat | `infrastruktur.md` 1 |
| Fahrstraßenausschluss | `RouteExclusion` | Belegungskonflikt zweier Fahrstraßen desselben Bahnhofskopfs, die sich ein Fahrwegelement oder eine Weiche teilen | `infrastruktur.md` 8 |
| Fahrstraßenbildezeit | `RouteSettingTime` | erster Anteil der Sperrzeit: Stellen und Festlegen des Fahrwegs, bevor das Signal Fahrt zeigen kann | `infrastruktur.md` 1 |
| Fahrweg | `RunPath` | lückenlose Folge von Segmenten mit Länge, zulässiger Geschwindigkeit und Neigung, aus der die Fahrdynamik eine Fahrzeit rechnet — anders als der `Laufweg` bereits auf konstante Werte geschnitten | `betriebsgraph.md` 16 |
| Fahrzeitrechner | `derive_running_time_table` | Verfahren, das über einen Fahrweg und eine Zugcharakteristik eine ganzzahlige Fahrzeittabelle rechnet — der einzige Ort mit Gleitkommarechnung in der Infra-Release-Pipeline | `betriebsgraph.md` 16 |
| Fahrzeittabelle | `RunningTimeTable` | vorberechnete, ganzzahlige Folge von Fahrzeiten und erreichten Geschwindigkeiten an den Segmentgrenzen eines Fahrwegs | `betriebsgraph.md` 16 |
| Fahrzeugasset | `VehicleAsset` | konkretes, weltgebundenes und persistentes Einzelfahrzeug mit Typ, Bau- und Beschaffungsjahr, Eigentum oder Leasing, Zulassungen, Wartungsfristen, Ist-Zugsicherung, Zustandsprofil und Lebenslauf | `betrieb.md` 2.1 |
| Fahrzeugepoche | `VehicleEra` | Weltfilter für zulässige Bau- oder Beschaffungsjahre; beide Epochen sind unabhängig und können alle Jahre umfassen | `betrieb.md` 2.1 |
| Fahrzeugkatalog-Release | `VehicleCatalogRelease` | unveränderlicher, versionierter Typkatalog mit faktischer Baureihenbezeichnung, fiktivem Handelsnamen, Bauzeit, Marktfenstern, typgenauer Zugsicherung, Quellen und Prüfsumme | `betrieb.md` 2.1 |
| Fahrzeugkonfiguration | `VehicleConfiguration` | Sitzaufteilung, Bestuhlung, Mehrzweckbereiche, Türen und Ausstattung eines Fahrzeugs | `betrieb.md` 3 |
| Fahrzeuglebenslauf | `VehicleLifeEvent` | unveränderliche, zeitlich geordnete Historie eines konkreten Fahrzeugs: Welteintritt, Halter/Nutzer, Leasing, Wartung, Umbau, Schaden, Marktwechsel und Ausmusterung | `betrieb.md` 3.6 |
| Fahrzeugmarktstatus | `VehicleMarketStatus` | autoritativer Zustand eines konkreten Fahrzeugs: Eigentum, Leasing, serverseitiges Leasingangebot, Gebrauchtangebot oder Ausmusterung | `betrieb.md` 3.6 |
| Fahrzeugzustand | `VehicleCondition` | mehrdimensionaler, ganzzahliger Zustand für Mechanik, Antrieb, Bremsen, Betrieb und Innenraum; wird im Lebenslauf fortgeschrieben | `betrieb.md` 3.6 |
| Formation | `Formation` | konkrete Zusammenstellung von Fahrzeugen für eine Zugfahrt | `betrieb.md` 2 |
| Frist | `deadlineAt` | Zeitpunkt, bis zu dem eine Reaktion auf eine Postfach-Nachricht erwartet wird; optional, nicht jede Nachricht trägt eine | `weltgeruest.md` 9 |
| Game-Verwaltungsfähigkeit | `GameAdminCapabilityProjection` | signierte, weltbezogene Projektion, ob eine typisierte Odoo-Administration im Game tatsächlich einen fachlichen Handler besitzt; ohne sie bleibt der Antrag vorbereitet und wirkungslos | `adr/0023-odoo-als-administrativer-kontrollpunkt.md` |
| Gegenfahrt | `OpposingMove` | Belegungskonflikt zweier Zugfahrten entgegengesetzter Richtung auf demselben eingleisigen Abschnitt | `infrastruktur.md` 1 |
| Geschätzte Zugkartenposition | `PublicMapEstimate` | rein visuelle, releasegebundene Lage mit bestätigter Ressourcenbindung, aber ohne behauptete `trackId` oder gleisscharfen Offset; wird als `≈` mit neutralem Ring gekennzeichnet und nie betrieblich verwendet | `zugkartenprojektion.md`, `adr/0027-geschaetzte-zugkartenposition-nur-visuell.md` |
| Gleichstand | `Tie` | exakte Punktgleichheit im Planungslauf; wird über den veröffentlichten Seed aufgelöst | `infrastruktur.md` 10 |
| Gleis | `Track` | das, worauf gefahren wird; liegt auf einer Kante oder in einer Betriebsstelle und trägt Vmax, Neigung, Elektrifizierung und Zugsicherung | `betriebsgraph.md` 2 |
| Grenzportal | `BoundaryPortal` | benannte, versionierte Schnittstelle am Rand des spielbaren Netzes; trägt die serverseitigen Ein- oder Ausfahrfenster einer Fahrtkette | `infrastruktur.md` 10.4 |
| Herkunft | `Provenance` | Quelle und Vertrauensgrad eines importierten Attributwertes; hängt am einzelnen Band, nicht am Gleis | `daten.md` 2 |
| Höhenstichprobe | `ElevationSample` | Position-Höhe-Paar eines Höhenmodells entlang der Gleisgeometrie; Eingabe der Neigungsableitung | `betriebsgraph.md` 10 |
| Infrastruktur-Release | `InfraRelease` | unveränderliches, versioniertes Netzartefakt mit Herkunft, Lizenz, Prüfsumme und Confidence je Attribut | `architektur.md` 3 |
| Insolvenz | `Insolvency` | Stufe 5 der Eskalationsleiter; das EVU endet vollständig, der Account bleibt | `wirtschaft.md` 5 |
| Kante | `TrackEdge` | Verbindung zweier Betriebsstellen im Betriebsgraph; trägt die Gleise und die Kilometrierung, aber selbst keine Fahrt | `betriebsgraph.md` 2 |
| Kartenobjektdetail | `LivemapObjectDetail` | releasegebundene, beim Klick geladene öffentliche Fachsicht auf Gleis, Betriebsstelle, Bahnsteig, Weiche, Signal, Block oder Anlage | `adr/0026-karte-als-spielzentrum.md` |
| Kartenposition | `mapPosition` / `mapEstimate` | gegenseitig exklusive öffentliche Kartendarstellung eines Zuges: entweder nachgewiesenes Exact, ausdrücklich gekennzeichnetes Estimate oder keine Lage | `zugkartenprojektion.md` |
| Konfliktbericht | `ConflictReport` | geordnete, durchnummerierte Menge der Befunde einer Prüfung, maschinenlesbar und als deutscher Text erklärbar | `infrastruktur.md` 8 |
| Konfliktressource | `ConflictResource` | alles, worum zwei Zugfahrten konkurrieren können — Block, Fahrstraße, Bahnsteig, Anlage | `infrastruktur.md` 1 |
| Konto | `Account` | Spielkonto, das ein Keycloak-Subject aus einem Weltzugang heraus in genau einer Welt führt; Anzeigename ist eine Angabe des Spielsystems, nicht der Identität bei Keycloak | `weltgeruest.md` 2 |
| Längsneigung | `Gradient` | Steigung oder Gefälle eines Gleisabschnitts in Zehntel Promille, bezogen auf die Kilometrierung; kehrt sich in der Gegenrichtung um | `betriebsgraph.md` 4 |
| Laufweg | `Itinerary` | die Folge von Betriebsstellen und Kanten, die eine Zugfahrt befährt | `infrastruktur.md` 2 |
| Ledger-Buchung | `LedgerEntry` | einzelner, unveränderlicher Posten einer Ledger-Transaktion, in Integer-Cent | `weltgeruest.md` 8 |
| Ledger-Konto | `LedgerAccount` | benanntes Konto in den Büchern genau eines EVU | `weltgeruest.md` 8 |
| Ledger-Transaktion | `LedgerTransaction` | unveränderliche Hülle einer doppelten Buchung; die Summe ihrer Ledger-Buchungen ist zwingend null | `weltgeruest.md` 8 |
| Livemap | `LiveMap` | öffentliche Echtzeitkarte des Verkehrs; vollständig transparent nach E9 | `produkt.md` |
| Livemap-Detailkatalog | `SQLiteLivemapReadModel` | releasegebundene, öffentliche SQLite-Projektion für anklickbare Infrastrukturdetails, Bahnhofstafel und FIS; wird read-only und per Einzelabfrage gelesen | `livemap-detailkatalog.md` |
| Los | `Lot` | ausgeschriebenes Leistungspaket eines Aufgabenträgers | `wirtschaft.md` 3.3 |
| Löschung (Datenschutz) | `eraseAccountData` | anonymisiert Anzeigename und Zeitstempel eines Kontos und entzieht den Weltzugang; Konto und Betriebshistorie bleiben bestehen (E8) | `weltgeruest.md` 10 |
| Manuelle Störung | `ManualDisruption` | hochriskanter, Odoo-vorbereiteter Antrag mit Beginn, Ende, Ursache, betroffenen Ressourcen und deklarierter Wirkung; vor M8.3 keine Simulationswirkung | `betrieb.md` 5, `adr/0023-odoo-als-administrativer-kontrollpunkt.md` |
| Marktverfügbarkeit | `MarketAvailability` | dokumentiertes oder ausdrücklich geschätztes Zeitfenster, in dem ein Fahrzeugtyp als Neubau, Leasing- oder Gebrauchtfahrzeug angeboten wird | `betrieb.md` 2.1 |
| Mindestzugfolgezeit | `MinimumHeadway` | kleinster zeitlicher Abstand zweier Zugfahrten derselben Richtung; folgt aus den Sperrzeiten, ist kein eigener Parameter | `infrastruktur.md` 1 |
| Mobilisierungsphase | `MobilisationPhase` | Zeit zwischen Zuschlag und Betriebsaufnahme; nachweispflichtig auf Fahrzeuge, Personal und Trassen | `wirtschaft.md` 3 |
| Nachricht (Postfach) | `MailboxMessage` | generischer Postfach-Eintrag mit `messageType` und `payload`; trägt später Trassenangebote, Ausschreibungen, Störungsmeldungen | `weltgeruest.md` 9 |
| Netzfahrplan | `NetworkTimetable` | das veröffentlichte Ergebnis eines Planungslaufs für eine Fahrplanperiode | `infrastruktur.md` 3 |
| Netzfilter | `filter_network` | wählt aus dem Rohgraph das EBO-Netz aus — `railway=rail` in Regelspur, ohne Stromschiene | `betriebsgraph.md` 8 |
| Notvergabe | `EmergencyAward` | auf zwei Perioden befristete Übernahme durch den Eigenbetrieb nach gescheiterter Ausschreibung | `wirtschaft.md` 4 |
| Nutzlänge | `usable_length` | der Teil eines Gleises oder Bahnsteigs, auf dem Fahrzeuge stehen dürfen; begrenzt die zulässige Formation | `betriebsgraph.md` 2 |
| Odoo-Projektion | `OdooProjectionEnvelope` | minimaler, versionierter und idempotenter Game-zu-Odoo-Datensatz mit Welt, Datenstand und Korrelation; keine zweite fachliche Wahrheit | `adr/0023-odoo-als-administrativer-kontrollpunkt.md` |
| Öffnungszeit | `OpeningHours` | durchgehende oder tägliche Zeitspanne, in der eine Anlage nutzbar ist | `betrieb.md` 4 |
| Outbox | `odooProjectionOutbox` | im selben Commit wie der Game-Zustand geschriebene, erneut zustellbare Projektion an Odoo; sie liegt nie im Simulationspfad | `odoo-betrieb.md` |
| Persistenter Fahrzeugmarkt | `PersistentVehicleMarket` | weltgebundene Zustandsmaschine für konkrete Fahrzeuge, Startbestand, Serververmieter, Leasingrücklauf, Gebrauchtmarkt und kanonischen Replay-Hash | `betrieb.md` 3.6 |
| Planungslauf | `PlanningRun` | deterministische, gemeinsame Behandlung aller Trassenanträge eines Planungsfensters | `infrastruktur.md` 10 |
| Pönale | `Penalty` | vertragliche Sanktion für Qualitätsmängel; wirkt bis zum letzten Tag der Vertragslaufzeit | `wirtschaft.md` 3 |
| Postfach | `mailboxMessages` | Grundgerüst für Nachrichten, Fristen und Quittierung eines Kontos in einer Welt | `weltgeruest.md` 9 |
| Präqualifikation | `Prequalification` | Eignungsnachweis eines Spielers aus seiner Betriebshistorie in dieser Welt | `wirtschaft.md` 5 |
| Prüfhorizont | `horizon_days` | wie viele Tage ein Verkehrsangebot vorausschauend materialisiert und geprüft wird; eine Woche deckt jedes Verkehrstagemuster genau einmal ab | `infrastruktur.md` 9 |
| Qualitätsklasse | `QualityClass` | A (validiert), B (konservativ) oder C (unzureichend); die höchste Klasse, die ein Vertrauensgrad datenseitig trägt | `daten.md` 5 |
| Quellenregister | `SourceRegister` | maschinenlesbares Verzeichnis aller Datenquellen mit Freigabestatus, Lizenz und Bereitstellungsweg; die geprüfte Wahrheit des Rechte-Gates | `rechte.md` 1 |
| Quittierung | `acknowledgeMessage` | Bestätigung des Empfängers, eine Postfach-Nachricht gesehen zu haben; nur der Empfänger selbst quittiert | `weltgeruest.md` 9 |
| Rahmenvertrag | `FrameworkAgreement` | mehrperiodige Kapazitätszusage, gedeckelt zum Schutz gegen Landgrab | `infrastruktur.md` 13 |
| Rangieren | `Shunting` | Fahrzeugbewegung ohne Zugfahrt; ausschließlich automatisiert, als Zeitbedarf und kurze Belegung verrechnet | `betrieb.md` 4 |
| Räumfahrzeit | `ClearingTime` | Anteil der Sperrzeit, in dem der Zug mit voller Länge den Abschnitt und den Durchrutschweg räumt | `infrastruktur.md` 1 |
| Rechte-Gate | `RightsGate` | Durchsetzung von Invariante 8: kein Import ohne dokumentierte Freigabe der Datenquelle | `rechte.md` 1 |
| Reconciliation-Aufgabe | `ReconciliationTask` | auditierte Korrekturaufgabe aus dem nächtlichen Abgleich stabiler Bridge-IDs und Hashes; überschreibt keine Daten still | `odoo-betrieb.md` |
| Referenzkorpus | `ReferenceCorpus` | Versionierte Vergleichsgrundlage einer Region: technische Referenzen für Fahrdynamik sowie davon getrennte veröffentlichte Fahrplanwerte und Haltezeiten; Herkunft und Verwendungszweck jeder Größe bleiben explizit | `betriebsgraph.md` 18 |
| Referenzlauf | `ReferenceRun` | ein Fahrweg mit Zugcharakteristik und explizit benannter Vergleichsgröße — technische Laufzeit oder Fahrplanzeit dürfen nicht vermischt werden | `betriebsgraph.md` 18 |
| Regelgrenze | `LimitKind` | konkrete betriebliche Zulässigkeitsprüfung einer Dispositionsmaßnahme, etwa Kapazität, Streckenkenntnis, Fahrzeug, Personal, Vertrag oder Kosten | `betriebsprogramm.md` 2 |
| Regionsübergabe | `RegionHandover` | Übergang einer Zugfahrt zwischen zwei regionalen Single-Writer-Prozessen, mit Bestätigung | `architektur.md` 3 |
| Reise- oder Fahrtkette | `JourneyChain` | ein durchgehender Zuglauf aus bestellbaren regionalen und nicht disponierbaren äußeren Abschnitten; Identität, Fahrzeug- und Personalbindung bleiben erhalten | `adr/0025-gebietsueberschreitende-fahrtketten.md` |
| Reisezugwagen | `VehicleRole::Coach` | nicht angetriebenes Fahrzeug für Fahrgäste; kann Teil eines Wagenparks sein, aber keine eigene Zugfahrt bilden | `betrieb.md` 2.3 |
| Rohgraph | `RawGraph` | Topologie, Geometrie und Tags eines OSM-PBF-Extracts, roh und ungefiltert; Ergebnis der Import-Pipeline, noch kein Betriebsgraph | `betriebsgraph.md` 7 |
| Rohkante | `RawEdge` | Wegabschnitt des Rohgraphen zwischen zwei bedeutsamen Knoten, mit voller Geometrie und den Tags seines OSM-Wegs | `betriebsgraph.md` 7 |
| Rohknoten | `RawNode` | betrieblich bedeutsamer Punkt des Rohgraphen — Anfang, Ende oder Verzweigung eines Wegs, oder selbst `railway`-getaggt | `betriebsgraph.md` 7 |
| Rolle | `Role` | `player` oder `world_admin`; ein Konto kann mehrere Rollen innerhalb derselben Welt gleichzeitig tragen | `weltgeruest.md` 3 |
| Rücktest | `BacktestResult` | hypothetische Auswertung einer Betriebsprogramm-Version gegen historische Ereignisfakten ohne Änderung von Event-Log oder Simulationszustand | `betriebsprogramm.md` 2 |
| Schichtentrennung | `LayerSeparation` | Trennung von Code, Daten und Marke; die proprietären Schichten bleiben aus dem öffentlichen Repositorium | `rechteschutz.md` 3 |
| Schienenersatzverkehr | `RailReplacementService` | vertragliche Ersatzleistung bei Sperrung; Kostenposten und Bewertungsfaktor, kein eigener Fuhrpark | `betrieb.md` 6 |
| Server-Leasingangebot | `ServerLeaseQuote` | deterministisches Angebot eines fiktiven servereigenen Vermieters für ein konkretes Fahrzeug; der Preis liegt strikt über dem vergleichbaren Marktpreis | `betrieb.md` 3.6 |
| Signal | `Signal` | Haupt-, Vor- oder Blockkennzeichen an einer Position entlang eines Gleises; nur blockbegrenzende Kennzeichen gehen in die Blockableitung ein | `betriebsgraph.md` 11 |
| Signalsichtzeit | `SignalSightingTime` | Anteil der Sperrzeit zwischen dem Erkennen des Vorsignals und dem Vorsignal selbst | `infrastruktur.md` 1 |
| Simulationszeit | `SimTime` | Sekunden seit Weltepoche; expliziter Wert, niemals aus der Systemuhr gelesen | `architektur.md` 4 |
| Sperrzeit | `BlockingTime` | Zeitspanne, in der eine Konfliktressource für eine Zugfahrt gesperrt ist — Fahrstraßenbildung, Annäherung, Fahrzeit, Räumung, Auflösung | `infrastruktur.md` 1 |
| Sperrzeitentreppe | `BlockingTimeStaircase` | die treppenförmige Darstellung aufeinanderfolgender Sperrzeiten im Bildfahrplan | `milestones.md` M0.3 |
| Sperrzeitparameter | `SignallingParameters` | Signalsichtzeit, Vorsignalabstand, Durchrutschweg und Stellwerksbauart einer Betriebsstelle — die Werte, aus denen die sechs Anteile der Sperrzeit entstehen | `infrastruktur.md` 6 |
| Spurweite | `TrackGauge` | Abstand der Schienen in Millimetern; das Spielnetz führt ausschließlich Regelspur (E14), der Netzfilter braucht die Angabe zum Aussortieren | `betriebsgraph.md` 2 |
| Starting-Capital-Policy | `StartingCapitalPolicy` | im signierten Weltentwurf festgelegtes Startkapital einer öffentlichen Welt: endliche Integer-Cent, null oder explizit `unlimited`; niemals eine Startausstattung | `produkt.md` 3 |
| Stationsanreicherung | `StationEnrichment` | je Betriebsstelle mit Fahrgastwechsel angereicherter Datensatz aus Bahnhofskategorie und Stationsausstattung, mit eigener Herkunft je Feld | `betriebsgraph.md` 13 |
| Stationsausstattung | `StationAmenities` | Menge der an einer Betriebsstelle vorhandenen Ausstattungsmerkmale — Barrierefreiheit, Wetterschutz, Fahrgastinformation und mehr | `betriebsgraph.md` 13 |
| Stellwerksbauart | `InterlockingKind` | mechanisch, elektromechanisch, Relais-, elektronisches oder digitales Stellwerk; entscheidet Fahrstraßenbilde- und Fahrstraßenauflösezeit | `infrastruktur.md` 6 |
| Steuerwagen | `VehicleRole::ControlCar` | nicht angetriebener Reisezugwagen mit einem oder zwei Steuerständen; ermöglicht bei passender Endlage den Wendezugbetrieb | `betrieb.md` 2.3 |
| Störung | `Disruption` | ungeplantes Ereignis mit Wirkung auf den Betrieb; Entstehung und Fortpflanzung sind getrennt modelliert | `betrieb.md` 5 |
| Substream | `Substream` | benannter Teilstrom des Weltseeds; ein neuer Strom verändert die bestehenden nicht | `architektur.md` 4 |
| Tagesbericht | `DailyReport` | asynchrone Rückmeldung an den Spieler: was ist passiert, welche Regel hat wann was getan | `betrieb.md` 1 |
| Toleranz | `Tolerance` | vorab definierte zulässige Abweichung zwischen berechneter und gleichartig definierter Referenzzeit — absoluter Sockel und relativer Anteil, der größere gilt | `betriebsgraph.md` 18 |
| Trasse | `TrainPath` | zugewiesenes Recht, einen Laufweg zu einer Zeitlage zu befahren | `infrastruktur.md` 2 |
| Trassenantrag | `PathRequest` | Antrag auf eine Trasse mit Zugcharakteristik, Verkehrstagen, Halten, Wunschzeiten und zulässigen Abweichungen | `infrastruktur.md` 2 |
| Trassenkandidat | `PathCandidate` | ein gegen das Belegungsbuch geprüftes Verkehrsangebot samt seiner Abweichung vom Trassenantrag | `infrastruktur.md` 9 |
| Tutorialbegleiter | `TutorialDialogue` | versionierter, reproduzierbarer Hinweis von Lutz mit Trigger, Handlung, optionalem Warum und Zielbereich; keine generative Laufzeit-KI | `produkt.md` 3 |
| Tutorialsitzung | `TutorialSession` | Bindung genau eines öffentlichen Weltkontos an eine private, ungewertete, beschleunigte und kurzlebige Tutorialwelt mit externer `tut_…`-Referenz | `adr/0028-getrennter-tutorial-und-wettbewerbsstart.md` |
| Tutorialtemplate | `TutorialTemplate` | unveränderliches, versioniertes und gehashtes Minimalartefakt für Korridor, Inventar, Dialoge, Zeitgrenzen und stets endliches Tutorialkapital | `adr/0028-getrennter-tutorial-und-wettbewerbsstart.md` |
| Umlauf | `VehicleRotation` | die Folge von Zugfahrten, die ein Fahrzeug oder eine Formation nacheinander leistet | `betrieb.md` 2 |
| Vergabekalender | `TenderCalendar` | beim Weltstart erzeugte, veröffentlichte Verteilung der Erstvergaben über die erste Welthälfte | `wirtschaft.md` 3.3 |
| Vergabeprofil | `TenderProfile` | deterministisch aus dem Seed gezogene, vorab veröffentlichte Kombination von Anforderungs- und Wertungshebeln einer Ausschreibung; sorgt dafür, dass eine Angebotsschablone nicht auf jedes Los passt | `wirtschaft.md` 3.7 |
| Verkehrsangebot | `ServicePattern` | wiederkehrender Verkehr als eine Zeile: Zugnummer, Zugcharakteristik, Laufweg, Abfahrtszeit, Verkehrstage — plus relativem Belegungsprofil | `infrastruktur.md` 7 |
| Verkehrstage | `OperatingDays` | die Tage, an denen ein wiederkehrendes Verkehrsangebot tatsächlich fährt | `infrastruktur.md` 2 |
| Verkehrsvertrag | `ServiceContract` | Vertrag zwischen Aufgabenträger und EVU über ein Los, mit Entgelt, Bonus, Pönale und Nachweisen | `wirtschaft.md` 3 |
| Vermieterprofil | `LessorProfile` | weltgebundenes, veröffentlichtes Profil eines fiktiven servereigenen Vermieters mit Präferenzen und deterministischer Preiskalkulation | `betrieb.md` 3.6 |
| Verspätung | `Delay` | Abweichung von der Soll-Zeitlage; propagiert regelbasiert über Anschlüsse und Umläufe | `infrastruktur.md` 5 |
| Verspätungsursachencode | `DelayCauseCode` | zweistellige Hauptkennung mit Kurztext, Ursachentyp und spielmechanischer Verantwortungsgruppe; getrennt von RIS-Abweichungscodes | `stoerungen.md` 3 |
| Vertrauensgrad | `Confidence` | wie belastbar ein Attributwert ist — erfasst, abgeleitet oder angenommen; Grundlage der Qualitätsklassen | `daten.md` 5 |
| Virtueller Fahrdienstleiter | `VirtualDispatcher` | regionale serverautoritative Dispositionslogik über gemeinsame Konfliktressourcen mit erklärbarer lexikographischer Reihenfolge | `stoerungen.md` 5 |
| Vmax-Band | `SpeedLimit` | die zulässigen Geschwindigkeiten eines Gleisabschnitts — Regel, Neigetechnik, Güterzug; als Band eines Bandprofils geführt | `betriebsgraph.md` 2 |
| Wagenpark | `UnpoweredFormation` | Formation ohne eigene Traktion; bleibt in Werkstatt oder Abstellung und wird für Überführungen von einer Lok bewegt | `betrieb.md` 2.3 |
| Weiche | `Switch` | Fahrwegverzweigung; Konfliktressource, weil kreuzende Bewegungen sich ausschließen | `infrastruktur.md` 1 |
| Weichenlage | `SwitchPosition` | Grundstellung oder abzweigende Lage einer Weiche in einer Fahrstraße | `betriebsgraph.md` 12 |
| Welt | `World` | vollständig isolierte Instanz von Netz, Wirtschaft und Spielern; Wurzel der Mandantentrennung, jede andere Tabelle trägt ihre `world_id` (Invariante 4) | `architektur.md` 5 |
| Weltprofil | `WorldProfile` | die Parameter einer Welt: Laufzeit, Periodenlänge, Vertragslaufzeit, Ausschreibungsvorlauf | `wirtschaft.md` 3 |
| Weltseed | `WorldSeed` | Seed einer Welt für eine Fahrplanperiode; Grundlage aller benannten Substreams | `architektur.md` 4 |
| Weltstartbestand | `WorldStarterFleet` | optionaler, vor Weltenstart auditierter und danach unveränderlicher Pool konkreter Gebrauchtfahrzeuge | `betrieb.md` 3.6 |
| Weltzugang | `worldAccesses` | das Recht eines Keycloak-Subjects, in einer Welt aufzutreten — getrennt vom Konto, damit ein Entzug dessen Betriebshistorie nicht mit sich reißt | `weltgeruest.md` 2 |
| Wendezeit | `TurnaroundTime` | Mindestzeit zwischen Ankunft und Abfahrt derselben Formation am Endpunkt | `betrieb.md` 2 |
| Wertungsgewichtung | `ScoringWeights` | das im Vergabeprofil festgelegte Verhältnis von Preis- zu Qualitätspunkten einer Ausschreibung; aus dem `EconomyRelease` | `wirtschaft.md` 3.7 |
| Wirtschafts-Release | `EconomyRelease` | versioniertes, je Welt gepinntes Artefakt mit allen Entgelten und Kostensätzen | `wirtschaft.md` 1 |
| Zeitlage | `departure_time_s` | die Abfahrtszeit eines Verkehrsangebots als Sekunde des Tages; alle Sperrzeiten des Belegungsprofils zählen relativ zu ihr | `infrastruktur.md` 7 |
| Zugcharakteristik | `TrainCharacteristics` | Masse, Länge, Vmax, Anfahr- und Bremsvermögen, Antriebsart, Zugsicherung — entkoppelt die Planung vom Fahrzeugkatalog | `infrastruktur.md` 2 |
| Zugfahrt | `TrainRun` | die einzelne, materialisierte Fahrt eines Zuges an einem Verkehrstag | `infrastruktur.md` 5 |
| Zugfolgefall | `Headway` | Belegungskonflikt zweier Zugfahrten derselben Richtung auf demselben Abschnitt; die Mindestzugfolgezeit ist unterschritten | `infrastruktur.md` 8 |
| Zuggattung | `TrainCategory` | Fernverkehr, S-Bahn, Regionalverkehr, Güterverkehr oder Dienstzug; bestimmt den Nummernbereich der Zugnummer | `infrastruktur.md` 7 |
| Zugkartenprojektion | `SQLiteTrainMapProjector` | read-only, releasegebundene Laufzeitprojektion: liefert Exact nur auf eindeutig nachgewiesenem Gleis und Estimate getrennt auf einem erlaubten Darstellungspfad; kein Rückfluss in Betrieb, Bestellbarkeit oder Qualität | `zugkartenprojektion.md` |
| Zugkilometer | `TrainKilometre` | Leistungseinheit der Verkehrsverträge und Bezugsgröße des Bestellerentgelts | `wirtschaft.md` 3.5 |
| Zugkreuzung | `TrainCrossing` | Begegnung zweier Zugfahrten entgegengesetzter Richtung auf eingleisiger Strecke; nur in einer Betriebsstelle mit Kreuzungsmöglichkeit zulässig | `infrastruktur.md` 1 |
| Zugnummer | `TrainNumber` | die Nummer einer Zugfahrt; nennt über ihren Bereich die Zuggattung und über ihre Parität die Richtung — gerade mit, ungerade gegen die Kilometrierung | `infrastruktur.md` 7 |
| Zugsicherung | `TrainProtection` | streckenseitige und fahrzeugseitige Sicherungstechnik; begrenzt, welche Formation wo fahren darf | `infrastruktur.md` 1 |
| Zugsicherungsoption | `ProtectionOption` | am exakten Fahrzeugtyp belegte, zeitgebundene Werksoption oder Werkstattnachrüstung; Serienausrüstung ist keine Option | `betrieb.md` 2.2 |
| Zulässige Abweichung | `PathTolerances` | wie weit ein Trassenantrag sich verschieben, wie viel Fahrzeit er verlieren und wie viele Betriebshalte er vertragen darf | `infrastruktur.md` 9 |
| Zusatzfahrt | `SupplementaryRun` | Zuführungs-, Werkstatt-, Versorgungs- oder Abstellfahrt; ein echter Zug mit Trasse, Personal und Kosten | `betrieb.md` 4 |
| Zuschlag | `Award` | Entscheidung über eine Ausschreibung; fällt deterministisch sofort bei Fristende | `wirtschaft.md` 3.5 |
| Zustands-Hash | `StateHash` | kanonischer, plattformunabhängiger Hash eines Simulationszustands | `architektur.md` 4 |
