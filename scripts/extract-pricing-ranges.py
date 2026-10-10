#!/usr/bin/env python3
"""Extract Pricing Ranges cells without evaluating formulas or rounding numbers.

This is a read-only workbook adapter. The importer validates range semantics and
catalog associations separately. No spreadsheet library or database is required.

Usage:
  python scripts/extract-pricing-ranges.py --input ranges.xlsx --output ranges.json

The output must not exist. By default, use the "Pricing Ranges" worksheet, or a
single worksheet whose row 6 matches the template. Use --sheet for another name.
"""

import argparse
import hashlib
import io
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS}
COLUMNS = tuple("ABCDEFGHIJKLMNOPQRS")
HEADERS = (
    "Range Code", "Brand", "Product", "System", "Configuration", "Crystal",
    "Minimum Width (in)", "Include minimum (Width Range)",
    "Maximum Width (in)", "Include maximum (Width Range)",
    "Minimum Height (in)", "Include minimum (Height Range)",
    "Maximum Height (in)", "Include maximum (Height Range)",
    "Area Cost (A)", "Perimeter Cost (B)", "Fixed Cost (C)", "Sort Order", "Active",
)
HEADER_ROW = 6
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_XML_BYTES = 64 * 1024 * 1024


class ExtractionError(ValueError):
    """The input does not meet the expected workbook contract."""


def read_xml(archive, name):
    try:
        info = archive.getinfo(name)
    except KeyError as exc:
        raise ExtractionError(f"Missing workbook part: {name}") from exc
    if info.file_size > MAX_XML_BYTES:
        raise ExtractionError(f"Workbook part is too large: {name}")
    data = archive.read(name)
    # XLSX parts do not need DTDs or custom entities.
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ExtractionError(f"XML declarations are not allowed in {name}")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ExtractionError(f"Invalid XML in {name}: {exc}") from exc


def string_text(element):
    """Join actual rich-text runs, excluding phonetic annotations and formatting."""
    if element is None:
        return ""
    return "".join(
        child.text or ""
        for child in element.findall("m:t", NS) + element.findall("m:r/m:t", NS)
    )


def decode_cell(cell, strings, sheet_name):
    location = f"{sheet_name}!{cell.get('r', '?')}"
    if cell.find("m:f", NS) is not None:
        raise ExtractionError(f"Formula not allowed at {location}; replace it with its value.")
    kind = cell.get("t", "n")
    if kind == "e":
        raise ExtractionError(f"Excel error at {location}; correct the cell first.")
    value_element = cell.find("m:v", NS)
    value = value_element.text if value_element is not None else None
    if kind == "s":
        if value is None or not re.fullmatch(r"\d+", value):
            raise ExtractionError(f"Invalid shared-string reference at {location}")
        index = int(value)
        if index >= len(strings):
            raise ExtractionError(f"Unknown shared-string reference at {location}")
        return strings[index]
    if kind == "inlineStr":
        return string_text(cell.find("m:is", NS))
    if kind not in ("n", "str", "b"):
        raise ExtractionError(f"Unsupported cell type {kind!r} at {location}")
    if kind == "b" and value not in (None, "0", "1"):
        raise ExtractionError(f"Invalid boolean at {location}")
    # Keep the XML spelling, including all decimal places. Never use float().
    return value


def worksheet_rows(root, sheet_name):
    data = root.find("m:sheetData", NS)
    if data is None:
        raise ExtractionError(f"Missing worksheet data in {sheet_name}")
    result = {}
    for row in data.findall("m:row", NS):
        raw_number = row.get("r", "")
        if not re.fullmatch(r"[1-9]\d*", raw_number):
            raise ExtractionError(f"Invalid row number in {sheet_name}")
        number = int(raw_number)
        if number > 1048576 or number in result:
            raise ExtractionError(f"Invalid or duplicate row {number} in {sheet_name}")
        cells = {}
        for cell in row.findall("m:c", NS):
            match = re.fullmatch(r"([A-Z]{1,3})([1-9]\d*)", cell.get("r", ""))
            if match is None or int(match.group(2)) != number:
                raise ExtractionError(f"Invalid cell reference in {sheet_name}, row {number}")
            column = match.group(1)
            if column in cells:
                raise ExtractionError(f"Duplicate cell {sheet_name}!{column}{number}")
            cells[column] = cell
        result[number] = cells
    return result


def nonblank(value):
    return value is not None and bool(value.strip())


def row_values(cells, strings, sheet_name):
    return {column: decode_cell(cell, strings, sheet_name) for column, cell in cells.items()}


def validate_headers(values, sheet_name):
    for column, expected in zip(COLUMNS, HEADERS):
        actual = values.get(column)
        if actual is None or actual.strip() != expected:
            raise ExtractionError(
                f"Wrong header at {sheet_name}!{column}{HEADER_ROW}: "
                f"expected {expected!r}, found {actual!r}"
            )
    extras = [column for column, value in values.items() if column not in COLUMNS and nonblank(value)]
    if extras:
        raise ExtractionError(f"Unexpected header columns in {sheet_name}: {', '.join(extras)}")


