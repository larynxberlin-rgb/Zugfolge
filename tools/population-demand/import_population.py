#!/usr/bin/env python3
"""Normalize the pinned, freely licensed BKG VG250-EW 2024 Excel archive.

This imports source facts only. Station catchments and travel demand are separate
model assumptions. No network access or spreadsheet library is required.

zugfolge:quelle=bkg-vg250-ew-2024
"""

from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


SOURCE_ID = "bkg-vg250-ew-2024"
SOURCE_URL = (
    "https://daten.gdz.bkg.bund.de/produkte/vg/vg250-ew_ebenen_1231/2024/"
    "vg250-ew_12-31.ee.excel.ebenen.zip"
)
ARTIFACT_SHA256 = "d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3"
REFERENCE_DATE = "2024-12-31"
ARCHIVE_ROOT = "vg250-ew_12-31.ee.excel.ebenen"
WORKBOOK_PATH = f"{ARCHIVE_ROOT}/vg250-ew_ebenen_1231/verwaltungsgebiete.xlsx"
MUNICIPALITY_COUNT = 10956
POPULATION_TOTAL = 83577140
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024
MAX_SHEET_ROWS = 20000
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"m": MAIN_NS}


class PopulationImportError(ValueError):
    """The input has no complete, unambiguous, licensed source interpretation."""


def _zip(blob: bytes) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile as error:
        raise PopulationImportError("Ungültiges ZIP-Archiv") from error
    members = archive.infolist()
    names = [member.filename for member in members]
    if len(names) != len(set(names)):
        raise PopulationImportError("Doppelte ZIP-Einträge")
    if len(members) > 256 or sum(member.file_size for member in members) > MAX_UNCOMPRESSED_BYTES:
        raise PopulationImportError("ZIP-Archiv überschreitet die dokumentierte Größenbegrenzung")
    for member in members:
        name = PurePosixPath(member.filename)
        if name.is_absolute() or ".." in name.parts or "\\" in member.filename:
            raise PopulationImportError("Unzulässiger ZIP-Pfad")
        if member.file_size > MAX_MEMBER_BYTES or member.flag_bits & 1:
            raise PopulationImportError("ZIP-Eintrag zu groß oder verschlüsselt")
    return archive


def _read(archive: zipfile.ZipFile, name: str) -> bytes:
    try:
        return archive.read(name)
    except (KeyError, zipfile.BadZipFile, RuntimeError) as error:
        raise PopulationImportError(f"ZIP-Eintrag fehlt oder ist ungültig: {name}") from error


def _xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    blob = _read(archive, name)
    if b"<!DOCTYPE" in blob.upper() or b"<!ENTITY" in blob.upper():
        raise PopulationImportError(f"XML-Deklarationen sind nicht zulässig: {name}")
    try:
        return ET.fromstring(blob)
    except ET.ParseError as error:
        raise PopulationImportError(f"Ungültiges XML: {name}") from error


def _worksheet_paths(workbook: zipfile.ZipFile) -> dict[str, str]:
    relations: dict[str, str] = {}
    for relation in _xml(workbook, "xl/_rels/workbook.xml.rels"):
        if relation.tag != f"{{{REL_NS}}}Relationship":
            continue
        if relation.get("Type") != f"{OFFICE_REL_NS}/worksheet":
            continue
        identifier, target = relation.get("Id"), relation.get("Target", "")
        path = PurePosixPath(target)
        if not identifier or identifier in relations or relation.get("TargetMode") == "External":
            raise PopulationImportError("Ungültige Tabellenbeziehung")
        if path.is_absolute() or ".." in path.parts or "\\" in target or not target:
            raise PopulationImportError("Unzulässiger Tabellenpfad")
        relations[identifier] = "xl/" + target
    sheets: dict[str, str] = {}
    for sheet in _xml(workbook, "xl/workbook.xml").findall("m:sheets/m:sheet", NS):
        name = sheet.get("name")
        relation = sheet.get(f"{{{OFFICE_REL_NS}}}id")
        if not name or name in sheets or relation not in relations:
            raise PopulationImportError("Tabellenname oder Tabellenbeziehung fehlt/ist doppelt")
        sheets[name] = relations[relation]
    return sheets


