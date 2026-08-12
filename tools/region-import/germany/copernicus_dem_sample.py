#!/usr/bin/env python3
"""Deterministic Copernicus GLO-30 enrichment for semantic railway tracks."""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


CAPTURE_SCHEMA = "zugfolge-copernicus-dem-capture/v1"
OUTPUT_SCHEMA = "zugfolge-copernicus-dem-track-enrichment/v1"
PRODUCT = "COP-DEM-GLO-30-DGED"
RELEASE = "2021"
ATTRIBUTION = (
    "produced using Copernicus WorldDEM-30 \u00a9 DLR e.V. 2010-2014 and "
    "\u00a9 Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS "
    "by the European Union and ESA; all rights reserved"
)
TILE_ID = re.compile(r"^[NS]\d{2}_[EW]\d{3}$")
SEGMENT_NUMBER = re.compile(r"-segment-(\d+)-")
DEFAULT_SAMPLE_INTERVAL_MM = 30_000
DEFAULT_MIN_BASELINE_MM = 200_000
DEFAULT_ANALYSIS_WINDOW_MM = 400_000
DEFAULT_VERTICAL_ACCURACY_MM = 4_000
DEFAULT_MAXIMUM_ABSOLUTE_GRADIENT_PERMILLE = 70
DEFAULT_MAXIMUM_UNCERTAINTY_PERMILLE = 50


