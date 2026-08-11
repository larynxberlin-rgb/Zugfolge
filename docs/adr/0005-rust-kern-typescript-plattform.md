# ADR-0005: Rust-Simulationskern, TypeScript-Plattform

- **Status:** Angenommen — bindend (entspricht E5)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../architektur.md](../architektur.md)
- **Betrifft Milestones:** M0.3 (Spike), M4 (Simulationskern), M1.12 (Release-Pipeline)
- **Verwandte ADRs:** [ADR-0010](0010-trassenfinder-nur-kalibrierwerkzeug.md)

## Kontext

Im System treffen zwei gegensätzliche Lasten aufeinander. Die **laufende
Simulation** ist ereignis- und ein-/ausgabegeprägt — wenige hundert Ereignisse
je Sekunde, dazu Delta-Versand an viele Clients; ein Nebenläufigkeitsproblem.
Der **Trassen-Solver** ist das Gegenteil: ein NP-hartes Planungsproblem über
zehntausende Konfliktressourcen mit der Sperrzeitenprüfung in der innersten
Schleife; ein reines Rechenproblem. Im Kern fallen zusätzlich drei
Anforderungen zusammen, die sonst nirgends zusammentreffen: nationale
Rechenlast, bitgenaue Reproduzierbarkeit über Jahre und ein Regelwerk, das sich
kaum ändert.

## Entscheidung

Simulationskern, Trassen-Solver und Release-Pipeline werden in **Rust**
geschrieben und über napi-rs in-process aus Node angebunden — kein zweiter
Dienst. Die Game-Services (Verträge, Ausschreibungen, Ledger, Märkte, Postfach)
bleiben **TypeScript** auf Node.js. Der Schnitt folgt der Last, nicht der
Bequemlichkeit. Zugfolge wird ausschließlich auf **Linux** betrieben und die
CI prüft den Rust-Kern deshalb nur auf dieser unterstützten Plattform.

## Akzeptanzszenarien

- **Given** ein Push oder Pull Request, **when** der Rust-CI-Job startet,
  **then** wird genau ein Linux-Runner und kein Windows-Runner angefordert.
- **Given** der gepinnte Rust-Kern auf Linux, **when** Formatierung, Clippy,
  Tests und Golden-Master laufen, **then** müssen alle Prüfungen erfolgreich
  sein, bevor die Änderung mergefähig ist.

## Begründung

Genau dort, wo Rechenlast, Reproduzierbarkeit und ein stabiles Regelwerk
zusammenfallen, ist eine Sprache mit langsamerer Iteration richtig — und dort
wäre ein späterer Umbau am teuersten, weil alles andere gegen den Kern
validiert ist. Die Game-Services dagegen ändern sich ständig, sind
ein-/ausgabegebunden und haben kein Skalierungsproblem; sie später
umzuschreiben wäre billig, sie jetzt in einer langsameren Sprache zu bauen
kostet dauerhaft Tempo.

## Konsequenzen

- **Erleichtert:** Der Kern hält einen engen, geprüften Vertrag — Kommandos
  rein, Events raus. Golden-Master- und Determinismus-Tests melden Fehler
  sofort.
- **Kostet / schränkt ein:** Rust ist die schwerere Sprache; ein Kern, den man
  nicht selbst reparieren kann, bleibt ein reales Risiko (R14). Beherrschbar
  gehalten durch stabiles Regelwerk, engen Vertrag und einen kleinen Einstieg
  (M0.3: drei Betriebsstellen, zwei Züge). Plattformübergreifende Abweichungen
  werden nicht mehr durch einen Windows-CI-Lauf erkannt; Windows ist keine
  unterstützte Betriebsplattform.
- **Invarianten:** Trägt Invariante 2 (kein `now()` im Kern), 3 (keine Floats
  im Zustand), 6 (kein externer Dienst im heißen Pfad) und 7 (kein DB-Zugriff
  aus dem Kern).
- **Milestones:** M0.3 ist der erste Rust-Spike; M4 baut den Kern aus; die
  Release-Pipeline (M1) läuft ebenfalls in Rust. Message-Broker und Cache erst,
  wenn eine Messung sie verlangt.
