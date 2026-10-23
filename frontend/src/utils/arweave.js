// ============================================================
// Memory Chain — Arweave Upload Utilities
// ============================================================
// MOCK_MODE = true  → instant fake txIds, no network required
// MOCK_MODE = false → real ArLocal (DEV) or arweave.net (PROD)
//
// Automatic fallback: if ArConnect is missing (PROD) or ArLocal is
// unreachable (DEV), uploads silently switch to local mock storage
// (console warning only) so MetaMask / Privy users can still mint.
//
// DEV (ArLocal) upload flow:
//   1. Generate a fresh JWK wallet
//   2. Mint 10 000 AR of test tokens via /mint endpoint
//   3. Create → sign → upload via chunked Uploader API
//   4. Verify tx.id is non-empty (throw if not)
//   5. Mine the block via /mine
//   6. Confirm tx status (throw on failure)
//
// Any throw from a real upload cancels the mint flow in CreateMemorial.jsx
// ============================================================

import Arweave from 'arweave';

const ArweaveClass = Arweave.default || Arweave;

export const arweave = ArweaveClass.init({
  host: import.meta.env.DEV ? '127.0.0.1' : 'arweave.net',
  port: import.meta.env.DEV ? 1984 : 443,
  protocol: import.meta.env.DEV ? 'http' : 'https',
});

export const MOCK_MODE = false; // Set true to force mock uploads (no network required)

const ARWEAVE_GATEWAY = import.meta.env.DEV
  ? 'http://127.0.0.1:1984'
  : 'https://arweave.net';

// ── Mock storage (graceful fallback) ─────────────────────────
// Used automatically when MOCK_MODE is on, ArConnect is missing (PROD),
// or ArLocal is unreachable (DEV). Mock IDs are `mock_` + 38 chars = 43 chars,
// which fits the contract's `arweave_uri: String[64]` limit.
// Metadata JSON is persisted in localStorage and served back as a data: URL
// by getArweaveUrl(), so the creator's browser renders photo + story normally.
const MOCK_PREFIX = 'mock_';
const MOCK_STORAGE_PREFIX = 'mc_mock_ar_';
const mockMemoryStore = new Map(); // mockId → data URL / JSON string (session cache)

export function isMockTxId(txId) {
  return typeof txId === 'string' && txId.startsWith(MOCK_PREFIX);
}

