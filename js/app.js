import * as store from './store.js';
import { parseCSV, rowsToItems, toCSV } from './csv.js';
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

const TITLES = { inventory: 'Inventory', selected: 'Selected', history: 'Order History' };

// ---------- Tabs ----------

function showTab(tab) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  $('#title').textContent = TITLES[tab];
  $('#btn-add').hidden = tab !== 'inventory';
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
  $('#vendor-list').innerHTML = datalist(uniqueSorted(items.flatMap((i) => [i.vendor1, i.vendor2])));

  const q = $('#search').value.trim().toLowerCase();
  const matches = (i) => [i.name1, i.name2, i.remarks, i.vendor1, i.vendor2, i.code, i.brand]
    .some((v) => v.toLowerCase().includes(q));
  const shown = items
    .filter((i) => (!cat || i.category === cat) && (!q || matches(i)))
    .sort((a, b) => a.name1.localeCompare(b.name1));

  const list = $('#inventory-list');
  if (!items.length) {
    list.innerHTML = emptyState('No inventory yet', 'Tap + to add an item, or ⋯ → Import inventory from CSV.');
  } else if (!shown.length) {
    list.innerHTML = emptyState('No matches', 'Try a different search or category.');
  } else {
    list.innerHTML = shown.map((i) => `
      <li class="row" data-id="${esc(i.id)}">
        ${thumb(i)}
        <button class="row-main" data-action="edit">
          ${itemText(i.code, i.name1, [i.name2, i.size].filter(Boolean).join(' · '), joinDot([i.brand, i.category]))}
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
    <li class="row" data-id="${esc(item.id)}">
      ${thumb(item)}
      <div class="row-main">
        ${itemText(item.code, item.name1, [item.name2, item.size].filter(Boolean).join(' · '),
          joinDot([item.brand, item.orderUnit && `per ${item.orderUnit}`]))}
      </div>
      ${stepper(qty)}
    </li>`).join('');
  $('#selected-summary').textContent = selectionSummary(rows);
}

function renderHistory() {
  const { orders } = store.getState();
  const list = $('#history-list');
  if (!orders.length) {
    list.innerHTML = emptyState('No orders yet', 'Orders you place from the Selected tab show up here.');
    return;
  }
  list.innerHTML = orders.map((o) => {
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

function render() {
  renderInventory();
  renderSelected();
  renderHistory();
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
  for (const field of store.ITEM_FIELDS) itemForm.elements[field].value = item ? item[field] : '';
  itemForm.elements.code.placeholder = item ? '' : `Auto: ${store.peekNextCode()}`;
  resetPhoto();
  showPhoto(null);
  itemDialog.showModal();
  if (item?.img) showPhoto(await images.imageUrl(item.id, item.img));
}

$('#photo-preview').addEventListener('click', () => photoInput.click());

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  photoInput.value = '';
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
});

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

const orderDialog = $('#order-dialog');
const orderForm = $('#order-form');
const prefixInput = orderForm.elements.prefix;

function updateOrderPreview() {
  $('#order-preview').textContent = store.previewOrderNo(prefixInput.value.trim() || 'PREFIX');
}

$('#btn-place-order').addEventListener('click', () => {
  const rows = selectedRows();
  if (!rows.length) return;
  $('#order-summary').textContent = selectionSummary(rows);
  prefixInput.value = store.getState().lastPrefix;
  updateOrderPreview();
  orderDialog.showModal();
});

prefixInput.addEventListener('input', updateOrderPreview);
$('#btn-cancel-order').addEventListener('click', () => orderDialog.close());

orderForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const prefix = prefixInput.value.trim();
  if (!prefix) return prefixInput.focus();
  const order = store.placeOrder(prefix);
  orderDialog.close();
  if (order) {
    toast(`Order ${order.orderNo} recorded`);
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

$('#btn-clear-selected').addEventListener('click', () => {
  if (confirm('Clear all selected items?')) store.clearSelected();
});

// ---------- Menu: CSV import/export, reset ----------

const menuDialog = $('#menu-dialog');
const csvInput = $('#csv-input');
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
  ['Order No', 'Date', 'ID', 'Brand', 'Name1', 'Name2', 'Size', 'Qty', 'Order Unit', 'Vendor1', 'Vendor2'],
  orders.flatMap((o) => o.lines.map((l) => [
    o.orderNo, csvDate(o.createdAt), l.code, l.brand, l.name1, l.name2, l.size,
    l.qty, l.orderUnit, l.vendor1, l.vendor2,
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
      store.ITEM_FIELDS.map((f) => store.FIELD_LABELS[f]),
      items.map((i) => store.ITEM_FIELDS.map((f) => i[f])))));
  },
  // One ZIP of all photos named <ID>.jpg, so it can be re-imported with "Import photos".
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
  reset: () => {
    if (confirm('Erase ALL inventory, selections and order history on this device? This cannot be undone.')) {
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

// Matches each photo to an item by file name: "BOX-S.jpg" → item with ID BOX-S (or Name1 "BOX-S").
photosBulkInput.addEventListener('change', async () => {
  const files = [...photosBulkInput.files];
  photosBulkInput.value = '';
  if (!files.length) return;
  const { items } = store.getState();
  const byCode = new Map(items.filter((i) => i.code).map((i) => [i.code.toLowerCase(), i]));
  const byName = new Map(items.map((i) => [i.name1.toLowerCase(), i]));
  const stamps = {};
  const unmatched = [];
  toast(`Importing ${files.length} photo(s)…`);
  for (const file of files) {
    const base = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
    const item = byCode.get(base) || byName.get(base);
    if (!item) { unmatched.push(file.name); continue; }
    try {
      await images.putImage(item.id, await images.resizeImage(file));
      stamps[item.id] = images.newStamp();
    } catch {
      unmatched.push(file.name);
    }
  }
  store.setImageStamps(stamps);
  const done = Object.keys(stamps).length;
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
$('#btn-add').addEventListener('click', () => openItemDialog(null));
$('#search').addEventListener('input', () => { renderInventory(); loadThumbs(); });
$('#category-filter').addEventListener('change', () => { renderInventory(); loadThumbs(); });

store.onChange(render);
render();

// Ask the browser not to evict our localStorage under storage pressure.
navigator.storage?.persist?.();

// Service workers need HTTPS or localhost; on plain LAN HTTP this is skipped.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
}
