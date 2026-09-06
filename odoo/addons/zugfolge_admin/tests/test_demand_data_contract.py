"""Offline executable tests of data editing; these do not substitute Odoo ORM tests."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("zugfolge_demand_data_contract_test", Path(__file__).parents[1] / "models" / "demand_data_contract.py")
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


def release_fixture():
    return {
        "schemaVersion": "zugfolge-demand-release/v1", "id": "fixture-demand", "provenance": "balanced",
        "sources": [{"id": "synthetic", "url": "https://example.org/synthetic", "license": "CC0-1.0", "artifactSha256": "a" * 64, "rightsApproved": True}],
        "zones": [{"id": "a", "population": 60, "stations": [{"stationId": "station-a"}]}, {"id": "b", "population": 90, "stations": [{"stationId": "station-b"}]}],
        "populationModel": {"schemaVersion": contract.MODEL_SCHEMA,
            "settlements": [{"id": "town-a", "name": "Quellenort", "population": 100, "sourceId": "synthetic"}, {"id": "town-b", "name": "Nachbarort", "population": 50, "sourceId": "synthetic"}],
            "stationAreas": [{"zoneId": "a", "stationId": "station-a", "demandClass": 1, "populationAllocations": [{"settlementId": "town-a", "population": 60}]},
                             {"zoneId": "b", "stationId": "station-b", "demandClass": 1, "populationAllocations": [{"settlementId": "town-a", "population": 40}, {"settlementId": "town-b", "population": 50}]}],
            "referenceTimetable": {"id": "fixture-week", "artifactSha256": "b" * 64, "sourceIds": ["synthetic"], "serviceDates": ["2026-09-%02d" % day for day in range(7, 14)]},
            "destinationPreferences": [{"originZoneId": "a", "destinationZoneId": "b", "referenceConnections": 7}]},
    }


class TestDemandDataContract(unittest.TestCase):
    def test_initial_facts_and_identifiers_survive_data_edit(self):
        original = release_fixture()
        base, _ = contract.parse_release(json.dumps(original).encode())
        command = contract.build_command("11111111-1111-4111-8111-111111111111", 2, base,
            {"town-a": 101, "town-b": 50}, [("town-a", "a", 61), ("town-a", "b", 40), ("town-b", "b", 50)], [("a", "b", 0), ("b", "a", 9)])
        self.assertEqual(base, original)
        self.assertEqual(command["zonePopulations"], [{"zoneId": "a", "population": 61}, {"zoneId": "b", "population": 90}])
        self.assertEqual(command["populationModel"]["destinationPreferences"], [{"originZoneId": "b", "destinationZoneId": "a", "referenceConnections": 9}])
        self.assertEqual(command["populationModel"]["referenceTimetable"], original["populationModel"]["referenceTimetable"])
        self.assertEqual(command["populationModel"]["settlements"][0]["sourceId"], "synthetic")

    def test_population_edit_rebalances_existing_shares_without_rounding_loss(self):
        self.assertEqual(contract.rebalance_population(101, [("a", 60), ("b", 40)]), {"a": 61, "b": 40})
        self.assertEqual(contract.rebalance_population(1, [("b", 1), ("a", 1)]), {"a": 1, "b": 0})
        self.assertEqual(contract.rebalance_population(3, [("b", 0), ("a", 0)]), {"a": 2, "b": 1})
        self.assertEqual(contract.rebalance_population(0, [("a", 60), ("b", 40)]), {"a": 0, "b": 0})
        with self.assertRaises(ValueError):
            contract.rebalance_population(1, [])

    def test_manual_allocation_must_preserve_every_settlement(self):
        for allocations in [[("town-a", "a", 100), ("town-b", "b", 51)],
                            [("town-a", "a", 100), ("town-a", "a", 0), ("town-b", "b", 50)],
                            [("town-a", "a", 100), ("foreign", "b", 50)]]:
            with self.subTest(allocations=allocations), self.assertRaises(ValueError):
                contract.build_command("11111111-1111-4111-8111-111111111111", 1, release_fixture(), {"town-a": 100, "town-b": 50}, allocations, [])

    def test_numeric_and_reference_corruption_is_rejected(self):
        for value in (-1, True, 1.5, "100", 2147483648):
            with self.subTest(value=value), self.assertRaises(ValueError):
                contract.integer(value)
        for mutate in [lambda r: r["sources"][0].update(rightsApproved=False),
                       lambda r: r["populationModel"]["settlements"][0].update(sourceId="missing"),
                       lambda r: r["populationModel"]["stationAreas"][0].update(demandClass=8),
                       lambda r: r["populationModel"]["stationAreas"][0].update(demandClass=True),
                       lambda r: r["sources"][0].update(license=""),
                       lambda r: r["populationModel"]["referenceTimetable"].update(serviceDates=["2026-09-07"] * 7),
                       lambda r: r["populationModel"]["referenceTimetable"].update(serviceDates=["2026-02-30"] * 7),
                       lambda r: r["zones"].append(deepcopy(r["zones"][0])),
                       lambda r: r["zones"][0].update(population=61)]:
            altered = deepcopy(release_fixture()); mutate(altered)
            with self.assertRaises(ValueError):
                contract.parse_release(json.dumps(altered).encode())
        with self.assertRaises(ValueError):
            contract.parse_release(b'{"id":"a","id":"b"}')

    def test_class_is_derived_at_every_boundary(self):
        self.assertEqual(contract.demand_class(0), 0)
        for expected, minimum in enumerate(contract.CLASS_MINIMA, 1):
            self.assertEqual(contract.demand_class(minimum), expected)
            self.assertEqual(contract.demand_class(minimum - 1), expected - 1)


if __name__ == "__main__":
    unittest.main()
