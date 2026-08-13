// Mit packages/glossary/generate.mjs aus docs/glossar.md erzeugt. Nicht von Hand ändern.
export const GENERATED_GLOSSARY_ENTRIES = Object.freeze([
  {
    "term": "Abdeckungsmessung",
    "code": "CoverageReport",
    "definition": "Bericht je Attribut und Streckenabschnitt, wie viel Länge welchen Vertrauensgrad trägt und welche Qualitätsklasse ein Abschnitt datenseitig höchstens erreichen kann"
  },
  {
    "term": "Abstellgleis",
    "code": "StablingTrack",
    "definition": "Gleis zum Abstellen nicht eingesetzter Fahrzeuge; Konfliktressource wie jedes andere Gleis"
  },
  {
    "term": "Abweichungsreport",
    "code": "DeviationReport",
    "definition": "stellt je Referenzlauf die aus dem Release berechnete Fahrzeit der realen gegenüber und prüft sie gegen die Toleranz"
  },
  {
    "term": "Ad-hoc-Trasse",
    "code": "AdHocPath",
    "definition": "Trasse aus der Restkapazität einer laufenden Fahrplanperiode"
  },
  {
    "term": "Administrationsantrag",
    "code": "AdminCommandPayload",
    "definition": "typisierter, begründeter und korrelierter Antrag aus Odoo; das Game prüft und auditiert ihn erneut, bevor irgendeine Wirkung entsteht"
  },
  {
    "term": "Alpha-Feedbackprojektion",
    "code": "AlphaFeedbackProjectionPort",
    "definition": "atomare, bereits pseudonymisierte Outbox-Grenze vom autoritativen Game-Feedback zur bearbeitbaren Odoo-Triage; enthält kein Keycloak-Subject"
  },
  {
    "term": "Anlage",
    "code": "Facility",
    "definition": "Werkstatt, Behandlungs- oder Waschanlage, Tankstelle, Entsorgungsanlage oder als Anlage geführtes Abstellgleis mit Kapazität, Öffnungszeit, Nutzlänge und Baureihenkompetenz"
  },
  {
    "term": "Anlagenkataster",
    "code": "FacilityCatalog",
    "definition": "geprüfte Sammlung aller Anlagen einer Welt, gegen den Betriebsgraphen validiert — welches Gleis, welche Kapazität, welche Baureihenkompetenz"
  },
  {
    "term": "Annäherungsabschnitt",
    "code": "ApproachSection",
    "definition": "Abschnitt vor einem Hauptsignal — der Vorsignalabstand; seine Durchfahrzeit gehört zur Sperrzeit des folgenden Abschnitts"
  },
  {
    "term": "Anschluss",
    "code": "Connection",
    "definition": "geplanter Übergang von Fahrgästen zwischen zwei Zugfahrten"
  },
  {
    "term": "Antriebsart",
    "code": "TractionType",
    "definition": "Diesel, Akku oder elektrisch unter einem oder mehreren Bahnstromsystemen; entscheidet, welche Elektrifizierung ein Zug nutzen kann"
  },
  {
    "term": "Aufbewahrungsfrist",
    "code": "RetentionPeriod",
    "definition": "wie lange eine Datenkategorie nach ihrem Bezugsereignis aufbewahrt wird; null heißt unbefristet"
  },
  {
    "term": "Aufgabenträger",
    "code": "TransportAuthority",
    "definition": "simulierter Besteller im SPNV; schreibt aus, zahlt, sanktioniert — betreibt aber selbst keine Züge außer im Eigenbetrieb"
  },
  {
    "term": "Auskömmlichkeitsgrenze",
    "code": "ViabilityThreshold",
    "definition": "vor Angebotsöffnung veröffentlichter Höchstwert; deterministisch aus dem EconomyRelease berechnet"
  },
  {
    "term": "Auskunft (Datenschutz)",
    "code": "PersonalDataExport",
    "definition": "vollständiges, maschinenlesbares Bündel aller Personendaten, die das Spielsystem über ein Konto in einer Welt führt"
  },
  {
    "term": "Ausschlussmenge",
    "code": "exclusion_set",
    "definition": "Menge der Fahrstraßen, die nicht gleichzeitig mit einer gegebenen gestellt werden dürfen, weil sie ein Fahrwegelement oder eine Weiche teilen"
  },
  {
    "term": "Ausschreibung",
    "code": "Tender",
    "definition": "Vergabeverfahren über ein Los, mit Leistungsbeschreibung, Frist, Wertung und Zuschlag"
  },
  {
    "term": "Außenlauf",
    "code": "ExternalLeg",
    "definition": "Teil einer Fahrtkette außerhalb des freigegebenen Netzes, ohne erfundene Topologie und ohne Spieler-Disposition; bindet Fahrzeuge und Dienste bis Rückkehr oder Außenende"
  },
  {
    "term": "Bahnhofskategorie",
    "code": "StationCategory",
    "definition": "Einstufung einer Betriebsstelle mit Fahrgastwechsel nach Größe und Ausstattungsniveau, Kategorie 1 bis 7; künftige Bemessungsgrundlage des Stationsentgelts"
  },
  {
    "term": "Bahnhofskopf",
    "code": "StationHead",
    "definition": "der Weichenbereich einer Betriebsstelle; aus Weichenlage und Signalstandort werden hier Fahrstraßen und Durchrutschwege abgeleitet"
  },
  {
    "term": "Bahnhofstafel",
    "code": "StationBoard",
    "definition": "weltzeitgebundene öffentliche Projektion geplanter und erwarteter Ankünfte/Abfahrten; die fallblattartige Ansicht ist nur ihre Darstellung"
  },
  {
    "term": "Bahnsteig",
    "code": "Platform",
    "definition": "Fahrgastanlage an einem Gleis; Nutzlänge und Höhe begrenzen die zulässige Formation"
  },
  {
    "term": "Bahnstromsystem",
    "code": "PowerSystem",
    "definition": "Spannung und Frequenz der Fahrstromversorgung; entscheidet, ob ein Triebfahrzeug den Strom nutzen kann"
  },
  {
    "term": "Bandprofil",
    "code": "BandProfile",
    "definition": "lückenlose, überschneidungsfreie Folge von Bändern eines Gleisattributs über die volle Gleislänge"
  },
  {
    "term": "Baureihenkompetenz",
    "code": "FleetCompetence",
    "definition": "Menge der Baureihen, die eine Anlage behandeln kann"
  },
  {
    "term": "Baustelle",
    "code": "PlannedWorks",
    "definition": "angekündigte Einschränkung mit Vorlauf, Planungsfenster und Ersatzkonzept"
  },
  {
    "term": "Belegungsbuch",
    "code": "OccupationLedger",
    "definition": "nach Konfliktressource gruppierte Sammlung aller Sperrzeiten einer Welt; nimmt über try_insert nur konfliktfreie Fahrten auf und hält Invariante 1 dadurch durch Konstruktion"
  },
  {
    "term": "Belegungskonflikt",
    "code": "OccupationConflict",
    "definition": "Überschneidung zweier Sperrzeiten auf derselben Konfliktressource; verletzt die harte Invariante 1"
  },
  {
    "term": "Belegungsprofil",
    "code": "OccupationProfile",
    "definition": "relative Belegung der Konfliktressourcen eines Laufwegs, unabhängig vom konkreten Verkehrstag"
  },
  {
    "term": "Beschleunigungsvermögen",
    "code": "Acceleration",
    "definition": "Anfahr- oder Bremsvermögen eines Zuges, in Millimetern je Sekunde zum Quadrat; ein vorzeichenloser Fähigkeitswert, den die Fahrdynamik richtungsabhängig einsetzt"
  },
  {
    "term": "Bestellerentgelt",
    "code": "OrderingFee",
    "definition": "Zahlung des Aufgabenträgers je Zugkilometer; der zentrale Hebel im Angebot"
  },
  {
    "term": "Betriebsentscheidung",
    "code": "DecisionExplanation",
    "definition": "vollständiger Auditdatensatz einer automatischen oder manuellen Dispositionsentscheidung mit Regel, Bedingungen, Grenzen, Alternativen, Ursache und Auswirkungen"
  },
  {
    "term": "Betriebsgraph",
    "code": "OperatingGraph",
    "definition": "das Netz als geprüftes Ganzes: Betriebsstellen, Kanten, Gleise und Bahnsteige mit ihren Attributen"
  },
  {
    "term": "Betriebshalt",
    "code": "operational_stop",
    "definition": "vom Planner eingelegter Halt ohne Fahrgastwechsel, in einer kreuzungsfähigen Betriebsstelle; seine Dauer wird aus dem Prüfbericht errechnet, nicht geraten"
  },
  {
    "term": "Betriebsmetrik",
    "code": "AlphaOperationsMetrics",
    "definition": "begrenzt beschriftete Prometheus-Sicht auf den bereits materialisierten Alpha-Monitoringsnapshot mit Datenalter, Queue, Bridge und Markt; liest beim Scrape keinen Fachzustand"
  },
  {
    "term": "Betriebsprogramm",
    "code": "OperatingProgram",
    "definition": "priorisierte Regelmenge eines EVU, die der Kern auch ohne den Spieler ausführt"
  },
  {
    "term": "Betriebsprojektion",
    "code": "OperationsProjection",
    "definition": "je EVU gefilterte Sicht auf Dispositionsentscheidungen, Ausfälle, manuelle Eingriffe und Großereignisse aus dem Event-Log"
  },
  {
    "term": "Betriebsstelle",
    "code": "OperatingPoint",
    "definition": "betrieblich benannter Punkt des Netzes — Bahnhof, Haltepunkt, Abzweigstelle, Überleitstelle"
  },
  {
    "term": "Betriebsübergang",
    "code": "OperatorTransition",
    "definition": "Wechsel des Betreibers eines Verkehrsvertrags, ausschließlich zum Fahrplanstichtag"
  },
  {
    "term": "Bildfahrplan",
    "code": "TimeDistanceDiagram",
    "definition": "Weg-Zeit-Darstellung der Zugfahrten; Träger der Sperrzeitentreppe"
  },
  {
    "term": "Blockableitung",
    "code": "derive_block_sections",
    "definition": "Verfahren, das ein Gleis aus Signalpositionen, Zugbeeinflussung und Topologie in seine Blockabschnitte zerlegt — mit virtuellen Blöcken bei Lücken und reinen LZB-/ETCS-Blöcken bei durchgehender Überwachung"
  },
  {
    "term": "Blockabschnitt",
    "code": "BlockSection",
    "definition": "Streckenabschnitt, den zur selben Zeit nur ein Zug befahren darf"
  },
  {
    "term": "Bremshundertstel",
    "code": "BrakePercentage",
    "definition": "ganzzahliges Maß der Bremsleistung eines Zuges im Verhältnis zu seiner Masse"
  },
  {
    "term": "Bremsprobe",
    "code": "BrakeTest",
    "definition": "vereinfachte oder vollständige Prüfung der Zugbremse nach Bildung oder Änderung eines Zugverbandes"
  },
  {
    "term": "Dialogrelease",
    "code": "DialogueReleaseV1",
    "definition": "unveränderlicher, signierter Korpus aus Sprechblasenbäumen, Gewichtungen, Zeitkosten und Ergebnissen; wird offline erzeugt und zur Laufzeit nur gelesen"
  },
  {
    "term": "Durchrutschweg",
    "code": "OverlapPath",
    "definition": "Weg hinter dem Zielsignal, der bei Bremsversagen frei bleiben muss"
  },
  {
    "term": "Eigenbetrieb",
    "code": "PublicOperator",
    "definition": "Ausfallsicherung des Aufgabenträgers; fährt die Mindestbedienung, bewusst mittelmäßig, sichtbar gekennzeichnet"
  },
  {
    "term": "Einspruchsfenster",
    "code": "ObjectionWindow",
    "definition": "Frist nach der Koordinierung, in der ein Trassenangebot beanstandet werden kann"
  },
  {
    "term": "Eisenbahnverkehrsunternehmen (EVU)",
    "code": "Operator",
    "definition": "das Unternehmen eines Spielers; Träger von Fahrzeugen, Personal, Trassen und Verträgen"
  },
  {
    "term": "Elektrifizierung",
    "code": "Electrification",
    "definition": "Bauart der Fahrstromversorgung — Oberleitung, Stromschiene oder keine — samt Bahnstromsystem; als Bandprofil je Gleis geführt"
  },
  {
    "term": "Entitlement",
    "code": "EntitlementRecord",
    "definition": "revisionssicherer Game-Zustand für Laufzeit und Umfang eines kaufmännisch ausgelösten Produkts; enthält keine Spielwerte oder Plannerrechte"
  },
  {
    "term": "Ersatzkonzept",
    "code": "ReplacementPlan",
    "definition": "eigener kleiner Planungslauf gegen die Restkapazität einer Baustelle"
  },
  {
    "term": "Event-Log",
    "code": "DomainEvent",
    "definition": "append-only Eintrag im Ereignisprotokoll einer Welt (domain_events); Wahrheit des Betriebsverlaufs, Träger von Replay und Audit"
  },
  {
    "term": "Exakte Zugkartenposition",
    "code": "PublicMapPosition",
    "definition": "releasegebundene Kartenlage mit bestätigter Ressource, trackId, gleisscharfem ganzzahligem Offset und daraus abgeleiteter E7-Koordinate; bleibt die einzige betriebliche Positionswahrheit"
  },
  {
    "term": "Fahrgastinformationsanzeige",
    "code": "PassengerInformationDisplay",
    "definition": "öffentliche, zuggebundene Projektion von Ziel, nächstem Halt, Folgehalten, Verspätung und Meldungen; Grundlage des generischen FIS-Monitors"
  },
  {
    "term": "Fahrgastkontrollfall",
    "code": "FareInspectionCaseV1",
    "definition": "persistenter, pseudonymer Kontrollvorgang eines materialisierten Manifestfahrgasts mit Dialog-, Feststellungs- und Forderungszustand"
  },
  {
    "term": "Fahrgastmanifest",
    "code": "PassengerManifestV1",
    "definition": "revisionierte M10-Projektion der tatsächlich reisenden Fahrgäste eines Zuglaufabschnitts einschließlich Ein-/Ausstieg und verdecktem Fahrberechtigungsstatus"
  },
  {
    "term": "Fahrplanperiode",
    "code": "SchedulePeriod",
    "definition": "Saison aus Anmeldung, Koordinierung, Veröffentlichung und Betrieb; Länge ist Weltparameter, 3 bis 8 Wochen"
  },
  {
    "term": "Fahrplanstichtag",
    "code": "ScheduleChangeDate",
    "definition": "Beginn einer Fahrplanperiode; einziger zulässiger Zeitpunkt für Betriebsübergänge und Releasewechsel"
  },
  {
    "term": "Fahrstraße",
    "code": "InterlockingRoute",
    "definition": "gesicherter Fahrweg durch einen Bahnhofskopf, aus Weichenlage und Signalstandort abgeleitet"
  },
  {
    "term": "Fahrstraßenableitung",
    "code": "derive_interlocking_routes",
    "definition": "Verfahren, das aus Weichenlage und Signalstandort die Fahrstraßen, Durchrutschwege und Ausschlussmengen eines Bahnhofskopfs erzeugt"
  },
  {
    "term": "Fahrstraßenauflösezeit",
    "code": "RouteReleaseTime",
    "definition": "letzter Anteil der Sperrzeit: das Auflösen des Fahrwegs, nachdem der Zug geräumt hat"
  },
  {
    "term": "Fahrstraßenausschluss",
    "code": "RouteExclusion",
    "definition": "Belegungskonflikt zweier Fahrstraßen desselben Bahnhofskopfs, die sich ein Fahrwegelement oder eine Weiche teilen"
  },
  {
    "term": "Fahrstraßenbildezeit",
    "code": "RouteSettingTime",
    "definition": "erster Anteil der Sperrzeit: Stellen und Festlegen des Fahrwegs, bevor das Signal Fahrt zeigen kann"
  },
  {
    "term": "Fahrweg",
    "code": "RunPath",
    "definition": "lückenlose Folge von Segmenten mit Länge, zulässiger Geschwindigkeit und Neigung, aus der die Fahrdynamik eine Fahrzeit rechnet — anders als der Laufweg bereits auf konstante Werte geschnitten"
  },
  {
    "term": "Fahrzeitrechner",
    "code": "derive_running_time_table",
    "definition": "Verfahren, das über einen Fahrweg und eine Zugcharakteristik eine ganzzahlige Fahrzeittabelle rechnet — der einzige Ort mit Gleitkommarechnung in der Infra-Release-Pipeline"
  },
  {
    "term": "Fahrzeittabelle",
    "code": "RunningTimeTable",
    "definition": "vorberechnete, ganzzahlige Folge von Fahrzeiten und erreichten Geschwindigkeiten an den Segmentgrenzen eines Fahrwegs"
  },
  {
    "term": "Fahrzeugasset",
    "code": "VehicleAsset",
    "definition": "konkretes, weltgebundenes und persistentes Einzelfahrzeug mit Typ, Bau- und Beschaffungsjahr, Eigentum oder Leasing, Zulassungen, Wartungsfristen, Ist-Zugsicherung, Zustandsprofil und Lebenslauf"
  },
  {
    "term": "Fahrzeugepoche",
    "code": "VehicleEra",
    "definition": "Weltfilter für zulässige Bau- oder Beschaffungsjahre; beide Epochen sind unabhängig und können alle Jahre umfassen"
  },
  {
    "term": "Fahrzeugkatalog-Release",
    "code": "VehicleCatalogRelease",
    "definition": "unveränderlicher, versionierter Typkatalog mit faktischer Baureihenbezeichnung, fiktivem Handelsnamen, Bauzeit, Marktfenstern, typgenauer Zugsicherung, Quellen und Prüfsumme"
  },
  {
    "term": "Fahrzeugkonfiguration",
    "code": "VehicleConfiguration",
    "definition": "Sitzaufteilung, Bestuhlung, Mehrzweckbereiche, Türen und Ausstattung eines Fahrzeugs"
  },
  {
    "term": "Fahrzeuglebenslauf",
    "code": "VehicleLifeEvent",
    "definition": "unveränderliche, zeitlich geordnete Historie eines konkreten Fahrzeugs: Welteintritt, Halter/Nutzer, Leasing, Wartung, Umbau, Schaden, Marktwechsel und Ausmusterung"
  },
  {
    "term": "Fahrzeugmarktstatus",
    "code": "VehicleMarketStatus",
    "definition": "autoritativer Zustand eines konkreten Fahrzeugs: Eigentum, Leasing, serverseitiges Leasingangebot, Gebrauchtangebot oder Ausmusterung"
  },
  {
    "term": "Fahrzeugzustand",
    "code": "VehicleCondition",
    "definition": "mehrdimensionaler, ganzzahliger Zustand für Mechanik, Antrieb, Bremsen, Betrieb und Innenraum; wird im Lebenslauf fortgeschrieben"
  },
  {
    "term": "Formation",
    "code": "Formation",
    "definition": "konkrete Zusammenstellung von Fahrzeugen für eine Zugfahrt"
  },
  {
    "term": "Frist",
    "code": "deadlineAt",
    "definition": "Zeitpunkt, bis zu dem eine Reaktion auf eine Postfach-Nachricht erwartet wird; optional, nicht jede Nachricht trägt eine"
  },
  {
    "term": "Game-Verwaltungsfähigkeit",
    "code": "GameAdminCapabilityProjection",
    "definition": "signierte, weltbezogene Projektion, ob eine typisierte Odoo-Administration im Game tatsächlich einen fachlichen Handler besitzt; ohne sie bleibt der Antrag vorbereitet und wirkungslos"
  },
  {
    "term": "Gegenfahrt",
    "code": "OpposingMove",
    "definition": "Belegungskonflikt zweier Zugfahrten entgegengesetzter Richtung auf demselben eingleisigen Abschnitt"
  },
  {
    "term": "Geschätzte Zugkartenposition",
    "code": "PublicMapEstimate",
    "definition": "rein visuelle, releasegebundene Lage mit bestätigter Ressourcenbindung, aber ohne behauptete trackId oder gleisscharfen Offset; wird als ≈ mit neutralem Ring gekennzeichnet und nie betrieblich verwendet"
  },
  {
    "term": "Gleichstand",
    "code": "Tie",
    "definition": "exakte Punktgleichheit im Planungslauf; wird über den veröffentlichten Seed aufgelöst"
  },
  {
    "term": "Gleis",
    "code": "Track",
    "definition": "das, worauf gefahren wird; liegt auf einer Kante oder in einer Betriebsstelle und trägt Vmax, Neigung, Elektrifizierung und Zugsicherung"
  },
  {
    "term": "Grenzportal",
    "code": "BoundaryPortal",
    "definition": "benannte, versionierte Schnittstelle am Rand des spielbaren Netzes; trägt die serverseitigen Ein- oder Ausfahrfenster einer Fahrtkette"
  },
  {
    "term": "Herkunft",
    "code": "Provenance",
    "definition": "Quelle und Vertrauensgrad eines importierten Attributwertes; hängt am einzelnen Band, nicht am Gleis"
  },
  {
    "term": "Höhenstichprobe",
    "code": "ElevationSample",
    "definition": "Position-Höhe-Paar eines Höhenmodells entlang der Gleisgeometrie; Eingabe der Neigungsableitung"
  },
  {
    "term": "Infrastruktur-Release",
    "code": "InfraRelease",
    "definition": "unveränderliches, versioniertes Netzartefakt mit Herkunft, Lizenz, Prüfsumme und Confidence je Attribut"
  },
  {
    "term": "Insolvenz",
    "code": "Insolvency",
    "definition": "Stufe 5 der Eskalationsleiter; das EVU endet vollständig, der Account bleibt"
  },
  {
    "term": "Kante",
    "code": "TrackEdge",
    "definition": "Verbindung zweier Betriebsstellen im Betriebsgraph; trägt die Gleise und die Kilometrierung, aber selbst keine Fahrt"
  },
  {
    "term": "Kartenobjektdetail",
    "code": "LivemapObjectDetail",
    "definition": "releasegebundene, beim Klick geladene öffentliche Fachsicht auf Gleis, Betriebsstelle, Bahnsteig, Weiche, Signal, Block oder Anlage"
  },
  {
    "term": "Kartenposition",
    "code": "mapPosition` / `mapEstimate",
    "definition": "gegenseitig exklusive öffentliche Kartendarstellung eines Zuges: entweder nachgewiesenes Exact, ausdrücklich gekennzeichnetes Estimate oder keine Lage"
  },
  {
    "term": "Konfliktbericht",
    "code": "ConflictReport",
    "definition": "geordnete, durchnummerierte Menge der Befunde einer Prüfung, maschinenlesbar und als deutscher Text erklärbar"
  },
  {
    "term": "Konfliktressource",
    "code": "ConflictResource",
    "definition": "alles, worum zwei Zugfahrten konkurrieren können — Block, Fahrstraße, Bahnsteig, Anlage"
  },
  {
    "term": "Konto",
    "code": "Account",
    "definition": "Spielkonto, das ein Keycloak-Subject aus einem Weltzugang heraus in genau einer Welt führt; Anzeigename ist eine Angabe des Spielsystems, nicht der Identität bei Keycloak"
  },
  {
    "term": "Kontrollbedingter Betriebshalt",
    "code": "FareControlHoldV1",
    "definition": "bindender zusätzlicher Aufenthalt am nächsten planmäßigen Fahrgasthalt nach Polizeianforderung; verlängert reale Ressourcenbelegungen und verlangt anschließend ein neues Abfahrtsrecht"
  },
  {
    "term": "Kündigungsvormerkung",
    "code": "termination-pending",
    "definition": "serverautoritiver Zwischenzustand eines EVU-Vertrags: Die Kündigung ist angenommen, Leistung und Fahrzeughaltung bleiben aber bis zum berechneten Fristende wirksam"
  },
  {
    "term": "Längsneigung",
    "code": "Gradient",
    "definition": "Steigung oder Gefälle eines Gleisabschnitts in Zehntel Promille, bezogen auf die Kilometrierung; kehrt sich in der Gegenrichtung um"
  },
  {
    "term": "Laufweg",
    "code": "Itinerary",
    "definition": "die Folge von Betriebsstellen und Kanten, die eine Zugfahrt befährt"
  },
  {
    "term": "Ledger-Buchung",
    "code": "LedgerEntry",
    "definition": "einzelner, unveränderlicher Posten einer Ledger-Transaktion, in Integer-Cent"
  },
  {
    "term": "Ledger-Konto",
    "code": "LedgerAccount",
    "definition": "benanntes Konto in den Büchern genau eines EVU"
  },
  {
    "term": "Ledger-Transaktion",
    "code": "LedgerTransaction",
    "definition": "unveränderliche Hülle einer doppelten Buchung; die Summe ihrer Ledger-Buchungen ist zwingend null"
  },
  {
    "term": "Livemap",
    "code": "LiveMap",
    "definition": "öffentliche Echtzeitkarte des Verkehrs; vollständig transparent nach E9"
  },
  {
    "term": "Livemap-Detailkatalog",
    "code": "SQLiteLivemapReadModel",
    "definition": "releasegebundene, öffentliche SQLite-Projektion für anklickbare Infrastrukturdetails, Bahnhofstafel und FIS; wird read-only und per Einzelabfrage gelesen"
  },
  {
    "term": "Los",
    "code": "Lot",
    "definition": "ausgeschriebenes Leistungspaket eines Aufgabenträgers"
  },
  {
    "term": "Löschung (Datenschutz)",
    "code": "eraseAccountData",
    "definition": "anonymisiert Anzeigename und Zeitstempel eines Kontos und entzieht den Weltzugang; Konto und Betriebshistorie bleiben bestehen (E8)"
  },
  {
    "term": "Manuelle Störung",
    "code": "ManualDisruption",
    "definition": "hochriskanter, Odoo-vorbereiteter Antrag mit Beginn, Ende, Ursache, betroffenen Ressourcen und deklarierter Wirkung; vor M8.3 keine Simulationswirkung"
  },
  {
    "term": "Marktverfügbarkeit",
    "code": "MarketAvailability",
    "definition": "dokumentiertes oder ausdrücklich geschätztes Zeitfenster, in dem ein Fahrzeugtyp als Neubau, Leasing- oder Gebrauchtfahrzeug angeboten wird"
  },
  {
    "term": "Mindestzugfolgezeit",
    "code": "MinimumHeadway",
    "definition": "kleinster zeitlicher Abstand zweier Zugfahrten derselben Richtung; folgt aus den Sperrzeiten, ist kein eigener Parameter"
  },
  {
    "term": "Mobilisierungsphase",
    "code": "MobilisationPhase",
    "definition": "Zeit zwischen Zuschlag und Betriebsaufnahme; nachweispflichtig auf Fahrzeuge, Personal und Trassen"
  },
  {
    "term": "Nachricht (Postfach)",
    "code": "MailboxMessage",
    "definition": "generischer Postfach-Eintrag mit messageType und payload; trägt später Trassenangebote, Ausschreibungen, Störungsmeldungen"
  },
  {
    "term": "Netzfahrplan",
    "code": "NetworkTimetable",
    "definition": "das veröffentlichte Ergebnis eines Planungslaufs für eine Fahrplanperiode"
  },
  {
    "term": "Netzfilter",
    "code": "filter_network",
    "definition": "wählt aus dem Rohgraph das EBO-Netz aus — railway=rail in Regelspur, ohne Stromschiene"
  },
  {
    "term": "Notvergabe",
    "code": "EmergencyAward",
    "definition": "auf zwei Perioden befristete Übernahme durch den Eigenbetrieb nach gescheiterter Ausschreibung"
  },
  {
    "term": "Nutzlänge",
    "code": "usable_length",
    "definition": "der Teil eines Gleises oder Bahnsteigs, auf dem Fahrzeuge stehen dürfen; begrenzt die zulässige Formation"
  },
  {
    "term": "Odoo-Projektion",
    "code": "OdooProjectionEnvelope",
    "definition": "minimaler, versionierter und idempotenter Game-zu-Odoo-Datensatz mit Welt, Datenstand und Korrelation; keine zweite fachliche Wahrheit"
  },
  {
    "term": "Öffnungszeit",
    "code": "OpeningHours",
    "definition": "durchgehende oder tägliche Zeitspanne, in der eine Anlage nutzbar ist"
  },
  {
    "term": "Outbox",
    "code": "odooProjectionOutbox",
    "definition": "im selben Commit wie der Game-Zustand geschriebene, erneut zustellbare Projektion an Odoo; sie liegt nie im Simulationspfad"
  },
  {
    "term": "Persistenter Fahrzeugmarkt",
    "code": "PersistentVehicleMarket",
    "definition": "weltgebundene Zustandsmaschine für konkrete Fahrzeuge, Startbestand, Serververmieter, Leasingrücklauf, Gebrauchtmarkt und kanonischen Replay-Hash"
  },
  {
    "term": "Planungslauf",
    "code": "PlanningRun",
    "definition": "deterministische, gemeinsame Behandlung aller Trassenanträge eines Planungsfensters"
  },
  {
    "term": "Pönale",
    "code": "Penalty",
    "definition": "vertragliche Sanktion für Qualitätsmängel; wirkt bis zum letzten Tag der Vertragslaufzeit"
  },
  {
    "term": "Postfach",
    "code": "mailboxMessages",
    "definition": "Grundgerüst für Nachrichten, Fristen und Quittierung eines Kontos in einer Welt"
  },
  {
    "term": "Präqualifikation",
    "code": "Prequalification",
    "definition": "Eignungsnachweis eines Spielers aus seiner Betriebshistorie in dieser Welt"
  },
  {
    "term": "Prüfhorizont",
    "code": "horizon_days",
    "definition": "wie viele Tage ein Verkehrsangebot vorausschauend materialisiert und geprüft wird; eine Woche deckt jedes Verkehrstagemuster genau einmal ab"
  },
  {
    "term": "Qualitätsklasse",
    "code": "QualityClass",
    "definition": "A (validiert), B (konservativ) oder C (unzureichend); die höchste Klasse, die ein Vertrauensgrad datenseitig trägt"
  },
  {
    "term": "Quellenregister",
    "code": "SourceRegister",
    "definition": "maschinenlesbares Verzeichnis aller Datenquellen mit Freigabestatus, Lizenz und Bereitstellungsweg; die geprüfte Wahrheit des Rechte-Gates"
  },
  {
    "term": "Quittierung",
    "code": "acknowledgeMessage",
    "definition": "Bestätigung des Empfängers, eine Postfach-Nachricht gesehen zu haben; nur der Empfänger selbst quittiert"
  },
  {
    "term": "Rahmenvertrag",
    "code": "FrameworkAgreement",
    "definition": "mehrperiodige Kapazitätszusage, gedeckelt zum Schutz gegen Landgrab"
  },
  {
    "term": "Rangieren",
    "code": "Shunting",
    "definition": "Fahrzeugbewegung ohne Zugfahrt; ausschließlich automatisiert, als Zeitbedarf und kurze Belegung verrechnet"
  },
  {
    "term": "Räumfahrzeit",
    "code": "ClearingTime",
    "definition": "Anteil der Sperrzeit, in dem der Zug mit voller Länge den Abschnitt und den Durchrutschweg räumt"
  },
  {
    "term": "Rechte-Gate",
    "code": "RightsGate",
    "definition": "Durchsetzung von Invariante 8: kein Import ohne dokumentierte Freigabe der Datenquelle"
  },
  {
    "term": "Reconciliation-Aufgabe",
    "code": "ReconciliationTask",
    "definition": "auditierte Korrekturaufgabe aus dem nächtlichen Abgleich stabiler Bridge-IDs und Hashes; überschreibt keine Daten still"
  },
  {
    "term": "Referenzkorpus",
    "code": "ReferenceCorpus",
    "definition": "Versionierte Vergleichsgrundlage einer Region: technische Referenzen für Fahrdynamik sowie davon getrennte veröffentlichte Fahrplanwerte und Haltezeiten; Herkunft und Verwendungszweck jeder Größe bleiben explizit"
  },
  {
    "term": "Referenzlauf",
    "code": "ReferenceRun",
    "definition": "ein Fahrweg mit Zugcharakteristik und explizit benannter Vergleichsgröße — technische Laufzeit oder Fahrplanzeit dürfen nicht vermischt werden"
  },
  {
    "term": "Regelgrenze",
    "code": "LimitKind",
    "definition": "konkrete betriebliche Zulässigkeitsprüfung einer Dispositionsmaßnahme, etwa Kapazität, Streckenkenntnis, Fahrzeug, Personal, Vertrag oder Kosten"
  },
  {
    "term": "Regionsübergabe",
    "code": "RegionHandover",
    "definition": "Übergang einer Zugfahrt zwischen zwei regionalen Single-Writer-Prozessen, mit Bestätigung"
  },
  {
    "term": "Reise- oder Fahrtkette",
    "code": "JourneyChain",
    "definition": "ein durchgehender Zuglauf aus bestellbaren regionalen und nicht disponierbaren äußeren Abschnitten; Identität, Fahrzeug- und Personalbindung bleiben erhalten"
  },
  {
    "term": "Reisezugwagen",
    "code": "VehicleRole::Coach",
    "definition": "nicht angetriebenes Fahrzeug für Fahrgäste; kann Teil eines Wagenparks sein, aber keine eigene Zugfahrt bilden"
  },
  {
    "term": "Rohgraph",
    "code": "RawGraph",
    "definition": "Topologie, Geometrie und Tags eines OSM-PBF-Extracts, roh und ungefiltert; Ergebnis der Import-Pipeline, noch kein Betriebsgraph"
  },
  {
    "term": "Rohkante",
    "code": "RawEdge",
    "definition": "Wegabschnitt des Rohgraphen zwischen zwei bedeutsamen Knoten, mit voller Geometrie und den Tags seines OSM-Wegs"
  },
  {
    "term": "Rohknoten",
    "code": "RawNode",
    "definition": "betrieblich bedeutsamer Punkt des Rohgraphen — Anfang, Ende oder Verzweigung eines Wegs, oder selbst railway-getaggt"
  },
  {
    "term": "Rolle",
    "code": "Role",
    "definition": "player oder world_admin; ein Konto kann mehrere Rollen innerhalb derselben Welt gleichzeitig tragen"
  },
  {
    "term": "Rücktest",
    "code": "BacktestResult",
    "definition": "hypothetische Auswertung einer Betriebsprogramm-Version gegen historische Ereignisfakten ohne Änderung von Event-Log oder Simulationszustand"
  },
  {
    "term": "Schaffnersitzung",
    "code": "ConductorSessionV1",
    "definition": "exklusive autorisierte Sitzung eines Spielers in einem eigenen aktiven SPNV-Zug; projiziert den Weltzustand und nimmt typisierte Kontrollkommandos an"
  },
  {
    "term": "Schichtentrennung",
    "code": "LayerSeparation",
    "definition": "Trennung von Code, Daten und Marke; die proprietären Schichten bleiben aus dem öffentlichen Repositorium"
  },
  {
    "term": "Schienenersatzverkehr",
    "code": "RailReplacementService",
    "definition": "vertragliche Ersatzleistung bei Sperrung; Kostenposten und Bewertungsfaktor, kein eigener Fuhrpark"
  },
  {
    "term": "Server-Leasingangebot",
    "code": "ServerLeaseQuote",
    "definition": "deterministisches Angebot eines fiktiven servereigenen Vermieters für ein konkretes Fahrzeug; der Preis liegt strikt über dem vergleichbaren Marktpreis"
  },
  {
    "term": "Signal",
    "code": "Signal",
    "definition": "Haupt-, Vor- oder Blockkennzeichen an einer Position entlang eines Gleises; nur blockbegrenzende Kennzeichen gehen in die Blockableitung ein"
  },
  {
    "term": "Signalsichtzeit",
    "code": "SignalSightingTime",
    "definition": "Anteil der Sperrzeit zwischen dem Erkennen des Vorsignals und dem Vorsignal selbst"
  },
  {
    "term": "Simulationszeit",
    "code": "SimTime",
    "definition": "Sekunden seit Weltepoche; expliziter Wert, niemals aus der Systemuhr gelesen"
  },
  {
    "term": "Sperrzeit",
    "code": "BlockingTime",
    "definition": "Zeitspanne, in der eine Konfliktressource für eine Zugfahrt gesperrt ist — Fahrstraßenbildung, Annäherung, Fahrzeit, Räumung, Auflösung"
  },
  {
    "term": "Sperrzeitentreppe",
    "code": "BlockingTimeStaircase",
    "definition": "die treppenförmige Darstellung aufeinanderfolgender Sperrzeiten im Bildfahrplan"
  },
  {
    "term": "Sperrzeitparameter",
    "code": "SignallingParameters",
    "definition": "Signalsichtzeit, Vorsignalabstand, Durchrutschweg und Stellwerksbauart einer Betriebsstelle — die Werte, aus denen die sechs Anteile der Sperrzeit entstehen"
  },
  {
    "term": "Spurweite",
    "code": "TrackGauge",
    "definition": "Abstand der Schienen in Millimetern; das Spielnetz führt ausschließlich Regelspur (E14), der Netzfilter braucht die Angabe zum Aussortieren"
  },
  {
    "term": "Starting-Capital-Policy",
    "code": "StartingCapitalPolicy",
    "definition": "im signierten Weltentwurf festgelegtes Startkapital einer öffentlichen Welt: endliche Integer-Cent, null oder explizit unlimited; niemals eine Startausstattung"
  },
  {
    "term": "Stationsanreicherung",
    "code": "StationEnrichment",
    "definition": "je Betriebsstelle mit Fahrgastwechsel angereicherter Datensatz aus Bahnhofskategorie und Stationsausstattung, mit eigener Herkunft je Feld"
  },
  {
    "term": "Stationsausstattung",
    "code": "StationAmenities",
    "definition": "Menge der an einer Betriebsstelle vorhandenen Ausstattungsmerkmale — Barrierefreiheit, Wetterschutz, Fahrgastinformation und mehr"
  },
  {
    "term": "Stellwerksbauart",
    "code": "InterlockingKind",
    "definition": "mechanisch, elektromechanisch, Relais-, elektronisches oder digitales Stellwerk; entscheidet Fahrstraßenbilde- und Fahrstraßenauflösezeit"
  },
  {
    "term": "Steuerwagen",
    "code": "VehicleRole::ControlCar",
    "definition": "nicht angetriebener Reisezugwagen mit einem oder zwei Steuerständen; ermöglicht bei passender Endlage den Wendezugbetrieb"
  },
  {
    "term": "Störung",
    "code": "Disruption",
    "definition": "ungeplantes Ereignis mit Wirkung auf den Betrieb; Entstehung und Fortpflanzung sind getrennt modelliert"
  },
  {
    "term": "Substream",
    "code": "Substream",
    "definition": "benannter Teilstrom des Weltseeds; ein neuer Strom verändert die bestehenden nicht"
  },
  {
    "term": "Tagesbericht",
    "code": "DailyReport",
    "definition": "asynchrone Rückmeldung an den Spieler: was ist passiert, welche Regel hat wann was getan"
  },
  {
    "term": "Toleranz",
    "code": "Tolerance",
    "definition": "vorab definierte zulässige Abweichung zwischen berechneter und gleichartig definierter Referenzzeit — absoluter Sockel und relativer Anteil, der größere gilt"
  },
  {
    "term": "Trasse",
    "code": "TrainPath",
    "definition": "zugewiesenes Recht, einen Laufweg zu einer Zeitlage zu befahren"
  },
  {
    "term": "Trassenantrag",
    "code": "PathRequest",
    "definition": "Antrag auf eine Trasse mit Zugcharakteristik, Verkehrstagen, Halten, Wunschzeiten und zulässigen Abweichungen"
  },
  {
    "term": "Trassenkandidat",
    "code": "PathCandidate",
    "definition": "ein gegen das Belegungsbuch geprüftes Verkehrsangebot samt seiner Abweichung vom Trassenantrag"
  },
  {
    "term": "Tutorialbegleiter",
    "code": "TutorialDialogue",
    "definition": "versionierter, reproduzierbarer Hinweis von Lutz mit Trigger, Handlung, optionalem Warum und Zielbereich; keine generative Laufzeit-KI"
  },
  {
    "term": "Tutorialsitzung",
    "code": "TutorialSession",
    "definition": "Bindung genau eines öffentlichen Weltkontos an eine private, ungewertete, beschleunigte und kurzlebige Tutorialwelt mit externer tut_…-Referenz"
  },
  {
    "term": "Tutorialtemplate",
    "code": "TutorialTemplate",
    "definition": "unveränderliches, versioniertes und gehashtes Minimalartefakt für Korridor, Inventar, Dialoge, Zeitgrenzen und stets endliches Tutorialkapital"
  },
  {
    "term": "Umlauf",
    "code": "VehicleRotation",
    "definition": "die Folge von Zugfahrten, die ein Fahrzeug oder eine Formation nacheinander leistet"
  },
  {
    "term": "Vergabekalender",
    "code": "TenderCalendar",
    "definition": "beim Weltstart erzeugte, veröffentlichte Verteilung der Erstvergaben über die erste Welthälfte"
  },
  {
    "term": "Vergabeprofil",
    "code": "TenderProfile",
    "definition": "deterministisch aus dem Seed gezogene, vorab veröffentlichte Kombination von Anforderungs- und Wertungshebeln einer Ausschreibung; sorgt dafür, dass eine Angebotsschablone nicht auf jedes Los passt"
  },
  {
    "term": "Verkehrsangebot",
    "code": "ServicePattern",
    "definition": "wiederkehrender Verkehr als eine Zeile: Zugnummer, Zugcharakteristik, Laufweg, Abfahrtszeit, Verkehrstage — plus relativem Belegungsprofil"
  },
  {
    "term": "Verkehrstage",
    "code": "OperatingDays",
    "definition": "die Tage, an denen ein wiederkehrendes Verkehrsangebot tatsächlich fährt"
  },
  {
    "term": "Verkehrsvertrag",
    "code": "ServiceContract",
    "definition": "Vertrag zwischen Aufgabenträger und EVU über ein Los, mit Entgelt, Bonus, Pönale und Nachweisen"
  },
  {
    "term": "Vermieterprofil",
    "code": "LessorProfile",
    "definition": "weltgebundenes, veröffentlichtes Profil eines fiktiven servereigenen Vermieters mit Präferenzen und deterministischer Preiskalkulation"
  },
  {
    "term": "Verspätung",
    "code": "Delay",
    "definition": "Abweichung von der Soll-Zeitlage; propagiert regelbasiert über Anschlüsse und Umläufe"
  },
  {
    "term": "Verspätungsursachencode",
    "code": "DelayCauseCode",
    "definition": "zweistellige Hauptkennung mit Kurztext, Ursachentyp und spielmechanischer Verantwortungsgruppe; getrennt von RIS-Abweichungscodes"
  },
  {
    "term": "Vertrauensgrad",
    "code": "Confidence",
    "definition": "wie belastbar ein Attributwert ist — erfasst, abgeleitet oder angenommen; Grundlage der Qualitätsklassen"
  },
  {
    "term": "Vier-Augen-Prinzip",
    "code": "FourEyesApproval",
    "definition": "Hochrisikoaktion mit getrennten Personen für Antrag und Freigabe; das Game prüft die Trennung vor der Wirkung erneut"
  },
  {
    "term": "Virtueller Fahrdienstleiter",
    "code": "VirtualDispatcher",
    "definition": "regionale serverautoritative Dispositionslogik über gemeinsame Konfliktressourcen mit erklärbarer lexikographischer Reihenfolge"
  },
  {
    "term": "Vmax-Band",
    "code": "SpeedLimit",
    "definition": "die zulässigen Geschwindigkeiten eines Gleisabschnitts — Regel, Neigetechnik, Güterzug; als Band eines Bandprofils geführt"
  },
  {
    "term": "Wagenpark",
    "code": "UnpoweredFormation",
    "definition": "Formation ohne eigene Traktion; bleibt in Werkstatt oder Abstellung und wird für Überführungen von einer Lok bewegt"
  },
  {
    "term": "Weiche",
    "code": "Switch",
    "definition": "Fahrwegverzweigung; Konfliktressource, weil kreuzende Bewegungen sich ausschließen"
  },
  {
    "term": "Weichenlage",
    "code": "SwitchPosition",
    "definition": "Grundstellung oder abzweigende Lage einer Weiche in einer Fahrstraße"
  },
  {
    "term": "Welt",
    "code": "World",
    "definition": "vollständig isolierte Instanz von Netz, Wirtschaft und Spielern; Wurzel der Mandantentrennung, jede andere Tabelle trägt ihre world_id (Invariante 4)"
  },
  {
    "term": "Weltprofil",
    "code": "WorldProfile",
    "definition": "die Parameter einer Welt: Laufzeit, Periodenlänge, Vertragslaufzeit, Ausschreibungsvorlauf"
  },
  {
    "term": "Weltseed",
    "code": "WorldSeed",
    "definition": "Seed einer Welt für eine Fahrplanperiode; Grundlage aller benannten Substreams"
  },
  {
    "term": "Weltstartbestand",
    "code": "WorldStarterFleet",
    "definition": "optionaler, vor Weltenstart auditierter und danach unveränderlicher Pool konkreter Gebrauchtfahrzeuge"
  },
  {
    "term": "Weltzugang",
    "code": "worldAccesses",
    "definition": "das Recht eines Keycloak-Subjects, in einer Welt aufzutreten — getrennt vom Konto, damit ein Entzug dessen Betriebshistorie nicht mit sich reißt"
  },
  {
    "term": "Wendezeit",
    "code": "TurnaroundTime",
    "definition": "Mindestzeit zwischen Ankunft und Abfahrt derselben Formation am Endpunkt"
  },
  {
    "term": "Wertungsgewichtung",
    "code": "ScoringWeights",
    "definition": "das im Vergabeprofil festgelegte Verhältnis von Preis- zu Qualitätspunkten einer Ausschreibung; aus dem EconomyRelease"
  },
  {
    "term": "Wirtschafts-Release",
    "code": "EconomyRelease",
    "definition": "versioniertes, je Welt gepinntes Artefakt mit allen Entgelten und Kostensätzen"
  },
  {
    "term": "Zeitlage",
    "code": "departure_time_s",
    "definition": "die Abfahrtszeit eines Verkehrsangebots als Sekunde des Tages; alle Sperrzeiten des Belegungsprofils zählen relativ zu ihr"
  },
  {
    "term": "Zugcharakteristik",
    "code": "TrainCharacteristics",
    "definition": "Masse, Länge, Vmax, Anfahr- und Bremsvermögen, Antriebsart, Zugsicherung — entkoppelt die Planung vom Fahrzeugkatalog"
  },
  {
    "term": "Zugfahrt",
    "code": "TrainRun",
    "definition": "die einzelne, materialisierte Fahrt eines Zuges an einem Verkehrstag"
  },
  {
    "term": "Zugfolgefall",
    "code": "Headway",
    "definition": "Belegungskonflikt zweier Zugfahrten derselben Richtung auf demselben Abschnitt; die Mindestzugfolgezeit ist unterschritten"
  },
  {
    "term": "Zuggattung",
    "code": "TrainCategory",
    "definition": "Fernverkehr, S-Bahn, Regionalverkehr, Güterverkehr oder Dienstzug; bestimmt den Nummernbereich der Zugnummer"
  },
  {
    "term": "Zugkartenprojektion",
    "code": "SQLiteTrainMapProjector",
    "definition": "read-only, releasegebundene Laufzeitprojektion: liefert Exact nur auf eindeutig nachgewiesenem Gleis und Estimate getrennt auf einem erlaubten Darstellungspfad; kein Rückfluss in Betrieb, Bestellbarkeit oder Qualität"
  },
  {
    "term": "Zugkilometer",
    "code": "TrainKilometre",
    "definition": "Leistungseinheit der Verkehrsverträge und Bezugsgröße des Bestellerentgelts"
  },
  {
    "term": "Zugkreuzung",
    "code": "TrainCrossing",
    "definition": "Begegnung zweier Zugfahrten entgegengesetzter Richtung auf eingleisiger Strecke; nur in einer Betriebsstelle mit Kreuzungsmöglichkeit zulässig"
  },
  {
    "term": "Zugnummer",
    "code": "TrainNumber",
    "definition": "die Nummer einer Zugfahrt; nennt über ihren Bereich die Zuggattung und über ihre Parität die Richtung — gerade mit, ungerade gegen die Kilometrierung"
  },
  {
    "term": "Zugsicherung",
    "code": "TrainProtection",
    "definition": "streckenseitige und fahrzeugseitige Sicherungstechnik; begrenzt, welche Formation wo fahren darf"
  },
  {
    "term": "Zugsicherungsoption",
    "code": "ProtectionOption",
    "definition": "am exakten Fahrzeugtyp belegte, zeitgebundene Werksoption oder Werkstattnachrüstung; Serienausrüstung ist keine Option"
  },
  {
    "term": "Zulässige Abweichung",
    "code": "PathTolerances",
    "definition": "wie weit ein Trassenantrag sich verschieben, wie viel Fahrzeit er verlieren und wie viele Betriebshalte er vertragen darf"
  },
  {
    "term": "Zusatzfahrt",
    "code": "SupplementaryRun",
    "definition": "Zuführungs-, Werkstatt-, Versorgungs- oder Abstellfahrt; ein echter Zug mit Trasse, Personal und Kosten"
  },
  {
    "term": "Zuschlag",
    "code": "Award",
    "definition": "Entscheidung über eine Ausschreibung; fällt deterministisch sofort bei Fristende"
  },
  {
    "term": "Zustands-Hash",
    "code": "StateHash",
    "definition": "kanonischer, plattformunabhängiger Hash eines Simulationszustands"
  }
]);
