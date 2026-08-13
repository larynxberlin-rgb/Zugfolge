# Betrieb: Disposition, Flotte, Versorgung, Störungen

## 1. Betriebsprogramm — das Dispo-Regelwerk (E2)

Der Kern des Spiels und die Antwort darauf, was ein Spieler an einem
gewöhnlichen Abend tut. Jedes EVU besitzt ein Betriebsprogramm: eine
priorisierte Regelmenge, die der Simulationskern ausführt — unabhängig davon, ob
der Spieler online ist.

```text
Regel := Auslöser + Bedingungen + Maßnahme + Grenzen + Priorität
```

**Auslöser:** Verspätungsschwelle, Anschlussgefährdung, Fahrzeugstörung,
Personaldienstüberschreitung, Streckensperrung, Bahnsteigwechsel,
Wendezeitunterschreitung, Trassenkonflikt in der Ad-hoc-Vergabe.

**Maßnahmen:** Anschluss halten oder brechen, Halt auslassen, Zug vorzeitig
wenden, Zug kürzen oder verstärken, Fahrt ausfallen lassen, Reserveumlauf
aktivieren, Ersatzfahrzeug zuführen, Umleitung beantragen, Trasse zurückgeben,
Ersatzverkehr auslösen.

**Grenzen — das ist der Realismus.** Jede Maßnahme muss betrieblich zulässig
sein. Eine Umleitung braucht freie Kapazität *und* Streckenkenntnis des Personals
*und* passende Zugsicherung. Eine Verstärkung braucht ein verfügbares,
fristgerechtes Fahrzeug *und* Personal in Reichweite. Regeln, die das verletzen,
greifen nicht — und sagen im Bericht, warum.

**Fairness-Invariante:** Manueller Eingriff überschreibt eine konkrete
Einzelentscheidung, gewährt aber niemals einen mechanischen Bonus.

**Oberfläche:** Bedingungsbaum, kein Freitext-Code. Dazu zwei Dinge, die den
Loop tragen:

- **Backtesting** — „Was hätte dieses Regelwerk an meinen letzten sieben
  Betriebstagen getan?“ Läuft gegen das Event-Log, kostet keine
  Simulationszeit.
- **Vorlagen** — „konservativ pünktlich“, „anschlussorientiert“,
  „umlaufschützend“. Neulinge sind ab Minute eins betriebsfähig und lernen durch
  Anpassen statt durch Lesen.

Die Regel-Engine hängt an der Dispositionsschnittstelle des Simulationskerns
(→ `infrastruktur.md`).

## 2. Fahrzeuge und Personal

- Fahrzeuge sind individuelle, weltgebundene und persistente Assets mit
  Baureihe, Antrieb, Länge, Masse, Leistung, Höchstgeschwindigkeit,
  Zugsicherung, Zulassung, Wartungsfristen, Eigentumsstatus, Zustandsprofil und
  Lebenslauf. Ein in die Welt eingebrachtes Fahrzeug wird nicht erneut erzeugt:
  Es wechselt nur zwischen Betrieb, Abstellung, Werkstatt, Vermietern,
  Gebrauchtmarkt und endgültiger Ausmusterung.
- Formationen werden aus Fahrzeugen gebildet. Für eine Zugfahrt erhalten sie
  aus ihrer tatsächlichen Masse und Bremsstellung ein signiertes,
  ganzzahliges **Fahrprofil**; erst damit werden sie auf eine
  **Zugcharakteristik** abgebildet (→ `infrastruktur.md`) und gegen Strecke,
  Bahnsteig, Elektrifizierung und Zugsicherung geprüft. Eine Lokomotive hat
  dabei keine pauschale Beschleunigung unabhängig von ihrem Wagenpark.
- Personal wird als regionaler Qualifikations- und Dienstkapazitätspool
  modelliert; einzelne Mitarbeiterbiografien sind nicht Teil der ersten Version.
- Dienst-, Wartungs-, Abstell- und Fahrzeugumlaufkonflikte verhindern die
  Freigabe eines nicht durchführbaren Fahrplans.
- Sicherheits- und Offline-Disposition bleibt für alle Spieler kostenlos.

### 2.1 Fahrzeugkatalog, Weltepochen und Markt (M5.1)

Der `VehicleCatalogRelease` ist ein unveränderliches, versioniertes Artefakt.
Er trennt die **faktische Baureihenbezeichnung** vom **fiktiven Handelsnamen**
(E6), nennt den beidseitig eingeschlossenen Bauzeitraum und führt Neubau,
Leasing und Gebrauchtmarkt als drei getrennte Zeitfenster. Jedes Marktfenster
kennzeichnet, ob es dokumentiert oder eine ausdrückliche Spielannahme ist.
Gerade Leasing- und Gebrauchtendjahre dürfen für das Balancing geschätzt werden;
sie werden dadurch nicht als historische Tatsache ausgegeben.

