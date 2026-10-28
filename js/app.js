import * as store from './store.js';
import { parseCSV, rowsToItems, rowsToVendors, toCSV } from './csv.js';
import * as images from './images.js';
import { makeZip } from './zip.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtQty = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, word) => `${fmtQty(n)} ${word}${n === 1 ? '' : 's'}`;
const joinDot = (parts) => parts.filter(Boolean).map(esc).join(' · ');
const uniqueSorted = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
const datalist = (values) => values.map((v) => `<option value="${esc(v)}">`).join('');

const TITLES = { inventory: 'Inventory', selected: 'Selected', history: 'Order History', vendors: 'Vendors' };

// Vendor pane keys besides real vendor names.
const ALL = '\uE000all';
const NONE = '\uE000none';
const view = { inventoryVendor: ALL, historyVendor: ALL, vendorKey: null }; // which vendor each pane shows

const itemVendors = (i) => (i.vendor ? [i.vendor] : []);
const inVendor = (vendors, key) =>
  key === ALL || (key === NONE ? !vendors.length : vendors.includes(key));
const vendorLabel = (key) => (key === ALL ? 'All' : key === NONE ? 'No vendor' : key);
// Every vendor name in use: on items, plus those with saved details.
const knownVendors = () => {
  const { items, vendors } = store.getState();
  return uniqueSorted([...items.map((i) => i.vendor), ...vendors.map((v) => v.name)]);
};

// ---------- Tabs ----------

let currentTab = 'inventory';

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  $('#title').textContent = TITLES[tab];
  $('#btn-add').hidden = tab !== 'inventory' && tab !== 'vendors';
  $('#btn-add').setAttribute('aria-label', tab === 'vendors' ? 'Add vendor' : 'Add item');
  window.scrollTo(0, 0);
}

// ---------- Rendering ----------

const emptyState = (title, text) => `<li class="empty"><strong>${esc(title)}</strong>${esc(text)}</li>`;

function stepper(qty) {
  return qty > 0
    ? `<div class="stepper">
         <button data-action="dec" aria-label="Decrease">−</button>
         <button class="qty-value" data-action="set-qty" aria-label="Set quantity">${fmtQty(qty)}</button>
         <button data-action="inc" aria-label="Increase">+</button>
       </div>`
    : `<button class="btn small" data-action="inc">Add</button>`;
}

const BOX_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/></svg>';

// Photo thumbnail; the src is filled in by loadThumbs() unless already cached.
function thumb(item) {
  if (!item.img) return `<span class="thumb">${BOX_ICON}</span>`;
  const url = images.cachedUrl(item.id, item.img);
  return `<button class="thumb" data-action="view-image" aria-label="View photo">
    <img data-img="${esc(item.id)}"${url ? ` src="${url}"` : ''} alt=""></button>`;
}

function loadThumbs() {
  document.querySelectorAll('img[data-img]:not([src])').forEach(async (el) => {
    const item = store.getItem(el.dataset.img);
    const url = item?.img && await images.imageUrl(item.id, item.img);
    if (url) el.src = url;
  });
}

// ID tag + Name1 as the title, Name2 below it, then a meta line.
function itemText(code, name1, name2, meta) {
  return `<span class="row-title">${code ? `<span class="row-id">${esc(code)}</span>` : ''}${esc(name1)}</span>
    ${name2 ? `<span class="row-sub">${esc(name2)}</span>` : ''}
    ${meta ? `<span class="row-sub2">${meta}</span>` : ''}`;
}

// Left-pane vendor list. groups: [{ key, count }]. Returns the key that is actually shown
// (falls back to All when the remembered vendor no longer exists).
function renderVendorPane(el, groups, current) {
  const key = groups.some((g) => g.key === current) ? current : ALL;
  el.innerHTML = groups.map((g) => `
    <button class="vendor${g.key === key ? ' active' : ''}${g.key === ALL || g.key === NONE ? ' special' : ''}"
      data-vendor="${esc(g.key)}" aria-pressed="${g.key === key}">
      <span>${esc(vendorLabel(g.key))}</span><b>${fmtQty(g.count)}</b>
    </button>`).join('');
  return key;
}

function vendorGroups(entries, all) {
  const vendors = uniqueSorted(entries.flatMap((e) => e.vendors));
  const count = (key) => entries.filter((e) => inVendor(e.vendors, key)).length;
  const groups = [{ key: ALL, count: count(ALL) }, ...vendors.map((v) => ({ key: v, count: count(v) }))];
  if (all.some((e) => !e.vendors.length)) groups.push({ key: NONE, count: count(NONE) });
  return groups;
}

// Empty values sort last; ties fall back to Name1, then ID.
const sortItems = (field) => (a, b) =>
  (!a[field] - !b[field]) || a[field].localeCompare(b[field]) ||
  a.name1.localeCompare(b.name1) || a.code.localeCompare(b.code, undefined, { numeric: true });

const DETAIL_FIELDS = [['brand', 'Brand'], ['category', 'Category'], ['size', 'Size'], ['orderUnit', 'Order Unit']];

