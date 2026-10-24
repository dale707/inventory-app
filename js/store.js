// All app state lives in one object persisted to localStorage on every change.
// Shape:
//   items:    [{ id, code, brand, category, name1, name2, size, orderUnit, vendor1, vendor2, remarks, img }]
//             (id is internal; code is the user-facing "ID"; img is a photo stamp or '' — see images.js)
//   selected: { [itemId]: qty }
//   orders:   [{ id, orderNo, vendor, createdAt, lines: [{ itemId, code, brand, name1, name2, size, orderUnit, vendor1, vendor2, qty }] }]  newest first
//   daySeq:   { date: 'YYYYMMDD', n }  last order sequence number used on that date
//   codeSeq:  last number used for auto-assigned item IDs (0001, 0002, ...)

const KEY = 'inventoryapp.v1';
const listeners = [];

export const ITEM_FIELDS = ['code', 'brand', 'category', 'name1', 'name2', 'size', 'orderUnit', 'vendor1', 'vendor2', 'remarks'];

// Column headers used for CSV export (import also accepts these, see csv.js).
export const FIELD_LABELS = {
  code: 'ID', brand: 'Brand', category: 'Category', name1: 'Name1', name2: 'Name2',
  size: 'Size', orderUnit: 'Order Unit', vendor1: 'Vendor1', vendor2: 'Vendor2', remarks: 'Remarks',
};

const emptyState = () => ({ items: [], selected: {}, orders: [], daySeq: { date: '', n: 0 }, codeSeq: 0 });

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
    if (raw) return migrate({ ...emptyState(), ...JSON.parse(raw) });
  } catch (e) {
    console.error('Failed to load saved data', e);
    // Keep the unreadable data so the next save doesn't destroy it.
    try { if (raw) localStorage.setItem(`${KEY}.backup-${Date.now()}`, raw); } catch {}
    alert('Saved data could not be read. A backup copy was kept on this device.');
  }
  return emptyState();
}

// Upgrades saved data from earlier versions: v1 fields (sku/name/unit/qty, numeric order
// numbers), items saved before IDs were auto-assigned, and orders from before vendors
// replaced the free-text prefix (the old prefix becomes the order's vendor).
function migrate(s) {
  s.items = s.items.map((i) => ('name1' in i ? normalize(i) : normalize({
    id: i.id, code: i.sku, category: i.category, name1: i.name, orderUnit: i.unit,
  })));
  s.orders = s.orders.map((o) => ('orderNo' in o ? o : {
    id: o.id,
    orderNo: String(o.number),
    createdAt: o.createdAt,
    lines: o.lines.map((l) => ({ itemId: l.itemId, code: l.sku, brand: '', name1: l.name, name2: '', orderUnit: l.unit, qty: l.qty })),
  }));
  for (const o of s.orders) if (!('vendor' in o)) o.vendor = o.orderNo.match(/^(.*)-\d{8}-\d{3,}$/)?.[1] ?? '';
  delete s.nextOrderNo;
  delete s.lastPrefix;
  const numericCodes = s.items.map((i) => (/^\d+$/.test(i.code) ? Number(i.code) : 0));
  s.codeSeq = Math.max(s.codeSeq, 0, ...numericCodes);
  for (const i of s.items) if (!i.code) i.code = assignCode(s);
  return s;
}

const codeTaken = (s, code) => s.items.some((i) => i.code.toLowerCase() === code.toLowerCase());

function nextFreeCode(s) {
  let n = s.codeSeq;
  let code;
  do code = String(++n).padStart(4, '0'); while (codeTaken(s, code));
  return { n, code };
}

// Item IDs are auto-assigned and never reused, even after the item is deleted.
function assignCode(s) {
  const { n, code } = nextFreeCode(s);
  s.codeSeq = n;
  return code;
}

function commit() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save data', e);
    alert('Could not save data on this device. Storage may be full or disabled.');
  }
  listeners.forEach((fn) => fn(state));
}

// crypto.randomUUID only exists in secure contexts (HTTPS/localhost), so fall back on LAN HTTP.
export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

const clean = (v) => String(v ?? '').trim();

function normalize(item) {
  const out = { id: item.id || uid() };
  for (const f of ITEM_FIELDS) out[f] = clean(item[f]);
  out.img = clean(item.img);
  return out;
}

// Must come after the helpers above: load() uses them while migrating.
let state = load();

