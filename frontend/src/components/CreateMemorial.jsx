import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChainId, useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useBalance, useSwitchChain } from 'wagmi';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { formatEther, decodeEventLog } from 'viem';
import { baseSepolia } from 'viem/chains';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress } from '../config/chains';
import {
  uploadToArweave, uploadJsonToArweave, buildNftMetadata,
} from '../utils/arweave';
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
const THUMBNAIL_MAX_DIMENSION = 500;          // px, max dimension for fast initial thumbnail
const THUMBNAIL_QUALITY = 0.75;               // fast preview quality
const AI_CHECK_COLD_TIMEOUT_MS = 12000;       // 12s timeout for cold start while models download
const AI_CHECK_WARM_TIMEOUT_MS = 4000;        // 4s timeout for warm start once models are cached

/**
 * Fast lightweight thumbnail generation (<= 500px, JPEG 0.75 Data URL) for instant zero-lag preview.
 * Prevents WebKit/Chromium decoder memory crashes on 12-48MP raw phone photos.
 * Returns a small base64 Data URL (~20-40 KB) with no ObjectURL lifecycle or revocation bugs.
 */
async function generateThumbnail(file, maxDim = THUMBNAIL_MAX_DIMENSION, quality = THUMBNAIL_QUALITY) {
  if (!file || !file.type?.startsWith('image/') || file.type === 'image/gif') {
    return null;
  }

  let source = null;
  let width = 0;
  let height = 0;
  let cleanup = () => {};

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
      cleanup = () => bitmap.close?.();
    } catch {
      // Android Chrome or mobile WebViews can fail when options dictionary is provided
      try {
        const bitmap = await createImageBitmap(file);
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
        cleanup = () => bitmap.close?.();
      } catch {
        source = null;
      }
    }
  }

  if (!source) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = (err) => reject(err);
        img.src = url;
      });
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
      cleanup = () => URL.revokeObjectURL(url);
    } catch {
      URL.revokeObjectURL(url);
      // Fallback via FileReader readAsDataURL if blob ObjectURL decoding failed
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = reject;
          img.src = dataUrl;
        });
        source = img;
        width = img.naturalWidth;
        height = img.naturalHeight;
        cleanup = () => {};
      } catch {
        return null;
      }
    }
  }

  if (!width || !height) {
    cleanup();
    return null;
  }

  const scale = Math.min(1, maxDim / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    cleanup();
    return null;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
  cleanup(); // Safely called AFTER drawImage

  try {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    canvas.width = 0;
    canvas.height = 0;
    return dataUrl;
  } catch {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }
}

/**
 * Downscale a photo via Canvas (max 1000px, JPEG 0.8) asynchronously so phone camera images
 * (10+ MB) don't exhaust browser memory or Arweave storage.
 * Falls back to the original file on any failure and never throws.
 */
async function resizeImage(file, maxWidth = MAX_IMAGE_DIMENSION, maxHeight = MAX_IMAGE_DIMENSION, quality = COMPRESSION_QUALITY) {
  try {
    if (!file || !file.type?.startsWith('image/') || file.type === 'image/gif') return file;

    let source = null;
    let width = 0;
    let height = 0;
    let cleanup = () => {};

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
        cleanup = () => bitmap.close?.();
      } catch {
        try {
          const bitmap = await createImageBitmap(file);
          source = bitmap;
          width = bitmap.width;
          height = bitmap.height;
          cleanup = () => bitmap.close?.();
        } catch {
          source = null;
        }
      }
    }

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
        cleanup = () => URL.revokeObjectURL(url);
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
let cachedFaceModelPromise = null;
let cachedObjectModelPromise = null;
let tfModulePromise = null;
let isAiWarm = false;

async function getTf() {
  if (!tfModulePromise) {
    tfModulePromise = import('@tensorflow/tfjs');
  }
  return tfModulePromise;
}

