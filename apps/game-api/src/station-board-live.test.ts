import { expect, it } from "vitest";
import type { PublicTrain, StationBoardV1 } from "@zugfolge/livemap-stream";
import { projectStationBoardWithLiveState } from "./livemap-read-routes.js";

const train: PublicTrain = { id: "train-1", operator: "Bahn", trainNumber: "RE1", category: "RE", positionMm: 0, speedMmPerSecond: 0, delaySeconds: 0, nextOperatingPoint: "station-a", status: "at_platform" };
function board(stationId: string, atS: number, stops = [100, 1_000]): StationBoardV1 {
  const call = { trainId: train.id, trainNumber: "RE1", category: "RE", status: "scheduled" as const, expectedTimeS: 0 };
  return { schemaVersion: "zugfolge-station-board/v1", worldId: "world", stationId, stationName: stationId, streamId: "stream", sequence: 1, atS,
    arrivals: stops.map((scheduledTimeS) => ({ ...call, scheduledTimeS })), departures: stops.map((at) => ({ ...call, scheduledTimeS: at + 60 })) };
}

it("unterscheidet drei Stationen und nimmt Ankunft an B/C beim Halt an A nicht vorweg", () => {
  for (const station of ["station-b", "station-c"]) {
    const projected = projectStationBoardWithLiveState(board(station, 130), [train], []);
    expect(projected.arrivals.map((call) => call.status)).toEqual(["scheduled", "scheduled"]);
    expect(projected.departures.map((call) => call.status)).toEqual(["scheduled", "scheduled"]);
  }
  const current = projectStationBoardWithLiveState(board("station-a", 130), [train], []);
  expect(current.arrivals.map((call) => call.status)).toEqual(["arrived", "scheduled"]);
  expect(current.departures.map((call) => call.status)).toEqual(["boarding", "scheduled"]);
});

it("ordnet Wiederholungsbesuche und fehlende Haltbelege konservativ ein", () => {
  const later = projectStationBoardWithLiveState(board("station-a", 1_030), [train], []);
  expect(later.departures.map((call) => call.status)).toEqual(["departed", "boarding"]);
  const ambiguous = projectStationBoardWithLiveState(board("station-a", 500), [train], []);
  expect(ambiguous.departures.every((call) => call.status === "scheduled")).toBe(true);
  const missing = projectStationBoardWithLiveState(board("station-a", 130), [{ ...train, delaySeconds: undefined }], []);
  expect(missing.arrivals.every((call) => call.status === "scheduled")).toBe(true);
});

it("bindet Verspaetung, Ausfall und Tagesinstanz an denselben Lauf", () => {
  const delayed = projectStationBoardWithLiveState(board("station-a", 230), [{ ...train, delaySeconds: 100 }], []);
  expect(delayed.arrivals[0]).toMatchObject({ status: "arrived", expectedTimeS: 200 });
  const cancelled = projectStationBoardWithLiveState(board("station-b", 130), [{ ...train, status: "cancelled" }], []);
  expect(cancelled.arrivals.every((call) => call.status === "cancelled")).toBe(true);
  const dayBoard = board("station-a", 86_530, [86_500]);
  const scoped = { ...dayBoard, arrivals: dayBoard.arrivals.map((call) => ({ ...call, trainId: "train-1:day-1" })), departures: dayBoard.departures.map((call) => ({ ...call, trainId: "train-1:day-1" })) };
  expect(projectStationBoardWithLiveState(scoped, [train], []).arrivals[0]?.status).toBe("scheduled");
  expect(projectStationBoardWithLiveState(scoped, [{ ...train, id: "train-1:day-1", baseTrainRunId: "train-1" }], []).arrivals[0]?.status).toBe("arrived");
});