export const getState = () => state;
export const onChange = (fn) => listeners.push(fn);
export const getItem = (id) => state.items.find((i) => i.id === id);
export const peekNextCode = () => nextFreeCode(state).code;

export function saveItem(item) {
  const next = normalize(item);
  if (!next.code) next.code = assignCode(state);
  const i = state.items.findIndex((x) => x.id === next.id);
  if (i >= 0) state.items[i] = next; else state.items.push(next);
  commit();
  return next;
}

// stamps: { [itemId]: imgStamp }
export function setImageStamps(stamps) {
  for (const [id, stamp] of Object.entries(stamps)) {
    const item = getItem(id);
    if (item) item.img = stamp;
  }
  commit();
}

export function deleteItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  delete state.selected[id];
  commit();
}

// Merge CSV rows into inventory: match by ID (code) when present, otherwise by Name1.
export function importItems(rows) {
  let added = 0, updated = 0;
  const byCode = new Map(state.items.filter((i) => i.code).map((i) => [i.code.toLowerCase(), i]));
  const byName = new Map(state.items.map((i) => [i.name1.toLowerCase(), i]));
  for (const r of rows) {
    const existing = r.code ? byCode.get(r.code.toLowerCase()) : byName.get(r.name1.toLowerCase());
    if (existing) {
      Object.assign(existing, normalize({ ...existing, ...r, code: existing.code || r.code }));
      updated++;
    } else {
      const item = normalize({ ...r, name1: r.name1 || r.code });
      if (!item.code) item.code = assignCode(state);
      state.items.push(item);
      if (item.code) byCode.set(item.code.toLowerCase(), item);
      byName.set(item.name1.toLowerCase(), item);
      added++;
    }
  }
  commit();
  return { added, updated };
}

export function setSelectedQty(id, qty) {
  if (!getItem(id)) return;
  if (qty > 0) state.selected[id] = qty; else delete state.selected[id];
  commit();
}

export function clearSelected() {
  state.selected = {};
  commit();
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const localDate = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

// Order number = VENDOR-YYYYMMDD-NNN. The sequence restarts at 001 each day, is shared by
// all vendors, and never reuses a number (even if an order is deleted).
export function formatOrderNo(vendor, date, seq) {
  return `${clean(vendor)}-${date}-${pad(seq, 3)}`;
}

const nextSeq = (date) => (state.daySeq.date === date ? state.daySeq.n + 1 : 1);

// The numbers placeOrder() would give orders for these vendors, in this order.
export function previewOrderNos(vendors, now = new Date()) {
  const date = localDate(now);
  const first = nextSeq(date);
  return vendors.map((v, i) => formatOrderNo(v, date, first + i));
}

// Records the current selection as one order per vendor. vendorByItem: { [itemId]: vendor }.
// Lines without a vendor are left selected. Returns the new orders (empty if none).
export function placeOrder(vendorByItem) {
  const groups = new Map();
  for (const [itemId, qty] of Object.entries(state.selected)) {
    const it = getItem(itemId);
    const vendor = clean(vendorByItem[itemId]);
    if (!it || !(qty > 0) || !vendor) continue;
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push({
      itemId, code: it.code, brand: it.brand, name1: it.name1, name2: it.name2, size: it.size,
      orderUnit: it.orderUnit, vendor1: it.vendor1, vendor2: it.vendor2, qty,
    });
    delete state.selected[itemId];
  }
  const now = new Date();
  const date = localDate(now);
  const orders = [...groups.keys()].sort((a, b) => a.localeCompare(b)).map((vendor) => {
    const n = nextSeq(date);
    state.daySeq = { date, n };
    return { id: uid(), orderNo: formatOrderNo(vendor, date, n), vendor, createdAt: now.toISOString(), lines: groups.get(vendor) };
  });
  state.orders.unshift(...[...orders].reverse());
  if (orders.length) commit();
  return orders;
}

export function deleteOrder(id) {
  state.orders = state.orders.filter((o) => o.id !== id);
  commit();
}

// Adds an old order's lines back into the selection. Returns how many lines were
// skipped because the item no longer exists.
export function reorder(id) {
  const order = state.orders.find((o) => o.id === id);
  if (!order) return 0;
  let missing = 0;
  for (const l of order.lines) {
    if (getItem(l.itemId)) state.selected[l.itemId] = (state.selected[l.itemId] || 0) + l.qty;
    else missing++;
  }
  commit();
  return missing;
}

export function resetAll() {
  state = emptyState();
  commit();
}
