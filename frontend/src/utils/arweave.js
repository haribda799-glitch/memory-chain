// ============================================================
// Memory Chain — Permanent Arweave Upload via ANS-104 + ArDrive Turbo
// ============================================================
//
// How permanent Arweave uploads work in Memory Chain (Testnet & Mainnet):
// 1. Photos are downscaled & compressed by `photoPipeline.js` (and guarded here) to `<= 95_000` bytes
//    (~95 KB), and NFT metadata JSON is ~1 KB.
// 2. ArDrive Turbo (`https://upload.ardrive.io/v1/tx`) subsidizes 100% of signed ANS-104 DataItems
//    under 100 KB (`winc = 0`, 0 credits required).
// 3. In the browser, `createAndSignAns104DataItem` generates an ephemeral secp256k1 keypair
//    (`SignatureType = 3`, Ethereum ANS-104), serializes the Arweave tags in Apache Avro zig-zag
//    binary format, computes the SHA-384 Arweave `deepHash` over the 8-part ANS-104 tuple, signs it
//    with EIP-191 (`personal_sign`), and POSTs the binary DataItem to `https://upload.ardrive.io/v1/tx`.
// 4. Every memorial receives a real, permanent 43-character Arweave transaction ID (`ar://<txId>`)
//    that resolves on ANY device worldwide via `https://turbo-gateway.com/<txId>` (instant 0s cache)
//    and `https://arweave.net/<txId>` (L1 settlement), with `localStorage` used ONLY as an instant
//    0ms optimistic cache on the creator's device right after minting.
// ============================================================

import Arweave from 'arweave';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToBytes } from 'viem';

const ArweaveClass = Arweave.default || Arweave;

export const arweave = ArweaveClass.init({
  host: 'arweave.net',
  port: 443,
  protocol: 'https',
});

export const MOCK_MODE = false;
export const TURBO_UPLOAD_URL = 'https://upload.ardrive.io/v1/tx';
export const TURBO_FREE_MAX_BYTES = 100 * 1024; // 100 KB free ANS-104 limit on ArDrive Turbo
export const MAX_TURBO_PHOTO_BYTES = 95_000;    // <= 95 KB target for image payload

// Primary gateway (`turbo-gateway.com`) serves ANS-104 DataItems at 0ms immediately after upload
// AND serves all settled Arweave L1 transactions; `arweave.net` is the L1 fallback gateway.
export const ARWEAVE_GATEWAY = 'https://turbo-gateway.com';
export const ARWEAVE_L1_GATEWAY = 'https://arweave.net';

// ── Optimistic cache (0ms local read right after minting) + Legacy mock support ──
const MOCK_PREFIX = 'mock_';
const MOCK_STORAGE_PREFIX = 'mc_mock_ar_';
const OPTIMISTIC_STORAGE_PREFIX = 'mc_opt_ar_';
const mockMemoryStore = new Map();       // legacy mockId -> data URL / JSON string
const optimisticMemoryStore = new Map(); // real Arweave txId -> data URL / JSON string

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

/** Extracts the raw 43-char Arweave txId from `ar://...`, `https://arweave.net/...`, or plain ID. */
export function extractArweaveTxId(uriOrId) {
  if (!uriOrId) return '';
  const clean = String(uriOrId).trim();
  if (clean.startsWith('data:')) return '';
  if (clean.startsWith('ar://')) return clean.slice(5).trim();
  const gatewayMatch = clean.match(/^https?:\/\/(?:[\w-]+\.)?(?:arweave\.net|turbo-gateway\.com|ar-io\.dev)\/([A-Za-z0-9_-]{43})/i);
  if (gatewayMatch) return gatewayMatch[1];
  return clean;
}

function getOptimisticCacheEntry(txId) {
  if (!txId) return '';
  const mem = optimisticMemoryStore.get(txId);
  if (mem) return mem;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      return window.localStorage.getItem(`${OPTIMISTIC_STORAGE_PREFIX}${txId}`) || '';
    } catch {
      return '';
    }
  }
  return '';
}