def sheet_parts(archive):
    workbook = read_xml(archive, "xl/workbook.xml")
    rels = read_xml(archive, "xl/_rels/workbook.xml.rels")
    relationships = {}
    for rel in rels.findall(f"{{{PACKAGE_REL_NS}}}Relationship"):
        key = rel.get("Id")
        if key in relationships:
            raise ExtractionError("Duplicate workbook relationship")
        relationships[key] = rel
    result = {}
    for sheet in workbook.findall("m:sheets/m:sheet", NS):
        name = sheet.get("name")
        if not name or name in result:
            raise ExtractionError("Missing or duplicate worksheet name")
        rel = relationships.get(sheet.get(f"{{{REL_NS}}}id"))
        if rel is None:
            raise ExtractionError(f"Missing worksheet relationship for {name}")
        # Chartsheets and similar non-tabular sheets cannot contain our input.
        if rel.get("Type") != f"{REL_NS}/worksheet":
            continue
        if rel.get("TargetMode", "Internal") != "Internal":
            raise ExtractionError(f"External worksheet reference is not allowed: {name}")
        target = rel.get("Target", "")
        if not target or "\\" in target or "?" in target or "#" in target or ":" in target:
            raise ExtractionError(f"Invalid worksheet target for {name}")
        path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
        if not path.startswith("xl/") or path.endswith("/"):
            raise ExtractionError(f"Worksheet target is outside the workbook: {name}")
        result[name] = path
    if not result:
        raise ExtractionError("Workbook contains no worksheets")
    return result


def extract_workbook(source, sheet_name=None):
    source = Path(source)
    if source.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ExtractionError("Workbook is too large")
    raw = source.read_bytes()
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ExtractionError("Workbook contains duplicate ZIP parts")
        if sum(info.file_size for info in archive.infolist()) > MAX_ARCHIVE_BYTES:
            raise ExtractionError("Uncompressed workbook is too large")
        strings = []
        if "xl/sharedStrings.xml" in names:
            strings = [string_text(si) for si in read_xml(archive, "xl/sharedStrings.xml").findall("m:si", NS)]
        parts = sheet_parts(archive)
        sheets = {}

        def load(name):
            if name not in sheets:
                sheets[name] = worksheet_rows(read_xml(archive, parts[name]), name)
            return sheets[name]

        if sheet_name is not None and sheet_name not in parts:
            raise ExtractionError(f"Worksheet not found: {sheet_name}")
        if sheet_name is None and "Pricing Ranges" in parts:
            sheet_name = "Pricing Ranges"
        if sheet_name is None:
            matches = []
            for name in parts:
                cells = load(name).get(HEADER_ROW, {})
                try:
                    validate_headers(row_values(cells, strings, name), name)
                except ExtractionError:
                    continue
                matches.append(name)
            if len(matches) != 1:
                raise ExtractionError(
                    f"Expected one worksheet matching the template at row {HEADER_ROW}; "
                    f"found {len(matches)}. Specify --sheet and check the headers."
                )
            sheet_name = matches[0]

        rows = load(sheet_name)
        validate_headers(row_values(rows.get(HEADER_ROW, {}), strings, sheet_name), sheet_name)
        extracted = []
        for number in sorted(rows):
            if number <= HEADER_ROW:
                continue
            values = row_values(rows[number], strings, sheet_name)
            extras = [column for column, value in values.items() if column not in COLUMNS and nonblank(value)]
            if extras:
                raise ExtractionError(
                    f"Unexpected data outside columns A:S at {sheet_name}, row {number}: {', '.join(extras)}"
                )
            if not any(nonblank(value) for value in values.values()):
                continue
            extracted.append({"row": number, "values": {column: values.get(column) for column in COLUMNS}})
        if not extracted:
            raise ExtractionError(f"No pricing range rows found in {sheet_name}")
    return {
        "schemaVersion": 1,
        "sourceFileName": source.name,
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "sheetName": sheet_name,
        "rows": extracted,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True, type=Path, help="Source .xlsx workbook (read only)")
    parser.add_argument("--output", required=True, type=Path, help="New JSON file; must not already exist")
    parser.add_argument("--sheet", help="Exact worksheet name; default is Pricing Ranges or an unambiguous header match")
    args = parser.parse_args(argv)
    try:
        if args.input.resolve() == args.output.resolve():
            raise ExtractionError("Input and output must be different files")
        if args.output.exists():
            raise ExtractionError("Output already exists; choose a new path to avoid overwriting data")
        payload = extract_workbook(args.input, args.sheet)
        # Serialize before opening output so invalid input never creates an output.
        encoded = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        with args.output.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(encoded)
        print(json.dumps({"output": str(args.output), "sheet": payload["sheetName"], "rows": len(payload["rows"]), "sourceSha256": payload["sourceSha256"]}, ensure_ascii=False))
        return 0
    except (ExtractionError, OSError, ValueError, zipfile.BadZipFile, RuntimeError) as exc:
        print(f"Extraction failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
