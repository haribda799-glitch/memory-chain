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
  resolveActivePrivyWallet,
  sendContractWithPrivyFallback,
} from '../utils/mobileWallet';
import { findMintedMemorial, waitForMintedMemorial, isAmbiguousSendError } from '../utils/mintRecovery';
import {
  sleep,
  releaseCanvas,
  loadImageElement,
  disposeImageElement,
  createAiInputCanvas,
  preparePhotoSequentially,
  PhotoPipelineCancelled,
} from '../utils/photoPipeline';
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

const AI_INPUT_MAX_DIM = 512;                 // px, photos are downscaled before TF.js to keep GPU memory tiny
const PREP_AI_WAIT_COLD_MS = 6000;            // Max time the "Preparing portrait" screen waits for the 1st (cold) AI check
const PREP_AI_WAIT_WARM_MS = 3500;            // ...and for a warm AI check; slower checks finish in the background
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
 * Downscale a photo via Canvas (max 1000px, JPEG 0.8) for the Arweave payload, right before upload.
 * The selected photo is normally already a prepared <=1000px JPEG (see utils/photoPipeline.js), so this
 * is usually a no-op. Canvas / bitmap / object URL memory is always released in `finally`.
 * Falls back to the original file on any failure and never throws.
 */
async function resizeImage(file, maxWidth = MAX_IMAGE_DIMENSION, maxHeight = MAX_IMAGE_DIMENSION, quality = COMPRESSION_QUALITY) {
  if (!file || file.type === 'image/gif') return file;
  const isImage = Boolean(file.type?.startsWith('image/') || /\.(jpe?g|png|webp|bmp|heic|heif)$/i.test(file.name || ''));
  if (!isImage) return file;
  // Small files under 1.5 MB don't require downscaling
  if (file.size <= 1.5 * 1024 * 1024) return file;

  let bitmap = null;
  let img = null;
  let objectUrl = '';
  let canvas = null;
  try {
    let source = null;
    let width = 0;
    let height = 0;

    // 1. createImageBitmap with hardware downsampling avoids a full 50 MP RAM explosion
    if (typeof createImageBitmap === 'function') {
      try {
        bitmap = await createImageBitmap(file, { resizeWidth: maxWidth, resizeQuality: 'medium' });
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
      } catch {
        bitmap = null; // fall back to <img>
      }
    }

    // 2. <img> via an object URL of the in-memory file
    if (!source) {
      objectUrl = URL.createObjectURL(file);
      img = await loadImageElement(objectUrl);
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
    }

    if (!width || !height) return file;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    if (scale >= 1 && file.size <= 2 * 1024 * 1024) return file;

    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#ffffff'; // JPEG has no alpha — avoid black backgrounds for PNGs
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;
    const name = (file.name || 'photo').replace(/\.[^.]+$/, '');
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch (err) {
    console.warn('[CreateMemorial] Image compression skipped, using original file fallback:', err?.message || err);
    return file;
  } finally {
    releaseCanvas(canvas);
    bitmap?.close?.();
    disposeImageElement(img);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
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

/**
 * Permanently (for this page session) moves TF.js to the CPU backend and drops the cached models,
 * whose weights lived in the lost WebGL context. Called when inference fails on WebGL, which happens
 * on Android Chrome after the tab was backgrounded by the system Photo Picker (WebGL context loss).
 */
let cpuFallbackPromise = null;
async function switchTfToCpuBackend() {
  if (!cpuFallbackPromise) {
    cpuFallbackPromise = (async () => {
      try {
        const tf = await ensureTfReady();
        if (tf.getBackend() === 'cpu') return true;
        console.warn('[AI Analysis] Switching TF.js backend from', tf.getBackend(), 'to cpu after a WebGL failure.');
        await tf.setBackend('cpu');
        await tf.ready();
        cachedFaceModelPromise = null;
        cachedObjectModelPromise = null;
        isAiWarm = false;
        return true;
      } catch (err) {
        console.warn('[AI Analysis] CPU backend fallback failed:', err?.message || err);
        cpuFallbackPromise = null;
        return false;
      }
    })();
  }
  return cpuFallbackPromise;
}

async function getActiveTfBackend() {
  try {
    const tf = await ensureTfReady();
    return tf.getBackend();
  } catch {
    return '';
  }
}

/*
 * TF.js inference is serialized (never two photo checks at once), so each run can own a TF engine scope:
 * every intermediate tensor created during the run is disposed by endScope(), even if a model leaks it
 * (model weights were created before the scope and are kept). The wait for a previous, possibly hung
 * run (dead WebGL context) is bounded so it can never deadlock the next photo.
 */
const AI_QUEUE_MAX_WAIT_MS = 8000;
let aiInferenceQueue = Promise.resolve();
function runSerializedInference(task) {
  const previous = aiInferenceQueue;
  const run = (async () => {
    await Promise.race([previous, sleep(AI_QUEUE_MAX_WAIT_MS)]);
    return task();
  })();
  aiInferenceQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function withTfScope(fn) {
  const tf = await ensureTfReady();
  const engine = tf.engine();
  const tensorsBefore = tf.memory().numTensors;
  engine.startScope();
  try {
    return await fn(tf);
  } finally {
    try {
      engine.endScope();
    } catch (scopeErr) {
      console.warn('[AI Analysis] TF scope cleanup note:', scopeErr?.message || scopeErr);
    }
    const leaked = tf.memory().numTensors - tensorsBefore;
    if (leaked > 0) console.warn(`[AI Analysis] ${leaked} tensor(s) still allocated after the photo check.`);
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
  const [recoveredMint, setRecoveredMint] = useState(null); // { tokenId } of an already-minted memorial found on-chain
  const [isVerifyingMint, setIsVerifyingMint] = useState(false); // On-chain duplicate check in progress
  const [mintedIsPublic, setMintedIsPublic] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  // Synchronous submit lock (state updates are async, so double taps can slip past isInitiating)
  const submitLockRef = useRef(false);
  // Pending tx hash the user explicitly chose to override after it could not be confirmed
  const acknowledgedPendingTxRef = useRef(null);

  // Tracking in-flight AI analysis runs to discard obsolete analysis results
  const analysisRunIdRef = useRef(0);

  /*
   * Photo model (identical rendering on Step 1 and Step 3):
   *   - Selecting a photo freezes the portrait card (`isPreparingPhoto`) while a STRICTLY SEQUENTIAL
   *     pipeline runs: wake-up pause -> single arrayBuffer read -> data URL -> canvas JPEG -> AI check.
   *   - Only then is the finished in-memory `data:image/jpeg;base64,...` written to `previewUrl` and the
   *     <img> rendered, so it never races the background work.
   *   - The <input type="file"> is remounted (`inputKey`) after the picker file was copied into RAM and on
   *     every removal, so Android Chrome drops its cached Photo Picker handle for that file.
   *   - "Portrait Selected & Ready" is shown only when the browser genuinely cannot decode the format.
   */
  const [isPreparingPhoto, setIsPreparingPhoto] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const preparingLockRef = useRef(false);
  const previewRetryRef = useRef(0);

  // Immediate background warmup of AI models on component mount
  useEffect(() => {
    preloadAiModels();
  }, []);

  // Cancel any in-flight photo preparation / AI check on unmount
  useEffect(() => {
    return () => {
      analysisRunIdRef.current += 1;
      preparingLockRef.current = false;
      resetAiModeration();
    };
  }, []);

  /** Fully clears the photo, its preview, every preview error flag, the AI check state and the <input>. */
  const clearPhotoState = useCallback(() => {
    analysisRunIdRef.current += 1; // cancels any in-flight pipeline run
    preparingLockRef.current = false;
    previewRetryRef.current = 0;
    setInputKey((k) => k + 1);
    setIsPreparingPhoto(false);
    setPhoto(null);
    setPreviewUrl('');
    setPreviewFailed(false);
    setPreviewKey((k) => k + 1);
    setCheckStatus('idle');
    setDetectedPerson(false);
    setDetectedAnimal(true);
    setHumanConsentGiven(false);
  }, []);

  const handleRemoveImage = useCallback(() => {
    if (preparingLockRef.current) return; // the card is frozen while the photo is being prepared
    clearPhotoState();
    setError(null);
  }, [clearPhotoState]);

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
    setStep(0);
    setPetName('');
    setSpecies('');
    setBreed('');
    setBirthDate('');
    setMemorialDate('');
    setBirthYear('');
    setPassingYear('');
    setDescription('');
    clearPhotoState();
    setIsPublic(false);
    setFlowStep(0);
    setError(null);
    setIsMinting(false);
    setIsInitiating(false);
    setTxHash(null);
    setRecoveredMint(null);
    setUnconfirmedTxHash(null);
    acknowledgedPendingTxRef.current = null;
    setMintedIsPublic(false);
    setShowShareModal(false);
    resetAiModeration();
  }, [clearPhotoState]);

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

  // Success = confirmed receipt of our tx, OR a memorial for this upload found on-chain (dedup recovery)
  const showSuccess = isSuccess || Boolean(recoveredMint);

  // Clear draft & photo states on successful transaction confirmation
  useEffect(() => {
    if (showSuccess) {
      persistDraft(null);
      setUnconfirmedTxHash(null);
      acknowledgedPendingTxRef.current = null;
      clearPhotoState();
      setError(null);
      resetAiModeration();
    }
  }, [showSuccess, persistDraft, clearPhotoState]);

  // Mobile UX: the error banner sits above the form, so a failed Continue / submit tapped at the bottom of
  // a phone screen would be invisible — bring the message into view whenever it appears.
  const errorBannerRef = useRef(null);
  useEffect(() => {
    if (!error || !errorBannerRef.current) return;
    errorBannerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [error]);

  // Mobile UX: every wizard transition (Continue / Back / success screen) starts at the top of the page
  const hasMountedStepRef = useRef(false);
  useEffect(() => {
    if (!hasMountedStepRef.current) {
      hasMountedStepRef.current = true;
      return;
    }
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step, showSuccess]);

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

  /* ── AI image check (BlazeFace + COCO-SSD), informational only ── */

  // One inference pass on the CURRENT TF.js backend, on a small copy of the PREPARED (in-memory) JPEG.
  // Serialized + wrapped in a TF engine scope; the input canvas is released in `finally`.
  const runAiInference = useCallback((preparedDataUrl) => runSerializedInference(async () => {
    await ensureTfReady();
    const [faceModel, objectModel] = await Promise.all([
      getFaceModel(),
      getObjectModel(),
    ]);

    const outcome = await withTfScope(async () => {
      let input = null;
      let faces = [];
      let predictions = [];
      let faceFailed = false;
      let objectFailed = false;
      try {
        input = await createAiInputCanvas(preparedDataUrl, AI_INPUT_MAX_DIM);
        try {
          faces = await faceModel.estimateFaces(input, false);
        } catch (faceErr) {
          faceFailed = true;
          console.warn('[AI Analysis] Face detection warning:', faceErr);
        }
        try {
          predictions = await objectModel.detect(input);
        } catch (objErr) {
          objectFailed = true;
          console.warn('[AI Analysis] Object detection warning:', objErr);
        }
      } finally {
        releaseCanvas(input);
      }
      return { faces, predictions, faceFailed, objectFailed };
    });

    const { faces, predictions, faceFailed, objectFailed } = outcome;
    if (faceFailed && objectFailed) {
      throw new Error('Both AI models failed during inference (graphics context lost)');
    }
    // A partial failure on WebGL usually means the GPU context is dying: let the caller retry on CPU
    if ((faceFailed || objectFailed) && (await getActiveTfBackend()) !== 'cpu') {
      throw new Error('Partial AI inference failure on the GPU backend');
    }

    const animalClasses = ['cat', 'dog', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'];
    const detectedAnimalList = predictions
      .filter((p) => animalClasses.includes(p.class) && p.score >= 0.25)
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const hasAnimal = predictions.length === 0 ? true : detectedAnimalList.length > 0;
    const topAnimalClass = detectedAnimalList[0]?.class || '';
    const cocoToSpeciesMap = {
      dog: 'Dog',
      cat: 'Cat',
      bird: 'Bird',
      horse: 'Horse',
    };
    const detectedSpecies = cocoToSpeciesMap[topAnimalClass] || '';

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
      detectedSpecies,
    };
  }), []);

  // Inference with an automatic WebGL -> CPU backend fallback (Android WebGL context loss after backgrounding)
  const runAiCheck = useCallback(async (preparedDataUrl) => {
    try {
      return await runAiInference(preparedDataUrl);
    } catch (err) {
      const backend = await getActiveTfBackend();
      if (backend && backend !== 'cpu') {
        console.warn(`[AI Analysis] Inference failed on "${backend}" backend, retrying on CPU:`, err?.message || err);
        const switched = await switchTfToCpuBackend();
        if (switched) return await runAiInference(preparedDataUrl);
      }
      throw err;
    }
  }, [runAiInference]);

  /* AI verification with a dynamic timeout (cold: 15s, warm: 5s). If the first attempt fails or hangs
   * (typical for a lost WebGL context), TF.js is moved to the CPU backend and the check is retried once.
   * Resolves once `checkStatus` has been set (or the run became obsolete). */
  const processSelectedImage = useCallback(async (preparedDataUrl, runId) => {
    const isCurrent = () => runId === analysisRunIdRef.current;
    const runWithTimeout = (timeoutMs) => Promise.race([
      runAiCheck(preparedDataUrl).catch((err) => {
        console.warn('[AI Analysis] Attempt failed:', err?.message || err);
        return null;
      }),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    try {
      if (!isCurrent()) return;
      let result = await runWithTimeout(isAiWarm ? AI_CHECK_WARM_TIMEOUT_MS : AI_CHECK_COLD_TIMEOUT_MS);
      if (!isCurrent()) return;

      if (!result) {
        console.warn('[AI Analysis] 1st attempt returned no result, retrying on the CPU backend...');
        await sleep(RETRY_DELAY_MS);
        if (!isCurrent()) return;
        if ((await getActiveTfBackend()) !== 'cpu') await switchTfToCpuBackend();
        if (!isCurrent()) return;
        result = await runWithTimeout(AI_CHECK_COLD_TIMEOUT_MS);
        if (!isCurrent()) return;
      }

      if (result) {
        isAiWarm = true;
        setDetectedPerson(Boolean(result.hasPerson));
        setDetectedAnimal(Boolean(result.hasAnimal));
        if (result.detectedSpecies) {
          setSpecies((prev) => prev || result.detectedSpecies);
        }
        setCheckStatus('accepted');
      } else {
        console.warn('[AI Analysis] Timed out or unavailable after CPU retry — check skipped.');
        setCheckStatus('skipped');
      }
    } catch (err) {
      console.warn('[CreateMemorial] Image check error, check skipped:', err?.message || err);
      if (isCurrent()) setCheckStatus('skipped');
    }
  }, [runAiCheck]);

  /**
   * Photo selection: freezes the portrait card and runs the strictly sequential pipeline
   * (utils/photoPipeline.js steps A-D, then the AI check as step E). Step F unfreezes the card and renders
   * the finished in-memory JPEG data URL.
   */
  const handlePhotoSelect = useCallback(async (file) => {
    if (!file) return;
    if (preparingLockRef.current) return; // one photo at a time; the card is frozen meanwhile
    // Multiplatform image validation (Android, iOS HEIC, Desktop)
    const looksLikeImage = Boolean(
      file.type?.startsWith('image/') ||
      /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(file.name || '') ||
      (!file.type && file.size > 0)
    );
    if (!looksLikeImage || file.size === 0) {
      setError('Please select a valid image file (JPG, PNG, WebP, or HEIC)');
      setInputKey((k) => k + 1);
      return;
    }
    if (file.size > MAX_RAW_PHOTO_BYTES) {
      setError('Photo must be under 30 MB');
      setInputKey((k) => k + 1);
      return;
    }

    analysisRunIdRef.current += 1;
    const runId = analysisRunIdRef.current;
    const isCurrent = () => runId === analysisRunIdRef.current;
    preparingLockRef.current = true;
    previewRetryRef.current = 0;

    // Freeze the portrait card: no <img> is rendered while the pipeline works
    setError(null);
    setPhoto(null);
    setPreviewUrl('');
    setPreviewFailed(false);
    setCheckStatus('idle');
    setDetectedPerson(false);
    setDetectedAnimal(true);
    setHumanConsentGiven(false);
    setIsPreparingPhoto(true);

    try {
      // Steps A-D (wake-up pause, single arrayBuffer read, data URL, canvas JPEG), one after another
      const prepared = await preparePhotoSequentially(file, {
        isCurrent,
        maxDim: MAX_IMAGE_DIMENSION,
        // The picker file is fully copied into RAM: remount <input> so Chrome drops its cached handle
        onFileCopied: () => setInputKey((k) => k + 1),
      });
      if (!isCurrent()) return;

      // Step E: AI check, only on the finished in-memory JPEG (the resize canvas is already released).
      // The card waits a bounded time; a slower (cold) check keeps running and updates the badge later.
      if (prepared.previewFailed) {
        setCheckStatus('skipped');
      } else {
        setCheckStatus('checking');
        const aiDone = processSelectedImage(prepared.previewUrl, runId);
        await Promise.race([aiDone, sleep(isAiWarm ? PREP_AI_WAIT_WARM_MS : PREP_AI_WAIT_COLD_MS)]);
        if (!isCurrent()) return;
      }

      // Step F: unfreeze and render the prepared data URL
      setPhoto(prepared.uploadFile);
      setPreviewUrl(prepared.previewUrl);
      setPreviewFailed(prepared.previewFailed);
      setPreviewKey((k) => k + 1);
    } catch (err) {
      if (err instanceof PhotoPipelineCancelled || !isCurrent()) return;
      console.warn('[CreateMemorial] Photo preparation failed:', err?.message || err);
      setPhoto(null);
      setPreviewUrl('');
      setCheckStatus('idle');
      setInputKey((k) => k + 1);
      setError('We could not read this photo. Please select it again.');
    } finally {
      if (isCurrent()) {
        preparingLockRef.current = false;
        setIsPreparingPhoto(false);
      }
    }
  }, [processSelectedImage]);

  /**
   * <img> onError: the preview is a canvas-made JPEG data URL held in memory, so a failure is transient
   * (memory pressure). Remount the <img> once after a short pause, then fall back to the placeholder.
   */
  const handleImageError = useCallback(async () => {
    const runId = analysisRunIdRef.current;
    if (previewRetryRef.current < 1) {
      previewRetryRef.current += 1;
      console.warn('[CreateMemorial] <img> preview error, remounting once...');
      await sleep(RETRY_DELAY_MS);
      if (runId !== analysisRunIdRef.current) return;
      setPreviewKey((k) => k + 1);
      return;
    }
    console.warn('[CreateMemorial] Browser cannot render this photo, showing placeholder.');
    setPreviewFailed(true);
  }, []);

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
    const preferredWallet = resolveActivePrivyWallet(wallets, activeUserAddress) || externalWallet || embeddedWallet || wallets[0];
    if (!connector && !preferredWallet && !activeUserAddress) {
      console.error('Wallet connector is missing or Privy was blocked.');
      return 'Wallet connection failed. Please disable your adblocker or reconnect your wallet.';
    }
    if (isCreationPaused) return 'Memorial creation is temporarily paused by the protocol. Please try again later.';

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
        if (preferredWallet?.walletClientType === 'privy' || !connector) {
          if (preferredWallet?.switchChain) {
            await preferredWallet.switchChain(baseSepolia.id);
          }
        } else if (switchChainAsync && connector) {
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
  const sendCreateMemorialTx = ({ name, metadataTxId, isPublicFlag, fee }) =>
    sendContractWithPrivyFallback({
      writeContractAsync,
      connector,
      wallets,
      activeAddress: wagmiAddress || activeUserAddress,
      txParams: {
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'create_memorial',
        args: [name, metadataTxId, isPublicFlag],
        value: fee,
        chainId: baseSepolia.id,
      },
    });

  const FEE_UNAVAILABLE_MESSAGE = 'Could not load the current creation fee from the contract. Please check your connection and try again.';

  /**
   * On-chain deduplication: looks the Arweave metadata upload up on-chain BEFORE any (re)send.
   * If a memorial with this metadata already exists, nothing is minted again: the original tx is reused
   * (normal receipt flow) or, when only the token id is known, the success screen is shown directly.
   * @returns {Promise<{ tokenId: string, txHash: string | null } | null>}
   */
  const recoverExistingMint = async ({ metadataTxId, name, isPublicFlag, poll = false }) => {
    if (!metadataTxId || !publicClient || !contractAddress) return null;
    const lookup = { publicClient, contractAddress, abi: CONTRACT_ABI, metadataTxId };
    setIsVerifyingMint(true);
    let found = null;
    try {
      found = poll
        ? await waitForMintedMemorial(lookup, { attempts: 8, intervalMs: 4000 })
        : await findMintedMemorial(lookup);
    } catch (lookupErr) {
      console.warn('[CreateMemorial] On-chain duplicate check failed:', lookupErr?.shortMessage || lookupErr);
    } finally {
      setIsVerifyingMint(false);
    }
    if (!found) return null;

    console.log('[CreateMemorial] Memorial already exists on-chain for this upload — not minting again:', found);
    setPetName(name);
    setIsPublic(Boolean(isPublicFlag));
    setMintedIsPublic(Boolean(isPublicFlag));
    setError('');
    setUnconfirmedTxHash(null);
    acknowledgedPendingTxRef.current = null;
    if (found.txHash) {
      setFlowStep(3);
      setTxHash(found.txHash);
    } else {
      setRecoveredMint({ tokenId: found.tokenId });
    }
    return found;
  };

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
    let mintContext = null; // { metadataTxId, name, isPublicFlag } once the metadata upload is saved in the draft
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
        owner: account,
        createdAt: Date.now(),
      };
      persistDraft(draftData);
      mintContext = { metadataTxId, name, isPublicFlag: Boolean(isPublic) };

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
        // Mobile wallets (MetaMask over WalletConnect) often broadcast the tx but lose the response
        // ("An unknown RPC error occurred."). Check the chain before telling the user anything failed.
        const recovered = mintContext
          ? await recoverExistingMint({ ...mintContext, poll: isAmbiguousSendError(err) })
          : null;
        if (recovered) {
          sentHash = recovered.txHash || null;
        } else {
          const message = formatTxError(err, 'Minting failed. Please try again.');
          if (/creation fee changed/i.test(message)) refetchCreationFee();
          setError(
            mintContext && isAmbiguousSendError(err)
              ? `${message} No memorial was found on-chain for this upload, so it is safe to use "Resume Minting".`
              : message
          );
        }
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
      const draftPublic = Boolean(targetDraft.isPublic ?? false);
      const mintContext = { metadataTxId: targetDraft.metadataTxId, name, isPublicFlag: draftPublic };

      // On-chain deduplication FIRST (works with any connected account, even with an empty balance):
      // a previous attempt may have been mined even though the wallet reported an RPC error.
      const alreadyMinted = await recoverExistingMint(mintContext);
      if (alreadyMinted) {
        sentHash = alreadyMinted.txHash || null;
        return;
      }

      if (isInsufficientFunds) { setError(INSUFFICIENT_FUNDS_MESSAGE); return; }

      const walletError = await ensureWalletReady();
      if (walletError) { setError(walletError); return; }
      const account = wagmiAddress || activeUserAddress;

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
        const recovered = await recoverExistingMint({
          metadataTxId: targetDraft.metadataTxId,
          name: String(targetDraft.petName || '').trim(),
          isPublicFlag: Boolean(targetDraft.isPublic ?? false),
          poll: isAmbiguousSendError(err),
        });
        if (recovered) {
          sentHash = recovered.txHash || null;
        } else {
          const message = formatTxError(err, 'Minting failed. Please try again.');
          if (/creation fee changed/i.test(message)) refetchCreationFee();
          setError(message);
        }
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

  const isSubmitting = isInitiating || flowStep > 0 || isMinting || isConfirming || isVerifyingMint || (Boolean(txHash) && !isSuccess);
  const finalTokenId = createdTokenId || recoveredMint?.tokenId || null;

  /* ── Success screen ────────────────────────────────────── */
  if (showSuccess) {
    const isPublicTribute = Boolean(mintedIsPublic);
    const memorialTargetUrl = finalTokenId ? `/memorial/${finalTokenId}` : '/my';
    const memorialShareUrl = finalTokenId
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}${import.meta.env.BASE_URL}#/memorial/${finalTokenId}`
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
                  className="w-full sm:w-auto whitespace-nowrap text-xs md:text-sm px-5 py-3.5 gap-2 inline-flex items-center justify-center bg-[#8a4f36] text-white rounded-2xl font-semibold uppercase tracking-wider hover:opacity-90 transition-opacity shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base shrink-0">visibility</span>
                  <span>View Memorial</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="w-full sm:w-auto whitespace-nowrap text-xs md:text-sm px-5 py-3.5 gap-2 inline-flex items-center justify-center border border-[#d8c2ba] text-[#53433e] hover:bg-[#f5efe6] rounded-2xl font-semibold uppercase tracking-wider transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base shrink-0">explore</span>
                  <span>Browse Gallery</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate(memorialTargetUrl)}
                  className="w-full sm:w-auto whitespace-nowrap text-xs md:text-sm px-5 py-3.5 gap-2 inline-flex items-center justify-center bg-[#8a4f36] text-white rounded-2xl font-semibold uppercase tracking-wider hover:opacity-90 transition-opacity shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base shrink-0">arrow_forward</span>
                  <span>Open Memorial</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowShareModal(true)}
                  className="w-full sm:w-auto whitespace-nowrap text-xs md:text-sm px-5 py-3.5 gap-2 inline-flex items-center justify-center border border-[#d8c2ba] bg-[#fbf5f2] text-[#8a4f36] hover:bg-[#f3ebe4] hover:text-[#2C2520] rounded-2xl font-semibold uppercase tracking-wider transition-colors shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base shrink-0">qr_code_2</span>
                  <span>Share &amp; QR Code</span>
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
          memorialId={finalTokenId || ''}
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
        <div className="max-w-md w-full text-center p-8 bg-stone-50 border border-stone-200 rounded-[28px] shadow-sm space-y-6 animate-fadeIn">
          <div className="w-16 h-16 rounded-full bg-[#ebddd5] flex items-center justify-center mx-auto text-[#8a4f36] shadow-sm">
            <span className="material-symbols-outlined text-3xl">mail</span>
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
              Sign In to Continue
            </h2>
            <p className="text-[#53433e] text-sm leading-relaxed max-w-sm mx-auto">
              Enter your email to automatically create and connect your personal blockchain wallet — no crypto apps or extensions needed.
            </p>
          </div>
          <div className="pt-1 flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => login({ loginMethods: ['email'] })}
              className="w-full inline-flex items-center justify-center gap-2 bg-[#8a4f36] hover:bg-[#723f2b] text-white px-7 py-3.5 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all shadow-sm cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">mail</span>
              <span>Continue with Email</span>
            </button>
            <p className="text-xs text-[#8a4f36] font-medium">
              ✨ Creates your built-in wallet automatically via email
            </p>

            <div className="w-full flex items-center gap-3 py-2">
              <div className="flex-1 h-px bg-[#d8c2ba]/60" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-[#85736d]">
                Or for Web3 wallet users
              </span>
              <div className="flex-1 h-px bg-[#d8c2ba]/60" />
            </div>

            <button
              type="button"
              onClick={() => connectWallet()}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-2xl text-xs font-semibold uppercase tracking-wider text-[#53433e] bg-white hover:bg-[#f5efe6] border border-[#d8c2ba] transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">account_balance_wallet</span>
              <span>Connect External Wallet</span>
            </button>
            {showMetaMaskDeepLink && (
              <a
                href={getMetaMaskDappDeepLink()}
                className="w-full inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-medium text-[#8a4f36] hover:bg-[#f5efe6] transition-colors"
              >
                <span className="material-symbols-outlined text-sm">open_in_new</span>
                <span>Open in MetaMask App</span>
              </a>
            )}
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
          <div ref={errorBannerRef} role="alert" className="mb-6 scroll-mt-28 bg-[#ffdad6] border border-[#ba1a1a]/20 rounded-xl px-4 py-3 text-sm text-[#93000a] break-words">
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
          <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-6 md:p-8 space-y-8">
            {/* Photo drop zone */}
            <div>
              <label className={labelBase}>Pet Portrait</label>
              {/* File input accessible to iOS Safari and Android */}
              <input
                key={`photo-input-${inputKey}`}
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
                disabled={isPreparingPhoto}
                onChange={(e) => {
                  const selectedFile = e.target.files?.[0];
                  if (selectedFile) {
                    handlePhotoSelect(selectedFile);
                  }
                }}
              />

              {isPreparingPhoto ? (
                <div
                  className="relative w-full h-56 rounded-2xl overflow-hidden border border-amber-900/10 bg-[#fdfbf9] flex flex-col items-center justify-center text-center px-6 animate-fadeIn"
                  role="status"
                  aria-live="polite"
                  aria-busy="true"
                >
                  <span className="inline-block w-8 h-8 border-[3px] border-[#d48c6f] border-t-transparent rounded-full animate-spin mb-4" />
                  <span className="text-[15px] text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
                    Preparing portrait...
                  </span>
                  <span className="text-xs text-[#85736d] mt-1.5 max-w-xs leading-relaxed">
                    Optimizing image &amp; initializing memory check — please wait a moment
                  </span>
                </div>
              ) : photo ? (
                <div className="space-y-3 animate-fadeIn">
                  <div className="relative w-full h-56 rounded-2xl overflow-hidden border border-amber-900/10 bg-[#f5f3f0]">
                    {previewUrl && !previewFailed ? (
                      <img
                        key={`photo-preview-${previewKey}`}
                        src={previewUrl}
                        alt={photo?.name || 'Pet Portrait'}
                        className="w-full h-full object-cover"
                        onError={handleImageError}
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-center px-6">
                        {previewFailed ? (
                          <>
                            <span className="material-symbols-outlined text-4xl text-[#d8c2ba] mb-2">pets</span>
                            <span className="text-[15px] text-[#53433e]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
                              Portrait Selected &amp; Ready
                            </span>
                            <span className="text-xs text-[#85736d] mt-1">
                              Your browser cannot preview this format, but your photo will be preserved on-chain
                            </span>
                          </>
                        ) : (
                          <span className="inline-block w-5 h-5 border-2 border-[#8a4f36] border-t-transparent rounded-full animate-spin" />
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleRemoveImage();
                      }}
                      className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white rounded-full transition-colors flex items-center justify-center w-9 h-9 text-sm cursor-pointer touch-manipulation"
                      title="Remove photo"
                      aria-label="Remove photo"
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
          <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-6 md:p-8 space-y-8">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <label className={labelBase}>Birth Date</label>
                <input
                  className={inputBase}
                  type="date"
                  min={`${MIN_YEAR}-01-01`}
                  max={todayISO}
                  value={birthDate}
                  onChange={(e) => {
                    const val = e.target.value;
                    setBirthDate(val);
                    if (val && /^\d{4}/.test(val)) {
                      setBirthYear(val.slice(0, 4));
                    } else if (!val) {
                      setBirthYear('');
                    }
                  }}
                />
              </div>
              <div>
                <label className={labelBase}>Memorial Date</label>
                <input
                  className={inputBase}
                  type="date"
                  min={`${MIN_YEAR}-01-01`}
                  max={todayISO}
                  value={memorialDate}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMemorialDate(val);
                    if (val && /^\d{4}/.test(val)) {
                      setPassingYear(val.slice(0, 4));
                    } else if (!val) {
                      setPassingYear('');
                    }
                  }}
                />
              </div>
              <div className={birthDate ? 'opacity-40 pointer-events-none select-none transition-opacity' : 'transition-opacity'}>
                <label className={labelBase}>
                  {birthDate ? 'Birth Year (synced from date)' : 'Birth Year (if exact date unknown)'}
                </label>
                <input
                  className={inputBase}
                  type="number"
                  min={MIN_YEAR}
                  max={currentYear}
                  step={1}
                  placeholder="e.g. 2012"
                  value={birthDate ? birthDate.slice(0, 4) : birthYear}
                  readOnly={Boolean(birthDate)}
                  tabIndex={birthDate ? -1 : 0}
                  onChange={(e) => setBirthYear(e.target.value)}
                />
              </div>
              <div className={memorialDate ? 'opacity-40 pointer-events-none select-none transition-opacity' : 'transition-opacity'}>
                <label className={labelBase}>
                  {memorialDate ? 'Passing Year (synced from date)' : 'Passing Year (if exact date unknown)'}
                </label>
                <input
                  className={inputBase}
                  type="number"
                  min={MIN_YEAR}
                  max={currentYear}
                  step={1}
                  placeholder="e.g. 2024"
                  value={memorialDate ? memorialDate.slice(0, 4) : passingYear}
                  readOnly={Boolean(memorialDate)}
                  tabIndex={memorialDate ? -1 : 0}
                  onChange={(e) => setPassingYear(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className={labelBase} htmlFor="bio">A Brief Memory</label>
              <textarea
                id="bio" rows={5}
                className="w-full border border-stone-200/90 bg-[#FAF7F2]/50 focus:bg-white focus:border-[#C87D65] focus:ring-2 focus:ring-[#C87D65]/15 rounded-2xl p-4 text-base text-[#1b1c1a] placeholder-[#85736d] outline-none transition-all resize-none"
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
            <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-6 md:p-8 space-y-5">
              <h3 className="text-xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
                Review your Memorial
              </h3>

              <div className="flex flex-col md:flex-row items-center md:items-center gap-6 md:gap-8 pt-1">
                {/* Left (or Top on mobile): Vertical 4:5 Memorial Arch Preview */}
                <div className="w-36 h-44 md:w-40 md:h-48 rounded-t-full rounded-b-2xl overflow-hidden border-2 border-amber-500/30 shadow-md shrink-0 bg-[#f5f3f0] flex items-center justify-center">
                  {photo && previewUrl && !previewFailed ? (
                    <img
                      key={`arch-preview-${previewKey}`}
                      src={previewUrl}
                      alt={photo?.name || 'Pet Portrait'}
                      className="w-full h-full object-cover"
                      onError={handleImageError}
                    />
                  ) : photo ? (
                    <div className="flex flex-col items-center justify-center text-[#85736d] p-4 text-center">
                      <span className="material-symbols-outlined text-3xl text-[#d8c2ba] mb-1">pets</span>
                      <span className="text-[11px]">Portrait Selected &amp; Ready</span>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center text-[#85736d] p-4 text-center">
                      <span className="material-symbols-outlined text-3xl text-[#d8c2ba] mb-1">pets</span>
                      <span className="text-[11px]">No photo selected</span>
                    </div>
                  )}
                </div>

                {/* Right: Refined Memorial Typography */}
                <div className="flex-1 w-full text-center md:text-left space-y-3">
                  <div>
                    <h4
                      className="font-serif text-2xl text-[#1b1c1a] leading-tight"
                      style={{ fontFamily: "'Libre Caslon Text', serif" }}
                    >
                      {petName || 'Unnamed Companion'}
                    </h4>
                    {(species || breed || birthDate || memorialDate || birthYear || passingYear) && (
                      <p className="text-xs uppercase tracking-widest text-[#8a4f36] font-semibold mt-1.5">
                        {[
                          [species, breed].filter(Boolean).join(' · '),
                          (birthDate || birthYear || memorialDate || passingYear)
                            ? `${birthDate || birthYear || '?'} – ${memorialDate || passingYear || '?'}`
                            : '',
                        ]
                          .filter(Boolean)
                          .join('  •  ')}
                      </p>
                    )}
                  </div>

                  {description ? (
                    <div className="bg-[#FAF7F2] border border-stone-200/80 rounded-xl px-4 py-3 text-sm text-[#53433e] italic leading-relaxed">
                      &ldquo;{description}&rdquo;
                    </div>
                  ) : (
                    <p className="text-xs text-[#85736d] italic">
                      No custom epitaph entered — a gentle default tribute will be inscribed.
                    </p>
                  )}

                  <div className="pt-2 border-t border-stone-200/70 flex flex-wrap items-center justify-center md:justify-start gap-x-5 gap-y-1.5 text-xs text-[#53433e]">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-semibold text-[#1b1c1a]">Visibility:</span>
                      <span>{isPublic ? 'Public Gallery' : 'Unlisted (Private)'}</span>
                    </span>
                    <span className="text-stone-300 hidden sm:inline">•</span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-semibold text-[#1b1c1a]">Creation Fee:</span>
                      <span className="font-semibold text-[#8a4f36]">
                        {isFeeKnown ? `${creationFeeLabel} ETH` : 'Loading fee…'}
                      </span>
                    </span>
                  </div>
                </div>
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
          </div>
        )}

        {/* ── Navigation ── */}
        {!isSubmitting ? (
          <div
            className={`flex pt-6 border-t border-[#d8c2ba]/30 mt-6 ${
              step === 0
                ? 'items-center justify-end'
                : step === 1
                  ? 'items-center justify-between gap-4'
                  : 'flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3'
            }`}
          >
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="px-6 py-3.5 border border-stone-300 text-stone-600 hover:bg-stone-100 rounded-2xl text-xs font-semibold tracking-widest uppercase transition-colors cursor-pointer text-center"
              >
                Back
              </button>
            )}
            {step < 2 ? (
              <button
                type="button"
                onClick={() => {
                  if (isPreparingPhoto) return;
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
                disabled={(step === 0 && detectedPerson && !humanConsentGiven) || isPreparingPhoto}
                className="flex items-center justify-center gap-2 bg-[#c27357] hover:bg-[#8a4f36] text-white px-8 py-3.5 rounded-2xl text-xs font-semibold tracking-widest uppercase transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-xs"
              >
                <span>Continue</span>
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </button>
            ) : (
              <form onSubmit={handleSubmit} className="flex-1 sm:max-w-sm">
                <button
                  type="submit"
                  disabled={isSubmitting || !petName.trim() || isInsufficientFunds || isCreationPaused || !isFeeKnown}
                  className="w-full min-h-[48px] flex items-center justify-center gap-2.5 bg-[#c27357] hover:bg-[#8a4f36] text-white px-4 sm:px-7 py-3.5 rounded-2xl text-xs sm:text-sm font-semibold tracking-wider uppercase text-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-xs whitespace-normal sm:whitespace-nowrap touch-manipulation"
                >
                  {isCreationPaused ? (
                    <span>Memorial Creation Paused</span>
                  ) : !isFeeKnown ? (
                    <span>Loading fee…</span>
                  ) : isInsufficientFunds ? (
                    <span>Insufficient ETH ({creationFeeLabel} ETH + gas)</span>
                  ) : (
                    <>
                      <span>Preserve Forever ({creationFeeLabel} ETH)</span>
                      <span className="material-symbols-outlined text-base">arrow_forward</span>
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        ) : (
          step === 2 && (
            <div className="pt-6 border-t border-[#d8c2ba]/30 mt-6">
              <button
                type="button"
                disabled
                className="w-full flex items-center justify-center gap-3 bg-[#c27357] text-white py-4 rounded-2xl text-sm font-semibold tracking-wider uppercase opacity-60 cursor-not-allowed"
              >
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>{isVerifyingMint ? 'Checking the blockchain…' : isConfirming || txHash ? 'Confirming on-chain…' : 'Minting…'}</span>
              </button>
            </div>
          )
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