Die Welteinstellung führt zwei unabhängige Epochen:

| Einstellung | Prüft | Beispiel |
|-------------|-------|----------|
| **Bau-Epoche** | tatsächliches Baujahr des einzelnen Fahrzeugs | Eine Gegenwartswelt kann auch Fahrzeuge aus der Bahnreformzeit zulassen |
| **Beschaffungs-Epoche** | Jahr, in dem das EVU das Fahrzeug übernimmt | Dasselbe ältere Fahrzeug erscheint 2026 nur noch im belegten Leasing-/Gebrauchtfenster |

Beide Epochen können auch auf **alle Jahre** gestellt werden. Ein alter Typ wird
davon nicht neu produzierbar: Der Neubau bleibt zusätzlich auf seinen
dokumentierten Bau- und Marktzeitraum begrenzt. Leasing und Gebrauchtmarkt
liefern ein bereits gebautes, bereits konfiguriertes Fahrzeug. Das
`VehicleAsset` hält deshalb je Einzelfahrzeug Welt, Typ, Bau- und
Beschaffungsjahr, Marktkanal, Eigentum oder Leasing, Zulassungen,
Wartungsfristen, die tatsächlich eingebaute Zugsicherung, Zustandswerte und
einen unveränderlichen Lebenslauf. Ein Lebenslauf beginnt spätestens mit dem
Welteintritt und dokumentiert Halter- und Nutzungswechsel, Leasing,
Wartung/Umbau, Schäden, Ausmusterung und die jeweils wirksamen
Zustandsänderungen. Damit bleibt sowohl die Herkunft eines Gebrauchtfahrzeugs
als auch seine betriebliche Geschichte nachvollziehbar.

Die historische Bauzeit des Typs bleibt stets unverändert. Für einen Typ, dessen
Bauende vor dem Weltsichtjahr liegt, wählt die Welt eine der folgenden Regeln:

| Altfahrzeugregel | Wirkung |
|------------------|---------|
| **Nur Gebrauchtmarkt** | Nur bereits gebaute Einzelstücke dürfen über den Gebrauchtkanal beschafft werden. |
| **Neubau fortsetzen** | Eine ausdrückliche kontrafaktische Weltannahme erlaubt Neubau über das reale Bauende hinaus. Werksoptionen entsprechen dabei dem letzten belegten Serienstand; die reale Bauzeit wird nicht umgeschrieben. |
| **Nur Epoche** | Die dokumentierten Bau- und Marktfenster gelten unverändert. |
| **Nicht verfügbar** | Der alte Typ ist in keinem Beschaffungskanal verfügbar. |

Leasing und Gebrauchtmarkt liefern grundsätzlich ein bereits gebautes, bereits
konfiguriertes Fahrzeug. Ein Weltenstart kann solche Fahrzeuge als
serverseitiges Leasingangebot enthalten, ohne dass dadurch ein freier
**Gebrauchtkaufmarkt** geöffnet ist: Die simzeitbasierte Marktöffnung sperrt
Kaufangebote bis zum festgelegten Zeitpunkt, nicht die Herkunft oder die
Historie eines Leasingfahrzeugs. Das `VehicleAsset` hält deshalb je
Einzelfahrzeug Welt, Typ, Bau- und Beschaffungsjahr, Marktkanal, Eigentum oder
Leasing, Zulassungen, Wartungsfristen und die tatsächlich eingebaute
Zugsicherung.

Ein früher dokumentierter redaktioneller Arbeitsstand vom 8. August 2026
nannte 48 Fahrzeugtypen und 63 Quellen. Dieser Datenbestand ist im öffentlichen
Checkout nicht reproduzierbar: PR #25 liefert das Katalogschema, individuelle
Assets und fiktive Testtypen, aber keine reale Fahrzeug-Seeddatei. Die reale
Katalogdatei bleibt als proprietäres Weltdatum außerhalb des öffentlichen Baums
(E16). Öffentlich sind nur Schema, Prüfregeln und rein fiktive Testdaten. Die
geprüfte Quellenübergabe liegt lokal im ignorierten
`data/fahrzeugkatalog/alpha-2026-recherche.md`; ihre **Freigegebene
Alpha-Liste** enthält ausschließlich konkrete Varianten mit vollständigen
Engine-Werten. Der anschließende Kandidatenkorpus ist ausdrücklich nicht
freigabefähig.