def _rows(workbook: zipfile.ZipFile, path: str, strings: list[str]) -> list[dict[str, str]]:
    source_rows = _xml(workbook, path).findall("m:sheetData/m:row", NS)
    if not source_rows or len(source_rows) > MAX_SHEET_ROWS:
        raise PopulationImportError("Leeres oder zu großes Tabellenblatt")
    headers: dict[str, str] = {}
    records: list[dict[str, str]] = []
    previous_row = 0
    for row in source_rows:
        row_number = row.get("r", "")
        if not re.fullmatch(r"[1-9][0-9]*", row_number) or int(row_number) <= previous_row:
            raise PopulationImportError("Fehlende oder doppelte Tabellenzeile")
        previous_row = int(row_number)
        cells: dict[str, str] = {}
        for cell in row.findall("m:c", NS):
            reference = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]*)", cell.get("r", ""))
            if reference is None or reference[2] != row_number or reference[1] in cells:
                raise PopulationImportError("Fehlende oder doppelte Zellenadresse")
            if cell.find("m:f", NS) is not None:
                raise PopulationImportError("Formeln sind keine Einwohner-Quellenfakten")
            value = cell.find("m:v", NS)
            kind = cell.get("t")
            if kind == "inlineStr":
                content = cell.find("m:is", NS)
                text = "" if content is None else "".join(content.itertext())
            elif value is None:
                text = ""
            elif kind == "s":
                if not re.fullmatch(r"[0-9]+", value.text or "") or int(value.text) >= len(strings):
                    raise PopulationImportError("Ungültiger Textverweis im Tabellenblatt")
                text = strings[int(value.text)]
            elif kind in (None, "n", "str"):
                text = value.text or ""
            else:
                raise PopulationImportError("Nicht unterstützter Zelltyp")
            cells[reference[1]] = text
        if not headers:
            if not cells or any(not text for text in cells.values()) or len(set(cells.values())) != len(cells):
                raise PopulationImportError("Leere oder doppelte Spaltenüberschrift")
            headers = cells
        elif any(cells.values()):
            if any(column not in headers and value for column, value in cells.items()):
                raise PopulationImportError("Zelle ohne Spaltenüberschrift")
            records.append({name: cells.get(column, "") for column, name in headers.items()})
    return records


def _keys(record: dict[str, str]) -> tuple[str, str]:
    ags, ars = record.get("AGS", ""), record.get("ARS", "")
    if not re.fullmatch(r"[0-9]{8}", ags) or not re.fullmatch(r"[0-9]{12}", ars):
        raise PopulationImportError("AGS/ARS fehlt oder verliert führende Nullen")
    if ars[:5] + ars[9:] != ags:
        raise PopulationImportError("AGS und ARS widersprechen sich")
    return ags, ars


