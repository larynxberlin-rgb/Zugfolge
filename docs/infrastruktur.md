# Infrastruktur, Trassen und Simulation

## 1. Konfliktressourcen

Die Infrastruktur wird als betrieblicher Graph modelliert. Woraus dieser Graph
besteht — Betriebsstellen, Kanten, Gleise, Bahnsteige und ihre Attribute —
steht seit M1.1 im eigenen Dokument: [`betriebsgraph.md`](betriebsgraph.md).
Hier geht es um das, was auf ihm stattfindet.

Konfliktressourcen:

- reale und konservativ erzeugte Blockabschnitte;
- Fahrstraßen, Weichen und kreuzende Bewegungen;
- eingleisige Gegenfahrten;
- Bahnsteig- und Bahnhofskopfbelegungen;
- Abstell- und Servicegleise sowie Behandlungsanlagen (→ `betrieb.md`);
- Durchrutschwege, Räumzeiten und Mindestzugfolgen;
- Zuglänge, Fahrdynamik und infrastrukturelle Kompatibilität.

> **Harte Invariante:** Keine zwei Züge dürfen zur gleichen Zeit inkompatible
> Belegungen derselben Konfliktressource besitzen.

Mehrere Züge dürfen auf derselben Strecke fahren, wenn unterschiedliche
freigegebene Blöcke belegt werden. Ein pauschales Verbot für einen gesamten
Streckenabschnitt wäre nicht realistisch.

**Die Sperrzeit besteht aus sechs Anteilen** — Fahrstraßenbildezeit,
Signalsichtzeit, Annäherungsfahrzeit, Fahrzeit, Räumfahrzeit,
Fahrstraßenauflösezeit. Sie beginnt, bevor der Zug den Abschnitt erreicht, und
endet, nachdem er ihn geräumt hat; aufeinanderfolgende Abschnitte ergeben
dadurch die **Sperrzeitentreppe**. Die Mindestzugfolgezeit folgt daraus und ist
kein eigener Parameter. Zwei Sperrzeiten derselben Ressource dürfen sich
berühren, aber nicht überschneiden.

Der Wegwerf-Spike aus M0.3 hat dieses Modell an drei Betriebsstellen geprüft
und ist mit M3.1 verfallen und gelöscht. Sein Ergebnis steht seither als Code
in `crates/zugfolge-conflict` (Abschnitt 6 bis 8): **Ein Ressourcenmodell trägt
beide Konfliktarten.** Ob aus einer Überschneidung ein Zugfolgefall oder eine
Gegenfahrt wird, entscheidet die Infrastruktur — auf der zweigleisigen Strecke
ist jedes Richtungsgleis eine eigene Ressource, auf dem eingleisigen Abschnitt
teilen beide Richtungen sich eine. Der Prüfer braucht dafür keine zweite Regel.

Was der Spike offengelassen hatte, gehört zum Bahnhofskopf: Weichen,
Fahrstraßen und kreuzende Bewegungen brauchen **Ausschlussmengen** statt
einzelner Ressourcen. Sie kommen aus der Fahrstraßenableitung (M1.7) und wirken
seit M3.3 im Prüfer (Abschnitt 8).

**Anlagen sind Konfliktressourcen wie Gleise.** Werkstätten, Waschanlagen,
Tankstellen, Entsorgungsanlagen und Abstellgleise laufen durch dieselbe
Konfliktengine wie der Fahrweg — kein zweites System.

## 2. Trassenvergabe

1. Ein `PathRequest` enthält Zugcharakteristik, Verkehrstage, Halte,
   Wunschzeiten und zulässige Abweichungen.
2. Der Planner erzeugt Laufweg- und Zeitkandidaten mit relativen
   Belegungsprofilen.
3. Reguläre Anträge eines Planungsfensters werden gemeinsam in einem
   deterministischen `PlanningRun` behandelt.
4. Reihenfolge innerhalb des Fensters und Bezahlstatus beeinflussen das Ergebnis
   nicht.
5. Exakte Gleichstände werden über einen veröffentlichten, je Planungsperiode
   rotierenden Seed aufgelöst.
