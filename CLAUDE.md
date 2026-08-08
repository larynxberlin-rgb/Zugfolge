# Zugfolge — Arbeitsgrundlage

Persistentes, serverautoritäres Browsergame: Eisenbahn-Unternehmenssimulation
mit hohem betrieblichem, infrastrukturellem und wirtschaftlichem Realismus.
Öffentliche Welten laufen dauerhaft in 1:1-Echtzeit ohne Wipes. Erste
Pilotregion: **Leipzig–Halle–Erfurt**, Stand 2026.

**Diese Datei wird in jeder Sitzung geladen. Sie enthält nur, was immer gilt.**
Alles Weitere steht in `docs/` — vor inhaltlicher Arbeit die passende Datei
lesen, nicht raten.

---

## Dokumentkarte

| Datei | Inhalt | Lesen wenn |
|-------|--------|------------|
| `docs/entscheidungen.md` | E1–E21 mit voller Begründung | eine Entscheidung infrage steht oder geändert werden soll |
| `docs/adr/` | E1–E21 je als Architecture Decision Record: Kontext, Konsequenzen, Querverweise | eine Grundsatzentscheidung ausführlich nachschlagen oder eine neue festhalten |
| `docs/monorepo.md` | Verzeichnisaufbau, Domänengrenzen, Werkzeugkette, Durchsetzung der Invarianten | Code beitragen, neues Paket oder Crate anlegen, CI verstehen |
| `docs/glossar.md` | Domänenglossar: deutscher Fachbegriff → Bezeichner im Code → Bedeutung → Quelle | jede Benennung im Code, jeder neue Fachbegriff |
| `docs/produkt.md` | Produktdefinition, Oberflächen, Onboarding, Netzabgrenzung, Spielertypen, Anti-Monokultur | Produktfragen, UI, Zielgruppe, Was-gehört-dazu |
| `docs/infrastruktur.md` | Konfliktressourcen, Trassenvergabe, Fahrplanperiode, Kapazitätsschutz, Simulation, Livemap; ab 6 das Sperrzeitenmodell, Belegungsprofil, Konfliktprüfer und Trassen-Planner (M3.1–M3.4) | Solver, Sperrzeiten, Planner, Livemap |
| `docs/betriebsgraph.md` | Domänenmodell der Infrastruktur (M1.1): Bausteine, Zusicherungen, Einheiten, Fingerabdruck, Abgrenzung | am Betriebsgraphen arbeiten, Import, Netzfilter, Blöcke, Fahrstraßen |
| `docs/betrieb.md` | Betriebsprogramm, Fahrzeuge, Personal, Versorgung, Zusatzfahrten, Störungen, Baustellenfahrplan | Disposition, Flotte, Umläufe, Wartung, Baustellen |
| `docs/weltgeruest.md` | Weltgerüst (M2): Konten, Rollen, Weltzugänge, Grenze zur Identität bei Keycloak, EVU, Ledger-Kern, Postfach, Datenschutz | Konten, Rollen, Weltzugänge, EVU, Ledger, Postfach oder Datenschutz bearbeiten |
| `docs/wirtschaft.md` | Spielkreislauf, Geschäftsfelder, Nachfrage, Ausschreibung, Eigenbetrieb, Insolvenz, Kooperation | Verträge, Märkte, Geld, Ausschreibungen |
| `docs/daten.md` | Datenlage OSM/ORM, Quellen, Rechte, Qualitätsklassen | Import-Pipeline, InfraRelease, Lizenzfragen zu Daten |
| `docs/rechte.md` | Rechte-Gate: Freigabestatus je Datenquelle, Quellenregister, Trassenfinder-Nutzungsbedingungen | eine Datenquelle nutzen oder aufnehmen, Import beginnen (Invariante 8) |
| `docs/architektur.md` | Systemarchitektur, Lastgrößen, irreversible Entscheidungen, Determinismus, Sicherheit, Health Checks | Technischer Entwurf, Skalierung, Persistenz, Monitoring |
| `docs/design.md` | Farbsystem, Barrierefreiheit, Dunkelmodus, Typografie, Dichte, Wortmarke | jede Oberflächenarbeit, jedes Diagramm, jede Zustandsdarstellung |
| `docs/geschaeft.md` | Odoo, Monetarisierung, Monetarisierungsgrenze, Lizenz, Marken | Bezahlfunktionen, Lizenz, Namensrechte |
| `docs/rechteschutz.md` | Umsetzung von M0.5: LICENSE, CLA, Schichtentrennung, Marke — und ihre Durchsetzung | Lizenz einsetzen, Beitrag annehmen, proprietäre Schicht, Marke |
| `docs/milestones.md` | M0–M13 mit Teilabschnitten und Beweisen | Planung, Reihenfolge, „was als Nächstes“ |
| `docs/risiken.md` | R1–R15 mit Gegenmaßnahmen | Risikoabwägung, Review |

