import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNormalizedScheduleTimeContract,
  assertRegionalAlphaReleaseContract,
} from "./regional-release-contract.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function fixture() {
  return {
    gtfsEnvelope: {
      snapshotHash: HASH_A,
      snapshot: {
        regionId: "mitteldeutschland-b",
        regionVariant: "B",
        serviceDate: "20260810",
      },
    },
    gtfsBytesSha256: HASH_B,
    infraRelease: {
      schema: "zugfolge-infra-release/v1",
      releaseId: "infra-mitteldeutschland-b-2026.2",
      releaseHash: HASH_C,
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      timetableYear: 2026,
      artifacts: [{
        kind: "gtfs-planning-snapshot",
        file: "gtfs-region-20260810-v2.json",
        serviceDate: "20260810",
        sha256: HASH_B,
        stateHash: HASH_A,
      }],
    },
    worldEpoch: "2026-08-10T00:00:00.000Z",
  };
}

test("bindet Release 2026.2, Verkehrstag und Fleet-ID eindeutig", () => {
  assert.deepEqual(assertRegionalAlphaReleaseContract(fixture()), {
    fleetReleaseId: "fleet-alpha-mitteldeutschland-b-2026.2",
    releaseVersion: "2026.2",
    serviceDate: "20260810",
    timetableYear: 2026,
  });
});

test("verweigert eine vom Verkehrstag abweichende Weltepoche", () => {
  const input = fixture();
  input.worldEpoch = "2026-08-17T00:00:00.000Z";
  assert.throws(() => assertRegionalAlphaReleaseContract(input), /Weltepoche und GTFS-serviceDate/);
});

test("verweigert umbenannte, doppelte oder inhaltlich abweichende GTFS-Artefakte", () => {
  for (const mutate of [
    (input) => { input.infraRelease.artifacts[0].file = "gtfs-region-20260812-v2.json"; },
    (input) => { input.infraRelease.artifacts.push({ ...input.infraRelease.artifacts[0] }); },
    (input) => { input.infraRelease.artifacts[0].sha256 = HASH_C; },
    (input) => { input.infraRelease.artifacts[0].stateHash = HASH_C; },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => assertRegionalAlphaReleaseContract(input), /GTFS-Artefakt/);
  }
});

test("verweigert nicht versionierte oder jahresfremde InfraRelease-IDs", () => {
  for (const releaseId of ["infra-mitteldeutschland-b-2026", "infra-mitteldeutschland-b-2027.2"]) {
    const input = fixture();
    input.infraRelease.releaseId = releaseId;
    assert.throws(() => assertRegionalAlphaReleaseContract(input), /ungueltig/);
  }
});

test("normalisiert Runtime und ReadModel auf dieselbe taegliche Weltzeitachse", () => {
  const contract = {
    worldEpoch: "2026-08-10T00:00:00.000Z",
    serviceDate: "20260810",
    timeZone: "Europe/Berlin",
    serviceStartOffsetS: 0,
    repeatEveryS: 86_400,
  };
  assert.deepEqual(assertNormalizedScheduleTimeContract(contract), contract);
  for (const mutate of [
    (value) => { value.worldEpoch = "2026-08-11T00:00:00.000Z"; },
    (value) => { value.timeZone = "UTC"; },
    (value) => { value.serviceStartOffsetS = -7_200; },
    (value) => { value.repeatEveryS = 172_800; },
  ]) {
    const value = { ...contract };
    mutate(value);
    assert.throws(() => assertNormalizedScheduleTimeContract(value), /Schedule-/);
  }
});
