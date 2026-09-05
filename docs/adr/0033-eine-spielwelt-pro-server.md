# E32 — Eine Spielwelt pro Server und Subdomain

Dieses ADR entspricht E32.

Status: angenommen, am 2026-09-05 ohne Ausnahmen bestätigt.

## Entscheidung

Jeder Game-Server betreibt genau eine Spielwelt mit eigener Datenbank und fester
HTTPS-Subdomain. Jede weitere öffentliche, private oder Testwelt benötigt einen
eigenen Server. `world_id` bleibt in Daten, Abfragen und Events zur eindeutigen
Zuordnung und für die Odoo-Verwaltung erhalten.

## Durchsetzung

- `ZUGFOLGE_WORLD_ID` und `PUBLIC_GAME_URL` pinnen Welt und Origin. Fremde aktive
  Welten verhindern den Start. Archivierte reguläre Vorgeschichte bleibt versiegelt.
- Initiale und administrative Deployments sowie restaurierter Zustand müssen
  dieselbe Welt-ID tragen. `ALPHA_WORLD_RELEASE_PATH` benennt genau ein Deployment.
- Die HTTP-Grenze prüft Host und Welt-ID vor der Handlerwirkung. Weitergeleitete
  Hostheader verändern die Bindung nicht. Interne Healthchecks bleiben erreichbar.
- Clients verwenden ausschließlich die ausgelieferte Weltkonfiguration. URL-Parameter
  können die Welt nicht wechseln. Weltlisten und lokale Neuwelt-Erzeugung entfallen.
- Odoo bleibt zentraler Kontrollpunkt mit Weltserverregister, signierten Befehlen,
  Vier-Augen-Freigaben und kommerziellen Teilnahmen. Es routet an den zur Welt
  gehörenden Server; neue Server werden dort verwaltet und bereitgestellt.

## Betrieb und Upgrade

Migration 0035 löscht die stillgelegten Lernwelten einschließlich Konten,
Simulation, Ledger, Events und Sitzungsdaten. Sonstige aktive Welten werden weder
gelöscht noch automatisch aufgeteilt. Bestehende reguläre Mehrweltbestände müssen
vor dem Neustart mit geprüften Exporten auf eigene Server verteilt werden.
DNS, TLS, Keycloak-Redirects und das Odoo-Register müssen je Subdomain passen.