---

## Harte Invarianten

Kein Beitrag darf diese verletzen:

1. **Keine zwei Züge dürfen zur gleichen Zeit inkompatible Belegungen derselben
   Konfliktressource besitzen.** Zentrale fachliche Invariante.
2. **Kein `now()` im Simulationskern.** Simulationszeit ist ein expliziter Wert.
3. **Keine Gleitkommazahlen im zustandsrelevanten Pfad.** Geld als `i64` Cent,
   Zeiten als Sekunden seit Weltepoche, Positionen als Millimeter entlang Kante.
4. **`world_id` in jeder Abfrage, jedem Index und jedem Event.**
5. **Kein Payment-Tier-Feld** in Planner, Nachfrage, Wirtschaft, Trassenvergabe
   oder Live-Disposition. CI-Wächter prüft das.
6. **Kein externer Dienst im heißen Pfad.** Jede Kostenberechnung kommt aus dem
   gepinnten `EconomyRelease` der Welt.
7. **Kein Datenbankzugriff aus dem Simulationskern.** Kommandos rein, Events
   raus.
8. **Kein Import ohne dokumentierte Rechtefreigabe.**

---

## Grundsatzentscheidungen (bindend)

Diese sind getroffen und werden nicht in jeder Sitzung neu verhandelt.
Begründungen: `docs/entscheidungen.md`. Änderungen dort eintragen und begründen.

| Nr. | Entscheidung |
|-----|--------------|
| E1 | SPNV ist das erste vollständig spielbare Geschäftsfeld |
| E2 | Kern-Loop ist das Betriebsprogramm (Dispo-Regelwerk), auch offline wirksam |
| E3 | Fahrplanperiode ist ein Weltparameter, 3–8 Wochen (8 = unbefristete Welt) |
| E4 | Kapazität wird aktiv gegen Landgrab geschützt |
| E5 | Rust-Simulationskern, TypeScript-Plattform — der Schnitt folgt der Last |
| E6 | Baureihennummern faktisch, Produkt- und Unternehmensmarken eigen |
| E7 | Gescheiterte Ausschreibungen übernimmt der Eigenbetrieb des Aufgabenträgers |
| E8 | Insolvenz bedeutet Totalverlust des EVU, mit telegrafierter Eskalationsleiter |
| E9 | Vollständige Transparenz auf der Livemap |
| E10 | Trassenfinder ist Kalibrierwerkzeug der Entwicklung, keine Laufzeitabhängigkeit |
| E11 | Kein einzelner Optimierungswert |
| E12 | Rangieren ist ausschließlich automatisiert |
| E13 | Der Automatikmodus bleibt in öffentlichen Welten kostenlos |
| E14 | Netzabgrenzung: ausschließlich EBO, ohne Übergang zu BOStrab |
| E15 | Baustellen sind ein eigenes Planungsverfahren, kein bloßer Schaden |
| E16 | Lizenz PolyForm Shield 1.0.0 — Source Available, nicht Open Source |
| E17 | Design: Domänensprache statt Markenzitat, achromatische Marke, durchgehend dunkel |
| E18 | Weltlaufzeit 6–18 Monate oder unbefristet; Perioden- und Vertragslängen skalieren mit |
| E19 | Realismus dient dem Spiel — Schritte ohne Entscheidung werden abstrahiert |
| E20 | Fahrzeuge werden konfiguriert bestellt; Werkstätten bauen den Innenraum um |
| E21 | SPNV-Ausschreibungen variieren nach einem angekündigten, seed-deterministischen Vergabeprofil |

