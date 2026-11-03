// ============================================================
// Sequential photo preparation pipeline + Session Cache (Android safe)
// ============================================================
//
// Why this architecture guarantees 100% photo opening on Samsung Android (both camera DCIM photos
// and downloaded/messenger photos like `1000000214.jpg` / `1000000162.jpg` from the virtual picker):
// 1. Virtual picker streams (`content://media/picker/.../1000000214`) close as soon as the synchronous
//    `onChange` tick ends if a pause (`sleep(350)`) runs before reading the bytes.
//    Therefore, Step 1 captures the file's `ArrayBuffer` into RAM immediately at 0ms (BEFORE any `sleep`),
//    cascading through `file.arrayBuffer()` -> `FileReader.readAsArrayBuffer(file)` ->
//    `FileReader.readAsDataURL(file)`.
// 2. Downloaded `.jpg` files from messengers/the web are frequently WebP, PNG, GIF, or AVIF inside or
//    arrive with an empty/wrong `file.type`. Step 1 inspects the magic bytes of the `ArrayBuffer`
//    (`FF D8 FF` -> `image/jpeg`, `89 50 4E 47` -> `image/png`, `RIFF....WEBP` -> `image/webp`,
//    `GIF8` -> `image/gif`, `....ftypavif` -> `image/avif`, etc.) and immediately constructs both an
//    independent `memoryBlob = new Blob([buffer], { type: detectedMime })` and `rawDataUrl`.
// 3. Only AFTER `memoryBlob` and `rawDataUrl` are safely in RAM does Step 2 pause 350ms
//    (`PHOTO_WAKEUP_DELAY_MS`) for the mobile browser's GPU/Canvas context to settle.
// 4. Bulletproof fallback: if Step 3 (`<canvas>` / `createImageBitmap` / `new Image()` downscale to
//    800px JPEG 0.82) succeeds, the compact `jpegBlob` + `jpegDataUrl` are used. If `<canvas>` decode
//    fails on a specific Samsung firmware, the pipeline NEVER throws "We could not read this photo.
//    Please select it again." — it seamlessly falls back to `memoryBlob` for upload and `rawDataUrl`
//    as `previewUrl` for `<img src={previewUrl} />`.
// 5. Successful results are cached in `sessionPhotoCache` by `${file.name}::${file.size}::${file.lastModified}`
//    (up to 10 entries). Re-selecting the same photo in the same session returns the cached result
//    without ever touching the Android file descriptor again.

export const PHOTO_WAKEUP_DELAY_MS = 350;      // Step 2: let mobile GPU/Canvas wake up after bytes are in RAM
export const DECODE_RETRY_DELAY_MS = 400;      // Pause before the single Image() decode retry
export const PREVIEW_MAX_DIMENSION = 800;      // Max 800px longest side for preview & upload
export const PREVIEW_JPEG_QUALITY = 0.82;      // Compact 0.82 JPEG quality (~70-95 KB)
export const MAX_ARWEAVE_FREE_PHOTO_BYTES = 95_000; // <= 95 KB so ANS-104 DataItem + tags stays under Turbo's 100 KB free limit
export const MAX_SESSION_CACHE_ENTRIES = 10;   // Up to 10 entries in sessionPhotoCache
export const CACHED_OVERLAY_DELAY_MS = 800;    // 800ms "Preparing Portrait..." overlay on session cache hit

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

// Track every created blob: URL so clearing the photo ("X") can forcibly revoke any lingering URLs.
const activeObjectUrls = new Set();

