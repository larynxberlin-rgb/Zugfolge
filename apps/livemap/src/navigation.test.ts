import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import mainSource from "./main.ts?raw";
import { livemapNavigationDestinations, mailboxDecisionDestination } from "./navigation.js";
import journeySource from "../../game-web/src/journey.ts?raw";
import cooperationSource from "../../game-web/src/cooperation.ts?raw";

describe("weltbewusste Hauptnavigation der Live-Lage", () => {
  it("verlinkt jede Spielerfläche in dieselbe ausdrücklich gewählte Welt", () => {
    expect(livemapNavigationDestinations("https://spiel.example/game/", "https://spiel.example/live/?world=welt-b&focus=train%3A7", "welt-b"))
      .toEqual({
        live: "https://spiel.example/live/?world=welt-b",
        journey: "https://spiel.example/game/?view=journey&world=welt-b#world-contract-title",
        markets: "https://spiel.example/game/?view=journey&world=welt-b#vehicle-market",
        planner: "https://spiel.example/game/?view=diagram&world=welt-b",
        operations: "https://spiel.example/game/?view=journey&world=welt-b#betrieb",
        mailbox: "https://spiel.example/game/?view=journey&world=welt-b#postfach",
      });
  });

  it("bleibt auch ohne getrennten Game-Web-Endpunkt bedienbar und erzeugt nie Attrappenlinks", () => {
    const links = Object.values(livemapNavigationDestinations("", "https://spiel.example/live/", "welt-a"));
    expect(links).toHaveLength(6);
    expect(links.every((link) => link !== "#" && new URL(link).searchParams.get("world") === "welt-a")).toBe(true);
  });

  it("entfernt kurzlebige OIDC-Rückgabeparameter aus allen internen Links", () => {
    const callback = "https://spiel.example/live/?world=welt-a&code=once&state=s&session_state=k&iss=https%3A%2F%2Fid.example&focus=train%3A7";
    const destinations = livemapNavigationDestinations("/game/", callback, "welt-a");
    for (const destination of Object.values(destinations)) {
      const url = new URL(destination);
      for (const parameter of ["code", "state", "session_state", "iss"]) expect(url.searchParams.has(parameter)).toBe(false);
    }
    expect(mailboxDecisionDestination("/game/", callback, "welt-a", {
      worldId: "welt-a", messageType: "planning.path-offered", payload: { trainId: "zug-1" },
    })).toBe("https://spiel.example/game/?view=diagram&world=welt-a&train=zug-1#diagram-card");
  });

  it("verweist nur auf im Spieler-Markup vorhandene Hauptziele", () => {
    const destinations = livemapNavigationDestinations("/", "https://spiel.example/live/", "welt-a");
    const source = `${journeySource}\n${cooperationSource}`;
    for (const key of ["journey", "markets", "operations", "mailbox"] as const) {
      const target = new URL(destinations[key]).hash.slice(1);
      expect(target).not.toBe("");
      expect(source).toContain(`id=\"${target}\"`);
    }
  });

  it("hält die vollständige Navigation mobil sichtbar und bietet ein echtes Skip-Ziel", () => {
    const cssSource = readFileSync(new URL("./style.css", import.meta.url), "utf8");
    expect(mainSource).not.toContain('href="#"');
    expect(mainSource).not.toContain("worldLabel.textContent = worldId");
    expect(mainSource).toContain("worldLabel.textContent = mapConfig.worldName");
    for (const label of ["Live-Lage", "Welt", "Märkte", "Fahrplan", "Betrieb", "Postfach"]) expect(mainSource).toContain(`>${label}</a>`);
    expect(mainSource).toContain('href="#map-object-list"');
    expect(mainSource).toContain('id="map-object-list" class="object-list" tabindex="-1" aria-labelledby="object-list-title"');
    expect(cssSource).toContain(".topbar nav { grid-column: 1 / -1; width: 100%; display: flex;");
    expect(cssSource).not.toMatch(/@media \(max-width: 900px\)[\s\S]*?\.topbar nav\s*\{[^}]*display:\s*none/);
  });

  it("führt Postfachentscheidungen weltkonkret auf Vertrag, Fahrzeugmarkt und Fahrplan", () => {
    const page = "https://spiel.example/live/?world=welt-b";
    const game = "https://spiel.example/game/";
    expect(mailboxDecisionDestination(game, page, "welt-b", {
      worldId: "welt-b",
      messageType: "cooperation.contract-offer",
      payload: { contractId: "vertrag-7" },
    })).toBe("https://spiel.example/game/?view=journey&world=welt-b&contractView=actionable#contract-vertrag-7");
    expect(mailboxDecisionDestination(game, page, "welt-b", {
      worldId: "welt-b",
      messageType: "vehicle-market.reserved",
      payload: { listingId: "angebot-2" },
    })).toBe("https://spiel.example/game/?view=journey&world=welt-b&listingView=actionable#listing-angebot-2");
    expect(mailboxDecisionDestination(game, page, "welt-b", {
      worldId: "welt-b",
      messageType: "planning.path-offered",
      payload: { trainId: "zug-9" },
    })).toBe("https://spiel.example/game/?view=diagram&world=welt-b&train=zug-9#diagram-card");
  });

  it("oeffnet beendete Vertraege und Marktuebertragungen mit konkreter ID im Archiv", () => {
    const page = "https://spiel.example/live/?world=welt-b";
    const game = "https://spiel.example/game/";
    for (const messageType of [
      "cooperation.contract-rejected",
      "cooperation.contract-terminated",
      "cooperation.contract-non-performance",
    ]) {
      expect(mailboxDecisionDestination(game, page, "welt-b", {
        worldId: "welt-b",
        messageType,
        payload: { contractId: "vertrag-archiv" },
      })).toBe("https://spiel.example/game/?view=journey&world=welt-b&contractView=archive#contract-vertrag-archiv");
    }
    for (const messageType of ["vehicle-market.transferred", "vehicle-market.reversed"]) {
      expect(mailboxDecisionDestination(game, page, "welt-b", {
        worldId: "welt-b",
        messageType,
        payload: { listingId: "angebot-archiv" },
      })).toBe("https://spiel.example/game/?view=journey&world=welt-b&listingView=archive#listing-angebot-archiv");
    }
  });

  it("verweigert Deep-Links aus einer fremden Welt", () => {
    expect(() => mailboxDecisionDestination("/", "https://spiel.example/live/", "welt-a", {
      worldId: "welt-b",
      messageType: "cooperation.contract-offer",
      payload: { contractId: "vertrag-7" },
    })).toThrow(/gewählten Welt/);
  });
});
