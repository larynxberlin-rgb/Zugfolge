# Zusammenhängender Netz-Abnahmekorpus

`network-source.mjs` ergänzt ausschließlich die explizit fiktive Originalquelle
vor Infrastruktur-, Betriebs- und M10-Pins. Das bestehende Compilerinventar
liefert drei unterschiedliche tatsächliche M5-Formationen: Typ 101 führt die
kontrollierte Fahrt, Typ 103 eine Folgefahrt und Typ 102 eine kreuzende Leerfahrt.
Die Leerfahrt führt anschließend mit derselben physischen Formation eine
belegte Rangierfortsetzung aus. Die zusätzliche kurze Prüfstrecke und ihre
Konfliktressource sind ausdrücklich entworfene Spielgeometrie, keine reale
Streckenbehauptung. Der Korpus behauptet keine Güterfahrzeugausstattung.

Der Anführer und die Folgefahrt benutzen dieselben originalen Gleiskanten und
Halteanker. Der vorhandene Haltbinder erzeugt für beide eigenständige
Haltpläne. Die Leerfahrt hat einen getrennten Laufweg, dessen Kreuzungsabschnitt
die tatsächliche Ressource `block:stop:2` beansprucht. Die anschließende
Rangierfahrt erweitert genau diesen Laufweg. Ihre Ausgangsbelegung stimmt mit
dem physischen Ende der Leerfahrt überein; die normale native
Fortsetzungsprüfung bleibt erforderlich.

Zwei explizite spätere M10-Anschlussangebote und ein zusätzlicher Zielbereich
sind Planungsdaten. Ohne eigene Betriebsquittungen bleiben diese Anschlüsse
Prognosen. Verpasste Anschlüsse und Neuwahlen werden ausschließlich durch den
vorhandenen M10-Consumer aus dem tatsächlichen verspäteten Anführer berechnet.
Niemand darf Prognosen als tatsächlich gefahrene Anschlusszüge ausweisen.

Im zusammenhängenden Lauf hält eine reale Infrastruktursperre den Anführer vor
dem mittleren Halt, während die Originalkontrollen laufen. Nach der technischen
Freigabe prüft der normale FDL erneut. Der polizeiliche Kontrollhalt verlängert
die tatsächliche Mittelhaltbelegung. Folge- und Kreuzungsfahrt werden erst bei
physisch freiem Ausgangsgleis materialisiert; sie erhalten keine vorgetäuschte
Bewegung. Ein Vergleichslauf beginnt am selben nativ restaurierten aktiven
Mittelhalt wie der tatsächliche Lauf. Er quittiert ausschließlich in seinem
privaten Testzweig sofort `unavailable`; der tatsächliche Zweig erhält die
echte Modellantwort nach 59 Minuten. Dieser Vergleich misst zusätzliche
Haltedauer und ist ausdrücklich keine Fahrt ohne Polizeianforderung. Beide
Zweige verwenden dieselben Materialisierungs-, FDL-, Fortsetzungs- und
ereignisabhängigen Retirementregeln. Der Gegenlauf erreicht niemals M6 oder
das Ledger; allein der tatsächliche Zweig liefert Geldbelege. Nachlaufende Halt-, Bewegungs-, M10- und
M6-Belege müssen die gemessenen Unterschiede tragen.

Der Wartebeleg bindet die native Ressourcenwarteschlange, den stehenden Zug
und die tatsächliche Belegung oder Fahrstraßenverriegelung des Anführers im
selben restaurierten Zustand. Bei der Folgefahrt wird die tatsächlich
blockierte Ressource des gemeinsamen Laufwegs verwendet; die Kreuzungsfahrt
muss an ihrer ausdrücklich gemeinsamen Ressource `block:stop:2` warten.
Eine Warteschlangenzugehörigkeit ohne nachgewiesenen blockierenden Anführer
genügt nicht.

Die Implementierung dieses Quellhooks allein ist keine Abnahme. Maßgeblich
sind der erfolgreiche native Integrationslauf und der unveränderte tatsächliche
Kontrollbrowser samt Journal-, Snapshot- und Bildhashes. Temporäre Signaturen
bleiben auf die Testwelt beschränkt.