---

## Stack

| Schicht | Wahl |
|---------|------|
| Simulationskern, Solver, Release-Pipeline | Rust, angebunden über napi-rs |
| Game-Services | TypeScript, Node.js LTS, Fastify |
| Datenbank | PostgreSQL + PostGIS, Zugriff über Drizzle |
| Frontend | React + Vite, MapLibre GL, PMTiles |
| Identität | Keycloak |

Message-Broker und Cache erst, wenn eine **Messung** sie verlangt. Details und
Lastgrößen: `docs/architektur.md`.

---

## Arbeitsprinzipien

- **Spezifikation vor Code.** Jede Regel — Sperrzeiten, Entgelte, Wertung — ist
  eine versionierte, testbare Spezifikationsdatei, kein Code-Kommentar.
- **Golden-Master-Tests** gegen reale Fahrplanausschnitte der Pilotregion mit
  definierter Toleranz.
- **Property-Tests** für Invariante 1.
- **Determinismus-Test in CI:** gleicher Seed ⇒ gleicher Zustands-Hash.
- **ADR für jede Grundsatzentscheidung.**
- Kein generierter Code ohne einen Test, der ohne ihn fehlschlägt.
- Monorepo mit harten Domänengrenzen, je Domäne eine eigene Agenten-Anleitung.
- Milestones sind nach **Abhängigkeiten** geschnitten, nicht nach Zeit. Aufwand
  relativ als S / M / L / XL. Keine Kalenderdaten.

## Sprachregelungen

- Das Projekt heißt **Source Available**, niemals „Open Source“.
- Vergleichbare Verkehrssimulationen werden generisch benannt, nicht namentlich.

---

## Stand

Konzeption abgeschlossen, E1–E21 entschieden, Milestones auf Reihenfolge und
Vollständigkeit geprüft. **M0 ist abgeschlossen: M0.1 bis M0.5 sind erledigt** —
ADRs, Monorepo, CI, Determinismus-Testharnisch, Wächter, Glossar, Lizenz-Scan,
der Wegwerf-Spike zur Sperrzeitentreppe, das Rechte-Gate und der Rechteschutz.
**M1 ist abgeschlossen: M1.1 bis M1.13 sind erledigt** — das
Domänenmodell des Betriebsgraphen, die Import-Pipeline OSM-PBF → Rohgraph, der
Netzfilter, die Abdeckungsmessung, das Neigungsprofil aus dem Höhenmodell, die
Blockableitung, die Fahrstraßen- und Durchrutschwegableitung, die
Stationsdaten-Anreicherung, die Zugcharakteristik, Fahrdynamik und
Fahrzeitrechner, der Anlagenkataster, der `InfraRelease` und der Referenzkorpus
mit Abweichungsreport stehen in `crates/zugfolge-infra`. Damit ist der
Betriebsgraph samt Infra-Release-Pipeline vollständig.
**Von M3 sind M3.1 bis M3.4 erledigt** — das Sperrzeitenmodell, das
wiederkehrende Verkehrsangebot mit relativem Belegungsprofil, der Konfliktprüfer
mit erklärbarem Ergebnis (`crates/zugfolge-conflict`) und der Trassen-Planner
(`crates/zugfolge-planner`). Der Wegwerf-Spike aus M0.3 ist damit verfallen und
gelöscht. Offen bleiben M3.5 bis M3.10.
**M2 ist abgeschlossen: M2.1 bis M2.6 sind erledigt** — Keycloak-Integration,
Konten, Rollen und Weltzugänge (`packages/identity`, `apps/game-api`), die
Weltisolation mit `packages/db`, die EVU-Entität (`packages/operators`), der
Ledger-Kern (`packages/economy`), das Postfach-Grundgerüst
(`packages/mailbox`) und Datenschutz (`packages/privacy`), siehe unten.