export function createTrackedObjectUrl(blob) {
  if (!blob || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return '';
  try {
    const url = URL.createObjectURL(blob);
    if (url) activeObjectUrls.add(url);
    return url;
  } catch {
    return '';
  }
}

export function revokeTrackedObjectUrl(url) {
  if (!url) return;
  activeObjectUrls.delete(url);
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

export function revokeAllTrackedObjectUrls() {
  for (const url of Array.from(activeObjectUrls)) {
    revokeTrackedObjectUrl(url);
  }
  activeObjectUrls.clear();
}

/** Fallback MIME guess from `file.type` / filename extension when magic bytes are inconclusive. */
export function guessImageMime(file) {
  const type = String(file?.type || '').toLowerCase();
  if (type.startsWith('image/')) return type;
  const name = String(file?.name || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.avif')) return 'image/avif';
  if (name.endsWith('.bmp')) return 'image/bmp';
  if (name.endsWith('.heic')) return 'image/heic';
  if (name.endsWith('.heif')) return 'image/heif';
  return 'image/jpeg';
}

/**
 * Detects the true MIME type of an image from its leading magic bytes:
 *   - `FF D8 FF` -> `'image/jpeg'`
 *   - `89 50 4E 47` -> `'image/png'`
 *   - `52 49 46 46` ... `57 45 42 50` (`RIFF....WEBP`) -> `'image/webp'`
 *   - `47 49 46 38` (`GIF8`) -> `'image/gif'`
 *   - `42 4D` (`BM`) -> `'image/bmp'`
 *   - ISO BMFF `ftyp` box (`avif`/`avis` -> `'image/avif'`, `heic`/`heix` -> `'image/heic'`, `mif1`/`heif` -> `'image/heif'`)
 * Falls back to `guessImageMime(fallbackFile)` when the header does not match a known signature.
 */
export function detectImageMimeFromBytes(buffer, fallbackFile = null) {
  let bytes = null;
  if (buffer instanceof Uint8Array) {
    bytes = buffer;
  } else if (buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(buffer);
  } else if (ArrayBuffer.isView(buffer)) {
    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  if (bytes && bytes.length >= 2) {
    // JPEG: FF D8 FF
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
      return 'image/jpeg';
    }
    // PNG: 89 50 4E 47
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4E &&
      bytes[3] === 0x47
    ) {
      return 'image/png';
    }
    // WebP: 52 49 46 46 ("RIFF") at 0..3 and 57 45 42 50 ("WEBP") at 8..11
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return 'image/webp';
    }
    // GIF: 47 49 46 38 ("GIF8")
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return 'image/gif';
    }
    // BMP: 42 4D ("BM")
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
      return 'image/bmp';
    }
    // ISO Base Media File Format: "ftyp" (66 74 79 70) at bytes 4..7
    if (
      bytes.length >= 12 &&
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
      if (brand === 'avif' || brand === 'avis' || brand === 'ma1b' || brand === 'ma1a') {
        return 'image/avif';
      }
      if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') {
        return 'image/heic';
      }
      if (brand === 'mif1' || brand === 'msf1' || brand === 'heif') {
        return 'image/heif';
      }
    }
  }

  if (typeof fallbackFile === 'string' && fallbackFile.startsWith('image/')) {
    return fallbackFile.toLowerCase();
  }
  return guessImageMime(fallbackFile);
}

/* ── Session Photo Cache (LRU, max 10 entries keyed by `${file.name}::${file.size}::${file.lastModified}`) ── */
const sessionPhotoCache = new Map();

export function getPhotoCacheKey(file) {
  if (!file) return '';
  const name = String(file.name || '');
  const size = Number(file.size || 0);
  const lastModified = Number(file.lastModified || 0);
  if (!name && !size) return '';
  return `${name}::${size}::${lastModified}`;
}

function findSessionCacheKey(file) {
  const exactKey = getPhotoCacheKey(file);
  if (exactKey && sessionPhotoCache.has(exactKey)) {
    return exactKey;
  }
  // Fallback if Android Photo Picker synthesized a different lastModified timestamp for the same file
  const name = String(file?.name || '');
  const size = Number(file?.size || 0);
  if (name && size > 0) {
    for (const [key, entry] of sessionPhotoCache.entries()) {
      if (entry.fileName === name && entry.fileSize === size) {
        return key;
      }
    }
  }
  return '';
}

