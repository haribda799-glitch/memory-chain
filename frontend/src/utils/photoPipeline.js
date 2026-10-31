// ============================================================
// Sequential photo preparation pipeline + Session Cache (Android safe)
// ============================================================
//
// Why this architecture works on 1st AND 50th photo selections on Android Chrome & WebViews:
// 1. `URL.createObjectURL(file)` alone does NOT read bytes into RAM — it is only a lazy pointer.
//    If the browser waits (`sleep(350)`) before starting a real byte read, Android closes the
//    temporary `content://` stream at the end of the `onChange` tick and throws `NotReadableError`.
// 2. Therefore, on the 1st selection of a photo, Step A starts reading the file's bytes into RAM
//    SYNCHRONOUSLY at 0ms (in the `onChange` tick, BEFORE any `sleep` and BEFORE resetting
//    `<input>.value`) via `FileReader.readAsDataURL(file)` (with fallback to `readAsArrayBuffer` /
//    `file.arrayBuffer()`).
// 3. Once the bytes are in RAM, Step B pauses 350ms (`PHOTO_WAKEUP_DELAY_MS`) so the mobile browser
//    restores its GPU/Canvas context after closing the gallery, then Step C downscales the image to
//    a compact 800px JPEG (`0.82` quality, ~80 KB), immediately frees the raw multi-megabyte buffer
//    and zeroes the `<canvas>`.
// 4. The compact 800px result (~80 KB data URL + ~80 KB Blob + AI check result) is saved in an
//    in-memory LRU cache (`sessionPhotoCache`, up to 10 entries). When the user removes the photo
//    ("X") and re-selects the same photo a 2nd, 4th, 10th, or 50th time, `preparePhotoSequentially`
//    returns the cached 800px portrait directly from RAM without touching Android's `content://`
//    stream again.

export const PHOTO_WAKEUP_DELAY_MS = 350;      // Step B: let mobile GPU/Canvas wake up after bytes are in RAM
export const DECODE_RETRY_DELAY_MS = 400;      // Pause before the single Image() decode retry
export const PREVIEW_MAX_DIMENSION = 800;      // Max 800px longest side for preview & upload
export const PREVIEW_JPEG_QUALITY = 0.82;      // Compact 0.82 JPEG quality (~70-100 KB)
export const MAX_SESSION_CACHE_ENTRIES = 10;   // Up to 10 compact (~80 KB) portraits in session cache

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

/* ── Session Photo Cache (LRU, max 10 compact 800px portraits) ── */
const sessionPhotoCache = new Map();

export function getPhotoCacheKey(file) {
  if (!file) return '';
  const name = String(file.name || '');
  const size = Number(file.size || 0);
  const lastModified = Number(file.lastModified || 0);
  if (!name && !size) return '';
  return `${name}::${size}::${lastModified}`;
}

function getPhotoFallbackCacheKey(file) {
  if (!file) return '';
  const name = String(file.name || '');
  const size = Number(file.size || 0);
  if (!name || !size) return '';
  return `${name}::${size}::*`;
}

function getFromSessionCache(file) {
  const exactKey = getPhotoCacheKey(file);
  const fallbackKey = getPhotoFallbackCacheKey(file);
  const hitKey = (exactKey && sessionPhotoCache.has(exactKey))
    ? exactKey
    : (fallbackKey && sessionPhotoCache.has(fallbackKey) ? fallbackKey : '');
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
  const fallbackKey = getPhotoFallbackCacheKey(file);

  if (sessionPhotoCache.has(exactKey)) sessionPhotoCache.delete(exactKey);
  sessionPhotoCache.set(exactKey, entry);

  if (fallbackKey) {
    if (sessionPhotoCache.has(fallbackKey)) sessionPhotoCache.delete(fallbackKey);
    sessionPhotoCache.set(fallbackKey, entry);
  }

  // Evict oldest keys so at most MAX_SESSION_CACHE_ENTRIES unique photos (2 keys each) are kept
  const maxKeys = MAX_SESSION_CACHE_ENTRIES * 2;
  while (sessionPhotoCache.size > maxKeys) {
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Initiates `FileReader.readAsDataURL(file)` synchronously on the calling tick (0ms).
 * Essential on Android so the `content://` stream is opened before the `onChange` tick ends.
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
 * Initiates `FileReader.readAsArrayBuffer(file)` synchronously on the calling tick.
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
      return await readFileAsDataUrlDirect(blob, mimeHint);
    } catch (err) {
      console.warn('[PhotoPipeline] FileReader failed on Blob, using base64 fallback:', err?.message || err);
    }
  }
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  return `data:${mimeHint};base64,${base64}`;
}

