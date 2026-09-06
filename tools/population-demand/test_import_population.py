"""Behavior tests for the BKG source normalizer, using a small source-shaped XLSX."""

import hashlib
import io
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from import_population import (
    ARCHIVE_ROOT, ARTIFACT_SHA256, MAIN_NS, OFFICE_REL_NS, REL_NS,
    PopulationImportError, WORKBOOK_PATH, _coordinate, import_population, main, parse_archive,
)


def archive_fixture(areas=None, points=None, *, date="31.12.2024", formula=False, reverse=False):
    areas = areas if areas is not None else [
        {"ADE": "1", "ARS": "000000000000", "AGS": "00000000", "GEN": "Deutschland", "EWZ": "1500"},
        {"ADE": "6", "ARS": "010010000000", "AGS": "01001000", "GEN": "Quellenstadt", "EWZ": "1500"},
        {"ADE": "6", "ARS": "010020000000", "AGS": "01002000", "GEN": "Nullgebiet", "EWZ": "0"},
    ]
    points = points if points is not None else [
        {"ARS": "010010000000", "AGS": "01001000", "GEN": "Quellenstadt", "LON_DEZ": "9.4375099999999996", "LAT_DEZ": "54.782519999999998"},
        {"ARS": "010020000000", "AGS": "01002000", "GEN": "Nullgebiet", "LON_DEZ": "10.137269999999999", "LAT_DEZ": "54.321775000000002"},
    ]
    texts = []

    def sheet(records):
        document = ET.Element(f"{{{MAIN_NS}}}worksheet")
        data = ET.SubElement(document, f"{{{MAIN_NS}}}sheetData")
        headers = list(records[0]) if records else ["ARS", "AGS", "GEN", "LON_DEZ", "LAT_DEZ"]
        values = [headers] + [[record.get(key, "") for key in headers] for record in (list(reversed(records)) if reverse else records)]
        for index, entries in enumerate(values, 1):
            row = ET.SubElement(data, f"{{{MAIN_NS}}}row", r=str(index))
            for column, value in enumerate(entries):
                # Alternate real numeric cells with shared strings. Leading-zero
                # administrative IDs are source strings, never integers.
                numeric = index > 1 and headers[column] in ("ADE", "EWZ", "LON_DEZ", "LAT_DEZ") and value
                cell = ET.SubElement(row, f"{{{MAIN_NS}}}c", r=f"{chr(65 + column)}{index}", t="n" if numeric else "s")
                if formula and index == 2 and column == 0:
                    ET.SubElement(cell, f"{{{MAIN_NS}}}f").text = "1+1"
                if numeric:
                    ET.SubElement(cell, f"{{{MAIN_NS}}}v").text = value
                else:
                    if value not in texts:
                        texts.append(value)
                    ET.SubElement(cell, f"{{{MAIN_NS}}}v").text = str(texts.index(value))
        return ET.tostring(document)

    area_xml, point_xml = sheet(areas), sheet(points)
    shared = ET.Element(f"{{{MAIN_NS}}}sst")
    for text in texts:
        ET.SubElement(ET.SubElement(shared, f"{{{MAIN_NS}}}si"), f"{{{MAIN_NS}}}t").text = text
    workbook = ET.Element(f"{{{MAIN_NS}}}workbook")
    sheets = ET.SubElement(workbook, f"{{{MAIN_NS}}}sheets")
    relationships = ET.Element(f"{{{REL_NS}}}Relationships")
    for name, identifier, target in [("VGTB_ATT_VG", "r7", "worksheets/areas.xml"), ("VG250_PK", "r2", "worksheets/points.xml")]:
        ET.SubElement(sheets, f"{{{MAIN_NS}}}sheet", name=name, attrib={f"{{{OFFICE_REL_NS}}}id": identifier})
        ET.SubElement(relationships, f"{{{REL_NS}}}Relationship", Id=identifier, Type=f"{OFFICE_REL_NS}/worksheet", Target=target)
    workbook_bytes = io.BytesIO()
    with zipfile.ZipFile(workbook_bytes, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in [("xl/workbook.xml", ET.tostring(workbook)), ("xl/_rels/workbook.xml.rels", ET.tostring(relationships)),
                              ("xl/sharedStrings.xml", ET.tostring(shared)), ("xl/worksheets/areas.xml", area_xml), ("xl/worksheets/points.xml", point_xml)]:
            archive.writestr(name, content)
    archive_bytes = io.BytesIO()
    with zipfile.ZipFile(archive_bytes, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(WORKBOOK_PATH, workbook_bytes.getvalue())
        for suffix in ("aktualitaet.txt", "dokumentation/aktualitaet.txt"):
            archive.writestr(f"{ARCHIVE_ROOT}/{suffix}", date + "\r\n\r\n")
    return archive_bytes.getvalue()


def one_area(**changes):
    return {"ADE": "6", "ARS": "010010000000", "AGS": "01001000", "GEN": "Quellenstadt", "EWZ": "1500", **changes}


def one_point(**changes):
    return {"ARS": "010010000000", "AGS": "01001000", "GEN": "Quellenstadt", "LON_DEZ": "9.4", "LAT_DEZ": "54.7", **changes}


class PopulationImportTest(unittest.TestCase):
    def test_preserves_ags_population_and_decimal_coordinates(self):
        rows = parse_archive(archive_fixture())
        self.assertEqual(rows, [
            {"id": "01001000", "name": "Quellenstadt", "population": 1500, "latitudeE7": 547825200, "longitudeE7": 94375100},
            {"id": "01002000", "name": "Nullgebiet", "population": 0, "latitudeE7": 543217750, "longitudeE7": 101372700},
        ])
        self.assertEqual(sum(row["population"] for row in rows), 1500)

    def test_permuted_source_rows_preserve_canonical_result(self):
        self.assertEqual(parse_archive(archive_fixture()), parse_archive(archive_fixture(reverse=True)))

    def test_missing_or_invalid_population_is_never_zero(self):
        for population in ("", "-", "unbekannt", "-1", "1.5", "1e3", "NaN", "100000001"):
            with self.subTest(population=population), self.assertRaisesRegex(PopulationImportError, "Einwohnerzahl"):
                parse_archive(archive_fixture([one_area(EWZ=population)], [one_point()]))

    def test_missing_municipality_or_point_is_rejected(self):
        with self.assertRaisesRegex(PopulationImportError, "Gemeindepunkt fehlt"):
            parse_archive(archive_fixture([one_area()], []))
        with self.assertRaisesRegex(PopulationImportError, "vollständig verbunden"):
            parse_archive(archive_fixture([one_area()], [one_point(), one_point(AGS="01002000", ARS="010020000000")]))

    def test_duplicate_population_or_point_cannot_multiply_population(self):
        with self.assertRaisesRegex(PopulationImportError, "Doppelte Gemeinde"):
            parse_archive(archive_fixture([one_area(), one_area()], [one_point()]))
        with self.assertRaisesRegex(PopulationImportError, "Doppelter Gemeindepunkt"):
            parse_archive(archive_fixture([one_area()], [one_point(), one_point()]))

    def test_identifiers_names_and_administrative_levels_are_bound(self):
        for changes in ({"AGS": "1001000"}, {"ARS": "010020000000"}, {"GEN": ""}, {"ADE": ""}, {"ADE": "7"}):
            with self.subTest(changes=changes), self.assertRaises(PopulationImportError):
                parse_archive(archive_fixture([one_area(**changes)], [one_point()]))
        with self.assertRaisesRegex(PopulationImportError, "widerspricht"):
            parse_archive(archive_fixture([one_area()], [one_point(GEN="Andere Gemeinde")]))

    def test_invalid_coordinates_are_not_replaced_with_defaults(self):
        for changes in ({"LAT_DEZ": ""}, {"LAT_DEZ": "NaN"}, {"LAT_DEZ": "90.01"}, {"LON_DEZ": "Infinity"}, {"LON_DEZ": "-180.1"}):
            with self.subTest(changes=changes), self.assertRaisesRegex(PopulationImportError, "Gemeindekoordinate"):
                parse_archive(archive_fixture([one_area()], [one_point(**changes)]))
        self.assertEqual(_coordinate("-0.00000005", 180), -1)
        self.assertEqual(_coordinate("0.00000005", 180), 1)

    def test_date_and_formulas_are_rejected(self):
        with self.assertRaisesRegex(PopulationImportError, "Bevölkerungsstand"):
            parse_archive(archive_fixture(date="31.12.2023"))
        with self.assertRaisesRegex(PopulationImportError, "Formeln"):
            parse_archive(archive_fixture(formula=True))

    def test_arbitrary_matching_archive_cannot_claim_bkg_rights(self):
        blob = archive_fixture()
        with self.assertRaisesRegex(PopulationImportError, "rechtegeprüfte"):
            import_population(blob, hashlib.sha256(blob).hexdigest())
        with self.assertRaisesRegex(PopulationImportError, "Eingabearchivs"):
            import_population(blob, ARTIFACT_SHA256)

    def test_cli_does_not_replace_output_after_integrity_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / "source.zip", Path(temporary) / "out.json"
            source.write_bytes(archive_fixture())
            output.write_text("unchanged", encoding="utf-8")
            self.assertEqual(main(["--input", str(source), "--output", str(output), "--expected-sha256", ARTIFACT_SHA256]), 1)
            self.assertEqual(output.read_text(encoding="utf-8"), "unchanged")


if __name__ == "__main__":
    unittest.main()