6. Ad-hoc-Anträge verwenden ausschließlich verbleibende Kapazität.
7. Annahme, Alternativtrasse und Ablehnung enthalten eine maschinenlesbare und
   verständliche Begründung.

**Zugcharakteristik statt Fahrzeugliste.** Der Planner rechnet mit Masse, Länge,
Vmax, Anfahr- und Bremsvermögen, Antriebsart und Zugsicherung — nicht mit
konkreten Fahrzeugen. Echte Formationen werden darauf abgebildet
(→ `betrieb.md`). So arbeiten reale Fahrplanrechner auch, und es entkoppelt die
Trassenplanung vom Fahrzeugkatalog.

## 3. Fahrplanperiode als Saison (E3)

**Die Periodenlänge ist ein Weltparameter, keine Konstante** — sie skaliert mit
der Weltlaufzeit, damit der Saison-Rhythmus in einer Sechsmonatswelt genauso
mehrfach erlebbar ist wie in einer unbefristeten. Werte und Herleitung:
`produkt.md` 6.1. Spanne 3 bis 8 Wochen; **8 Wochen ist der Wert der
unbefristeten Welt** und der Rhythmus, für den das Konzept entworfen wurde.

Der Ablauf ist in jeder Welt derselbe, nur gestaucht. Anteile am Beispiel der
Achtwochenperiode:

| Anteil | Phase |
|--------|-------|
| erstes Viertel | Anmeldefenster — `PathRequest` für die kommende Periode |
| zweites Achtel | Koordinierung — deterministischer `PlanningRun`, Alternativangebote, Einspruchsfenster |
| drittes Achtel | Veröffentlichung Netzfahrplan, Annahmefrist, Rahmenvertragsabgleich |
| zweite Hälfte | Betrieb; parallel Ad-hoc-Trassen aus Restkapazität |

Der Periodenwechsel ist ein Ereignis mit Fahrplanwechsel-Bericht.
Infrastruktur- und Wirtschafts-Releases treten ausschließlich hier in Kraft.

**Der Fahrplanstichtag ist zugleich der einzige zulässige Zeitpunkt für einen
Betriebsübergang** bei Betreiberwechsel im SPNV (→ `wirtschaft.md`). Das ist
real so und technisch sauber, weil Trassen ohnehin periodenweise vergeben
werden.

## 4. Kapazitätsschutz und Markteintritt (E4)

Das größte soziale Risiko einer Welt ohne Wipes: Früheinsteiger binden die
Korridore, Neulinge kommen nie hinein. Alle Gegenmittel sind real begründbar:

- **Rahmenvertragsdeckel** — Rahmenverträge binden nur einen begrenzten Anteil
  der Kapazität eines Korridors.
- **Use it or lose it** — unter einem Nutzungsschwellwert liegende Trassen
  verfallen und lösen Stornoentgelt aus.
- **Markteintrittskontingent** — neue EVU haben in ihrer ersten Periode bei
  kleinen Verkehren Vorrang im exakten Gleichstand.
- **Notvergabe nach Insolvenz** — die natürliche Wiedereinstiegsrampe.
- **Kapazitäts-Heatmap** — die Welt weist niemandem ein Gebiet zu, zeigt aber
  offen, wo noch etwas geht.

## 5. Simulation und Livemap

- Die Simulation ist ereignisgesteuert; Positionen werden zwischen
  Betriebspunkten analytisch berechnet.
- Nur die nächsten 48–72 Stunden werden als vollständige `TrainRun`-Instanzen
  materialisiert.
- Wiederkehrender Verkehr wird als `ServicePattern` plus relativem
  `OccupationProfile` gespeichert.
- Regionale Single-Writer-Prozesse besitzen die jeweiligen Konfliktressourcen.
- Eine Regionsgrenze wird erst übergeben, wenn die Folgeregion die Belegung
  bestätigt.
- Verspätungen, Fahrzeugstörungen und Infrastrukturrestriktionen propagieren
  regelbasiert. Die *Entstehung* von Störungsursachen ist davon getrennt
  (→ `betrieb.md`).
- Der Browser erhält einen Initialsnapshot und anschließend Sequenz-Deltas;
  Positionen werden entlang der Gleisgeometrie interpoliert.