/** Synchronous `data:` URL -> Blob. */
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
 * Step C: decode the already-read in-memory image (`rawDataUrl` or `memoryBlob`, falling back to
 * `fallbackObjectUrl`), downscale onto a max 800px `<canvas>`, export compact `jpegDataUrl` (0.82)
 * + `jpegBlob` (0.82), and immediately zero the canvas (`width = 0; height = 0`) in `finally`.
 */
export async function renderToJpeg({
  rawDataUrl = '',
  memoryBlob = null,
  fallbackObjectUrl = '',
  maxDim = PREVIEW_MAX_DIMENSION,
  quality = PREVIEW_JPEG_QUALITY,
  retryDelayMs = DECODE_RETRY_DELAY_MS,
}) {
  let img = null;
  let objectUrl = '';
  let canvas = null;
  try {
    let lastDecodeErr = null;
    if (rawDataUrl) {
      try {
        img = await loadImageElement(rawDataUrl);
      } catch (firstErr) {
        lastDecodeErr = firstErr;
        console.warn('[PhotoPipeline] 1st decode failed, retrying via object URL:', firstErr?.message || firstErr);
        if (retryDelayMs > 0) await sleep(retryDelayMs);
      }
    }

    if (!img && memoryBlob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      try {
        objectUrl = createTrackedObjectUrl(memoryBlob);
        img = await loadImageElement(objectUrl);
      } catch (blobErr) {
        lastDecodeErr = blobErr;
      }
    }

    if (!img && fallbackObjectUrl) {
      try {
        img = await loadImageElement(fallbackObjectUrl);
      } catch (fallbackErr) {
        lastDecodeErr = fallbackErr;
      }
    }

    if (!img) {
      throw lastDecodeErr || new Error('Image decode failed');
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

    // Immediately release the decoded Image element and temporary object URLs right after drawing
    disposeImageElement(img);
    img = null;
    revokeTrackedObjectUrl(objectUrl);
    objectUrl = '';
    revokeTrackedObjectUrl(fallbackObjectUrl);

    const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
    if (!jpegDataUrl || !jpegDataUrl.startsWith('data:image/jpeg;base64,')) {
      throw new Error('Canvas produced an empty JPEG');
    }

    let jpegBlob = null;
    if (typeof canvas.toBlob === 'function') {
      jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    }
    if (!jpegBlob) {
      jpegBlob = dataUrlToBlob(jpegDataUrl);
    }

    const outWidth = canvas.width;
    const outHeight = canvas.height;
    releaseCanvas(canvas);
    canvas = null;

    return { jpegDataUrl, jpegBlob, width: outWidth, height: outHeight };
  } finally {
    releaseCanvas(canvas);
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
 * Strictly sequential photo preparation with in-memory session caching:
 *   Step 0 (0ms): Check `sessionPhotoCache`. If this photo was already prepared in the current
 *          session, skip reading the Android `content://` stream altogether, pause `wakeupDelayMs`,
 *          and return the cached 800px JPEG + cached AI result.
 *   Step A (0ms, synchronous start): Immediately start reading the picker File into RAM on the
 *          `onChange` tick (`FileReader.readAsDataURL(file)` -> `readAsArrayBuffer` / `arrayBuffer()`
 *          fallback) BEFORE any `sleep` or `<input>` reset.
 *   Step B (350ms wakeup pause): Wait for the mobile browser's GPU/Canvas context to settle after
 *          closing the Photo Picker.
 *   Step C: Decode + downscale into an 800px `<canvas>` (JPEG 0.82), immediately discard the raw
 *          buffer, zero the canvas, and save the compact (~80 KB) result in `sessionPhotoCache`.
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
 *   cachedAiResult?: object | null,
 * }>}
 */
export async function preparePhotoSequentially(file, {
  isCurrent = () => true,
  maxDim = PREVIEW_MAX_DIMENSION,
  quality = PREVIEW_JPEG_QUALITY,
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
        cachedAiResult: cached.aiResult || null,
      };
    }
  }

  const mime = guessImageMime(file);

  // Step A.1 (0ms): capture a fallback object URL synchronously on the current tick
  const fallbackObjectUrl = file instanceof Blob ? createTrackedObjectUrl(file) : '';

  try {
    // Step A.2 (0ms): start reading bytes into RAM synchronously BEFORE any sleep or input reset
    let rawDataUrl = '';
    let memoryBlob = null;
    let lastReadErr = null;

    // Primary 0ms read: FileReader.readAsDataURL(file)
    if (typeof FileReader !== 'undefined' && file instanceof Blob) {
      try {
        rawDataUrl = await readFileAsDataUrlDirect(file, mime);
      } catch (frErr) {
        lastReadErr = frErr;
        rawDataUrl = '';
        console.warn('[PhotoPipeline] Direct FileReader.readAsDataURL failed, trying ArrayBuffer fallback:', frErr?.message || frErr);
        try {
          const ab = await readFileAsArrayBufferDirect(file);
          memoryBlob = new Blob([ab], { type: mime });
          rawDataUrl = await readBlobAsDataUrl(memoryBlob, mime);
        } catch (abFrErr) {
          lastReadErr = abFrErr;
        }
      }
    }

    // Secondary 0ms read: file.arrayBuffer() (with 1 immediate retry if the first call fails)
    if (!rawDataUrl && !memoryBlob && typeof file.arrayBuffer === 'function') {
      let arrayBuffer = null;
      try {
        arrayBuffer = await file.arrayBuffer();
      } catch (firstAbErr) {
        lastReadErr = firstAbErr;
        console.warn('[PhotoPipeline] 1st arrayBuffer read failed, retrying once:', firstAbErr?.message || firstAbErr);
        try {
          arrayBuffer = await file.arrayBuffer();
        } catch (secondAbErr) {
          lastReadErr = secondAbErr;
        }
      }

      if (arrayBuffer) {
        if (arrayBuffer.byteLength === 0) {
          throw new Error('The selected photo is empty');
        }
        memoryBlob = new Blob([arrayBuffer], { type: mime });
        arrayBuffer = null;
        rawDataUrl = await readBlobAsDataUrl(memoryBlob, mime);
      }
    }

    if (!rawDataUrl && !memoryBlob && !fallbackObjectUrl) {
      throw lastReadErr || new Error('The selected photo could not be read');
    }

    checkpoint();

    // Step B (350ms): ONLY AFTER the bytes are safely read into RAM, pause so the mobile browser's
    // GPU/Canvas/WebGL context finishes waking up after closing the system Photo Picker.
    if (wakeupDelayMs > 0) {
      await sleep(wakeupDelayMs);
      checkpoint();
    }

    // GIF: preserve original animation bytes
    if (mime === 'image/gif' && (rawDataUrl || memoryBlob)) {
      const gifDataUrl = rawDataUrl || await readBlobAsDataUrl(memoryBlob, mime);
      const gifBlob = memoryBlob || dataUrlToBlob(gifDataUrl);
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
          mime,
          aiResult: null,
        });
      }
      return {
        previewUrl: gifDataUrl,
        uploadFile: new File([gifBlob], uploadFileName, { type: mime }),
        previewFailed: false,
        mime,
        fromCache: false,
        cachedAiResult: null,
      };
    }

    // Step C: decode + downscale into an 800px `<canvas>` (JPEG 0.82), then immediately free raw buffers
    try {
      const { jpegDataUrl, jpegBlob } = await decode({
        rawDataUrl,
        memoryBlob,
        fallbackObjectUrl,
        maxDim,
        quality,
      });
      // Immediately drop the multi-megabyte raw data URL / Blob so GC frees them right away
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
          aiResult: null,
        });
      }

      return {
        previewUrl: jpegDataUrl,
        uploadFile: new File([jpegBlob], uploadFileName, { type: 'image/jpeg' }),
        previewFailed: false,
        mime: 'image/jpeg',
        fromCache: false,
        cachedAiResult: null,
      };
    } catch (decodeErr) {
      if (decodeErr instanceof PhotoPipelineCancelled) throw decodeErr;
      checkpoint();

      // If the raw bytes were read into RAM (e.g. an undecodable HEIC on Android), preserve them for upload
      const fallbackBlob = memoryBlob || (rawDataUrl ? dataUrlToBlob(rawDataUrl) : null);
      rawDataUrl = '';
      memoryBlob = null;
      if (fallbackBlob) {
        console.warn('[PhotoPipeline] Browser cannot decode this format, uploading original bytes:', decodeErr?.message || decodeErr);
        const uploadFileName = file?.name || 'photo';
        if (useCache) {
          setInSessionCache(file, {
            previewUrl: '',
            blob: fallbackBlob,
            uploadFileName,
            previewFailed: true,
            mime,
            aiResult: { hasPerson: false, hasAnimal: true, detectedSpecies: '', checkStatus: 'skipped' },
          });
        }
        return {
          previewUrl: '',
          uploadFile: new File([fallbackBlob], uploadFileName, { type: mime }),
          previewFailed: true,
          mime,
          fromCache: false,
          cachedAiResult: null,
        };
      }
      throw lastReadErr || decodeErr;
    }
  } finally {
    revokeTrackedObjectUrl(fallbackObjectUrl);
  }
}
