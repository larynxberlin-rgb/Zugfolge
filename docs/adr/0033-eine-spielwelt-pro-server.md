# E32 — Eine Spielwelt pro Server und Subdomain

Dieses ADR entspricht E32.

Status: angenommen, durch den Projektverantwortlichen am 2026-09-05 bestaetigt.

## Entscheidung

Jeder Game-Server betreibt genau eine regulaere Spielwelt. Diese besitzt eine
feste HTTPS-Subdomain. Ausschliesslich die persoenlichen, kurzlebigen
Tutorialinstanzen dieser Spielwelt laufen auf demselben Server mit (E28).
Eine weitere oeffentliche oder private Spielwelt braucht einen eigenen Server,
eigene Datenhaltung und eine eigene Subdomain.

`world_id` bleibt in Daten, Abfragen und Events erhalten. Die feste
Serverzuordnung ergaenzt diese fachliche Isolation. Gemeinsame Bibliotheken und
Isolationstests duerfen weiterhin mehrere Welt-IDs modellieren; der produktive
Server darf sie nicht gemeinsam freischalten.

## Grenzen und Durchsetzung

- `ZUGFOLGE_WORLD_ID` und `PUBLIC_GAME_URL` pinnen Welt und Origin. Vor
  Listenern und Hintergrundjobs wird das Datenbankinventar geprueft. Fremde
  aktive Welten sowie ungebundene oder fremde aktive Tutorials verhindern den
  Start. Archivierte Vorgaenger bleiben als versiegelte Geschichte erhalten,
  werden aber weder als Spielwelt geladen noch ueber Weltlisten angeboten.
- Signierte initiale, persistierte und spaeter administrativ angeforderte
  Deployments muessen dieselbe Welt-ID tragen. Der HTTP-Pfad zum spontanen
  Erzeugen einer weiteren privaten Welt ist auf einem Weltserver gesperrt.
- Proxy und API erhalten und pruefen den kanonischen Host. Eine Welt-ID im
  Pfad und ein `X-Forwarded-Host` koennen die Serverzuordnung nicht aendern.
  Lokale Liveness-/Readiness-Pruefungen bleiben erreichbar.
- Welt- und EVU-Listen enthalten nur die Hauptwelt und nachweislich an sie
  gebundene Tutorials. Die bestehenden Konto- und Eigentuemerpruefungen gelten
  zusaetzlich, auch innerhalb der Tutorialausnahme.
- Odoo bleibt ein zentraler Katalog und administrativer Kontrollpunkt (E23).
  Es darf mehrere Weltserver kennen, muss aber weltgebundene Kommandos,
  Teilnahmen und Abgleiche an den explizit zugeordneten Server zustellen.
  Tutorialinstanzen erscheinen weder als Verkaufswelten noch als Odoo-Ziele.
  Kontoweite Entitlements brauchen eine explizite Verteilung an registrierte
  Server; ein globales beliebiges Game-Ziel ist keine Weltzuordnung.

## Betrieb

Bestehende Mehrwelt-Datenbanken werden durch diese Aenderung weder zerlegt
noch geloescht. Ihre Migration auf getrennte Server erfordert gesicherte,
gepruefte Exporte und eigene Release-/Deploymentnachweise. Der Startabbruch
macht eine versehentliche Weiterverwendung sichtbar. CI prueft die
Servergrenze; die produktiven DNS-, TLS-, Keycloak-Redirect- und Odoo-Zuordnungen
muessen vor Freigabe mit der jeweiligen echten Subdomain abgeglichen werden.
