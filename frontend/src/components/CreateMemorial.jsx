import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChainId, useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useBalance, useSwitchChain, usePublicClient } from 'wagmi';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { formatEther, decodeEventLog } from 'viem';
import { baseSepolia } from 'viem/chains';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress, getExplorerUrl } from '../config/chains';
import {
  uploadToArweave, uploadJsonToArweave, buildNftMetadata,
} from '../utils/arweave';
import { formatTxError, isUserRejection } from '../utils/txErrors';
import {
  isMobileWithoutEthereum,
  getMetaMaskDappDeepLink,
  getActiveWalletChainId,
  setTxInProgress,
} from '../utils/mobileWallet';
import ShareModal from './ShareModal';

const SPECIES_OPTIONS = ['Dog', 'Cat', 'Horse', 'Fish', 'Rabbit', 'Hamster', 'Turtle', 'Other'];

const STEPS = ['Basic Info', 'Story', 'Preservation'];

/* ── Minimal underline input ──────────────────────────────── */
const inputBase = 'w-full bg-transparent border-b border-[#d8c2ba] focus:border-[#8a4f36] focus:ring-0 outline-none px-0 py-2 text-[18px] leading-7 text-[#1b1c1a] placeholder-[#85736d] transition-colors';
const labelBase = 'block text-[11px] font-semibold tracking-widest uppercase text-[#53433e] mb-2';

/* ── Photo processing constants ───────────────────────────── */
const MAX_RAW_PHOTO_BYTES = 30 * 1024 * 1024; // raw phone photos can be huge; we compress below
const MAX_IMAGE_DIMENSION = 1000;             // px, longest side after compression
const COMPRESSION_QUALITY = 0.8;              // JPEG compression quality (0.75 - 0.8)
const AI_CHECK_COLD_TIMEOUT_MS = 15000;       // 15s timeout for cold start while models download
const AI_CHECK_WARM_TIMEOUT_MS = 5000;        // 5s timeout for warm start once models are cached

const THUMBNAIL_MAX_DIM = 800;
const THUMBNAIL_QUALITY = 0.85;
const TAB_WAKEUP_DELAY_MS = 180;              // 150-200ms pause after rAF so Android Chrome restores GPU/Canvas/WebGL context after Photo Picker
const RETRY_DELAY_MS = 350;                   // 350ms delay before automatic silent retry of image decode / AI check

/* ── On-chain / validation constants ───────────────────────── */
const MAX_PET_NAME_BYTES = 128;                // Vyper String[128] limits UTF-8 BYTES, not characters
const MIN_YEAR = 1900;
const GAS_BUFFER_WEI = 50_000_000_000_000n;    // 0.00005 ETH fallback gas reserve when estimation is unavailable
const ARWEAVE_URI_PLACEHOLDER = 'x'.repeat(43); // Same length as a real Arweave tx id (used for pre-upload gas estimation)
const INSUFFICIENT_FUNDS_MESSAGE = 'Insufficient Base Sepolia ETH to cover the creation fee plus network fees. Top up your wallet from a faucet and try again.';
const UNCONFIRMED_TX_MESSAGE = 'We could not confirm the transaction yet. It may still succeed — please check the block explorer before retrying.';
const EXPLORER_BASE_URL = getExplorerUrl(baseSepolia.id);

function getUtf8ByteLength(value) {
  return new TextEncoder().encode(value || '').length;
}

/** Returns an English error message, or '' when the (trimmed) pet name can be stored on-chain. */
function validatePetName(rawName) {
  const name = (rawName || '').trim();
  if (!name) return 'Pet name is required';
  if (getUtf8ByteLength(name) > MAX_PET_NAME_BYTES) {
    return `Name is too long for on-chain storage (max ${MAX_PET_NAME_BYTES} bytes). Please shorten it.`;
  }
  return '';
}

/** Today's date in the user's local timezone as YYYY-MM-DD (matches <input type="date"> values). */
function getTodayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates the Story step (dates + years). Returns an English error message, or '' when valid. */
function validateStoryFields({ birthDate, memorialDate, birthYear, passingYear }) {
  const todayISO = getTodayISO();
  const currentYear = new Date().getFullYear();
  const minDateISO = `${MIN_YEAR}-01-01`;

  const checkDate = (value, label) => {
    if (!value) return '';
    if (!ISO_DATE_RE.test(value)) return `${label} is not a valid date.`;
    if (value > todayISO) return `${label} cannot be in the future.`;
    if (value < minDateISO) return `${label} cannot be earlier than ${MIN_YEAR}.`;
    return '';
  };
  const parseYear = (value, label) => {
    const raw = String(value ?? '').trim();
    if (!raw) return { year: null, error: '' };
    const rangeError = `${label} must be a whole number between ${MIN_YEAR} and ${currentYear}.`;
    if (!/^\d{4}$/.test(raw)) return { year: null, error: rangeError };
    const year = Number(raw);
    if (year < MIN_YEAR || year > currentYear) return { year: null, error: rangeError };
    return { year, error: '' };
  };

  const birthDateError = checkDate(birthDate, 'Birth date');
  if (birthDateError) return birthDateError;
  const memorialDateError = checkDate(memorialDate, 'Memorial date');
  if (memorialDateError) return memorialDateError;
  if (birthDate && memorialDate && birthDate > memorialDate) {
    return 'Birth date must be on or before the memorial date.';
  }

  const birth = parseYear(birthYear, 'Birth year');
  if (birth.error) return birth.error;
  const passing = parseYear(passingYear, 'Passing year');
  if (passing.error) return passing.error;

  const birthDateYear = birthDate ? Number(birthDate.slice(0, 4)) : null;
  const memorialDateYear = memorialDate ? Number(memorialDate.slice(0, 4)) : null;
  if (birth.year !== null && birthDateYear !== null && birth.year !== birthDateYear) {
    return `Birth year (${birth.year}) does not match the birth date (${birthDate}).`;
  }
  if (passing.year !== null && memorialDateYear !== null && passing.year !== memorialDateYear) {
    return `Passing year (${passing.year}) does not match the memorial date (${memorialDate}).`;
  }

  const effectiveBirthYear = birthDateYear ?? birth.year;
  const effectivePassingYear = memorialDateYear ?? passing.year;
  if (effectiveBirthYear !== null && effectivePassingYear !== null && effectiveBirthYear > effectivePassingYear) {
    return 'Birth year must be on or before the passing year.';
  }
  return '';
}

/**
 * Normalize a FileReader Data URL when Android Photo Picker / content:// providers
 * supply an empty MIME type (`data:;base64,...` or `data:application/octet-stream;base64,...`).
 */
