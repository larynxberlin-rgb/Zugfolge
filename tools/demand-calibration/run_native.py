#!/usr/bin/env python3
"""Training-only Schätzparameter und ehrlicher Holdout-Vergleich mit dem Rust-Kern."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
from collections import Counter, defaultdict
from fractions import Fraction
from pathlib import Path

from build_observations import ROOT, SELECTION, SOURCE_ID, require_hash, sha256, tenths

DAY_MS = 86_400_000
WORLD = "nvbw-re7-calibration"


def rounded_ratio(numerator: int, denominator: int) -> int:
    return (numerator * 2 + denominator) // (denominator * 2)


def trip_groups(rows: list[dict[str, str]]) -> dict[tuple, list[dict[str, str]]]:
    trips = defaultdict(list)
    for row in rows:
        key = tuple(row[field] for field in ["Datum", "Teilnetz", "Vertrag", "Zugnummer", "Linie"])
        trips[key].append(row)
    for calls in trips.values():
        calls.sort(key=lambda row: int(row["Index"]))
    return dict(sorted(trips.items()))


def build_inputs(rows: list[dict[str, str]], source: dict) -> tuple[dict, dict]:
    trips = trip_groups(rows)
    training_rows = [row for row in rows if SELECTION[row["Datum"]] == "training"]
    all_training_calls = Counter(row["DHID"] for row in training_rows)
    measured_training = [row for key, calls in trips.items()
                         if SELECTION[key[0]] == "training"
                         and all(row["Fahrgastzahlenart"] == "Zählfahrt AFZS" for row in calls)
                         for row in calls]
    measured_training_calls = Counter(row["DHID"] for row in measured_training)
    boarding = Counter()
    alighting = Counter()
    for row in measured_training:
        boarding[row["DHID"]] += tenths(row["Einsteiger"])
        alighting[row["DHID"]] += tenths(row["Aussteiger"])
    hour_boardings = Counter()
    measured_hours = Counter()
    # NVBW verwendet Betriebsstunden 24/25 für den Folgetag. Die Gewichtung
    # gehört zur gleichen Uhrzeit wie die zugehörige Fahrt, nicht 24 h davor.
    training_hours = Counter(int(row["Abfahrtszeit"].split(":")[0]) for row in training_rows)
    operating_hours = sorted(training_hours)
    if not operating_hours or operating_hours[0] < 0 or operating_hours[-1] - operating_hours[0] >= 24:
        raise ValueError("Trainings-Betriebstag muss in ein eindeutiges 24-Stunden-Profil passen")
    for row in measured_training:
        hour = int(row["Abfahrtszeit"].split(":")[0])
        hour_boardings[hour] += tenths(row["Einsteiger"])
        measured_hours[hour] += 1
    expanded_hours = [Fraction(0) for _ in range(24)]
    for hour in operating_hours:
        expanded_hours[hour % 24] = (Fraction(hour_boardings[hour] * training_hours[hour], measured_hours[hour])
                                     if measured_hours[hour] else Fraction(0))
    total_hours = sum(expanded_hours)
    shares = [int(value * 10000 / total_hours) for value in expanded_hours]
    residual = 10000 - sum(shares)
    order = sorted(range(24), key=lambda hour: (-(expanded_hours[hour] * 10000 / total_hours - shares[hour]), hour))
    for hour in order[:residual]:
        shares[hour] += 1
    stations = sorted(set(row["DHID"] for row in rows))
    zones = [{"id": station,
              "population": rounded_ratio(boarding[station] * all_training_calls[station], 10 * measured_training_calls[station]) if measured_training_calls[station] else 0,
              "workplaces": rounded_ratio(alighting[station] * all_training_calls[station], 10 * measured_training_calls[station]) if measured_training_calls[station] else 0,
              "poiWeight": 0,
              "stations": [{"stationId": station, "accessMs": 0, "serviceIntervalMs": 0, "stepFree": True}]}
             for station in stations]
    release = {
        "schemaVersion": "zugfolge-demand-release/v1", "id": "nvbw-re7-training-2025-01-14-v1",
        "provenance": "balanced", "sources": [{field: source[field] for field in
                                                ["id", "url", "license", "artifactSha256", "rightsApproved"]}],
        "zones": zones,
        "profiles": [{"id": "marginal-balance", "purpose": "unspecified-training-marginals",
                      "dailyTripsBasisPoints": 10000, "workplaceWeight": 1, "poiWeight": 0, "populationWeight": 0,
                      "comfortClass": "standard", "spaceNeeds": "ordinary", "requiresReservation": False,
                      "maxFareCents": 0, "maxJourneyMs": DAY_MS,
                      "ranking": ["fare", "time", "transfers", "frequency", "reliability", "comfort"]}],
        "daySlices": [{"id": f"hour-{hour:02d}", "startOffsetMs": hour * 3600000,
                       "endOffsetMs": (hour + 1) * 3600000, "shareBasisPoints": shares[hour]} for hour in range(24)],
        "seasonBasisPoints": 10000, "minimumTransferMs": 0, "maxTransfers": 0,
        "maxGeneratedPassengers": 100000, "maxConnectionsPerCohort": 256,
        "fareCompliance": {"schemaVersion": "fare-compliance-policy/v1", "validBasisPoints": 10000,
                           "unpresentableBasisPoints": 0, "provenance": "balanced", "sourceIds": []},
    }
    inputs = {}
    for day, split in SELECTION.items():
        services = []
        for key, calls in trips.items():
            if key[0] != day:
                continue
            run_id = "nvbw:" + hashlib.sha256(json.dumps(key).encode()).hexdigest()[:16]
            stops = []
            previous = -1
            offset = 0
            for row in calls:
                hour, minute = map(int, row["Abfahrtszeit"].split(":"))
                departure = (hour * 60 + minute) * 60000 + offset
                if departure < previous:
                    offset += DAY_MS
                    departure += DAY_MS
                if departure <= previous:
                    raise ValueError(f"Nicht strikt steigende Quellzeit: {row['sourceRowNumber']}")
                previous = departure
                stops.append({"stopId": "source-row:" + row["sourceRowNumber"], "stationId": row["DHID"],
                              "arrivalMs": departure, "departureMs": departure, "passengerStop": True})
            reported = [tenths(row["Ist-Sitzplätze"]) // 10 for row in calls if row["Ist-Sitzplätze"]]
            positive = [count for count in reported if count > 0]
            if not positive:
                positive = [tenths(row["Soll-Sitzplätze"]) // 10 for row in calls if row["Soll-Sitzplätze"] and tenths(row["Soll-Sitzplätze"]) > 0]
            if not positive:
                raise ValueError(f"Keine gemeldete Kapazität: {key}")
            services.append({
                "worldId": WORLD, "trainRunId": run_id, "operatorId": "nvbw-calibration-only", "mode": "spnv",
                "cancelled": False, "stops": stops,
                "fares": [{"id": "balanced-zero-fare", "comfortClass": "standard", "centsPerSegment": 0,
                           "salesAvailable": True, "onboardSales": False, "reservationRequired": False}],
                "capacity": {"standardSeats": min(positive), "standardStanding": 0, "premiumSeats": 0,
                             "wheelchairSpaces": 0, "bicycleSpaces": 0, "strollerSpaces": 0},
                "serviceIntervalMs": 0, "reliabilityBasisPoints": 10000, "comfortBasisPoints": 5000,
            })
        inputs[split] = {"schemaVersion": "zugfolge-demand-evaluation/v1", "worldId": WORLD,
                         "periodId": "-".join(reversed(day.split("."))), "seed": "42", "nowMs": 0,
                         "revision": 1, "windowStartMs": operating_hours[0] * 3600000,
                         "windowEndMs": (operating_hours[-1] + 1) * 3600000, "daySliceId": "pooled",
                         "generationWindows": [{"windowStartMs": hour * 3600000, "windowEndMs": (hour + 1) * 3600000,
                                                "daySliceId": f"hour-{hour % 24:02d}"} for hour in operating_hours],
                         "release": release, "services": services, "alternatives": []}
    parameters = {"schemaVersion": "zugfolge-demand-training-parameters/v1", "trainingDate": "2025-01-14",
                  "sourceRowNumbers": [int(row["sourceRowNumber"]) for row in measured_training],
                  "effectiveGeneratedPassengers": sum(zone["population"] for zone in zones),
                  "stationCount": len(zones), "releaseSha256": hashlib.sha256(json.dumps(release, sort_keys=True).encode()).hexdigest(),
                  "provenance": "balanced", "hourlySharesBasisPoints": shares,
                  "generationOperatingHours": operating_hours, "release": release}
    return inputs, parameters


def native_evaluate(binary: Path, value: dict) -> dict:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    result = subprocess.run([str(binary)], input=encoded, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
    output = json.loads(result.stdout)
    if output["worldId"] != WORLD or output["periodId"] != value["periodId"]:
        raise ValueError("Rust-Ergebnis gehört nicht zum eingegebenen Kalibrierfenster")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    manifest = json.loads((ROOT / "sources/manifest.json").read_text(encoding="utf-8"))
    for artifact in manifest["bundledArtifacts"]:
        require_hash(ROOT / artifact["path"], artifact["sha256"])
    source = next(source for source in manifest["sources"] if source["id"] == SOURCE_ID)
    with (ROOT / "sources/nvbw-re7-selection.csv").open(encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream, delimiter=";"))
    inputs, parameters = build_inputs(rows, source)
    # Modellbildung ist abgeschlossen, bevor Beobachtungszielwerte gelesen werden.
    (ROOT / "training-parameters.json").write_text(json.dumps(parameters, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    observations = json.loads((ROOT / "observations.json").read_text(encoding="utf-8"))["observations"]
    outcomes = {}
    deviations = []
    for split, value in inputs.items():
        (ROOT / f"input-{split}.json").write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    for split, value in inputs.items():
        try:
            first = native_evaluate(binary, value)
            replay = native_evaluate(binary, value)
        except RuntimeError as error:
            failure = {"schemaVersion": "zugfolge-demand-limited-native-calibration/v1", "status": "native-error",
                       "failedSplit": split, "error": str(error).strip(), "nativeBinarySha256": sha256(binary),
                       "trainingParametersSha256": sha256(ROOT / "training-parameters.json"),
                       "inputHashes": {key: sha256(ROOT / f"input-{key}.json") for key in inputs},
                       "observationsSha256": sha256(ROOT / "observations.json"), "nativeOutcomes": outcomes,
                       "fullM10CalibrationAccepted": False, "spnvMeasuredSubsetAccepted": False}
            (ROOT / "native-report.json").write_text(json.dumps(failure, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
            raise
        if first != replay:
            raise ValueError("Nativer Replay ist nicht bitgleich")
        outcomes[split] = {"stateHash": first["stateHash"], "releaseHash": first["releaseHash"],
                           "totals": first["totals"], "inputSha256": sha256(ROOT / f"input-{split}.json"),
                           "replayEqual": True, "services": len(value["services"])}
        boardings = {row["stopId"]: row["boarding"] for row in first["stopFlows"]}
        loads = {row["fromStopId"]: row["passengers"] for row in first["allocations"]}
        for observation in observations:
            if observation["split"] != split:
                continue
            values = boardings if observation["metric"] == "daily_profile" else loads
            keys = [f"source-row:{row}" for row in observation["sampleRows"]]
            if any(key not in values for key in keys):
                raise ValueError(f"Rust-Ergebnis enthält nicht alle beobachteten Halte/Abschnitte: {observation['id']}")
            simulated = sum(values[key] for key in keys)
            observed = observation["observedPassengers"]
            allowed = max(20, observed * 2500 // 10000)
            deviations.append({"observationId": observation["id"], "split": split, "metric": observation["metric"],
                               "observedPassengers": observed, "simulatedPassengers": simulated,
                               "absoluteDeviation": abs(simulated - observed), "allowedDeviation": allowed,
                               "accepted": abs(simulated - observed) <= allowed})
    summary = []
    for split in ["training", "holdout"]:
        for metric in ["daily_profile", "cross_section"]:
            selected = [row for row in deviations if row["split"] == split and row["metric"] == metric]
            observed = sum(row["observedPassengers"] for row in selected)
            absolute = sum(row["absoluteDeviation"] for row in selected)
            summary.append({"split": split, "metric": metric, "observations": len(selected),
                            "acceptedObservations": sum(row["accepted"] for row in selected),
                            "observedSum": observed, "simulatedSum": sum(row["simulatedPassengers"] for row in selected),
                            "absoluteDeviationSum": absolute,
                            "weightedAbsolutePercentageErrorBasisPoints": absolute * 10000 // observed if observed else None})
    report = {"schemaVersion": "zugfolge-demand-limited-native-calibration/v1",
              "comparisonVersion": "nvbw-re7-native-comparison/v2", "sourceId": SOURCE_ID,
              "nativeBinarySha256": sha256(binary), "trainingParametersSha256": sha256(ROOT / "training-parameters.json"),
              "observationsSha256": sha256(ROOT / "observations.json"), "tolerance": {"absolutePassengers": 20, "relativeBasisPoints": 2500},
              "nativeOutcomes": outcomes, "summary": summary, "deviations": deviations,
              "spnvMeasuredSubsetAccepted": all(row["accepted"] for row in deviations if row["split"] == "holdout"),
              "fullM10CalibrationAccepted": False,
              "missingRequiredHoldouts": ["spnv/transfer_flow", "spfv/daily_profile", "spfv/cross_section", "spfv/transfer_flow"],
              "limitations": ["See README native comparison v2: balanced OD/marginals and training-derived hourly shares on the source operating-day axis, zero fares/dwell/standing, observed train mask, cross-border RE7 only."]}
    (ROOT / "native-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"summary": summary, "spnvMeasuredSubsetAccepted": report["spnvMeasuredSubsetAccepted"],
                      "fullM10CalibrationAccepted": False}, ensure_ascii=True))


if __name__ == "__main__":
    main()