- **Dispositionsschnittstelle:** Der Kern besitzt einen definierten
  Entscheidungspunkt je Ereignis. Zunächst greift ein konservatives
  Standardverhalten; später hängt dort die Regel-Engine des Betriebsprogramms.
- **Zeitumstellung** ist ein Pflichtfall, kein Detail: Verhalten von
  Fahrplanperiode und laufenden Zugfahrten beim Sommerzeitwechsel muss definiert
  sein.

**Sichtbarkeit (E9):** EVU, Zugart, Zugnummer, Position, Geschwindigkeit,
Verspätung, nächster Betriebspunkt und Betriebsstatus sind öffentlich.
Vertrags- und Ladungsdetails bleiben geschützt.

---

## 6. Das Sperrzeitenmodell (M3.1)

`crates/zugfolge-conflict` löst den Wegwerf-Spike aus M0.3 ab. Die sechs Anteile
aus Abschnitt 1 stehen dort als `RelativeOccupation`, ihre Grenzen als
**halboffenes Intervall** `[start, end)`: Zwei Sperrzeiten dürfen sich berühren,
nicht überschneiden. Genau an dieser Grenze liegt die Mindestzugfolgezeit — sie
fällt dadurch aus dem Modell heraus, statt darin als Parameter zu stehen.

### 6.1 Die Konfliktressource ist eine Aufzählung

`ConflictResource` fasst zusammen, was Abschnitt 1 aufzählt: Blockabschnitt,
Bahnhofsgleis, Fahrstraße, Anlage. Ein Bahnhofsgleis wird **nicht** in Blöcke
zerlegt — auf ihm steht ein Zug, und zwei stehen dort nie gleichzeitig. Ist für
ein Streckengleis keine Blockteilung hinterlegt, gilt das ganze Gleis als ein
Block: konservativ, sichtbar, und niemals eine Datenlücke, die als freie Fahrt
durchgeht.

Zwei Fahrstraßen desselben Bahnhofskopfs sind **verschiedene** Ressourcen und
schließen einander trotzdem aus. Deshalb steht die Ausschlussmenge aus M1.7
(`ResourceExclusions`) neben der Ressource und nicht in ihr: Die Ressource ist
eine Kennung, die Verträglichkeit eine Eigenschaft des Stellwerks.

### 6.2 Die Parameter hängen an der Betriebsstelle

Der Spike rechnete mit netzweiten Konstanten. Das ist die Stelle, an der M3.1
ihn ablöst: Fahrstraßenbilde- und Fahrstraßenauflösezeit hängen an der
**Stellwerksbauart** (`InterlockingKind`, vom mechanischen bis zum digitalen
Stellwerk), Signalsichtzeit, Vorsignalabstand und Durchrutschweg an der
**Betriebsstelle**. `SignallingModel` hält einen Vorgabewert und die Ausnahmen —
Netze haben Tausende Betriebsstellen und eine Handvoll Stellwerksbauarten.

Eine sichtbare Folge: Die Sperrzeitentreppe steigt in der **Fahrt**, nicht
zwingend im Beginn der Sperrzeit. Ein mechanisches Stellwerk stellt seinen
Fahrweg eine Minute vorher; seine Stufe beginnt dadurch früher als die des
elektronisch gestellten Blocks davor.

### 6.3 Zwei bewusste Vereinfachungen

**Der Halt liegt am Ende des Bahnhofsgleises.** Das Gleis ist über die ganze
Haltezeit eine einzige Konfliktressource; die genaue Halteposition am Bahnsteig
ändert daran nichts, sondern nur die Ankunftszeit um wenige Sekunden. Sie kommt
mit der Formation in M5.

**Die Fahrstraße wird für die Dauer des Bahnhofsgleises belegt.** Genauer wäre:
von der Fahrstraßenbildung bis zum Räumen des Kopfs. Solange die Zuordnung von
Fahrstraße zu Bahnsteiggleis aus keiner freigegebenen Quelle kommt
(`rechte.md`), wäre jede feinere Angabe erfunden. Die Ausschlussmenge wirkt
trotzdem vollständig.