- **Alpha-Schnitt:** M0 – M9. Alles ab M10 ist Ausbau.
- **Kritischer Pfad:** M0.3 → M1 → M3 → M4 → M7. Die ersten Schritte sind geführt.
- **M0.3 hat getragen und ist abgelöst:** Der Spike
  `spikes/blocking-time-staircase/` hat die Sperrzeitentreppe zweier Züge über
  drei Betriebsstellen gerechnet und beide Konfliktarten erkannt. Er ist **mit
  M3.1 verfallen und gelöscht**, wie angekündigt. Seine drei Befunde und seine
  drei offenen Punkte stehen jetzt im Modell: das Ressourcenmodell für beide
  Konfliktarten und die halboffenen Intervalle in M3.1, der erklärbare Befund in
  M3.3, die Ausschlussmengen des Bahnhofskopfs aus M1.7, die Fahrdynamik aus
  M1.10 und die betrieblich richtige Auflösung — kreuzen statt warten — im
  Planner aus M3.4.
- **M0.4 und M0.5 haben getragen:** Das Rechte-Gate führt jede Datenquelle mit
  Freigabestatus im Quellenregister (`tools/guards/quellenregister.json`), und
  der Wächter `rights-gate` setzt Invariante 8 durch — heute die Registerpflege,
  ab dem ersten Import auch die Herkunft. `LICENSE` nennt den Rechteinhaber und
  ist wirksam; der Wächter `layer-separation` hält die proprietären Schichten
  aus dem öffentlichen Baum. Siehe `docs/rechte.md` und `docs/rechteschutz.md`.
- **M1.1 steht:** `crates/zugfolge-infra` beschreibt Betriebsstellen, Kanten,
  Gleise, Bahnsteige, Elektrifizierung, Zugsicherung, Vmax-Bänder und Neigung.
  Drei Entscheidungen wirken weiter: Gefahren wird auf **Gleisen**, und die
  Richtungsbindung liegt am Gleis — Zugfolgefall und Gegenfahrt bleiben damit
  eine Eigenschaft des Netzes (M3.1, M3.3). Die vier veränderlichen Attribute
  teilen sich **einen** Bandmechanismus (M1.5, M1.6 füllen ihn). Und die
  Herkunft hängt am einzelnen Band, damit M1.4 je Attribut und Abschnitt messen
  kann. Der Graph liefert einen kanonischen Fingerabdruck — die spätere
  Prüfsumme des `InfraRelease` (M1.12). Siehe `docs/betriebsgraph.md`.
- **M1.2 steht:** `crates/zugfolge-infra/src/import` liest einen genehmigten
  OSM-PBF-Extract (Quelle `osm-pbf-lhe`) blockweise über einen selbst
  geschriebenen Protobuf-/Blob-Leser und baut daraus einen Rohgraph —
  Topologie, Geometrie und Tags, roh und ungefiltert. Ein Knoten wird nur dann
  zum eigenen Punkt des Rohgraphen, wenn er Anfang, Ende oder Verzweigung
  eines Wegs ist oder selbst einen `railway`-Tag trägt; alle anderen bleiben
  Geometriepunkte ihrer Kante. Der Rohgraph ist bewusst noch kein
  `OperatingGraph` — das entscheidet erst der Netzfilter. Siehe
  `docs/betriebsgraph.md` Abschnitt 7.
- **M1.3 steht:** Der Netzfilter (`crates/zugfolge-infra/src/network_filter.rs`)
  wählt aus dem Rohgraph nur `railway=rail` in Regelspur aus und wirft jeden
  anderen Wert heraus — Tram, Stadtbahn, U-Bahn, Schmalspur, Standseil- und
  Einschienenbahn eingeschlossen, sowie Stromschienennetze über
  `electrified=rail`. Betriebs-, Abstell- und Anschlussgleise bleiben
  erhalten, weil der Filter kein `service`-Tag prüft. Siehe
  `docs/betriebsgraph.md` Abschnitt 8.
- **M1.4 steht:** Die Abdeckungsmessung (`crates/zugfolge-infra/src/coverage.rs`)
  bildet den Vertrauensgrad jedes Bandes auf eine Qualitätsklasse ab und
  zerlegt jedes Gleis an jeder Bandgrenze seiner vier Profile neu, damit jeder
  Abschnitt seine eigene erreichbare Klasse trägt — die datenseitige
  Obergrenze, bevor M1.6 und M1.7 Klasse A tatsächlich erreichbar machen.
  Siehe `docs/betriebsgraph.md` Abschnitt 9.
