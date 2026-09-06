"""Belegt die Trennung zwischen Trainingswerten und Holdout-Zielgrößen."""
import copy
import csv
import hashlib
import json
import unittest

from build_observations import ROOT, SOURCE_ID
from run_native import build_inputs


class NativeInputTests(unittest.TestCase):
    def test_report_artifact_pins_match_portable_raw_bytes(self):
        report = json.loads((ROOT / "native-report.json").read_bytes())
        pins = {"training-parameters.json": report["trainingParametersSha256"],
                "observations.json": report["observationsSha256"]}
        pins.update({f"input-{split}.json": outcome["inputSha256"]
                     for split, outcome in report["nativeOutcomes"].items()})
        for filename, expected in pins.items():
            with self.subTest(artifact=filename):
                self.assertEqual(hashlib.sha256((ROOT / filename).read_bytes()).hexdigest(), expected)
        for filename in [*pins, "native-report.json"]:
            with self.subTest(portable=filename):
                raw = (ROOT / filename).read_bytes()
                self.assertNotIn(b"\r", raw)
                self.assertEqual(raw, (json.dumps(json.loads(raw), ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    def test_holdout_measurements_cannot_change_model_or_service_inputs(self):
        with (ROOT / "sources/nvbw-re7-selection.csv").open(encoding="utf-8", newline="") as stream:
            rows = list(csv.DictReader(stream, delimiter=";"))
        manifest = json.loads((ROOT / "sources/manifest.json").read_text(encoding="utf-8"))
        source = next(row for row in manifest["sources"] if row["id"] == SOURCE_ID)
        before = build_inputs(rows, source)
        changed = copy.deepcopy(rows)
        for row in changed:
            if row["Datum"] == "21.01.2025":
                for field in ["Einsteiger", "Aussteiger", "Belegung abg.", "Pkm", "Auslastung in % (abg.)"]:
                    row[field] = "999999,0"
        self.assertEqual(build_inputs(changed, source), before)
        inputs, parameters = before
        self.assertEqual(sum(parameters["hourlySharesBasisPoints"]), 10000)
        self.assertEqual(len(inputs["holdout"]["generationWindows"]), 22)
        self.assertEqual(inputs["training"]["release"], inputs["holdout"]["release"])
        self.assertEqual(inputs["holdout"]["release"]["provenance"], "balanced")

    def test_after_midnight_demand_stays_on_its_source_operating_day(self):
        with (ROOT / "sources/nvbw-re7-selection.csv").open(encoding="utf-8", newline="") as stream:
            rows = list(csv.DictReader(stream, delimiter=";"))
        manifest = json.loads((ROOT / "sources/manifest.json").read_text(encoding="utf-8"))
        source = next(row for row in manifest["sources"] if row["id"] == SOURCE_ID)
        inputs, parameters = build_inputs(rows, source)
        self.assertEqual(parameters["generationOperatingHours"], list(range(4, 26)))
        self.assertGreater(parameters["hourlySharesBasisPoints"][0], 0)
        for value in inputs.values():
            windows = value["generationWindows"]
            self.assertEqual(value["windowStartMs"], 4 * 3600000)
            self.assertEqual(value["windowEndMs"], 26 * 3600000)
            self.assertEqual([window["windowStartMs"] for window in windows if window["daySliceId"] == "hour-00"], [24 * 3600000])
            self.assertEqual([window["windowStartMs"] for window in windows if window["daySliceId"] == "hour-01"], [25 * 3600000])
            self.assertTrue(any(stop["departureMs"] >= 24 * 3600000 for service in value["services"] for stop in service["stops"]))

        # Ein zweiter gleichnamiger Kalendertageswert darf nicht still mit Stunde
        # 24 zusammengelegt werden; dieser Fall benötigt ein anderes Profil.
        ambiguous = copy.deepcopy(rows)
        next(row for row in ambiguous if row["Datum"] == "14.01.2025")["Abfahrtszeit"] = "00:15"
        with self.assertRaisesRegex(ValueError, "eindeutiges 24-Stunden-Profil"):
            build_inputs(ambiguous, source)


if __name__ == "__main__":
    unittest.main()