function setOptimisticCacheEntry(txId, value) {
  if (!txId || !value) return;
  optimisticMemoryStore.set(txId, value);
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(`${OPTIMISTIC_STORAGE_PREFIX}${txId}`, value);
    } catch {
      // If localStorage is full, prune older optimistic cache entries (`mc_opt_ar_*`) and retry once
      try {
        const keysToRemove = [];
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(OPTIMISTIC_STORAGE_PREFIX)) keysToRemove.push(k);
        }
        keysToRemove.slice(0, Math.ceil(keysToRemove.length / 2)).forEach((k) => {
          try { window.localStorage.removeItem(k); } catch {}
        });
        window.localStorage.setItem(`${OPTIMISTIC_STORAGE_PREFIX}${txId}`, value);
      } catch {
        // In-memory optimisticMemoryStore still holds the entry for this session
      }
    }
  }
}

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
 * Returns a fetchable URL for an Arweave transaction ID or `ar://` URI.
 * - Checks the local optimistic cache first (0ms after minting while gateways index the tx).
 * - Handles legacy `mock_...` IDs for older testnet memorials.
 * - Otherwise returns the permanent gateway URL (`https://turbo-gateway.com/<txId>`).
 */
export function getArweaveUrl(txId, { preferGateway = false } = {}) {
  if (!txId) return '';
  const clean = String(txId).trim();
  if (clean.startsWith('data:')) return clean;

  const normalizedId = extractArweaveTxId(clean);
  if (!normalizedId) return clean;

  if (isMockTxId(normalizedId)) return resolveMockUrl(normalizedId);

  if (!preferGateway) {
    const cached = getOptimisticCacheEntry(normalizedId);
    if (cached) {
      return cached.startsWith('data:') ? cached : jsonToDataUrl(cached);
    }
  }

  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    // Rewrite arweave.net/<txId> to primary gateway so freshly uploaded ANS-104 items resolve at 0s
    if (/^https?:\/\/arweave\.net\/[A-Za-z0-9_-]{43}$/i.test(clean)) {
      return `${ARWEAVE_GATEWAY}/${normalizedId}`;
    }
    return clean;
  }

  return `${ARWEAVE_GATEWAY}/${normalizedId}`;
}

/** Returns the direct L1 `https://arweave.net/<txId>` URL for explorer links or secondary fallback. */
export function getArweaveFallbackUrl(txId) {
  const normalizedId = extractArweaveTxId(txId);
  if (!normalizedId || isMockTxId(normalizedId)) return '';
  return `${ARWEAVE_L1_GATEWAY}/${normalizedId}`;
}

// ── Per-memorial epitaph cache ───────────────────────────────
export const EPITAPH_TX_STORAGE_PREFIX = 'mc_epitaph_tx_';

export function getEpitaphStorageKeyForTx(metadataTxId) {
  return `${EPITAPH_TX_STORAGE_PREFIX}${metadataTxId}`;
}

function persistEpitaphForTx(metadataTxId, metadata) {
  const userEpitaph = typeof metadata?.bio === 'string' ? metadata.bio.trim() : '';
  if (!metadataTxId || !userEpitaph) return;
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(getEpitaphStorageKeyForTx(metadataTxId), userEpitaph);
  } catch {
    // ignore storage quota errors
  }
}

// ============================================================
// ANS-104 DataItem Construction & Signing (Browser + Node WebCrypto)
// ============================================================

const utf8Encoder = new TextEncoder();