function jsonToDataUrl(json) {
  return `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
}

export const TESTNET_TEMPORARY_STORAGE_NOTICE =
  'This memorial was created on testnet with temporary storage. Its photo and story are only available on the device where it was created.';

const MOCK_PLACEHOLDER_METADATA = JSON.stringify({
  name: 'Memorial',
  description: '',
  epitaph: '',
  image: '',
  attributes: [],
  isTemporaryStoragePlaceholder: true,
  temporaryStorageNotice: TESTNET_TEMPORARY_STORAGE_NOTICE,
});

function resolveMockUrl(txId) {
  let stored = mockMemoryStore.get(txId);
  if (!stored && typeof window !== 'undefined' && window.localStorage) {
    try {
      stored =
        window.localStorage.getItem(`${MOCK_STORAGE_PREFIX}${txId}`) ||
        window.localStorage.getItem(`${MOCK_STORAGE_PREFIX}text_${txId}`);
    } catch {
      stored = null;
    }
  }
  if (!stored) return jsonToDataUrl(MOCK_PLACEHOLDER_METADATA);
  return stored.startsWith('data:') ? stored : jsonToDataUrl(stored);
}

/**
 * Returns a fetchable URL for an Arweave transaction ID.
 * Mock IDs resolve to a local data: URL instead of the gateway.
 */
export function getArweaveUrl(txId) {
  if (!txId) return '';
  if (isMockTxId(txId)) return resolveMockUrl(txId);
  return `${ARWEAVE_GATEWAY}/${txId}`;
}

/**
 * Generate a random mock transaction ID (43 chars, `mock_` prefixed).
 */
function generateMockTxId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = MOCK_PREFIX;
  for (let i = 0; i < 43 - MOCK_PREFIX.length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Decide once per session whether real Arweave uploads are possible.
 * Never throws — falls back to 'mock' with a console warning.
 *
 * @returns {Promise<'arweave'|'mock'>}
 */
let storageModePromise = null;
export function resolveStorageMode() {
  if (!storageModePromise) {
    storageModePromise = (async () => {
      if (MOCK_MODE) {
        console.warn('[Arweave] MOCK_MODE enabled — using mock storage.');
        return 'mock';
      }
      if (import.meta.env.DEV) {
        try {
          const res = await arweave.api.get('/info');
          if (res.status === 200) return 'arweave';
          console.warn(`[ArLocal] /info returned HTTP ${res.status} — falling back to mock storage.`);
        } catch (err) {
          console.warn('[ArLocal] Not reachable on port 1984 — falling back to mock storage.', err?.message || err);
        }
        return 'mock';
      }
      if (typeof window === 'undefined' || !window.arweaveWallet) {
        console.warn('[Arweave] ArConnect extension not found — falling back to mock storage (testnet).');
        return 'mock';
      }
      return 'arweave';
    })();
  }
  return storageModePromise;
}

// ── Per-memorial epitaph cache ───────────────────────────────
// The user's story is cached under `mc_epitaph_tx_<metadataTxId>` (the metadata tx id is the value stored
// on-chain as the memorial's arweave_uri), so memorials sharing a pet name never leak stories into each other.
// The legacy name-keyed entry (`mc_epitaph_<petname lowercase>`) is still written for backward compatibility.
export const EPITAPH_TX_STORAGE_PREFIX = 'mc_epitaph_tx_';

export function getEpitaphStorageKeyForTx(metadataTxId) {
  return `${EPITAPH_TX_STORAGE_PREFIX}${metadataTxId}`;
}

function persistEpitaphForTx(metadataTxId, metadata) {
  // `bio` is only present when the user actually wrote a story (never the generic fallback epitaph)
  const userEpitaph = typeof metadata?.bio === 'string' ? metadata.bio.trim() : '';
  if (!metadataTxId || !userEpitaph) return;
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(getEpitaphStorageKeyForTx(metadataTxId), userEpitaph);
  } catch {
    // ignore storage quota errors
  }
}

/**
 * Downscale an image File to a compact JPEG data URL (fits localStorage).
 * Resolves '' if the file can't be processed.
 */
async function fileToCompactDataUrl(file, maxSide = 640, quality = 0.82) {
  if (!file || typeof document === 'undefined') return '';
  if (file.type?.startsWith('image/')) {
    let objectUrl = '';
    try {
      objectUrl = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = objectUrl;
      });
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    } catch (err) {
      console.warn('[MOCK] Image compression failed:', err);
    } finally {
      // Always release the blob URL, including on decode errors
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  return '';
}

/**
 * Generate and fund a DEV wallet on ArLocal.
 * Returns the JWK object for signing, or 'use_wallet' for PROD.
 *
 * @returns {Promise<object|string>} JWK or 'use_wallet'
 */
async function getSigningKey() {
  if (import.meta.env.DEV) {
    const jwk = await arweave.wallets.generate();
    const address = await arweave.wallets.jwkToAddress(jwk);

    // Mint 10 000 AR (10_000 * 10^12 winston) — enough for many transactions
    const mintRes = await arweave.api.get(`/mint/${address}/10000000000000000`);
    if (mintRes.status !== 200) {
      throw new Error(`[ArLocal] Failed to mint test tokens: HTTP ${mintRes.status}. Is ArLocal running on port 1984?`);
    }
    console.log(`[ArLocal] Minted 10 000 AR for ${address}`);
    return jwk;
  }

  // PROD: ArConnect browser extension handles signing.
  // resolveStorageMode() routes to mock storage before we get here if it's missing.
  if (typeof window === 'undefined' || !window.arweaveWallet) {
    throw new Error('[Arweave] ArConnect extension not available for signing.');
  }
  return 'use_wallet';
}

/**
 * Upload a transaction via the chunked Uploader API and mine the block (DEV).
 * Throws if upload fails or tx.id is empty.
 *
 * @param {Arweave.Transaction} tx
 * @returns {Promise<string>} Transaction ID
 */
async function uploadAndVerify(tx) {
  if (!tx.id || tx.id === '') {
    throw new Error('[Arweave] Transaction ID is empty after signing — sign step failed.');
  }

  // Use chunked Uploader API — reliable for large files, avoids timeout
  const uploader = await arweave.transactions.getUploader(tx);
  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    console.log(`[Arweave] Upload progress: ${uploader.pctComplete.toFixed(0)}% (chunk ${uploader.uploadedChunks}/${uploader.totalChunks})`);
  }

  // For DEV: mine the block immediately so the data is queryable
  if (import.meta.env.DEV) {
    const mineRes = await arweave.api.get('/mine');
    if (mineRes.status !== 200) {
      console.warn(`[ArLocal] /mine returned HTTP ${mineRes.status} — data may not be immediately available.`);
    } else {
      console.log('[ArLocal] Block mined. Transaction confirmed:', tx.id);
    }

    // Confirm the data is retrievable
    const statusRes = await arweave.transactions.getStatus(tx.id);
    if (statusRes.status !== 200) {
      throw new Error(`[ArLocal] Transaction ${tx.id} not confirmed after mining. Status: ${statusRes.status}`);
    }
  }

  console.log('[Arweave] Upload complete. TxID:', tx.id);
  return tx.id;
}

/**
 * Upload a file (image/video) to Arweave.
 * Falls back to mock storage (never throws for missing ArConnect / ArLocal).
 *
 * @param {File} file - The file to upload
 * @param {Object[]} extraTags - Optional extra Arweave tags [{name, value}]
 * @returns {Promise<string>} Arweave transaction ID (or `mock_…` ID)
 */
export async function uploadToArweave(file, extraTags = []) {
  const mode = await resolveStorageMode();
  if (mode === 'mock') {
    const mockTxId = generateMockTxId();
    // Kept in memory only; buildNftMetadata() embeds it into the metadata JSON,
    // which is what gets persisted (avoids storing the image twice).
    const dataUrl = await fileToCompactDataUrl(file);
    if (dataUrl) mockMemoryStore.set(mockTxId, dataUrl);
    console.log('[MOCK] Stored file locally:', mockTxId, dataUrl ? `(${(dataUrl.length / 1024).toFixed(1)} KB)` : '(no preview)');
    return mockTxId;
  }

  console.log('[Arweave] Starting file upload…', file.name, `(${(file.size / 1024).toFixed(1)} KB)`);

  const jwk = await getSigningKey();

  // Read raw bytes — required for correct binary upload
  const imageBuffer = await file.arrayBuffer();

  const tx = await arweave.createTransaction({ data: imageBuffer }, jwk);
  tx.addTag('Content-Type', file.type || 'application/octet-stream');
  tx.addTag('App-Name', 'MemoryChain');
  extraTags.forEach(({ name, value }) => tx.addTag(name, String(value)));

  await arweave.transactions.sign(tx, jwk);

  // Guard: tx.id must be non-empty after signing
  if (!tx.id) {
    throw new Error('[Arweave] Image transaction ID is empty after signing.');
  }

  return uploadAndVerify(tx);
}

/**
 * Upload JSON metadata to Arweave.
 * Uses TextEncoder for correct UTF-8 encoding (Cyrillic, emoji, etc.)
 * Throws on any failure — this will cancel the entire mint flow.
 *
 * @param {Object} metadata - The JSON metadata object
 * @returns {Promise<string>} Arweave transaction ID
 */
export async function uploadJsonToArweave(metadata) {
  const mode = await resolveStorageMode();
  if (mode === 'mock') {
    const mockTxId = generateMockTxId();
    const storageKey = `${MOCK_STORAGE_PREFIX}${mockTxId}`;
    let json = JSON.stringify(metadata);
    mockMemoryStore.set(mockTxId, json);

    // Always persist lightweight text-only backup first (~300 bytes) so user epitaph is never lost to image quota
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const textOnly = JSON.stringify({ ...metadata, image: '' });
        window.localStorage.setItem(`${MOCK_STORAGE_PREFIX}text_${mockTxId}`, textOnly);
      } catch {
        // ignore
      }
    }
    try {
      window.localStorage.setItem(storageKey, json);
    } catch (err) {
      // Quota exceeded (large base64 image) — first strip base64 images from older mock entries
      // while preserving their text metadata (epitaph/description, dates, breed) so user stories are never lost.
      console.warn('[MOCK] localStorage quota reached, compacting older mock images:', err?.name || err);
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(MOCK_STORAGE_PREFIX) && k !== storageKey) {
            const rawOld = window.localStorage.getItem(k);
            if (rawOld && rawOld.length > 2048) {
              try {
                const parsedOld = JSON.parse(rawOld);
                if (parsedOld && parsedOld.image) {
                  parsedOld.image = '';
                  window.localStorage.setItem(k, JSON.stringify(parsedOld));
                }
              } catch {
                // ignore malformed entry
              }
            }
          }
        }
        window.localStorage.setItem(storageKey, json);
      } catch {
        // Still over quota — persist this memorial's text metadata (epitaph, dates, attributes) without the photo
        json = JSON.stringify({ ...metadata, image: '' });
        try {
          window.localStorage.setItem(storageKey, json);
        } catch (err2) {
          console.warn('[MOCK] Could not persist metadata; it will be available for this session only.', err2);
        }
      }
    }
    console.log('[MOCK] Stored metadata locally:', mockTxId, metadata);
    persistEpitaphForTx(mockTxId, metadata);
    return mockTxId;
  }

  console.log('[Arweave] Starting metadata upload…', metadata);

  const jwk = await getSigningKey();

  // TextEncoder gives strict UTF-8 binary — required for Cyrillic and all unicode
  const metadataBuffer = new TextEncoder().encode(JSON.stringify(metadata));

  const tx = await arweave.createTransaction({ data: metadataBuffer }, jwk);
  tx.addTag('Content-Type', 'application/json');
  tx.addTag('App-Name', 'MemoryChain');

  await arweave.transactions.sign(tx, jwk);

  // Guard: tx.id must be non-empty after signing
  if (!tx.id) {
    throw new Error('[Arweave] Metadata transaction ID is empty after signing.');
  }

  // Additional guard: verify using post() before switching to uploader
  const response = await arweave.transactions.post(tx);
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`[Arweave] Metadata upload failed with HTTP ${response.status}: ${JSON.stringify(response.data)}`);
  }

  // Mine the block (DEV only)
  if (import.meta.env.DEV) {
    const mineRes = await arweave.api.get('/mine');
    if (mineRes.status !== 200) {
      console.warn(`[ArLocal] /mine returned HTTP ${mineRes.status}`);
    } else {
      console.log('[ArLocal] Block mined. Metadata TxID:', tx.id);
    }

    const statusRes = await arweave.transactions.getStatus(tx.id);
    if (statusRes.status !== 200) {
      throw new Error(`[ArLocal] Metadata tx ${tx.id} not confirmed after mining. Status: ${statusRes.status}`);
    }
  }

  console.log('[Arweave] Metadata upload complete. TxID:', tx.id);
  persistEpitaphForTx(tx.id, metadata);
  return tx.id;
}

/**
 * Year of a date value. ISO strings (YYYY-MM-DD) are sliced directly: `new Date('YYYY-MM-DD')` parses as UTC
 * midnight, so getFullYear() returns the previous year for Jan 1 in negative-UTC timezones.
 */
function yearFromDate(date) {
  if (!date) return '';
  const str = String(date);
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 4);
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.getFullYear().toString();
}

/**
 * Build NFT-standard metadata JSON for a pet memorial.
 * Follows OpenSea / ERC-721 metadata standard.
 *
 * - image: HTTP URL for DEV (ArLocal), ar:// URI for PROD
 * - description: "A Brief Memory" form field (epitaph)
 * - birth_year / passing_year: top-level for fast parsing + in attributes[]
 */
export function buildNftMetadata({
  petName,
  description = '',
  birthDate = '',
  memorialDate = '',
  birthYear = '',
  passingYear = '',
  species = '',
  breed = '',
  imageTxId = '',
  videoTxId = '',
  ownerAddress = '',
}) {
  const resolvedBirthYear = birthYear
    ? birthYear.toString()
    : yearFromDate(birthDate);

  const resolvedPassingYear = passingYear
    ? passingYear.toString()
    : yearFromDate(memorialDate);

  const imageUrl = !imageTxId
    ? ''
    : isMockTxId(imageTxId)
      ? (mockMemoryStore.get(imageTxId) || '')
      : (import.meta.env.DEV ? `${ARWEAVE_GATEWAY}/${imageTxId}` : `ar://${imageTxId}`);

  const cleanUserEpitaph = typeof description === 'string' ? description.trim() : '';
  const finalEpitaph =
    cleanUserEpitaph ||
    `In loving memory of ${petName}. Forever on the blockchain.`;

  // Persist custom user-entered epitaph so it always takes priority over generic fallback
  if (typeof window !== 'undefined' && window.localStorage && petName && cleanUserEpitaph) {
    try {
      window.localStorage.setItem(
        `mc_epitaph_${String(petName).trim().toLowerCase()}`,
        cleanUserEpitaph
      );
    } catch {
      // ignore storage quota errors
    }
  }

  const metadata = {
    name: `Memorial: ${petName}`,
    description: finalEpitaph,
    epitaph: cleanUserEpitaph || finalEpitaph,
    ...(cleanUserEpitaph ? { bio: cleanUserEpitaph } : {}),
    image: imageUrl,
    external_url: '',
    ...(resolvedBirthYear   ? { birth_year:   resolvedBirthYear   } : {}),
    ...(resolvedPassingYear ? { passing_year: resolvedPassingYear } : {}),
    attributes: [
      { trait_type: 'Pet Name', value: petName },
      ...(cleanUserEpitaph ? [{ trait_type: 'Epitaph', value: cleanUserEpitaph }] : []),
      ...(species ? [{ trait_type: 'Species', value: species }] : []),
      ...(breed   ? [{ trait_type: 'Breed',   value: breed   }] : []),
      ...(resolvedBirthYear
        ? [{ trait_type: 'Birth Year', value: resolvedBirthYear }]
        : []),
      ...(birthDate
        ? [{ trait_type: 'Birth Date', display_type: 'date', value: Math.floor(new Date(birthDate).getTime() / 1000) }]
        : []),
      ...(resolvedPassingYear
        ? [{ trait_type: 'Passing Year', value: resolvedPassingYear }]
        : []),
      ...(memorialDate
        ? [{ trait_type: 'Memorial Date', display_type: 'date', value: Math.floor(new Date(memorialDate).getTime() / 1000) }]
        : []),
      ...(ownerAddress
        ? [{ trait_type: 'Owner', value: ownerAddress }]
        : []),
    ],
  };

  if (videoTxId && !isMockTxId(videoTxId)) {
    metadata.animation_url = import.meta.env.DEV
      ? `${ARWEAVE_GATEWAY}/${videoTxId}`
      : `ar://${videoTxId}`;
  }

  return metadata;
}