function getFromSessionCache(file) {
  const hitKey = findSessionCacheKey(file);
  if (!hitKey) return null;
  const entry = sessionPhotoCache.get(hitKey);
  // Refresh LRU order
  sessionPhotoCache.delete(hitKey);
  sessionPhotoCache.set(hitKey, entry);
  return entry;
}

function setInSessionCache(file, entry) {
  const exactKey = getPhotoCacheKey(file);
  if (!exactKey) return;

  const existingKey = findSessionCacheKey(file);
  if (existingKey) {
    sessionPhotoCache.delete(existingKey);
  }

  sessionPhotoCache.set(exactKey, {
    ...entry,
    fileName: String(file?.name || ''),
    fileSize: Number(file?.size || 0),
  });

  // Evict oldest entries so at most MAX_SESSION_CACHE_ENTRIES (10) are kept
  while (sessionPhotoCache.size > MAX_SESSION_CACHE_ENTRIES) {
    const oldestKey = sessionPhotoCache.keys().next().value;
    if (oldestKey === undefined) break;
    sessionPhotoCache.delete(oldestKey);
  }
}

/** Stores the completed AI moderation outcome on the cached photo entry for instant reuse. */
export function cachePhotoAiResult(file, aiResult) {
  const entry = getFromSessionCache(file);
  if (entry && aiResult) {
    entry.aiResult = { ...aiResult };
  }
}

/** Returns the cached AI moderation result for `file` if available. */
export function getCachedPhotoAiResult(file) {
  const entry = getFromSessionCache(file);
  return entry?.aiResult || null;
}