// Labelled item fields shown in full in Inventory rows (Remarks on its own wrapping line).
function itemDetails(i, withVendor) {
  const fields = [...DETAIL_FIELDS, ...(withVendor ? [['vendor', 'Vendor']] : [])]
    .filter(([f]) => i[f])
    .map(([f, label]) => `<span class="detail"><span class="detail-label">${label}</span>${esc(i[f])}</span>`).join('');
  return (fields ? `<span class="details">${fields}</span>` : '') +
    (i.remarks ? `<span class="remarks"><span class="detail-label">Remarks</span>${esc(i.remarks)}</span>` : '');
}

function renderInventory() {
  const { items, selected } = store.getState();

  const cats = uniqueSorted(items.map((i) => i.category));
  const filter = $('#category-filter');
  const cat = cats.includes(filter.value) ? filter.value : '';
  filter.innerHTML = `<option value="">All categories</option>` +
    cats.map((c) => `<option${c === cat ? ' selected' : ''}>${esc(c)}</option>`).join('');
  $('#category-list').innerHTML = datalist(cats);
  $('#brand-list').innerHTML = datalist(uniqueSorted(items.map((i) => i.brand)));
  $('#unit-list').innerHTML = datalist(uniqueSorted(items.map((i) => i.orderUnit)));
  $('#vendor-list').innerHTML = datalist(knownVendors());

  const q = $('#search').value.trim().toLowerCase();
  const matches = (i) => [i.name1, i.name2, i.remarks, i.vendor, i.code, i.brand]
    .some((v) => v.toLowerCase().includes(q));
  const withVendors = (list) => list.map((i) => ({ item: i, vendors: itemVendors(i) }));
  // Vendor counts follow the search/category filter, so it's clear where the matches are.
  const filtered = withVendors(items.filter((i) => (!cat || i.category === cat) && (!q || matches(i))));
  const vendor = view.inventoryVendor =
    renderVendorPane($('#inventory-vendors'), vendorGroups(filtered, withVendors(items)), view.inventoryVendor);
  const shown = filtered
    .filter((e) => inVendor(e.vendors, vendor))
    .map((e) => e.item)
    .sort(sortItems($('#sort-by').value));

  $('#inventory-heading').textContent = items.length ? `${vendorLabel(vendor)} · ${plural(shown.length, 'item')}` : '';
  const list = $('#inventory-list');
  if (!items.length) {
    list.innerHTML = emptyState('No inventory yet', 'Tap + to add an item, or ⋯ → Import inventory from CSV.');
  } else if (!shown.length) {
    list.innerHTML = emptyState('No matches', 'Try a different vendor, search or category.');
  } else {
    list.innerHTML = shown.map((i) => `
      <li class="row${i.noMore ? ' no-more' : ''}" data-id="${esc(i.id)}">
        ${thumb(i)}
        <button class="row-main" data-action="edit">
          ${itemText(i.code, i.name1, i.name2, '')}
          ${itemDetails(i, vendor === ALL)}
        </button>
        ${stepper(selected[i.id] || 0)}
      </li>`).join('');
  }
}

function selectedRows() {
  return Object.entries(store.getState().selected)
    .map(([id, qty]) => ({ item: store.getItem(id), qty }))
    .filter((r) => r.item)
    .sort((a, b) => a.item.name1.localeCompare(b.item.name1));
}

const selectionSummary = (rows) =>
  `${plural(rows.length, 'item')} · ${plural(rows.reduce((s, r) => s + r.qty, 0), 'unit')}`;

function renderSelected() {
  const rows = selectedRows();
  const list = $('#selected-list');
  const badge = $('#selected-badge');

  badge.hidden = rows.length === 0;
  badge.textContent = rows.length;
  $('#selected-footer').hidden = rows.length === 0;

  if (!rows.length) {
    list.innerHTML = emptyState('Nothing selected', 'Tap “Add” on items in the Inventory tab.');
    return;
  }
  list.innerHTML = rows.map(({ item, qty }) => `
    <li class="row${item.noMore ? ' no-more' : ''}" data-id="${esc(item.id)}">
      ${thumb(item)}
      <div class="row-main">
        ${itemText(item.code, item.name1, [item.name2, item.size].filter(Boolean).join(' · '),
          joinDot([item.brand, item.orderUnit && `per ${item.orderUnit}`, item.vendor]))}
      </div>
      ${stepper(qty)}
    </li>`).join('');
  $('#selected-summary').textContent = selectionSummary(rows);
}

