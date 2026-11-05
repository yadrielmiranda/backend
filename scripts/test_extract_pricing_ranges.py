"""Regression tests for the XLSX adapter; run with Python's unittest module."""

import contextlib
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


SPEC = importlib.util.spec_from_file_location("extract_pricing_ranges", Path(__file__).with_name("extract-pricing-ranges.py"))
extractor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extractor)
N = extractor.MAIN_NS
R = extractor.REL_NS
P = extractor.PACKAGE_REL_NS


def sheet(data_cells=None, header_override=None, more_rows=None, header_row=6):
    root = ET.Element(f"{{{N}}}worksheet")
    data = ET.SubElement(root, f"{{{N}}}sheetData")
    headers = dict(zip(extractor.COLUMNS, extractor.HEADERS))
    headers.update(header_override or {})
    all_rows = {
        header_row: {col: ("str", value) for col, value in headers.items()},
        header_row + 1: data_cells or {"A": ("str", "SMALL_01")},
    }
    all_rows.update(more_rows or {})
    for number, cells in all_rows.items():
        row = ET.SubElement(data, f"{{{N}}}row", {"r": str(number)})
        for col, (kind, value) in cells.items():
            cell = ET.SubElement(row, f"{{{N}}}c", {"r": f"{col}{number}", "t": "n" if kind == "formula" else kind})
            if kind == "formula":
                ET.SubElement(cell, f"{{{N}}}f").text = "1+1"
            if kind == "inlineStr":
                inline = ET.SubElement(cell, f"{{{N}}}is")
                ET.SubElement(inline, f"{{{N}}}t").text = value
            else:
                ET.SubElement(cell, f"{{{N}}}v").text = value
    return ET.tostring(root, encoding="utf-8")


def workbook(path, sheets=None, shared=None):
    sheets = sheets or {"Pricing Ranges": sheet()}
    root = ET.Element(f"{{{N}}}workbook")
    sheet_list = ET.SubElement(root, f"{{{N}}}sheets")
    rels = ET.Element(f"{{{P}}}Relationships")
    with zipfile.ZipFile(path, "w") as archive:
        for index, (name, content) in enumerate(sheets.items(), start=1):
            rel_id = f"rId{index}"
            ET.SubElement(sheet_list, f"{{{N}}}sheet", {"name": name, "sheetId": str(index), f"{{{R}}}id": rel_id})
            ET.SubElement(rels, f"{{{P}}}Relationship", {"Id": rel_id, "Type": f"{R}/worksheet", "Target": f"worksheets/sheet{index}.xml"})
            archive.writestr(f"xl/worksheets/sheet{index}.xml", content)
        archive.writestr("xl/workbook.xml", ET.tostring(root))
        archive.writestr("xl/_rels/workbook.xml.rels", ET.tostring(rels))
        if shared:
            archive.writestr("xl/sharedStrings.xml", shared)


class ExtractorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "rángos.xlsx"

    def test_preserves_decimal_spelling_unicode_and_blanks(self):
        workbook(self.source, {"Pricing Ranges": sheet({
            "A": ("str", "  SMALL_01  "),
            "G": ("n", "67.0625"),
            "O": ("str", "1.12345678901234567890"),
            "P": ("n", "1.20E-5"),
            "S": ("inlineStr", "Sí"),
        }, more_rows={8: {"A": ("str", " ")}, 10: {"A": ("str", "LARGE_01")}})})
        before = self.source.read_bytes()
        result = extractor.extract_workbook(self.source)
        self.assertEqual(before, self.source.read_bytes())
        self.assertEqual(result["sourceSha256"], hashlib.sha256(before).hexdigest())
        self.assertEqual(result["sourceFileName"], "rángos.xlsx")
        self.assertEqual([row["row"] for row in result["rows"]], [7, 10])
        values = result["rows"][0]["values"]
        self.assertEqual(values["A"], "  SMALL_01  ")
        self.assertEqual(values["G"], "67.0625")
        self.assertEqual(values["O"], "1.12345678901234567890")
        self.assertEqual(values["P"], "1.20E-5")
        self.assertEqual(values["S"], "Sí")
        self.assertIsNone(values["I"])
        self.assertEqual(tuple(values), extractor.COLUMNS)

    def test_shared_rich_text_excludes_phonetic_annotation(self):
        shared = f'<sst xmlns="{N}"><si><r><t>Eco </t></r><rPh sb="0" eb="1"><t>not a name</t></rPh><r><t>Windows</t></r></si></sst>'
        workbook(self.source, {"Pricing Ranges": sheet({"B": ("s", "0")})}, shared)
        self.assertEqual(extractor.extract_workbook(self.source)["rows"][0]["values"]["B"], "Eco Windows")

    def test_row_four_template_preserves_all_data_and_decimal_spelling(self):
        workbook(self.source, {"Pricing Ranges": sheet(
            {"A": ("str", "FIRST"), "Q": ("n", "2.273736754432321e-13")},
            more_rows={6: {"A": ("str", "SECOND")}, 7: {"A": ("str", "THIRD")}},
            header_row=4,
        )})
        before = self.source.read_bytes()
        result = extractor.extract_workbook(self.source)
        self.assertEqual([row["row"] for row in result["rows"]], [5, 6, 7])
        self.assertEqual([row["values"]["A"] for row in result["rows"]], ["FIRST", "SECOND", "THIRD"])
        self.assertEqual(result["rows"][0]["values"]["Q"], "2.273736754432321e-13")
        self.assertEqual(self.source.read_bytes(), before)

    def test_row_six_data_formula_is_rejected_with_row_four_headers(self):
        workbook(self.source, {"Pricing Ranges": sheet(
            more_rows={6: {"O": ("formula", "2")}}, header_row=4,
        )})
        with self.assertRaisesRegex(extractor.ExtractionError, "Formula.*O6"):
            extractor.extract_workbook(self.source)

    def test_row_four_wrong_header_reports_its_actual_location(self):
        workbook(self.source, {"Pricing Ranges": sheet(header_override={"O": "Cost"}, header_row=4)})
        with self.assertRaisesRegex(extractor.ExtractionError, "Wrong header.*O4"):
            extractor.extract_workbook(self.source)

    def test_rejects_extra_header_column_in_each_template(self):
        for number in (4, 6):
            with self.subTest(header_row=number):
                workbook(self.source, {"Pricing Ranges": sheet(header_override={"T": "Extra"}, header_row=number)})
                with self.assertRaisesRegex(extractor.ExtractionError, "Unexpected header columns.*T"):
                    extractor.extract_workbook(self.source)

    def test_rejects_ambiguous_header_rows_even_with_explicit_sheet(self):
        headers = {column: ("str", value) for column, value in zip(extractor.COLUMNS, extractor.HEADERS)}
        workbook(self.source, {"Pricing Ranges": sheet(more_rows={6: headers}, header_row=4)})
        for name in (None, "Pricing Ranges"):
            with self.subTest(sheet=name), self.assertRaisesRegex(extractor.ExtractionError, "Ambiguous.*rows 4, 6"):
                extractor.extract_workbook(self.source, name)

    def test_header_detection_is_limited_to_supported_template_rows(self):
        workbook(self.source, {"Pricing Ranges": sheet(header_row=8)})
        with self.assertRaisesRegex(extractor.ExtractionError, "Wrong header"):
            extractor.extract_workbook(self.source)

    def test_ambiguous_renamed_sheet_is_not_silently_ignored(self):
        headers = {column: ("str", value) for column, value in zip(extractor.COLUMNS, extractor.HEADERS)}
        workbook(self.source, {"Ambiguous": sheet(more_rows={6: headers}, header_row=4), "Other": sheet()})
        with self.assertRaisesRegex(extractor.ExtractionError, "Ambiguous.*rows 4, 6"):
            extractor.extract_workbook(self.source)
        self.assertEqual(extractor.extract_workbook(self.source, "Other")["sheetName"], "Other")

    def test_rejects_formula_even_with_cached_value(self):
        workbook(self.source, {"Pricing Ranges": sheet({"O": ("formula", "2")})})
        with self.assertRaisesRegex(extractor.ExtractionError, "Formula.*O7"):
            extractor.extract_workbook(self.source)

    def test_rejects_error(self):
        workbook(self.source, {"Pricing Ranges": sheet({"O": ("e", "#DIV/0!")})})
        with self.assertRaisesRegex(extractor.ExtractionError, "Excel error.*O7"):
            extractor.extract_workbook(self.source)

    def test_rejects_wrong_header(self):
        workbook(self.source, {"Pricing Ranges": sheet(header_override={"O": "Cost"})})
        with self.assertRaisesRegex(extractor.ExtractionError, "Wrong header.*O6"):
            extractor.extract_workbook(self.source)

    def test_rejects_header_formula(self):
        content = sheet().replace(b'<ns0:v>Range Code</ns0:v>', b'<ns0:f>"Range Code"</ns0:f><ns0:v>Range Code</ns0:v>')
        workbook(self.source, {"Pricing Ranges": content})
        with self.assertRaisesRegex(extractor.ExtractionError, "Formula.*A6"):
            extractor.extract_workbook(self.source)

    def test_finds_renamed_sheet_and_ignores_guide_data(self):
        workbook(self.source, {"Guía": sheet({"O": ("formula", "2")}, {"A": "Instructions"}), "Importación": sheet()})
        self.assertEqual(extractor.extract_workbook(self.source)["sheetName"], "Importación")

    def test_finds_renamed_row_four_template(self):
        workbook(self.source, {"Guía": sheet(header_override={"A": "Instructions"}), "Importación": sheet(header_row=4)})
        self.assertEqual(extractor.extract_workbook(self.source)["sheetName"], "Importación")

    def test_requires_unambiguous_sheet_unless_explicit(self):
        workbook(self.source, {"One": sheet(header_row=4), "Two": sheet()})
        with self.assertRaisesRegex(extractor.ExtractionError, "found 2"):
            extractor.extract_workbook(self.source)
        self.assertEqual(extractor.extract_workbook(self.source, "Two")["sheetName"], "Two")

    def test_named_sheet_with_bad_header_is_not_silently_ignored(self):
        workbook(self.source, {"Pricing Ranges": sheet(header_override={"A": "Wrong"}), "Other": sheet()})
        with self.assertRaisesRegex(extractor.ExtractionError, "Wrong header"):
            extractor.extract_workbook(self.source)

    def test_rejects_data_outside_template(self):
        workbook(self.source, {"Pricing Ranges": sheet({"T": ("str", "unexpected")})})
        with self.assertRaisesRegex(extractor.ExtractionError, "outside columns A:S"):
            extractor.extract_workbook(self.source)

    def test_cli_writes_utf8_and_does_not_overwrite(self):
        workbook(self.source)
        target = self.source.with_suffix(".json")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(extractor.main(["--input", str(self.source), "--output", str(target)]), 0)
            saved = target.read_bytes()
            self.assertEqual(json.loads(saved)["sourceFileName"], "rángos.xlsx")
            self.assertEqual(extractor.main(["--input", str(self.source), "--output", str(target)]), 1)
            self.assertEqual(target.read_bytes(), saved)
            source_saved = self.source.read_bytes()
            self.assertEqual(extractor.main(["--input", str(self.source), "--output", str(self.source)]), 1)
            self.assertEqual(self.source.read_bytes(), source_saved)

    def test_invalid_input_creates_no_output(self):
        workbook(self.source, {"Pricing Ranges": sheet({"O": ("formula", "2")})})
        target = self.source.with_suffix(".json")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(extractor.main(["--input", str(self.source), "--output", str(target)]), 1)
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
