// Minimal RFC 4180 CSV parse/serialize. No dependencies.

/** Parse CSV text into an array of string arrays. Handles quotes, escaped quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  if (text.charCodeAt(0) === 0xfeff) i = 1; // strip BOM

  for (; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function escapeField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize columns + array of string-ish arrays to CSV text (LF endings, trailing newline). */
export function stringifyCsv(columns, rows) {
  const lines = [columns.map(escapeField).join(",")];
  for (const row of rows) lines.push(row.map(escapeField).join(","));
  return lines.join("\n") + "\n";
}

/** Parse CSV text with a header row into an array of plain objects keyed by header. */
export function parseCsvObjects(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((cells) => {
    const obj = {};
    header.forEach((name, idx) => {
      obj[name] = cells[idx] ?? "";
    });
    return obj;
  });
}