- **M1.5 steht:** Aus Höhenstichproben entlang der Gleisgeometrie leitet
  `crates/zugfolge-infra/src/elevation.rs` ein geglättetes Neigungsprofil ab —
  Stützpunkte im Mindestabstand einer Bandlänge statt einer Übersetzung jeder
  Stichprobe. Das Höhenmodell der Pilotregion selbst ist noch nicht
  freigegeben (`docs/rechte.md` 3, Status `pruefung`); M1.5 liefert deshalb
  das Verfahren, keinen Import. Siehe `docs/betriebsgraph.md` Abschnitt 10.
- **M1.6 steht:** `crates/zugfolge-infra/src/blocks.rs` leitet mit
  `derive_block_sections` die Blockabschnitte eines Gleises aus Signalpositionen,
  Zugbeeinflussung und Topologie ab. Ein Hauptsignal setzt eine Blockgrenze, ein
  Vorsignal nicht. Eine durchgehend LZB- oder ETCS-geführte Strecke ist ein
  **realer, führerraumsignalisierter Block** ohne ortsfestes Signal — der reine
  LZB- und der reine ETCS-Block, gerade keine Datenlücke; nur wo weder ein
  Kennzeichen noch die durchgehende Überwachung einspringt, entstehen
  **virtuelle Blöcke**. Jeder Block trägt eine Qualitätsklasse A/B/C. Siehe
  `docs/betriebsgraph.md` Abschnitt 11.
- **M1.7 steht:** `crates/zugfolge-infra/src/interlocking.rs` zählt mit
  `derive_interlocking_routes` aus einem `StationHead` — Weichenlage und
  Signalstandort — alle Fahrstraßen eines Bahnhofskopfs auf, mit Weichenlagen,
  Durchrutschweg und **Ausschlussmenge** je Fahrstraße. Das ist die
  Konfliktressource des Bahnhofskopfs, die der Spike aus M0.3 offengelassen
  hatte (M3.1, M3.3). Siehe `docs/betriebsgraph.md` Abschnitt 12.
- **M1.8 steht:** OpenStation und StaDa stehen im Quellenregister noch auf
  `pruefung` (`docs/rechte.md` 3) — Invariante 8 verbietet deshalb jeden
  Import. `crates/zugfolge-infra/src/station.rs` liefert stattdessen das
  Modell: `StationEnrichment` bindet Bahnhofskategorie und Ausstattung an eine
  Betriebsstelle mit planmäßigem Fahrgastwechsel, mit einer **eigenen
  Herkunft je Feld**, weil eine Anreicherung anders als eine Ersterfassung in
  Schüben kommt. Siehe `docs/betriebsgraph.md` Abschnitt 13.
- **M1.11 steht:** `crates/zugfolge-infra/src/facility.rs` führt den
  Anlagenkataster — Werkstätten, Behandlungs- und Waschanlagen, Tankstellen,
  Entsorgungsanlagen und als Anlage geführte Abstellgleise, je mit Kapazität,
  Öffnungszeit, Nutzlänge und **Baureihenkompetenz** als Menge
  (`docs/betrieb.md` 4: „Anlagen sind Konfliktressourcen wie Gleise“). Jede
  Anlage ist gegen einen fertigen `OperatingGraph` geprüft und liegt auf einem
  vorhandenen Gleis, das kein Hauptgleis ist. Die Belegung durch eine
  Zusatzfahrt bleibt M5.7 vorbehalten. Siehe `docs/betriebsgraph.md`
  Abschnitt 14.
- **M1.9 steht:** `crates/zugfolge-infra/src/train.rs` liefert
  `TrainCharacteristics` — Masse, Länge, Vmax, Anfahr- und Bremsvermögen,
  Antriebsart (`TractionType`) und Zugsicherung (dieselbe `TrainProtection` wie
  streckenseitig) — die abstrakte Sicht, mit der Trassen-Planner (M3.4) und
  Fahrzeitrechnung (M1.10) arbeiten, „Zugcharakteristik statt Fahrzeugliste“
  (`docs/infrastruktur.md` 2). Kein Fahrzeugkatalog, keine Formation — das
  bildet M5.2 erst später darauf ab. Siehe `docs/betriebsgraph.md`
  Abschnitt 15.
