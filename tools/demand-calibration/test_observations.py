"""ETL-Verhaltenstests mit synthetischen Testzeilen, keine Kalibrierbeobachtungen."""
import unittest

from build_observations import build, tenths


def row(index, train="7", kind="Zählfahrt AFZS", board="1,4", load="2,5"):
    return {"Datum": "14.01.2025", "Linie": "RE 7", "Teilnetz": "test", "Vertrag": "test",
            "Zugnummer": train, "Index": str(index), "sourceRowNumber": str(index + 2),
            "Fahrgastzahlenart": kind, "DHID": f"de:test:{index}", "Abfahrtszeit": f"0{index + 6}:00",
            "Stationsname": f"Station {index}", "Einsteiger": board, "Belegung abg.": load}


class ObservationTests(unittest.TestCase):
    def test_exact_aggregation_and_train_boundaries(self):
        result = build([row(0), row(1), row(0, "8"), row(1, "8")])
        section = [item for item in result["observations"] if item["metric"] == "cross_section"]
        self.assertEqual(len(section), 1)
        self.assertEqual(section[0]["observedPassengerTenths"], 50)
        self.assertEqual(section[0]["observedPassengers"], 5)
        morning = [item for item in result["observations"] if item["scope"].get("hourFrom") == 6]
        self.assertEqual(morning[0]["observedPassengerTenths"], 28)
        self.assertEqual(morning[0]["observedPassengers"], 3)

    def test_imputed_or_mixed_trip_is_never_an_observed_holdout(self):
        result = build([row(0), row(1, kind="Fahrplanfahrt (mit Fahrgastzahl)")])
        self.assertEqual(result["observations"], [])
        self.assertEqual(result["coverage"][0]["excludedTrips"], 1)

    def test_missing_invalid_or_disconnected_measurements_fail(self):
        for value in ["", "-1,0", "0,01", "NaN"]:
            with self.assertRaises(ValueError):
                tenths(value)
        with self.assertRaises(ValueError):
            build([row(0), row(2)])
        with self.assertRaises(ValueError):
            build([row(0), row(0)])


if __name__ == "__main__":
    unittest.main()
