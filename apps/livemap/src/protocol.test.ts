import { describe, expect, it } from "vitest";
import { applyDelta, initialState, interpolatedPosition, type Snapshot } from "./protocol.js";
const snapshot: Snapshot = { worldId: "welt-1", sequence: 4, at: 100, trains: [{ id:"1", operator:"Elbtalbahn", trainNumber:"RE 1", category:"Regional", positionMm:1_000, speedMmPerSecond:20, delaySeconds:0, nextOperatingPoint:"Halle Hbf", status:"running" }] };
describe("Livemap-Protokoll", () => { it("fordert bei Sequenzlücken einen Snapshot",()=>expect(applyDelta(initialState(snapshot),{worldId:"welt-1",sequence:6,at:101,changed:[],removed:[]})).toBeUndefined()); it("interpoliert höchstens zehn Sekunden",()=>expect(interpolatedPosition(snapshot.trains[0]!,100,120)).toBe(1_200)); });