- **M1.10 steht:** `crates/zugfolge-infra/src/dynamics.rs` ist der in
  `docs/monorepo.md` 3 vorgesehene, **einzige Ort mit Gleitkommarechnung** in
  diesem Crate. `derive_running_time_table` rechnet über einen `RunPath` in
  zwei Durchgängen — rückwärts die Bremskurve, vorwärts das aus
  Anfahrvermögen Erreichbare — ein Trapez- oder Dreiecksgeschwindigkeitsprofil
  je Segment und rundet die Zeit **aufwärts** in eine ganzzahlige
  Fahrzeittabelle. Die Neigung mindert Anfahr- oder Bremsvermögen über die
  Kleinwinkelnäherung `sin θ ≈ Gefälle ‰ / 1000`; reicht eines nicht mehr aus,
  meldet das Verfahren einen Fehler statt einer unmöglichen Fahrt. Siehe
  `docs/betriebsgraph.md` Abschnitt 16.
- **M1.12 steht:** `crates/zugfolge-infra/src/release.rs` friert einen geprüften
  `OperatingGraph` zu einem `InfraRelease` ein — **unveränderlich, versioniert,
  mit Herkunft und Lizenz je Quelle (`ReleaseSource`), Prüfsumme und Confidence
  je Attribut**. `InfraReleaseBuilder::build` prüft, dass jede vom Netz genutzte
  Quelle mit einer Lizenz deklariert ist und keine ohne Gegenstand. Die
  Prüfsumme ist der Fingerabdruck des Graphen (M1.1), umschlossen von Version
  und Quellen; wie er über `DeterministicModel` und einen Golden-Master auf
  Linux und Windows gesichert. Mit M1.12 ist `rust-toolchain.toml` auf eine
  Patchversion gepinnt, damit die Reproduzierbarkeit nicht an der Toolchain
  hängt. Siehe `docs/betriebsgraph.md` Abschnitt 17.
- **M1.13 steht:** `crates/zugfolge-infra/src/reference.rs` hält mit
  `ReferenceCorpus` Referenzläufe — je ein Fahrweg mit realer Fahrzeit — und
  stellt ihnen im `DeviationReport` die aus dem Release berechnete Fahrzeit
  (M1.10) gegenüber, geprüft gegen eine `Tolerance`. `docs/daten.md` 3 verbietet
  eine Präzisionswahrheit, verglichen wird gegen eine **definierte Toleranz**.
  Wie M1.5 bis M1.8 ist das Verfahren **kein Import** — der Trassenfinder steht
  auf `entwicklung` (E10) —, es rechnet mit gegebenen Referenzfahrzeiten. Damit
  ist der M1-Beweis erbracht. Siehe `docs/betriebsgraph.md` Abschnitt 18.
- **M2.1 steht:** `packages/identity` hält Weltzugang (`worldAccesses`), Konto
  (`accounts`) und Kontorolle (`accountRoles`) als Drizzle-Schema in
  `packages/db` neben `worlds` — getrennt von der Identität bei Keycloak, die
  nur verifiziert, nicht gespiegelt wird. Der erste Weltverwalter entsteht
  durch Selbstermächtigung, ausschließlich für das anfragende Konto selbst;
  jede weitere Rollenvergabe verlangt bereits `world_admin` in genau dieser
  Welt. `apps/game-api` verdrahtet das über Fastify: Weltzugang, Kontoliste,
  Rollenvergabe, alle hinter Bearer-Token-Prüfung. Beide Pakete testen
  vollständig ohne laufendes PostgreSQL oder Keycloak — dieselbe Migration aus
  `packages/db` läuft in Tests über `@electric-sql/pglite`, im Betrieb über
  `@zugfolge/db`s Postgres-Verbindung. Siehe `docs/weltgeruest.md`.
