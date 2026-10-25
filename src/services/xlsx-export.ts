type CellValue = string | number | boolean | null;

type ZipEntry = {
  name: string;
  data: Uint8Array;
  crc32: number;
  offset: number;
};

const textEncoder = new TextEncoder();

export function buildXlsxWorkbook(rows: CellValue[][]): Uint8Array {
  const sheetXml = buildWorksheetXml(rows);
  const entries = [
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Resultados" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: sheetXml,
    },
  ];

  return zip(entries.map((entry) => ({ name: entry.name, data: textEncoder.encode(entry.content) })));
}

function buildWorksheetXml(rows: CellValue[][]) {
  const rowXml = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((cell, columnIndex) => buildCellXml(cell, columnName(columnIndex), rowNumber)).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function buildCellXml(value: CellValue, column: string, rowNumber: number) {
  const ref = `${column}${rowNumber}`;

  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }

  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }

  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(value ?? ""))}</t></is></c>`;
}

function columnName(index: number) {
  let current = index + 1;
  let name = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }

  return name;
}

function zip(files: Array<{ name: string; data: Uint8Array }>) {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const crc = crc32(file.data);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);

    writeUint32(view, 0, 0x04034b50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 0);
    writeUint16(view, 8, 0);
    writeUint16(view, 10, 0);
    writeUint16(view, 12, 0);
    writeUint32(view, 14, crc);
    writeUint32(view, 18, file.data.length);
    writeUint32(view, 22, file.data.length);
    writeUint16(view, 26, nameBytes.length);
    writeUint16(view, 28, 0);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, file.data);
    entries.push({ name: file.name, data: file.data, crc32: crc, offset });
    offset += localHeader.length + file.data.length;
  }

  const centralDirectoryOffset = offset;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(centralHeader.buffer);

    writeUint32(view, 0, 0x02014b50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 20);
    writeUint16(view, 8, 0);
    writeUint16(view, 10, 0);
    writeUint16(view, 12, 0);
    writeUint16(view, 14, 0);
    writeUint32(view, 16, entry.crc32);
    writeUint32(view, 20, entry.data.length);
    writeUint32(view, 24, entry.data.length);
    writeUint16(view, 28, nameBytes.length);
    writeUint16(view, 30, 0);
    writeUint16(view, 32, 0);
    writeUint16(view, 34, 0);
    writeUint16(view, 36, 0);
    writeUint32(view, 38, 0);
    writeUint32(view, 42, entry.offset);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += centralHeader.length;
  }

  const centralDirectorySize = offset - centralDirectoryOffset;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralDirectorySize);
  writeUint32(endView, 16, centralDirectoryOffset);
  writeUint16(endView, 20, 0);

  return concatUint8Arrays([...localParts, ...centralParts, end]);
}

function concatUint8Arrays(parts: Uint8Array[]) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
