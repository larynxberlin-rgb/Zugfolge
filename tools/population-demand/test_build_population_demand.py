"""Behavioral adapter and real Rust integration checks; no external services."""
from collections import Counter
from copy import deepcopy
from datetime import date
import json
import os
from pathlib import Path
import subprocess
import unittest

from build_population_demand import (active_dates, allocate_population, boarding_rule, canonical, compile_deployment,
    compile_release, demand_class, digest, direct_connections, distance_mm, gtfs_seconds, native_summary, read_json,
    service_dates, verify_source_pin)
from make_demo_deployment import demo_template


BASE = Path(__file__).parent
BINARY = os.environ.get("ZUGFOLGE_DEMAND_TEST_BINARY")


def data():
    return tuple(read_json(BASE / name) for name in ("config.json", "sources/population.json", "sources/reference-timetable.json"))


def repin(config, population, reference):
    config["populationSha256"] = digest(population)
    config["referenceSha256"] = digest(reference)


class PopulationBuilderTests(unittest.TestCase):
    def test_reference_dates_require_real_consecutive_week(self):
        self.assertEqual(len(service_dates([f"2026-09-{day:02d}" for day in range(7, 14)])), 7)
        for values in (["2026-09-07"] * 7, [f"2026-09-{day:02d}" for day in range(25, 32)], ["2026-09-07"]):
            with self.assertRaises(ValueError):
                service_dates(values)

    def test_calendar_exceptions_and_after_midnight_stay_on_the_service_day(self):
        dates = service_dates([f"2026-09-{day:02d}" for day in range(7, 14)])
        row = {"service_id": "a", "start_date": "20260901", "end_date": "20260930",
               **{day: "1" if day == "monday" else "0" for day in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")}}
        active = active_dates([row], [{"service_id": "a", "date": "20260907", "exception_type": "2"},
            {"service_id": "a", "date": "20260908", "exception_type": "1"}], dates)
        self.assertEqual(active["a"], {"2026-09-08"})
        self.assertEqual(gtfs_seconds("25:03:04"), 90184)
        for invalid in ({**row, "start_date": "20260900"}, {**row, "end_date": "20260999"}, {**row, "monday": "maybe"}):
            with self.assertRaises(ValueError):
                active_dates([invalid], [], dates)
        for invalid in ("24:60:00", "-1:00:00", "168:00:00"):
            with self.assertRaises(ValueError):
                gtfs_seconds(invalid)
        self.assertTrue(boarding_rule("0"))
        self.assertFalse(boarding_rule("2"))
        self.assertFalse(boarding_rule("3"))
        with self.assertRaises(ValueError):
            boarding_rule("anything")

    def test_repeated_station_pairs_count_once_per_source_trip_and_day(self):
        def stop(ident, sequence, pickup=True, dropoff=True):
            return {"stationId": ident, "stopSequence": sequence, "arrivalS": 86400 + sequence * 600,
                    "departureS": 86400 + sequence * 600, "pickupAllowed": pickup, "dropoffAllowed": dropoff}
        reference = {"serviceDates": ["2026-09-07", "2026-09-08"], "sources": [{"id": "source-a"}, {"id": "source-b"}],
            "stations": [{"stationId": "a"}, {"stationId": "b"}], "trips": [
                {"sourceId": "source-a", "tripId": "repeated", "serviceDates": ["2026-09-07", "2026-09-08"], "stops": [stop("a", 0), stop("b", 1), stop("a", 2), stop("b", 3)]},
                {"sourceId": "source-b", "tripId": "same-id-in-another-source", "serviceDates": ["2026-09-07"], "stops": [stop("a", 0), stop("b", 1)]},
                {"sourceId": "source-a", "tripId": "no-boarding", "serviceDates": ["2026-09-07"], "stops": [stop("a", 0, pickup=False), stop("b", 1)]}]}
        counts, metrics = direct_connections(reference)
        self.assertEqual(counts, Counter({("a", "b"): 3, ("b", "a"): 2}))
        self.assertGreater(metrics["afterMidnightSelectedCalls"], 0)
        reference["trips"].append(deepcopy(reference["trips"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            direct_connections(reference)

    def test_allocation_conserves_individual_settlements_and_ignores_input_order(self):
        settlements = [{"id": "town", "name": "Town", "population": 7, "latitudeE7": 510000000, "longitudeE7": 120000000},
            {"id": "uncovered", "name": "Elsewhere", "population": 11, "latitudeE7": 520000000, "longitudeE7": 120000000}]
        stations = [{"stationId": ident, "latitudeE7": 510000000, "longitudeE7": 120000000} for ident in ("b", "a", "c")]
        allocations, included, excluded, _ = allocate_population(settlements, stations, 10_000_000)
        self.assertEqual({key: rows[0]["population"] for key, rows in allocations.items()}, {"a": 3, "b": 2, "c": 2})
        self.assertEqual(allocations, allocate_population(list(reversed(settlements)), list(reversed(stations)), 10_000_000)[0])
        self.assertEqual(sum(row["population"] for row in included), 7)
        self.assertEqual(excluded[0]["population"], 11)
        self.assertEqual(distance_mm(stations[0], {**stations[0], "latitudeE7": 510001000}), 11132)
        self.assertEqual(distance_mm(stations[0], {**stations[0], "longitudeE7": 120001000}), 7000)

    def test_station_classes_have_exact_boundaries(self):
        self.assertEqual(demand_class(0), 0)
        for index, minimum in enumerate((1, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000), 1):
            self.assertEqual(demand_class(minimum), index)
            self.assertEqual(demand_class(minimum - 1), index - 1)
        with self.assertRaises(ValueError):
            demand_class(True)

    def test_real_corpus_preserves_population_and_reference_provenance(self):
        config, population, reference = data()
        release, report = compile_release(config, population, reference)
        self.assertEqual(release, read_json(BASE / "example/release.json"))
        self.assertEqual(report["populationAllocated"], 1245193)
        self.assertEqual(report["populationUncovered"], 10007)
        self.assertEqual(report["populationInput"], report["populationAllocated"] + report["populationUncovered"])
        self.assertEqual(report["referenceMetrics"]["directConnectionsBySource"], {"gtfs-de-fv": 886, "gtfs-de-rv": 9365})
        leipzig = next(row for row in report["allocations"] if row["settlementId"] == "14713000")
        self.assertEqual(sum(row["population"] for row in leipzig["allocations"]), 611850)
        self.assertEqual(len(leipzig["allocations"]), 3)
        self.assertEqual({row["stationId"] for row in report["stations"]}, set(config["stationIds"]))
        self.assertNotIn("719", config["stationIds"])
        self.assertIn("85981", config["stationIds"])
        self.assertEqual(release["provenance"], "balanced")

    def test_changed_or_unreviewed_sources_cannot_acquire_official_provenance(self):
        for field, bad_value in (("url", "https://example.org/not-reviewed"), ("artifactSha256", "0" * 64), ("rightsApproved", False), ("license", "non-commercial-only")):
            config, population, reference = data()
            population["source"][field] = bad_value
            repin(config, population, reference)
            with self.assertRaises(ValueError):
                compile_release(config, population, reference)
        with self.assertRaises(ValueError):
            verify_source_pin({"id": "gtfs-de-rv", "url": "https://example.org/feed.zip", "artifactSha256": "0" * 64})
        config, population, reference = data()
        population["settlements"][0]["population"] += 1
        with self.assertRaisesRegex(ValueError, "population snapshot hash"):
            compile_release(config, population, reference)
        config, population, reference = data()
        config["demandPolicy"]["provenance"] = "observed"
        with self.assertRaisesRegex(ValueError, "policy"):
            compile_release(config, population, reference)

    def test_deployment_keeps_world_and_services_and_supports_pooled_windows(self):
        release, _ = compile_release(*data())
        template = demo_template()
        original_services = deepcopy(template["windows"][0]["services"])
        deployment = compile_deployment(release, template)
        self.assertEqual(deployment["windows"][0]["services"], original_services)
        self.assertEqual(deployment["infrastructureReleaseId"], template["infrastructureReleaseId"])
        pooled = template["windows"][0]
        pooled["daySliceId"] = "pooled"
        pooled["windowEndMs"] = 54_000_000
        pooled["generationWindows"] = [
            {"windowStartMs": 21_600_000, "windowEndMs": 32_400_000, "daySliceId": "morning"},
            {"windowStartMs": 32_400_000, "windowEndMs": 54_000_000, "daySliceId": "day"}]
        # A valid game train may additionally serve stations outside the chosen demand zones.
        pooled["services"][0]["stops"][1]["stationId"] = "additional-infrastructure-station"
        self.assertEqual(compile_deployment(release, template)["windows"][0]["generationWindows"], pooled["generationWindows"])
        pooled["worldId"] = "foreign-world"
        with self.assertRaisesRegex(ValueError, "world"):
            compile_deployment(release, template)


@unittest.skipUnless(BINARY, "Set ZUGFOLGE_DEMAND_TEST_BINARY for the real Rust integration test")
class PopulationNativeIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.release, _ = compile_release(*data())
        cls.input = compile_deployment(cls.release, demo_template())["windows"][0]

    def evaluate(self, value):
        result = subprocess.run([BINARY], input=canonical(value), capture_output=True, check=True, timeout=120)
        return json.loads(result.stdout)

    def test_real_corpus_uses_one_native_pool_for_spnv_spfv_and_replays(self):
        first, replay = self.evaluate(self.input), self.evaluate(self.input)
        self.assertEqual(first, replay)
        stored = read_json(BASE / "example/native-summary-0.json")
        self.assertEqual(native_summary(first, self.release), stored)
        self.assertEqual(first["totals"]["generated"], 3729)
        self.assertEqual(first["totals"]["rail"] + first["totals"]["unserved"], first["totals"]["generated"])
        self.assertGreater(stored["passengerJourneysUsingMode"]["spnv"], 0)
        self.assertGreater(stored["passengerJourneysUsingMode"]["spfv"], 0)
        self.assertEqual(len(stored["stations"]), 12)

    def test_player_offer_changes_never_rewrite_population_or_wish_destinations(self):
        initial = self.evaluate(self.input)
        changed = deepcopy(self.input)
        changed["services"] = []
        no_offer = self.evaluate(changed)
        self.assertEqual(initial["cohorts"], no_offer["cohorts"])
        self.assertEqual(initial["releaseHash"], no_offer["releaseHash"])
        self.assertEqual(no_offer["totals"]["rail"], 0)
        self.assertEqual(no_offer["totals"]["unserved"], initial["totals"]["generated"])

    def test_native_accepts_shared_capacity_pool_across_generation_slices(self):
        pooled = deepcopy(self.input)
        pooled["daySliceId"] = "pooled"
        pooled["windowEndMs"] = 54_000_000
        pooled["generationWindows"] = [
            {"windowStartMs": 21_600_000, "windowEndMs": 32_400_000, "daySliceId": "morning"},
            {"windowStartMs": 32_400_000, "windowEndMs": 54_000_000, "daySliceId": "day"}]
        result = self.evaluate(pooled)
        self.assertGreater(result["totals"]["generated"], 3729)
        self.assertEqual(len(result["generationWindows"]), 2)
        self.assertTrue(all(row["passengers"] <= row["capacity"] for row in result["allocations"]))


if __name__ == "__main__":
    unittest.main()