Die Engine lädt dagegen ausschließlich die ignorierte,
maschinenlesbare Datei
`data/fahrzeugkatalog/alpha-2026-authority-assets.json`. Sie ist ein
`zugfolge-fleet-authority-release-catalog/v1`, bindet die kanonische
Mitteldeutschland-Alpha-Welt an konkrete Einzelassets und wird über
`ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH` fail-closed eingelesen. Die
Recherchedatei ist damit Nachweis und Freigabebasis; die Authority-Datei ist
der tatsächlich ausführbare Startbestand.

### 2.2 Funktionsentscheidung: optionale Zugsicherung

Eine Zugsicherung ist nur dann wähl- oder nachrüstbar, wenn sie für die
**genaue Baureihe oder Unterbaureihe** zumindest an einem Teilbestand real
belegt ist. Eine Beobachtung an einem einzelnen Fahrzeug oder Teilbestand
reicht als Positivbeleg, weil genau daraus die optionale statt serienmäßige
Einordnung folgt. Eine verwandte Baureihe, eine allgemeine Produktbroschüre oder
eine bloß geplante Ausrüstung reicht nicht. Das Release erzwingt hierzu
Quellenbezüge, die den exakten Fahrzeugtyp abdecken.

| Katalogangabe | Spielerentscheidung | Regel |
|---------------|----------------------|-------|
| **Serienausrüstung** | keine | ist immer eingebaut und kann nicht abgewählt oder entfernt werden |
| **Werksoption** (`FactoryOption`) | beim Neukauf | im belegten Optionszeitraum frei wählbar; außerhalb des Zeitraums und auf dem Sekundärmarkt keine kostenlose Umkonfiguration |
| **Nachrüstung** (`Retrofit`) | ausdrücklicher Werkstattumbau | nur am belegten exakten Typ und nur im Freigabezeitraum; bereits eingebaute Systeme bleiben erhalten |

Damit bedeutet „teilweise mit LZB/ETCS ausgerüstet“ weder „alle Fahrzeuge haben
es“ noch „die Baureihe hat es nie“. Beim Neukauf entscheidet der Spieler über
eine belegte Werksoption. Bei Leasing und Gebrauchtkauf wird dagegen die
konkrete Ist-Ausrüstung des angebotenen Fahrzeugs übernommen. Eine spätere
Nachrüstung ist nur zulässig, wenn der Katalog sie für diesen Typ ausdrücklich
belegt; eine Werksoption allein begründet noch keinen Werkstattumbau.

Für die Infrastrukturprüfung gilt die Ausrüstung der aktiven Zugspitze. Fehlt
LZB auf einer Strecke, die sowohl LZB- als auch ortsfeste Signalblöcke führt,
fällt der Zug auf die Signalblöcke zurück; ein reiner LZB-Block bleibt für ihn
unzulässig. Auf einem reinen ETCS-Abschnitt gibt es diese PZB-/Signalblock-
Rückfallebene nicht: Ein Fahrzeug ohne das erforderliche ETCS darf dort nicht
fahren. ETCS-only ist deshalb eine echte Ausnahme von der sonstigen PZB-
Grundausstattung, nicht eine abgeschwächte LZB-Konfiguration.

Das offene Endjahr `9999` bedeutet nach dem frühesten belegten Einbau nur eine
**spielerische Fortschreibung der technischen Einbaubarkeit**, keine
Marktprognose. M5.1 entscheidet über Zulässigkeit und hält den eingebauten
Zustand deterministisch fest. Kosten, Dauer, Werkstattkompetenz und
Anlagenbelegung werden erst mit M5.7 und M5.14 an den Umbau gebunden.

### 2.3 Wagenparks, Steuerwagen und Rangierzeiten

Ein Reisezugwagen ist ein gültiges, nicht angetriebenes Fahrzeugasset. Ein
Steuerwagen ist ebenfalls nicht angetrieben, besitzt aber mindestens einen
Steuerstand. Beide dürfen gemeinsam einen Wagenpark bilden, der in der
Werkstatt oder Abstellung ohne Lok bestehen bleibt. Ohne angetriebenes
Fahrzeug darf dieser Wagenpark jedoch keine eigene Zugfahrt bilden; für eine
Überführung in die Werkstatt oder Abstellung wird eine geeignete Lok
angekuppelt und danach wieder abgekuppelt.

Ein Wendevorgang ohne Lokumsetzen verlangt einen Führerstand am vorderen und am
hinteren Ende der Formation. Fehlt der hintere Steuerstand, muss die Lok den
Wagenpark im Bahnhof oder in der Betriebsstelle umfahren. Das ist eine
Rangierbewegung mit eigener Zeit- und Infrastrukturbelegung, kein kostenloser
Richtungswechsel. Kupplungs- und Entkupplungszeiten sowie die erforderliche
Bremsprobe gehören bei jeder solchen Maßnahme in den Plan.

