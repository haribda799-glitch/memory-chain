#!/usr/bin/env node
/**
 * frontend/scripts/deploy-permaweb.mjs
 *
 * Zero-Web2-Dependency Permaweb Deployment Script for Memory Chain.
 * 1. Scans all built files in `frontend/dist` and verifies every file is <= 95_000 bytes.
 * 2. Signs and uploads each file as an ANS-104 DataItem (SignatureType = 3) with its
 *    exact MIME `Content-Type` tag to ArDrive Turbo (`https://upload.ardrive.io/v1/tx`).
 * 3. Builds a standard Arweave Path Manifest v0.2.0 (`application/x.arweave-manifest+json`)
 *    with `index: { path: "index.html" }` and `fallback: { id: "<index_tx_id>" }`.
 * 4. Uploads the manifest DataItem and prints the permanent Arweave Permaweb URLs.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createAndSignAns104DataItem,
  TURBO_UPLOAD_URL,
  TURBO_FREE_MAX_BYTES,
  MAX_TURBO_PHOTO_BYTES,
} from '../src/utils/arweave.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(FRONTEND_ROOT, 'dist');
const CACHE_FILE = path.join(FRONTEND_ROOT, '.permaweb-upload-cache.json');

const CONCURRENCY = 6;
const MAX_RETRIES = 4;

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function walkFiles(dir, baseDir = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
      results.push({ fullPath, relPath });
    }
  }
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // ignore cache write errors
  }
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadDataItemWithRetry(payloadBytes, tags, label) {
  const { id, binary } = await createAndSignAns104DataItem(payloadBytes, tags);

  if (binary.byteLength > TURBO_FREE_MAX_BYTES) {
    throw new Error(
      `DataItem for "${label}" is ${binary.byteLength} bytes, exceeding ArDrive Turbo free limit (${TURBO_FREE_MAX_BYTES} bytes).`,
    );
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(TURBO_UPLOAD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Accept: 'application/json',
        },
        body: binary,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const result = await response.json();
      return result?.id || id;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Failed to upload "${label}" after ${MAX_RETRIES} attempts: ${err.message}`);
      }
      const backoffMs = 1500 * attempt;
      console.warn(`  [!] Retry ${attempt}/${MAX_RETRIES} for ${label} (${err.message}) in ${backoffMs}ms...`);
      await sleep(backoffMs);
    }
  }

  return id;
}

export async function deployPermaweb({ dryRun = false } = {}) {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error(`Build directory not found: ${DIST_DIR}. Run "npm run build" first.`);
  }

  const files = walkFiles(DIST_DIR);
  if (files.length === 0) {
    throw new Error(`No files found in ${DIST_DIR}.`);
  }

  console.log(`\n[*] Memory Chain — Arweave Permaweb Deployment`);
  console.log(`[*] Found ${files.length} files in dist/`);

  // 1. Pre-flight size check: every file must fit inside ArDrive Turbo's free ANS-104 limit (< 95 KB)
  let maxFileBytes = 0;
  let maxFileName = '';
  for (const file of files) {
    const stat = fs.statSync(file.fullPath);
    if (stat.size > maxFileBytes) {
      maxFileBytes = stat.size;
      maxFileName = file.relPath;
    }
    if (stat.size > MAX_TURBO_PHOTO_BYTES) {
      throw new Error(
        `File "${file.relPath}" is ${stat.size} bytes, exceeding the ${MAX_TURBO_PHOTO_BYTES}-byte free Arweave upload limit!`,
      );
    }
    if (file.relPath.endsWith('.js') || file.relPath.endsWith('.mjs')) {
      const jsContent = fs.readFileSync(file.fullPath, 'utf8');
      if (jsContent.includes('__VITE_PRELOAD__')) {
        throw new Error(
          `File "${file.relPath}" contains unreplaced __VITE_PRELOAD__ placeholder!`,
        );
      }
    }
  }
  console.log(`[✓] Pre-flight check passed: all ${files.length} files <= 95 KB (largest: ${maxFileName} at ${maxFileBytes} bytes)`);

  const cache = loadCache();
  const manifestPaths = {};
  let uploadedCount = 0;
  let cachedCount = 0;

  // 2. Upload all files in dist/ with bounded concurrency
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const idx = cursor;
      cursor += 1;
      const file = files[idx];
      const rawBytes = new Uint8Array(fs.readFileSync(file.fullPath));
      const contentType = getMimeType(file.relPath);
      const cacheKey = `${contentType}:${sha256Hex(rawBytes)}`;

      if (!dryRun && cache[cacheKey]) {
        manifestPaths[file.relPath] = { id: cache[cacheKey] };
        cachedCount += 1;
        continue;
      }

      const tags = [
        { name: 'Content-Type', value: contentType },
        { name: 'App-Name', value: 'MemoryChain' },
        { name: 'App-Version', value: '1.0.0' },
        { name: 'File-Path', value: file.relPath },
      ];

      if (dryRun) {
        const { id } = await createAndSignAns104DataItem(rawBytes, tags);
        manifestPaths[file.relPath] = { id };
        uploadedCount += 1;
      } else {
        const txId = await uploadDataItemWithRetry(rawBytes, tags, file.relPath);
        manifestPaths[file.relPath] = { id: txId };
        cache[cacheKey] = txId;
        uploadedCount += 1;
        if (uploadedCount % 10 === 0 || uploadedCount + cachedCount === files.length) {
          saveCache(cache);
          console.log(
            `  [↑] Progress: ${uploadedCount + cachedCount}/${files.length} files processed (${uploadedCount} uploaded, ${cachedCount} cached)`,
          );
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));
  if (!dryRun) {
    saveCache(cache);
  }

  const indexEntry = manifestPaths['index.html'];
  if (!indexEntry?.id) {
    throw new Error('Missing index.html in manifest paths!');
  }

  // 3. Construct Arweave Path Manifest v0.2.0
  const sortedPaths = {};
  for (const key of Object.keys(manifestPaths).sort()) {
    sortedPaths[key] = manifestPaths[key];
  }

  const manifestObject = {
    manifest: 'arweave/paths',
    version: '0.2.0',
    index: { path: 'index.html' },
    fallback: { id: indexEntry.id },
    paths: sortedPaths,
  };

  const manifestJson = JSON.stringify(manifestObject, null, 2);
  const manifestBytes = new TextEncoder().encode(manifestJson);

  const manifestTags = [
    { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
    { name: 'App-Name', value: 'MemoryChain' },
    { name: 'App-Version', value: '1.0.0' },
    { name: 'Type', value: 'manifest' },
  ];

  let manifestTxId;
  if (dryRun) {
    const { id } = await createAndSignAns104DataItem(manifestBytes, manifestTags);
    manifestTxId = id;
  } else {
    console.log(`\n[*] Uploading Arweave Path Manifest v0.2.0 (${manifestBytes.byteLength} bytes)...`);
    manifestTxId = await uploadDataItemWithRetry(manifestBytes, manifestTags, 'arweave-manifest.json');
  }

  console.log('\n' + '='.repeat(74));
  console.log(
    dryRun
      ? '  MEMORY CHAIN — ARWEAVE PERMAWEB DRY-RUN SUMMARY'
      : '  MEMORY CHAIN — LIVE ON ARWEAVE PERMAWEB (PERMANENT WEB3 HOSTING)',
  );
  console.log('='.repeat(74));
  console.log(`  Files Packaged:    ${files.length} (uploaded: ${uploadedCount}, cached: ${cachedCount})`);
  console.log(`  Index HTML TX:     ${indexEntry.id}`);
  console.log(`  Manifest TX ID:    ${manifestTxId}`);
  console.log('-'.repeat(74));
  console.log(`  Arweave Gateway:   https://arweave.net/${manifestTxId}/`);
  console.log(`  Turbo Gateway:     https://turbo-gateway.com/${manifestTxId}/`);
  console.log(`  G8way Gateway:     https://g8way.io/${manifestTxId}/`);
  console.log(`  Arweave URI:       ar://${manifestTxId}`);
  console.log('='.repeat(74) + '\n');

  return {
    manifestTxId,
    indexTxId: indexEntry.id,
    manifest: manifestObject,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const dryRun = process.argv.includes('--dry-run');
  deployPermaweb({ dryRun }).catch((err) => {
    console.error('\n[FATAL] Permaweb deployment failed:', err.message || err);
    process.exit(1);
  });
}
