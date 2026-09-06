"""Pure data-maintenance contract; passenger demand is still generated in Rust."""

from copy import deepcopy
from datetime import date, timedelta
import hashlib
import json
import re


DATA_SCHEMA = "zugfolge-demand-data-update/v1"
MODEL_SCHEMA = "zugfolge-station-population-demand/v1"
MAX_INTEGER = 2_147_483_647  # Native Odoo Integer/PostgreSQL integer storage.
MAX_JSON_BYTES = 16 * 1024 * 1024
CLASS_MINIMA = (1, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000)


def integer(value):
    if type(value) is not int or not 0 <= value <= MAX_INTEGER:
        raise ValueError("Einwohner und Verbindungszahlen brauchen nichtnegative Ganzzahlen.")
    return value


def demand_class(population):
    return sum(population >= minimum for minimum in CLASS_MINIMA)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def parse_release(blob):
    if not isinstance(blob, bytes) or not blob or len(blob) > MAX_JSON_BYTES:
        raise ValueError("Datengrundlage fehlt oder überschreitet 16 MiB.")
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Die Datengrundlage enthält doppelte JSON-Felder.")
            result[key] = value
        return result
    release = json.loads(blob.decode("utf-8"), object_pairs_hook=unique_pairs,
                         parse_float=lambda _: (_ for _ in ()).throw(ValueError("Nur Ganzzahlen sind zulässig.")),
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nur endliche Ganzzahlen sind zulässig.")))
    if (not isinstance(release, dict) or release.get("schemaVersion") != "zugfolge-demand-release/v1"
            or release.get("provenance") != "balanced" or not isinstance(release.get("id"), str)
            or not release["id"] or len(release["id"]) > 500):
        raise ValueError("Es wird eine einwohnerbasierte Datengrundlage mit Herkunft balanced erwartet.")
    model = release.get("populationModel")
    if not isinstance(model, dict) or set(model) != {"schemaVersion", "settlements", "stationAreas", "referenceTimetable", "destinationPreferences"} or model["schemaVersion"] != MODEL_SCHEMA:
        raise ValueError("Das Stations-/Einwohnermodell fehlt oder hat ein unbekanntes Format.")
    if (not isinstance(model["settlements"], list) or not 1 <= len(model["settlements"]) <= 20000
            or not isinstance(model["stationAreas"], list) or not 1 <= len(model["stationAreas"]) <= 200
            or not isinstance(model["destinationPreferences"], list) or len(model["destinationPreferences"]) > 39800):
        raise ValueError("Die Datengrundlage überschreitet die Modellgrenzen.")
    source_ids = set()
    if not isinstance(release.get("sources"), list) or not release["sources"]:
        raise ValueError("Die rechtegeprüfte Quellbindung fehlt.")
    for source in release["sources"]:
        if (not isinstance(source, dict) or source.get("rightsApproved") is not True
                or not isinstance(source.get("id"), str) or not source["id"] or source["id"] in source_ids
                or not isinstance(source.get("url"), str) or not source["url"].startswith("https://")
                or not isinstance(source.get("license"), str) or not source["license"]
                or not re.fullmatch(r"[0-9a-f]{64}", source.get("artifactSha256", ""))):
            raise ValueError("Die rechtegeprüfte Quellbindung fehlt.")
        source_ids.add(source["id"])
    settlements = {}
    for row in model["settlements"]:
        if (not isinstance(row, dict) or set(row) != {"id", "name", "population", "sourceId"}
                or not isinstance(row["id"], str) or not row["id"] or row["id"] in settlements
                or not isinstance(row["name"], str) or not row["name"] or row["sourceId"] not in source_ids):
            raise ValueError("Ortskennung, Name oder Quellenbindung fehlt/ist doppelt.")
        settlements[row["id"]] = integer(row["population"])
    areas = {}
    station_ids = set()
    allocations = []
    for area in model["stationAreas"]:
        if (not isinstance(area, dict) or set(area) != {"zoneId", "stationId", "populationAllocations", "demandClass"}
                or not isinstance(area["zoneId"], str) or not area["zoneId"] or area["zoneId"] in areas
                or not isinstance(area["stationId"], str) or not area["stationId"] or area["stationId"] in station_ids
                or not isinstance(area["populationAllocations"], list)):
            raise ValueError("Die Stationsbindung ist ungültig.")
        station_ids.add(area["stationId"])
        if integer(area["demandClass"]) > 10:
            raise ValueError("Die Nachfrageklasse muss zwischen null und zehn liegen.")
        areas[area["zoneId"]] = area
        for allocation in area["populationAllocations"]:
            if not isinstance(allocation, dict) or set(allocation) != {"settlementId", "population"}:
                raise ValueError("Ungültige Einwohnerzuteilung.")
            allocations.append((allocation["settlementId"], area["zoneId"], integer(allocation["population"])))
    preferences = []
    for row in model["destinationPreferences"]:
        if not isinstance(row, dict) or set(row) != {"originZoneId", "destinationZoneId", "referenceConnections"}:
            raise ValueError("Ungültiger Verbindungshinweis.")
        preferences.append((row["originZoneId"], row["destinationZoneId"], integer(row["referenceConnections"])))
    reference = model["referenceTimetable"]
    if (not isinstance(reference, dict) or set(reference) != {"id", "artifactSha256", "sourceIds", "serviceDates"}
            or not isinstance(reference.get("id"), str) or not reference["id"]
            or not re.fullmatch(r"[0-9a-f]{64}", reference.get("artifactSha256", ""))
            or not isinstance(reference.get("sourceIds"), list)
            or not set(reference.get("sourceIds", [])) <= source_ids or not reference.get("sourceIds")
            or len(reference["sourceIds"]) != len(set(reference["sourceIds"]))
            or not isinstance(reference.get("serviceDates"), list) or len(reference["serviceDates"]) != 7):
        raise ValueError("Der gepinnte Referenzfahrplan fehlt.")
    dates = reference["serviceDates"]
    if any(not isinstance(day, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) for day in dates):
        raise ValueError("Die Referenzwoche braucht sieben aufeinanderfolgende ISO-Kalendertage.")
    first_day = date.fromisoformat(dates[0])
    if dates != [(first_day + timedelta(days=offset)).isoformat() for offset in range(7)]:
        raise ValueError("Die Referenzwoche braucht sieben aufeinanderfolgende ISO-Kalendertage.")
    command = build_command("00000000-0000-4000-8000-000000000001", 1, release, settlements, allocations, preferences)
    zones = {row["id"]: row for row in release.get("zones", [])}
    if set(zones) != set(areas) or len(zones) != len(release["zones"]):
        raise ValueError("Gebiete und Stationen stimmen nicht überein.")
    for row in command["zonePopulations"]:
        zone = zones[row["zoneId"]]
        if (zone.get("population") != row["population"] or len(zone.get("stations", [])) != 1
                or zone["stations"][0].get("stationId") != areas[row["zoneId"]]["stationId"]
                or areas[row["zoneId"]]["demandClass"] != demand_class(row["population"])):
            raise ValueError("Einwohner, Klasse und Stationsgebiet widersprechen sich.")
    return release, hashlib.sha256(blob).hexdigest()


def rebalance_population(population, weights):
    """Preserve existing station shares exactly using integer largest remainders."""
    integer(population)
    if not weights:
        if population:
            raise ValueError("Dem Ort muss mindestens eine bekannte Station zugeordnet sein.")
        return {}
    if len(set(key for key, _ in weights)) != len(weights):
        raise ValueError("Doppelte Stationszuordnung.")
    weights = sorted((key, integer(weight)) for key, weight in weights)
    if not any(weight for _, weight in weights):
        weights = [(key, 1) for key, _ in weights]
    total = sum(weight for _, weight in weights)
    assigned = {key: population * weight // total for key, weight in weights}
    remaining = population - sum(assigned.values())
    for key, _ in sorted(weights, key=lambda item: (-(population * item[1] % total), item[0]))[:remaining]:
        assigned[key] += 1
    return assigned


def build_command(world_id, revision, base, populations, allocations, preferences):
    if not isinstance(world_id, str) or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}", world_id):
        raise ValueError("Eine eindeutige Zielwelt ist erforderlich.")
    if integer(revision) < 1:
        raise ValueError("Die Datenrevision muss positiv sein.")
    model = deepcopy(base["populationModel"])
    known_settlements = {row["id"] for row in model["settlements"]}
    known_zones = {row["zoneId"] for row in model["stationAreas"]}
    if set(populations) != known_settlements or len(allocations) > 40000 or len(preferences) > 39800:
        raise ValueError("Der unveränderte Orts-/Stationsbestand oder die Modellgrenzen sind verletzt.")
    totals = {identifier: 0 for identifier in known_settlements}
    by_zone = {identifier: [] for identifier in known_zones}
    seen = set()
    for settlement, zone, population in allocations:
        if settlement not in totals or zone not in by_zone or (settlement, zone) in seen:
            raise ValueError("Stationsanteil ist doppelt oder verweist auf fremde Orte/Stationen.")
        seen.add((settlement, zone))
        totals[settlement] += integer(population)
        by_zone[zone].append({"settlementId": settlement, "population": population})
    for row in model["settlements"]:
        row["population"] = integer(populations[row["id"]])
        if totals[row["id"]] != row["population"]:
            raise ValueError("Stationsanteile für %s müssen zusammen genau %s Einwohner ergeben." % (row["name"], row["population"]))
    zone_populations = []
    for area in model["stationAreas"]:
        area["populationAllocations"] = sorted(by_zone[area["zoneId"]], key=lambda row: row["settlementId"])
        population = integer(sum(row["population"] for row in area["populationAllocations"]))
        area["demandClass"] = demand_class(population)
        zone_populations.append({"zoneId": area["zoneId"], "population": population})
    selected = []
    seen = set()
    for origin, destination, count in preferences:
        if origin not in known_zones or destination not in known_zones or origin == destination or (origin, destination) in seen:
            raise ValueError("Verbindungshinweis ist doppelt oder gehört nicht zu zwei bekannten Stationen.")
        seen.add((origin, destination))
        if integer(count):
            selected.append({"originZoneId": origin, "destinationZoneId": destination, "referenceConnections": count})
    model["settlements"].sort(key=lambda row: row["id"])
    model["stationAreas"].sort(key=lambda row: row["zoneId"])
    model["destinationPreferences"] = sorted(selected, key=lambda row: (row["originZoneId"], row["destinationZoneId"]))
    command = {"kind": "demand.data.update", "schemaVersion": DATA_SCHEMA, "worldId": world_id,
               "sourceRevision": revision, "baseReleaseId": base["id"], "populationModel": model,
               "zonePopulations": sorted(zone_populations, key=lambda row: row["zoneId"])}
    if len(canonical(command).encode("utf-8")) > MAX_JSON_BYTES:
        raise ValueError("Die Datenänderung überschreitet 16 MiB.")
    return command
