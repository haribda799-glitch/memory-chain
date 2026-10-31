// ============================================================
// Sequential photo preparation pipeline (Android Chrome safe)
// ============================================================
//
// Why this exact order:
// 1. On Android Chrome and MetaMask WebView, a picked `File` is backed by a temporary `content://`
//    descriptor from the system Photo Picker. Waiting 400ms or unmounting `<input type="file">` BEFORE
//    starting the read revokes that descriptor and triggers `NotReadableError`.
// 2. Therefore, Step A starts reading the file into RAM IMMEDIATELY at 0ms (synchronously on the
//    `onChange` tick) via `FileReader.readAsDataURL(file)` -> `file.arrayBuffer()` fallback, while also
//    capturing an immediate `URL.createObjectURL(file)` fallback handle.
// 3. Once the bytes are safely in RAM, Step B pauses 400ms (`PHOTO_WAKEUP_DELAY_MS`) so the mobile
//    browser finishes resuming its GPU/Canvas/WebGL context after the Photo Picker closes, before any
//    `new Image()`, `<canvas>`, or TF.js work runs.

export const PHOTO_WAKEUP_DELAY_MS = 400;   // Step B: let Chrome/WebView GPU resume after bytes are in RAM
export const DECODE_RETRY_DELAY_MS = 400;   // Pause before the decode fallback retry
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