function renderHistory() {
  const { orders } = store.getState();
  const list = $('#history-list');
  const entries = orders.map((o) => ({ order: o, vendors: o.vendor ? [o.vendor] : [] }));
  const vendor = view.historyVendor =
    renderVendorPane($('#history-vendors'), vendorGroups(entries, entries), view.historyVendor);
  const shown = entries.filter((e) => inVendor(e.vendors, vendor)).map((e) => e.order);
  $('#history-heading').textContent = orders.length ? `${vendorLabel(vendor)} · ${plural(shown.length, 'order')}` : '';
  if (!orders.length) {
    list.innerHTML = emptyState('No orders yet', 'Orders you place from the Selected tab show up here.');
    return;
  }
  list.innerHTML = shown.map((o) => {
    const units = o.lines.reduce((s, l) => s + l.qty, 0);
    return `<li class="order" data-id="${esc(o.id)}">
      <details>
        <summary>
          <span class="row-title">${esc(o.orderNo)}</span>
          <span class="row-sub">${esc(fmtDate(o.createdAt))} · ${plural(o.lines.length, 'item')} · ${plural(units, 'unit')}</span>
        </summary>
        <ul class="order-lines">
          ${o.lines.map((l) => `<li>
            <span>${esc(l.name1)}${l.name2 || l.size ? ` <small>${joinDot([l.name2, l.size])}</small>` : ''}
              ${l.code || l.brand ? `<br><small>${joinDot([l.code, l.brand])}</small>` : ''}</span>
            <span class="line-qty">${fmtQty(l.qty)}${l.orderUnit ? ' × ' + esc(l.orderUnit) : ''}</span>
          </li>`).join('')}
        </ul>
        <div class="order-actions">
          <button class="btn danger" data-action="delete-order">Delete</button>
          <span class="spacer"></span>
          <button class="btn" data-action="export-order">Export</button>
          <button class="btn" data-action="reorder">Reorder</button>
        </div>
      </details>
    </li>`;
  }).join('');
}

// ---------- Vendors tab ----------

// Left: every vendor (with saved details, or only named on items/orders). Right: the chosen
// vendor's details as an editable form. view.vendorKey is the lower-cased name, or NEW_KEY.
const NEW_KEY = '\uE000new';
const vendorForm = $('#vendor-form');
let vendorFormKey = null; // which vendor the form holds
let vendorDirty = false;  // unsaved edits in the form

// [{ key, name, record, count }] sorted by name; count = items under that vendor.
function vendorEntries() {
  const { items, orders, vendors } = store.getState();
  const byKey = new Map();
  const add = (name, record) => {
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { key, name, record: null, count: 0 });
    if (record) Object.assign(byKey.get(key), { name, record });
  };
  vendors.forEach((v) => add(v.name, v));
  items.forEach((i) => i.vendor && add(i.vendor));
  orders.forEach((o) => o.vendor && add(o.vendor));
  items.forEach((i) => { if (i.vendor) byKey.get(i.vendor.toLowerCase()).count++; });
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function fillVendorForm(entry) {
  for (const f of store.VENDOR_FIELDS) vendorForm.elements[f].value = entry?.record?.[f] ?? '';
  if (entry && !entry.record) vendorForm.elements.name.value = entry.name;
  vendorFormKey = view.vendorKey;
  vendorDirty = false;
}

function renderVendors() {
  const entries = vendorEntries();
  if (!entries.some((e) => e.key === view.vendorKey) && view.vendorKey !== NEW_KEY) {
    view.vendorKey = entries[0]?.key ?? NEW_KEY;
  }
  const entry = entries.find((e) => e.key === view.vendorKey);
  const q = $('#vendor-search').value.trim().toLowerCase();
  const shown = !q ? entries : entries.filter((e) =>
    [e.name, ...(e.record ? store.VENDOR_FIELDS.map((f) => e.record[f]) : [])].some((v) => v.toLowerCase().includes(q)));
  $('#vendor-pane').innerHTML = shown.map((e) => `
    <button class="vendor${e.key === view.vendorKey ? ' active' : ''}${e.record ? '' : ' no-details'}"
      data-vendor="${esc(e.key)}" aria-pressed="${e.key === view.vendorKey}">
      <span>${esc(e.name)}</span><b>${fmtQty(e.count)}</b>
    </button>`).join('') ||
    (q ? '<p class="pane-empty">No matches</p>' : '');

  $('#vendor-heading').textContent = !entry ? 'New vendor'
    : `${entry.name} · ${plural(entry.count, 'item')}${entry.record ? '' : ' · no details saved yet'}`;
  $('#btn-delete-vendor').hidden = !entry?.record;
  $('#btn-vendor-items').hidden = !entry?.count;
  // Keep what's being typed; otherwise show the latest saved details (e.g. after an import).
  if (vendorFormKey !== view.vendorKey || !vendorDirty) fillVendorForm(entry);
}

const confirmDiscardVendor = () =>
  !vendorDirty || confirm('Discard unsaved changes to this vendor?');

function selectVendor(key) {
  if (key === view.vendorKey) return true;
  if (!confirmDiscardVendor()) return false;
  view.vendorKey = key;
  vendorDirty = false;
  renderVendors();
  return true;
}

vendorForm.addEventListener('input', () => { vendorDirty = true; });

$('#vendor-pane').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-vendor]');
  if (btn && selectVendor(btn.dataset.vendor)) window.scrollTo(0, 0);
});

$('#vendor-search').addEventListener('input', renderVendors);

vendorForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const entry = vendorEntries().find((x) => x.key === vendorFormKey);
  const values = { id: entry?.record?.id };
  for (const f of store.VENDOR_FIELDS) values[f] = vendorForm.elements[f].value;
  const renamed = entry && entry.name !== values.name.trim() && entry.count;
  if (renamed && !confirm(`Rename “${entry.name}” to “${values.name.trim()}” on its ${plural(entry.count, 'item')} and orders too?`)) return;
  const result = store.saveVendor(values, entry?.name);
  if (result.error) {
    alert(result.error);
    return vendorForm.elements.name.focus();
  }
  vendorDirty = false;
  view.vendorKey = result.vendor.name.toLowerCase();
  vendorFormKey = null; // refill from the saved record
  render();
  toast(`Saved ${result.vendor.name}`);
});

