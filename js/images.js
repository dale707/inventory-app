// Product photos, stored as Blobs in IndexedDB keyed by item id (localStorage is too
// small for images). Items carry an `img` stamp that changes whenever their photo does.

const DB_NAME = 'inventoryapp';
const STORE = 'images';
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const putImage = (id, blob) => tx('readwrite', (s) => s.put(blob, id));
export const getImage = (id) => tx('readonly', (s) => s.get(id));

export async function deleteImage(id) {
  forget(id);
  await tx('readwrite', (s) => s.delete(id));
}

export async function clearImages() {
  [...urls.keys()].forEach(forget);
  await tx('readwrite', (s) => s.clear());
}

// Object URLs for display, cached per item id and invalidated when the stamp changes.
const urls = new Map();     // id -> { stamp, url }
const pending = new Map();  // `${id}:${stamp}` -> Promise<url|null>

export function cachedUrl(id, stamp) {
  const c = urls.get(id);
  return c && c.stamp === stamp ? c.url : null;
}

export function imageUrl(id, stamp) {
  const hit = cachedUrl(id, stamp);
  if (hit) return Promise.resolve(hit);
  const key = `${id}:${stamp}`;
  if (!pending.has(key)) {
    pending.set(key, getImage(id)
      .then((blob) => {
        if (!blob) return null;
        forget(id);
        const url = URL.createObjectURL(blob);
        urls.set(id, { stamp, url });
        return url;
      })
      .catch(() => null)
      .finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

function forget(id) {
  const c = urls.get(id);
  if (c) {
    URL.revokeObjectURL(c.url);
    urls.delete(id);
  }
}

// Phone photos are several MB; downscale to a JPEG no larger than `max` px on its long side.
export async function resizeImage(file, max = 800, quality = 0.8) {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs would otherwise turn black in JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(src);
  }
}

export const newStamp = () => Date.now().toString(36);
