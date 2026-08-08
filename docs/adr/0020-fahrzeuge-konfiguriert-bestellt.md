# ADR-0020: Fahrzeuge werden konfiguriert bestellt

- **Status:** Angenommen — bindend (entspricht E20)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../betrieb.md](../betrieb.md)
- **Betrifft Milestones:** M5.1 (Katalog und typgenaue Zugsicherung), M5.1a (Konfiguration), M5.1b (Werkstattumbau), M5.14 (Beschaffung), M6.6a (Fahrzeugvorgaben)
- **Verwandte ADRs:** [ADR-0019](0019-realismus-dient-dem-spiel.md)

## Kontext

Fahrzeuge könnten wie in vielen Simulationen aus einem Katalog gekauft werden —
Modell auswählen, bezahlen, fertig. Das ist eine triviale Entscheidung mit einer
eindeutig besten Antwort und damit spielerisch arm. Reale Fahrzeuge dagegen
werden nach Einsatzzweck konfiguriert, und die Konfiguration wirkt bis in den
Betrieb hinein.

## Entscheidung

Fahrzeuge werden **konfiguriert bestellt**, nicht aus einem Katalog gekauft.
Sitzaufteilung nach Klassen, Bestuhlungsdichte, Sitzart, Mehrzweckbereiche,
Türanzahl und -breite sowie Ausstattung sind Spielerentscheidungen. **Türen
wirken über die Haltezeit direkt in die Simulation.** Werkstätten bauen den
Innenraum um; Türen, Wagenkasten und Antrieb bleiben baulich fest. Eine
serienmäßige Zugsicherung ist weder abwähl- noch entfernbar. Eine nicht
serienmäßige Zugsicherung wird nur dann zur Spielerentscheidung, wenn sie an der
genauen Baureihe zumindest für einen Teilbestand belegt ist: als zeitgebundene
Werksoption beim Neubau oder als zeitgebundene, ausdrückliche Nachrüstung in der
Werkstatt. Leasing ist sofort verfügbar, Neubestellungen dauern mehrere
Perioden.

## Begründung

Weil die Türanzahl über die Haltezeit in die Simulation wirkt, gibt es keine
allgemein beste Konfiguration: Eine dichte S-Bahn-Linie will andere Fahrzeuge
als ein langlaufender Regional-Express. Damit wird die Fahrzeugwahl zur echten,
einsatzabhängigen Entscheidung — genau das, was „Realismus dient dem Spiel"
(ADR-0019) verlangt.

## Konsequenzen

- **Erleichtert:** Die Fahrzeugwahl wird zu einer strategischen, von der Linie
  abhängigen Entscheidung; Werkstattumbauten erlauben Anpassung an geänderten
  Bedarf.
- **Kostet / schränkt ein:** Der Umbau kostet Geld und belegt eine
  Werkstattanlage; Türen, Wagenkasten und Antrieb sind nicht änderbar.
  Neubestellungen binden über mehrere Perioden. Die Konfiguration muss gegen die
  Fahrzeugvorgaben der Ausschreibung geprüft werden. Leasing- und
  Gebrauchtfahrzeuge behalten ihre vorhandene Konfiguration und Zugsicherung;
  der Markt ist kein kostenloser Konfigurator.
- **Beleggrenze:** Teilflotten- oder Einzelfahrzeugbelege reichen für eine
  Option, nicht für eine Serienangabe. Eine verwandte Baureihe, bloße Planung
  oder eine allgemeine Produktbroschüre schaltet nichts frei.
- **Milestones:** M5.1 (Katalog, Zeitfenster und typgenaue Zugsicherung), M5.1a
  (Fahrzeugkonfiguration), M5.1b (Werkstattumbau), M5.14 (Beschaffung: Leasing
  sofort, Gebrauchtmarkt, Neubestellung), M6.6a (Fahrzeugvorgaben der
  Ausschreibung, geprüft gegen die Konfiguration).
