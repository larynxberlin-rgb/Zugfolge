import { readFileSync } from "node:fs";
import type {
  PassengerInformationDisplayV1,
  StationBoardCall,
  StationBoardV1,
} from "@zugfolge/livemap-stream";
import { describe, expect, it } from "vitest";
import {
  fisDisplayModel,
  fisVariantForCategory,
  initialSplitFlapMotion,
  SPLIT_FLAP_MOTION_STORAGE_KEY,
  splitFlapBoardAnnouncement,
  splitFlapBoardHasSemanticChange,
  splitFlapBoardModel,
  splitFlapCharacterTransition,
  splitFlapCharacters,
  splitFlapFieldTransitions,
  splitFlapSequence,
  stationBoardDisplayState,
  stationBoardDisplayStateWithMovement,
} from "./railway-displays.js";

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channel = (value: string): number => {
      const normalized = Number.parseInt(value, 16) / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(hex.slice(1, 3))
      + 0.7152 * channel(hex.slice(3, 5))
      + 0.0722 * channel(hex.slice(5, 7));
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function fis(
  category: string,
  overrides: Partial<PassengerInformationDisplayV1> = {},
): PassengerInformationDisplayV1 {
  return {
    schemaVersion: "zugfolge-passenger-information-display/v1",
    trainId: "train-17",
    operator: "Musterbahn",
    trainNumber: "17",
    category,
    destination: "Leipzig Hbf",
    nextStop: "Bitterfeld",
    followingStops: ["Delitzsch", "Leipzig Messe"],
    delaySeconds: 180,
    status: "running",
    messages: ["Heute ohne Wagen 6."],
    ...overrides,
  };
}

describe("Fahrgastinformationsanzeigen", () => {
  it("ordnet S-Bahn, Regional- und Fernverkehr in drei belastbare Varianten ein", () => {
    expect(fisVariantForCategory("S-Bahn")).toBe("suburban");
    expect(fisVariantForCategory("S 7")).toBe("suburban");
    expect(fisVariantForCategory("suburban")).toBe("suburban");
    expect(fisVariantForCategory("Regional-Express")).toBe("regional");
    expect(fisVariantForCategory("RB")).toBe("regional");
    expect(fisVariantForCategory("ICE")).toBe("long-distance");
    expect(fisVariantForCategory("Fernverkehr")).toBe("long-distance");
    expect(fisVariantForCategory("long-distance")).toBe("long-distance");
  });

  it("verdichtet alle drei Varianten bei identischer Datenwahrheit verschieden", () => {
    const suburban = fisDisplayModel(fis("S-Bahn"));
    const regional = fisDisplayModel(fis("RE"));
    const longDistance = fisDisplayModel(fis("IC"));

    expect([suburban.variant, regional.variant, longDistance.variant]).toEqual([
      "suburban",
      "regional",
      "long-distance",
    ]);
    expect([suburban.variantLabel, regional.variantLabel, longDistance.variantLabel]).toEqual([
      "S-Bahn",
      "Regionalverkehr",
      "Fernverkehr",
    ]);
    expect([suburban.iconName, regional.iconName, longDistance.iconName]).toEqual([
      "train-suburban",
      "train-regional",
      "train-long-distance",
    ]);
    expect(regional).toMatchObject({
      destination: "Leipzig Hbf",
      nextStop: "Bitterfeld",
      followingStops: ["Delitzsch", "Leipzig Messe"],
      delayText: "+3 min",
      delayAccessibleText: "3 Minuten später",
      delayed: true,
      statusCode: "running",
      statusText: "Unterwegs",
      cancelled: false,
      messages: ["Heute ohne Wagen 6."],
    });
    expect(fisDisplayModel(fis("long-distance", { trainNumber: "IC 42" })).trainLabel).toBe("IC 42");
    expect(fisDisplayModel(fis("IC", { trainNumber: "IC 42" })).trainLabel).toBe("IC 42");
  });

  it("erfindet bei Vertragsluecken weder Ziel noch naechsten Halt", () => {
    const source = fis("RE");
    const model = fisDisplayModel({
      ...source,
      destination: undefined,
      nextStop: undefined,
      followingStops: [],
      messages: [],
    });

    expect(model).not.toHaveProperty("destination");
    expect(model).not.toHaveProperty("nextStop");
    expect(model.followingStops).toEqual([]);
    expect(model.messages).toEqual([]);
  });

  it("uebernimmt den Live-Status und kennzeichnet einen Ausfall mit Wort und Stoerungsicon", () => {
    const cancelled = fisDisplayModel(fis("RE", { status: "cancelled" }));
    expect(cancelled).toMatchObject({
      statusCode: "cancelled",
      statusText: "Fällt aus",
      cancelled: true,
    });

    const source = readFileSync(new URL("./railway-displays.ts", import.meta.url), "utf8");
    expect(source).toContain('appendIcon(status, "disruption")');
    expect(source).toContain('element("span", model.statusText)');
  });
});

describe("mechanische Bahnhofstafel", () => {
  const calls = [
    {
      trainId: "train-1",
      trainNumber: "1654",
      category: "IC",
      scheduledTimeS: 43_200,
      expectedTimeS: 43_380,
      platform: "7",
      origin: "Dresden Hbf",
      destination: "Hannover Hbf",
      status: "boarding",
    },
    {
      trainId: "train-2",
      trainNumber: "10",
      category: "RE",
      scheduledTimeS: 43_500,
      expectedTimeS: 43_500,
      status: "scheduled",
    },
  ] satisfies readonly StationBoardCall[];

  it("nutzt fuer Ankunft und Abfahrt nur vorhandene Fahrplanwerte", () => {
    const departures = splitFlapBoardModel(calls, "departure", 43_000);
    const arrivals = splitFlapBoardModel(calls, "arrival", 43_000);

    expect(departures).toMatchObject({ title: "Abfahrt", routeHeading: "Nach", at: "11:56" });
    expect(departures.rows[0]).toMatchObject({
      time: "12:03",
      scheduledTime: "12:00",
      train: "IC 1654",
      route: "Hannover Hbf",
      platform: "7",
      status: "Einstieg",
      statusCode: "boarding",
    });
    expect(arrivals.rows[0]?.route).toBe("Dresden Hbf");
    expect(departures.rows[1]).toMatchObject({
      route: "nicht verfügbar",
      platform: "—",
      status: "planmäßig",
    });
    expect(departures.loadedAnnouncement).toContain("2 Fahrten");
  });

  it("gibt Betriebsstatus Vorrang und zeigt sonst die echte Fahrplanabweichung", () => {
    const statusCalls = [
      { ...calls[1]!, trainId: "late", expectedTimeS: 43_680, status: "scheduled" },
      { ...calls[1]!, trainId: "early", expectedTimeS: 43_380, status: "scheduled" },
      { ...calls[1]!, trainId: "cancelled", expectedTimeS: 44_100, status: "cancelled" },
      { ...calls[1]!, trainId: "boarding", expectedTimeS: 44_100, status: "boarding" },
      { ...calls[1]!, trainId: "arrived", expectedTimeS: 44_100, status: "arrived" },
      { ...calls[1]!, trainId: "departed", expectedTimeS: 44_100, status: "departed" },
    ] satisfies readonly StationBoardCall[];

    const rows = splitFlapBoardModel(statusCalls, "departure", 43_000).rows;
    expect(rows.map(({ status, statusCode }) => ({ status, statusCode }))).toEqual([
      { status: "+3 min", statusCode: "delayed" },
      { status: "−2 min", statusCode: "early" },
      { status: "fällt aus", statusCode: "cancelled" },
      { status: "Einstieg", statusCode: "boarding" },
      { status: "angekommen", statusCode: "arrived" },
      { status: "abgefahren", statusCode: "departed" },
    ]);
    const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
    const source = readFileSync(new URL("./railway-displays.ts", import.meta.url), "utf8");
    expect(source).toContain('current.dataset["status"] = row.statusCode');
    expect(css).toMatch(/tr\[data-status="delayed"\][\s\S]*tr\[data-status="early"\][\s\S]*color: var\(--amber\)/);
  });

  it("segmentiert, kuerzt und fuellt feste Fallblattfelder deterministisch", () => {
    expect(splitFlapCharacters("Re 10", 7)).toEqual(["R", "E", " ", "1", "0", " ", " "]);
    expect(splitFlapCharacters("Hannover", 5)).toEqual(["H", "A", "N", "N", "…"]);
    expect(() => splitFlapCharacters("X", 0)).toThrow(RangeError);

    expect(splitFlapSequence("A", "D", "normal")).toEqual(["B", "C", "D"]);
    expect(splitFlapSequence("Z", "A", "normal")).toEqual(["Ä", "Ö", "A"]);
    expect(splitFlapSequence("7", " ", "normal")).toEqual(["8", "9", " "]);
    expect(splitFlapSequence("Z", "Z", "normal")).toEqual([]);
  });

  it("entfernt Zwischenlagen in reduziertem und ausgeschaltetem Modus", () => {
    expect(splitFlapSequence("A", "Z", "reduced")).toEqual([]);
    expect(splitFlapSequence("A", "Z", "none")).toEqual([]);
  });

  it("haelt den alten Buchstaben bis zum gezielten Klapplauf und laesst unveraenderte Zeichen stehen", () => {
    const changed = splitFlapCharacterTransition("A", "Z", "normal");
    expect(changed).toMatchObject({ changed: true, from: "A", to: "Z" });
    expect(changed.intermediate).toHaveLength(3);
    expect(changed.intermediate.at(-1)).toBe("Z");

    expect(splitFlapCharacterTransition("Z", "Z", "normal")).toEqual({
      changed: false,
      from: "Z",
      intermediate: [],
      to: "Z",
    });
    expect(splitFlapCharacterTransition("A", "Z", "reduced").intermediate).toEqual([]);
    expect(splitFlapCharacterTransition("A", "Z", "none").intermediate).toEqual([]);

    const field = splitFlapFieldTransitions("GLEIS 7", "GLEIS 8", 7, "normal");
    expect(field.flatMap((transition, index) => transition.changed ? [index] : [])).toEqual([6]);
    expect(field[6]).toMatchObject({ from: "7", to: "8" });
  });

  it("sagt nur semantische Aenderungen der jeweiligen Bewegungsart an", () => {
    const initial = splitFlapBoardModel(calls, "departure", 43_000);
    const onlyNewClock = splitFlapBoardModel(calls, "departure", 43_060);
    const changed = splitFlapBoardModel([
      { ...calls[0]!, expectedTimeS: calls[0]!.expectedTimeS + 60 },
      calls[1]!,
    ], "departure", 43_060);
    const arrivals = splitFlapBoardModel(calls, "arrival", 43_060);

    expect(splitFlapBoardAnnouncement(undefined, initial)).toBe(initial.loadedAnnouncement);
    expect(splitFlapBoardHasSemanticChange(initial, onlyNewClock)).toBe(false);
    expect(splitFlapBoardAnnouncement(initial, onlyNewClock)).toBeUndefined();
    expect(splitFlapBoardHasSemanticChange(initial, changed)).toBe(true);
    expect(splitFlapBoardAnnouncement(initial, changed)).toBe(changed.updatedAnnouncement);
    expect(splitFlapBoardAnnouncement(initial, arrivals)).toBe(arrivals.loadedAnnouncement);
  });

  it("behaelt die gewaehlte Ankunftstafel ueber einen Datenrefresh", () => {
    const board = {
      schemaVersion: "zugfolge-station-board/v1",
      worldId: "world-1",
      stationId: "station-1",
      stationName: "Leipzig Hbf",
      streamId: "live",
      sequence: 17,
      atS: 43_000,
      departures: calls,
      arrivals: calls,
    } satisfies StationBoardV1;
    const first = stationBoardDisplayState(board);
    const selectedArrival = stationBoardDisplayStateWithMovement(first, "arrival");
    const refreshed = stationBoardDisplayState({ ...board, sequence: 18, atS: 43_060 }, selectedArrival);

    expect(first.activeMovement).toBe("departure");
    expect(refreshed.activeMovement).toBe("arrival");
    expect(refreshed.departure.at).toBe("11:57");
  });

  it("respektiert die lokale Sessionwahl und faellt auf die Systempraeferenz zurueck", () => {
    let requestedKey = "";
    expect(initialSplitFlapMotion({
      getItem(key) {
        requestedKey = key;
        return "none";
      },
    }, false)).toBe("none");
    expect(requestedKey).toBe(SPLIT_FLAP_MOTION_STORAGE_KEY);
    expect(initialSplitFlapMotion({ getItem: () => "invalid" }, true)).toBe("reduced");
    expect(initialSplitFlapMotion({ getItem: () => null }, false)).toBe("normal");
  });

  it("bildet echte obere und untere Klappen ab und schaltet sie barrierearm ab", () => {
    const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
    const source = readFileSync(new URL("./railway-displays.ts", import.meta.url), "utf8");

    expect(css).toMatch(/@keyframes flap-upper[\s\S]*rotateX\(-90deg\)/);
    expect(css).toMatch(/@keyframes flap-lower[\s\S]*rotateX\(90deg\)[\s\S]*rotateX\(0\)/);
    expect(css).toContain("@keyframes flap-target-reveal");
    expect(css).toContain("animation: flap-target-reveal 1ms step-end var(--flap-complete) forwards");
    expect(css).toMatch(/\.flap-motion-reduced \.flap-character__step,[\s\S]*display: none; animation: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.flap-character__step \{ display: none !important; animation: none !important; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.flap-character__final--new \{ opacity: 1 !important; animation: none !important; \}/);
    expect(source).toContain('field.setAttribute("aria-hidden", "true")');
    expect(source).toContain('live.setAttribute("aria-live", "polite")');
    expect(source).not.toMatch(/new Audio|\.play\(\)/);
  });

  it("haelt Primärinformation, Touchziele und Textkontraste auch mobil lesbar", () => {
    const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

    expect(css).toContain(".fis-display__destination strong { font-size: var(--fis-primary-size)");
    expect(css).toContain(".fis-display__next strong { display: block; margin-top: 2px; font-size: var(--fis-primary-size)");
    expect(css).toMatch(/\.split-flap-movement-control span \{ min-height: 42px;/);
    expect(css).toMatch(/\.split-flap-motion-control select \{[\s\S]*min-height: 42px;/);
    expect(css).not.toContain(".split-flap-board { font-size: 8px; }");
    expect(contrastRatio("#929aa5", "#11141a")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#8f97a2", "#0b0d11")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#747b85", "#090a0c")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#f0b75a", "#090a0c")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ff9386", "#090a0c")).toBeGreaterThanOrEqual(4.5);
  });
});