M3.1 hat dafür `derive_running_time_table_with_exit` in M1.10 ergänzt: die
Bremskurve in einen Halt hinein. M1.10 hatte sie ausdrücklich offengelassen,
weil sie zur Sperrzeit gehört und nicht zur reinen Fahrzeit.

---

## 7. Verkehrsangebot und Belegungsprofil (M3.2)

Abschnitt 5 verlangt, wiederkehrenden Verkehr als `ServicePattern` plus
relativem `OccupationProfile` zu speichern. Der Grund ist Rechenlast: Ein
Angebot fährt in einer Fahrplanperiode dutzende Male, und seine Sperrzeiten sind
an jedem dieser Tage dieselben — nur um eine Zeitlage verschoben. **Einmal
rechnen, oft verschieben.** Das ist die Eigenschaft, die den Planner aus M3.4
bezahlbar macht: Er probiert Zeitlagen aus, und jede kostet ihn eine Addition
statt einer Fahrdynamikrechnung.

### 7.1 Die Zugnummernsystematik

Eine Zugnummer ist keine laufende Nummer, sondern eine Aussage — Zuggattung und
Richtung:

| Zuggattung | Nummernbereich | Kürzel |
|------------|----------------|--------|
| Fernverkehr | 1–9 999 | FV |
| S-Bahn | 10 000–19 999 | S |
| Regionalverkehr | 20 000–39 999 | RV |
| Güterverkehr | 40 000–79 999 | GZ |
| Dienstzug, Zusatzfahrt | 80 000–99 999 | DZ |

**Gerade Nummern fahren mit der Kilometrierung, ungerade gegen sie** — im
deutschen Netz üblich und hier eine geprüfte Zusicherung. Die Kürzel sind
generische Betriebsbegriffe, keine Produktmarken (E6).

### 7.2 Die Weltepoche ist ein Montag

Verkehrstage sind Wochentage, und Wochentage brauchen einen Nullpunkt.
`SimTime::EPOCH` ist **Montag, 00:00 Uhr**. Das ist eine Festlegung, keine
Ableitung — sie steht an einer Stelle, damit sie nicht an dreien verschieden
getroffen wird.

---

## 8. Der Konfliktprüfer (M3.3)

Die Regel ist **eine**: Zwei Sperrzeiten, die dieselbe Konfliktressource oder
zwei einander ausschließende Ressourcen betreffen, dürfen sich zeitlich nicht
überschneiden. Daraus werden vier betriebliche Fälle — Zugfolge, Gegenfahrt,
Fahrstraßenausschluss, Anlagenbelegung —, ohne dass der Prüfer sie
unterscheiden müsste.

**Erklärbar heißt: ohne zweite Abfrage.** Abschnitt 2.7 verlangt eine
maschinenlesbare *und* verständliche Begründung. Ressource, Fenster, Gegenzug
und Konfliktart fallen bei der Prüfung ohnehin an; es braucht dafür keinen
zweiten Mechanismus, nur eine Ausgabeform.

Das Belegungsbuch (`OccupationLedger`) ist nach Ressource gruppiert — die
einzige Struktur, die die Prüfung braucht. Sein `try_insert` nimmt eine Fahrt
nur auf, wenn sie die Prüfung besteht: **Invariante 1 gilt darin durch
Konstruktion.** Nachgewiesen ist sie über einen Property-Test mit 400
gestreuten Lagen, verglichen gegen eine zweite, unabhängig geschriebene
Prüfung; eine Prüfung, die sich selbst prüft, prüft nichts.

Die **Mindestzugfolgezeit** ist ein Ergebnis, kein Parameter: `minimum_headway`
rechnet aus zwei Sperrzeitentreppen den kleinsten Abstand aus, bei dem sich
keine zwei Sperrzeiten mehr überschneiden.

---

## 9. Der Trassen-Planner (M3.4)

Der Prüfer sagt, ob eine Trasse **zulässig** ist. Der Planner sagt, welche
**gut** ist. Das ist ein eigenes Verfahren, kein erweiterter Prüfer — der Spike
aus M0.3 hat genau diesen Punkt hinterlassen: Für eine Gegenfahrt auf
eingleisiger Strecke lautete seine Auskunft „6:57 min später"; betrieblich
richtig war „früher fahren und in einer Betriebsstelle kreuzen".

