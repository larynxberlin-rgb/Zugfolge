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

Der Wegwerf-Spike aus M0.3 (`spikes/blocking-time-staircase/`) hat dieses Modell
an drei Betriebsstellen geprüft. Sein Ergebnis für M3.1 und M3.3: **Ein
Ressourcenmodell trägt beide Konfliktarten.** Ob aus einer Überschneidung ein
Zugfolgefall oder eine Gegenfahrt wird, entscheidet die Infrastruktur — auf der
zweigleisigen Strecke ist jedes Richtungsgleis eine eigene Ressource, auf dem
eingleisigen Abschnitt teilen beide Richtungen sich eine. Der Prüfer braucht
dafür keine zweite Regel.

Was der Spike offengelassen hat, gehört zum Bahnhofskopf: Weichen, Fahrstraßen
und kreuzende Bewegungen brauchen **Ausschlussmengen** statt einzelner
Ressourcen. Sie hängen an der Fahrstraßenableitung (M1.7); bis dahin prüft eine
reine Blockbetrachtung nur die halbe Wahrheit.

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
