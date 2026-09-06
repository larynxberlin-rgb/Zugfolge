"""Own synthetic services for a technical population-model example, never GTFS trains.

This fixture has no operational infrastructure approval. The production adapter
uses --deployment-template with an independently approved game deployment.
"""
from pathlib import Path

from build_population_demand import write_json


WORLD = "population-demand-demo"


def demo_template():
    lines = [
        ("regional", "spnv", ["354639", "85981", "104445", "464080", "194454", "542001", "66393"], [28, 10, 30, 35, 15, 10]),
        ("city", "spnv", ["46758", "611502", "630508", "600951", "85981", "154282"], [15, 10, 12, 15, 20]),
        ("express", "spfv", ["354639", "85981", "542001"], [25, 40]),
    ]
    services = []
    for name, mode, stations, minutes in lines:
        for direction in (0, 1):
            sequence = stations if direction == 0 else list(reversed(stations))
            durations = minutes if direction == 0 else list(reversed(minutes))
            for hour in (6, 7, 8):
                train_id = f"demo-{name}-{direction}-{hour}"
                current_ms = (hour * 60 + 10 + direction * 5) * 60_000
                stops = []
                for index, station_id in enumerate(sequence):
                    departure_ms = current_ms + (60_000 if 0 < index < len(sequence) - 1 else 0)
                    stops.append({"stopId": f"{train_id}:{index}", "stationId": station_id,
                                  "arrivalMs": current_ms, "departureMs": departure_ms, "passengerStop": True})
                    if index < len(durations):
                        current_ms = departure_ms + durations[index] * 60_000
                services.append({"worldId": WORLD, "trainRunId": train_id, "operatorId": f"demo-{mode}-operator", "mode": mode, "cancelled": False,
                    "stops": stops, "fares": [{"id": f"{name}-standard", "comfortClass": "standard", "centsPerSegment": 100 if mode == "spnv" else 200,
                        "salesAvailable": True, "onboardSales": False, "reservationRequired": False}],
                    "capacity": {"standardSeats": 120 if mode == "spnv" else 100, "standardStanding": 80 if mode == "spnv" else 0,
                        "premiumSeats": 0, "wheelchairSpaces": 2, "bicycleSpaces": 8, "strollerSpaces": 4},
                    "serviceIntervalMs": 3_600_000, "reliabilityBasisPoints": 9500, "comfortBasisPoints": 6000 if mode == "spnv" else 8000})
    evaluation = {"schemaVersion": "zugfolge-demand-evaluation/v1", "worldId": WORLD, "periodId": "population-demo-day-1", "seed": "173",
        "nowMs": 0, "revision": 1, "windowStartMs": 21_600_000, "windowEndMs": 32_400_000, "daySliceId": "morning",
        "release": {}, "services": services, "alternatives": []}
    return {"schemaVersion": "zugfolge-demand-deployment/v1", "worldId": WORLD,
            "infrastructureReleaseId": "population-demo-infrastructure-unapproved", "windows": [evaluation]}


if __name__ == "__main__":
    write_json(Path(__file__).with_name("demo-deployment-template.json"), demo_template())