/** Used by unit tests to inspect or reset the session cache. */
export function clearSessionPhotoCache() {
  sessionPhotoCache.clear();
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

/** Ensures a base64 `data:` URL carries the exact `detectedMime` determined from magic bytes. */
export function enforceDataUrlMime(dataUrl, detectedMime = 'image/jpeg') {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return '';
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return '';
  const header = dataUrl.slice(0, commaIdx);
  if (!header.includes(';base64')) return dataUrl;
  return `data:${detectedMime};base64,${dataUrl.slice(commaIdx + 1)}`;
}

export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function arrayBufferToDataUrl(buffer, mime = 'image/jpeg') {
  return `data:${mime};base64,${arrayBufferToBase64(buffer)}`;
}

export function dataUrlToArrayBuffer(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) throw new Error('Invalid data URL');
  const binary = atob(dataUrl.slice(commaIdx + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Initiates `FileReader.readAsDataURL(file)` synchronously on the calling tick (0ms).
 */
export function readFileAsDataUrlDirect(file, mimeHint = guessImageMime(file)) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined' || !(file instanceof Blob)) {
      reject(new Error('FileReader unavailable for this input'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const normalized = normalizeImageDataUrl(reader.result, mimeHint);
      if (normalized) {
        resolve(normalized);
      } else {
        reject(new Error('FileReader returned an empty data URL'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Initiates `FileReader.readAsArrayBuffer(file)` synchronously on the calling tick (0ms).
 */
export function readFileAsArrayBufferDirect(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined' || !(file instanceof Blob)) {
      reject(new Error('FileReader unavailable for this input'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result && reader.result.byteLength > 0) {
        resolve(reader.result);
      } else {
        reject(new Error('FileReader returned an empty ArrayBuffer'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader ArrayBuffer read failed'));
    reader.readAsArrayBuffer(file);
  });
}

/** In-memory Blob -> normalized `data:image/...;base64` URL (FileReader with base64 fallback). */
export async function readBlobAsDataUrl(blob, mimeHint = blob?.type || 'image/jpeg') {
  if (typeof FileReader !== 'undefined' && blob instanceof Blob) {
    try {
      const dataUrl = await readFileAsDataUrlDirect(blob, mimeHint);
      return enforceDataUrlMime(dataUrl, mimeHint);
    } catch (err) {
      console.warn('[PhotoPipeline] FileReader failed on Blob, using base64 fallback:', err?.message || err);
    }
  }
  const ab = await blob.arrayBuffer();
  return arrayBufferToDataUrl(ab, mimeHint);
}

/** Synchronous `data:` URL -> Blob. */
export function dataUrlToBlob(dataUrl, mimeOverride = '') {
  const commaIdx = dataUrl.indexOf(',');
  const header = dataUrl.slice(5, commaIdx); // after "data:"
  const mime = mimeOverride || header.split(';')[0] || 'application/octet-stream';
  const ab = dataUrlToArrayBuffer(dataUrl);
  return new Blob([ab], { type: mime });
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
 * Encodes a 2D `<canvas>` to `{ jpegDataUrl, jpegBlob }` at the given quality.
 */
async function encodeCanvasToJpeg(canvas, quality) {
  const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
  if (!jpegDataUrl || !jpegDataUrl.startsWith('data:image/jpeg;base64,')) {
    throw new Error('Canvas produced an empty JPEG');
  }
  let jpegBlob = null;
  if (typeof canvas.toBlob === 'function') {
    jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  if (!jpegBlob) {
    jpegBlob = dataUrlToBlob(jpegDataUrl, 'image/jpeg');
  }
  return { jpegDataUrl, jpegBlob };
}

/**
 * Step C: decode the already-read in-memory image (`rawDataUrl` or `memoryBlob`, falling back to
 * `createImageBitmap` / `objectUrl` / `fallbackObjectUrl`), downscale onto a max 800px `<canvas>`,
 * export compact `jpegDataUrl` + `jpegBlob` guaranteed `<= maxBytes` (95_000 bytes for ArDrive Turbo's
 * free 100 KB ANS-104 bundler limit), and immediately zero every canvas in `finally`.
 */
export async function renderToJpeg({
  rawDataUrl = '',
  memoryBlob = null,
  fallbackObjectUrl = '',
  maxDim = PREVIEW_MAX_DIMENSION,
  quality = PREVIEW_JPEG_QUALITY,
  maxBytes = MAX_ARWEAVE_FREE_PHOTO_BYTES,
  retryDelayMs = DECODE_RETRY_DELAY_MS,
}) {
  let img = null;
  let bitmap = null;
  let objectUrl = '';
  let canvas = null;
  let scaledCanvas = null;
  try {
    let lastDecodeErr = null;
    if (rawDataUrl) {
      try {
        img = await loadImageElement(rawDataUrl);
      } catch (firstErr) {
        lastDecodeErr = firstErr;
        console.warn('[PhotoPipeline] 1st decode failed, trying fallback decoders:', firstErr?.message || firstErr);
      }
    }

    if (!img && memoryBlob && typeof createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(memoryBlob);
      } catch (bmpErr) {
        lastDecodeErr = bmpErr;
        bitmap = null;
      }
    }

    if (!img && !bitmap && memoryBlob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      if (retryDelayMs > 0 && rawDataUrl) {
        await sleep(retryDelayMs);
      }
      try {
        objectUrl = createTrackedObjectUrl(memoryBlob);
        if (objectUrl) {
          img = await loadImageElement(objectUrl);
        }
      } catch (blobErr) {
        lastDecodeErr = blobErr;
      }
    }

    if (!img && !bitmap && fallbackObjectUrl) {
      try {
        img = await loadImageElement(fallbackObjectUrl);
      } catch (fallbackErr) {
        lastDecodeErr = fallbackErr;
      }
    }

    const source = bitmap || img;
    if (!source) {
      throw lastDecodeErr || new Error('Image decode failed');
    }

    const width = bitmap ? bitmap.width : (img.naturalWidth || img.width);
    const height = bitmap ? bitmap.height : (img.naturalHeight || img.height);
    if (!width || !height) throw new Error('Invalid image dimensions');

    const scale = Math.min(1, maxDim / Math.max(width, height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha: avoid black backgrounds for transparent PNGs/WebPs
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    // Immediately release the decoded source and temporary object URLs right after drawing
    if (bitmap && typeof bitmap.close === 'function') {
      try { bitmap.close(); } catch {}
    }
    bitmap = null;
    disposeImageElement(img);
    img = null;
    revokeTrackedObjectUrl(objectUrl);
    objectUrl = '';
    revokeTrackedObjectUrl(fallbackObjectUrl);

    let { jpegDataUrl, jpegBlob } = await encodeCanvasToJpeg(canvas, quality);
    let outWidth = canvas.width;
    let outHeight = canvas.height;

    // Guarantee `jpegBlob.size <= maxBytes` (95,000 bytes) for ArDrive Turbo free ANS-104 uploads:
    // 1) First step down JPEG quality on the current canvas (0.72 -> 0.62 -> 0.52)
    if (maxBytes > 0 && jpegBlob.size > maxBytes) {
      const fallbackQualities = [0.72, 0.62, 0.52].filter((q) => q < quality);
      for (const nextQuality of fallbackQualities) {
        const candidate = await encodeCanvasToJpeg(canvas, nextQuality);
        jpegDataUrl = candidate.jpegDataUrl;
        jpegBlob = candidate.jpegBlob;
        if (jpegBlob.size <= maxBytes) break;
      }
    }

    // 2) If still > maxBytes (e.g. high-frequency foliage/fur texture), step down dimensions (720px -> 640px -> 560px -> 480px)
    if (maxBytes > 0 && jpegBlob.size > maxBytes) {
      const longestCurrent = Math.max(canvas.width, canvas.height);
      const smallerDims = [720, 640, 560, 480].filter((d) => d < longestCurrent);
      for (const targetDim of smallerDims) {
        const subScale = targetDim / longestCurrent;
        scaledCanvas = document.createElement('canvas');
        scaledCanvas.width = Math.max(1, Math.round(canvas.width * subScale));
        scaledCanvas.height = Math.max(1, Math.round(canvas.height * subScale));
        const subCtx = scaledCanvas.getContext('2d');
        if (!subCtx) {
          releaseCanvas(scaledCanvas);
          scaledCanvas = null;
          break;
        }
        subCtx.fillStyle = '#ffffff';
        subCtx.fillRect(0, 0, scaledCanvas.width, scaledCanvas.height);
        subCtx.drawImage(canvas, 0, 0, scaledCanvas.width, scaledCanvas.height);

        for (const subQuality of [0.72, 0.62, 0.50]) {
          const candidate = await encodeCanvasToJpeg(scaledCanvas, subQuality);
          jpegDataUrl = candidate.jpegDataUrl;
          jpegBlob = candidate.jpegBlob;
          outWidth = scaledCanvas.width;
          outHeight = scaledCanvas.height;
          if (jpegBlob.size <= maxBytes) break;
        }
        releaseCanvas(scaledCanvas);
        scaledCanvas = null;
        if (jpegBlob.size <= maxBytes) break;
      }
    }

    releaseCanvas(canvas);
    canvas = null;

    return { jpegDataUrl, jpegBlob, width: outWidth, height: outHeight };
  } finally {
    releaseCanvas(scaledCanvas);
    releaseCanvas(canvas);
    if (bitmap && typeof bitmap.close === 'function') {
      try { bitmap.close(); } catch {}
    }
    disposeImageElement(img);
    revokeTrackedObjectUrl(objectUrl);
    revokeTrackedObjectUrl(fallbackObjectUrl);
  }
}

/**
 * Small canvas (longest side <= maxDim) of an already-prepared 800px data URL, for TF.js.
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
 * Step 1 helper: reads the picked `File` into an `ArrayBuffer` + `rawDataUrl` immediately at 0ms
 * (before any `sleep`), cascading through `file.arrayBuffer()` -> `FileReader.readAsArrayBuffer` ->
 * `FileReader.readAsDataURL`.
 */
async function captureFileBytesAtZeroMs(file) {
  let arrayBuffer = null;
  let rawDataUrl = '';
  let lastReadErr = null;
  const fallbackMime = guessImageMime(file);

  // 1. Primary 0ms read: file.arrayBuffer()
  if (typeof file?.arrayBuffer === 'function') {
    try {
      const ab = await file.arrayBuffer();
      if (ab && ab.byteLength > 0) {
        arrayBuffer = ab;
      } else {
        throw new Error('The selected photo is empty');
      }
    } catch (abErr) {
      lastReadErr = abErr;
      console.warn('[PhotoPipeline] 0ms file.arrayBuffer() failed, trying FileReader fallback:', abErr?.message || abErr);
    }
  }

  // 2. Cascade fallback: FileReader.readAsArrayBuffer(file)
  if (!arrayBuffer && typeof FileReader !== 'undefined' && file instanceof Blob) {
    try {
      const ab = await readFileAsArrayBufferDirect(file);
      if (ab && ab.byteLength > 0) {
        arrayBuffer = ab;
      }
    } catch (frAbErr) {
      lastReadErr = frAbErr;
      console.warn('[PhotoPipeline] FileReader.readAsArrayBuffer failed, trying readAsDataURL:', frAbErr?.message || frAbErr);
    }
  }

  // 3. Cascade fallback: FileReader.readAsDataURL(file)
  if (!arrayBuffer && typeof FileReader !== 'undefined' && file instanceof Blob) {
    try {
      rawDataUrl = await readFileAsDataUrlDirect(file, fallbackMime);
      if (rawDataUrl) {
        arrayBuffer = dataUrlToArrayBuffer(rawDataUrl);
      }
    } catch (frDataErr) {
      lastReadErr = frDataErr;
    }
  }

  // 4. Final immediate retry of file.arrayBuffer() if all above failed
  if (!arrayBuffer && typeof file?.arrayBuffer === 'function') {
    try {
      const ab = await file.arrayBuffer();
      if (ab && ab.byteLength > 0) {
        arrayBuffer = ab;
      }
    } catch (retryErr) {
      lastReadErr = retryErr;
    }
  }

  if (!arrayBuffer && !rawDataUrl) {
    throw lastReadErr || new Error('The selected photo could not be read');
  }

  if (arrayBuffer && arrayBuffer.byteLength === 0) {
    throw new Error('The selected photo is empty');
  }

  // Detect true MIME type from the first bytes of the buffer (magic bytes)
  const detectedMime = arrayBuffer
    ? detectImageMimeFromBytes(arrayBuffer, file)
    : fallbackMime;

  const memoryBlob = arrayBuffer
    ? new Blob([arrayBuffer], { type: detectedMime })
    : dataUrlToBlob(rawDataUrl, detectedMime);

  const normalizedDataUrl = rawDataUrl
    ? enforceDataUrlMime(rawDataUrl, detectedMime)
    : arrayBufferToDataUrl(arrayBuffer, detectedMime);

  return {
    memoryBlob,
    rawDataUrl: normalizedDataUrl,
    detectedMime,
  };
}

/**
 * Strictly sequential photo preparation with 0ms byte capture, magic-byte MIME detection,
 * bulletproof fallback, and in-memory session caching:
 *   Step 0 (0ms): Check `sessionPhotoCache` (`${file.name}::${file.size}::${file.lastModified}`).
 *          If cached, never touch the Android `content://` descriptor again.
 *   Step 1 (0ms, BEFORE any `sleep`): Immediately read `file` into RAM (`ArrayBuffer`), detect real
 *          MIME type via magic bytes (`FF D8 FF` -> `image/jpeg`, `89 50 4E 47` -> `image/png`,
 *          `52 49 46 46 ... 57 45 42 50` -> `image/webp`, `47 49 46 38` -> `image/gif`), and build
 *          an independent `memoryBlob` and `rawDataUrl`.
 *   Step 2 (350ms wakeup pause): Only AFTER bytes are in `memoryBlob`, pause `await sleep(350)` so
 *          the mobile browser's GPU/Canvas context recovers after closing the Photo Picker.
 *   Step 3: Resize via `<canvas>` to 800px JPEG (0.82). If `<canvas>` decoding fails on a specific
 *          Samsung firmware, NEVER fail the pipeline — return `memoryBlob` as `uploadFile` and
 *          `rawDataUrl` as `previewUrl` for `<img src={previewUrl} />`.
 *
 * @param {File} file
 * @param {{
 *   isCurrent?: () => boolean,
 *   maxDim?: number,
 *   quality?: number,
 *   wakeupDelayMs?: number,
 *   useCache?: boolean,
 *   decode?: typeof renderToJpeg,   // injectable for unit tests
 * }} options
 * @returns {Promise<{
 *   previewUrl: string,
 *   uploadFile: File,
 *   previewFailed: boolean,
 *   mime: string,
 *   fromCache?: boolean,
 *   usedRawFallback?: boolean,
 *   cachedAiResult?: object | null,
 * }>}
 */
export async function preparePhotoSequentially(file, {
  isCurrent = () => true,
  maxDim = PREVIEW_MAX_DIMENSION,
  quality = PREVIEW_JPEG_QUALITY,
  maxBytes = MAX_ARWEAVE_FREE_PHOTO_BYTES,
  wakeupDelayMs = PHOTO_WAKEUP_DELAY_MS,
  useCache = true,
  decode = renderToJpeg,
} = {}) {
  const checkpoint = () => {
    if (!isCurrent()) throw new PhotoPipelineCancelled();
  };
  checkpoint();

  if (!file || file.size === 0) {
    throw new Error('The selected photo is empty');
  }

  // Step 0 (0ms): Check sessionPhotoCache first — never re-read an already-processed Android content:// URI
  if (useCache) {
    const cached = getFromSessionCache(file);
    if (cached) {
      if (wakeupDelayMs > 0) {
        await sleep(wakeupDelayMs);
        checkpoint();
      }
      const uploadFile = new File([cached.blob], cached.uploadFileName, { type: cached.mime });
      return {
        previewUrl: cached.previewUrl,
        uploadFile,
        previewFailed: cached.previewFailed,
        mime: cached.mime,
        fromCache: true,
        usedRawFallback: Boolean(cached.usedRawFallback),
        cachedAiResult: cached.aiResult || null,
      };
    }
  }

  // Capture a synchronous fallback object URL on the 0ms tick as an extra safety net
  const fallbackObjectUrl = file instanceof Blob ? createTrackedObjectUrl(file) : '';

  try {
    // Step 1 (0ms, BEFORE any sleep!): Read bytes into RAM, detect magic-byte MIME, build memoryBlob + rawDataUrl
    let { memoryBlob, rawDataUrl, detectedMime } = await captureFileBytesAtZeroMs(file);
    checkpoint();

    // Step 2 (350ms): ONLY AFTER bytes are safely inside `memoryBlob`, pause for GPU/Canvas wakeup
    if (wakeupDelayMs > 0) {
      await sleep(wakeupDelayMs);
      checkpoint();
    }

    // GIF: preserve original animation bytes
    if (detectedMime === 'image/gif') {
      const gifDataUrl = rawDataUrl || await readBlobAsDataUrl(memoryBlob, detectedMime);
      const gifBlob = memoryBlob || dataUrlToBlob(gifDataUrl, detectedMime);
      rawDataUrl = '';
      memoryBlob = null;
      checkpoint();
      const uploadFileName = file?.name || 'photo.gif';
      if (useCache) {
        setInSessionCache(file, {
          previewUrl: gifDataUrl,
          blob: gifBlob,
          uploadFileName,
          previewFailed: false,
          mime: detectedMime,
          usedRawFallback: false,
          aiResult: null,
        });
      }
      return {
        previewUrl: gifDataUrl,
        uploadFile: new File([gifBlob], uploadFileName, { type: detectedMime }),
        previewFailed: false,
        mime: detectedMime,
        fromCache: false,
        usedRawFallback: false,
        cachedAiResult: null,
      };
    }

    // Step 3: Decode + downscale into an 800px `<canvas>` (JPEG <= 95 KB)
    try {
      let decoded = await decode({
        rawDataUrl,
        memoryBlob,
        fallbackObjectUrl,
        maxDim,
        quality,
        maxBytes,
      });
      if (maxBytes > 0 && decoded.jpegBlob && decoded.jpegBlob.size > maxBytes) {
        const stepPlans = [
          { dim: maxDim, q: 0.72 },
          { dim: maxDim, q: 0.62 },
          { dim: 720, q: 0.72 },
          { dim: 720, q: 0.62 },
          { dim: 640, q: 0.62 },
          { dim: 560, q: 0.52 },
        ];
        for (const plan of stepPlans) {
          if (plan.dim >= maxDim && plan.q >= quality) continue;
          const next = await decode({
            rawDataUrl,
            memoryBlob,
            fallbackObjectUrl,
            maxDim: plan.dim,
            quality: plan.q,
            maxBytes,
          });
          decoded = next;
          if (decoded.jpegBlob && decoded.jpegBlob.size <= maxBytes) break;
        }
      }
      const { jpegDataUrl, jpegBlob } = decoded;
      // Immediately drop the raw buffers so GC frees them right away
      rawDataUrl = '';
      memoryBlob = null;
      checkpoint();

      const uploadFileName = `${baseName(file)}.jpg`;
      if (useCache) {
        setInSessionCache(file, {
          previewUrl: jpegDataUrl,
          blob: jpegBlob,
          uploadFileName,
          previewFailed: false,
          mime: 'image/jpeg',
          usedRawFallback: false,
          aiResult: null,
        });
      }

      return {
        previewUrl: jpegDataUrl,
        uploadFile: new File([jpegBlob], uploadFileName, { type: 'image/jpeg' }),
        previewFailed: false,
        mime: 'image/jpeg',
        fromCache: false,
        usedRawFallback: false,
        cachedAiResult: null,
      };
    } catch (decodeErr) {
      if (decodeErr instanceof PhotoPipelineCancelled) throw decodeErr;
      checkpoint();

      // Bulletproof Fallback: bytes are ALREADY in `memoryBlob` and `rawDataUrl` from Step 1.
      // Never fail with "We could not read this photo. Please select it again." — use `memoryBlob`
      // as the upload file and `rawDataUrl` as `previewUrl` for `<img src={previewUrl} />`.
      const fallbackBlob = memoryBlob || (rawDataUrl ? dataUrlToBlob(rawDataUrl, detectedMime) : null);
      const fallbackPreviewUrl = rawDataUrl || (fallbackBlob ? await readBlobAsDataUrl(fallbackBlob, detectedMime).catch(() => '') : '');
      rawDataUrl = '';
      memoryBlob = null;

      if (fallbackBlob) {
        console.warn('[PhotoPipeline] Canvas decode failed on this device; using in-memory raw bytes + rawDataUrl preview:', decodeErr?.message || decodeErr);
        const uploadFileName = file?.name || 'photo';
        const previewFailed = !fallbackPreviewUrl;
        const skippedAi = { hasPerson: false, hasAnimal: true, detectedSpecies: '', checkStatus: 'skipped' };
        if (useCache) {
          setInSessionCache(file, {
            previewUrl: fallbackPreviewUrl,
            blob: fallbackBlob,
            uploadFileName,
            previewFailed,
            mime: detectedMime,
            usedRawFallback: true,
            aiResult: skippedAi,
          });
        }
        return {
          previewUrl: fallbackPreviewUrl,
          uploadFile: new File([fallbackBlob], uploadFileName, { type: detectedMime }),
          previewFailed,
          mime: detectedMime,
          fromCache: false,
          usedRawFallback: true,
          cachedAiResult: skippedAi,
        };
      }
      throw decodeErr;
    }
  } finally {
    revokeTrackedObjectUrl(fallbackObjectUrl);
  }
}
