// Barcode scanning with the camera, using ZXing (js/vendor/zxing.min.js, loaded on first use —
// Safari has no BarcodeDetector). Live video needs getUserMedia, which only exists on HTTPS or
// localhost; without it, or if the camera can't start, the dialog offers to take a photo of the
// barcode instead and decodes that.

import { resizeImage } from './images.js';

let zxingLoad = null;
function loadZXing() {
  zxingLoad ??= new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src: 'js/vendor/zxing.min.js' });
    s.onload = () => resolve(window.ZXing);
    s.onerror = () => {
      zxingLoad = null;
      s.remove();
      reject(new Error('Could not load the barcode scanner'));
    };
    document.head.append(s);
  });
  return zxingLoad;
}

const dialog = document.getElementById('scan-dialog');
const video = dialog.querySelector('video');
const status = dialog.querySelector('.scan-status');
const photoInput = document.getElementById('scan-photo-input');
let session = null; // { reader, resolve } while the dialog is open

function finish(text) {
  if (!session) return;
  const { reader, resolve } = session;
  session = null;
  reader?.reset(); // stops the camera
  if (dialog.open) dialog.close();
  resolve(text);
}

dialog.addEventListener('close', () => finish(null));
dialog.querySelector('[data-scan="cancel"]').addEventListener('click', () => finish(null));
dialog.querySelector('[data-scan="photo"]').addEventListener('click', () => photoInput.click());

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  photoInput.value = '';
  if (!file || !session) return;
  status.textContent = 'Reading photo…';
  const text = await decodePhoto(file).catch(() => null);
  if (text) finish(text);
  else if (session) status.textContent = 'No barcode found in that photo. Try again closer, with the barcode in focus.';
});

async function decodePhoto(file) {
  const ZXing = await loadZXing();
  // Phone photos are 12MP+; 1600px keeps barcodes readable and decoding quick.
  const blob = await resizeImage(file, 1600, 0.92);
  const url = URL.createObjectURL(blob);
  try {
    const reader = new ZXing.BrowserMultiFormatReader(new Map([[ZXing.DecodeHintType.TRY_HARDER, true]]));
    return (await reader.decodeFromImageUrl(url)).getText();
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Opens the scanner; resolves with the barcode text, or null if cancelled.
export function scanBarcode() {
  if (session) return Promise.resolve(null);
  return new Promise((resolve) => {
    session = { reader: null, resolve };
    const live = !!navigator.mediaDevices?.getUserMedia;
    video.hidden = !live;
    status.textContent = live
      ? 'Starting camera…'
      : 'Live scanning needs the app on HTTPS. Take a photo of the barcode instead.';
    dialog.showModal();
    if (live) startLive();
  });
}

async function startLive() {
  const mine = session;
  try {
    const ZXing = await loadZXing();
    if (session !== mine) return; // cancelled while loading
    const reader = new ZXing.BrowserMultiFormatReader();
    mine.reader = reader;
    await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, (result) => {
      if (result && session === mine) {
        navigator.vibrate?.(80);
        finish(result.getText());
      }
    });
    if (session === mine) status.textContent = 'Point the camera at a barcode.';
    else reader.reset(); // closed while the camera was starting
  } catch (err) {
    if (session !== mine) return;
    video.hidden = true;
    status.textContent = `The camera couldn't start (${err?.name === 'NotAllowedError' ? 'permission denied' : err?.message || err}). Take a photo of the barcode instead.`;
  }
}
