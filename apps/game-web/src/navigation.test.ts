import { describe, expect, it } from "vitest";

import { primaryMapDestination } from "./navigation.js";

describe("primäre Spieloberfläche", () => {
  it("öffnet ohne explizite Nebenansicht die weltgebundene Live-Karte", () => {
    expect(primaryMapDestination({
      requestedView: null,
      demoMode: false,
      livemapUrl: "/live/",
      worldId: "public-world",
      pageUrl: "https://spiel.example/",
    })).toBe("https://spiel.example/live/?world=public-world");
  });

  it("erhält Spielerreise, Bildfahrplan, Demo und fehlende Kartenkonfiguration", () => {
    for (const input of [
      { requestedView: "journey", demoMode: false, livemapUrl: "/live/" },
      { requestedView: "diagram", demoMode: false, livemapUrl: "/live/" },
      { requestedView: null, demoMode: true, livemapUrl: "/live/" },
      { requestedView: null, demoMode: false, livemapUrl: "" },
    ] as const) {
      expect(primaryMapDestination({ ...input, worldId: "public-world", pageUrl: "https://spiel.example/" })).toBeUndefined();
    }
  });
});
