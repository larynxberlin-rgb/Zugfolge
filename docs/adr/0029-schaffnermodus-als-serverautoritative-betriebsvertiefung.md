# ADR-0029: Der Schaffnermodus vertieft den serverautoritativen Betrieb

- **Status:** Angenommen — bindend (entspricht E29)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) ·
  [../schaffnermodus.md](../schaffnermodus.md) ·
  [../stoerungen.md](../stoerungen.md) · [../wirtschaft.md](../wirtschaft.md)
- **Betrifft Milestones:** M10.1–M10.3a, M15.1–M15.12
- **Verwandte ADRs:** ADR-0002, ADR-0011, ADR-0017, ADR-0019, ADR-0025

## Kontext

Die laufende Simulation bildet Züge, Konfliktressourcen, Fahrgäste und
wirtschaftliche Folgen bereits serverautoritativ ab. Eine begehbare
Innenansicht könnte diese Systeme erlebbar machen, würde als abgetrenntes
Minigame aber zwei Wahrheiten erzeugen: erfundene Fahrgäste neben dem
Nachfragemodell und künstliche Halte neben der Konfliktengine. Eine hohe
ungekappte Belohnung würde den optionalen Modus außerdem zur Pflichtarbeit
machen.

Gleichzeitig darf eine Spielerentscheidung nicht folgenlos bleiben. Wer wegen
einer Identitätsverweigerung Polizei anfordert, hält einen echten Zug an einem
echten Bahnhof auf. Das blockiert Ressourcen und beeinflusst andere Fahrten.
Eine bloße Animation ohne diese Folgen widerspräche E19 ebenso wie ein
detailgetreuer Verwaltungsprozess ohne interessante Entscheidung.

## Entscheidung

**Der Schaffnermodus ist eine optionale, serverautoritative Vertiefung des
regulären Betriebs. Er verwendet ausschließlich den tatsächlichen Weltzustand
aus Betrieb und Personenverkehrsnachfrage, verändert ihn nur über typisierte
und auditierbare Kommandos und belohnt aktives Spielen wirtschaftlich nur klein
und gedeckelt.**

M10 bleibt Quelle für Reisen, Auslastung und Fahrberechtigungsstatus. M15
projiziert diese Fahrgäste 1:1 in einen begehbaren Innenraum und hält verdeckte
Sachverhalte auf dem Server. Normale Gespräche verändern den Betrieb nicht.
Eine bindende Polizeianforderung erzeugt am nächsten planmäßigen Fahrgasthalt
einen `FareControlHoldV1`, der die tatsächlich benötigten Konfliktressourcen
über den vorhandenen `CapacityLedger` weiter belegt.

Nach Ende des Halts erteilt das Spiel kein automatisches Abfahrtsrecht. Die
vorhandene virtuelle Fahrdienstleitung prüft und priorisiert die Bewegung
gemeinsam mit allen anderen Zugarten neu. M4 propagiert die resultierende
Verspätung, M10 berechnet betroffene Reiseketten neu und M6 bucht Forderungen,
Kosten, Prämie und Pönalen.

Der Modus ist kein Fahr- oder Signalsimulator. Fremde Bildwelten werden nicht
kopiert; ein eigener gepinnter Pixelart- und Dialogkorpus wird außerhalb der
Laufzeit erzeugt und geprüft.

## Begründung

Eine gemeinsame Autorität verhindert widersprüchliche Auslastungen und
Umgehungen der zentralen Konfliktinvariante. Die vorhandene
Dispositionsschnittstelle kann die zusätzliche Ursache aufnehmen, ohne eine
zweite Fahrdienstleitung für das Minigame zu bauen. Die 1:1-Projektion macht
M10 sichtbar und prüfbar, während kohortenbasierte Berechnung die Last
beherrschbar hält.

Die gedeckelte positive Wirkung gibt einen kleinen Spielanreiz, ohne
Zeitverfügbarkeit zum dominanten Wettbewerbsvorteil zu machen. Offene
Forderungen, Ausfälle, Bearbeitungskosten, Verspätung und Pönalen verhindern
eine garantierte Gelddruckmaschine. Der einmalige Polizeihalt je Zuglauf und
die maximale Wartezeit begrenzen Missbrauch des gemeinsamen Netzes.

## Konsequenzen

- **Erleichtert:** M10, M8, M4 und M6 bleiben jeweils Source of Truth ihres
  Fachgebiets; M15 wird eine autorisierte Projektion und Kommandoquelle.
- **Erleichtert:** Jeder relevante Ausgang ist über Event-Log, Replay,
  Belegungsbuch und Ledger reproduzierbar erklärbar.
- **Kostet / schränkt ein:** M15 kann erst nach dem gemeinsamen
  Personenverkehrsmodell M10.1–M10.3a vollständig umgesetzt werden.
- **Kostet / schränkt ein:** Grafik- und Dialogproduktion brauchen signierte,
  rechtsgeprüfte Releases und eigene Qualitätsgates.
- **Kostet / schränkt ein:** Ein Polizeihalt darf andere EVU tatsächlich
  treffen und verlangt deshalb Missbrauchsschutz, Höchstwartezeit und
  datensparsame Sichtbarkeit.
- **Invarianten:** Invariante 1 gilt auch während verlängerter Halte;
  Invarianten 2–4 und 7 gelten für sämtliche neuen Zustände und Events;
  Invariante 8 gilt für alle Daten- und Assetimporte.
- **Milestones:** M10 liefert Manifeste und Fahrberechtigungsstatus. M15.1–M15.12
  liefern Fachvertrag, Assets, Browser, Sitzung, Kontrolle, Betriebswirkung,
  Wirtschaft und Abnahme.