- **M2.2 steht:** `packages/db` trägt `worlds` — die Wurzel der
  Mandantentrennung, keine ihrer Zeilen — und das append-only Event-Log
  `domain_events`, beide als Drizzle-Schema mit generierter SQL-Migration. Der
  Wächter `world-id` (`tools/guards`) ist jetzt vollständig: Er prüft nicht
  mehr nur die Tabelle, sondern auch jeden Index in SQL und Drizzle, mit genau
  einer benannten Ausnahme für `worlds` selbst — keiner erfundenen. Das
  weltgebundene Repository `worldEventLog` bindet die `world_id` an den
  Konstruktor statt an jeden einzelnen Aufruf, und ein Test gegen eine echte,
  eingebettete Postgres-Instanz (PGlite) beweist, dass zwei Welten einander
  nie sehen — nicht nur, dass das Schema es verspricht. Invariante 4 ist damit
  seit M0.2 durchgesetzt und seit M2.2 vollständig bewiesen.
- **M2.3 steht:** `packages/operators` gründet ein EVU (`Operator`) für ein
  bestehendes Konto und ordnet es Welt und gründendem Konto zu
  (`packages/db/src/schema/operators.ts`). Ein Konto kann mehrere EVU
  gründen; der Unternehmensname ist je Welt eindeutig (E6), nicht global.
  Die EVU-Liste einer Welt trägt denselben Belegungstest wie die Kontoliste
  aus M2.1: nur für Mitglieder dieser Welt sichtbar. Siehe
  `docs/weltgeruest.md` Abschnitt 7.
- **M2.4 steht:** `packages/economy` ist der Ledger-Kern — Integer-Cent als
  `bigint`, unveränderlich (nur Einfügen und Lesen, kein `update`, kein
  `delete`, wie das Event-Log aus M2.2), ausgeglichen (`postLedgerTransaction`
  weist jede Transaktion zurück, deren Buchungen nicht exakt null Cent
  ergeben) und doppelt geführt (mindestens zwei Buchungen je Transaktion, auf
  Konten desselben EVU). Die Ausgeglichenheit ist mit `fast-check`
  property-getestet — sowohl rein (`balance.property.test.ts`) als auch gegen
  eine echte Datenbank über beliebig viele Transaktionen
  (`ledger.test.ts`). `packages/economy/**` unterliegt der Wächterregel
  `no-wallclock`: Zeitpunkte sind explizite Werte des Aufrufers, nie aus der
  Systemuhr gelesen. Siehe `docs/weltgeruest.md` Abschnitt 8.
- **M2.5 steht:** `packages/mailbox` liefert das Postfach-Grundgerüst —
  Nachrichten mit generischem `messageType` und `payload` (jsonb), optionaler
  Frist (`deadlineAt`) und Quittierung (`acknowledgedAt`). Nur der Empfänger
  quittiert, nie stellvertretend ein Weltverwalter; wiederholte Quittierung
  ist ein Kein-Op. Trassenangebote, Ausschreibungen und Störungsmeldungen
  (spätere Milestones) sind je ein `messageType`, keine eigene Tabelle. Siehe
  `docs/weltgeruest.md` Abschnitt 9.
- **M2.6 steht:** `packages/privacy` trägt Auskunft (`exportAccountData` —
  Konto, Weltzugangsstatus, eigene EVU, Postfach an einer Stelle) und Löschung
  (`eraseAccountData` — Anzeigename anonymisiert, `accounts.erasedAt`
  gesetzt, Weltzugang entzogen; das Konto selbst bleibt bestehen, wie bei
  einer Insolvenz, E8). `revokeWorldAccess` (`packages/identity`) trägt dafür
  seit M2.6 eine Selbstbedienungs-Ausnahme: Eine Identität entzieht sich
  jederzeit selbst den Zugang. `packages/privacy/src/retention.ts` hält
  Aufbewahrungsfristen je Datenkategorie fest — Ledger und Event-Log bleiben
  unbefristet und außerhalb der Löschung, weil beide unveränderlich sind und
  keine natürliche Person tragen. Siehe `docs/weltgeruest.md` Abschnitt 10.
- **Health-Check-Grundlage steht:** `packages/health` trägt den
  `HealthCheck`-Vertrag und `runHealthChecks`, das zum ungünstigsten Status
  aggregiert. `packages/db` liefert darauf die Datenbankprüfung,
  `apps/game-api` verdrahtet sie unter `GET /health/ready`
  (`GET /health` bleibt reine Liveness) und öffnet mit
  `AppDependencies.extraHealthChecks` den Anschluss für jeden künftigen
  Milestone. Kein eigener Milestone-Punkt, sondern bewusst früh gelegt, damit
  M9.5 (Betriebsreife) Monitoring darauf aufbaut statt es nachträglich über
  bereits fertige Pakete zu ziehen. Siehe `docs/architektur.md` Abschnitt 6.
