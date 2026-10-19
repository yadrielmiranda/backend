"""Read the supplied NFRC workbook without modifying it; preserve decimal text."""

import argparse
import hashlib
import json
import posixpath
import re
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def extract(path, version):
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared = ["".join(item.itertext()) for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheet = next(item for item in workbook.findall("s:sheets/s:sheet", NS) if item.attrib["name"] == "NFRC PLAN")
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next(item.attrib["Target"] for item in relationships if item.attrib["Id"] == sheet.attrib[f"{{{REL}}}id"])
        target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        xml = ET.fromstring(archive.read(target))
        cells = {}
        for cell in xml.findall("s:sheetData/s:row/s:c", NS):
            kind = cell.attrib.get("t")
            value = cell.find("s:v", NS)
            if kind == "s":
                text = shared[int(value.text)] if value is not None else ""
            elif kind == "inlineStr":
                text = "".join(cell.find("s:is", NS).itertext())
            else:
                text = value.text if value is not None else ""
            cells[cell.attrib["r"]] = text
        contexts = {}
        for merge in xml.findall("s:mergeCells/s:mergeCell", NS):
            match = re.fullmatch(r"D(\d+):D(\d+)", merge.attrib["ref"])
            if match:
                start, end = map(int, match.groups())
                for row in range(start, end + 1):
                    contexts[row] = cells.get(f"D{start}", "")
        brand_headers = sorted((int(ref[1:]), value.strip()) for ref, value in cells.items() if re.fullmatch(r"D\d+", ref) and value.strip() in ("ECO WINDOW", "ECO NOVO"))
        rows = []
        for ref, value in cells.items():
            match = re.fullmatch(r"F(\d+)", ref)
            if not match or not re.fullmatch(r"GL\s*-\s*\d+", str(value).strip(), re.I):
                continue
            row = int(match.group(1))
            rows.append({
                "sourceRow": row,
                "brandLabel": next((label for header_row, label in reversed(brand_headers) if header_row < row), ""),
                "productLabel": contexts.get(row, cells.get(f"D{row}", "")).strip(),
                "glassDescription": cells.get(f"E{row}", "").strip(),
                "sourceGlassId": value.strip(),
                "nominalThickness": cells.get(f"G{row}", "").strip(),
                "composition": cells.get(f"H{row}", "").strip(),
                "uFactor": cells.get(f"I{row}") or None,
                "shgc": cells.get(f"J{row}") or None,
                "vlt": cells.get(f"K{row}") or None,
            })
    return {
        "formatVersion": 1,
        "sourceFile": path.name,
        "sourceSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "sourceSheet": "NFRC PLAN",
        "sourceVersion": version,
        "rows": sorted(rows, key=lambda row: row["sourceRow"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    result = extract(args.workbook, args.version)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"rows": len(result["rows"]), "numericRows": sum(all(re.fullmatch(r"\d+(?:\.\d+)?", row[key] or "") for key in ("uFactor", "shgc", "vlt")) for row in result["rows"]), "output": str(args.output)}))


if __name__ == "__main__":
    main()
