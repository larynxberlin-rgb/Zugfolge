import unittest

from apn_semantic_extract import classify_words


def word(text, x0):
    return {
        "text": text,
        "x0": x0,
        "top": 10,
        "x1": x0 + 5,
        "bottom": 15,
        "size": 8,
    }


class SemanticExtractTest(unittest.TestCase):
    def test_extracts_only_lexically_bound_review_tokens(self):
        values = [
            "Gleis", "7", "Weiche", "123", "W456A", "95A", "96Q8",
            "Strecke", "6340", "km", "123,456", "Bahnsteig", "2",
            "NL/BL", "250/220", "Vq109", "L3414X", "999",
        ]
        result = classify_words([[word(value, index * 10) for index, value in enumerate(values)]])

        self.assertEqual(
            [item["normalizedValue"] for item in result["trackDesignationTokens"]],
            ["7"],
        )
        self.assertEqual(
            [item["normalizedValue"] for item in result["switchDesignationTokens"]],
            ["123", "456A"],
        )
        self.assertEqual(
            [item["normalizedValue"] for item in result["mainSignalDesignationTokens"]],
            ["95A", "96Q8"],
        )
        self.assertEqual(result["routeNumberTokens"][0]["routeNumber"], 6340)
        self.assertEqual(result["kilometreHintTokens"][0]["millimetresFromRouteOrigin"], 123_456_000)
        self.assertEqual(
            [item["normalizedValue"] for item in result["platformDesignationTokens"]],
            ["2"],
        )
        self.assertEqual(result["usefulPlatformLengthTokens"][0]["usefulLengthMetres"], 250)
        self.assertEqual(result["usefulPlatformLengthTokens"][0]["platformLengthMetres"], 220)
        self.assertTrue(all(
            item["semanticAssertion"] is False
            for name, items in result.items()
            if name.endswith("Tokens")
            for item in items
        ))

    def test_does_not_promote_bare_numbers_or_distant_route_tokens(self):
        values = ["415", "416", "95Vq109", "95L3414X", "Bedarfsplan1", "Bahnsteig"]
        result = classify_words([[word(value, index * 10) for index, value in enumerate(values)]])
        self.assertEqual(result["switchDesignationTokens"], [])
        self.assertEqual(result["mainSignalDesignationTokens"], [])
        self.assertEqual(result["platformDesignationTokens"], [])
        self.assertEqual(result["metrics"]["unclassifiedNumericOccurrences"], 2)


if __name__ == "__main__":
    unittest.main()