$('#btn-revert-vendor').addEventListener('click', () => {
  vendorDirty = false;
  vendorFormKey = null;
  renderVendors();
});

$('#btn-delete-vendor').addEventListener('click', () => {
  const entry = vendorEntries().find((x) => x.key === view.vendorKey);
  if (!entry?.record) return;
  const kept = entry.count ? ` Its ${plural(entry.count, 'item')} and orders are kept (⋯ → Delete a vendor's data… removes those).` : '';
  if (!confirm(`Delete the details of “${entry.name}”?${kept}`)) return;
  vendorDirty = false;
  store.deleteVendor(entry.record.id);
  toast('Vendor details deleted');
});

$('#btn-vendor-items').addEventListener('click', () => {
  const entry = vendorEntries().find((x) => x.key === view.vendorKey);
  const vendor = entry && store.getState().items.find((i) => i.vendor.toLowerCase() === entry.key)?.vendor;
  if (!vendor) return;
  view.inventoryVendor = vendor;
  render();
  showTab('inventory');
});

function render() {
  renderInventory();
  renderSelected();
  renderHistory();
  renderVendors();
  loadThumbs();
}

// ---------- Toast ----------

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ---------- Item add/edit dialog ----------

const itemDialog = $('#item-dialog');
const itemForm = $('#item-form');
let editingId = null;

// Photo changes in the dialog are only applied on Save.
const photoInput = $('#photo-input');
const photoImg = $('#photo-preview img');
let photo = { blob: null, removed: false, tempUrl: null };

function showPhoto(url) {
  photoImg.hidden = !url;
  if (url) photoImg.src = url; else photoImg.removeAttribute('src');
  $('#photo-preview span').hidden = !!url;
  $('#btn-photo-remove').hidden = !url;
}

function resetPhoto() {
  if (photo.tempUrl) URL.revokeObjectURL(photo.tempUrl);
  photo = { blob: null, removed: false, tempUrl: null };
}

async function openItemDialog(id) {
  const item = id ? store.getItem(id) : null;
  editingId = item?.id ?? null;
  $('#item-dialog-title').textContent = item ? 'Edit Item' : 'Add Item';
  $('#btn-delete-item').hidden = !item;
  $('#btn-copy-item').hidden = !item;
  for (const field of store.ITEM_FIELDS) itemForm.elements[field].value = item ? item[field] : '';
  itemForm.elements.noMore.checked = !!item?.noMore;
  const v = view.inventoryVendor;
  if (!item && v !== ALL && v !== NONE) itemForm.elements.vendor.value = v;
  itemForm.elements.code.placeholder = item ? '' : `Auto: ${store.peekNextCode()}`;
  resetPhoto();
  showPhoto(null);
  itemDialog.showModal();
  if (item?.img) showPhoto(await images.imageUrl(item.id, item.img));
}

// "Take photo" uses an input with capture="environment", which opens the camera directly on
// phones/iPads; "Choose photo" (and tapping the preview) opens the photo library/files.
const cameraInput = $('#camera-input');
$('#photo-preview').addEventListener('click', () => photoInput.click());
$('#btn-photo-library').addEventListener('click', () => photoInput.click());
$('#btn-photo-camera').addEventListener('click', () => cameraInput.click());

async function onPhotoPicked(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const blob = await images.resizeImage(file);
    resetPhoto();
    photo.blob = blob;
    photo.tempUrl = URL.createObjectURL(blob);
    showPhoto(photo.tempUrl);
  } catch {
    alert('That file could not be read as an image.');
  }
}
photoInput.addEventListener('change', () => onPhotoPicked(photoInput));
cameraInput.addEventListener('change', () => onPhotoPicked(cameraInput));

$('#btn-photo-remove').addEventListener('click', () => {
  resetPhoto();
  photo.removed = true;
  showPhoto(null);
});

itemDialog.addEventListener('close', resetPhoto);

itemForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = itemForm.elements;
  const id = editingId ?? store.uid();
  const values = { id, img: store.getItem(id)?.img ?? '' };
  for (const field of store.ITEM_FIELDS) values[field] = f[field].value;
  values.noMore = f.noMore.checked;
  const dup = values.code && store.findDuplicate(values.code, values.vendor, id);
  if (dup) {
    alert(`${dup.vendor ? `Vendor “${dup.vendor}”` : 'The “No vendor” list'} already has an item with ID ${dup.code} (“${dup.name1}”).`);
    return f.vendor.focus();
  }
  try {
    if (photo.blob) {
      await images.putImage(id, photo.blob);
      values.img = images.newStamp();
    } else if (photo.removed && values.img) {
      await images.deleteImage(id);
      values.img = '';
    }
  } catch (err) {
    alert(`Could not save the photo (${err?.message || err}). Storage may be full.`);
    return;
  }
  const saved = store.saveItem(values);
  itemDialog.close();
  toast(`${editingId ? 'Updated' : 'Added'} ${saved.code} “${saved.name1}”`);
});

$('#btn-cancel-item').addEventListener('click', () => itemDialog.close());

