// ============================================================
// Lightweight native photo preparation pipeline (Android safe)
// ============================================================
//
// Why this architecture prevents OOM / NotReadableError after 8-10 selections:
// 1. NEVER read the raw multi-megabyte camera File (5-12 MB) into a huge UTF-16 Base64 string via
//    `FileReader.readAsDataURL(file)` or copy full raw buffers in JS heap.
// 2. At 0ms, create only a lightweight `rawObjectUrl = URL.createObjectURL(file)`.
// 3. Pause 350ms (`PHOTO_WAKEUP_DELAY_MS`) so the mobile browser restores its graphics context after
//    the system Photo Picker closes.
// 4. Decode directly in browser C++ memory and draw straight into an 800px `<canvas>` (JPEG 0.82):
//    - Attempt 1: native `createImageBitmap(file)` -> draw to 800px canvas -> `bitmap.close()` immediately.
//    - Attempt 2: `new Image()` with `src = rawObjectUrl` (with 1 automatic retry after 400ms) -> draw to
//      800px canvas.
//    - Immediately after drawing to `<canvas>`, call `URL.revokeObjectURL(rawObjectUrl)`!
// 5. Export compact `jpegBlob` (~70-100 KB via `canvas.toBlob(..., 'image/jpeg', 0.82)`) and short
//    `previewDataUrl = canvas.toDataURL('image/jpeg', 0.82)`, then immediately zero the canvas
//    (`canvas.width = 0; canvas.height = 0;`).

export const PHOTO_WAKEUP_DELAY_MS = 350;   // Step b: let mobile GPU/Canvas context settle after picker closes
export const DECODE_RETRY_DELAY_MS = 400;   // Pause before the single Image() decode retry
export const PREVIEW_MAX_DIMENSION = 800;   // Max 800px longest side for preview & upload
export const PREVIEW_JPEG_QUALITY = 0.82;   // Compact 0.82 JPEG quality (~70-100 KB)

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

/** Synchronous compact `data:` URL -> Blob fallback when `canvas.toBlob` is unavailable. */
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
 * Step c & d: decode directly in C++ memory via `createImageBitmap(file)` (or `new Image()` with
 * `src = rawObjectUrl` + 1 retry after 400ms), draw onto a max 800px `<canvas>`, immediately close
 * the bitmap and revoke `rawObjectUrl`, export compact `jpegBlob` (0.82) + `previewDataUrl` (0.82),
 * and immediately zero the canvas (`width = 0; height = 0`).
 */
export async function renderToJpeg({
  file,
  rawObjectUrl = '',
  maxDim = PREVIEW_MAX_DIMENSION,
  quality = PREVIEW_JPEG_QUALITY,
  retryDelayMs = DECODE_RETRY_DELAY_MS,
}) {
  let bitmap = null;
  let img = null;
  let retryObjectUrl = '';
  let canvas = null;
  try {
    let source = null;
    let width = 0;
    let height = 0;
    let lastDecodeErr = null;

    // Attempt 1: native C++ createImageBitmap(file)
    if (typeof createImageBitmap === 'function' && file) {
      try {
        bitmap = await createImageBitmap(file);
        width = bitmap.width;
        height = bitmap.height;
        if (width > 0 && height > 0) {
          source = bitmap;
        } else {
          try { bitmap.close?.(); } catch {}
          bitmap = null;
        }
      } catch (bmpErr) {
        lastDecodeErr = bmpErr;
        bitmap = null;
      }
    }

    // Attempt 2: new Image() with src = rawObjectUrl (with 1 automatic retry after 400ms)
    if (!source) {
      const primaryUrl = rawObjectUrl || (file instanceof Blob ? createTrackedObjectUrl(file) : '');
      if (primaryUrl) {
        try {
          img = await loadImageElement(primaryUrl);
        } catch (firstErr) {
          lastDecodeErr = firstErr;
          console.warn('[PhotoPipeline] 1st Image decode failed, retrying after 400ms:', firstErr?.message || firstErr);
          if (retryDelayMs > 0) await sleep(retryDelayMs);
          retryObjectUrl = file instanceof Blob ? createTrackedObjectUrl(file) : primaryUrl;
          try {
            img = await loadImageElement(retryObjectUrl || primaryUrl);
          } catch (secondErr) {
            lastDecodeErr = secondErr;
          }
        }
        if (img) {
          width = img.naturalWidth || img.width;
          height = img.naturalHeight || img.height;
          if (width > 0 && height > 0) {
            source = img;
          }
        }
      }
    }

    if (!source || !width || !height) {
      throw lastDecodeErr || new Error('Image decode failed');
    }

    const scale = Math.min(1, maxDim / Math.max(width, height));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha: avoid black backgrounds for transparent PNGs
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    // Immediately free C++ bitmap / Image element and revoke object URLs right after drawing to canvas
    if (bitmap) {
      try { bitmap.close?.(); } catch {}
      bitmap = null;
    }
    if (img) {
      disposeImageElement(img);
      img = null;
    }
    revokeTrackedObjectUrl(rawObjectUrl);
    revokeTrackedObjectUrl(retryObjectUrl);

    const previewDataUrl = canvas.toDataURL('image/jpeg', quality);
    if (!previewDataUrl || !previewDataUrl.startsWith('data:image/jpeg;base64,')) {
      throw new Error('Canvas produced an empty JPEG');
    }

    let jpegBlob = null;
    if (typeof canvas.toBlob === 'function') {
      jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    }
    if (!jpegBlob) {
      jpegBlob = dataUrlToBlob(previewDataUrl);
    }

    const outWidth = canvas.width;
    const outHeight = canvas.height;
    releaseCanvas(canvas);
    canvas = null;

    return {
      jpegDataUrl: previewDataUrl,
      jpegBlob,
      width: outWidth,
      height: outHeight,
    };
  } finally {
    releaseCanvas(canvas);
    if (bitmap) {
      try { bitmap.close?.(); } catch {}
    }
    disposeImageElement(img);
    revokeTrackedObjectUrl(rawObjectUrl);
    revokeTrackedObjectUrl(retryObjectUrl);
  }
}