function concatUint8Arrays(...arrays) {
  let totalLength = 0;
  for (let i = 0; i < arrays.length; i += 1) {
    totalLength += arrays[i].byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (let i = 0; i < arrays.length; i += 1) {
    result.set(arrays[i], offset);
    offset += arrays[i].byteLength;
  }
  return result;
}

async function webCryptoDigest(algorithm, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digestBuffer = await crypto.subtle.digest(algorithm, bytes);
  return new Uint8Array(digestBuffer);
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Computes the Arweave ANS-104 `deepHash` (SHA-384 recursive merkle-like digest)
 * using native WebCrypto (`crypto.subtle.digest('SHA-384', ...)`).
 */
export async function computeAns104DeepHash(chunk) {
  if (Array.isArray(chunk)) {
    const listTag = concatUint8Arrays(
      utf8Encoder.encode('list'),
      utf8Encoder.encode(String(chunk.length))
    );
    let acc = await webCryptoDigest('SHA-384', listTag);
    for (let i = 0; i < chunk.length; i += 1) {
      const childHash = await computeAns104DeepHash(chunk[i]);
      acc = await webCryptoDigest('SHA-384', concatUint8Arrays(acc, childHash));
    }
    return acc;
  }
  const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  const blobTag = concatUint8Arrays(
    utf8Encoder.encode('blob'),
    utf8Encoder.encode(String(bytes.byteLength))
  );
  const taggedHash = concatUint8Arrays(
    await webCryptoDigest('SHA-384', blobTag),
    await webCryptoDigest('SHA-384', bytes)
  );
  return webCryptoDigest('SHA-384', taggedHash);
}

/** Encodes a non-negative integer as an Apache Avro zig-zag variable-length integer. */
function encodeAvroZigZagVarInt(value) {
  let z = (value << 1) ^ (value >> 31);
  const out = [];
  while ((z & ~0x7f) !== 0) {
    out.push((z & 0x7f) | 0x80);
    z >>>= 7;
  }
  out.push(z & 0x7f);
  return new Uint8Array(out);
}

/**
 * Serializes `[{ name, value }]` tags into the ANS-104 Apache Avro binary array format.
 */
export function serializeAns104Tags(tags = []) {
  const validTags = (tags || []).filter(
    (t) => t && String(t.name || '').trim() && t.value !== undefined && t.value !== null
  );
  if (validTags.length === 0) return new Uint8Array(0);

  const chunks = [encodeAvroZigZagVarInt(validTags.length)];
  for (let i = 0; i < validTags.length; i += 1) {
    const nameBytes = utf8Encoder.encode(String(validTags[i].name));
    const valueBytes = utf8Encoder.encode(String(validTags[i].value));
    chunks.push(
      encodeAvroZigZagVarInt(nameBytes.byteLength),
      nameBytes,
      encodeAvroZigZagVarInt(valueBytes.byteLength),
      valueBytes
    );
  }
  // Terminating 0x00 marks the end of the Avro array block
  chunks.push(new Uint8Array([0]));
  return concatUint8Arrays(...chunks);
}

function writeUint64LE(value) {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(value), true);
  return buf;
}

// Reuse a single ephemeral secp256k1 keypair per browser session for signing ANS-104 DataItems
let sessionEphemeralPrivateKey = null;
function getSessionEphemeralPrivateKey() {
  if (!sessionEphemeralPrivateKey) {
    sessionEphemeralPrivateKey = generatePrivateKey();
  }
  return sessionEphemeralPrivateKey;
}

/**
 * Builds and signs a binary ANS-104 DataItem (`SignatureType = 3`, Ethereum secp256k1).
 *
 * @param {{
 *   dataBytes: Uint8Array | ArrayBuffer,
 *   tags?: Array<{ name: string, value: string }>,
 *   privateKey?: `0x${string}`,
 * }} params
 * @returns {Promise<{ id: string, rawBytes: Uint8Array, byteLength: number }>}
 */
export async function createAndSignAns104DataItem(firstArg, secondTags) {
  const isOptionsObject =
    firstArg &&
    !(firstArg instanceof Uint8Array) &&
    !(firstArg instanceof ArrayBuffer) &&
    typeof firstArg === 'object' &&
    'dataBytes' in firstArg;
  const dataBytes = isOptionsObject ? firstArg.dataBytes : firstArg;
  const tags = (isOptionsObject ? firstArg.tags : secondTags) || [];
  const privateKey = (isOptionsObject && firstArg.privateKey) || getSessionEphemeralPrivateKey();

  const payload = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes);
  const cleanTags = (tags || []).filter(
    (t) => t && String(t.name || '').trim() && t.value !== undefined && t.value !== null
  );
  const account = privateKeyToAccount(privateKey);
  // Uncompressed 65-byte secp256k1 public key (0x04 + 32-byte X + 32-byte Y)
  const ownerBytes = hexToBytes(account.publicKey);
  const targetBytes = new Uint8Array(0);
  const anchorBytes = new Uint8Array(0);
  const tagsBytes = serializeAns104Tags(cleanTags);

  const deepHashDigest = await computeAns104DeepHash([
    utf8Encoder.encode('dataitem'),
    utf8Encoder.encode('1'),
    utf8Encoder.encode('3'), // SignatureType 3 = Ethereum secp256k1
    ownerBytes,
    targetBytes,
    anchorBytes,
    tagsBytes,
    payload,
  ]);

  const signatureHex = await account.signMessage({
    message: { raw: deepHashDigest },
  });
  const signatureBytes = hexToBytes(signatureHex); // 65 bytes (r + s + v)

  const rawBytes = concatUint8Arrays(
    new Uint8Array([3, 0]), // uint16LE(3) = Ethereum signature type
    signatureBytes,         // 65 bytes
    ownerBytes,             // 65 bytes
    new Uint8Array([0, 0]), // target present = 0, anchor present = 0
    writeUint64LE(cleanTags.length),
    writeUint64LE(tagsBytes.byteLength),
    tagsBytes,
    payload
  );

  // Canonical ANS-104 DataItem ID is base64url(SHA-256(signatureBytes))
  const idDigest = await webCryptoDigest('SHA-256', signatureBytes);
  const id = bytesToBase64Url(idDigest);

  return {
    id,
    rawBytes,
    binary: rawBytes,
    byteLength: rawBytes.byteLength,
  };
}

