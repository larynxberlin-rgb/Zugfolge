import { describe, expect, it } from "vitest";
import { filterTrains, liveOverview, trainSituation, watchMarkup, watchTrains } from "./live-overview.js";
import type { PublicTrain } from "./protocol.js";

const train = (id: string, values: Partial<PublicTrain> = {}): PublicTrain => ({id,operatorId:"own",operator:"Meine Bahn",trainNumber:`RE ${id}`,category:"Regional",positionMm:0,speedMmPerSecond:0,status:"running",...values});

describe("LiveMap als Spielübersicht", () => {
  it("filtert eigene Züge anhand der Unternehmenskennung, auch bei gleichem Namen", () => {
    const trains = [train("1"),train("2",{operatorId:"other"}),train("3",{operatorId:undefined})];
    expect(filterTrains(trains,"own","own").map(t=>t.id)).toEqual(["1"]);
    expect(filterTrains(trains,"own","")).toEqual([]);
    expect(filterTrains(trains,"all","")).toHaveLength(3);
  });
  it("kombiniert die Suche nach nächstem Halt mit dem gewählten Unternehmen", () => {
    const trains=[train("1",{nextOperatingPoint:"München Hbf"}),train("2",{operatorId:"other",nextOperatingPoint:"München Hbf"})];
    expect(filterTrains(trains,"own","own"," MÜNCHEN ").map(t=>t.id)).toEqual(["1"]);
    expect(filterTrains(trains,"all","","re 2").map(t=>t.id)).toEqual(["2"]);
  });
  it("zählt fehlende Verspätung nicht als Pünktlichkeit und schließt beendete Fahrten aus", () => {
    const trains=[train("1"),train("2",{delaySeconds:60}),train("3",{delaySeconds:59,status:"at_platform"}),train("4",{delaySeconds:900,status:"completed"}),train("5",{status:"cancelled"}),train("6",{status:"planned"})];
    expect(liveOverview(trains)).toEqual({active:3,moving:2,delayed:1,unknownDelay:1});
    expect(trainSituation(trains[0]!)).toBe("Verspätung unbekannt");
    expect(trainSituation(trains[1]!)).toBe("+1 min");
  });
  it("stellt bestätigte Probleme zuerst dar und begrenzt den Überblick", () => {
    const trains=[train("1",{delaySeconds:0}),train("2",{delaySeconds:600}),train("3",{status:"cancelled"}),train("4",{status:"completed"}),train("5",{delaySeconds:120}),train("6",{delaySeconds:180})];
    expect(watchTrains(trains).map(t=>t.id)).toEqual(["3","2","6","5"]);
    expect(trainSituation(train("7",{positionFrozen:true,delaySeconds:0}))).toBe("Position wird geprüft");
  });
  it("behandelt Zugnamen als Text und zeigt einen hilfreichen leeren Zustand", () => {
    const markup=watchMarkup([train('a"<b>',{trainNumber:"<script>alert(1)</script>"})]);
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
    expect(watchMarkup([])).toContain("Sobald Fahrten unterwegs sind");
  });
});