Die Rechts- und Betriebsquellen legen die auslösenden Ereignisse fest, aber
keine universelle Sekundenzahl für jede Betriebsstelle: Die EBO verlangt eine
Wiederholung der Bremsprobe nach Führerstandswechsel sowie nach Ergänzen oder
Trennen des Zuges, mit der Ausnahme des bloßen Abhängens am Zugschluss. Die DB
Fahrdienstvorschrift definiert einen Zug erst nach ordnungsgemäßem Kuppeln,
wagentechnischer Behandlung und erforderlicher Bremsprobe als vorbereitet.
Eine veröffentlichte Studie der Breisgau-S-Bahn misst für das Aufkuppeln im
Mittel 3:18 Minuten und für das Entkuppeln 1:56 Minuten; die angesetzten
Fahrplanwerte liegen bei vier bzw. drei Minuten. Daraus leitet die Simulation
folgende konservative, ganzzahlige Standardwerte ab:

| Vorgang | Standardwert | Einordnung |
|---|---:|---|
| Kuppeln | 180 s | technischer Kuppelvorgang; örtliche Fahrweg- und Kommunikationszeit kommt hinzu |
| Entkuppeln | 120 s | technischer Mindestwert; bei ungünstiger Zugänglichkeit muss die Betriebsstelle erhöhen |
| vereinfachte Bremsprobe | 60 s + 30 s je Fahrzeug | nach Zusammensetzungsänderung |
| volle Bremsprobe | 120 s + 45 s je Fahrzeug | nach Inbetriebnahme oder maßgeblichem Führerstandswechsel |
| Lok umsetzen | 300 s | konservative Alpha-Annahme; abhängig von Fahrweg, Personal und Bahnhof |

Die Werte sind in crates/zugfolge-fleet/src/operations.rs als versionierbare
Regelkonstanten gekapselt. Die Zeitberechnung führt Kuppeln, Entkuppeln,
Bremsprobe und Lokumsetzen getrennt aus, damit eine Betriebsstelle oder ein
späteres Release sie anhand eigener Messwerte überschreiben kann. Ein bloßes
Abhängen am Zugschluss löst nach der EBO-Ausnahme keine zusätzliche Bremsprobe
aus; ein Führerstandswechsel löst dagegen eine volle Bremsprobe aus.

Quellen:

