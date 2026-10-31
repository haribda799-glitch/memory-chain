// ============================================================
// Sequential photo preparation pipeline (Android Chrome safe)
// ============================================================
//
// Why strictly sequential: on Android Chrome, re-selecting the SAME photo from the system Photo Picker
// (a `content://` URI) while several consumers read the File in parallel (<img>, FileReader, canvas,
// TF.js) can break the Blob stream, and Chrome keeps that broken handle cached for the URI until a
// different file is picked. So the picker File is read EXACTLY ONCE into RAM (arrayBuffer -> Blob),
// and every later step works on that in-memory copy only, one step at a time.

export const PHOTO_WAKEUP_DELAY_MS = 400;   // Step A: let Chrome fully resume after the Photo Picker closes
export const DECODE_RETRY_DELAY_MS = 400;   // Pause before the single decode retry
export const PREVIEW_JPEG_QUALITY = 0.88;

/** Thrown when a newer selection / removal made the current pipeline run obsolete. */
export class PhotoPipelineCancelled extends Error {
  constructor() {
    super('Photo preparation cancelled');
    this.name = 'PhotoPipelineCancelled';
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best MIME type for a picked file (Android Photo Picker sometimes reports an empty type). */
export function guessImageMime(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('image/')) return type;
  const name = String(file?.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.bmp')) return 'image/bmp';
  if (name.endsWith('.heic')) return 'image/heic';
  if (name.endsWith('.heif')) return 'image/heif';
  return 'image/jpeg';
}

/** Fixes `data:;base64,...` / `data:application/octet-stream;base64,...` URLs to a real image MIME. */
export function normalizeImageDataUrl(dataUrl, mimeHint = 'image/jpeg') {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return '';
  if (dataUrl.startsWith('data:image/')) return dataUrl;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return '';
  const header = dataUrl.slice(0, commaIdx);
  if (!header.includes(';base64')) return '';
  return `data:${mimeHint};base64,${dataUrl.slice(commaIdx + 1)}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Step C: in-memory Blob -> normalized `data:image/...;base64` URL (FileReader, base64 fallback). */
export async function readBlobAsDataUrl(blob, mimeHint = blob?.type || 'image/jpeg') {
  if (typeof FileReader !== 'undefined') {
    try {
      const raw = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsDataURL(blob);
      });
      const normalized = normalizeImageDataUrl(raw, mimeHint);
      if (normalized) return normalized;
    } catch (err) {
      console.warn('[PhotoPipeline] FileReader failed, using base64 fallback:', err?.message || err);
    }
  }
  // The Blob lives in RAM, so reading it again is safe (it is NOT the picker's content:// file)
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:${mimeHint};base64,${base64}`;
}

/** Synchronous `data:` URL -> Blob (no second canvas encode, no fetch). */
export function dataUrlToBlob(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  const header = dataUrl.slice(5, commaIdx); // after "data:"
  const mime = header.split(';')[0] || 'application/octet-stream';
  const binary = atob(dataUrl.slice(commaIdx + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Frees a canvas backing store immediately (mobile Chrome caps total canvas memory per tab). */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // ignore
  }
}

export function disposeImageElement(img) {
  if (!img) return;
  img.onload = null;
  img.onerror = null;
  try {
    img.removeAttribute('src');
  } catch {
    img.src = '';
  }
}

/** Decodes a URL in a detached <img> using onload (never img.decode(), flaky on Android Chrome). */
export function loadImageElement(src, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      disposeImageElement(img);
      reject(new Error('Image decode timed out'));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      disposeImageElement(img);
      reject(new Error('Image decode failed'));
    };
    img.src = src;
  });
}

/**
 * Step D: decode the data URL (single retry with a fresh object URL of the in-memory Blob after 400ms),
 * draw it on a canvas (longest side <= maxDim) and export a clean JPEG. The canvas memory is released
 * in `finally`, on success AND on failure.
 */