$('#btn-delete-item').addEventListener('click', () => {
  const item = store.getItem(editingId);
  if (item && confirm(`Delete “${item.name1}”? Past orders keep their copy of it.`)) {
    store.deleteItem(item.id);
    images.deleteImage(item.id).catch(() => {});
    itemDialog.close();
    toast('Item deleted');
  }
});

// ---------- Copy item to another vendor ----------

const copyDialog = $('#copy-dialog');
const copyForm = $('#copy-form');

async function copyPhoto(fromId, toId) {
  const blob = await images.getImage(fromId);
  if (!blob) return;
  await images.putImage(toId, blob);
  store.setImageStamps({ [toId]: images.newStamp() });
}

$('#btn-copy-item').addEventListener('click', () => {
  const item = store.getItem(editingId);
  if (!item) return;
  const { items } = store.getState();
  const taken = new Set(items.filter((i) => i.code === item.code).map((i) => i.vendor.toLowerCase()));
  $('#copy-vendor-list').innerHTML = datalist(knownVendors().filter((v) => !taken.has(v.toLowerCase())));
  $('#copy-summary').innerHTML = `<span class="row-id">${esc(item.code)}</span>${esc(item.name1)}` +
    (item.vendor ? ` — now under ${esc(item.vendor)}` : '');
  copyForm.elements.vendor.value = '';
  copyDialog.showModal();
});

$('#btn-cancel-copy').addEventListener('click', () => copyDialog.close());

copyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const vendor = copyForm.elements.vendor.value.trim();
  const item = store.getItem(editingId);
  if (!vendor || !item) return;
  const copy = store.copyItemToVendor(item.id, vendor);
  if (!copy) return alert(`“${vendor}” already has an item with ID ${item.code}.`);
  copyDialog.close();
  itemDialog.close();
  if (item.img) await copyPhoto(item.id, copy.id).catch(() => toast('Copied, but the photo could not be copied'));
  view.inventoryVendor = copy.vendor;
  render();
  toast(`Copied ${copy.code} “${copy.name1}” to ${copy.vendor}`);
});

// ---------- Full-size photo ----------

const imageDialog = $('#image-dialog');
let viewingId = null;

async function viewImage(id) {
  const item = store.getItem(id);
  const url = item?.img && await images.imageUrl(item.id, item.img);
  if (!url) return;
  viewingId = id;
  imageDialog.querySelector('img').src = url;
  imageDialog.showModal();
}

imageDialog.addEventListener('click', (e) => {
  if (e.target === imageDialog || e.target.tagName === 'IMG') imageDialog.close();
});
$('#btn-close-photo').addEventListener('click', () => imageDialog.close());
$('#btn-save-photo').addEventListener('click', async () => {
  const item = store.getItem(viewingId);
  const blob = item && await images.getImage(item.id);
  if (blob) saveFile(`${safeFileName(item.code || item.name1)}.jpg`, blob);
});

// ---------- Place order dialog ----------

// Each selected line gets a vendor (default: the item's own). Lines are grouped into one
// order per vendor.
const orderDialog = $('#order-dialog');
const orderForm = $('#order-form');
const vendorAll = $('#order-vendor-all');
const NEW_VENDOR = '\uE000new';
let orderVendors = []; // every known vendor, plus any typed in this dialog

