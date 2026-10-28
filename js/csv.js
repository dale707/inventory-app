// Minimal RFC 4180 CSV parsing/writing plus mapping of inventory and vendor columns.

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
  vendor: ['vendor', 'vendor1', 'vendor 1', 'supplier', 'supplier1', 'supplier 1'],
  vendor2: ['vendor2', 'vendor 2', 'supplier2', 'supplier 2'], // older files: becomes a second row
  remarks: ['remarks', 'remark', 'notes', 'note', 'comments', 'comment'],
  noMore: ['no more', 'nomore', 'discontinued'], // Yes/No
};

// Same for vendor details.
const VENDOR_COLUMNS = {
  name: ['vendor name', 'vendorname', 'vendor', 'name', 'supplier', 'supplier name'],
  alias1: ['alias 1', 'alias1', 'alias'],
  alias2: ['alias 2', 'alias2'],
  howToOrder: ['howto order', 'how to order', 'howtoorder', 'order method', 'ordering'],
  bookLatestDate: ['booklatestdate', 'book latest date', 'latest booking date', 'order by', 'cutoff', 'cut off'],
  deliveryDate: ['deliverydate', 'delivery date', 'delivery', 'delivery day'],
  phone: ['phonenum', 'phone num', 'phone', 'phone number', 'tel', 'telephone'],
  email: ['email', 'e mail', 'email address', 'mail'],
  sales: ['sales', 'salesperson', 'sales person', 'sales rep', 'contact'],
  remarks1: ['remarks 1', 'remarks1', 'remarks', 'remark', 'notes', 'note', 'comments'],
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
  const idx = columnIndex(rows[0], COLUMNS);
  if (idx.name1 === undefined && idx.code === undefined) {
    return { error: 'No "Name1" or "ID" column found.\nExpected headers: ID, Brand, Category, Name1, Name2, Size, Order Unit, Vendor, Remarks, No More' };
  }

  const items = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const item = pick(r, idx);
    if (!item.name1 && !item.code) { skipped++; continue; }
    const { vendor2, ...first } = item;
    if (!first.vendor && vendor2) first.vendor = vendor2;
    items.push(first);
    // Same ID under the second vendor; without an ID, Name1 links the two (see importItems).
    if (vendor2 && vendor2 !== first.vendor) items.push({ ...first, vendor: vendor2 });
  }
  return { items, skipped };
}

// Returns { vendors, skipped } or { error }; like rowsToItems, only non-empty fields are set.
export function rowsToVendors(rows) {
  if (rows.length < 2) return { error: 'The file needs a header row and at least one vendor row.' };
  const idx = columnIndex(rows[0], VENDOR_COLUMNS);
  if (idx.name === undefined) {
    return { error: 'No "Vendor Name" column found.\nExpected headers: Vendor Name, Alias 1, Alias 2, Howto Order, BookLatestDate, DeliveryDate, PhoneNum, Email, Sales, Remarks 1' };
  }
  const vendors = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const v = pick(r, idx);
    if (v.name) vendors.push(v); else skipped++;
  }
  return { vendors, skipped };
}

// { field: column index } for the header row, using an alias table like COLUMNS.
function columnIndex(headerRow, columns) {
  const header = headerRow.map(normHeader);
  const idx = {};
  for (const [key, aliases] of Object.entries(columns)) {
    const i = header.findIndex((h) => aliases.includes(h));
    if (i >= 0) idx[key] = i;
  }
  return idx;
}

// The row's non-empty fields as { field: value }.
function pick(row, idx) {
  const out = {};
  for (const [key, i] of Object.entries(idx)) {
    const v = (row[i] ?? '').trim();
    if (v !== '') out[key] = v;
  }
  return out;
}

export function toCSV(headers, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}
