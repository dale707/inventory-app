// Minimal RFC 4180 CSV parsing/writing plus mapping of inventory columns.

// Accepted header names for each item field. Headers are compared lower-cased with
// spaces/underscores/hyphens collapsed, so "Order_Unit" and "order unit" both match.
const COLUMNS = {
  code: ['id', 'item id', 'code', 'item code', 'item no', 'item number', 'sku', 'part number'],
  brand: ['brand', 'make', 'manufacturer'],
  category: ['category', 'cat', 'group', 'type'],
  name1: ['name1', 'name 1', 'name', 'item name', 'product name'],
  name2: ['name2', 'name 2', 'description', 'desc'],
  size: ['size', 'dimensions', 'dimension', 'spec', 'specification'],
  orderUnit: ['order unit', 'orderunit', 'unit', 'units', 'uom'],
  vendor1: ['vendor1', 'vendor 1', 'vendor', 'supplier', 'supplier1', 'supplier 1'],
  vendor2: ['vendor2', 'vendor 2', 'supplier2', 'supplier 2'],
  remarks: ['remarks', 'remark', 'notes', 'note', 'comments', 'comment'],
};

const normHeader = (h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  // Excel in some locales writes semicolon-separated files.
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';

  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Returns { items, skipped } or { error }. Each item only contains the fields
// present (non-empty) in the CSV, so imports can update existing items partially.
export function rowsToItems(rows) {
  if (rows.length < 2) return { error: 'The file needs a header row and at least one item row.' };
  const header = rows[0].map(normHeader);
  const idx = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) idx[key] = i;
  }
  if (idx.name1 === undefined && idx.code === undefined) {
    return { error: 'No "Name1" or "ID" column found.\nExpected headers: ID, Brand, Category, Name1, Name2, Size, Order Unit, Vendor1, Vendor2, Remarks' };
  }

  const items = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const item = {};
    for (const [key, i] of Object.entries(idx)) {
      const v = (r[i] ?? '').trim();
      if (v !== '') item[key] = v;
    }
    if (!item.name1 && !item.code) { skipped++; continue; }
    items.push(item);
  }
  return { items, skipped };
}

export function toCSV(headers, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