def _coordinate(text: str, limit: int) -> int:
    try:
        value = Decimal(text)
    except InvalidOperation as error:
        raise PopulationImportError("Gemeindekoordinate fehlt oder ist ungültig") from error
    if not value.is_finite() or abs(value) > limit:
        raise PopulationImportError("Gemeindekoordinate außerhalb des Wertebereichs")
    return int((value * 10_000_000).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def parse_archive(blob: bytes) -> list[dict[str, object]]:
    """Parse complete municipality rows; callers must separately verify provenance."""
    if len(blob) > MAX_ARCHIVE_BYTES:
        raise PopulationImportError("Eingabearchiv ist zu groß")
    with _zip(blob) as archive:
        for suffix in ("aktualitaet.txt", "dokumentation/aktualitaet.txt"):
            if _read(archive, f"{ARCHIVE_ROOT}/{suffix}").strip() != b"31.12.2024":
                raise PopulationImportError("Nicht unterstützter Gebiets-/Bevölkerungsstand")
        workbook_bytes = _read(archive, WORKBOOK_PATH)
    with _zip(workbook_bytes) as workbook:
        paths = _worksheet_paths(workbook)
        if "VGTB_ATT_VG" not in paths or "VG250_PK" not in paths:
            raise PopulationImportError("Einwohner- oder Gemeindepunkttabelle fehlt")
        strings = ["".join(element.itertext()) for element in _xml(workbook, "xl/sharedStrings.xml")]
        areas = _rows(workbook, paths["VGTB_ATT_VG"], strings)
        points = _rows(workbook, paths["VG250_PK"], strings)
    by_ars: dict[str, dict[str, str]] = {}
    point_ags: set[str] = set()
    for point in points:
        ags, ars = _keys(point)
        if ars in by_ars or ags in point_ags:
            raise PopulationImportError("Doppelter Gemeindepunkt")
        by_ars[ars] = point
        point_ags.add(ags)
    settlements: list[dict[str, object]] = []
    seen_ars: set[str] = set()
    seen_ags: set[str] = set()
    for area in areas:
        if not re.fullmatch(r"[1-6]", area.get("ADE", "")):
            raise PopulationImportError("Administrative Ebene fehlt oder ist ungültig")
        if area["ADE"] != "6":
            continue
        ags, ars = _keys(area)
        if ars in seen_ars or ags in seen_ags:
            raise PopulationImportError("Doppelte Gemeinde im Einwohnerbestand")
        seen_ars.add(ars)
        seen_ags.add(ags)
        name = area.get("GEN", "")
        if not name.strip() or len(name) > 500:
            raise PopulationImportError("Gemeindename fehlt oder ist ungültig")
        population = area.get("EWZ", "")
        if not re.fullmatch(r"0|[1-9][0-9]*", population) or int(population) > 100_000_000:
            raise PopulationImportError(f"Einwohnerzahl unbekannt oder ungültig: {ags}")
        point = by_ars.get(ars)
        if point is None or point.get("AGS") != ags or point.get("GEN") != name:
            raise PopulationImportError(f"Gemeindepunkt fehlt oder widerspricht dem Einwohnerbestand: {ags}")
        settlements.append({
            "id": ags, "name": name, "population": int(population),
            "latitudeE7": _coordinate(point.get("LAT_DEZ", ""), 90),
            "longitudeE7": _coordinate(point.get("LON_DEZ", ""), 180),
        })
    if not settlements or seen_ars != set(by_ars):
        raise PopulationImportError("Gemeinden und Gemeindepunkte sind nicht vollständig verbunden")
    return sorted(settlements, key=lambda settlement: str(settlement["id"]))


def import_population(blob: bytes, expected_sha256: str) -> dict[str, object]:
    """Only the reviewed BKG release may acquire its source ID and rights pin."""
    if expected_sha256 != ARTIFACT_SHA256:
        raise PopulationImportError("SHA-256 ist nicht der rechtegeprüfte BKG-2024-Quellenpin")
    if hashlib.sha256(blob).hexdigest() != expected_sha256:
        raise PopulationImportError("SHA-256 des Eingabearchivs stimmt nicht mit dem Quellenpin überein")
    settlements = parse_archive(blob)
    if len(settlements) != MUNICIPALITY_COUNT or sum(int(row["population"]) for row in settlements) != POPULATION_TOTAL:
        raise PopulationImportError("Der vollständige amtliche Einwohnerbestand ist nicht erhalten")
    return {
        "schemaVersion": "zugfolge-settlement-population/v1",
        "source": {"id": SOURCE_ID, "url": SOURCE_URL, "license": "dl-de/by-2-0",
                   "artifactSha256": expected_sha256, "rightsApproved": True},
        "referenceDate": REFERENCE_DATE,
        "settlements": settlements,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Unverändertes BKG-2024-Excel-ZIP")
    parser.add_argument("--output", type=Path, required=True, help="Kanonisches JSON-Ziel")
    parser.add_argument("--expected-sha256", required=True, help="Rechtegeprüfter Quellenpin")
    arguments = parser.parse_args(argv)
    try:
        if arguments.input.resolve() == arguments.output.resolve():
            raise PopulationImportError("Quelle und Ausgabe müssen verschiedene Dateien sein")
        if arguments.input.stat().st_size > MAX_ARCHIVE_BYTES:
            raise PopulationImportError("Eingabearchiv ist zu groß")
        artifact = import_population(arguments.input.read_bytes(), arguments.expected_sha256)
        serialized = json.dumps(artifact, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(serialized, encoding="utf-8", newline="\n")
    except (OSError, PopulationImportError) as error:
        print(f"Einwohnerimport fehlgeschlagen: {error}", file=sys.stderr)
        return 1
    print(f"{len(artifact['settlements'])} Gemeinden/Gebiete, {POPULATION_TOTAL} Einwohner; {arguments.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