class DemError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DemError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def round_fraction(numerator: int, denominator: int) -> int:
    require(denominator > 0, "Rundungsnenner muss positiv sein.")
    sign = -1 if numerator < 0 else 1
    absolute = abs(numerator)
    return sign * ((absolute + denominator // 2) // denominator)


def ceil_fraction(numerator: int, denominator: int) -> int:
    require(numerator >= 0 and denominator > 0, "Aufrundungsbruch ist ung\u00fcltig.")
    return (numerator + denominator - 1) // denominator


def tile_id(longitude: float, latitude: float) -> str:
    require(math.isfinite(longitude) and -180 <= longitude < 180, "L\u00e4ngengrad liegt au\u00dferhalb WGS84.")
    require(math.isfinite(latitude) and -90 < latitude < 90, "Breitengrad liegt au\u00dferhalb WGS84.")
    west = math.floor(longitude)
    # GLO-30 point rasters include the northern, not the southern, integer grid post.
    south = math.floor(math.nextafter(latitude, -math.inf)) if latitude.is_integer() else math.floor(latitude)
    return f"{'N' if south >= 0 else 'S'}{abs(south):02d}_{'E' if west >= 0 else 'W'}{abs(west):03d}"


def parse_tile_id(value: str) -> tuple[int, int]:
    require(bool(TILE_ID.fullmatch(value)), f"Ung\u00fcltige Kachelkennung {value}.")
    latitude = int(value[1:3]) * (1 if value[0] == "N" else -1)
    longitude = int(value[5:8]) * (1 if value[4] == "E" else -1)
    return longitude, latitude


def tile_file_name(value: str) -> str:
    require(bool(TILE_ID.fullmatch(value)), f"Ung\u00fcltige Kachelkennung {value}.")
    latitude, longitude = value.split("_")
    return f"Copernicus_DSM_COG_10_{latitude}_00_{longitude}_00_DEM.tif"


def haversine_metres(left: list[float], right: list[float]) -> float:
    lon1, lat1 = math.radians(left[0]), math.radians(left[1])
    lon2, lat2 = math.radians(right[0]), math.radians(right[1])
    dlon, dlat = lon2 - lon1, lat2 - lat1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6_371_008.8 * 2 * math.asin(min(1.0, math.sqrt(value)))


def coordinate_at(feature: dict[str, Any], offset_mm: int) -> tuple[int, int]:
    coordinates = feature["geometry"]["coordinates"]
    length_mm = feature["properties"]["length_mm"]
    require(isinstance(length_mm, int) and length_mm > 0, f"Gleis {feature['properties'].get('feature_id')} besitzt keine positive L\u00e4nge.")
    require(0 <= offset_mm <= length_mm, "Stichprobe liegt au\u00dferhalb des Gleises.")
    distances = [haversine_metres(left, right) for left, right in zip(coordinates, coordinates[1:])]
    total = sum(distances)
    require(total > 0, f"Gleis {feature['properties']['feature_id']} besitzt keine r\u00e4umliche L\u00e4nge.")
    target = (offset_mm / length_mm) * total
    travelled = 0.0
    for index, distance in enumerate(distances):
        if target <= travelled + distance or index == len(distances) - 1:
            ratio = 0.0 if distance == 0 else min(1.0, max(0.0, (target - travelled) / distance))
            left, right = coordinates[index], coordinates[index + 1]
            longitude = left[0] + (right[0] - left[0]) * ratio
            latitude = left[1] + (right[1] - left[1]) * ratio
            return round(longitude * 10_000_000), round(latitude * 10_000_000)
        travelled += distance
    raise DemError("Interne Koordinateninterpolation ist fehlgeschlagen.")


def segment_number(feature: dict[str, Any]) -> int:
    feature_id = feature.get("properties", {}).get("feature_id")
    require(isinstance(feature_id, str) and feature_id, "Gleis ohne feature_id.")
    match = SEGMENT_NUMBER.search(feature_id)
    require(match is not None, f"Gleiskennung besitzt keine Segmentnummer: {feature_id}.")
    return int(match.group(1))


def validate_feature(feature: dict[str, Any], line_number: int) -> str:
    require(feature.get("type") == "Feature" and feature.get("geometry", {}).get("type") == "LineString", f"Zeile {line_number} ist kein Gleis-LineString.")
    properties = feature.get("properties", {})
    feature_id = properties.get("feature_id")
    way_id = properties.get("osm_way_id")
    require(isinstance(feature_id, str) and feature_id, f"Zeile {line_number} besitzt keine feature_id.")
    require(isinstance(way_id, int) and way_id > 0, f"Gleis {feature_id} besitzt keine positive osm_way_id.")
    require(isinstance(properties.get("length_mm"), int) and properties["length_mm"] > 0, f"Gleis {feature_id} besitzt keine positive length_mm.")
    coordinates = feature["geometry"].get("coordinates")
    require(isinstance(coordinates, list) and len(coordinates) >= 2, f"Gleis {feature_id} besitzt zu wenige Koordinaten.")
    for pair in coordinates:
        require(isinstance(pair, list) and len(pair) >= 2, f"Gleis {feature_id} besitzt eine ung\u00fcltige Koordinate.")
        require(all(isinstance(value, (int, float)) and math.isfinite(value) for value in pair[:2]), f"Gleis {feature_id} besitzt keine endliche Koordinate.")
    segment_number(feature)
    return str(way_id)


def feature_groups(path: Path) -> Iterable[tuple[str, list[dict[str, Any]]]]:
    current_way: str | None = None
    current: list[dict[str, Any]] = []
    closed_way: str | None = None
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue
            feature = json.loads(line)
            way = validate_feature(feature, line_number)
            if current_way is None:
                current_way = way
            if way != current_way:
                require(closed_way is None or current_way > closed_way, "Gleisdatei ist nicht stabil nach feature_id sortiert.")
                yield current_way, current
                closed_way = current_way
                current_way, current = way, []
            current.append(feature)
    if current_way is not None:
        require(closed_way is None or current_way > closed_way, "Gleisdatei ist nicht stabil nach feature_id sortiert.")
        yield current_way, current


def chain(features: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[int], str | None]:
    ordered = sorted(features, key=segment_number)
    numbers = [segment_number(feature) for feature in ordered]
    if len(set(numbers)) != len(numbers) or numbers != list(range(numbers[0], numbers[-1] + 1)):
        return ordered, [], "non_contiguous_segment_numbers"
    starts: list[int] = []
    position = 0
    previous_end: list[float] | None = None
    for feature in ordered:
        coordinates = feature["geometry"]["coordinates"]
        if previous_end is not None and coordinates[0][:2] != previous_end[:2]:
            return ordered, [], "disconnected_way_geometry"
        starts.append(position)
        position += feature["properties"]["length_mm"]
        previous_end = coordinates[-1]
    return ordered, starts, None


def create_database(path: Path) -> sqlite3.Connection:
    database = sqlite3.connect(path)
    database.executescript(
        """
        PRAGMA journal_mode=OFF;
        PRAGMA synchronous=OFF;
        PRAGMA temp_store=MEMORY;
        CREATE TABLE samples (
          way_id TEXT NOT NULL,
          position_mm INTEGER NOT NULL,
          lon_e7 INTEGER NOT NULL,
          lat_e7 INTEGER NOT NULL,
          tile_id TEXT NOT NULL,
          elevation_mm INTEGER,
          PRIMARY KEY (way_id, position_mm)
        ) WITHOUT ROWID;
        CREATE INDEX samples_by_tile ON samples(tile_id, way_id, position_mm);
        """
    )
    return database


def build_sample_index(tracks: Path, database: sqlite3.Connection, interval_mm: int) -> dict[str, int]:
    totals = Counter()
    insert = "INSERT INTO samples(way_id, position_mm, lon_e7, lat_e7, tile_id) VALUES (?, ?, ?, ?, ?)"
    for way_id, features in feature_groups(tracks):
        totals["ways"] += 1
        totals["features"] += len(features)
        ordered, starts, problem = chain(features)
        if problem is not None:
            totals[f"unresolved_{problem}"] += len(features)
            continue
        total_length = starts[-1] + ordered[-1]["properties"]["length_mm"]
        positions = set(range(0, total_length + 1, interval_mm))
        positions.add(total_length)
        for start, feature in zip(starts, ordered):
            positions.add(start)
            positions.add(start + feature["properties"]["length_mm"])
        rows = []
        feature_index = 0
        for position in sorted(positions):
            while feature_index + 1 < len(ordered) and position > starts[feature_index] + ordered[feature_index]["properties"]["length_mm"]:
                feature_index += 1
            offset = position - starts[feature_index]
            lon_e7, lat_e7 = coordinate_at(ordered[feature_index], offset)
            rows.append((way_id, position, lon_e7, lat_e7, tile_id(lon_e7 / 10_000_000, lat_e7 / 10_000_000)))
        database.executemany(insert, rows)
        totals["samples"] += len(rows)
        totals["length_mm"] += total_length
        if totals["ways"] % 10_000 == 0:
            database.commit()
    database.commit()
    return dict(totals)


def validate_manifest(manifest_path: Path, tracks: Path, cache: Path) -> tuple[dict[str, Any], dict[str, Path]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    require(manifest.get("schema") == CAPTURE_SCHEMA, "Unbekanntes Copernicus-Capture-Manifest.")
    source = manifest.get("source", {})
    require(source.get("rightsSourceId") == "dem-hoehenmodell", "DEM-Capture besitzt keine freigegebene Rechtekennung.")
    require(source.get("product") == PRODUCT and source.get("release") == RELEASE, "DEM-Capture ist nicht auf GLO-30 Release 2021 gepinnt.")
    require(source.get("attribution") == ATTRIBUTION, "DEM-Capture besitzt nicht die verbindliche Attribution.")
    require(sha256_file(tracks) == manifest.get("input", {}).get("tracksSha256"), "DEM-Capture geh\u00f6rt zu einer anderen Gleisdatei.")
    paths: dict[str, Path] = {}
    aggregate = hashlib.sha256()
    for tile in manifest.get("tiles", []):
        identifier = tile.get("tileId")
        require(isinstance(identifier, str) and TILE_ID.fullmatch(identifier), "DEM-Capture enth\u00e4lt eine ung\u00fcltige Kachelkennung.")
        expected_file = tile_file_name(identifier)
        require(tile.get("file") == expected_file, f"DEM-Capture manipuliert den Dateinamen von {identifier}.")
        path = cache / expected_file
        require(path.is_file(), f"Gepinnte DEM-Kachel fehlt: {identifier}.")
        require(path.stat().st_size == tile.get("bytes"), f"DEM-Kachelgr\u00f6\u00dfe stimmt nicht: {identifier}.")
        digest = sha256_file(path)
        require(digest == tile.get("sha256"), f"DEM-Kachelhash stimmt nicht: {identifier}.")
        aggregate.update(f"{identifier}:{digest}\n".encode())
        paths[identifier] = path
    require(paths, "DEM-Capture enth\u00e4lt keine Kacheln.")
    require(aggregate.hexdigest() == manifest.get("aggregateTileSha256"), "Aggregierter DEM-Kachelsatzhash stimmt nicht.")
    return manifest, paths


def validate_raster(dataset: Any, identifier: str) -> None:
    from osgeo import osr

    require(dataset is not None, f"DEM-Kachel {identifier} kann nicht ge\u00f6ffnet werden.")
    require(dataset.RasterCount == 1 and dataset.RasterYSize == 3600, f"DEM-Kachel {identifier} besitzt unerwartete Rasterma\u00dfe.")
    require(dataset.RasterXSize in (2400, 3600), f"DEM-Kachel {identifier} besitzt eine unerwartete L\u00e4ngenaufl\u00f6sung.")
    reference = osr.SpatialReference(wkt=dataset.GetProjection())
    require(reference.GetAuthorityCode(None) == "4326", f"DEM-Kachel {identifier} ist nicht EPSG:4326.")
    metadata = dataset.GetMetadata("IMAGE_STRUCTURE")
    require(metadata.get("LAYOUT") == "COG", f"DEM-Kachel {identifier} ist kein Cloud Optimized GeoTIFF.")
    transform = dataset.GetGeoTransform()
    west, south = parse_tile_id(identifier)
    require(abs(transform[0] + transform[1] / 2 - west) < 1e-9, f"DEM-Kachel {identifier} besitzt eine falsche Westgrenze.")
    require(abs(transform[3] + transform[5] / 2 - (south + 1)) < 1e-9, f"DEM-Kachel {identifier} besitzt eine falsche Nordgrenze.")
    require(abs(transform[1] * dataset.RasterXSize - 1) < 1e-9 and abs(transform[5] * dataset.RasterYSize + 1) < 1e-9, f"DEM-Kachel {identifier} deckt keine 1-Grad-Geozelle ab.")
    require(dataset.GetRasterBand(1).DataType == 6, f"DEM-Kachel {identifier} ist nicht Float32.")


def sample_rasters(database: sqlite3.Connection, tile_paths: dict[str, Path]) -> dict[str, int]:
    from osgeo import gdal
    import numpy as np

    gdal.UseExceptions()
    totals = Counter()
    update = "UPDATE samples SET elevation_mm = ? WHERE way_id = ? AND position_mm = ?"
    required_tiles = [row[0] for row in database.execute("SELECT DISTINCT tile_id FROM samples ORDER BY tile_id")]
    missing = sorted(set(required_tiles) - set(tile_paths))
    require(not missing, f"DEM-Capture deckt ben\u00f6tigte Kacheln nicht ab: {', '.join(missing[:10])}.")
    for identifier in required_tiles:
        dataset = gdal.Open(str(tile_paths[identifier]), gdal.GA_ReadOnly)
        validate_raster(dataset, identifier)
        band = dataset.GetRasterBand(1)
        no_data = band.GetNoDataValue()
        raster = band.ReadAsArray()
        require(raster is not None, f"DEM-Kachel {identifier} kann nicht gelesen werden.")
        transform = dataset.GetGeoTransform()
        pending = []
        for way_id, position_mm, lon_e7, lat_e7 in database.execute(
            "SELECT way_id, position_mm, lon_e7, lat_e7 FROM samples WHERE tile_id = ? ORDER BY way_id, position_mm",
            (identifier,),
        ):
            longitude, latitude = lon_e7 / 10_000_000, lat_e7 / 10_000_000
            pixel_x = (longitude - transform[0]) / transform[1] - 0.5
            pixel_y = (latitude - transform[3]) / transform[5] - 0.5
            x0 = min(max(math.floor(pixel_x), 0), dataset.RasterXSize - 2)
            y0 = min(max(math.floor(pixel_y), 0), dataset.RasterYSize - 2)
            fx = min(1.0, max(0.0, pixel_x - x0))
            fy = min(1.0, max(0.0, pixel_y - y0))
            values = (
                float(raster[y0, x0]),
                float(raster[y0, x0 + 1]),
                float(raster[y0 + 1, x0]),
                float(raster[y0 + 1, x0 + 1]),
            )
            valid = all(math.isfinite(value) and (no_data is None or value != no_data) for value in values)
            if valid:
                top = values[0] * (1 - fx) + values[1] * fx
                bottom = values[2] * (1 - fx) + values[3] * fx
                elevation_mm = round((top * (1 - fy) + bottom * fy) * 1000)
                pending.append((elevation_mm, way_id, position_mm))
                totals["valid_samples"] += 1
            else:
                totals["nodata_samples"] += 1
            if len(pending) >= 20_000:
                database.executemany(update, pending)
                pending.clear()
        if pending:
            database.executemany(update, pending)
        database.commit()
        totals["tiles_read"] += 1
        del raster
        dataset = None
        np.zeros(0)  # Keep NumPy import explicit for the external-tool contract.
    return dict(totals)


def regression(samples: list[tuple[int, int]], vertical_accuracy_mm: int) -> dict[str, int] | None:
    if len(samples) < 5:
        return None
    positions = [sample[0] for sample in samples]
    heights = [sample[1] for sample in samples]
    baseline = positions[-1] - positions[0]
    if baseline <= 0:
        return None
    count = len(samples)
    sum_x, sum_y = sum(positions), sum(heights)
    sum_xx = sum(value * value for value in positions)
    sum_xy = sum(x * y for x, y in samples)
    denominator = count * sum_xx - sum_x * sum_x
    numerator = count * sum_xy - sum_x * sum_y
    if denominator <= 0:
        return None
    representative = round_fraction(numerator * 1000, denominator)
    prediction_denominator = count * denominator
    intercept_numerator = sum_y * denominator - numerator * sum_x
    maximum_residual_mm = 0
    for x, y in samples:
        prediction_numerator = intercept_numerator + numerator * count * x
        residual_numerator = abs(y * prediction_denominator - prediction_numerator)
        maximum_residual_mm = max(maximum_residual_mm, ceil_fraction(residual_numerator, prediction_denominator))
    source_uncertainty = ceil_fraction(2 * vertical_accuracy_mm * 1000, baseline)
    residual_uncertainty = ceil_fraction(2 * maximum_residual_mm * 1000, baseline)
    uncertainty = max(1, source_uncertainty, residual_uncertainty)
    return {
        "representative_gradient_permille": representative,
        "minimum_gradient_permille": representative - uncertainty,
        "maximum_gradient_permille": representative + uncertainty,
        "uncertainty_permille": uncertainty,
        "analysis_baseline_mm": baseline,
        "sample_count": count,
        "maximum_residual_mm": maximum_residual_mm,
    }


def selected_samples(samples: list[tuple[int, int | None]], midpoint: int, total: int, window: int) -> list[tuple[int, int]]:
    start = max(0, midpoint - window // 2)
    end = min(total, start + window)
    start = max(0, end - window)
    positions = [position for position, _ in samples]
    left, right = bisect.bisect_left(positions, start), bisect.bisect_right(positions, end)
    selected = samples[left:right]
    if any(elevation is None for _, elevation in selected):
        return []
    return [(position, elevation) for position, elevation in selected if elevation is not None]


def derive_outputs(
    tracks: Path,
    database: sqlite3.Connection,
    output_path: Path,
    *,
    min_baseline_mm: int,
    analysis_window_mm: int,
    vertical_accuracy_mm: int,
    maximum_absolute_gradient_permille: int,
    maximum_uncertainty_permille: int,
) -> dict[str, Any]:
    status_counts = Counter()
    status_lengths = Counter()
    feature_count = 0
    with output_path.open("x", encoding="utf-8", newline="\n") as target:
        for way_id, features in feature_groups(tracks):
            ordered, starts, chain_problem = chain(features)
            sample_rows = list(database.execute(
                "SELECT position_mm, elevation_mm FROM samples WHERE way_id = ? ORDER BY position_mm",
                (way_id,),
            ))
            total = starts[-1] + ordered[-1]["properties"]["length_mm"] if starts else 0
            results: dict[str, dict[str, Any]] = {}
            sample_by_position = dict(sample_rows)
            for index, feature in enumerate(ordered):
                properties = feature["properties"]
                feature_id = properties["feature_id"]
                length_mm = properties["length_mm"]
                enrichment: dict[str, Any] = {
                    "schema": OUTPUT_SCHEMA,
                    "feature_id": feature_id,
                    "source_id": "copernicus-dem-germany",
                    "source_product": PRODUCT,
                    "source_release": RELEASE,
                    "confidence": "derived",
                    "class_a_eligible": False,
                    "quality_class_cap": "B",
                    "surface_model": True,
                    "vertical_accuracy_assumption_mm": vertical_accuracy_mm,
                }
                reason: str | None = chain_problem
                if reason is None:
                    start, end = starts[index], starts[index] + length_mm
                    start_elevation, end_elevation = sample_by_position.get(start), sample_by_position.get(end)
                    if start_elevation is None or end_elevation is None:
                        reason = "endpoint_nodata"
                    elif total < min_baseline_mm:
                        enrichment.update(elevation_start_mm=start_elevation, elevation_end_mm=end_elevation)
                        reason = "insufficient_way_baseline"
                    else:
                        samples = selected_samples(sample_rows, (start + end) // 2, total, analysis_window_mm)
                        if not samples:
                            enrichment.update(elevation_start_mm=start_elevation, elevation_end_mm=end_elevation)
                            reason = "analysis_window_nodata"
                        elif samples[-1][0] - samples[0][0] < min_baseline_mm:
                            enrichment.update(elevation_start_mm=start_elevation, elevation_end_mm=end_elevation)
                            reason = "insufficient_analysis_baseline"
                        else:
                            model = regression(samples, vertical_accuracy_mm)
                            if model is None:
                                reason = "regression_not_identifiable"
                            elif abs(model["representative_gradient_permille"]) > maximum_absolute_gradient_permille:
                                reason = "surface_model_gradient_outlier"
                            elif model["uncertainty_permille"] > maximum_uncertainty_permille:
                                reason = "surface_model_uncertainty_too_wide"
                            else:
                                enrichment.update(
                                    elevation_start_mm=start_elevation,
                                    elevation_end_mm=end_elevation,
                                    gradient_status="derived_with_uncertainty",
                                    gradient_dimension_state="derived",
                                    uncertainty_model="copernicus-dem-glo30-dsm-envelope/v1",
                                    **model,
                                )
                if reason is not None:
                    enrichment.update(
                        gradient_status="unresolved",
                        gradient_dimension_state="missing",
                        unresolved_reason=reason,
                    )
                    status = f"unresolved:{reason}"
                else:
                    status = "derived"
                status_counts[status] += 1
                status_lengths[status] += length_mm
                results[feature_id] = {
                    "type": "Feature",
                    "geometry": feature["geometry"],
                    "properties": enrichment,
                }
                feature_count += 1
            for feature in features:
                target.write(canonical_json(results[feature["properties"]["feature_id"]]) + "\n")
    return {
        "featureCount": feature_count,
        "byStatusFeatureCount": dict(sorted(status_counts.items())),
        "byStatusLengthMm": dict(sorted(status_lengths.items())),
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    tracks = Path(args.tracks).resolve()
    manifest_path = Path(args.manifest).resolve()
    cache = Path(args.cache).resolve()
    output = Path(args.output).resolve()
    staging = output.with_name(output.name + ".building")
    require(tracks.is_file(), "Semantische Gleisdatei fehlt.")
    require(manifest_path.is_file(), "Copernicus-Capture-Manifest fehlt.")
    require(not output.exists() and not staging.exists(), "DEM-Ausgabe oder reserviertes Bauverzeichnis existiert bereits.")
    require(args.sample_interval_mm > 0, "Stichprobenabstand muss positiv sein.")
    require(args.min_baseline_mm >= 200_000, "DEM-Neigungsableitung ben\u00f6tigt mindestens 200 m St\u00fctzweite.")
    require(args.analysis_window_mm >= args.min_baseline_mm, "Analysefenster ist k\u00fcrzer als die Mindestst\u00fctzweite.")
    require(args.maximum_absolute_gradient_permille > 0, "Plausibilit\u00e4tsgrenze f\u00fcr Neigungen muss positiv sein.")
    require(args.maximum_uncertainty_permille > 0, "Unsicherheitsgrenze muss positiv sein.")
    manifest, tile_paths = validate_manifest(manifest_path, tracks, cache)
    staging.mkdir(parents=True)
    database_path = staging / "samples.sqlite"
    database = create_database(database_path)
    try:
        index_counts = build_sample_index(tracks, database, args.sample_interval_mm)
        sample_counts = sample_rasters(database, tile_paths)
        enrichment_file = staging / "copernicus-dem-track-enrichment.geojsonseq"
        quality = derive_outputs(
            tracks,
            database,
            enrichment_file,
            min_baseline_mm=args.min_baseline_mm,
            analysis_window_mm=args.analysis_window_mm,
            vertical_accuracy_mm=args.vertical_accuracy_mm,
            maximum_absolute_gradient_permille=args.maximum_absolute_gradient_permille,
            maximum_uncertainty_permille=args.maximum_uncertainty_permille,
        )
    finally:
        database.close()
    database_path.unlink()

    quality_report = {
        "schema": "zugfolge-copernicus-dem-quality-report/v1",
        "scopeId": "deutschland-ebo",
        "qualityDimension": "gradient",
        "policy": {
            "derived": "Mindestens 200 m St\u00fctzweite; robuste lineare Korridorneigung mit explizitem Unsicherheitsintervall.",
            "unresolved": "Keine erfundene Neigung; der Deutschland-Compiler verwendet weiterhin seinen sichtbaren konservativen B-Korridor.",
            "classAEligible": False,
            "maximumAbsoluteGradientPermille": args.maximum_absolute_gradient_permille,
            "maximumUncertaintyPermille": args.maximum_uncertainty_permille,
        },
        **quality,
    }
    quality_file = staging / "copernicus-dem-quality-report.json"
    write_json(quality_file, quality_report)
    evidence = {
        "schema": "zugfolge-copernicus-dem-evidence-report/v1",
        "source": {
            "sourceId": "copernicus-dem-germany",
            "rightsSourceId": "dem-hoehenmodell",
            "product": PRODUCT,
            "release": RELEASE,
            "rasterKind": "digital-surface-model",
            "attribution": ATTRIBUTION,
            "aggregateTileSha256": manifest["aggregateTileSha256"],
            "tileCount": len(tile_paths),
        },
        "input": {
            "tracksSha256": manifest["input"]["tracksSha256"],
            "captureManifestSha256": sha256_file(manifest_path),
        },
        "algorithm": {
            "id": "copernicus-dem-glo30-track-gradient/v1",
            "sampleIntervalMm": args.sample_interval_mm,
            "minimumBaselineMm": args.min_baseline_mm,
            "analysisWindowMm": args.analysis_window_mm,
            "verticalAccuracyAssumptionMm": args.vertical_accuracy_mm,
            "maximumAbsoluteGradientPermille": args.maximum_absolute_gradient_permille,
            "maximumUncertaintyPermille": args.maximum_uncertainty_permille,
            "interpolation": "bilinear",
            "slope": "integer-least-squares-with-conservative-envelope",
        },
        "sampling": {**index_counts, **sample_counts},
        "outputs": [
            {
                "file": enrichment_file.name,
                "bytes": enrichment_file.stat().st_size,
                "sha256": sha256_file(enrichment_file),
            },
            {
                "file": quality_file.name,
                "bytes": quality_file.stat().st_size,
                "sha256": sha256_file(quality_file),
            },
        ],
        "limitations": [
            "Copernicus GLO-30 is a digital surface model, not a surveyed railway formation model.",
            "The result is derived evidence with an explicit uncertainty envelope and never class-A evidence by itself.",
            "Ways shorter than 200 metres or with NoData remain unresolved instead of receiving a fabricated gradient.",
        ],
    }
    write_json(staging / "copernicus-dem-evidence-report.json", evidence)
    os.replace(staging, output)
    return {
        "tiles": len(tile_paths),
        "samples": index_counts.get("samples", 0),
        "validSamples": sample_counts.get("valid_samples", 0),
        "features": quality["featureCount"],
        "derivedFeatures": quality["byStatusFeatureCount"].get("derived", 0),
        "output": str(output),
    }


def self_test() -> None:
    assert tile_id(10.5, 50.2) == "N50_E010"
    assert tile_id(10.5, 50.0) == "N49_E010"
    assert round_fraction(15, 10) == 2
    assert round_fraction(-15, 10) == -2
    flat = regression([(0, 100_000), (50_000, 100_500), (100_000, 101_000), (150_000, 101_500), (200_000, 102_000)], 4_000)
    assert flat is not None and flat["representative_gradient_permille"] == 10
    assert flat["minimum_gradient_permille"] <= 10 <= flat["maximum_gradient_permille"]


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--tracks")
    result.add_argument("--manifest")
    result.add_argument("--cache")
    result.add_argument("--output")
    result.add_argument("--sample-interval-mm", type=int, default=DEFAULT_SAMPLE_INTERVAL_MM)
    result.add_argument("--min-baseline-mm", type=int, default=DEFAULT_MIN_BASELINE_MM)
    result.add_argument("--analysis-window-mm", type=int, default=DEFAULT_ANALYSIS_WINDOW_MM)
    result.add_argument("--vertical-accuracy-mm", type=int, default=DEFAULT_VERTICAL_ACCURACY_MM)
    result.add_argument("--maximum-absolute-gradient-permille", type=int, default=DEFAULT_MAXIMUM_ABSOLUTE_GRADIENT_PERMILLE)
    result.add_argument("--maximum-uncertainty-permille", type=int, default=DEFAULT_MAXIMUM_UNCERTAINTY_PERMILLE)
    result.add_argument("--self-test", action="store_true")
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    if arguments.self_test:
        self_test()
        print(json.dumps({"selfTest": "ok"}))
        sys.exit(0)
    for required_argument in ("tracks", "manifest", "cache", "output"):
        require(getattr(arguments, required_argument) is not None, f"--{required_argument.replace('_', '-')} fehlt.")
    print(json.dumps(run(arguments), ensure_ascii=False, sort_keys=True))