/**
 * Small canvas (longest side <= maxDim) of the already-downsized 800px previewDataUrl, for TF.js.
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
 * Verifies that a file handle is readable (used only when canvas decode fails, to distinguish an
 * unsupported format like HEIC from a revoked/unreadable file descriptor). Reads at most 16 bytes.
 */
async function assertFileReadable(file) {
  if (!file || file.size === 0) {
    throw new Error('The selected photo is empty');
  }
  if (typeof file.slice === 'function') {
    const slice = file.slice(0, 16);
    if (slice && typeof slice.arrayBuffer === 'function') {
      const buf = await slice.arrayBuffer();
      if (!buf || buf.byteLength === 0) throw new Error('The selected photo is empty');
      return;
    }
  }
  if (typeof file.arrayBuffer === 'function') {
    const buf = await file.arrayBuffer();
    if (!buf || buf.byteLength === 0) throw new Error('The selected photo is empty');
  }
}

/**
 * Lightweight native photo preparation pipeline:
 *   a) At 0ms, create only `rawObjectUrl = URL.createObjectURL(file)`.
 *   b) Wait 350ms (`wakeupDelayMs`) for the mobile browser to restore its graphics context.
 *   c) Decode in C++ memory (`createImageBitmap(file)` -> `new Image(rawObjectUrl)` fallback) and
 *      draw into an 800px `<canvas>`, immediately closing the bitmap and revoking `rawObjectUrl`.
 *   d) Export compact `jpegBlob` (0.82) + `previewDataUrl` (0.82) and zero the canvas.
 *
 * @param {File} file
 * @param {{
 *   isCurrent?: () => boolean,
 *   maxDim?: number,
 *   quality?: number,
 *   wakeupDelayMs?: number,
 *   decode?: typeof renderToJpeg,   // injectable for unit tests
 * }} options
 * @returns {Promise<{ previewUrl: string, uploadFile: File, previewFailed: boolean, mime: string }>}
 */
export async function preparePhotoSequentially(file, {
  isCurrent = () => true,
  maxDim = PREVIEW_MAX_DIMENSION,
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

  // Step a (0ms): create only a lightweight object URL handle (zero Base64 / zero buffer copy in RAM)
  const rawObjectUrl = file instanceof Blob ? createTrackedObjectUrl(file) : '';

  try {
    // Step b (350ms): wait for the mobile browser's graphics context to settle after closing the gallery
    if (wakeupDelayMs > 0) {
      await sleep(wakeupDelayMs);
      checkpoint();
    }

    // Step c & d: native decode -> 800px canvas (JPEG 0.82) -> immediate revokeObjectURL & canvas release
    try {
      const { jpegDataUrl, jpegBlob } = await decode({
        file,
        rawObjectUrl,
        maxDim,
        quality,
      });
      revokeTrackedObjectUrl(rawObjectUrl);
      checkpoint();
      return {
        previewUrl: jpegDataUrl,
        uploadFile: new File([jpegBlob], `${baseName(file)}.jpg`, { type: 'image/jpeg' }),
        previewFailed: false,
        mime: 'image/jpeg',
      };
    } catch (decodeErr) {
      revokeTrackedObjectUrl(rawObjectUrl);
      if (decodeErr instanceof PhotoPipelineCancelled) throw decodeErr;
      checkpoint();

      // Verify whether the file descriptor is alive (e.g. unsupported HEIC vs NotReadableError)
      await assertFileReadable(file);
      checkpoint();

      console.warn('[PhotoPipeline] Browser cannot decode this format, preserving original file:', decodeErr?.message || decodeErr);
      const uploadFile = file instanceof File
        ? file
        : new File([file], file?.name || 'photo', { type: mime });
      return {
        previewUrl: '',
        uploadFile,
        previewFailed: true,
        mime,
      };
    }
  } finally {
    revokeTrackedObjectUrl(rawObjectUrl);
  }
}