function normalizeImageDataUrl(dataUrl, file) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return '';
  if (dataUrl.startsWith('data:image/')) return dataUrl;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return dataUrl;
  const header = dataUrl.slice(0, commaIdx);
  if (!header.includes(';base64')) return dataUrl;
  const name = (file?.name || '').toLowerCase();
  let mime = 'image/jpeg';
  if (name.endsWith('.png')) mime = 'image/png';
  else if (name.endsWith('.webp')) mime = 'image/webp';
  else if (name.endsWith('.gif')) mime = 'image/gif';
  else if (name.endsWith('.bmp')) mime = 'image/bmp';
  else if (name.endsWith('.heic')) mime = 'image/heic';
  else if (name.endsWith('.heif')) mime = 'image/heif';
  return `data:${mime};base64,${dataUrl.slice(commaIdx + 1)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for requestAnimationFrame + a short pause (150-200ms) so mobile Chrome
 * finishes waking up its graphics/Canvas/WebGL context after returning from the system Photo Picker.
 */
function waitForTabWakeup(delayMs = TAB_WAKEUP_DELAY_MS) {
  return new Promise((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        setTimeout(resolve, delayMs);
      };
      const rafFallback = setTimeout(done, 120);
      window.requestAnimationFrame(() => {
        clearTimeout(rafFallback);
        done();
      });
    } else {
      setTimeout(resolve, delayMs);
    }
  });
}

function readFileAsDataUrlOnce(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const normalized = normalizeImageDataUrl(reader.result, file);
      if (normalized && normalized.startsWith('data:image/')) {
        resolve(normalized);
      } else {
        reject(new Error('FileReader returned empty or non-image Data URL'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Reads a File into a normalized `data:image/...` URL via FileReader,
 * automatically retrying after 350ms if the first read fails while Android wakes up.
 */
async function readFileAsDataUrlWithRetry(file) {
  try {
    return await readFileAsDataUrlOnce(file);
  } catch (err1) {
    console.warn('[CreateMemorial] FileReader 1st attempt failed, retrying after 350ms:', err1?.message || err1);
    await sleep(RETRY_DELAY_MS);
    return await readFileAsDataUrlOnce(file);
  }
}

/**
 * Helper to load a URL (Data URL or ObjectURL) into an HTMLImageElement via standard onload
 * (never calling img.decode(), which throws EncodingError on valid JPEG/WebP on Android Chrome)
 * and downscale it on a 2D Canvas.
 */
function renderUrlToCanvasJpeg(srcUrl, maxDim, quality, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      reject(new Error('Image load timeout'));
    }, timeoutMs);

    img.onload = () => {
      clearTimeout(timer);
      try {
        const nw = img.naturalWidth || img.width;
        const nh = img.naturalHeight || img.height;
        if (!nw || !nh) {
          reject(new Error('Invalid image dimensions'));
          return;
        }
        const scale = Math.min(1, maxDim / Math.max(nw, nh));
        const w = Math.max(1, Math.round(nw * scale));
        const h = Math.max(1, Math.round(nh * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 2D context unavailable'));
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const res = canvas.toDataURL('image/jpeg', quality);
        canvas.width = 0;
        canvas.height = 0;
        img.onload = null;
        img.onerror = null;
        if (res && res.startsWith('data:image/jpeg;base64,')) {
          resolve(res);
        } else {
          reject(new Error('Canvas toDataURL produced empty output'));
        }
      } catch (e) {
        reject(e);
      }
    };

    img.onerror = () => {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      reject(new Error('Image load error'));
    };

    img.src = srcUrl;
  });
}

async function renderUrlToCanvasJpegWithRetry(srcUrl, maxDim, quality, timeoutMs = 8000) {
  try {
    return await renderUrlToCanvasJpeg(srcUrl, maxDim, quality, timeoutMs);
  } catch (err1) {
    console.warn('[CreateMemorial] Canvas decode 1st attempt failed, retrying after 350ms:', err1?.message || err1);
    await sleep(RETRY_DELAY_MS);
    return await renderUrlToCanvasJpeg(srcUrl, maxDim, quality, timeoutMs);
  }
}

// Non-blocking fallback SVG preview used only when an exotic mobile format (e.g. raw HEIC)
// cannot be rendered by the browser's <img> tag, while still allowing the file to be uploaded.
const FALLBACK_PORTRAIT_SVG_DATA_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">' +
      '<rect width="600" height="400" fill="#f5f3f0"/>' +
      '<circle cx="300" cy="175" r="44" fill="#ebdcd1"/>' +
      '<path d="M286 168c0-8 6-14 14-14s14 6 14 14-6 14-14 14-14-6-14-14zm-18 36c6-12 18-18 32-18s26 6 32 18" stroke="#8a4f36" stroke-width="4" fill="none" stroke-linecap="round"/>' +
      '<text x="300" y="255" text-anchor="middle" font-family="Georgia, serif" font-size="18" fill="#53433e">Portrait Selected &amp; Ready</text>' +
      '<text x="300" y="282" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#85736d">Your photo will be preserved on-chain</text>' +
    '</svg>'
  );

/**
 * Universal multi-stage proportional thumbnail generator (Data URL max 800px) with automatic retry:
 * - Attempt 1: FileReader.readAsDataURL(file) + renderUrlToCanvasJpegWithRetry (with 350ms retry)
 * - Attempt 2: URL.createObjectURL(file) + renderUrlToCanvasJpegWithRetry (with 350ms retry)
 * - Attempt 3: Always preserve the valid FileReader rawDataUrl if Canvas resize failed, never replacing
 *   a valid FileReader Data URL with the SVG placeholder.
 */
async function generateThumbnail(
  file,
  maxDim = THUMBNAIL_MAX_DIM,
  quality = THUMBNAIL_QUALITY,
  registerObjectUrl = null,
  preloadedRawDataUrl = ''
) {
  if (!file || file.size === 0) return null;

  let rawDataUrl = preloadedRawDataUrl || '';
  let rawObjectUrl = '';

  // Attempt 1: FileReader Data URL + Canvas resize (with automatic 350ms retry)
  try {
    if (!rawDataUrl) {
      rawDataUrl = await readFileAsDataUrlWithRetry(file);
    }
    if (rawDataUrl) {
      if (file.type === 'image/gif') {
        return rawDataUrl;
      }
      const resizedFromDataUrl = await renderUrlToCanvasJpegWithRetry(rawDataUrl, maxDim, quality);
      if (resizedFromDataUrl) {
        return resizedFromDataUrl;
      }
    }
  } catch (err1) {
    console.warn('[CreateMemorial] Thumbnail Attempt 1 (FileReader + Canvas) note:', err1?.message || err1);
  }

  // Attempt 2: URL.createObjectURL(file) + Canvas resize (with automatic 350ms retry)
  try {
    rawObjectUrl = URL.createObjectURL(file);
    if (typeof registerObjectUrl === 'function') {
      registerObjectUrl(rawObjectUrl);
    }
    if (file.type === 'image/gif') {
      return rawDataUrl || rawObjectUrl;
    }
    const resizedFromObjectUrl = await renderUrlToCanvasJpegWithRetry(rawObjectUrl, maxDim, quality);
    if (resizedFromObjectUrl) {
      return resizedFromObjectUrl;
    }
  } catch (err2) {
    console.warn('[CreateMemorial] Thumbnail Attempt 2 (ObjectURL + Canvas) note:', err2?.message || err2);
  }

  // Attempt 3: Always prefer the real FileReader Data URL over any fallback so <img> renders the real photo
  if (rawDataUrl) {
    return rawDataUrl;
  }
  if (rawObjectUrl) {
    return rawObjectUrl;
  }
  try {
    const fallbackObjectUrl = URL.createObjectURL(file);
    if (typeof registerObjectUrl === 'function') {
      registerObjectUrl(fallbackObjectUrl);
    }
    return fallbackObjectUrl;
  } catch {
    return FALLBACK_PORTRAIT_SVG_DATA_URL;
  }
}

/**
 * Downscale a photo via Canvas (max 1000px, JPEG 0.8) for Arweave payload.
 * Runs right before upload so it never blocks the UI or exhausts phone memory during form editing.
 * Falls back to the original file on any failure and never throws.
 */
async function resizeImage(file, maxWidth = MAX_IMAGE_DIMENSION, maxHeight = MAX_IMAGE_DIMENSION, quality = COMPRESSION_QUALITY) {
  try {
    if (!file || file.type === 'image/gif') return file;
    const isImage = Boolean(file.type?.startsWith('image/') || /\.(jpe?g|png|webp|bmp|heic|heif)$/i.test(file.name || ''));
    if (!isImage) return file;

    // Small files under 1.5 MB don't require downscaling
    if (file.size <= 1.5 * 1024 * 1024) return file;

    let source = null;
    let width = 0;
    let height = 0;
    let cleanup = () => {};

    // 1. Try createImageBitmap with hardware downsampling to avoid full 50MP RAM explosion
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, {
          resizeWidth: maxWidth,
          resizeQuality: 'medium',
        });
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
        cleanup = () => bitmap.close?.();
      } catch {
        // Fall back to Image
      }
    }

    // 2. Fall back to Image via lightweight ObjectURL
    if (!source) {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('decode failed'));
          img.src = url;
        });
        source = img;
        width = img.naturalWidth;
        height = img.naturalHeight;
        cleanup = () => {
          URL.revokeObjectURL(url);
          img.onload = null;
          img.onerror = null;
          img.src = '';
        };
      } catch (err) {
        URL.revokeObjectURL(url);
        throw err;
      }
    }

    if (!width || !height) {
      cleanup();
      return file;
    }

    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    if (scale >= 1 && file.size <= 2 * 1024 * 1024) {
      cleanup();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      cleanup();
      return file;
    }
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha — avoid black backgrounds for PNGs
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    cleanup(); // Safely called AFTER drawImage

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob || blob.size >= file.size) return file;

    const baseName = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (err) {
    console.warn('[CreateMemorial] Image compression skipped, using original file fallback:', err?.message || err);
    return file;
  }
}

/* ── Module-level cache for TFJS models to prevent repeated heavy re-downloads ── */
let cachedTfReadyPromise = null;
let cachedFaceModelPromise = null;
let cachedObjectModelPromise = null;
let isAiWarm = false;

function resetAiModeration() {
  // Do not call tf.disposeVariables() to avoid destroying BlazeFace / COCO-SSD model weights
}

/**
 * Imports TF.js (registers the WebGL / CPU backends) and waits for a backend to be ready.
 * Must run before any model is loaded. A failed attempt clears the cache so the next call retries.
 */
async function ensureTfReady() {
  if (!cachedTfReadyPromise) {
    cachedTfReadyPromise = (async () => {
      try {
        const tf = await import('@tensorflow/tfjs');
        await tf.ready();
        return tf;
      } catch (err) {
        cachedTfReadyPromise = null;
        throw err;
      }
    })();
  }
  return cachedTfReadyPromise;
}

async function getFaceModel() {
  if (!cachedFaceModelPromise) {
    cachedFaceModelPromise = (async () => {
      try {
        await ensureTfReady();
        const blazeface = await import('@tensorflow-models/blazeface');
        return await blazeface.load();
      } catch (err) {
        cachedFaceModelPromise = null;
        throw err;
      }
    })();
  }
  return cachedFaceModelPromise;
}

async function getObjectModel() {
  if (!cachedObjectModelPromise) {
    cachedObjectModelPromise = (async () => {
      try {
        await ensureTfReady();
        const cocoSsd = await import('@tensorflow-models/coco-ssd');
        return await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      } catch (err) {
        cachedObjectModelPromise = null;
        throw err;
      }
    })();
  }
  return cachedObjectModelPromise;
}

async function preloadAiModels() {
  try {
    await ensureTfReady();
    await Promise.all([getFaceModel(), getObjectModel()]);
    isAiWarm = true;
  } catch (e) {
    console.warn('[AI Preload] Background warmup note:', e);
  }
}

export default function CreateMemorial() {
  const { ready, authenticated, connectWallet, login, user } = usePrivy();
  const { wallets } = useWallets();
  const chainId = useChainId();
  const navigate = useNavigate();
  const contractAddress = getContractAddress(chainId);
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: baseSepolia.id });

  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const externalWallet = wallets.find((w) => w.walletClientType !== 'privy');
  const { address: wagmiAddress, connector, chain, chainId: accountChainId } = useAccount();
  // Single source of truth for the signer: prefer the wagmi-connected account,
  // or any connected Privy wallet (external MetaMask via connectWallet() or embedded wallet).
  const activeUserAddress = wagmiAddress || externalWallet?.address || embeddedWallet?.address || wallets[0]?.address || user?.wallet?.address;
  const { data: balance } = useBalance({ address: activeUserAddress });
  const isConnected = Boolean(activeUserAddress) || (ready && authenticated);

  // Form state
  const [step, setStep] = useState(0); // Wizard step 0-2
  const [petName, setPetName] = useState('');
  const [species, setSpecies] = useState('');
  const [breed, setBreed] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [memorialDate, setMemorialDate] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [passingYear, setPassingYear] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [isPublic, setIsPublic] = useState(false);

  // AI Verification State (informational only — never blocks the wizard)
  const [checkStatus, setCheckStatus] = useState('idle'); // idle | checking | accepted | skipped
  const [detectedPerson, setDetectedPerson] = useState(false);
  const [detectedAnimal, setDetectedAnimal] = useState(true);
  const [humanConsentGiven, setHumanConsentGiven] = useState(false);

  // Submission state
  const [flowStep, setFlowStep] = useState(0); // 0=idle,1=media,2=metadata,3=minting
  const [error, setError] = useState('');
  const [isMinting, setIsMinting] = useState(false);
  const [isInitiating, setIsInitiating] = useState(false); // Immediate sync lock on click to prevent multi-mint
  const [txHash, setTxHash] = useState(null);
  const [unconfirmedTxHash, setUnconfirmedTxHash] = useState(null); // Receipt could not be confirmed (timeout / RPC)
  const [mintedIsPublic, setMintedIsPublic] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  // Synchronous submit lock (state updates are async, so double taps can slip past isInitiating)
  const submitLockRef = useRef(false);
  // Pending tx hash the user explicitly chose to override after it could not be confirmed
  const acknowledgedPendingTxRef = useRef(null);

  // Photo processing progress state (instant visual feedback on file selection)
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [photoProgress, setPhotoProgress] = useState(0);

  // Tracking in-flight AI analysis runs to discard obsolete analysis results
  const analysisRunIdRef = useRef(0);

  // Dedicated file input ref for reliable reset across repeated creations
  const fileInputRef = useRef(null);

  // Current preview URL, raw FileReader Data URL, and tracked ObjectURLs so blob URLs are NEVER revoked mid-read/render,
  // and a valid FileReader Data URL is never replaced by a placeholder unless <img> itself fails after retries.
  const previewUrlRef = useRef('');
  const rawDataUrlRef = useRef('');
  const imgErrorRetryCountRef = useRef(0);
  const [imgRetryTick, setImgRetryTick] = useState(0);
  const objectUrlsRef = useRef(new Set());

  const registerObjectUrl = useCallback((url) => {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      objectUrlsRef.current.add(url);
    }
  }, []);

  const revokeTrackedObjectUrls = useCallback((keepUrl = '') => {
    for (const url of objectUrlsRef.current) {
      if (url !== keepUrl) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore
        }
        objectUrlsRef.current.delete(url);
      }
    }
  }, []);

  // Immediate background warmup of AI models on component mount
  useEffect(() => {
    preloadAiModels();
  }, []);

  // Ensure file input has no stale browser-restored value on initial mount only
  // (never clear input.value while a file selection is being read on Android Chrome!)
  useEffect(() => {
    if (fileInputRef.current) {
      try {
        fileInputRef.current.value = '';
      } catch {}
    }
  }, []);

  useEffect(() => {
    return () => {
      revokeTrackedObjectUrls();
      previewUrlRef.current = '';
      rawDataUrlRef.current = '';
      imgErrorRetryCountRef.current = 0;
      resetAiModeration();
    };
  }, [revokeTrackedObjectUrls]);

  const handleRemoveImage = useCallback(() => {
    analysisRunIdRef.current += 1;
    revokeTrackedObjectUrls();
    previewUrlRef.current = '';
    rawDataUrlRef.current = '';
    imgErrorRetryCountRef.current = 0;
    setImgRetryTick(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setPhoto(null);
    setPreviewUrl('');
    setIsProcessingPhoto(false);
    setPhotoProgress(0);
    setError(null);
    setCheckStatus('idle');
    setDetectedPerson(false);
    setDetectedAnimal(true);
    setHumanConsentGiven(false);
  }, [revokeTrackedObjectUrls]);

  const { writeContractAsync } = useWriteContract();
  const {
    isLoading: isConfirming,
    isSuccess,
    isError: isReceiptError,
    error: receiptError,
    data: receipt,
    refetch: refetchReceipt,
  } = useWaitForTransactionReceipt({ hash: txHash, chainId: baseSepolia.id });

  // Decode created memorial tokenId from transaction logs
  const createdTokenId = useMemo(() => {
    if (!receipt?.logs) return null;
    const expectedAddress = String(contractAddress || '').toLowerCase();
    for (const log of receipt.logs) {
      // Only our contract's logs can carry the MemorialCreated event we care about
      if (!expectedAddress || String(log.address || '').toLowerCase() !== expectedAddress) continue;
      try {
        const decoded = decodeEventLog({
          abi: CONTRACT_ABI,
          eventName: 'MemorialCreated',
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'MemorialCreated' && decoded.args?.tokenId !== undefined) {
          return decoded.args.tokenId.toString();
        }
      } catch {
        // Not this event
      }
    }
    return null;
  }, [receipt, contractAddress]);

  // Draft recovery state
  const [draft, setDraft] = useState(null);

  // Persist (or clear, when `next` is null) the local draft and mirror it into state
  const persistDraft = useCallback((next) => {
    try {
      if (next) localStorage.setItem('draft_memorial', JSON.stringify(next));
      else localStorage.removeItem('draft_memorial');
    } catch (err) {
      console.warn('[Draft] Could not persist draft:', err);
    }
    setDraft(next);
  }, []);

  // Handle transaction receipt error: distinguish a real on-chain revert from a timeout / RPC failure
  useEffect(() => {
    if (!isReceiptError || !txHash) return;
    let cancelled = false;
    const failedHash = txHash;

    (async () => {
      let status = null; // 'reverted' | 'success' | null (unknown)
      try {
        const directReceipt = await publicClient?.getTransactionReceipt({ hash: failedHash });
        status = directReceipt?.status ?? null;
      } catch {
        // Receipt not found yet or RPC failure — status stays unknown
      }
      if (cancelled) return;

      if (status === 'success') {
        // The tx actually confirmed; the hook error was transient — re-query so the success flow runs.
        refetchReceipt();
        return;
      }

      const receiptErrorText = `${receiptError?.shortMessage || ''} ${receiptError?.message || ''}`;
      const isRevert = status === 'reverted' || (status === null && /reverted/i.test(receiptErrorText));

      if (isRevert) {
        let reason = formatTxError(receiptError, 'The contract rejected the transaction.');
        if (/^Network error/i.test(reason)) reason = 'The contract rejected the transaction.';
        setError(`Transaction reverted on-chain: ${reason} No memorial was created and the creation fee was not charged (only network gas was spent).`);
        setUnconfirmedTxHash(null);
        // The tx definitively failed, so the saved draft can be resumed safely without double-paying
        try {
          const saved = JSON.parse(localStorage.getItem('draft_memorial') || 'null');
          if (saved && saved.pendingTxHash === failedHash) {
            const nextDraft = { ...saved };
            delete nextDraft.pendingTxHash;
            persistDraft(nextDraft);
          }
        } catch {
          // ignore malformed draft
        }
      } else {
        // Timeout / RPC error: the tx may still be mined. Keep the draft (with its pending hash) and do NOT
        // encourage an immediate retry that could pay the creation fee twice.
        setError(UNCONFIRMED_TX_MESSAGE);
        setUnconfirmedTxHash(failedHash);
      }
      setTxHash(null);
      setIsMinting(false);
      setIsInitiating(false);
      setFlowStep(0);
    })();

    return () => {
      cancelled = true;
    };
  }, [isReceiptError, txHash, receiptError, publicClient, refetchReceipt, persistDraft]);

  // Complete reset of form state
  const resetFormState = useCallback(() => {
    analysisRunIdRef.current += 1;
    setStep(0);
    setPetName('');
    setSpecies('');
    setBreed('');
    setBirthDate('');
    setMemorialDate('');
    setBirthYear('');
    setPassingYear('');
    setDescription('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setPhoto(null);
    revokeTrackedObjectUrls();
    previewUrlRef.current = '';
    rawDataUrlRef.current = '';
    imgErrorRetryCountRef.current = 0;
    setImgRetryTick(0);
    setPreviewUrl('');
    setIsProcessingPhoto(false);
    setPhotoProgress(0);
    setIsPublic(false);
    setCheckStatus('idle');
    setDetectedPerson(false);
    setDetectedAnimal(true);
    setHumanConsentGiven(false);
    setFlowStep(0);
    setError(null);
    setIsMinting(false);
    setIsInitiating(false);
    setTxHash(null);
    setUnconfirmedTxHash(null);
    acknowledgedPendingTxRef.current = null;
    setMintedIsPublic(false);
    setShowShareModal(false);
    resetAiModeration();
  }, [revokeTrackedObjectUrls]);

  // Initialize clean state and check for saved draft on mount
  useEffect(() => {
    resetFormState();
    try {
      const saved = localStorage.getItem('draft_memorial');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.metadataTxId && parsed.petName) {
          setDraft(parsed);
        }
      }
    } catch (err) {
      console.warn('[Draft] Error loading draft:', err);
    }
  }, [resetFormState]);

  // Clear draft & photo states on successful transaction confirmation
  useEffect(() => {
    if (isSuccess) {
      persistDraft(null);
      setUnconfirmedTxHash(null);
      acknowledgedPendingTxRef.current = null;
      analysisRunIdRef.current += 1;
      if (fileInputRef.current) fileInputRef.current.value = '';
      setPhoto(null);
      revokeTrackedObjectUrls();
      previewUrlRef.current = '';
      rawDataUrlRef.current = '';
      imgErrorRetryCountRef.current = 0;
      setImgRetryTick(0);
      setPreviewUrl('');
      setIsProcessingPhoto(false);
      setPhotoProgress(0);
      setCheckStatus('idle');
      setError(null);
      resetAiModeration();
    }
  }, [isSuccess, persistDraft, revokeTrackedObjectUrls]);

  // Read creation_fee from contract
  const { data: creationFeeRaw, refetch: refetchCreationFee } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'creation_fee',
  });
  // Never fall back to a guessed fee: the contract requires msg.value == creation_fee exactly.
  const creationFee = typeof creationFeeRaw === 'bigint' ? creationFeeRaw : null;
  const isFeeKnown = creationFee !== null;
  const creationFeeLabel = isFeeKnown ? formatEther(creationFee) : '…';

  // Read creation_paused from contract (on-chain invariant guard)
  const { data: creationPaused } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'creation_paused',
  });
  const isCreationPaused = Boolean(creationPaused);

  const isInsufficientFunds = Boolean(
    isFeeKnown && balance?.value !== undefined && balance.value < creationFee + GAS_BUFFER_WEI
  );

  /* ── Non-blocking AI image check (BlazeFace + COCO-SSD) with automatic retry ── */
  const runAiCheck = useCallback(async (imageUrl) => {
    // 1. Ensure TFJS backend is ready and models are loaded
    await ensureTfReady();
    const [faceModel, objectModel] = await Promise.all([
      getFaceModel(),
      getObjectModel(),
    ]);

    const loadAiImageOnce = (src) => new Promise((resolve, reject) => {
      const candidate = new Image();
      const timer = setTimeout(() => {
        candidate.onload = null;
        candidate.onerror = null;
        reject(new Error('Timed out loading image for AI analysis'));
      }, 6000);
      candidate.onload = () => {
        clearTimeout(timer);
        resolve(candidate);
      };
      candidate.onerror = () => {
        clearTimeout(timer);
        candidate.onload = null;
        candidate.onerror = null;
        reject(new Error('Failed to load image for AI analysis'));
      };
      candidate.src = src;
    });

    let img;
    try {
      img = await loadAiImageOnce(imageUrl);
    } catch (loadErr) {
      console.warn('[AI Analysis] Image decode 1st attempt failed, retrying after 350ms:', loadErr?.message || loadErr);
      await sleep(RETRY_DELAY_MS);
      const fallbackSrc = rawDataUrlRef.current || imageUrl;
      img = await loadAiImageOnce(fallbackSrc);
    }

    let faces = [];
    let predictions = [];
    let faceFailed = false;
    let objectFailed = false;

    try {
      faces = await faceModel.estimateFaces(img, false);
    } catch (faceErr) {
      faceFailed = true;
      console.warn('[AI Analysis] Face detection warning:', faceErr);
    }

    try {
      predictions = await objectModel.detect(img);
    } catch (objErr) {
      objectFailed = true;
      console.warn('[AI Analysis] Object detection warning:', objErr);
    } finally {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    }

    if (faceFailed && objectFailed) {
      throw new Error('Both AI models failed during inference (graphics context still waking up)');
    }

    const animalClasses = ['cat', 'dog', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'];
    const detectedAnimalList = predictions.filter((p) => animalClasses.includes(p.class) && p.score >= 0.25);
    const hasAnimal = predictions.length === 0 ? true : detectedAnimalList.length > 0;

    const hasCocoPerson = predictions.some((p) => p.class === 'person' && p.score >= 0.40);
    // Real human faces in BlazeFace have confidence >= 0.90; animal muzzles (like dogs/cats) false-positive around 0.70-0.85
    const highConfidenceFaces = (faces || []).filter((f) => {
      const prob = Array.isArray(f.probability) ? f.probability[0] : (typeof f.probability === 'number' ? f.probability : 1);
      return prob >= 0.90;
    });

    const hasPerson = Boolean(hasCocoPerson || highConfidenceFaces.length > 0);

    return {
      hasPerson,
      hasAnimal,
    };
  }, []);

  /* Background AI verification pipeline: runs with dynamic timeout (cold: 15s, warm: 5s)
   * and an automatic 350ms retry if the first check fails while mobile Chrome wakes up. */
  const processSelectedImage = useCallback(async (file, imagePreviewUrl, runId) => {
    const isCurrent = () => runId === analysisRunIdRef.current;
    try {
      if (!isCurrent()) return;

      let aiUrl =
        (imagePreviewUrl && imagePreviewUrl !== FALLBACK_PORTRAIT_SVG_DATA_URL ? imagePreviewUrl : '') ||
        rawDataUrlRef.current ||
        (previewUrlRef.current && previewUrlRef.current !== FALLBACK_PORTRAIT_SVG_DATA_URL ? previewUrlRef.current : '');

      if (!aiUrl) {
        const tempUrl = URL.createObjectURL(file);
        registerObjectUrl(tempUrl);
        aiUrl = tempUrl;
      }

      const runWithTimeout = (targetUrl, timeoutMs) => Promise.race([
        runAiCheck(targetUrl).catch((err) => {
          console.warn('[AI Analysis] Attempt failed:', err?.message || err);
          return null;
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);

      const firstTimeoutMs = isAiWarm ? AI_CHECK_WARM_TIMEOUT_MS : AI_CHECK_COLD_TIMEOUT_MS;
      let result = await runWithTimeout(aiUrl, firstTimeoutMs);
      if (!isCurrent()) return;

      // Self-healing retry: if the 1st AI check attempt failed right after returning from Android Photo Picker,
      // wait 350ms for WebGL/CPU backend recovery and retry once before marking as skipped.
      if (!result) {
        console.warn('[AI Analysis] 1st attempt returned null, retrying after 350ms...');
        await sleep(RETRY_DELAY_MS);
        if (!isCurrent()) return;
        const retryUrl = rawDataUrlRef.current || aiUrl;
        const retryTimeoutMs = isAiWarm ? AI_CHECK_WARM_TIMEOUT_MS : AI_CHECK_COLD_TIMEOUT_MS;
        result = await runWithTimeout(retryUrl, retryTimeoutMs);
        if (!isCurrent()) return;
      }

      if (result) {
        isAiWarm = true;
        setDetectedPerson(Boolean(result.hasPerson));
        setDetectedAnimal(Boolean(result.hasAnimal));
        setCheckStatus('accepted');
      } else {
        console.warn('[AI Analysis] Timed out or unavailable after retry — check skipped.');
        setCheckStatus('skipped');
      }
    } catch (err) {
      console.warn('[CreateMemorial] Image processing error, check skipped:', err?.message || err);
      if (isCurrent()) setCheckStatus('skipped');
    }
  }, [runAiCheck, registerObjectUrl]);

  const handlePhotoSelect = useCallback(async (file) => {
    if (!file) return;
    // Multiplatform image validation (Android, iOS HEIC, Desktop)
    const looksLikeImage = Boolean(
      file.type?.startsWith('image/') ||
      /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(file.name || '') ||
      (!file.type && file.size > 0)
    );
    if (!looksLikeImage || file.size === 0) {
      setError('Please select a valid image file (JPG, PNG, WebP, or HEIC)');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (file.size > MAX_RAW_PHOTO_BYTES) {
      setError('Photo must be under 30 MB');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    analysisRunIdRef.current += 1;
    const runId = analysisRunIdRef.current;
    const isCurrent = () => runId === analysisRunIdRef.current;
    setError(null);

    imgErrorRetryCountRef.current = 0;
    rawDataUrlRef.current = '';
    setImgRetryTick(0);

    // Keep the selected File in state immediately so React re-renders never see !photo during decoding
    setPhoto(file);
    setIsProcessingPhoto(true);
    setPhotoProgress(20);
    setDetectedPerson(false);
    setDetectedAnimal(true);
    setHumanConsentGiven(false);
    setCheckStatus('checking');

    // 1. Always read the real photo via FileReader (data: URL) first (with automatic 350ms retry)
    //    and immediately set it as previewUrl so <img src={previewUrl} /> renders the real image.
    let rawDataUrl = '';
    try {
      rawDataUrl = await readFileAsDataUrlWithRetry(file);
    } catch (readErr) {
      console.warn('[CreateMemorial] Initial FileReader read note:', readErr?.message || readErr);
    }
    if (!isCurrent()) return;

    if (rawDataUrl) {
      rawDataUrlRef.current = rawDataUrl;
      previewUrlRef.current = rawDataUrl;
      setPreviewUrl(rawDataUrl);
      setPhotoProgress(55);
    }

    // 2. Wait for requestAnimationFrame + 180ms so Android Chrome finishes restoring its
    //    graphics/Canvas/WebGL context after returning from the system Photo Picker.
    await waitForTabWakeup(TAB_WAKEUP_DELAY_MS);
    if (!isCurrent()) return;

    // 3. Generate proportional Canvas thumbnail (with automatic 350ms retry).
    //    Never overwrite a valid FileReader rawDataUrl with the SVG placeholder!
    let thumbUrl = rawDataUrl;
    try {
      setPhotoProgress(75);
      const generated = await generateThumbnail(
        file,
        THUMBNAIL_MAX_DIM,
        THUMBNAIL_QUALITY,
        registerObjectUrl,
        rawDataUrl
      );
      if (generated && (generated !== FALLBACK_PORTRAIT_SVG_DATA_URL || !rawDataUrl)) {
        thumbUrl = generated;
      }
      setPhotoProgress(90);
    } catch (e) {
      console.warn('[CreateMemorial] Thumbnail note, keeping FileReader dataUrl:', e);
    }
    if (!isCurrent()) {
      // A newer selection (or removal) owns the photo UI state now — leave it untouched
      return;
    }

    // Ultimate Fallback only when even FileReader could not produce a dataUrl
    if (!thumbUrl) {
      try {
        thumbUrl = URL.createObjectURL(file);
        registerObjectUrl(thumbUrl);
      } catch {
        thumbUrl = FALLBACK_PORTRAIT_SVG_DATA_URL;
      }
    }

    setPhotoProgress(100);
    revokeTrackedObjectUrls(thumbUrl);
    previewUrlRef.current = thumbUrl;
    setPhoto(file);
    setPreviewUrl(thumbUrl);
    setIsProcessingPhoto(false);

    // 4. Run non-blocking AI verification in background (with automatic 350ms retry)
    processSelectedImage(file, thumbUrl, runId);
  }, [processSelectedImage, registerObjectUrl, revokeTrackedObjectUrls]);

  const handleImageError = useCallback(async () => {
    if (!photo) return;
    const runId = analysisRunIdRef.current;
    const isCurrent = () => runId === analysisRunIdRef.current;

    // Self-healing retry: if <img> fired onError in the first frames while mobile Chrome was waking up
    // from the Android Photo Picker, wait 350ms + rAF and retry rendering the real FileReader dataUrl.
    if (imgErrorRetryCountRef.current < 2) {
      imgErrorRetryCountRef.current += 1;
      console.warn(
        `[CreateMemorial] <img> preview load error (attempt ${imgErrorRetryCountRef.current}), retrying after 350ms wakeup...`
      );
      await waitForTabWakeup(RETRY_DELAY_MS);
      if (!isCurrent()) return;

      let recoveryDataUrl = rawDataUrlRef.current;
      if (!recoveryDataUrl) {
        try {
          recoveryDataUrl = await readFileAsDataUrlWithRetry(photo);
          if (recoveryDataUrl && isCurrent()) {
            rawDataUrlRef.current = recoveryDataUrl;
          }
        } catch {
          // ignore
        }
      }
      if (!isCurrent()) return;

      if (recoveryDataUrl) {
        previewUrlRef.current = recoveryDataUrl;
        setPreviewUrl(recoveryDataUrl);
        setImgRetryTick((t) => t + 1);
        return;
      }

      if (imgErrorRetryCountRef.current === 1) {
        try {
          const directBlobUrl = URL.createObjectURL(photo);
          registerObjectUrl(directBlobUrl);
          previewUrlRef.current = directBlobUrl;
          setPreviewUrl(directBlobUrl);
          setImgRetryTick((t) => t + 1);
          return;
        } catch {
          // fall through
        }
      }
    }

    // Ultimate Fallback: only reached if <img> genuinely cannot render even the FileReader dataUrl
    // after wakeup + retries (e.g., an unsupported raw HEIC codec).
    console.warn('[CreateMemorial] <img> could not decode format after retries, showing SVG placeholder.');
    if (previewUrlRef.current !== FALLBACK_PORTRAIT_SVG_DATA_URL) {
      previewUrlRef.current = FALLBACK_PORTRAIT_SVG_DATA_URL;
      setPreviewUrl(FALLBACK_PORTRAIT_SVG_DATA_URL);
    }
  }, [photo, registerObjectUrl]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('border-[#8a4f36]');
    const file = e.dataTransfer.files[0];
    if (file) handlePhotoSelect(file);
  }, [handlePhotoSelect]);

  /* ── Shared minting pre-flight helpers ─────────────────── */

  // Latest on-chain creation fee as a bigint, or null when it cannot be read (never guess the fee).
  const fetchLatestFee = async () => {
    try {
      const result = await refetchCreationFee();
      if (result?.error || result?.isError) return null;
      return typeof result?.data === 'bigint' ? result.data : null;
    } catch (fErr) {
      console.warn('[CreateMemorial] Failed to refetch latest fee:', fErr);
      return null;
    }
  };

  // Balance check that also reserves network gas. Returns an English error message, or '' when funds look sufficient.
  const checkFundsForMint = async ({ account, args, fee }) => {
    if (!publicClient || !account) return '';
    let gasCost = GAS_BUFFER_WEI;
    try {
      const [gas, fees] = await Promise.all([
        publicClient.estimateContractGas({
          address: contractAddress,
          abi: CONTRACT_ABI,
          functionName: 'create_memorial',
          args,
          value: fee,
          account,
        }),
        publicClient.estimateFeesPerGas(),
      ]);
      const perGas = fees?.maxFeePerGas ?? fees?.gasPrice;
      if (gas && perGas) gasCost = (gas * perGas * 12n) / 10n; // +20% safety margin
    } catch (estErr) {
      const friendly = formatTxError(estErr, '');
      if (/^Insufficient/i.test(friendly)) return INSUFFICIENT_FUNDS_MESSAGE;
      // A contract revert during estimation means the real tx would revert too — surface it before anything is paid
      let cause = estErr;
      for (let i = 0; i < 8 && cause; i += 1) {
        if (cause.name === 'ContractFunctionRevertedError') {
          return friendly || 'The contract would reject this transaction. Please try again later.';
        }
        cause = cause.cause;
      }
      console.warn('[CreateMemorial] Gas estimation unavailable, using fixed buffer:', estErr?.shortMessage || estErr);
    }
    try {
      const latestBalance = await publicClient.getBalance({ address: account });
      if (latestBalance < fee + gasCost) return INSUFFICIENT_FUNDS_MESSAGE;
    } catch (balErr) {
      console.warn('[CreateMemorial] Balance refresh failed, using cached balance:', balErr?.shortMessage || balErr);
      if (balance?.value !== undefined && balance.value < fee + gasCost) return INSUFFICIENT_FUNDS_MESSAGE;
    }
    return '';
  };

  // Wallet / network readiness. Returns an English error message, or '' when ready to send.
  const ensureWalletReady = async () => {
    if (!isConnected || !activeUserAddress) return 'Please connect your wallet first';
    if (!connector && !activeUserAddress) {
      console.error('Wallet connector is missing or Privy was blocked.');
      return 'Wallet connection failed. Please disable your adblocker or reconnect your wallet.';
    }
    if (isCreationPaused) return 'Memorial creation is temporarily paused by the protocol. Please try again later.';

    const preferredWallet = externalWallet || embeddedWallet || wallets[0];
    const currentWalletChainId = await getActiveWalletChainId({
      chain,
      accountChainId,
      wallet: preferredWallet,
      connector,
      fallbackChainId: chainId,
    });

    // Only call switchChain if the wallet is confirmed to be on a network other than Base Sepolia (84532)
    if (currentWalletChainId !== null && currentWalletChainId !== baseSepolia.id) {
      try {
        if (switchChainAsync && connector) {
          await switchChainAsync({ chainId: baseSepolia.id });
        } else if (preferredWallet?.switchChain) {
          await preferredWallet.switchChain(baseSepolia.id);
        }
      } catch (switchErr) {
        console.error('[CreateMemorial] Failed to switch network:', switchErr);
        return formatTxError(switchErr, 'Please switch your wallet network to Base Sepolia to continue.');
      }
    }
    return '';
  };

  // The tx account prefers the wagmi-connected address and falls back to activeUserAddress.
  const sendCreateMemorialTx = ({ name, metadataTxId, isPublicFlag, fee }) => writeContractAsync({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'create_memorial',
    args: [name, metadataTxId, isPublicFlag],
    value: fee,
    account: wagmiAddress || activeUserAddress,
    ...(connector ? { connector } : {}),
    chainId: baseSepolia.id,
  });

  const FEE_UNAVAILABLE_MESSAGE = 'Could not load the current creation fee from the contract. Please check your connection and try again.';

  /* ── Submit flow: Arweave upload → mint ──────────────── */
  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (submitLockRef.current) return;
    if (isInitiating || isMinting || isConfirming || Boolean(txHash) || flowStep > 0) return;
    submitLockRef.current = true;
    setTxInProgress(true);
    setIsInitiating(true);
    setError('');
    setUnconfirmedTxHash(null);

    let phase = 'preflight'; // preflight | upload | mint
    let sentHash = null;
    try {
      const name = petName.trim();
      const nameError = validatePetName(name);
      if (nameError) { setStep(0); setError(nameError); return; }
      const storyError = validateStoryFields({ birthDate, memorialDate, birthYear, passingYear });
      if (storyError) { setStep(1); setError(storyError); return; }
      if (detectedPerson && !humanConsentGiven) {
        setError('Please confirm consent for the person detected in the photo');
        return;
      }
      if (isInsufficientFunds) { setError(INSUFFICIENT_FUNDS_MESSAGE); return; }

      const walletError = await ensureWalletReady();
      if (walletError) { setError(walletError); return; }
      const account = wagmiAddress || activeUserAddress;

      // Check fee + balance (incl. gas) BEFORE paid uploads so nothing is uploaded for a mint that cannot succeed
      const preflightFee = await fetchLatestFee();
      if (preflightFee === null) { setError(FEE_UNAVAILABLE_MESSAGE); return; }
      const preflightFundsError = await checkFundsForMint({
        account,
        args: [name, ARWEAVE_URI_PLACEHOLDER, isPublic],
        fee: preflightFee,
      });
      if (preflightFundsError) { setError(preflightFundsError); return; }

      phase = 'upload';
      setFlowStep(1);
      let imageTxId = '';
      if (photo) {
        let photoToUpload = photo;
        try {
          photoToUpload = await resizeImage(photo, MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, COMPRESSION_QUALITY);
        } catch (compErr) {
          console.warn('[CreateMemorial] Arweave image preparation note:', compErr);
        }
        imageTxId = await uploadToArweave(photoToUpload, [{ name: 'Pet-Name', value: name }]);
      }

      setFlowStep(2);
      const metadata = buildNftMetadata({ petName: name, description, birthDate, memorialDate, birthYear, passingYear, species, breed, imageTxId, ownerAddress: account });
      const metadataTxId = await uploadJsonToArweave(metadata);

      // Save draft immediately after Arweave metadata upload succeeds
      const draftData = {
        metadataTxId,
        petName: name,
        isPublic,
        createdAt: Date.now(),
      };
      persistDraft(draftData);

      phase = 'mint';
      setFlowStep(3);
      setIsMinting(true);
      setMintedIsPublic(Boolean(isPublic));

      // Fetch latest creation fee dynamically to guarantee sending the exact amount required by the contract
      const currentFee = await fetchLatestFee();
      if (currentFee === null) {
        setError(`${FEE_UNAVAILABLE_MESSAGE} Your upload is saved — use "Resume Minting" when you are ready.`);
        return;
      }

      console.log('[CreateMemorial] Triggering writeContractAsync...');
      const hash = await sendCreateMemorialTx({ name, metadataTxId, isPublicFlag: isPublic, fee: currentFee });
      sentHash = hash;

      console.log('[CreateMemorial] Success Tx Hash:', hash);
      // Keep the draft until the receipt succeeds; remember the hash so a reload / resume never blindly pays twice
      persistDraft({ ...draftData, pendingTxHash: hash });
      setTxHash(hash);
    } catch (err) {
      console.error('[CreateMemorial] Minting error:', err);
      if (phase === 'upload') {
        const detail = String(err?.message || '').slice(0, 160);
        setError(`Upload to Arweave failed${detail ? `: ${detail}` : ''}. No payment was made — please try again.`);
      } else if (isUserRejection(err)) {
        setError('Transaction cancelled in your wallet.');
      } else {
        const message = formatTxError(err, 'Minting failed. Please try again.');
        if (/creation fee changed/i.test(message)) refetchCreationFee();
        setError(message);
      }
    } finally {
      setTxInProgress(false);
      submitLockRef.current = false;
      setIsMinting(false);
      setIsInitiating(false);
      if (!sentHash) setFlowStep(0);
    }
  };

  /* ── Resume draft flow ─────────────────────────────────── */
  const handleResumeDraft = async (targetDraft = draft) => {
    if (!targetDraft || !targetDraft.metadataTxId) return;
    if (submitLockRef.current) return;
    if (isInitiating || isMinting || isConfirming || Boolean(txHash) || flowStep > 0) return;
    submitLockRef.current = true;
    setTxInProgress(true);
    setIsInitiating(true);
    setError('');

    let sentHash = null;
    try {
      const name = String(targetDraft.petName || '').trim();
      const nameError = validatePetName(name);
      if (nameError) {
        setError(`${nameError.replace(/\.?$/, '.')} Please discard this draft and create the memorial again.`);
        return;
      }
      if (isInsufficientFunds) { setError(INSUFFICIENT_FUNDS_MESSAGE); return; }

      const walletError = await ensureWalletReady();
      if (walletError) { setError(walletError); return; }
      const account = wagmiAddress || activeUserAddress;
      const draftPublic = Boolean(targetDraft.isPublic ?? false);

      // A transaction for this draft was already broadcast: check its outcome before paying again
      const pendingHash = targetDraft.pendingTxHash;
      if (pendingHash && acknowledgedPendingTxRef.current !== pendingHash) {
        let pendingStatus = null;
        try {
          const previousReceipt = await publicClient?.getTransactionReceipt({ hash: pendingHash });
          pendingStatus = previousReceipt?.status ?? null;
        } catch {
          pendingStatus = null; // not mined yet, dropped, or RPC failure
        }
        if (pendingStatus === 'success') {
          // Already minted — run the normal confirmation flow instead of paying twice
          setPetName(name);
          setIsPublic(draftPublic);
          setMintedIsPublic(draftPublic);
          setFlowStep(3);
          sentHash = pendingHash;
          setTxHash(pendingHash);
          return;
        }
        if (pendingStatus !== 'reverted') {
          acknowledgedPendingTxRef.current = pendingHash;
          setUnconfirmedTxHash(pendingHash);
          setError('Your previous transaction for this memorial has not been confirmed yet. Please check the block explorer first. If it failed or was dropped, click "Resume Minting" again to send a new transaction.');
          return;
        }
        // Reverted: the fee was not charged, so a fresh transaction is safe
      }
      setUnconfirmedTxHash(null);

      setFlowStep(3);
      setIsMinting(true);
      setPetName(name);
      setIsPublic(draftPublic);
      setMintedIsPublic(draftPublic);

      // Fetch latest creation fee dynamically to guarantee sending the exact amount required by the contract
      const currentFee = await fetchLatestFee();
      if (currentFee === null) { setError(FEE_UNAVAILABLE_MESSAGE); return; }
      const fundsError = await checkFundsForMint({
        account,
        args: [name, targetDraft.metadataTxId, draftPublic],
        fee: currentFee,
      });
      if (fundsError) { setError(fundsError); return; }

      const hash = await sendCreateMemorialTx({ name, metadataTxId: targetDraft.metadataTxId, isPublicFlag: draftPublic, fee: currentFee });
      sentHash = hash;

      console.log('[CreateMemorial] Resumed Tx Hash:', hash);
      // Keep the draft until the receipt succeeds; remember the hash so a reload / resume never blindly pays twice
      acknowledgedPendingTxRef.current = null;
      persistDraft({ ...targetDraft, petName: name, pendingTxHash: hash });
      setTxHash(hash);
    } catch (err) {
      console.error('[CreateMemorial] Resume minting error:', err);
      if (isUserRejection(err)) {
        setError('Transaction cancelled in your wallet.');
      } else {
        const message = formatTxError(err, 'Minting failed. Please try again.');
        if (/creation fee changed/i.test(message)) refetchCreationFee();
        setError(message);
      }
    } finally {
      setTxInProgress(false);
      submitLockRef.current = false;
      setIsMinting(false);
      setIsInitiating(false);
      if (!sentHash) setFlowStep(0);
    }
  };

  const handleDiscardDraft = () => {
    acknowledgedPendingTxRef.current = null;
    persistDraft(null);
  };

  const isEOA = connector?.name && !connector.name.toLowerCase().includes('privy');

  const petNameBytes = getUtf8ByteLength(petName.trim());
  const todayISO = getTodayISO();
  const currentYear = new Date().getFullYear();

  const isSubmitting = isInitiating || flowStep > 0 || isMinting || isConfirming || (Boolean(txHash) && !isSuccess);

  /* ── Success screen ────────────────────────────────────── */
  if (isSuccess) {
    const isPublicTribute = Boolean(mintedIsPublic);
    const memorialTargetUrl = createdTokenId ? `/memorial/${createdTokenId}` : '/my';
    const memorialShareUrl = createdTokenId
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}${import.meta.env.BASE_URL}#/memorial/${createdTokenId}`
      : (typeof window !== 'undefined' ? window.location.href : '');

    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="max-w-lg w-full text-center space-y-6 bg-white/80 backdrop-blur-sm border border-[#e0d0c7] p-8 md:p-10 rounded-[32px] shadow-sm animate-fadeIn">
          <div className="w-20 h-20 rounded-full bg-[#ebddd5] flex items-center justify-center mx-auto shadow-inner text-[#8a4f36]">
            <span className="material-symbols-outlined text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>
              favorite
            </span>
          </div>

          <div className="space-y-2">
            <h2 className="text-3xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
              Memorial Created
            </h2>
            {petName && (
              <p className="text-xs uppercase tracking-widest text-[#8a4f36] font-semibold">
                For {petName}
              </p>
            )}
          </div>

          {isPublicTribute ? (
            <p className="text-[#53433e] text-sm md:text-base leading-relaxed max-w-md mx-auto">
              Memorial preserved on-chain! Your tribute is now visible in the public sanctuary.
            </p>
          ) : (
            <div className="space-y-3 max-w-md mx-auto">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold uppercase tracking-wider">
                <span className="material-symbols-outlined text-sm">lock</span>
                <span>Private / Unlisted</span>
              </div>
              <p className="text-[#53433e] text-sm md:text-base leading-relaxed">
                Memorial preserved on-chain! As a private tribute, it will not appear in the public gallery. Access is exclusive via direct link or QR code.
              </p>
            </div>
          )}

          {/* Action buttons */}
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
            {isPublicTribute ? (
              <>
                <button
                  type="button"
                  onClick={() => navigate(memorialTargetUrl)}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#8a4f36] text-white px-7 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider hover:opacity-90 transition-opacity shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">visibility</span>
                  <span>View Memorial</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 border border-[#d8c2ba] text-[#53433e] hover:bg-[#f5efe6] px-7 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">explore</span>
                  <span>Browse Gallery</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate(memorialTargetUrl)}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#8a4f36] text-white px-7 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider hover:opacity-90 transition-opacity shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">arrow_forward</span>
                  <span>Open Memorial</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowShareModal(true)}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 border border-[#d8c2ba] bg-[#fbf5f2] text-[#8a4f36] hover:bg-[#f3ebe4] hover:text-[#2C2520] px-7 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider transition-colors shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">qr_code_2</span>
                  <span>Share / Get QR Code</span>
                </button>
              </>
            )}
          </div>

          <div className="pt-2 border-t border-[#e0d0c7]/50">
            <button
              type="button"
              onClick={resetFormState}
              className="text-xs text-[#85736d] hover:text-[#8a4f36] font-semibold uppercase tracking-wider transition-colors cursor-pointer"
            >
              + Create Another Memorial
            </button>
          </div>
        </div>

        {/* Share Modal for Unlisted Memorial QR Code */}
        <ShareModal
          isOpen={showShareModal}
          onClose={() => setShowShareModal(false)}
          petName={petName}
          memorialId={createdTokenId || ''}
          url={memorialShareUrl}
        />
      </div>
    );
  }

  /* ── Privy initializing / hydrating session ──────────────── */
  if (!ready && !activeUserAddress) {
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-4 animate-fadeIn">
          <span className="inline-block w-8 h-8 border-2 border-[#8a4f36] border-t-transparent rounded-full animate-spin" />
          <p className="text-[#85736d] text-sm font-medium">Connecting to Sanctuary…</p>
        </div>
      </div>
    );
  }

  /* ── Not connected ─────────────────────────────────────── */
  if (!isConnected) {
    const showMetaMaskDeepLink = isMobileWithoutEthereum();
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-5 animate-fadeIn">
          <span className="material-symbols-outlined text-5xl text-[#d8c2ba]">account_balance_wallet</span>
          <h2 className="text-2xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>Connect Your Wallet</h2>
          <p className="text-[#53433e] text-sm">Please connect your wallet to create a memorial.</p>
          <div className="pt-2 flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={() => connectWallet()}
              className="w-full inline-flex items-center justify-center gap-2 bg-[#8a4f36] hover:bg-[#723f2b] text-white px-7 py-3.5 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">account_balance_wallet</span>
              <span>Connect Wallet</span>
            </button>
            {showMetaMaskDeepLink && (
              <a
                href={getMetaMaskDappDeepLink()}
                className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-2xl text-xs font-semibold uppercase tracking-wider text-[#8a4f36] bg-[#f5efe6] hover:bg-[#ebddd5] border border-[#d8c2ba]/70 transition-colors"
              >
                <span className="material-symbols-outlined text-base">open_in_new</span>
                <span>Open in MetaMask App</span>
              </a>
            )}
            <button
              type="button"
              onClick={() => login({ loginMethods: ['email'] })}
              className="text-xs font-medium text-[#85736d] hover:text-[#8a4f36] transition-colors cursor-pointer pt-1"
            >
              Or sign in with Email
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6]">
      <div className="max-w-2xl mx-auto px-6 md:px-0">
        {/* Progress bar */}
        <div className="mb-10">
          <div className="flex justify-between items-end mb-3">
            <h1 className="text-3xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
              Begin the Memorial
            </h1>
            <span className="text-xs font-semibold tracking-widest uppercase text-[#85736d]">
              Step {step + 1} of {STEPS.length}: {STEPS[step]}
            </span>
          </div>
          <div className="w-full h-1 bg-[#e4e2df] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#8a4f36] rounded-full transition-all duration-500"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Draft recovery banner */}
        {draft && (
          <div className="mb-6 bg-[#fffbf2] border border-[#e8d5b7] rounded-2xl p-4 md:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm animate-fadeIn">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-[#8a4f36] text-2xl shrink-0 mt-0.5">restore_page</span>
              <div>
                <h4 className="text-sm font-semibold text-[#1b1c1a]">Unfinished Memorial Found</h4>
                <p className="text-xs text-[#53433e] mt-0.5 leading-relaxed">
                  Arweave preservation record for <span className="font-semibold italic">{draft.petName}</span> is saved on your device. Skip media re-upload and complete the on-chain minting.
                </p>
                {draft.pendingTxHash && (
                  <p className="text-xs text-amber-800 mt-1 leading-relaxed">
                    A minting transaction was already sent for this draft (
                    <a
                      href={`${EXPLORER_BASE_URL}/tx/${draft.pendingTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline font-medium"
                    >
                      view on explorer
                    </a>
                    ). Resuming checks its status first so you are not charged twice.
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto justify-end shrink-0">
              <button
                type="button"
                onClick={handleDiscardDraft}
                disabled={isSubmitting}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-[#85736d] hover:bg-[#ebdcd1]/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => handleResumeDraft(draft)}
                disabled={isSubmitting || isInsufficientFunds || isCreationPaused || !isFeeKnown}
                className="px-4 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider bg-[#8a4f36] text-white hover:opacity-90 transition-opacity shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>{isConfirming || txHash ? 'Confirming…' : 'Minting…'}</span>
                  </>
                ) : (
                  <>
                    <span>
                      {isCreationPaused
                        ? 'Creation Paused'
                        : !isFeeKnown
                          ? 'Loading fee…'
                          : isInsufficientFunds
                            ? `Insufficient ETH (${creationFeeLabel} ETH + gas required)`
                            : 'Resume Minting'}
                    </span>
                    {!isInsufficientFunds && !isCreationPaused && isFeeKnown && (
                      <span className="material-symbols-outlined text-sm">arrow_forward</span>
                    )}
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Upload flow progress (during submission) */}
        {isSubmitting && (
          <div className="mb-6 bg-[#f5f3f0] rounded-2xl p-4 flex flex-col gap-2">
            {[
              { n: 1, label: 'Uploading photo to Arweave' },
              { n: 2, label: 'Uploading metadata to Arweave' },
              { n: 3, label: 'Minting on-chain' },
            ].map(({ n, label }) => (
              <div key={n} className={`flex items-center gap-3 text-sm ${flowStep >= n ? 'text-[#8a4f36]' : 'text-[#85736d]'}`}>
                {flowStep > n
                  ? <span className="material-symbols-outlined text-base text-[#8a4f36]">check_circle</span>
                  : flowStep === n
                    ? <span className="inline-block w-4 h-4 border-2 border-[#8a4f36] border-t-transparent rounded-full animate-spin" />
                    : <span className="w-4 h-4 rounded-full border border-[#d8c2ba] inline-block" />
                }
                {label}
              </div>
            ))}
          </div>
        )}

        {isCreationPaused && (
          <div className="mb-6 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-center gap-2">
            <span>⏸️ Memorial creation is temporarily paused by the protocol.</span>
          </div>
        )}

        {error && (
          <div className="mb-6 bg-[#ffdad6] border border-[#ba1a1a]/20 rounded-xl px-4 py-3 text-sm text-[#93000a]">
            {error}
            {unconfirmedTxHash && (
              <a
                href={`${EXPLORER_BASE_URL}/tx/${unconfirmedTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block mt-2 text-xs font-mono underline break-all"
              >
                {unconfirmedTxHash}
              </a>
            )}
          </div>
        )}

        {/* ── WIZARD STEP 0: Basic Info ── */}
        {step === 0 && (
          <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-8 space-y-8">
            {/* Photo drop zone */}
            <div>
              <label className={labelBase}>Pet Portrait</label>
              {/* File input accessible to iOS Safari and Android */}
              <input
                ref={fileInputRef}
                id="photo-input"
                type="file"
                autoComplete="off"
                tabIndex={-1}
                accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/*"
                className="sr-only"
                style={{
                  position: 'absolute',
                  width: '1px',
                  height: '1px',
                  padding: 0,
                  margin: '-1px',
                  overflow: 'hidden',
                  clip: 'rect(0,0,0,0)',
                  border: 0,
                }}
                onClick={(e) => {
                  // Reset value on click so re-selecting the same photo always triggers onChange
                  e.currentTarget.value = '';
                }}
                onChange={(e) => {
                  const selectedFile = e.target.files?.[0];
                  if (selectedFile) {
                    handlePhotoSelect(selectedFile);
                  }
                }}
              />

              {previewUrl ? (
                <div className="space-y-3 animate-fadeIn">
                  <div className="relative w-full h-56 rounded-2xl overflow-hidden border border-amber-900/10 bg-[#f5f3f0]">
                    <img
                      key={imgRetryTick}
                      src={previewUrl}
                      alt={photo?.name || 'Pet Portrait'}
                      className="w-full h-full object-cover"
                      onError={handleImageError}
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleRemoveImage();
                      }}
                      className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white rounded-full p-1.5 transition-colors flex items-center justify-center w-7 h-7 text-xs cursor-pointer"
                      title="Remove photo"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Non-blocking image check status */}
                  {checkStatus === 'checking' && (
                    <div className="bg-[#fcf8f5] border border-[#d8c2ba]/40 rounded-xl p-3 flex items-center justify-between gap-2.5 text-xs text-[#8a4f36] animate-fadeIn">
                      <div className="flex items-center gap-2.5">
                        <span className="inline-block w-3.5 h-3.5 border-2 border-[#8a4f36] border-t-transparent rounded-full animate-spin" />
                        <span className="font-medium">Checking image… you can continue anytime</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          console.log('[AI Analysis] Manually skipped by user');
                          analysisRunIdRef.current += 1;
                          setCheckStatus('skipped');
                          setDetectedPerson(false);
                          setDetectedAnimal(true);
                        }}
                        className="text-xs text-[#8a4f36] hover:text-[#53433e] underline font-semibold cursor-pointer shrink-0"
                      >
                        Skip Check
                      </button>
                    </div>
                  )}

                  {/* Image check status badge */}
                  {checkStatus === 'accepted' && !detectedPerson && (
                    <div className="flex items-center gap-1.5 text-xs text-green-700 font-medium">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      <span>Image accepted</span>
                    </div>
                  )}
                  {checkStatus === 'skipped' && (
                    <div className="flex items-center gap-1.5 text-xs text-[#85736d] font-medium">
                      <span className="material-symbols-outlined text-sm">info</span>
                      <span>Check skipped</span>
                    </div>
                  )}

                  {/* Human Detection Consent Checkbox (only when a person was actually detected) */}
                  {detectedPerson && (
                    <div className="bg-[#fff8f6] border border-[#d8c2ba] rounded-xl p-4 flex items-start gap-3">
                      <input
                        type="checkbox"
                        id="humanConsent"
                        checked={humanConsentGiven}
                        onChange={(e) => setHumanConsentGiven(e.target.checked)}
                        className="mt-1 accent-[#8a4f36] cursor-pointer w-4 h-4"
                      />
                      <label htmlFor="humanConsent" className="text-xs text-[#53433e] leading-relaxed cursor-pointer">
                        <span className="font-semibold text-[#1b1c1a] block mb-0.5">On-chain Privacy Notice</span>
                        A person was detected in this photo. I confirm I have explicit consent to publish their image permanently on Arweave.
                      </label>
                    </div>
                  )}

                  {/* Animal Detection Info Notice */}
                  {checkStatus === 'accepted' && !detectedAnimal && (
                    <div className="bg-[#fffdfa] border border-[#e4d3c3] rounded-xl p-4 flex items-start gap-3 text-xs text-[#53433e]">
                      <span className="material-symbols-outlined text-[#d48c6f] text-base shrink-0 mt-0.5">info</span>
                      <p>
                        We couldn't automatically detect a pet in this image (e.g., if it's a silhouette, paw print, or memorial object). That is completely fine — feel free to proceed if this is the photo you want.
                      </p>
                    </div>
                  )}
                </div>
              ) : isProcessingPhoto ? (
                <div className="w-full h-40 rounded-2xl border border-[#d8c2ba]/50 bg-[#fdfbf9] p-6 flex flex-col items-center justify-center space-y-3.5 animate-fadeIn">
                  <div className="flex items-center gap-3">
                    <span className="inline-block w-4 h-4 border-2 border-[#8a4f36] border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm font-medium text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
                      Preparing Pet Portrait…
                    </span>
                  </div>
                  <div className="w-full max-w-xs space-y-1.5">
                    <div className="w-full h-2 bg-[#ebdcd1]/50 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#8a4f36] rounded-full transition-all duration-300 ease-out"
                        style={{ width: `${Math.max(10, photoProgress)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] text-[#85736d]">
                      <span>{photoProgress < 50 ? 'Reading image…' : photoProgress < 90 ? 'Optimizing preview…' : 'Finalizing…'}</span>
                      <span className="font-mono font-medium">{photoProgress}%</span>
                    </div>
                  </div>
                </div>
              ) : (
                <label
                  htmlFor="photo-input"
                  className="w-full h-40 border-2 border-dashed border-[#d8c2ba]/60 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-[#f5f3f0] hover:border-[#8a4f36]/40 transition-colors group block"
                  onDrop={handleDrop}
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-[#8a4f36]'); }}
                  onDragLeave={(e) => e.currentTarget.classList.remove('border-[#8a4f36]')}
                >
                  <span className="material-symbols-outlined text-4xl text-[#d8c2ba] group-hover:text-[#8a4f36] transition-colors mb-2 block text-center">add_photo_alternate</span>
                  <p className="text-sm text-[#53433e] text-center">Click or drag photo to upload</p>
                  <p className="text-xs text-[#85736d] mt-1 text-center">JPG, PNG, WebP, or HEIC up to 30 MB (auto-optimized)</p>
                </label>
              )}
            </div>

            {/* Pet name */}
            <div>
              <label className={labelBase} htmlFor="petName">Pet Name *</label>
              <input
                className={inputBase} id="petName" type="text"
                value={petName} onChange={(e) => setPetName(e.target.value)}
                placeholder="e.g. Luna" maxLength={128}
              />
              {petNameBytes > MAX_PET_NAME_BYTES && (
                <p className="text-xs text-[#93000a] mt-1">
                  Name is too long for on-chain storage ({petNameBytes}/{MAX_PET_NAME_BYTES} bytes). Please shorten it.
                </p>
              )}
            </div>

            {/* Species + Breed */}
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className={labelBase}>Species</label>
                <select className={`${inputBase} cursor-pointer`} value={species} onChange={(e) => setSpecies(e.target.value)}>
                  <option value="">Select…</option>
                  {SPECIES_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className={labelBase}>Breed</label>
                <input className={inputBase} type="text" value={breed} onChange={(e) => setBreed(e.target.value)} placeholder="e.g. Beagle" />
              </div>
            </div>
          </div>
        )}

        {/* ── WIZARD STEP 1: Story ── */}
        {step === 1 && (
          <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-8 space-y-8">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className={labelBase}>Birth Date</label>
                <input className={inputBase} type="date" min={`${MIN_YEAR}-01-01`} max={todayISO} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Memorial Date</label>
                <input className={inputBase} type="date" min={`${MIN_YEAR}-01-01`} max={todayISO} value={memorialDate} onChange={(e) => setMemorialDate(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Birth Year (if exact date unknown)</label>
                <input className={inputBase} type="number" min={MIN_YEAR} max={currentYear} step={1} placeholder="e.g. 2012" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Passing Year (if exact date unknown)</label>
                <input className={inputBase} type="number" min={MIN_YEAR} max={currentYear} step={1} placeholder="e.g. 2024" value={passingYear} onChange={(e) => setPassingYear(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={labelBase} htmlFor="bio">A Brief Memory</label>
              <textarea
                id="bio" rows={5}
                className="w-full bg-[#fbf9f6] border border-[#d8c2ba]/40 rounded-xl p-4 text-base text-[#1b1c1a] placeholder-[#85736d] focus:border-[#8a4f36] focus:ring-1 focus:ring-[#8a4f36] outline-none transition-all resize-none"
                placeholder="Tell us about their favourite toy, habit, or memory…"
                value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))}
              />
              <p className="text-right text-xs text-[#85736d] mt-1">{description.length}/500</p>
            </div>
          </div>
        )}

        {/* ── WIZARD STEP 2: Preservation (review + mint) ── */}
        {step === 2 && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-8 space-y-4">
              <h3 className="text-xl text-[#1b1c1a] mb-2" style={{ fontFamily: "'Libre Caslon Text', serif" }}>Review your Memorial</h3>
              {previewUrl && (
                <div className="relative w-full h-48 rounded-xl overflow-hidden border border-amber-900/10 bg-[#f5f3f0]">
                  <img
                    src={previewUrl}
                    alt={photo?.name || 'Pet Portrait'}
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
              <div className="space-y-2 text-sm text-[#53433e]">
                <p><span className="font-semibold text-[#1b1c1a]">Name:</span> {petName || '—'}</p>
                {species && <p><span className="font-semibold text-[#1b1c1a]">Species:</span> {species}{breed ? ` · ${breed}` : ''}</p>}
                {(birthDate || memorialDate) && (
                  <p><span className="font-semibold text-[#1b1c1a]">Dates:</span> {birthDate || '?'} – {memorialDate || '?'}</p>
                )}
                {description && <p className="italic leading-relaxed">"{description}"</p>}
                <p><span className="font-semibold text-[#1b1c1a]">Visibility:</span> {isPublic ? 'Public Gallery' : 'Unlisted (Private)'}</p>
                <p><span className="font-semibold text-[#1b1c1a]">Creation Fee:</span> {isFeeKnown ? `${creationFeeLabel} ETH` : 'Loading fee…'}</p>
              </div>
            </div>

            {/* Chain preservation & wallet notice */}
            <div className="bg-[#f5f3f0] rounded-2xl border border-[#d8c2ba]/20 p-5 flex gap-4 items-start">
              <span className="material-symbols-outlined text-[#8a4f36] mt-0.5">link</span>
              <div>
                <p className="text-xs font-semibold tracking-widest uppercase text-[#8a4f36] mb-1">Eternal Provenance</p>
                <p className="text-sm text-[#53433e] leading-relaxed">
                  Photo and metadata will be uploaded to Arweave, then the memorial NFT will be minted on Base as a soulbound token. This is permanent.
                </p>
                {isEOA && (
                  <p className="text-xs text-[#85736d] mt-2 border-t border-[#d8c2ba]/30 pt-2 flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm text-[#8a4f36]">info</span>
                    <span><strong className="font-semibold">{connector?.name || 'External Wallet'} connected:</strong> You will be asked to confirm 1 on-chain transaction after Arweave preservation completes.</span>
                  </p>
                )}
              </div>
            </div>

            {/* Privacy Toggle */}
            <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-6 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex-1 pr-4">
                  <label className="block text-[11px] font-semibold tracking-widest uppercase text-[#53433e] mb-1">Show in public gallery</label>
                  <p className="text-sm text-[#85736d]">Allow others to discover this memorial</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPublic}
                  onClick={() => setIsPublic(!isPublic)}
                  className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 ${
                    isPublic ? 'bg-[#8a4f36]' : 'bg-[#d8c2ba]'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200 ${
                      isPublic ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
              <p className="text-[11px] text-[#85736d] italic leading-relaxed">
                If disabled, the memorial will appear only in your personal dashboard and be accessible via a direct link.
                Note: data on Arweave is permanent — hiding removes the card from the site catalog but does not encrypt it on the blockchain.
              </p>
            </div>

            <form onSubmit={handleSubmit}>
              <button
                type="submit"
                disabled={isSubmitting || !petName.trim() || isInsufficientFunds || isCreationPaused || !isFeeKnown}
                className="w-full flex items-center justify-center gap-3 bg-[#d48c6f] text-white py-4 rounded-2xl text-sm font-semibold tracking-wider uppercase hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>{isConfirming || txHash ? 'Confirming on-chain…' : 'Minting…'}</span>
                  </>
                ) : isCreationPaused ? (
                  <><span>Memorial Creation Paused</span></>
                ) : !isFeeKnown ? (
                  <><span>Loading fee…</span></>
                ) : isInsufficientFunds ? (
                  <><span>Insufficient ETH Balance ({creationFeeLabel} ETH + gas required)</span></>
                ) : (
                  <><span>Preserve Forever ({creationFeeLabel} ETH)</span><span className="material-symbols-outlined text-base">arrow_forward</span></>
                )}
              </button>
            </form>
          </div>
        )}

        {/* ── Navigation ── */}
        {!isSubmitting && (
          <div className="flex justify-between items-center pt-6 border-t border-[#d8c2ba]/30 mt-6">
            <button
              type="button"
              onClick={() => step > 0 ? setStep(s => s - 1) : navigate(-1)}
              className="px-6 py-3 border border-[#665d56] text-[#665d56] rounded-2xl text-xs font-semibold tracking-widest uppercase hover:bg-[#efeeeb] transition-colors"
            >
              Back
            </button>
            {step < 2 && (
              <button
                type="button"
                onClick={() => {
                  if (step === 0) {
                    const nameError = validatePetName(petName);
                    if (nameError) { setError(nameError); return; }
                    // Image check/compression runs in the background and never gates Continue.
                    if (detectedPerson && !humanConsentGiven) {
                      setError('Please confirm consent for the detected person in the photo');
                      return;
                    }
                  }
                  if (step === 1) {
                    const storyError = validateStoryFields({ birthDate, memorialDate, birthYear, passingYear });
                    if (storyError) { setError(storyError); return; }
                  }
                  setError('');
                  setUnconfirmedTxHash(null);
                  setStep(s => s + 1);
                }}
                disabled={step === 0 && detectedPerson && !humanConsentGiven}
                className="flex items-center gap-2 bg-[#d48c6f] text-white px-8 py-3 rounded-2xl text-xs font-semibold tracking-widest uppercase hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <span>Continue</span>
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </button>
            )}
          </div>
        )}

        {/* Full-screen blocking modal while transaction is submitted to Base Sepolia and waiting for confirmation */}
        {Boolean(txHash) && !isSuccess && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
            <div className="max-w-md w-full bg-[#fbf9f6] border border-[#d8c2ba] rounded-3xl p-6 md:p-8 text-center space-y-5 shadow-2xl">
              <div className="w-16 h-16 rounded-full bg-[#ebddd5] flex items-center justify-center mx-auto shadow-inner text-[#8a4f36]">
                <span className="inline-block w-8 h-8 border-3 border-[#8a4f36] border-t-transparent rounded-full animate-spin" />
              </div>

              <div className="space-y-2">
                <h3 className="text-2xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
                  Transaction Submitted
                </h3>
                <p className="text-sm text-[#53433e] leading-relaxed font-medium">
                  Transaction submitted to Base Sepolia. Waiting for confirmation...
                </p>
              </div>

              {/* BaseScan Explorer Link */}
              <div className="bg-white rounded-2xl border border-[#d8c2ba]/40 p-4 space-y-2 text-left shadow-xs">
                <div className="flex items-center justify-between text-xs text-[#85736d]">
                  <span className="font-semibold uppercase tracking-wider">Explorer</span>
                  <span className="inline-flex items-center gap-1.5 text-amber-700 font-medium bg-amber-50 border border-amber-200/60 px-2.5 py-0.5 rounded-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" />
                    Confirming Block
                  </span>
                </div>
                <a
                  href={`https://sepolia.basescan.org/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-mono text-[#8a4f36] hover:underline break-all group"
                >
                  <span>{txHash}</span>
                  <span className="material-symbols-outlined text-sm group-hover:translate-x-0.5 transition-transform shrink-0">open_in_new</span>
                </a>
              </div>

              <p className="text-xs text-[#85736d] leading-relaxed">
                Please do not close or refresh this tab while your memorial is being written into the blockchain ledger.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