/**
 * Initiates a direct `FileReader.readAsDataURL(file)` synchronously on the current tick.
 * Most reliable primary reader for `content://` URIs in Android Chrome and in-app WebViews.
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

/** In-memory Blob -> normalized `data:image/...;base64` URL (FileReader with base64 fallback). */
export async function readBlobAsDataUrl(blob, mimeHint = blob?.type || 'image/jpeg') {
  if (typeof FileReader !== 'undefined' && blob instanceof Blob) {
    try {
      return await readFileAsDataUrlDirect(blob, mimeHint);
    } catch (err) {
      console.warn('[PhotoPipeline] FileReader failed on Blob, using base64 fallback:', err?.message || err);
    }
  }
  // The Blob lives in RAM, so reading it via arrayBuffer is safe
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
 * Step C: decode the image from `rawDataUrl` (falling back to a fresh object URL of `memoryBlob`
 * or `fallbackObjectUrl`), draw it on a canvas (longest side <= maxDim), and export a clean JPEG.
 * The canvas memory is released in `finally`, on success AND on failure.
 */
export async function renderToJpeg({
  rawDataUrl,
  memoryBlob,
  fallbackObjectUrl = '',
  maxDim,
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
        objectUrl = URL.createObjectURL(memoryBlob);
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

    const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
    if (!jpegDataUrl || !jpegDataUrl.startsWith('data:image/jpeg;base64,')) {
      throw new Error('Canvas produced an empty JPEG');
    }
    return { jpegDataUrl, jpegBlob: dataUrlToBlob(jpegDataUrl), width: canvas.width, height: canvas.height };
  } finally {
    releaseCanvas(canvas);
    disposeImageElement(img);
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
    }
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
 * Strictly sequential photo preparation:
 *   Step A (0ms, synchronous start): capture `fallbackObjectUrl` and immediately read the picker File
 *          into RAM (`FileReader.readAsDataURL(file)` -> `file.arrayBuffer()` fallback) while the
 *          Android `content://` grant is fresh.
 *   Step B (400ms wakeup pause): wait for the mobile browser's GPU/Canvas context to settle after
 *          closing the system Photo Picker.
 *   Step C: decode + downscale + export a clean JPEG data URL (+ Blob for upload); canvas released.
 *
 * @param {File} file
 * @param {{
 *   isCurrent?: () => boolean,
 *   maxDim: number,
 *   quality?: number,
 *   wakeupDelayMs?: number,
 *   decode?: typeof renderToJpeg,   // injectable for unit tests
 * }} options
 * @returns {Promise<{ previewUrl: string, uploadFile: File, previewFailed: boolean, mime: string }>}
 */
export async function preparePhotoSequentially(file, {
  isCurrent = () => true,
  maxDim,
  quality = PREVIEW_JPEG_QUALITY,
  wakeupDelayMs = PHOTO_WAKEUP_DELAY_MS,
  decode = renderToJpeg,
} = {}) {
  const checkpoint = () => {
    if (!isCurrent()) throw new PhotoPipelineCancelled();
  };
  checkpoint();

  if (!file || file.size === 0) {
    throw new Error('The selected photo is empty');
  }

  const mime = guessImageMime(file);

  // Step A.1 (0ms): create an immediate object URL handle before any async gap
  let fallbackObjectUrl = '';
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && file instanceof Blob) {
      fallbackObjectUrl = URL.createObjectURL(file);
    }
  } catch {
    // ignore if unavailable
  }

  try {
    // Step A.2 (0ms): start reading the picker File into RAM immediately on the current tick
    let rawDataUrl = '';
    let memoryBlob = null;
    let lastReadErr = null;

    // Primary read path: direct FileReader.readAsDataURL(file)
    if (typeof FileReader !== 'undefined' && file instanceof Blob) {
      try {
        rawDataUrl = await readFileAsDataUrlDirect(file, mime);
        memoryBlob = dataUrlToBlob(rawDataUrl);
      } catch (frErr) {
        lastReadErr = frErr;
        rawDataUrl = '';
        memoryBlob = null;
        console.warn('[PhotoPipeline] Direct FileReader failed, trying arrayBuffer fallback:', frErr?.message || frErr);
      }
    }

    // Secondary read path: file.arrayBuffer() (with one immediate retry if the first read fails)
    if (!memoryBlob && typeof file.arrayBuffer === 'function') {
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

    if (!memoryBlob && !rawDataUrl && !fallbackObjectUrl) {
      throw lastReadErr || new Error('The selected photo could not be read');
    }

    checkpoint();

    // Step B: now that the file bytes are in RAM (or fallbackObjectUrl is captured), wait for the
    // mobile browser's GPU / Canvas / WebGL context to finish waking up after the Photo Picker closes.
    if (wakeupDelayMs > 0) {
      await sleep(wakeupDelayMs);
      checkpoint();
    }

    // GIF: keep the original bytes (a canvas would drop the animation)
    if (mime === 'image/gif' && (rawDataUrl || memoryBlob)) {
      const gifDataUrl = rawDataUrl || await readBlobAsDataUrl(memoryBlob, mime);
      checkpoint();
      return {
        previewUrl: gifDataUrl,
        uploadFile: new File([memoryBlob || file], file?.name || 'photo.gif', { type: mime }),
        previewFailed: false,
        mime,
      };
    }

    // Step C: decode + downscale + export a clean JPEG data URL (+ Blob for upload)
    try {
      const { jpegDataUrl, jpegBlob } = await decode({
        rawDataUrl,
        memoryBlob,
        fallbackObjectUrl,
        maxDim,
        quality,
      });
      rawDataUrl = '';
      checkpoint();
      return {
        previewUrl: jpegDataUrl,
        uploadFile: new File([jpegBlob], `${baseName(file)}.jpg`, { type: 'image/jpeg' }),
        previewFailed: false,
        mime: 'image/jpeg',
      };
    } catch (decodeErr) {
      if (decodeErr instanceof PhotoPipelineCancelled) throw decodeErr;
      checkpoint();
      // If the file bytes were read into RAM (e.g. raw HEIC that Android Chrome cannot decode),
      // never block the user — preserve the original bytes for upload and show the ready badge.
      if (memoryBlob) {
        console.warn('[PhotoPipeline] Browser cannot decode this format, uploading original bytes:', decodeErr?.message || decodeErr);
        return {
          previewUrl: '',
          uploadFile: new File([memoryBlob], file?.name || 'photo', { type: mime }),
          previewFailed: true,
          mime,
        };
      }
      throw lastReadErr || decodeErr;
    }
  } finally {
    if (fallbackObjectUrl) {
      try {
        URL.revokeObjectURL(fallbackObjectUrl);
      } catch {
        // ignore
      }
    }
  }
}