/**
 * Signs `dataBytes` + `tags` as an ANS-104 DataItem and uploads it to ArDrive Turbo's
 * free bundler endpoint (`https://upload.ardrive.io/v1/tx`, free for items <= 100 KB).
 *
 * @param {Uint8Array | ArrayBuffer} dataBytes
 * @param {Array<{ name: string, value: string }>} tags
 * @param {{ uploadUrl?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string>} Permanent 43-character Arweave transaction ID
 */
export async function uploadDataItemToTurbo(
  dataBytes,
  tags = [],
  { uploadUrl = TURBO_UPLOAD_URL, fetchImpl = fetch } = {}
) {
  const { id: computedId, rawBytes, byteLength } = await createAndSignAns104DataItem({
    dataBytes,
    tags,
  });

  if (byteLength > TURBO_FREE_MAX_BYTES) {
    throw new Error(
      `Arweave DataItem size (${(byteLength / 1024).toFixed(1)} KB) exceeds the 100 KB free bundler limit.`
    );
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/json',
        },
        body: rawBytes,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Turbo bundler HTTP ${response.status}${errBody ? `: ${errBody.slice(0, 120)}` : ''}`);
      }

      const result = await response.json().catch(() => ({}));
      const txId = String(result?.id || computedId).trim();
      if (!txId || txId.length < 40) {
        throw new Error('Turbo bundler returned an invalid transaction ID');
      }
      return txId;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
  }
  throw lastErr || new Error('Failed to upload DataItem to Arweave via Turbo bundler');
}

/**
 * Ensures an image `File` / `Blob` fits within `maxBytes` (95,000 bytes) before uploading to Turbo.
 * Normally `photoPipeline.js` already produces a `<= 95_000` byte JPEG; this is a secondary guard
 * in case a caller passed an uncompressed or raw-fallback image.
 */
async function ensureFileUnderTurboLimit(file, maxBytes = MAX_TURBO_PHOTO_BYTES) {
  if (!file || file.size <= maxBytes || typeof document === 'undefined') {
    return file;
  }

  let objectUrl = '';
  let canvas = null;
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      const timer = setTimeout(() => reject(new Error('Image decode timeout')), 8000);
      el.onload = () => {
        clearTimeout(timer);
        resolve(el);
      };
      el.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Image decode error'));
      };
      el.src = objectUrl;
    });

    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    if (!nw || !nh) return file;

    const dims = [800, 720, 640, 560, 480];
    const qualities = [0.76, 0.66, 0.56, 0.46];

    for (const dim of dims) {
      const scale = Math.min(1, dim / Math.max(nw, nh));
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(nw * scale));
      canvas.height = Math.max(1, Math.round(nh * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      for (const q of qualities) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
        if (blob && blob.size <= maxBytes) {
          canvas.width = 0;
          canvas.height = 0;
          canvas = null;
          const base = String(file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
          return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
        }
      }
      canvas.width = 0;
      canvas.height = 0;
      canvas = null;
    }
  } catch (err) {
    console.warn('[Arweave] Secondary compression guard note:', err?.message || err);
  } finally {
    if (canvas) {
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch {}
    }
    if (objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch {}
    }
  }
  return file;
}

function arrayBufferToDataUrl(buffer, mime = 'image/jpeg') {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Permanently uploads an image `File` (`<= 95 KB`) to Arweave as a signed ANS-104 DataItem
 * via ArDrive Turbo (`https://upload.ardrive.io/v1/tx`), and primes the local optimistic cache
 * so the image renders at 0ms on the creator's device while gateways index the transaction.
 *
 * @param {File} file - The prepared image file (`<= 95 KB`)
 * @param {Object[]} extraTags - Optional extra Arweave tags `[{ name, value }]`
 * @returns {Promise<string>} Permanent 43-character Arweave transaction ID
 */
export async function uploadToArweave(file, extraTags = []) {
  if (!file || file.size === 0) {
    throw new Error('Cannot upload an empty file to Arweave');
  }

  const readyFile = await ensureFileUnderTurboLimit(file, MAX_TURBO_PHOTO_BYTES);
  const imageBuffer = await readyFile.arrayBuffer();
  const contentType = readyFile.type || 'image/jpeg';

  const tags = [
    { name: 'Content-Type', value: contentType },
    { name: 'App-Name', value: 'MemoryChain' },
    ...extraTags.map(({ name, value }) => ({ name: String(name), value: String(value) })),
  ];

  console.log(
    '[Arweave] Uploading photo DataItem to ArDrive Turbo…',
    readyFile.name || 'photo.jpg',
    `(${(imageBuffer.byteLength / 1024).toFixed(1)} KB)`
  );

  const txId = await uploadDataItemToTurbo(imageBuffer, tags);

  // Prime the optimistic local cache (used only to avoid gateway indexing latency right after mint)
  try {
    const optimisticDataUrl = arrayBufferToDataUrl(imageBuffer, contentType);
    setOptimisticCacheEntry(txId, optimisticDataUrl);
  } catch (cacheErr) {
    console.warn('[Arweave] Optimistic photo cache note:', cacheErr?.message || cacheErr);
  }

  console.log('[Arweave] Photo permanently uploaded. TxID:', txId);
  return txId;
}

/**
 * Permanently uploads NFT metadata JSON (`~1 KB`) to Arweave as a signed ANS-104 DataItem
 * via ArDrive Turbo (`https://upload.ardrive.io/v1/tx`), and primes the local optimistic cache.
 *
 * @param {Object} metadata - The JSON metadata object
 * @returns {Promise<string>} Permanent 43-character Arweave transaction ID
 */
export async function uploadJsonToArweave(metadata) {
  const jsonString = JSON.stringify(metadata);
  const metadataBytes = utf8Encoder.encode(jsonString);

  const tags = [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'App-Name', value: 'MemoryChain' },
  ];

  console.log(
    '[Arweave] Uploading metadata DataItem to ArDrive Turbo…',
    `(${(metadataBytes.byteLength / 1024).toFixed(2)} KB)`
  );

  const txId = await uploadDataItemToTurbo(metadataBytes, tags);

  // Prime optimistic cache for 0ms reads right after minting + persist per-memorial epitaph backup
  setOptimisticCacheEntry(txId, jsonString);
  persistEpitaphForTx(txId, metadata);

  console.log('[Arweave] Metadata permanently uploaded. TxID:', txId);
  return txId;
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
 * - image: `ar://<imageTxId>` permanent Arweave URI
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
      : `ar://${extractArweaveTxId(imageTxId)}`;

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
    ...(species ? { species } : {}),
    ...(breed ? { breed } : {}),
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
    metadata.animation_url = `ar://${extractArweaveTxId(videoTxId)}`;
  }

  return metadata;
}