const vendorOptions = (own, value) => {
  const opt = (v) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(v)}</option>`;
  const others = orderVendors.filter((v) => !own.includes(v));
  return (value ? '' : '<option value="" selected disabled>Choose vendor…</option>') +
    own.map(opt).join('') +
    (others.length ? `<optgroup label="${own.length ? 'Other vendors' : 'Vendors'}">${others.map(opt).join('')}</optgroup>` : '') +
    `<option value="${NEW_VENDOR}">New vendor…</option>`;
};

const lineSelects = () => [...orderDialog.querySelectorAll('#order-lines select')];

function setLineVendor(sel, vendor) {
  const item = store.getItem(sel.closest('[data-id]').dataset.id);
  sel.innerHTML = vendorOptions(itemVendors(item), vendor);
  sel.dataset.prev = vendor;
}

function askNewVendor() {
  const name = prompt('New vendor name')?.trim();
  if (name && !orderVendors.includes(name)) orderVendors = uniqueSorted([...orderVendors, name]);
  return name || '';
}

function updateOrderPreview() {
  vendorAll.innerHTML = '<option value="" selected>Choose…</option>' +
    orderVendors.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('') +
    `<option value="${NEW_VENDOR}">New vendor…</option>`;
  const counts = new Map();
  let unassigned = 0;
  for (const sel of lineSelects()) {
    if (sel.value) counts.set(sel.value, (counts.get(sel.value) || 0) + 1); else unassigned++;
  }
  const vendors = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const nos = store.previewOrderNos(vendors);
  $('#order-preview').innerHTML = vendors.map((v, i) =>
    `<li><strong>${esc(nos[i])}</strong><span>${plural(counts.get(v), 'item')}</span></li>`).join('') +
    (unassigned ? `<li class="warn">${plural(unassigned, 'item')} without a vendor</li>` : '');
}

$('#btn-place-order').addEventListener('click', () => {
  const rows = selectedRows();
  if (!rows.length) return;
  orderVendors = knownVendors();
  $('#order-summary').textContent = selectionSummary(rows);
  $('#order-lines').innerHTML = rows.map(({ item, qty }) => `
    <li data-id="${esc(item.id)}">
      <span class="assign-item">${item.code ? `<span class="row-id">${esc(item.code)}</span>` : ''}${esc(item.name1)}
        <small>Qty ${fmtQty(qty)}${item.orderUnit ? ' × ' + esc(item.orderUnit) : ''}</small></span>
      <select aria-label="Vendor for ${esc(item.name1)}"></select>
    </li>`).join('');
  for (const sel of lineSelects()) setLineVendor(sel, store.getItem(sel.closest('[data-id]').dataset.id).vendor);
  updateOrderPreview();
  orderDialog.showModal();
});

orderForm.addEventListener('change', (e) => {
  const sel = e.target;
  if (sel === vendorAll) {
    const v = sel.value === NEW_VENDOR ? askNewVendor() : sel.value;
    if (v) lineSelects().forEach((s) => setLineVendor(s, v));
  } else if (sel.matches('#order-lines select')) {
    if (sel.value === NEW_VENDOR) {
      const v = askNewVendor();
      setLineVendor(sel, v || sel.dataset.prev);
    } else {
      sel.dataset.prev = sel.value;
    }
  }
  updateOrderPreview();
});

$('#btn-cancel-order').addEventListener('click', () => orderDialog.close());

orderForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const missing = lineSelects().find((s) => !s.value);
  if (missing) {
    toast('Choose a vendor for every item');
    return missing.focus();
  }
  const vendorByItem = Object.fromEntries(lineSelects().map((s) => [s.closest('[data-id]').dataset.id, s.value]));
  const orders = store.placeOrder(vendorByItem);
  orderDialog.close();
  if (orders.length) {
    view.historyVendor = orders.length === 1 ? orders[0].vendor : ALL;
    toast(orders.length === 1 ? `Order ${orders[0].orderNo} recorded` : `${orders.length} orders recorded`);
    render();
    showTab('history');
  }
});

// ---------- List interactions ----------

function onListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.closest('[data-id]')?.dataset.id;
  const current = store.getState().selected[id] || 0;

  switch (btn.dataset.action) {
    case 'inc':
      store.setSelectedQty(id, current + 1);
      break;
    case 'dec':
      store.setSelectedQty(id, current - 1);
      break;
    case 'set-qty': {
      const input = prompt('Quantity', current);
      if (input === null) break;
      const n = Number(input);
      if (Number.isFinite(n) && n >= 0) store.setSelectedQty(id, n);
      else alert('Please enter a number of 0 or more.');
      break;
    }
    case 'edit':
      openItemDialog(id);
      break;
    case 'view-image':
      viewImage(id);
      break;
    case 'reorder': {
      const missing = store.reorder(id);
      toast(missing ? `Added to Selected (${missing} item(s) no longer exist)` : 'Added to Selected');
      break;
    }
    case 'export-order': {
      const order = store.getState().orders.find((o) => o.id === id);
      if (order) saveFile(`${safeFileName(order.orderNo)}.csv`, ordersCsv([order]));
      break;
    }
    case 'delete-order':
      if (confirm('Delete this order from history?')) store.deleteOrder(id);
      break;
  }
}

['#inventory-list', '#selected-list', '#history-list'].forEach((sel) =>
  $(sel).addEventListener('click', onListClick));

[['#inventory-vendors', 'inventoryVendor'], ['#history-vendors', 'historyVendor']].forEach(([sel, key]) =>
  $(sel).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vendor]');
    if (!btn) return;
    view[key] = btn.dataset.vendor;
    render();
    window.scrollTo(0, 0);
  }));

$('#btn-clear-selected').addEventListener('click', () => {
  if (confirm('Clear all selected items?')) store.clearSelected();
});

// ---------- Menu: CSV import/export, reset ----------

const menuDialog = $('#menu-dialog');
const csvInput = $('#csv-input');
const vendorCsvInput = $('#vendor-csv-input');
const photosBulkInput = $('#photos-bulk-input');


// Excel needs the BOM to read UTF-8 correctly.
const csvBlob = (text) => new Blob(['\uFEFF' + text], { type: 'text/csv' });

// Local time as "YYYY-MM-DD HH:MM", which Excel recognises as a date.
const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const csvDate = (iso) => {
  const d = new Date(iso);
  return `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const today = () => localDay(new Date()); // for export file names

const ordersCsv = (orders) => csvBlob(toCSV(
  ['Order No', 'Vendor', 'Date', 'ID', 'Brand', 'Name1', 'Name2', 'Size', 'Qty', 'Order Unit'],
  orders.flatMap((o) => o.lines.map((l) => [
    o.orderNo, o.vendor, csvDate(o.createdAt), l.code, l.brand, l.name1, l.name2, l.size,
    l.qty, l.orderUnit,
  ]))));

const safeFileName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'photo';

