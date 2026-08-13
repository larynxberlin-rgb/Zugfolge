import { describe, expect, it, vi } from "vitest";

import {
  cooperationPageViews,
  focusCooperationDeepLink,
  primaryMapDestination,
  resolveWorldContext,
} from "./navigation.js";

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

describe("kanonischer Weltkontext", () => {
  it("verwendet bei einer normalen Spielerreise immer die verlinkte Welt", () => {
    expect(resolveWorldContext(new URLSearchParams("view=journey&world=world-b&publicWorld=world-a"), "world-a"))
      .toEqual({ worldId: "world-b", publicWorldId: "world-b" });
  });

  it("trennt beim Tutorial-Reentry Tutorial- und öffentliche Welt", () => {
    expect(resolveWorldContext(new URLSearchParams("world=tutorial-b&publicWorld=world-b&tutorial=tut-1"), "world-a"))
      .toEqual({ worldId: "tutorial-b", publicWorldId: "world-b" });
  });

  it("fällt ohne URL-Welt ausschließlich auf den Runtime-Vertrag zurück", () => {
    expect(resolveWorldContext(new URLSearchParams("view=journey"), "world-a"))
      .toEqual({ worldId: "world-a", publicWorldId: "world-a" });
  });
});

describe("Kooperations-Deep-Link", () => {
  it("waehlt Archivansichten bereits fuer den ersten autoritativen Abruf", () => {
    expect(cooperationPageViews(new URLSearchParams("contractView=archive&listingView=archive"))).toEqual({
      contractPageView: "archive",
      listingPageView: "archive",
    });
    expect(cooperationPageViews(new URLSearchParams("contractView=fremd&listingView=all"))).toEqual({
      contractPageView: "actionable",
      listingPageView: "actionable",
    });
  });

  it("fokussiert den konkreten Beleg erst nachdem er gerendert wurde", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const target = { id: "listing-angebot 7", scrollIntoView, focus } as unknown as HTMLElement;
    const root = {
      querySelectorAll: vi.fn(() => [target]),
    } as unknown as ParentNode;

    expect(focusCooperationDeepLink(root, "#listing-angebot%207", true)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusCooperationDeepLink(root, "#postfach", false)).toBe(false);
    expect(focusCooperationDeepLink(root, "#listing-nicht-geladen", false)).toBe(false);
  });
});
