const fs = require("node:fs"),
  path = require("node:path"),
  AdmZip = require("adm-zip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const root = path.resolve(__dirname, ".."),
  out = path.resolve(process.argv[2] || "work/po-dryrun/cases");
fs.mkdirSync(out, { recursive: true });
const original = fs.readFileSync(
  path.join(root, "fixtures/purchase-orders.xlsx"),
);
const sheet = "xl/worksheets/sheet1.xml",
  B = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const cases = [];
function create(id, expectedError, mutate) {
  const zip = new AdmZip(original);
  if (mutate) mutate(zip);
  fs.writeFileSync(path.join(out, id + ".xlsx"), zip.toBuffer());
  cases.push({
    id,
    file: id + ".xlsx",
    ...(expectedError ? { expectedError } : { orders: 2, items: 3 }),
  });
}
function edit(zip, action) {
  const doc = new DOMParser().parseFromString(
    zip.readAsText(sheet),
    "application/xml",
  );
  action(doc);
  zip.updateFile(
    sheet,
    Buffer.from(new XMLSerializer().serializeToString(doc)),
  );
}
function cell(doc, ref, value, type = "str") {
  const e = Array.from(doc.getElementsByTagNameNS(B, "c")).find(
    (e) => e.getAttribute("r") === ref,
  );
  if (!e) throw Error(ref);
  while (e.firstChild) e.removeChild(e.firstChild);
  e.setAttribute("t", type);
  const v = doc.createElementNS(B, "x:v");
  v.textContent = String(value);
  e.appendChild(v);
  return e;
}
create("valid");
create("shared-strings", null, (zip) => {
  edit(zip, (doc) => {
    let i = 0;
    const strings = [];
    for (const e of Array.from(doc.getElementsByTagNameNS(B, "c")).filter(
      (e) => e.getAttribute("t") === "str",
    )) {
      strings.push(e.textContent);
      const v = e.getElementsByTagNameNS(B, "v")[0];
      e.setAttribute("t", "s");
      v.textContent = String(i++);
    }
    const d = new DOMParser().parseFromString(
      `<x:sst xmlns:x="${B}"/>`,
      "application/xml",
    );
    for (const text of strings) {
      const si = d.createElementNS(B, "x:si"),
        t = d.createElementNS(B, "x:t");
      t.textContent = text;
      si.appendChild(t);
      d.documentElement.appendChild(si);
    }
    zip.updateFile(
      "xl/sharedStrings.xml",
      Buffer.from(new XMLSerializer().serializeToString(d)),
    );
  });
});
create("inline-strings", null, (zip) =>
  edit(zip, (doc) => {
    for (const e of Array.from(doc.getElementsByTagNameNS(B, "c")).filter(
      (e) => e.getAttribute("t") === "str",
    )) {
      const text = e.textContent;
      while (e.firstChild) e.removeChild(e.firstChild);
      e.setAttribute("t", "inlineStr");
      const is = doc.createElementNS(B, "x:is"),
        r = doc.createElementNS(B, "x:r"),
        t = doc.createElementNS(B, "x:t");
      t.textContent = text;
      r.appendChild(t);
      is.appendChild(r);
      e.appendChild(is);
    }
  }),
);
create("excel-1904-dates", null, (zip) => {
  const doc = new DOMParser().parseFromString(
    zip.readAsText("xl/workbook.xml"),
    "application/xml",
  );
  let props = doc.getElementsByTagNameNS(B, "workbookPr")[0];
  if (!props) {
    props = doc.createElementNS(B, "x:workbookPr");
    doc.documentElement.insertBefore(props, doc.documentElement.firstChild);
  }
  props.setAttribute("date1904", "1");
  zip.updateFile(
    "xl/workbook.xml",
    Buffer.from(new XMLSerializer().serializeToString(doc)),
  );
  edit(zip, (doc) => {
    for (const ref of ["O2", "O3", "O4"]) {
      const e = Array.from(doc.getElementsByTagNameNS(B, "c")).find(
        (e) => e.getAttribute("r") === ref,
      );
      const v = e.getElementsByTagNameNS(B, "v")[0];
      v.textContent = String(
        Math.round(Date.parse(v.textContent) / 86400000) + 25569 - 1462,
      );
      e.setAttribute("t", "n");
    }
  });
});
const badCell = (id, ref, value, error, type = "str") =>
  create(id, error, (z) => edit(z, (d) => cell(d, ref, value, type)));
badCell("missing-vendor", "D2", "", "PO_REQUIRED_FIELD");
create("unknown-vendor", "MASTER_VENDOR_NOT_ALLOWED", (z) =>
  edit(z, (d) => {
    cell(d, "D2", "0000999999");
    cell(d, "D3", "0000999999");
  }),
);
badCell(
  "unknown-material",
  "I2",
  "MAT-MISSING",
  "MASTER_MATERIAL_PLANT_NOT_FOUND",
);
badCell("unknown-plant", "J2", "9999", "MASTER_PLANT_NOT_FOUND");
badCell(
  "material-wrong-plant",
  "J2",
  "2000",
  "MASTER_MATERIAL_PLANT_NOT_FOUND",
);
badCell("zero-quantity", "K2", 0, "PO_NUMBER_RANGE", "n");
badCell("negative-quantity", "K2", -1, "PO_NUMBER_RANGE", "n");
badCell("zero-price", "M2", 0, "PO_NUMBER_RANGE", "n");
badCell("quantity-precision", "K2", "12.1234", "PO_NUMBER_RANGE", "n");
badCell("fractional-price-unit", "N2", "1.2", "PO_NUMBER_RANGE", "n");
badCell("duplicate-item", "H3", "00010", "PO_DUPLICATE_ITEM");
badCell("conflicting-header", "G3", "EUR", "PO_INCONSISTENT_HEADER");
badCell("invalid-date", "O2", "2026-02-30", "PO_DELIVERY_DATE");
badCell("missing-header", "I1", "SKU", "XLSX_HEADERS");
badCell("numeric-vendor", "D2", 100001, "XLSX_IDENTIFIER_MUST_BE_TEXT", "n");
create("formula-rejected", "XLSX_FORMULA_UNSUPPORTED", (z) =>
  edit(z, (d) => {
    const e = cell(d, "M2", "25.5", "n"),
      f = d.createElementNS(B, "x:f");
    f.textContent = "2+3";
    e.insertBefore(f, e.firstChild);
  }),
);
create("dtd-rejected", "XLSX_XML_DTD", (z) =>
  z.updateFile(
    "xl/workbook.xml",
    Buffer.from(
      z
        .readAsText("xl/workbook.xml")
        .replace(
          /(<\?xml[^?]*\?>)/,
          '$1<!DOCTYPE workbook [<!ENTITY injected "forbidden">]>',
        ),
    ),
  ),
);
// AdmZip sanitizes traversal paths, so mutate equal-length ZIP filename bytes to
// build a deliberately malformed input. No files are extracted by this test.
{
  const z = new AdmZip(original);
  z.addFile("aa/escape.xml", Buffer.from("<x/>"));
  const b = z.toBuffer();
  for (
    let at = b.indexOf("aa/escape.xml");
    at >= 0;
    at = b.indexOf("aa/escape.xml", at + 1)
  )
    b.write("../escape.xml", at, "utf8");
  fs.writeFileSync(path.join(out, "zip-traversal.xlsx"), b);
  cases.push({
    id: "zip-traversal",
    file: "zip-traversal.xlsx",
    expectedError: "XLSX_UNSAFE_PATH",
  });
}
create("invalid-shared-string", "XLSX_SHARED_STRING_INDEX", (z) =>
  edit(z, (d) => cell(d, "D2", "999999", "s")),
);
create("empty-workbook", "XLSX_EMPTY_DATA", (z) =>
  edit(z, (d) => {
    for (const row of Array.from(d.getElementsByTagNameNS(B, "row")).slice(1))
      row.parentNode.removeChild(row);
  }),
);
create("expanded-limit", "XLSX_EXPANDED_LIMIT", (z) =>
  z.addFile("xl/large.xml", Buffer.alloc(4 * 1024 * 1024 + 1, 65)),
);
create("row-limit", "XLSX_ROW_LIMIT", (z) =>
  edit(z, (d) => {
    const row = d.getElementsByTagNameNS(B, "row")[1];
    for (let i = 5; i < 1007; i++) {
      const copy = row.cloneNode(true);
      copy.setAttribute("r", String(i));
      for (const c of Array.from(copy.getElementsByTagNameNS(B, "c")))
        c.setAttribute("r", c.getAttribute("r").replace(/[0-9]+$/, String(i)));
      row.parentNode.appendChild(copy);
    }
  }),
);
create("extra-sheet", "XLSX_SHEET_CONTRACT", (z) => {
  const d = new DOMParser().parseFromString(
      z.readAsText("xl/workbook.xml"),
      "application/xml",
    ),
    s = d.getElementsByTagNameNS(B, "sheet")[0],
    copy = s.cloneNode(true);
  copy.setAttribute("name", "Unexpected");
  s.parentNode.appendChild(copy);
  z.updateFile(
    "xl/workbook.xml",
    Buffer.from(new XMLSerializer().serializeToString(d)),
  );
});
fs.writeFileSync(
  path.join(out, "not-a-zip.xlsx"),
  Buffer.from("not a workbook"),
);
cases.push({
  id: "not-a-zip",
  file: "not-a-zip.xlsx",
  expectedError: "XLSX_WORKBOOK_MISSING",
});
fs.writeFileSync(path.join(out, "cases.json"), JSON.stringify(cases, null, 2));
console.log(JSON.stringify({ generated: cases.length, folder: out }));
