"""Offline source adapter; passenger generation and destination choice stay in Rust.

zugfolge:quelle=bkg-vg250-ew-2024
zugfolge:quelle=gtfs-de-rv
zugfolge:quelle=gtfs-de-fv
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from datetime import date, timedelta
from decimal import Decimal
from hashlib import sha256
from io import TextIOWrapper
import json
from math import isqrt
from pathlib import Path
import subprocess
from zipfile import ZipFile


DAY_MS = 86_400_000
CLASS_MINIMA = (1, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000)
SOURCE_LICENSES = {"bkg-vg250-ew-2024": "dl-de/by-2-0", "gtfs-de-rv": "CC BY 4.0", "gtfs-de-fv": "CC BY 4.0"}
SOURCE_PINS = {
    "bkg-vg250-ew-2024": ("https://daten.gdz.bkg.bund.de/produkte/vg/vg250-ew_ebenen_1231/2024/vg250-ew_12-31.ee.excel.ebenen.zip", "d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3"),
    "gtfs-de-rv": ("https://download.gtfs.de/germany/rv_free/latest.zip", "8ff77cb6bed7375d4cce5aa8f2027bfffe7e74bbc4bccd859237a96f2da24162"),
    "gtfs-de-fv": ("https://download.gtfs.de/germany/fv_free/latest.zip", "5e3efe3b3be69fb4bbbed0efc3fd8c2d8a0481c6a102a901ab1dc68219e45d40"),
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value):
    return sha256(canonical(value)).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value, name, low=0, high=2**32 - 1):
    require(type(value) is int and low <= value <= high, f"{name}: integer outside bounds")
    return value


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def service_dates(values):
    require(isinstance(values, list) and len(values) == 7, "exactly seven reference dates required")
    parsed = [date.fromisoformat(value) for value in values]
    require(all(right == left + timedelta(days=1) for left, right in zip(parsed, parsed[1:])), "reference dates must be consecutive and ascending")
    return parsed


def compact_date(value):
    require(len(value) == 8 and value.isascii() and value.isdecimal(), "invalid compact GTFS date")
    return date(int(value[:4]), int(value[4:6]), int(value[6:]))


def boarding_rule(value):
    value = value or "0"
    require(value in ("0", "1", "2", "3"), "invalid GTFS boarding restriction")
    # Telephone / driver arrangements are not unconditional direct services.
    return value == "0"


def verify_source_pin(source):
    require(source.get("id") in SOURCE_PINS and (source.get("url"), source.get("artifactSha256")) == SOURCE_PINS[source["id"]], "source does not match the reviewed provider and capture pin")


def active_dates(calendar_rows, exceptions, dates):
    active = defaultdict(set)
    days = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
    seen = set()
    for row in calendar_rows:
        ident = row["service_id"]
        require(ident not in seen, "duplicate GTFS calendar service")
        seen.add(ident)
        first, last = compact_date(row["start_date"]), compact_date(row["end_date"])
        require(first <= last and all(row[day] in ("0", "1") for day in days), "invalid GTFS calendar range or weekday flag")
        for day in dates:
            if first <= day <= last and row[days[day.weekday()]] == "1":
                active[ident].add(day.isoformat())
    seen_exceptions = set()
    for row in exceptions:
        key = (row["service_id"], row["date"])
        require(key not in seen_exceptions, "duplicate GTFS calendar exception")
        seen_exceptions.add(key)
        require(row["exception_type"] in ("1", "2"), "unknown GTFS calendar exception")
        day = compact_date(row["date"])
        if day in dates:
            if row["exception_type"] == "1":
                active[row["service_id"]].add(day.isoformat())
            else:
                active[row["service_id"]].discard(day.isoformat())
    return active


def gtfs_seconds(value):
    fields = value.split(":")
    require(len(fields) == 3 and all(field.isdecimal() for field in fields), "invalid GTFS time")
    hour, minute, second = map(int, fields)
    require(hour <= 167 and minute < 60 and second < 60, "GTFS time outside bounds")
    return hour * 3600 + minute * 60 + second


def e7(value, latitude=False):
    number = Decimal(value) * 10_000_000
    require(number.is_finite() and number == number.to_integral_value(), "GTFS coordinate exceeds E7 precision")
    return integer(int(number), "coordinate", -900_000_000 if latitude else -1_800_000_000, 900_000_000 if latitude else 1_800_000_000)


def capture_reference(config, archives):
    dates = service_dates(config["serviceDates"])
    selected = set(config["stationIds"])
    require(len(selected) == len(config["stationIds"]) and 2 <= len(selected) <= 200, "duplicate stations or station limit")
    stations, trips, sources = {}, [], []
    overlap_ids = set()
    for pin in sorted(config["gtfsSources"], key=lambda item: item["id"]):
        source_id = pin["id"]
        require(source_id in ("gtfs-de-rv", "gtfs-de-fv"), "unsupported GTFS source")
        verify_source_pin(pin)
        path = archives[source_id]
        require(sha256(path.read_bytes()).hexdigest() == pin["artifactSha256"], f"archive hash mismatch: {source_id}")
        with ZipFile(path) as archive:
            require(len(archive.namelist()) == len(set(archive.namelist())), "duplicate ZIP member")
            require(sum(info.file_size for info in archive.infolist()) <= 4 * 1024**3, "GTFS archive too large")

            def rows(name, optional=False):
                if optional and name not in archive.namelist():
                    return []
                return csv.DictReader(TextIOWrapper(archive.open(name), encoding="utf-8-sig", newline=""))

            require("frequencies.txt" not in archive.namelist(), "frequency-based feeds require an explicit expansion adapter")
            active = active_dates(rows("calendar.txt", True), rows("calendar_dates.txt", True), dates)
            routes = {}
            for row in rows("routes.txt"):
                require(row["route_id"] not in routes, "duplicate GTFS route")
                routes[row["route_id"]] = row
            candidates = {}
            all_ids = set()
            for row in rows("trips.txt"):
                require(row["trip_id"] not in all_ids, "duplicate GTFS trip")
                all_ids.add(row["trip_id"])
                require(row["route_id"] in routes, "GTFS trip has unknown route")
                if active[row["service_id"]] and routes[row["route_id"]]["route_type"] == "2":
                    candidates[row["trip_id"]] = row
            duplicate_cross_feed_ids = overlap_ids.intersection(all_ids)
            require(not duplicate_cross_feed_ids, "overlapping trip IDs across reference feeds require explicit reconciliation")
            overlap_ids.update(all_ids)
            for row in rows("stops.txt"):
                if row["stop_id"] not in selected:
                    continue
                station = {"stationId": row["stop_id"], "name": row["stop_name"], "parentStationId": row.get("parent_station") or None,
                           "latitudeE7": e7(row["stop_lat"], True), "longitudeE7": e7(row["stop_lon"])}
                require(station["stationId"] not in stations or stations[station["stationId"]] == station, "station facts differ between feeds")
                stations[station["stationId"]] = station
            selected_stops = defaultdict(list)
            for row in rows("stop_times.txt"):
                if row["trip_id"] not in candidates or row["stop_id"] not in selected:
                    continue
                # Explicit non-passenger calls cannot demonstrate a desired direct destination.
                pickup, dropoff = boarding_rule(row.get("pickup_type")), boarding_rule(row.get("drop_off_type"))
                if not pickup and not dropoff:
                    continue
                selected_stops[row["trip_id"]].append({"stationId": row["stop_id"], "stopSequence": int(row["stop_sequence"]),
                    "arrivalS": gtfs_seconds(row["arrival_time"]), "departureS": gtfs_seconds(row["departure_time"]),
                    "pickupAllowed": pickup, "dropoffAllowed": dropoff})
            for trip_id, stops in sorted(selected_stops.items()):
                trip = candidates[trip_id]
                stops.sort(key=lambda stop: stop["stopSequence"])
                require(len({stop["stopSequence"] for stop in stops}) == len(stops), "duplicate selected stop sequence")
                trips.append({"sourceId": source_id, "tripId": trip_id, "routeId": trip["route_id"],
                    "routeShortName": routes[trip["route_id"]]["route_short_name"], "serviceDates": sorted(active[trip["service_id"]]), "stops": stops})
        sources.append({**pin, "license": SOURCE_LICENSES[source_id], "rightsApproved": True})
    require(set(stations) == selected, f"selected stations missing: {sorted(selected - set(stations))}")
    require(all(any(day in trip["serviceDates"] for trip in trips if trip["sourceId"] == source["id"]) for source in sources for day in config["serviceDates"]), "reference source is not active on every selected day")
    return {"schemaVersion": "zugfolge-population-reference-timetable/v1", "serviceDates": config["serviceDates"],
            "sources": sources, "stations": sorted(stations.values(), key=lambda item: item["stationId"]),
            "trips": sorted(trips, key=lambda item: (item["sourceId"], item["tripId"]))}


def direct_connections(reference):
    dates = set(reference["serviceDates"])
    stations = {item["stationId"] for item in reference["stations"]}
    source_ids = {item["id"] for item in reference["sources"]}
    seen_trips, counts, source_counts = set(), Counter(), Counter()
    after_midnight = 0
    for trip in reference["trips"]:
        key = (trip["sourceId"], trip["tripId"])
        require(key not in seen_trips and trip["sourceId"] in source_ids, "duplicate or unbound reference trip")
        seen_trips.add(key)
        require(trip["serviceDates"] and len(set(trip["serviceDates"])) == len(trip["serviceDates"]) and set(trip["serviceDates"]) <= dates, "invalid reference trip dates")
        stops = sorted(trip["stops"], key=lambda stop: stop["stopSequence"])
        require(len({stop["stopSequence"] for stop in stops}) == len(stops), "duplicate reference stop sequence")
        previous_departure = -1
        for stop in stops:
            require(stop["stationId"] in stations, "unknown reference station")
            integer(stop["stopSequence"], "stopSequence")
            integer(stop["arrivalS"], "arrivalS", 0, 7 * 86400 - 1)
            integer(stop["departureS"], "departureS", stop["arrivalS"], 7 * 86400 - 1)
            require(stop["arrivalS"] >= previous_departure, "reference stop times are not monotonic")
            require(type(stop["pickupAllowed"]) is bool and type(stop["dropoffAllowed"]) is bool, "invalid boarding flags")
            previous_departure = stop["departureS"]
            after_midnight += int(stop["departureS"] >= 86400) * len(trip["serviceDates"])
        pairs = {(origin["stationId"], destination["stationId"])
                 for index, origin in enumerate(stops) for destination in stops[index + 1:]
                 if origin["stationId"] != destination["stationId"] and origin["pickupAllowed"] and destination["dropoffAllowed"]}
        for pair in pairs:
            counts[pair] += len(trip["serviceDates"])
            source_counts[trip["sourceId"]] += len(trip["serviceDates"])
    return counts, {"uniqueReferenceTrips": len(seen_trips), "directedPairs": len(counts),
                    "directConnectionsBySource": dict(sorted(source_counts.items())), "afterMidnightSelectedCalls": after_midnight}


def distance_mm(left, right):
    """Germany-only distance proxy: fixed scale, integer square root, no GIS claim."""
    dy = abs(left["latitudeE7"] - right["latitudeE7"]) * 11132 // 1000
    dx = abs(left["longitudeE7"] - right["longitudeE7"]) * 7000 // 1000
    return isqrt(dx * dx + dy * dy)


def allocate_population(settlements, stations, radius_mm):
    integer(radius_mm, "catchmentRadiusMm", 1, 100_000_000)
    allocations = {station["stationId"]: [] for station in stations}
    included, excluded, evidence = [], [], []
    for settlement in sorted(settlements, key=lambda row: row["id"]):
        population = integer(settlement["population"], "population")
        candidates = [(station["stationId"], distance_mm(settlement, station)) for station in stations]
        candidates = [(ident, distance) for ident, distance in candidates if distance <= radius_mm]
        if not candidates:
            excluded.append({"settlementId": settlement["id"], "population": population, "reason": "no-selected-station-within-radius"})
            continue
        included.append(settlement)
        weights = [(ident, distance, max(1, radius_mm - distance)) for ident, distance in candidates]
        total_weight = sum(weight for _, _, weight in weights)
        apportioned = [{"stationId": ident, "distanceMm": distance, "weight": weight,
                        "population": population * weight // total_weight, "remainder": population * weight % total_weight}
                       for ident, distance, weight in weights]
        remaining = population - sum(item["population"] for item in apportioned)
        for item in sorted(apportioned, key=lambda row: (-row["remainder"], row["stationId"]))[:remaining]:
            item["population"] += 1
        require(sum(item["population"] for item in apportioned) == population, "population allocation failed conservation")
        for item in apportioned:
            allocations[item["stationId"]].append({"settlementId": settlement["id"], "population": item["population"]})
        evidence.append({"settlementId": settlement["id"], "population": population, "allocations": sorted(apportioned, key=lambda row: row["stationId"])})
    return allocations, included, excluded, evidence


def demand_class(population):
    integer(population, "station population")
    return sum(population >= threshold for threshold in CLASS_MINIMA)


def select_population(population, selected_ids):
    """Same source-bound regional projection from a full or already selected input."""
    require(1 <= len(population["settlements"]) <= 20000, "population source row limit")
    rows = {row["id"]: row for row in population["settlements"]}
    require(len(rows) == len(population["settlements"]), "duplicate population settlement")
    require(len(set(selected_ids)) == len(selected_ids) and set(selected_ids) <= set(rows), "duplicate or missing selected settlement")
    return {**population, "settlements": [rows[ident] for ident in sorted(selected_ids)]}


def compile_release(config, population, reference):
    require(config["schemaVersion"] == "zugfolge-population-demand-build/v1", "unknown build configuration")
    require(population["schemaVersion"] == "zugfolge-settlement-population/v1", "unknown population schema")
    population = select_population(population, config["settlementIds"])
    require(population["referenceDate"] == "2024-12-31", "population reference date differs from approved capture")
    require(reference["schemaVersion"] == "zugfolge-population-reference-timetable/v1", "unknown reference schema")
    require(set(config["demandPolicy"]) == {"profiles", "daySlices", "seasonBasisPoints", "minimumTransferMs", "maxTransfers", "maxGeneratedPassengers", "maxConnectionsPerCohort", "fareCompliance"}, "unsupported demand policy field")
    integer(config["accessMs"], "accessMs", 0, DAY_MS)
    service_dates(config["serviceDates"])
    require(reference["serviceDates"] == config["serviceDates"], "reference dates differ from configuration")
    require(digest(reference) == config["referenceSha256"], "reference snapshot hash mismatch")
    require(digest(population) == config["populationSha256"], "population snapshot hash mismatch")
    stations = sorted(reference["stations"], key=lambda row: row["stationId"])
    require(len(stations) == len({station["stationId"] for station in stations}) and {station["stationId"] for station in stations} == set(config["stationIds"]), "station binding mismatch")
    require(2 <= len(stations) <= 200, "release station limit")
    for row in [*stations, *population["settlements"]]:
        integer(row["latitudeE7"], "latitudeE7", 470_000_000, 560_000_000)
        integer(row["longitudeE7"], "longitudeE7", 50_000_000, 160_000_000)
    settlement_rows = {item["id"]: item for item in population["settlements"]}
    require(len(settlement_rows) == len(population["settlements"]), "duplicate population settlement")
    require(len(set(config["settlementIds"])) == len(config["settlementIds"]), "duplicate settlement selection")
    require(set(config["settlementIds"]) <= set(settlement_rows), "selected settlement missing")
    settlements = [settlement_rows[ident] for ident in config["settlementIds"]]
    allocations, included, excluded, allocation_evidence = allocate_population(settlements, stations, config["catchmentRadiusMm"])
    require(included, "no settlement covered by selected stations")
    population_source = population["source"]
    source_pins = [population_source, *reference["sources"]]
    sources = [{key: source[key] for key in ("id", "url", "license", "artifactSha256", "rightsApproved")} for source in source_pins]
    require(len({item["id"] for item in sources}) == len(sources), "duplicate release source")
    for source in sources:
        verify_source_pin(source)
        require(source["rightsApproved"] is True and source["license"] == SOURCE_LICENSES.get(source["id"]), "source rights mismatch")
    require([{key: source[key] for key in ("id", "url", "artifactSha256")} for source in reference["sources"]]
            == sorted(config["gtfsSources"], key=lambda row: row["id"]), "GTFS source binding mismatch")
    counts, reference_metrics = direct_connections(reference)
    zones, areas = [], []
    for station in stations:
        ident = station["stationId"]
        mass = sum(item["population"] for item in allocations[ident])
        integer(mass, "station population")
        zone_id = f"station-{ident}"
        zones.append({"id": zone_id, "population": mass, "workplaces": 0, "poiWeight": 0,
                      "stations": [{"stationId": ident, "accessMs": config["accessMs"], "serviceIntervalMs": 0, "stepFree": False}]})
        areas.append({"zoneId": zone_id, "stationId": ident, "populationAllocations": sorted(allocations[ident], key=lambda row: row["settlementId"]), "demandClass": demand_class(mass)})
    binding = {"configSha256": digest(config), "populationSha256": digest(population), "referenceSha256": digest(reference),
               "sourceArtifacts": {source["id"]: source["artifactSha256"] for source in sources}}
    model = {"schemaVersion": "zugfolge-station-population-demand/v1",
        "settlements": [{"id": row["id"], "name": row["name"], "population": row["population"], "sourceId": population_source["id"]} for row in included],
        "stationAreas": sorted(areas, key=lambda row: row["zoneId"]),
        "referenceTimetable": {"id": config["referenceId"], "artifactSha256": digest(binding),
            "sourceIds": sorted(source["id"] for source in reference["sources"]), "serviceDates": config["serviceDates"]},
        "destinationPreferences": [{"originZoneId": f"station-{origin}", "destinationZoneId": f"station-{destination}", "referenceConnections": count}
                                  for (origin, destination), count in sorted(counts.items())]}
    release = {"schemaVersion": "zugfolge-demand-release/v1", "id": config["releaseId"], "provenance": "balanced",
        "sources": sorted(sources, key=lambda row: row["id"]), "zones": zones, **config["demandPolicy"], "populationModel": model}
    require(sum(zone["population"] for zone in zones) == sum(row["population"] for row in included), "release population conservation failed")
    report = {"schemaVersion": "zugfolge-population-demand-build-report/v1", "releaseId": release["id"], "releaseSha256": digest(release), "inputBinding": binding,
        "scope": "explicit-regional-station-selection", "populationProvenance": "official-statistics", "modelProvenance": "balanced",
        "distanceRule": {"id": "germany-e7-fixed-scale-integer-distance/v1", "latitudeMmPer1000E7": 11132, "longitudeMmPer1000E7": 7000, "squareRoot": "floor-isqrt"},
        "allocationRule": {"id": "linear-distance-largest-remainder/v1", "radiusMm": config["catchmentRadiusMm"], "weight": "max(1, radiusMm - distanceMm)", "tie": "stationId-ascending"},
        "selectedSettlements": len(settlements), "includedSettlements": len(included), "uncoveredSettlements": excluded,
        "populationInput": sum(row["population"] for row in settlements), "populationAllocated": sum(zone["population"] for zone in zones),
        "populationUncovered": sum(row["population"] for row in excluded), "allocations": allocation_evidence,
        "stations": [{**station, "population": zone["population"], "demandClass": demand_class(zone["population"])} for station, zone in zip(stations, zones)],
        "referenceMetrics": reference_metrics,
        "limitations": ["No administrative territory or measured catchment claim; municipal representative points and configured station selection only.",
            "No observed OD, ridership, workplaces, interchange flows or exact forecast; population, source service and own balancing remain distinct.",
            "Original GTFS stop IDs are retained. Other platforms and stations are outside this explicit selection.",
            "GTFS services are reference evidence only and are never activated as player services by this adapter."]}
    return release, report


def compile_deployment(release, template):
    require(template["schemaVersion"] == "zugfolge-demand-deployment/v1", "unknown deployment template")
    require(isinstance(template["windows"], list) and 1 <= len(template["windows"]) <= 256, "invalid deployment windows")
    slices = {item["id"] for item in release["daySlices"]}
    windows = []
    for window in template["windows"]:
        require(window["schemaVersion"] == "zugfolge-demand-evaluation/v1" and window["worldId"] == template["worldId"], "world mismatch in deployment template")
        require("previousEvaluation" not in window and "operationalProgress" not in window, "deployment template must be an unstarted pool")
        generation = window.get("generationWindows")
        require((generation is None and window["daySliceId"] in slices)
                or (isinstance(generation, list) and len(generation) > 0 and window["daySliceId"] == "pooled"
                    and all(item["daySliceId"] in slices for item in generation)), "template day slices differ from generated release")
        require(all(service["worldId"] == template["worldId"] for service in window["services"]), "foreign service world")
        windows.append({**window, "release": release})
    return {**template, "windows": windows}


def native_summary(result, release):
    """Projection of actual native cohorts, never a second demand calculation."""
    by_origin = defaultdict(Counter)
    for cohort in result["cohorts"]:
        by_origin[cohort["originZoneId"]][cohort["destinationZoneId"]] += cohort["passengers"]
    journeys_by_mode = Counter()
    for choice in result["choices"]:
        for mode in {train["mode"] for train in choice["trains"]}:
            journeys_by_mode[mode] += choice["passengers"]
    return {"schemaVersion": "zugfolge-population-native-summary/v1", "worldId": result["worldId"],
        "stateHash": result["stateHash"], "releaseHash": result["releaseHash"], "projectionMode": result["projectionMode"], "totals": result["totals"],
        "passengerJourneysUsingMode": dict(sorted(journeys_by_mode.items())),
        "stations": [{"stationId": area["stationId"], "zoneId": area["zoneId"], "demandClass": area["demandClass"],
            "allocatedPopulation": sum(allocation["population"] for allocation in area["populationAllocations"]),
            "generatedPassengers": sum(by_origin[area["zoneId"]].values()),
            "topDestinations": [{"destinationZoneId": destination, "passengers": count}
                for destination, count in sorted(by_origin[area["zoneId"]].items(), key=lambda row: (-row[1], row[0]))[:5]]}
            for area in release["populationModel"]["stationAreas"]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--population", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--rv-gtfs", type=Path)
    parser.add_argument("--fv-gtfs", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--deployment-template", type=Path)
    parser.add_argument("--binary", type=Path, help="Real Rust evaluate_json; validates each exported pool and its deterministic replay")
    args = parser.parse_args()
    config, population = read_json(args.config), read_json(args.population)
    if args.rv_gtfs or args.fv_gtfs:
        require(args.rv_gtfs and args.fv_gtfs, "both pinned GTFS archives required")
        reference = capture_reference(config, {"gtfs-de-rv": args.rv_gtfs, "gtfs-de-fv": args.fv_gtfs})
        require(digest(reference) == config["referenceSha256"], "captured reference differs from approved configuration pin")
        write_json(args.reference, reference)
    else:
        reference = read_json(args.reference)
    release, report = compile_release(config, population, reference)
    args.output.mkdir(parents=True, exist_ok=True)
    write_json(args.output / "release.json", release)
    if args.deployment_template:
        deployment = compile_deployment(release, read_json(args.deployment_template))
        encoded = json.dumps(deployment, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        require(len(encoded) <= 16 * 1024**2, "deployment exceeds API size limit")
        (args.output / "deployment.json").write_bytes(encoded)
        report["deploymentSha256"] = sha256(encoded).hexdigest()
        report["nativeRuns"] = []
        if args.binary:
            require(args.binary.is_absolute(), "native binary path must be absolute")
            for index, evaluation in enumerate(deployment["windows"]):
                payload = canonical(evaluation)
                results = [json.loads(subprocess.run([str(args.binary)], input=payload, capture_output=True, check=True, timeout=120).stdout) for _ in range(2)]
                require(results[0] == results[1], "Rust replay differs")
                result = results[0]
                write_json(args.output / f"native-summary-{index}.json", native_summary(result, release))
                report["nativeRuns"].append({"windowIndex": index, "inputSha256": sha256(payload).hexdigest(),
                    "resultSha256": digest(result), "stateHash": result["stateHash"], "binarySha256": sha256(args.binary.read_bytes()).hexdigest(),
                    "replayEqual": True, "totals": result["totals"]})
    require(not args.binary or args.deployment_template, "native validation requires a deployment template")
    write_json(args.output / "report.json", report)
    print(json.dumps({"releaseSha256": report["releaseSha256"], "populationAllocated": report["populationAllocated"],
                      "stations": len(report["stations"]), "directedPairs": report["referenceMetrics"]["directedPairs"]}))


if __name__ == "__main__":
    main()