- [EBO, Bremsprobe und Zugtrennung](https://www.gesetze-im-internet.de/ebo/BJNR215630967.html)
- [DB Fahrdienstvorschrift Ril 408.8321, Zug vorbereiten](https://www-ecm-pu.deutschebahn.com/resource/blob/1357408/e015a4fc6fa4181f4462b81b22fda238/rw_408-81-89-data.pdf)
- [ZRF/Ramboll, Studie zur Breisgau-S-Bahn, Tabelle 4](https://zrf.de/wp-content/uploads/2023/11/231213_TOP7_BSB.pdf)
- [Bayerische Eisenbahngesellschaft, Untersuchung Illertalbahn](https://beg.bahnland-bayern.de/files/media/corporate-portal/imports/planung/infrastrukturprojekte/gutachten_illertalbahn_ulm/endbericht-gutachten-illertalbahn.pdf)

## 3. Fahrzeugkonfiguration (E20)

Fahrzeuge werden beim Hersteller **konfiguriert bestellt**, nicht aus einem
Katalog gekauft. Die Konfiguration ist eine der interessantesten Entscheidungen
des Spiels, weil sie in drei Richtungen gleichzeitig wirkt: Kapazität,
Fahrgastbewertung und **Betrieb**.

### 3.1 Was konfiguriert wird

| Merkmal | Wirkung |
|---------|---------|
| Sitzplätze 1. und 2. Klasse | Kapazität je Klasse; im SPNV oft klein oder ganz entfallend |
| Bestuhlungsdichte | eng = mehr Sitze, schlechtere Bewertung; weit = weniger Sitze, bessere |
| Sitzart und Anordnung | Reihe, Vis-à-vis, Klapp- und Stehplätze — Komfort gegen Kapazität |
| Mehrzweckbereich | Fahrrad-, Kinderwagen- und Rollstuhlplätze; kostet Sitze, wird häufig ausgeschrieben |
| **Türanzahl und -breite** | kürzere Haltezeit, dafür weniger Sitzplätze |
| Toiletten, barrierefrei | Pflichtmerkmal auf längeren Laufwegen |
| Klimatisierung, WLAN, Steckdosen, Fahrgastinformation | Ausstattungsstufen, Bewertungswirkung |

### 3.2 Der Zielkonflikt ist der Kern

Türen sind der wichtigste Zusammenhang und der am wenigsten offensichtliche:
**mehr und breitere Türen verkürzen die Haltezeit**, das verbessert Fahrzeit und
Pünktlichkeit — und kostet Sitzplätze. Damit greift die Fahrzeugkonfiguration
direkt in die Simulation ein und ist keine Zahlenkosmetik.

Daraus folgt, dass es **keine allgemein beste Konfiguration** gibt (E11): Eine
dichte S-Bahn-Linie mit kurzen Abständen will viele Türen und Stehplätze; ein
Regional-Express über neunzig Minuten will Sitze und Komfort. Dieselbe Baureihe
unterschiedlich konfiguriert passt auf unterschiedliche Lose — die Flotte wird
dadurch zum strategischen Vermögenswert statt zur Handelsware.

### 3.3 Ausschreibungen geben Rahmen vor

Eine Ausschreibung kann Mindestsitzplätze je Zug, einen Anteil oder Ausschluss
der 1. Klasse, Barrierefreiheit, Rollstuhl- und Fahrradstellplätze,
Klimatisierung oder Fahrgastinformation fordern. Wer darüber hinausgeht,
sammelt Wertungspunkte — und zahlt dafür.

### 3.4 Umbau in der Werkstatt

Fahrzeuge sind **nicht** auf ihre Erstkonfiguration festgelegt. Ein Umbau kostet
Geld und Werkstattzeit und belegt dabei eine Anlage — er läuft also durch
dieselbe Konfliktengine wie alles andere.

| Umbaubar | Baulich fest |
|----------|--------------|
| Bestuhlung, Dichte, Sitzart | Türanzahl und -position |
| Klassenaufteilung | Wagenkastenlänge, Achsfolge |
| Mehrzweckbereiche | Antrieb, Höchstgeschwindigkeit |
| Ausstattung: WLAN, Steckdosen, Information | serienmäßige Zugsicherungsgrundausrüstung |

Nicht serienmäßige Zugsicherung ist der einzige bewusst enger geregelte
Sonderfall: Sie ist nicht frei umbaubar, sondern folgt der typgenauen
Werksoptions-/Nachrüstungsentscheidung aus Abschnitt 2.2.

Die Trennung gibt der Erstbestellung bleibendes Gewicht: Wer die Türen falsch
wählt, korrigiert das nie. Sie erzeugt zugleich einen echten Sekundärmarkt —
ein Gebrauchtfahrzeug mit passender Grundauslegung ist deutlich mehr wert.

**Umsetzung M5.1a/M5.1b:** `crates/zugfolge-fleet` bildet feste
`StructuralConfiguration` und umbaubare `InteriorConfiguration` als getrennte
Typen ab. Die Mindesthaltezeit teilt den Fahrgastwechsel ganzzahlig und
aufrundend durch die gesamte lichte Türbreite einer Fahrzeugseite. Ein
`WorkshopSchedule` nimmt Umbauten nur in passenden Werkstätten innerhalb der
Öffnungszeit und freien Kapazität an. Bei Fertigstellung belastet der
`ConversionLedger` die Kosten, bevor der Innenraum übernommen wird; ein
fehlgeschlagener Ledger-Aufruf lässt Fahrzeug und Auftrag unverändert. Die
Belegung ist ein spezialisierter Vorgriff für Umbauten; die gemeinsame
Konfliktengine für alle Anlagenbelegungen folgt weiterhin mit M5.7.

### 3.5 Beschaffungswege und Tempo

| Weg | Lieferzeit | Rolle |
|-----|-----------|-------|
| **Leasing** | sofort | Standardkonfiguration von Leasinggesellschaften. Der Weg für kurzfristigen Bedarf und für Einsteiger |
| **Gebrauchtmarkt** | kurz | vorhandene Konfiguration und vorhandener Fristenstand — passt oder passt nicht |
| **Neubestellung** | mehrere Perioden | frei konfigurierbar, günstigste Vollkosten, aber nicht für eine gerade gewonnene Ausschreibung |

Dass Neubestellungen lange dauern, ist real und spielerisch wichtig: Es macht
Leasing zum Einstiegsweg und langfristige Flottenplanung zu einer eigenen
Disziplin. Ein Einsteiger wartet dadurch nie auf Fahrzeuge.

### 3.6 Persistenter Fahrzeugmarkt und Weltstartbestand

Ein Fahrzeug entsteht genau einmal: als Gebrauchtfahrzeug im administrativ vor
Weltenstart freigegebenen Startbestand oder nach der Lieferzeit aus einer
Neubestellung beziehungsweise einem Neufahrzeug-Leasing. Beide Wege schreiben
ein neues, weltweit eindeutiges `VehicleAsset` in die Welt; kein Marktangebot
ist eine austauschbare Kopie eines Typs. Wird ein Fahrzeug ausgemustert, bleibt
sein Lebenslauf Teil des Weltarchivs, es kann aber nicht mehr disponiert oder
gehandelt werden.

Der optionale **Weltstartbestand** wird vor dem Start von der Administration
als versionierter, auditierter und anschließend unveränderlicher Bestand
festgelegt. Seine Fahrzeuge sind ausnahmslos gebraucht: Baujahr,
Konfiguration, Fristen, technische und Innenraumzustände sowie Historie dürfen
deshalb sichtbar voneinander abweichen. Ohne freigegebenen Weltstartbestand
werden keine solchen Gebrauchtfahrzeuge künstlich erzeugt.

Mehrere servereigene, fiktiv benannte Vermieter führen diesen Startbestand und
bei Bedarf Neufahrzeug-Leasing. Jeder Vermieter besitzt ein veröffentlichtes,
weltspezifisches Profil:

| Profilteil | Wirkung |
|-------------|---------|
| Kalkulationsaufschlag | Vertragsrate, Kaution, Rückgabekosten und angebotener Kaufpreis folgen einer eigenen, aus dem `EconomyRelease` abgeleiteten Formel. |
| Präferenzen | Gewichtung nach Baureihe, Verkehrstyp (SPNV, SPFV, SGV), Alter, Zustand und Vertragsdauer bestimmt, welche Fahrzeuge und Neufahrzeuge der Vermieter bevorzugt anbietet. |
| Marktrolle | Serverseitige Angebote liegen für einen vergleichbaren Bedarf immer über dem transparenten Marktpreisband. Sie sichern den Einstieg und Engpassbedarf, sollen aber keinen vorteilhafteren Dauerweg gegenüber Handel und Vermietung zwischen EVU bilden. |

Die Profile, Startbestände, Angebote und Preise sind deterministisch aus den
an die Welt gepinnten Releases abzuleiten und für alle sichtbar. Ihre Namen,
Präferenzen und Zuschläge sind Spielwelt-Fiktion; sie behaupten weder reale
Unternehmen noch reale Marktpreise nachzubilden.

Nach E28 ist dieser sichtbare Markt in einer öffentlichen Welt der normale
Einstiegsweg, **kein Startpaket**. Ein neues EVU erhält kein Fahrzeug
zugewiesen; es wählt ein konkretes Angebot und finanziert Kaution und Rate über
sein weltgebundenes Startkapital oder einen regulären Kredit. Derselbe Preis-
und Verfügbarkeitsvertrag gilt für bestehende EVU. Nur das getrennte
Tutorial-Deployment darf ein vorbereitetes Leasingfahrzeug didaktisch
zuteilen. Der öffentliche Weltentwurf ist bei endlichem Startkapital von null
nur freigabefähig, wenn mindestens eine erreichbare Ausschreibungs-, Kredit-
und Leasingkombination den Einstieg tatsächlich ermöglicht.

**Rücklaufregeln.** Endet ein Leasingvertrag, gibt ein EVU den Betrieb auf oder
wird es insolvent, geht jedes Leasingfahrzeug nach einer nötigen Rückführung
an seinen Leasinggeber zurück. Dieser bietet es mit seinem fortgeschriebenen
Zustand und vollständigen Lebenslauf erneut an oder stellt es ab. Eigene
Fahrzeuge eines endenden oder insolventen EVU werden nach der
Gläubigerverwertung als konkrete Angebote auf den Gebrauchtmarkt gegeben;
kein Ersatzfahrzeug wird erzeugt. Gleiches gilt für einen freiwilligen Verkauf.
Ein reguläres Ende eines Verkehrsvertrags beendet dagegen nicht automatisch
einen noch laufenden Leasingvertrag.

### 3.7 Begehbare Innenraumprojektion (M15)

Der Schaffnermodus leitet ein `InteriorLayoutV1` aus der tatsächlichen
Formation sowie `StructuralConfiguration` und `InteriorConfiguration` ab.
Wagenlänge, Übergänge, Türen, Sitz- und Stehplätze, Mehrzweckflächen, WC,
Fahrrad- und Barrierefreiheitsbereiche bestimmen Geometrie, Begehbarkeit und
Kapazitätsnachweis. Die Darstellung ist generisch-konfigurationsgetreu und
behauptet keine exakte reale Baureihenarchitektur.

Ein Fahrzeug ohne vollständige Konfiguration ist nicht betretbar; der fehlende
Nachweis wird sichtbar ausgewiesen. Die Innenraumprojektion ändert weder die
Formation noch die betriebliche Kapazität. Vollständiger Vertrag:
[`schaffnermodus.md`](schaffnermodus.md) 4 und 5.

## 4. Versorgung, Instandhaltung und Zusatzfahrten

Ein Fahrzeug ist nicht verfügbar, wenn es fahrbereit ist, sondern wenn es
versorgt, entsorgt, gereinigt, fristgerecht **und am richtigen Ort** ist.

**Bedarfe je Fahrzeug**, laufen kontinuierlich mit und sind sichtbar:

| Bedarf | Treiber | Folge bei Vernachlässigung |
|--------|---------|----------------------------|
| Energie und Kraftstoff | Zugkm, Fahrprofil, Masse | Fahrt nicht durchführbar |
| Sand | Bremsungen, Witterung | Geschwindigkeitseinschränkung |
| Frischwasser | Betriebsstunden, Fahrgastzahl | Qualitätsmangel |
| Fäkalienentsorgung | Betriebsstunden, Fahrgastzahl | Toiletten gesperrt, Pönale |
| Innenreinigung | Betriebsstunden, Fahrgastzahl | Sauberkeitsbewertung, Pönale |
| Außenreinigung | Zeit, Witterung | Erscheinungsbild, weicher Faktor |
| Instandhaltungsfristen | Laufleistung und Zeit, gestuft | **harte Sperre** |

**Anlagen sind Konfliktressourcen wie Gleise.** Werkstätten, Behandlungs- und
Waschanlagen, Tankstellen, Entsorgungsanlagen und Abstellgleise haben Kapazität,
Öffnungszeiten, Nutzlänge und Baureihenkompetenz. Zwei EVU konkurrieren dadurch
tatsächlich um dieselbe Abstellanlage in derselben Nacht — und Abstellkapazität
wird zur strategischen Größe, die mitentscheidet, welche Linien fahrbar sind.

**Zusatzfahrten sind echte Züge.** Zuführungs-, Werkstatt-, Versorgungs- und
Abstellfahrten brauchen Trasse, Personal und Zeit, kosten Geld, erscheinen auf
der Livemap und können verspätet sein oder ausfallen. Sie füllen die
Nachtstunden, in denen sonst nichts auf der Karte passiert.

**Rangieren ist vollständig automatisiert (E12).** Der Spieler plant das
*Ergebnis* — Formation, Gleis, Reihenfolge —, niemals die Bewegung dorthin.
Rangierbewegungen belegen Bahnhofsköpfe und Anlagen nur kurz und werden
vereinfacht als Zeitbedarf plus kurzzeitige Belegung verrechnet. Das gilt auch
im Güterverkehr: Zugbildung ist Spielerentscheidung, der Rangieraufwand eine
berechnete Konsequenz. Einzeln steuerbare Rangierbewegungen wären die Ebene, auf
der Detailtiefe in reine Klickarbeit umschlägt, ohne dass eine interessante
Entscheidung entsteht.

Die drei Eingriffstiefen für die Versorgungsplanung stehen in `produkt.md`.

**Umsetzung M5.2–M5.14:** `crates/zugfolge-fleet/src/operations.rs` bildet
diese Kette ohne Nebenpfade ab. Formation, Umlauf, Wartungszustand,
Personalpool und Fahrzeugbedarfe speisen eine gemeinsame Planung; Anlagen und
Rangierbedarf verwenden die Konfliktressourcen des Fahrwegs. Zusatzfahrten
sind nur mit Trassen-, Dienst-, Kosten- und Sichtbarkeitsnachweis gültig. Die
Versorgungsautomatik berücksichtigt die drei Vorgaben Ort, Zeitfenster und
Anlage und veröffentlicht Score, obere Schranke, Lücke in Promille und den
konfigurierbaren Neubau nach mehreren Perioden ab. `CapacityLedger` in
`zugfolge-conflict` stellt die gemeinsame kapazitätsfähige Konfliktengine;
Zusatzfahrten werden nach Trassen-, Dienst- und Kostenprüfung als echte
Simulationsfahrt materialisiert. Ein Dreiwochen-Test einschließlich
Versorgungsautomatik, Wartung und Freigabe-Gate erbringt den Periodenbeweis und
misst 88 Prozent Güte gegenüber der Handplanung.
konfigurierbaren Neubau nach mehreren Perioden ab.

## 5. Baustellen und Störungen

Der ausführbare Fachvertrag für M8, einschließlich Ursachenkennungen,
Abfahrtsrechten und virtuellen Fahrdienstleitern, steht in
[`stoerungen.md`](stoerungen.md).

Jede Welt konfiguriert Baustellen und ungeplante Störungen unabhängig:

```text
DisruptionPolicy
  plannedWorksMode: REALISTIC | SIMULATED | MANUAL
  operationalIncidentMode: REALISTIC | SIMULATED | MANUAL
  providerSetId
  simulationProfile
  rulesetVersion
```

**Realistisch** — autorisierte externe Feeds werden in 1:1-Zeit importiert und
auf Konfliktressourcen gemappt. Quelle, Abrufzeit, Gültigkeit und Confidence
bleiben sichtbar. Bei Providerausfall gilt der letzte sichere Stand; kein
stiller Wechsel auf Simulation. Falschzuordnungen nur durch auditierte
Admin-Korrekturen.

**Simuliert** — ein deterministischer Generator erzeugt Ereignisse anhand von
Häufigkeit, Schwere, Dauer, Vorlauf, Region, Infrastrukturart und Belastung.
Alle Parameter je Welt einstellbar. Gleicher Seed, gleiche Weltversion, gleiche
Ereignisse ⇒ dasselbe Ergebnis. **Standard für Pilot- und erste Großwelt.**
Geplante Baustellen und La-Einschränkungen sind dabei nicht der Ersatz für
spontane Betriebsstörungen: Signal, Stellwerk, Gleisfreimeldung, Weiche,
Fahrzeug, Bremse, Zugbeeinflussung, Tür und verlängerter Fahrgastwechsel werden
in einem eigenen Kanal erzeugt. Dessen Raten beziehen sich auf Netztage,
tatsächliche Zugfahrten und tatsächliche Fahrgasthalte; fahrzeug- und
haltebezogene Ereignisse treffen genau einen Zuglauf.

**Manuell** — keine automatischen Ereignisse. Autorisierte Spielleiter legen
Beginn, Ende, Ursache, betroffene Ressourcen und Wirkung händisch an. Beginn und
Ende sind Pflichtfelder; jede Änderung wird protokolliert.

Modi dürfen während einer laufenden Fahrplanperiode nicht unangekündigt
gewechselt werden. Änderungen treten erst an einem veröffentlichten
Fahrplanstichtag in Kraft.

## 6. Baustellenfahrplan und Ersatzkonzept (E15)

Eine angekündigte Sperrung ist die interessanteste Planungsaufgabe des Spiels —
und die, bei der Automatik und Handplanung am weitesten auseinandergehen.

**Vorlauf ist Pflicht.** Geplante Baumaßnahmen werden mit Vorlauf
veröffentlicht: Beginn, Ende, betroffene Konfliktressourcen, verbleibende
Kapazität. Der Spieler bekommt ein Planungsfenster statt einer Überraschung.
Ungeplante Störungen trifft dagegen das Betriebsprogramm in Echtzeit.

| Maßnahme | Voraussetzung | Wirkung |
|----------|---------------|---------|
| Umleitung über andere Strecke | freie Kapazität, Streckenkenntnis, Zugsicherung, Elektrifizierung, zulässige Zuglänge | Fahrzeitverlängerung und Mehrkosten, aber der Zug fährt |
| Vorzeitige Wende | Wendemöglichkeit und Gleiskapazität am Ersatzendpunkt | Teilstrecke entfällt, Umlauf verkürzt sich |
| Taktausdünnung | vertragliche Zulässigkeit | weniger Leistung, Minderung statt Pönale |
| Linienzusammenlegung | Fahrzeug- und Personalverfügbarkeit | spart Umläufe, kostet Direktverbindungen |
| Schienenersatzverkehr | Vertragspflicht | teuer, spürbarer Qualitätsabzug |

**Ein Ersatzkonzept ist ein eigener kleiner `PlanningRun`** gegen die
verbleibende Kapazität, mit denselben Konfliktregeln und derselben
Begründungspflicht wie der Regelfahrplan.

**Der soziale Kern:** Eine Sperrung verlagert Verkehr, die Umleitungsstrecke
wird selbst zum Engpass, und **mehrere EVU konkurrieren um dieselbe
Ersatzkapazität**. Wer früher und besser plant, bekommt die Umleitungstrasse;
wer spät kommt, fährt Ersatzverkehr. Eine Baustelle ist damit kein Schaden, den
man erleidet, sondern ein Wettlauf, den man gewinnen kann.

**Vertragliche Behandlung** — gut geplant und fristgerecht eingereicht → geringe
Minderung, kaum Qualitätsverlust; spät oder unplausibel → volle Pönale, als
hätte man gar nicht geplant; gar nicht befasst → die Automatik legt ein
sicheres, teures Standardkonzept auf, meist Taktausdünnung plus Ersatzverkehr.

Dasselbe Prinzip wie bei der Versorgung: Wer nichts tut, spielt weiter — nur
teurer. Wer sich hineinkniet, gewinnt spürbar.