async function saveFile(filename, blob) {
  const file = new File([blob], filename, { type: blob.type });
  // On phones the share sheet ("Save to Files", Drive, email...) is more reliable than a download.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const menuActions = {
  import: () => csvInput.click(),
  'import-photos': () => {
    if (!store.getState().items.length) return toast('Add or import items first');
    photosBulkInput.click();
  },
  'export-inventory': () => {
    const { items } = store.getState();
    if (!items.length) return toast('No inventory to export');
    saveFile(`inventory-${today()}.csv`, csvBlob(toCSV(
      [...store.ITEM_FIELDS.map((f) => store.FIELD_LABELS[f]), store.NO_MORE_LABEL],
      items.map((i) => [...store.ITEM_FIELDS.map((f) => i[f]), i.noMore ? 'Yes' : 'No']))));
  },
  // One ZIP of all photos named <ID>.jpg, so it can be re-imported with "Import photos".
  // Copies of an item under other vendors share its ID, so only the first photo per ID is kept.
  'export-photos': async () => {
    const withPhotos = store.getState().items.filter((i) => i.img);
    if (!withPhotos.length) return toast('No photos to export');
    toast(`Preparing ${withPhotos.length} photo(s)…`);
    const used = new Set();
    const files = [];
    for (const item of withPhotos) {
      const blob = await images.getImage(item.id).catch(() => null);
      if (!blob) continue;
      const base = safeFileName(item.code || item.name1);
      if (item.code && used.has(`${base}.jpg`.toLowerCase())) continue;
      let name = `${base}.jpg`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.jpg`;
      used.add(name.toLowerCase());
      files.push({ name, blob });
    }
    saveFile(`photos-${today()}.zip`, await makeZip(files));
  },
  'export-orders': () => {
    const { orders } = store.getState();
    if (!orders.length) return toast('No orders to export');
    saveFile(`orders-${today()}.csv`, ordersCsv(orders));
  },
  'import-vendors': () => vendorCsvInput.click(),
  'export-vendors': () => {
    const { vendors } = store.getState();
    if (!vendors.length) return toast('No vendor details to export');
    const sorted = [...vendors].sort((a, b) => a.name.localeCompare(b.name));
    saveFile(`vendors-${today()}.csv`, csvBlob(toCSV(
      store.VENDOR_FIELDS.map((f) => store.VENDOR_LABELS[f]),
      sorted.map((v) => store.VENDOR_FIELDS.map((f) => v[f])))));
  },
  storage: async () => {
    const persisted = await requestPersistentStorage();
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    const lines = [
      persisted
        ? '✓ Persistent storage is on: the browser will not clear this data to free up space.'
        : '✗ Persistent storage was not granted, so the browser may clear this data when space runs low or the app goes unused.',
      isInstalled()
        ? '✓ Running from the Home Screen.'
        : '✗ Not running from the Home Screen. In Safari, tap Share → Add to Home Screen and open it from there: Safari deletes data of websites that aren\'t used for 7 days, but not of Home Screen apps.',
    ];
    if (est?.usage != null) lines.push(`Using ${mb(est.usage)}${est.quota ? ` of ${mb(est.quota)}` : ''}.`);
    lines.push('Tip: export inventory, photos, order history and vendors now and then as a backup.');
    alert(lines.join('\n\n'));
  },
  'delete-vendor': () => {
    const { items, orders } = store.getState();
    const vendors = uniqueSorted([...items.map((i) => i.vendor), ...orders.map((o) => o.vendor)]);
    const keys = items.some((i) => !i.vendor) ? [...vendors, NONE] : vendors;
    if (!keys.length) return toast('No vendor data to delete');
    const select = vendorDeleteForm.elements.vendor;
    select.innerHTML = keys.map((k) => `<option value="${esc(k)}">${esc(vendorLabel(k))}</option>`).join('');
    // Start on the vendor the Inventory pane is showing, if it's a real one.
    if (keys.includes(view.inventoryVendor)) select.value = view.inventoryVendor;
    vendorDeleteForm.elements.items.checked = vendorDeleteForm.elements.orders.checked = true;
    updateVendorDeleteCounts();
    vendorDeleteDialog.showModal();
  },
  reset: () => {
    if (confirm('Erase ALL inventory, selections, order history and vendors on this device? This cannot be undone.')) {
      store.resetAll();
      images.clearImages().catch(() => {});
      toast('All data erased');
    }
  },
  close: () => {},
};

$('#btn-menu').addEventListener('click', () => menuDialog.showModal());
menuDialog.addEventListener('click', (e) => {
  if (e.target === menuDialog) return menuDialog.close(); // tap on backdrop
  const action = e.target.closest('[data-menu]')?.dataset.menu;
  if (!action) return;
  menuDialog.close();
  menuActions[action]();
});

// ---------- Delete one vendor's data ----------

const vendorDeleteDialog = $('#vendor-delete-dialog');
const vendorDeleteForm = $('#vendor-delete-form');
const vendorOf = (key) => (key === NONE ? '' : key);

function updateVendorDeleteCounts() {
  const vendor = vendorOf(vendorDeleteForm.elements.vendor.value);
  const { items, orders } = store.getState();
  $('#vendor-delete-items').textContent = `Inventory items (${items.filter((i) => i.vendor === vendor).length})`;
  $('#vendor-delete-orders').textContent = `Order history (${plural(orders.filter((o) => o.vendor === vendor).length, 'order')})`;
}

vendorDeleteForm.elements.vendor.addEventListener('change', updateVendorDeleteCounts);
$('#btn-cancel-vendor-delete').addEventListener('click', () => vendorDeleteDialog.close());

vendorDeleteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = vendorDeleteForm.elements;
  const key = f.vendor.value;
  const opts = { items: f.items.checked, orders: f.orders.checked };
  if (!opts.items && !opts.orders) return alert('Tick what to delete.');
  const what = [opts.items && 'inventory items', opts.orders && 'order history'].filter(Boolean).join(' and ');
  if (!confirm(`Delete all ${what} of “${vendorLabel(key)}”? This cannot be undone.`)) return;
  const gone = store.deleteVendorData(vendorOf(key), opts);
  gone.forEach((id) => images.deleteImage(id).catch(() => {}));
  vendorDeleteDialog.close();
  toast(`Deleted ${vendorLabel(key)}'s ${what}`);
});

csvInput.addEventListener('change', async () => {
  const file = csvInput.files[0];
  csvInput.value = '';
  if (!file) return;
  const result = rowsToItems(parseCSV(await file.text()));
  if (result.error) return alert(result.error);
  if (!result.items.length) return alert('No items found in the file.');
  const skippedNote = result.skipped ? `\n${result.skipped} row(s) without Name1 or ID will be skipped.` : '';
  if (!confirm(`Import ${result.items.length} item(s)?\nItems with a matching ID (or Name1, if no ID) are updated; others are added.${skippedNote}`)) return;
  const { added, updated } = store.importItems(result.items);
  toast(`Imported: ${added} added, ${updated} updated`);
});

vendorCsvInput.addEventListener('change', async () => {
  const file = vendorCsvInput.files[0];
  vendorCsvInput.value = '';
  if (!file) return;
  const result = rowsToVendors(parseCSV(await file.text()));
  if (result.error) return alert(result.error);
  if (!result.vendors.length) return alert('No vendors found in the file.');
  const skippedNote = result.skipped ? `\n${result.skipped} row(s) without a Vendor Name will be skipped.` : '';
  if (!confirm(`Import ${result.vendors.length} vendor(s)?\nVendors with a matching name are updated; others are added.${skippedNote}`)) return;
  vendorDirty = false;
  const { added, updated } = store.importVendors(result.vendors);
  toast(`Imported: ${added} added, ${updated} updated`);
});

// Matches each photo to items by file name: "BOX-S.jpg" → every item with ID BOX-S (all
// vendors), or else Name1 "BOX-S".
photosBulkInput.addEventListener('change', async () => {
  const files = [...photosBulkInput.files];
  photosBulkInput.value = '';
  if (!files.length) return;
  const { items } = store.getState();
  const group = (key) => items.reduce((m, i) => m.set(key(i), [...(m.get(key(i)) || []), i]), new Map());
  const byCode = group((i) => i.code.toLowerCase());
  const byName = group((i) => i.name1.toLowerCase());
  const stamps = {};
  const unmatched = [];
  toast(`Importing ${files.length} photo(s)…`);
  for (const file of files) {
    const base = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
    const matched = byCode.get(base) || byName.get(base);
    if (!matched) { unmatched.push(file.name); continue; }
    try {
      const blob = await images.resizeImage(file);
      for (const item of matched) {
        await images.putImage(item.id, blob);
        stamps[item.id] = images.newStamp();
      }
    } catch {
      unmatched.push(file.name);
    }
  }
  store.setImageStamps(stamps);
  const done = files.length - unmatched.length;
  if (unmatched.length) {
    const shown = unmatched.slice(0, 10).join('\n');
    const more = unmatched.length > 10 ? `\n…and ${unmatched.length - 10} more` : '';
    alert(`${done} photo(s) added.\n\nThese didn't match any item ID or Name1 (or couldn't be read):\n${shown}${more}`);
  } else {
    toast(`${done} photo(s) added`);
  }
});

// ---------- Startup ----------

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#btn-add').addEventListener('click', () => {
  if (currentTab !== 'vendors') return openItemDialog(null);
  if (selectVendor(NEW_KEY)) vendorForm.elements.name.focus();
});
$('#search').addEventListener('input', () => { renderInventory(); loadThumbs(); });
$('#category-filter').addEventListener('change', () => { renderInventory(); loadThumbs(); });

const SORT_KEY = 'inventoryapp.sort'; // per-device convenience only
const sortBy = $('#sort-by');
try { sortBy.value = localStorage.getItem(SORT_KEY) || 'name1'; } catch {}
if (!sortBy.value) sortBy.value = 'name1';
sortBy.addEventListener('change', () => {
  try { localStorage.setItem(SORT_KEY, sortBy.value); } catch {}
  renderInventory();
  loadThumbs();
});

// Items split per vendor by migrate() still need their photo copied.
for (const { from, to } of store.takePendingPhotoCopies()) copyPhoto(from, to).catch(() => {});

store.onChange(render);
render();

// Ask the browser to keep our data (localStorage + IndexedDB photos) instead of evicting it
// under storage pressure. Some browsers only grant this after a user gesture or once the app
// is on the Home Screen, so ask again on the first tap of each launch if it was refused.
async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

const isInstalled = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

requestPersistentStorage().then((ok) => {
  if (!ok) document.addEventListener('pointerdown', requestPersistentStorage, { once: true });
});

// Service workers need HTTPS or localhost; on plain LAN HTTP this is skipped.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
}