function resetAiModeration() {
  if (tfModulePromise) {
    tfModulePromise.then((tf) => {
      try {
        tf.disposeVariables();
      } catch {
        // ignore
      }
    }).catch(() => {});
  }
  // DO NOT wipe cachedFaceModelPromise or cachedObjectModelPromise here.
  // Models are statically loaded once per session to prevent repeated ~20MB downloads.
}

async function getFaceModel() {
  if (!cachedFaceModelPromise) {
    cachedFaceModelPromise = (async () => {
      const blazeface = await import('@tensorflow-models/blazeface');
      return blazeface.load();
    })();
  }
  return cachedFaceModelPromise;
}

async function getObjectModel() {
  if (!cachedObjectModelPromise) {
    cachedObjectModelPromise = (async () => {
      const cocoSsd = await import('@tensorflow-models/coco-ssd');
      return cocoSsd.load({ base: 'lite_mobilenet_v2' });
    })();
  }
  return cachedObjectModelPromise;
}

async function preloadAiModels() {
  try {
    await Promise.all([getFaceModel(), getObjectModel()]);
    isAiWarm = true;
  } catch (e) {
    console.warn('[AI Preload] Background warmup note:', e);
  }
}

export default function CreateMemorial() {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const chainId = useChainId();
  const navigate = useNavigate();
  const contractAddress = getContractAddress(chainId);
  const { switchChainAsync } = useSwitchChain();

  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  // Fallback to the first available wallet if not using embedded
  const userAddress = embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;
  const { address: wagmiAddress, connector, chain } = useAccount();
  const activeUserAddress = wagmiAddress || userAddress;
  const { data: balance } = useBalance({ address: activeUserAddress });
  const isConnected = ready && authenticated;

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
  const [previewFailed, setPreviewFailed] = useState(false);
  const [isPublic, setIsPublic] = useState(false);

  // AI Verification State (informational only — never blocks the wizard)
  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);
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
  const [mintedIsPublic, setMintedIsPublic] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  // Tracking in-flight AI analysis runs to discard obsolete analysis results
  const analysisRunIdRef = useRef(0);

  // Dedicated file input ref for reliable reset across repeated creations
  const fileInputRef = useRef(null);

  // Current preview object URL, kept in a ref so it can be revoked only on unmount or file replacement
  const previewUrlRef = useRef('');
  const thumbUrlRef = useRef('');
  const objectUrlFailedRef = useRef(false);
  const isGeneratingThumbnailRef = useRef(false);

  // Background warmup of AI models on component mount
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        window.requestIdleCallback(() => {
          if (!cancelled) preloadAiModels();
        }, { timeout: 4000 });
      } else {
        preloadAiModels();
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = '';
      }
      resetAiModeration();
    };
  }, []);

  const handleRemoveImage = useCallback(() => {
    analysisRunIdRef.current += 1;
    if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = '';
    thumbUrlRef.current = '';
    objectUrlFailedRef.current = false;
    isGeneratingThumbnailRef.current = false;
    if (fileInputRef.current) fileInputRef.current.value = '';
    setPhoto(null);
    setPreviewUrl('');
    setPreviewFailed(false);
    setError(null);
    setIsAnalyzingImage(false);
    setCheckStatus('idle');
    setDetectedPerson(false);
    setDetectedAnimal(true);
    setHumanConsentGiven(false);
    resetAiModeration();
  }, []);

  const { writeContractAsync } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isReceiptError, data: receipt } = useWaitForTransactionReceipt({ hash: txHash });

  // Decode created memorial tokenId from transaction logs
  const createdTokenId = useMemo(() => {
    if (!receipt?.logs) return null;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: CONTRACT_ABI,
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
  }, [receipt]);

  // Handle transaction receipt error
  useEffect(() => {
    if (isReceiptError) {
      setError('Transaction reverted on-chain. Please verify and try again.');
      setTxHash(null);
      setIsMinting(false);
      setIsInitiating(false);
      setFlowStep(0);
    }
  }, [isReceiptError]);

  // Draft recovery state
  const [draft, setDraft] = useState(null);

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
    if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = '';
    thumbUrlRef.current = '';
    objectUrlFailedRef.current = false;
    isGeneratingThumbnailRef.current = false;
    setPreviewUrl('');
    setPreviewFailed(false);
    setIsPublic(false);
    setIsAnalyzingImage(false);
    setCheckStatus('idle');
    setDetectedPerson(false);
    setDetectedAnimal(true);
    setHumanConsentGiven(false);
    setFlowStep(0);
    setError(null);
    setIsMinting(false);
    setIsInitiating(false);
    setTxHash(null);
    setMintedIsPublic(false);
    setShowShareModal(false);
    resetAiModeration();
  }, []);

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
      localStorage.removeItem('draft_memorial');
      setDraft(null);
      analysisRunIdRef.current += 1;
      if (fileInputRef.current) fileInputRef.current.value = '';
      setPhoto(null);
      if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      previewUrlRef.current = '';
      thumbUrlRef.current = '';
      objectUrlFailedRef.current = false;
      isGeneratingThumbnailRef.current = false;
      setPreviewUrl('');
      setPreviewFailed(false);
      setIsAnalyzingImage(false);
      setCheckStatus('idle');
      setError(null);
      resetAiModeration();
    }
  }, [isSuccess]);

  // Read creation_fee from contract
  const { data: creationFeeRaw, refetch: refetchCreationFee } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'creation_fee',
  });
  const creationFee = creationFeeRaw ? BigInt(creationFeeRaw) : 2_000_000_000_000_000n; // fallback 0.002 ETH

  // Read creation_paused from contract (on-chain invariant guard)
  const { data: creationPaused } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'creation_paused',
  });
  const isCreationPaused = Boolean(creationPaused);

  const isInsufficientFunds = Boolean(balance?.value !== undefined && balance.value < creationFee);

  /* ── Non-blocking AI image check ───────────────────────────
   * Runs on a small compressed copy or thumbnail. Resolves with
   * { hasPerson, hasAnimal }; may throw (callers treat that as "skipped"). */
  const runAiCheck = useCallback(async (imageUrl) => {
    const tf = await getTf();
    const img = new Image();
    try {
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load image for AI analysis'));
        img.src = imageUrl;
      });

      let faces = [];
      let predictions = [];

      // Guarantee clean tensor memory by wrapping in tf.engine().startScope() / endScope()
      tf.engine().startScope();
      try {
        const faceModel = await getFaceModel();
        faces = await faceModel.estimateFaces(img, false);
      } catch (faceErr) {
        console.warn('[AI Analysis] Face detection warning:', faceErr);
      }

      try {
        const objectModel = await getObjectModel();
        predictions = await objectModel.detect(img);
      } catch (objErr) {
        console.warn('[AI Analysis] Object detection warning:', objErr);
      } finally {
        tf.engine().endScope();
      }

      const animalClasses = ['cat', 'dog', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'];
      return {
        hasPerson: (faces && faces.length > 0) || predictions.some((p) => p.class === 'person' && p.score > 0.35),
        hasAnimal: predictions.some((p) => animalClasses.includes(p.class) && p.score > 0.20),
      };
    } finally {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    }
  }, []);

  /* Background AI verification pipeline: runs with dynamic timeout (cold: 12s, warm: 4s).
   * Fast preview is already on screen; nothing here blocks the UI. */
  const processSelectedImage = useCallback(async (file, thumbDataUrl, runId) => {
    const isCurrent = () => runId === analysisRunIdRef.current;
    let tempUrl = null;
    try {
      if (!isCurrent()) return;

      // Use fast thumbnail if available; otherwise use current objectUrl or create a temp one
      let aiUrl = thumbDataUrl;
      if (!aiUrl) {
        if (previewUrlRef.current) {
          aiUrl = previewUrlRef.current;
        } else {
          tempUrl = URL.createObjectURL(file);
          aiUrl = tempUrl;
        }
      }

      const timeoutMs = isAiWarm ? AI_CHECK_WARM_TIMEOUT_MS : AI_CHECK_COLD_TIMEOUT_MS;

      const result = await Promise.race([
        runAiCheck(aiUrl).catch((err) => {
          console.warn('[AI Analysis] Check failed, skipping:', err?.message || err);
          return null;
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (!isCurrent()) return;

      if (result) {
        isAiWarm = true;
        setDetectedPerson(result.hasPerson);
        setDetectedAnimal(result.hasAnimal);
        setCheckStatus('accepted');
      } else {
        console.warn('[AI Analysis] Timed out or unavailable — check skipped.');
        setCheckStatus('skipped');
      }
    } catch (err) {
      console.warn('[CreateMemorial] Image processing error, check skipped:', err?.message || err);
      if (isCurrent()) setCheckStatus('skipped');
    } finally {
      if (tempUrl) URL.revokeObjectURL(tempUrl);
      if (isCurrent()) setIsAnalyzingImage(false);
    }
  }, [runAiCheck]);

  /* ── Photo handlers ────────────────────────────────────── */
  const handlePhotoSelect = useCallback(async (file) => {
    if (!file) return;

    const isHeic = file.type === 'image/heic' || file.type === 'image/heif' || /\.(heic|heif)$/i.test(file.name || '');
    if (isHeic) {
      setError('HEIC format is not supported by your browser. Please select a JPG or PNG photo.');
      setPreviewFailed(true);
      return;
    }

    const looksLikeImage = file.type?.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(file.name || '');
    if (!looksLikeImage) {
      setError('Please select a valid image file (JPG, PNG, or WebP)');
      setPreviewFailed(true);
      return;
    }
    if (file.size > MAX_RAW_PHOTO_BYTES) {
      setError('Photo must be under 30 MB');
      setPreviewFailed(true);
      return;
    }

    analysisRunIdRef.current += 1;
    const runId = analysisRunIdRef.current;
    const isCurrent = () => runId === analysisRunIdRef.current;

    // Reset error & states
    setError(null);
    setPhoto(file);
    setPreviewFailed(false);
    objectUrlFailedRef.current = false;
    thumbUrlRef.current = '';

    // Reset previous check results
    setDetectedPerson(false);
    setDetectedAnimal(true);
    setHumanConsentGiven(false);
    setCheckStatus('checking');
    setIsAnalyzingImage(true);

    // 1) Instant Zero-Wait Preview: synchronously create Object URL
    const objectUrl = URL.createObjectURL(file);
    if (previewUrlRef.current && previewUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    previewUrlRef.current = objectUrl;
    setPreviewUrl(objectUrl);

    // 2) Generate lightweight thumbnail concurrently in background
    isGeneratingThumbnailRef.current = true;
    generateThumbnail(file, THUMBNAIL_MAX_DIMENSION, THUMBNAIL_QUALITY)
      .then((thumbDataUrl) => {
        if (!isCurrent()) return;
        isGeneratingThumbnailRef.current = false;

        if (thumbDataUrl) {
          thumbUrlRef.current = thumbDataUrl;
          // Switch to lightweight thumbnail DataURL for memory efficiency
          setPreviewUrl(thumbDataUrl);
          setPreviewFailed(false);
        } else if (objectUrlFailedRef.current) {
          setPreviewFailed(true);
        }

        // Run AI verification on lightweight thumbnail or objectUrl
        processSelectedImage(file, thumbDataUrl, runId);
      })
      .catch((thumbErr) => {
        console.warn('[CreateMemorial] Thumbnail generation error:', thumbErr);
        if (!isCurrent()) return;
        isGeneratingThumbnailRef.current = false;
        if (objectUrlFailedRef.current) {
          setPreviewFailed(true);
        }
        processSelectedImage(file, null, runId);
      });

    // 3) Background safe compression for Arweave payload (never blocks preview or UI)
    resizeImage(file, 1000, 1000, COMPRESSION_QUALITY)
      .then((compressed) => {
        if (isCurrent() && compressed && compressed !== file) {
          setPhoto(compressed);
        }
      })
      .catch((compErr) => {
        console.warn('[CreateMemorial] Background compression note:', compErr);
      });
  }, [processSelectedImage]);

  const handleImageError = useCallback(() => {
    // If currently rendering DataURL and ObjectURL exists, try ObjectURL
    if (previewUrl && previewUrl.startsWith('data:') && previewUrlRef.current) {
      console.warn('[CreateMemorial] DataURL preview failed, falling back to ObjectURL');
      setPreviewUrl(previewUrlRef.current);
      return;
    }
    // If currently rendering ObjectURL
    if (previewUrl && previewUrl.startsWith('blob:')) {
      objectUrlFailedRef.current = true;
      // If thumbnail is already ready, switch to it immediately
      if (thumbUrlRef.current) {
        console.warn('[CreateMemorial] ObjectURL preview failed, falling back to Thumbnail DataURL');
        setPreviewUrl(thumbUrlRef.current);
        return;
      }
      // If thumbnail is still being generated, do not fail yet
      if (isGeneratingThumbnailRef.current) {
        console.warn('[CreateMemorial] ObjectURL preview failed, waiting for background thumbnail...');
        return;
      }
    }
    setPreviewFailed(true);
  }, [previewUrl]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('border-[#8a4f36]');
    const file = e.dataTransfer.files[0];
    if (file) handlePhotoSelect(file);
  }, [handlePhotoSelect]);

  /* ── Submit flow: Arweave upload → mint ──────────────── */
  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (isInitiating || isMinting || isConfirming || Boolean(txHash) || flowStep > 0) return;
    setIsInitiating(true);

    if (!isConnected) { setIsInitiating(false); setError('Please connect your wallet first'); return; }
    if (!connector) {
      setIsInitiating(false);
      console.error("Wallet connector is missing or Privy was blocked.");
      setError("Wallet connection failed. Please disable your adblocker or reconnect your wallet.");
      return;
    }
    if (!petName.trim()) { setIsInitiating(false); setError('Pet name is required'); return; }
    if (detectedPerson && !humanConsentGiven) {
      setIsInitiating(false);
      setError('Please confirm consent for the person detected in the photo');
      return;
    }
    if (isCreationPaused) {
      setIsInitiating(false);
      setError('Memorial creation is temporarily paused by the protocol. Please try again later.');
      return;
    }
    if (isInsufficientFunds) {
      setIsInitiating(false);
      setError('Insufficient ETH Balance to mint memorial.');
      return;
    }
    if (chain?.id !== baseSepolia.id) {
      try {
        await switchChainAsync({ chainId: baseSepolia.id });
      } catch (switchErr) {
        setIsInitiating(false);
        console.error('[CreateMemorial] Failed to switch network:', switchErr);
        setError('Please switch your wallet network to Base Sepolia to continue.');
        return;
      }
    }
    setError('');

    try {
      setFlowStep(1);
      let imageTxId = '';
      if (photo) imageTxId = await uploadToArweave(photo, [{ name: 'Pet-Name', value: petName }]);

      setFlowStep(2);
      const metadata = buildNftMetadata({ petName, description, birthDate, memorialDate, birthYear, passingYear, species, breed, imageTxId, ownerAddress: userAddress });
      const metadataTxId = await uploadJsonToArweave(metadata);

      // Save draft immediately after Arweave metadata upload succeeds
      const draftData = {
        metadataTxId,
        petName,
        isPublic,
        createdAt: Date.now(),
      };
      localStorage.setItem('draft_memorial', JSON.stringify(draftData));
      setDraft(draftData);

      setFlowStep(3);
      setIsMinting(true);
      setMintedIsPublic(Boolean(isPublic));
      console.log('[CreateMemorial] Triggering writeContractAsync...');

      // Fetch latest creation fee dynamically to guarantee sending the exact amount required by the contract
      let currentFee = creationFee;
      try {
        const { data: latestFee } = await refetchCreationFee();
        if (latestFee) currentFee = BigInt(latestFee);
      } catch (fErr) {
        console.warn('[CreateMemorial] Failed to refetch latest fee, using cached:', fErr);
      }

      const hash = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'create_memorial',
        args: [petName, metadataTxId, isPublic],
        value: currentFee,
        account: userAddress,
        connector,
        chainId: baseSepolia.id,
      });

      console.log('[CreateMemorial] Success Tx Hash:', hash);
      // Immediately clear local draft upon receiving tx hash to prevent duplicate submissions
      localStorage.removeItem('draft_memorial');
      setDraft(null);
      setTxHash(hash);
      setIsMinting(false);
      setIsInitiating(false);
    } catch (err) {
      console.error('[CreateMemorial] Minting error:', err);
      let errMsg = err.shortMessage || err.message || 'Something went wrong';
      if (errMsg.includes('Exact creation fee required')) {
        errMsg = 'The exact creation fee is required by the contract. The fee has been refreshed, please try again.';
        refetchCreationFee();
      }
      setError(`Minting failed: ${errMsg}`);
      alert(`Minting failed: ${errMsg}`);
      setIsMinting(false);
      setIsInitiating(false);
      setFlowStep(0);
    }
  };

  /* ── Resume draft flow ─────────────────────────────────── */
  const handleResumeDraft = async (targetDraft = draft) => {
    if (!targetDraft || !targetDraft.metadataTxId) return;
    if (isInitiating || isMinting || isConfirming || Boolean(txHash) || flowStep > 0) return;
    setIsInitiating(true);

    if (!isConnected) { setIsInitiating(false); setError('Please connect your wallet first'); return; }
    if (!connector) {
      setIsInitiating(false);
      setError("Wallet connection failed. Please disable your adblocker or reconnect your wallet.");
      return;
    }
    if (isCreationPaused) {
      setIsInitiating(false);
      setError('Memorial creation is temporarily paused by the protocol. Please try again later.');
      return;
    }
    if (isInsufficientFunds) {
      setIsInitiating(false);
      setError('Insufficient ETH Balance to mint memorial.');
      return;
    }
    if (chain?.id !== baseSepolia.id) {
      try {
        await switchChainAsync({ chainId: baseSepolia.id });
      } catch (switchErr) {
        setIsInitiating(false);
        console.error('[CreateMemorial] Failed to switch network:', switchErr);
        setError('Please switch your wallet network to Base Sepolia to continue.');
        return;
      }
    }
    setError('');

    try {
      setFlowStep(3);
      setIsMinting(true);
      if (targetDraft.petName) setPetName(targetDraft.petName);
      const draftPublic = Boolean(targetDraft.isPublic ?? false);
      setIsPublic(draftPublic);
      setMintedIsPublic(draftPublic);

      // Fetch latest creation fee dynamically to guarantee sending the exact amount required by the contract
      let currentFee = creationFee;
      try {
        const { data: latestFee } = await refetchCreationFee();
        if (latestFee) currentFee = BigInt(latestFee);
      } catch (fErr) {
        console.warn('[CreateMemorial] Failed to refetch latest fee, using cached:', fErr);
      }

      const hash = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'create_memorial',
        args: [targetDraft.petName, targetDraft.metadataTxId, draftPublic],
        value: currentFee,
        account: userAddress,
        connector,
        chainId: baseSepolia.id,
      });

      console.log('[CreateMemorial] Resumed Tx Hash:', hash);
      // Immediately clear local draft upon receiving tx hash to prevent duplicate submissions
      localStorage.removeItem('draft_memorial');
      setDraft(null);
      setTxHash(hash);
      setIsMinting(false);
      setIsInitiating(false);
    } catch (err) {
      console.error('[CreateMemorial] Resume minting error:', err);
      let errMsg = err.shortMessage || err.message || 'Something went wrong';
      if (errMsg.includes('Exact creation fee required')) {
        errMsg = 'The exact creation fee is required by the contract. The fee has been refreshed, please try again.';
        refetchCreationFee();
      }
      setError(`Minting failed: ${errMsg}`);
      setIsMinting(false);
      setIsInitiating(false);
      setFlowStep(0);
    }
  };

  const handleDiscardDraft = () => {
    localStorage.removeItem('draft_memorial');
    setDraft(null);
  };

  const isEOA = connector?.name && !connector.name.toLowerCase().includes('privy');

  const isSubmitting = isInitiating || flowStep > 0 || isMinting || isConfirming || (Boolean(txHash) && !isSuccess);

  /* ── Success screen ────────────────────────────────────── */
  if (isSuccess) {
    const isPublicTribute = Boolean(mintedIsPublic);
    const memorialTargetUrl = createdTokenId ? `/memorial/${createdTokenId}` : '/my';
    const memorialShareUrl = createdTokenId
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}/#/memorial/${createdTokenId}`
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

  /* ── Not connected ─────────────────────────────────────── */
  if (!isConnected) {
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-5">
          <span className="material-symbols-outlined text-5xl text-[#d8c2ba]">account_balance_wallet</span>
          <h2 className="text-2xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>Connect Your Wallet</h2>
          <p className="text-[#53433e] text-sm">Please connect your wallet to create a memorial.</p>
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
                disabled={isSubmitting || isInsufficientFunds || isCreationPaused}
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
                        : isInsufficientFunds
                          ? `Insufficient ETH (${formatEther(creationFee)} ETH required)`
                          : 'Resume Minting'}
                    </span>
                    {!isInsufficientFunds && !isCreationPaused && (
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
          </div>
        )}

        {/* ── WIZARD STEP 0: Basic Info ── */}
        {step === 0 && (
          <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-8 space-y-8">
            {/* Photo drop zone */}
            <div>
              <label className={labelBase}>Pet Portrait</label>
              {/* File input stays mounted regardless of preview state (mobile browsers dislike removing it mid-selection) */}
              <input
                ref={fileInputRef}
                id="photo-input"
                type="file"
                accept="image/*"
                className="hidden"
                onClick={(e) => {
                  e.target.value = '';
                }}
                onChange={(e) => {
                  handlePhotoSelect(e.target.files?.[0]);
                }}
              />
              {previewUrl ? (
                <div className="space-y-3">
                  {previewFailed ? (
                    <div
                      className="w-full h-56 rounded-2xl border border-dashed border-[#d8c2ba] bg-[#fbf9f6] flex flex-col items-center justify-center p-4 cursor-pointer hover:bg-[#f5efe6] transition-colors relative"
                      onClick={() => {
                        if (fileInputRef.current) fileInputRef.current.value = '';
                        fileInputRef.current?.click();
                      }}
                    >
                      <span className="material-symbols-outlined text-4xl text-[#8a4f36] mb-1">image</span>
                      <p className="text-sm font-medium text-[#1b1c1a] truncate max-w-xs">{photo?.name || 'Photo selected'}</p>
                      <p className="text-xs text-[#85736d] mt-1">Tap to select a different photo</p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveImage();
                        }}
                        className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white rounded-full p-1.5 transition-colors flex items-center justify-center w-7 h-7 text-xs cursor-pointer"
                        title="Remove photo"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="relative w-full h-56 rounded-2xl overflow-hidden border border-amber-900/10">
                      <img
                        src={previewUrl}
                        alt="Pet Portrait Preview"
                        className="w-full h-full object-cover"
                        onError={handleImageError}
                      />
                      <button
                        type="button"
                        onClick={handleRemoveImage}
                        className="absolute top-2 right-2 bg-black/50 hover:bg-black/70 text-white rounded-full p-1.5 transition-colors flex items-center justify-center w-7 h-7 text-xs cursor-pointer"
                        title="Remove photo"
                      >
                        ✕
                      </button>
                    </div>
                  )}

                  {/* Non-blocking image check status */}
                  {isAnalyzingImage && (
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
                          setIsAnalyzingImage(false);
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
                  {!isAnalyzingImage && checkStatus === 'accepted' && (
                    <div className="flex items-center gap-1.5 text-xs text-green-700 font-medium">
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      <span>Image accepted</span>
                    </div>
                  )}
                  {!isAnalyzingImage && checkStatus === 'skipped' && (
                    <div className="flex items-center gap-1.5 text-xs text-[#85736d] font-medium">
                      <span className="material-symbols-outlined text-sm">info</span>
                      <span>Check skipped</span>
                    </div>
                  )}

                  {/* Human Detection Consent Checkbox (only when a person was actually detected) */}
                  {!isAnalyzingImage && detectedPerson && (
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
                  {!isAnalyzingImage && checkStatus === 'accepted' && !detectedAnimal && (
                    <div className="bg-[#fffdfa] border border-[#e4d3c3] rounded-xl p-4 flex items-start gap-3 text-xs text-[#53433e]">
                      <span className="material-symbols-outlined text-[#d48c6f] text-base shrink-0 mt-0.5">info</span>
                      <p>
                        We couldn't automatically detect a pet in this image (e.g., if it's a silhouette, paw print, or memorial object). That is completely fine — feel free to proceed if this is the photo you want.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="w-full h-40 border-2 border-dashed border-[#d8c2ba]/60 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-[#f5f3f0] hover:border-[#8a4f36]/40 transition-colors group"
                  onDrop={handleDrop}
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-[#8a4f36]'); }}
                  onDragLeave={(e) => e.currentTarget.classList.remove('border-[#8a4f36]')}
                  onClick={() => {
                    if (fileInputRef.current) fileInputRef.current.value = '';
                    fileInputRef.current?.click();
                  }}
                >
                  <span className="material-symbols-outlined text-4xl text-[#d8c2ba] group-hover:text-[#8a4f36] transition-colors mb-2">add_photo_alternate</span>
                  <p className="text-sm text-[#53433e]">Click or drag photo to upload</p>
                  <p className="text-xs text-[#85736d] mt-1">JPG, PNG, WebP up to 30 MB (auto-optimized)</p>
                </div>
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
                <input className={inputBase} type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Memorial Date</label>
                <input className={inputBase} type="date" value={memorialDate} onChange={(e) => setMemorialDate(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Birth Year (if exact date unknown)</label>
                <input className={inputBase} type="number" placeholder="e.g. 2012" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Passing Year (if exact date unknown)</label>
                <input className={inputBase} type="number" placeholder="e.g. 2024" value={passingYear} onChange={(e) => setPassingYear(e.target.value)} />
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
                <div className="relative w-full h-48 rounded-xl overflow-hidden border border-amber-900/10">
                  {previewFailed ? (
                    <div className="w-full h-full bg-[#fbf9f6] flex items-center justify-center gap-2 text-sm text-[#8a4f36]">
                      <span className="material-symbols-outlined text-xl">image</span>
                      <span>{photo?.name || 'Photo attached'}</span>
                    </div>
                  ) : (
                    <img
                      src={previewUrl}
                      alt="Pet Portrait Preview"
                      className="w-full h-full object-cover"
                      onError={() => setPreviewFailed(true)}
                    />
                  )}
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
                <p><span className="font-semibold text-[#1b1c1a]">Creation Fee:</span> {formatEther(creationFee)} ETH</p>
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
                disabled={isSubmitting || !petName.trim() || isInsufficientFunds || isCreationPaused}
                className="w-full flex items-center justify-center gap-3 bg-[#d48c6f] text-white py-4 rounded-2xl text-sm font-semibold tracking-wider uppercase hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>{isConfirming || txHash ? 'Confirming on-chain…' : 'Minting…'}</span>
                  </>
                ) : isCreationPaused ? (
                  <><span>Memorial Creation Paused</span></>
                ) : isInsufficientFunds ? (
                  <><span>Insufficient ETH Balance ({formatEther(creationFee)} ETH required)</span></>
                ) : (
                  <><span>Preserve Forever ({formatEther(creationFee)} ETH)</span><span className="material-symbols-outlined text-base">arrow_forward</span></>
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
                    if (!petName.trim()) { setError('Pet name is required'); return; }
                    // Image check/compression runs in the background and never gates Continue.
                    if (detectedPerson && !humanConsentGiven) {
                      setError('Please confirm consent for the detected person in the photo');
                      return;
                    }
                  }
                  setError('');
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