export async function renderToJpeg({ rawDataUrl, memoryBlob, maxDim, quality = PREVIEW_JPEG_QUALITY, retryDelayMs = DECODE_RETRY_DELAY_MS }) {
  let img = null;
  let objectUrl = '';
  let canvas = null;
  try {
    try {
      img = await loadImageElement(rawDataUrl);
    } catch (firstErr) {
      console.warn('[PhotoPipeline] 1st decode failed, retrying with a fresh object URL:', firstErr?.message || firstErr);
      await sleep(retryDelayMs);
      objectUrl = URL.createObjectURL(memoryBlob);
      img = await loadImageElement(objectUrl);
    }

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('Invalid image dimensions');

    const scale = Math.min(1, maxDim / Math.max(width, height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha: avoid black backgrounds for transparent PNGs
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
    if (!jpegDataUrl || !jpegDataUrl.startsWith('data:image/jpeg;base64,')) {
      throw new Error('Canvas produced an empty JPEG');
    }
    return { jpegDataUrl, jpegBlob: dataUrlToBlob(jpegDataUrl), width: canvas.width, height: canvas.height };
  } finally {
    releaseCanvas(canvas);
    disposeImageElement(img);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Small canvas (longest side <= maxDim) of an already-prepared data URL, for TF.js.
 * The caller MUST pass the returned canvas to `releaseCanvas` in a `finally`.
 */
export async function createAiInputCanvas(dataUrl, maxDim = 512) {
  let img = null;
  let canvas = null;
  try {
    img = await loadImageElement(dataUrl, 8000);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('Invalid image dimensions');
    const scale = Math.min(1, maxDim / Math.max(width, height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const result = canvas;
    canvas = null; // ownership moves to the caller
    return result;
  } finally {
    releaseCanvas(canvas); // only on failure
    disposeImageElement(img);
  }
}

function baseName(file) {
  return String(file?.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
}

/**
 * Steps A-D, strictly one after another (no parallel access to the picker File):
 *   A. wait for Chrome to resume after the Photo Picker
 *   B. read the picker File EXACTLY ONCE into RAM (`file.arrayBuffer()`) -> independent in-memory Blob
 *   C. in-memory Blob -> base64 data URL
 *   D. decode + downscale + export a clean JPEG data URL (+ Blob for upload); canvas released
 *
 * @param {File} file
 * @param {{
 *   isCurrent?: () => boolean,
 *   onFileCopied?: () => void,      // called once the picker File is no longer needed (remount <input>)
 *   maxDim: number,
 *   quality?: number,
 *   wakeupDelayMs?: number,
 *   decode?: typeof renderToJpeg,   // injectable for unit tests
 * }} options
 * @returns {Promise<{ previewUrl: string, uploadFile: File, previewFailed: boolean, mime: string }>}
 */
export async function preparePhotoSequentially(file, {
  isCurrent = () => true,
  onFileCopied,
  maxDim,
  quality = PREVIEW_JPEG_QUALITY,
  wakeupDelayMs = PHOTO_WAKEUP_DELAY_MS,
  decode = renderToJpeg,
} = {}) {
  const checkpoint = () => {
    if (!isCurrent()) throw new PhotoPipelineCancelled();
  };
  const mime = guessImageMime(file);

  // Step A
  await sleep(wakeupDelayMs);
  checkpoint();

  // Step B (a single successful read; one retry only if the first read itself failed)
  let arrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (readErr) {
    console.warn('[PhotoPipeline] Reading the picked file failed, retrying once:', readErr?.message || readErr);
    await sleep(DECODE_RETRY_DELAY_MS);
    checkpoint();
    arrayBuffer = await file.arrayBuffer();
  }
  checkpoint();
  if (!arrayBuffer || arrayBuffer.byteLength === 0) throw new Error('The selected photo is empty');
  const memoryBlob = new Blob([arrayBuffer], { type: mime });
  arrayBuffer = null;
  if (typeof onFileCopied === 'function') onFileCopied();

  // GIF: keep the original bytes (a canvas would drop the animation)
  if (mime === 'image/gif') {
    const gifDataUrl = await readBlobAsDataUrl(memoryBlob, mime);
    checkpoint();
    return {
      previewUrl: gifDataUrl,
      uploadFile: new File([memoryBlob], file?.name || 'photo.gif', { type: mime }),
      previewFailed: false,
      mime,
    };
  }

  // Step C
  let rawDataUrl = await readBlobAsDataUrl(memoryBlob, mime);
  checkpoint();

  // Step D
  try {
    const { jpegDataUrl, jpegBlob } = await decode({ rawDataUrl, memoryBlob, maxDim, quality });
    rawDataUrl = null;
    checkpoint();
    return {
      previewUrl: jpegDataUrl,
      uploadFile: new File([jpegBlob], `${baseName(file)}.jpg`, { type: 'image/jpeg' }),
      previewFailed: false,
      mime: 'image/jpeg',
    };
  } catch (decodeErr) {
    if (decodeErr instanceof PhotoPipelineCancelled) throw decodeErr;
    // The browser cannot decode this format (e.g. HEIC on Android Chrome): upload the original bytes
    console.warn('[PhotoPipeline] Browser cannot decode this format, uploading original bytes:', decodeErr?.message || decodeErr);
    rawDataUrl = null;
    checkpoint();
    return {
      previewUrl: '',
      uploadFile: new File([memoryBlob], file?.name || 'photo', { type: mime }),
      previewFailed: true,
      mime,
    };
  }
}
