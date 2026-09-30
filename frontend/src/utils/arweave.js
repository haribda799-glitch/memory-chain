// ============================================================
// Memory Chain — Arweave Upload Utilities
// ============================================================
// MOCK_MODE = true  → instant fake txIds, no network required
// MOCK_MODE = false → real ArLocal (DEV) or arweave.net (PROD)
//
// DEV (ArLocal) upload flow:
//   1. Generate a fresh JWK wallet
//   2. Mint 10 000 AR of test tokens via /mint endpoint
//   3. Create → sign → upload via chunked Uploader API
//   4. Verify tx.id is non-empty (throw if not)
//   5. Mine the block via /mine
//   6. Confirm tx status (throw on failure)
//
// Any throw cancels the entire mint flow in CreateMemorial.jsx
// ============================================================

import Arweave from 'arweave';

const ArweaveClass = Arweave.default || Arweave;

export const arweave = ArweaveClass.init({
  host: import.meta.env.DEV ? '127.0.0.1' : 'arweave.net',
  port: import.meta.env.DEV ? 1984 : 443,
  protocol: import.meta.env.DEV ? 'http' : 'https',
});

export const MOCK_MODE = false; // Set true to skip real uploads

const ARWEAVE_GATEWAY = import.meta.env.DEV
  ? 'http://127.0.0.1:1984'
  : 'https://arweave.net';

/**
 * Returns a full HTTP gateway URL for an Arweave transaction ID.
 */
export function getArweaveUrl(txId) {
  if (!txId) return '';
  return `${ARWEAVE_GATEWAY}/${txId}`;
}

/**
 * Generate a random mock transaction ID (43 chars base64url).
 */
function generateMockTxId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let i = 0; i < 43; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
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

  // PROD: ArConnect browser extension handles signing
  if (!window.arweaveWallet) {
    throw new Error('ArConnect extension not found. Install ArConnect or set MOCK_MODE = true.');
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
 * Throws on any failure — this will cancel the entire mint flow.
 *
 * @param {File} file - The file to upload
 * @param {Object[]} extraTags - Optional extra Arweave tags [{name, value}]
 * @returns {Promise<string>} Arweave transaction ID
 */
export async function uploadToArweave(file, extraTags = []) {
  if (MOCK_MODE) {
    await new Promise((r) => setTimeout(r, 1500));
    const mockTxId = generateMockTxId();
    console.log('[MOCK] Uploaded file to Arweave:', mockTxId);
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
  if (MOCK_MODE) {
    await new Promise((r) => setTimeout(r, 1000));
    const mockTxId = generateMockTxId();
    console.log('[MOCK] Uploaded metadata to Arweave:', mockTxId, metadata);
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
  return tx.id;
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
    : (birthDate ? new Date(birthDate).getFullYear().toString() : '');

  const resolvedPassingYear = passingYear
    ? passingYear.toString()
    : (memorialDate ? new Date(memorialDate).getFullYear().toString() : '');

  const imageUrl = imageTxId
    ? (import.meta.env.DEV ? `${ARWEAVE_GATEWAY}/${imageTxId}` : `ar://${imageTxId}`)
    : '';

  const metadata = {
    name: `Memorial: ${petName}`,
    description:
      description ||
      `In loving memory of ${petName}. Forever on the blockchain.`,
    image: imageUrl,
    external_url: '',
    ...(resolvedBirthYear   ? { birth_year:   resolvedBirthYear   } : {}),
    ...(resolvedPassingYear ? { passing_year: resolvedPassingYear } : {}),
    attributes: [
      { trait_type: 'Pet Name', value: petName },
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

  if (videoTxId) {
    metadata.animation_url = import.meta.env.DEV
      ? `${ARWEAVE_GATEWAY}/${videoTxId}`
      : `ar://${videoTxId}`;
  }

  return metadata;
}