Der Unterschied entsteht aus drei Freiheitsgraden, die eine Prüfung nicht hat:

| Freiheitsgrad | Was er bedeutet |
|---------------|-----------------|
| **Laufweg** | welches Streckengleis, welches Bahnsteiggleis (`enumerate_itineraries`) |
| **Zeitlage** | früher oder später innerhalb der beantragten Abweichung |
| **Betriebshalt** | in einer kreuzungsfähigen Betriebsstelle warten, bis der Gegenzug durch ist |

Der Betriebshalt ist die Kreuzung, und **seine Dauer wird ausgerechnet, nicht
geraten**: Der Prüfbericht nennt die fremde Sperrzeit, das Verfahren wartet
genau bis zu ihrem Ende, auf volle Minuten aufgerundet. Ein Konflikt *vor* dem
Betriebshalt löst sich dadurch nie — dann gibt das Verfahren auf, statt sinnlos
weiterzuwarten. Ein Haltepunkt ohne Weichen kommt nie in Frage: Ein dort
wartender Zug stünde dem Gegenzug im Weg.

Ein beantragter Halt ist ein **Fahrgastwechsel** und verlangt einen Bahnsteig,
der die Zuglänge aufnimmt. Ein Halt ohne Bahnsteig ist kein Halt.

### 9.1 Kein einzelner Optimierungswert (E11)

Die naheliegende Lösung wäre eine Zielfunktion: Abweichung mal Gewicht plus
Fahrzeitverlängerung mal Gewicht, kleinster Wert gewinnt. E11 verbietet das, und
aus gutem Grund — ein solcher Wert behauptet eine Umrechnung zwischen Minuten
Verspätung und Minuten Fahrzeit, die es betrieblich nicht gibt, und verbirgt sie
hinter einer Zahl.

Stattdessen gilt eine **veröffentlichte Rangfolge**. Die Kriterien werden der
Reihe nach verglichen, und erst bei Gleichstand entscheidet das nächste:

| Rang | Kriterium | Warum es dort steht |
|------|-----------|---------------------|
| 1 | Betrag der Zeitlagenabweichung | die Zeitlage ist das, was beantragt wurde |
| 2 | Fahrzeitverlängerung | sie kostet Umlauf, Personal und Anschluss |
| 3 | Zahl der Betriebshalte | jeder ist ein zusätzlicher Betriebsvorgang |
| 4 | Umweg | Zugkilometer kosten Trassen- und Energieentgelt |
| 5 | frühere vor späterer Lage | Puffer am Zielort |
| 6 | Gleisfolge des Laufwegs | damit die Rangfolge vollständig bestimmt ist |

Und der Planner liefert **alle** zulässigen Kandidaten, nicht nur den ersten.
Wer die Rangfolge anders sieht, sieht die Alternativen daneben — genau das kann
eine Zielfunktion nicht.

Aus Rang 1 folgt unmittelbar das Verhalten, das der Spike vermisst hat: Eine
Kreuzung zur Wunschzeit schlägt jede Verschiebung, weil ihre
Zeitlagenabweichung null ist.

### 9.2 Die drei Ausgänge

`Annahme` (die Wunschlage ist frei), `Alternativtrasse` (sie ist es nicht, aber
etwas innerhalb der zulässigen Abweichungen), `Ablehnung` (auch das nicht). Alle
drei tragen ihre Begründung; die einer Ablehnung ist immer der Prüfbericht der
Wunschlage. Das ist Abschnitt 2.7, ausbuchstabiert.

### 9.3 Was M3.4 bewusst nicht ist

Der Planner behandelt **einen** Antrag gegen ein bestehendes Belegungsbuch. Wie
mehrere konkurrierende Anträge eines Planungsfensters gemeinsam und
reihenfolgeunabhängig behandelt werden — Abschnitt 2.3 bis 2.5 —, ist der
deterministische `PlanningRun` aus M3.5, mit Seed-Tiebreak und Einspruchsfenster.
Der Planner ist dessen Baustein, nicht sein Ersatz.