- **M3.1 steht:** `crates/zugfolge-conflict` trägt das Sperrzeitenmodell — die
  sechs Anteile als `RelativeOccupation`, halboffen `[start, end)`, sodass die
  Mindestzugfolgezeit aus dem Modell **herausfällt** statt darin zu stehen.
  `ConflictResource` fasst Blockabschnitt, Bahnhofsgleis, Fahrstraße und Anlage
  in **einer** Aufzählung; die Ausschlussmenge aus M1.7 (`ResourceExclusions`)
  steht daneben, nicht darin — die Ressource ist eine Kennung, die
  Verträglichkeit eine Eigenschaft des Stellwerks. Die netzweiten Konstanten des
  Spikes sind durch Werte **je Betriebsstelle und Stellwerksbauart** ersetzt
  (`SignallingModel`, `InterlockingKind`). Dafür hat M3.1 M1.10 additiv um
  `derive_running_time_table_with_exit` ergänzt: die Bremskurve in einen Halt
  hinein, die M1.10 ausdrücklich offengelassen hatte. Siehe
  `docs/infrastruktur.md` 6.
- **M3.2 steht:** `ServicePattern` hält wiederkehrenden Verkehr als **eine**
  Zeile — Zugnummer, Zugcharakteristik, Laufweg, Zeitlage, Verkehrstage — über
  einem **relativen** `OccupationProfile`. Einmal rechnen, oft verschieben: Ein
  Verkehrstag ist eine Addition, keine zweite Fahrdynamikrechnung, und genau das
  macht den Planner bezahlbar. Dazu die Zugnummernsystematik (Gattung über den
  Nummernbereich, Richtung über die Parität) und die Festlegung, dass die
  **Weltepoche ein Montag** ist. Siehe `docs/infrastruktur.md` 7.
- **M3.3 steht:** Das Belegungsbuch `OccupationLedger` ist nach Ressource
  gruppiert und nimmt über `try_insert` nur konfliktfreie Fahrten auf —
  **Invariante 1 gilt darin durch Konstruktion**. Der Befund nennt Ressource,
  Fenster, Gegenzug und Konfliktart und erklärt sich ohne zweite Abfrage. Die
  Mindestzugfolgezeit ist ein Ergebnis (`minimum_headway`), kein Parameter. Der
  Nachweis ist ein Property-Test über 400 gestreute Lagen gegen eine zweite,
  unabhängig geschriebene Prüfung. Siehe `docs/infrastruktur.md` 8.
- **M3.4 steht:** `crates/zugfolge-planner` beantwortet die andere Frage — nicht
  ob eine Trasse zulässig ist, sondern welche gut ist. Drei Freiheitsgrade, die
  der Prüfer nicht hat: Laufweg, Zeitlage und **Betriebshalt**. Der Betriebshalt
  ist die Kreuzung, und seine Dauer wird aus dem Prüfbericht errechnet, nicht
  geraten; ein Haltepunkt ohne Weichen kommt nie in Frage. Bewertet wird nach
  einer **veröffentlichten Rangfolge** statt nach einer Zielfunktion (E11), und
  der Planner liefert alle zulässigen Kandidaten, damit die Alternative sichtbar
  bleibt. Damit fährt der Zug aus dem Fall des Spikes zur Wunschzeit und kreuzt
  in Sandberg, statt sieben Minuten später zu fahren. Siehe
  `docs/infrastruktur.md` 9.
- **Nächster Schritt:** M3.5 bis M3.10 — deterministischer `PlanningRun` mit
  Seed-Tiebreak, Fahrplanperiode als Ablauf, Ad-hoc-Trassen, Rahmenverträge,
  Gestaltungssystem und Bildfahrplan-Oberfläche (`docs/milestones.md`).

Repository: https://github.com/larynxberlin-rgb/Zugfolge. `LICENSE` steht unter
PolyForm Shield 1.0.0, nennt Sebastian Barowski als Rechteinhaber und ist damit
**wirksam**.
