#!/usr/bin/env python3
"""Deterministic, internal-only vector-text evidence extraction.

The extractor observes lexical tokens and page geometry.  It deliberately does
not infer railway topology, bind a token to a physical object, or validate a
quality dimension.  Its JSON output is only an input to manual discrepancy
review outside public release artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable


SCHEMA = "zugfolge-internal-station-plan-vector-text/v1"
VERSION = "station-plan-vector-text/1"

TRACK_PREFIX = re.compile(r"^(?:GLEIS|GL\.?)(\d{1,3}[A-Z]?)$", re.IGNORECASE)
SWITCH_PREFIX = re.compile(r"^(?:WEICHE|W)(\d{1,4}[A-Z]?)$", re.IGNORECASE)
TRACK_VALUE = re.compile(r"^\d{1,3}[A-Z]?$", re.IGNORECASE)
SWITCH_VALUE = re.compile(r"^\d{1,4}[A-Z]?$", re.IGNORECASE)
ROUTE_INLINE = re.compile(r"^STRECKE(?:N?R?\.?[-:]?)?(\d{4})$", re.IGNORECASE)
ROUTE_VALUE = re.compile(r"^\d{4}$")
KM_INLINE = re.compile(r"^KM[-:]?(\d{1,3}(?:[.,]\d{1,3})?)$", re.IGNORECASE)
KM_VALUE = re.compile(r"^\d{1,3}(?:[.,]\d{1,3})?$")
LENGTH_PAIR = re.compile(r"^(\d{1,4})/(\d{1,4})$")
PLATFORM_INLINE = re.compile(r"^BAHNSTEIG[-:]?([A-Z0-9]{1,4})$", re.IGNORECASE)
PLATFORM_VALUE = re.compile(r"^[A-Z0-9]{1,4}$", re.IGNORECASE)

# This is intentionally narrower than all legal German signal names.  A match
# is still only a lexical candidate, never proof that a main signal exists.
MAIN_SIGNAL = re.compile(
    r"^(?=.{2,8}$)(?=.*\d)(?:\d{1,2})?(?:AA|BB|CC|GG|[ABCEFGHJKMNPQRST]\d{0,4})$",
    re.IGNORECASE,
)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def normalize_token(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text.strip("\"'`()[]{};:")


def millipoints(value: Any) -> int:
    return int((Decimal(str(value)) * 1000).to_integral_value())


def occurrence(word: dict[str, Any], page_number: int, rule: str, value: str | None = None) -> dict[str, Any]:
    observed = normalize_token(word.get("text")) if value is None else normalize_token(value)
    return {
        "value": observed,
        "normalizedValue": observed.upper(),
        "page": page_number,
        "bboxMillipoints": {
            "x0": millipoints(word.get("x0", 0)),
            "top": millipoints(word.get("top", 0)),
            "x1": millipoints(word.get("x1", 0)),
            "bottom": millipoints(word.get("bottom", 0)),
        },
        "fontSizeMillipoints": millipoints(word.get("size", 0)),
        "rule": rule,
        "evidenceKind": "observed-vector-text",
        "semanticAssertion": False,
    }


def _sort_occurrences(values: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        values,
        key=lambda item: (
            item["normalizedValue"],
            item["page"],
            item["bboxMillipoints"]["top"],
            item["bboxMillipoints"]["x0"],
            item["rule"],
        ),
    )


def _dedupe_occurrences(values: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for item in _sort_occurrences(values):
        box = item["bboxMillipoints"]
        key = (
            item["normalizedValue"], item["page"], box["x0"], box["top"],
            box["x1"], box["bottom"], item["rule"],
        )
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result


def _next_nonempty(words: list[dict[str, Any]], index: int, maximum_offset: int = 2) -> tuple[int, dict[str, Any]] | None:
    for offset in range(1, maximum_offset + 1):
        if index + offset >= len(words):
            return None
        candidate = normalize_token(words[index + offset].get("text"))
        if candidate:
            return index + offset, words[index + offset]
    return None


def _km_millimetres(value: str) -> int | None:
    try:
        km = Decimal(value.replace(",", "."))
    except InvalidOperation:
        return None
    if km < 0 or km > 999:
        return None
    return int((km * Decimal(1_000_000)).to_integral_value())


def classify_words(pages: list[list[dict[str, Any]]]) -> dict[str, Any]:
    categories: dict[str, list[dict[str, Any]]] = {
        "trackDesignationTokens": [],
        "switchDesignationTokens": [],
        "mainSignalDesignationTokens": [],
        "routeNumberTokens": [],
        "kilometreHintTokens": [],
        "platformDesignationTokens": [],
        "usefulPlatformLengthTokens": [],
    }
    numeric_occurrences = 0
    numeric_values: set[str] = set()

    for page_index, raw_words in enumerate(pages, start=1):
        words = [word for word in raw_words if normalize_token(word.get("text"))]
        for index, word in enumerate(words):
            token = normalize_token(word.get("text"))
            upper = token.upper()
            if re.fullmatch(r"\d{1,5}", upper):
                numeric_occurrences += 1
                numeric_values.add(upper)

            match = TRACK_PREFIX.fullmatch(upper)
            if match:
                categories["trackDesignationTokens"].append(
                    occurrence(word, page_index, "explicit-track-prefix", match.group(1))
                )
            elif upper in {"GLEIS", "GL", "GL."}:
                following = _next_nonempty(words, index)
                if following and TRACK_VALUE.fullmatch(normalize_token(following[1].get("text"))):
                    categories["trackDesignationTokens"].append(
                        occurrence(following[1], page_index, "explicit-track-context")
                    )

            match = SWITCH_PREFIX.fullmatch(upper)
            if match:
                categories["switchDesignationTokens"].append(
                    occurrence(word, page_index, "lexical-switch-prefix-candidate", match.group(1))
                )
            elif upper == "WEICHE":
                following = _next_nonempty(words, index)
                if following and SWITCH_VALUE.fullmatch(normalize_token(following[1].get("text"))):
                    categories["switchDesignationTokens"].append(
                        occurrence(following[1], page_index, "explicit-switch-context")
                    )

            if MAIN_SIGNAL.fullmatch(upper) and not any(marker in upper for marker in ("V", "W", "Z", "L")):
                categories["mainSignalDesignationTokens"].append(
                    occurrence(word, page_index, "lexical-main-signal-candidate")
                )

            match = ROUTE_INLINE.fullmatch(upper)
            if match:
                item = occurrence(word, page_index, "explicit-route-prefix", match.group(1))
                item["routeNumber"] = int(match.group(1))
                categories["routeNumberTokens"].append(item)
            elif upper in {"STRECKE", "STRECKENR", "STRECKENNR", "STRECKEN-NR"}:
                following = _next_nonempty(words, index, 3)
                if following:
                    value = normalize_token(following[1].get("text"))
                    if ROUTE_VALUE.fullmatch(value):
                        item = occurrence(following[1], page_index, "explicit-route-context")
                        item["routeNumber"] = int(value)
                        categories["routeNumberTokens"].append(item)

            match = KM_INLINE.fullmatch(upper)
            if match:
                distance = _km_millimetres(match.group(1))
                if distance is not None:
                    item = occurrence(word, page_index, "explicit-kilometre-prefix", match.group(1))
                    item["millimetresFromRouteOrigin"] = distance
                    categories["kilometreHintTokens"].append(item)
            elif upper in {"KM", "KM."}:
                following = _next_nonempty(words, index)
                if following:
                    value = normalize_token(following[1].get("text"))
                    if KM_VALUE.fullmatch(value):
                        distance = _km_millimetres(value)
                        if distance is not None:
                            item = occurrence(following[1], page_index, "explicit-kilometre-context")
                            item["millimetresFromRouteOrigin"] = distance
                            categories["kilometreHintTokens"].append(item)

            match = PLATFORM_INLINE.fullmatch(upper)
            if match and match.group(1) != "":
                categories["platformDesignationTokens"].append(
                    occurrence(word, page_index, "explicit-platform-prefix", match.group(1))
                )
            elif upper == "BAHNSTEIG":
                following = _next_nonempty(words, index)
                if following:
                    value = normalize_token(following[1].get("text"))
                    if PLATFORM_VALUE.fullmatch(value) and value.upper() != "BAHNSTEIG":
                        categories["platformDesignationTokens"].append(
                            occurrence(following[1], page_index, "explicit-platform-context")
                        )

            if upper in {"NL/BL", "NL-BL"}:
                following = _next_nonempty(words, index)
                if following:
                    value = normalize_token(following[1].get("text"))
                    match = LENGTH_PAIR.fullmatch(value)
                    if match:
                        useful = int(match.group(1))
                        platform = int(match.group(2))
                        if 10 <= useful <= 5000 and 10 <= platform <= 5000:
                            item = occurrence(following[1], page_index, "explicit-nl-bl-pair")
                            item["usefulLengthMetres"] = useful
                            item["platformLengthMetres"] = platform
                            categories["usefulPlatformLengthTokens"].append(item)

    normalized_categories = {name: _dedupe_occurrences(values) for name, values in categories.items()}
    distinct = {
        name: len({item["normalizedValue"] for item in values})
        for name, values in normalized_categories.items()
    }
    return {
        **normalized_categories,
        "metrics": {
            "tokenOccurrences": {name: len(values) for name, values in normalized_categories.items()},
            "distinctTokenValues": distinct,
            "unclassifiedNumericOccurrences": numeric_occurrences,
            "unclassifiedNumericDistinctValues": len(numeric_values),
        },
    }


def extract_pdf(path: Path) -> dict[str, Any]:
    # Lazy import keeps the lexical unit tests independent from pdfplumber.
    import pdfplumber  # type: ignore

    source = path.read_bytes()
    if not source.startswith(b"%PDF-"):
        raise ValueError("Input does not have PDF magic")

    page_words: list[list[dict[str, Any]]] = []
    page_metrics: list[dict[str, Any]] = []
    with pdfplumber.open(path) as pdf:
        if getattr(pdf, "is_encrypted", False):
            raise ValueError("Encrypted station plan cannot be semantically extracted")
        for page_number, page in enumerate(pdf.pages, start=1):
            deduplicated = page.dedupe_chars(tolerance=1, extra_attrs=("fontname", "size"))
            words = deduplicated.extract_words(
                x_tolerance=2,
                y_tolerance=2,
                keep_blank_chars=False,
                use_text_flow=False,
                extra_attrs=["size"],
            )
            page_words.append(words)
            page_metrics.append({
                "page": page_number,
                "widthMillipoints": millipoints(page.width),
                "heightMillipoints": millipoints(page.height),
                "characterCount": len(deduplicated.chars),
                "wordCount": len(words),
                "lineCount": len(page.lines),
                "curveCount": len(page.curves),
                "rectangleCount": len(page.rects),
                "imageCount": len(page.images),
            })

    lexical = classify_words(page_words)
    total_characters = sum(page["characterCount"] for page in page_metrics)
    total_vectors = sum(page["lineCount"] + page["curveCount"] + page["rectangleCount"] for page in page_metrics)
    total_images = sum(page["imageCount"] for page in page_metrics)
    if total_characters == 0 and total_images > 0:
        extraction_state = "image-only-manual-review"
    elif total_characters == 0:
        extraction_state = "no-vector-text-manual-review"
    else:
        extraction_state = "vector-text-observed-review-required"
    result = {
        "schema": SCHEMA,
        "extractorVersion": VERSION,
        "documentSha256": sha256_bytes(source),
        "extractionState": extraction_state,
        "pageMetrics": page_metrics,
        "documentMetrics": {
            "pageCount": len(page_metrics),
            "characterCount": total_characters,
            "wordCount": sum(page["wordCount"] for page in page_metrics),
            "vectorPrimitiveCount": total_vectors,
            "imageCount": total_images,
        },
        "lexicalEvidence": lexical,
        "safety": {
            "manualReviewRequired": True,
            "semanticObjectAssertion": False,
            "topologyMutationAllowed": False,
            "qualityClassPromotionAllowed": False,
            "orderabilityPromotionAllowed": False,
            "publicExportAllowed": False,
            "ocrUsed": False,
        },
    }
    result["extractionSha256"] = sha256_bytes(canonical(result).encode("utf-8"))
    return result


def summary(result: dict[str, Any]) -> dict[str, Any]:
    lexical = result["lexicalEvidence"]
    return {
        "schema": result["schema"],
        "extractorVersion": result["extractorVersion"],
        "documentSha256": result["documentSha256"],
        "extractionSha256": result["extractionSha256"],
        "extractionState": result["extractionState"],
        "documentMetrics": result["documentMetrics"],
        "tokenOccurrences": lexical["metrics"]["tokenOccurrences"],
        "distinctTokenValues": lexical["metrics"]["distinctTokenValues"],
        "safety": result["safety"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Internal vector-text station-plan extractor")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args(argv)
    result = extract_pdf(args.input.resolve())
    json.dump(summary(result) if args.summary else result, sys.stdout, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
