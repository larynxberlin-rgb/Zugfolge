#!/usr/bin/env python3
"""Offline-ETL für den beobachteten M10-SPNV-Kalibrierkorpus, keine Nachfrage-Engine."""
# zugfolge:quelle=nvbw-fahrgastzaehlung-2025
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE_ID = "nvbw-fahrgastzaehlung-2025"
SELECTION = {"14.01.2025": "training", "21.01.2025": "holdout"}
LINE = "RE 7"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def require_hash(path: Path, expected: str) -> None:
    actual = sha256(path)
    if actual != expected:
        raise ValueError(f"Quellenhash weicht ab: {path.name}: {actual} != {expected}")


def tenths(value: str) -> int:
    if not value:
        raise ValueError("Fehlender Messwert darf nicht als Null verwendet werden")
    result = Decimal(value.replace(",", ".")) * 10
    if not result.is_finite() or result < 0 or result != result.to_integral_value():
        raise ValueError(f"Ungültiger Zehntel-Messwert: {value!r}")
    return int(result)


def select_original(original: Path, target: Path, expected_hash: str) -> None:
    require_hash(original, expected_hash)
    rows = []
    with gzip.open(original, "rt", encoding="cp1252", newline="") as stream:
        reader = csv.DictReader(stream, delimiter=";")
        fields = ["sourceRowNumber", *(reader.fieldnames or [])]
        for row in reader:
            if row["Datum"] in SELECTION and row["Linie"] == LINE:
                rows.append({"sourceRowNumber": reader.line_num, **row})
    if not rows or set(row["Datum"] for row in rows) != set(SELECTION):
        raise ValueError("Gepinnte Kalendertage fehlen in der Quelle")
    with target.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, delimiter=";", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def build(rows: list[dict[str, str]]) -> dict:
    trips: dict[tuple, list[dict[str, str]]] = defaultdict(list)
    coverage: dict[str, Counter] = {day: Counter() for day in SELECTION}
    for row in rows:
        if row["Datum"] not in SELECTION or row["Linie"] != LINE:
            raise ValueError("Unzulässige Zeile außerhalb des Auswahlvertrags")
        coverage[row["Datum"]][row["Fahrgastzahlenart"]] += 1
        key = tuple(row[field] for field in ["Datum", "Teilnetz", "Vertrag", "Zugnummer", "Linie"])
        trips[key].append(row)

    # Dieselbe Maske wird später auf Modellfahrten angewandt; keine Ergänzung fehlender Messungen.
    groups: dict[tuple, list] = defaultdict(list)
    excluded_trips = Counter()
    measured_trips = Counter()
    for key, calls in sorted(trips.items()):
        calls.sort(key=lambda row: int(row["Index"]))
        if any(row["Fahrgastzahlenart"] != "Zählfahrt AFZS" for row in calls):
            excluded_trips[key[0]] += 1
            continue
        indices = [int(row["Index"]) for row in calls]
        if len(indices) != len(set(indices)):
            raise ValueError(f"Mehrdeutige Fahrt/Stationsreihenfolge: {key}")
        measured_trips[key[0]] += 1
        for i, row in enumerate(calls):
            if not row["DHID"] or not row["Abfahrtszeit"]:
                raise ValueError(f"Messfahrt ohne Station/Zeit: {row['sourceRowNumber']}")
            hour = int(row["Abfahrtszeit"].split(":")[0])
            if hour < 0 or hour > 47:
                raise ValueError(f"Unerwartete Fahrplantagesstunde: {hour}")
            # Stunden jenseits Mitternacht behalten den Betriebstag und werden nicht zurückgefaltet.
            groups[(key[0], "daily_profile", str(hour))].append(
                (tenths(row["Einsteiger"]), row, None))
            if i + 1 < len(calls):
                following = calls[i + 1]
                if int(following["Index"]) != int(row["Index"]) + 1 or not following["DHID"]:
                    raise ValueError(f"Nicht zusammenhängender gemessener Abschnitt: {key}")
                groups[(key[0], "cross_section", row["DHID"], following["DHID"])].append(
                    (tenths(row["Belegung abg."]), row, following))

    observations = []
    for group, sample in sorted(groups.items()):
        day, metric, *dimensions = group
        iso_day = "-".join(reversed(day.split(".")))
        exact_tenths = sum(value[0] for value in sample)
        scope = {"line": LINE, "operatingDate": iso_day, "timeZone": "Europe/Berlin",
                 "countingMethod": "AFZS", "serviceMask": "only-fully-AFZS-counted-trips"}
        if metric == "daily_profile":
            scope.update({"measure": "boardings", "hourFrom": int(dimensions[0]),
                          "hourUntil": int(dimensions[0]) + 1})
        else:
            scope.update({"measure": "departing-occupancy", "fromDhid": dimensions[0],
                          "toDhid": dimensions[1], "fromLabel": sample[0][1]["Stationsname"],
                          "toLabel": sample[0][2]["Stationsname"]})
        observations.append({
            "id": ":".join(["nvbw", iso_day, "re7", metric, *dimensions]),
            "split": SELECTION[day], "sourceId": SOURCE_ID, "mode": "spnv", "metric": metric,
            "provenance": "observed", "observedPassengers": (exact_tenths + 5) // 10,
            "observedPassengerTenths": exact_tenths, "scope": scope,
            "sampleRows": [int(item[1]["sourceRowNumber"]) for item in sample],
            "sampleTrainNumbers": [item[1]["Zugnummer"] for item in sample],
        })
    return {
        "schemaVersion": "zugfolge-demand-observation-pack/v1",
        "selectionVersion": "nvbw-re7-two-tuesdays/v1",
        "rounding": "Sum exact decimal tenths; round total half up to whole passengers",
        "sourceArtifactSha256": "74de5f8b36d8b9819d30cfc2a435cf26595bdae49d09c184375a2e45b6af63ff",
        "coverage": [{"operatingDate": "-".join(reversed(day.split("."))),
                      "sourceRowsByType": dict(sorted(counts.items())),
                      "measuredTrips": measured_trips[day], "excludedTrips": excluded_trips[day]}
                     for day, counts in sorted(coverage.items())],
        "observations": observations,
        "missingRequiredHoldouts": ["spnv/transfer_flow", "spfv/daily_profile",
                                    "spfv/cross_section", "spfv/transfer_flow"],
        "simulationComparison": {"status": "not-run", "reason": "Requires matching native model, source-to-world station mapping, and identical measured-trip mask"},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nvbw-original", type=Path)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "sources/manifest.json").read_text(encoding="utf-8"))
    source = next(source for source in manifest["sources"] if source["id"] == SOURCE_ID)
    selection = ROOT / "sources/nvbw-re7-selection.csv"
    if args.nvbw_original:
        select_original(args.nvbw_original, selection, source["artifactSha256"])
    for artifact in manifest["bundledArtifacts"]:
        require_hash(ROOT / artifact["path"], artifact["sha256"])
    with selection.open(encoding="utf-8", newline="") as stream:
        result = build(list(csv.DictReader(stream, delimiter=";")))
    target = ROOT / "observations.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"observations": len(result["observations"]), "coverage": result["coverage"],
                      "sha256": sha256(target)}, ensure_ascii=True))


if __name__ == "__main__":
    main()
