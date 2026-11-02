import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectImageMimeFromBytes,
  preparePhotoSequentially,
  clearSessionPhotoCache,
  getPhotoCacheKey,
  cachePhotoAiResult,
  getCachedPhotoAiResult,
  MAX_SESSION_CACHE_ENTRIES,
} from './photoPipeline.js';

function makeMagicBuffer(hexBytes, totalSize = 64) {
  const out = new Uint8Array(Math.max(totalSize, hexBytes.length));
  for (let i = 0; i < hexBytes.length; i += 1) {
    out[i] = hexBytes[i];
  }
  return out.buffer;
}

test('detectImageMimeFromBytes detects JPEG, PNG, WebP, GIF, and AVIF magic bytes regardless of .jpg extension', () => {
  const fakeJpgFile = { name: '1000000214.jpg', type: 'image/jpeg' };

  // FF D8 FF -> image/jpeg
  const jpegBuf = makeMagicBuffer([0xFF, 0xD8, 0xFF, 0xE0]);
  assert.equal(detectImageMimeFromBytes(jpegBuf, fakeJpgFile), 'image/jpeg');

  // 89 50 4E 47 -> image/png
  const pngBuf = makeMagicBuffer([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(detectImageMimeFromBytes(pngBuf, fakeJpgFile), 'image/png');

  // 52 49 46 46 ... 57 45 42 50 -> image/webp
  const webpBuf = makeMagicBuffer([
    0x52, 0x49, 0x46, 0x46,
    0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
  ]);
  assert.equal(detectImageMimeFromBytes(webpBuf, fakeJpgFile), 'image/webp');

  // 47 49 46 38 -> image/gif
  const gifBuf = makeMagicBuffer([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.equal(detectImageMimeFromBytes(gifBuf, fakeJpgFile), 'image/gif');

  // ISO BMFF ftypavif -> image/avif
  const avifBuf = makeMagicBuffer([
    0x00, 0x00, 0x00, 0x1C,
    0x66, 0x74, 0x79, 0x70,
    0x61, 0x76, 0x69, 0x66,
  ]);
  assert.equal(detectImageMimeFromBytes(avifBuf, fakeJpgFile), 'image/avif');
});

test('preparePhotoSequentially captures bytes at 0ms BEFORE sleep(350) so ephemeral Samsung picker streams succeed', async () => {
  clearSessionPhotoCache();
  const webpBytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46,
    0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20,
  ]);

  let streamOpen = true;
  // Close the simulated Android content://media/picker/.../1000000214 stream right after the 0ms tick
  setTimeout(() => {
    streamOpen = false;
  }, 5);

  const samsungVirtualFile = {
    name: '1000000214.jpg',
    size: webpBytes.byteLength,
    type: '',
    lastModified: 1700000214000,
    async arrayBuffer() {
      if (!streamOpen) {
        throw new Error('NotReadableError: The requested file could not be read');
      }
      return webpBytes.buffer.slice(0);
    },
  };

  const result = await preparePhotoSequentially(samsungVirtualFile, {
    wakeupDelayMs: 30,
    decode: async ({ rawDataUrl, memoryBlob }) => {
      assert.equal(memoryBlob.type, 'image/webp');
      assert.ok(rawDataUrl.startsWith('data:image/webp;base64,'));
      const fakeJpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
      return {
        jpegDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
        jpegBlob: new Blob([fakeJpeg], { type: 'image/jpeg' }),
        width: 800,
        height: 600,
      };
    },
  });

  assert.equal(result.previewFailed, false);
  assert.equal(result.fromCache, false);
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.previewUrl, 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(result.uploadFile.name, '1000000214.jpg');
});

test('preparePhotoSequentially never throws when canvas decode fails on Samsung — falls back to memoryBlob and rawDataUrl', async () => {
  clearSessionPhotoCache();
  const webpBytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46,
    0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
    0x01, 0x02, 0x03, 0x04,
  ]);
  const file = new File([webpBytes], '1000000162.jpg', {
    type: 'image/jpeg',
    lastModified: 1700000162000,
  });

  const result = await preparePhotoSequentially(file, {
    wakeupDelayMs: 0,
    decode: async () => {
      throw new Error('Image decode failed on Samsung canvas');
    },
  });

  assert.equal(result.previewFailed, false);
  assert.equal(result.usedRawFallback, true);
  assert.equal(result.mime, 'image/webp');
  assert.ok(result.previewUrl.startsWith('data:image/webp;base64,'));
  assert.equal(result.uploadFile.name, '1000000162.jpg');
  assert.equal(result.uploadFile.type, 'image/webp');
  assert.equal(result.uploadFile.size, webpBytes.byteLength);
});

test('preparePhotoSequentially preserves GIF bytes even when saved with a .jpg extension', async () => {
  clearSessionPhotoCache();
  const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
  const file = new File([gifBytes], 'downloaded_anim.jpg', {
    type: 'image/jpeg',
    lastModified: 1700000999000,
  });

  const result = await preparePhotoSequentially(file, {
    wakeupDelayMs: 0,
    decode: async () => {
      throw new Error('decode should not be called for GIF');
    },
  });

  assert.equal(result.previewFailed, false);
  assert.equal(result.mime, 'image/gif');
  assert.ok(result.previewUrl.startsWith('data:image/gif;base64,'));
  assert.equal(result.uploadFile.type, 'image/gif');
});

test('sessionPhotoCache returns cached result on repeat selection without touching Android file descriptor again and caps at 10 entries', async () => {
  clearSessionPhotoCache();
  const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
  let readCount = 0;

  const file = {
    name: '1000000214.jpg',
    size: jpegBytes.byteLength,
    type: 'image/jpeg',
    lastModified: 1700000214999,
    async arrayBuffer() {
      readCount += 1;
      if (readCount > 1) {
        throw new Error('Android file descriptor closed on 2nd read');
      }
      return jpegBytes.buffer.slice(0);
    },
  };

  assert.equal(getPhotoCacheKey(file), `1000000214.jpg::${jpegBytes.byteLength}::1700000214999`);

  const first = await preparePhotoSequentially(file, {
    wakeupDelayMs: 0,
    decode: async () => ({
      jpegDataUrl: 'data:image/jpeg;base64,/9j/4AAQ',
      jpegBlob: new Blob([jpegBytes], { type: 'image/jpeg' }),
      width: 400,
      height: 400,
    }),
  });
  assert.equal(first.fromCache, false);
  assert.equal(readCount, 1);

  cachePhotoAiResult(file, {
    hasPerson: false,
    hasAnimal: true,
    detectedSpecies: 'Dog',
    checkStatus: 'accepted',
  });
  assert.equal(getCachedPhotoAiResult(file)?.detectedSpecies, 'Dog');

  // 2nd selection of the same file hits sessionPhotoCache without calling file.arrayBuffer()
  const second = await preparePhotoSequentially(file, {
    wakeupDelayMs: 0,
    decode: async () => {
      throw new Error('decode should not run on cache hit');
    },
  });
  assert.equal(second.fromCache, true);
  assert.equal(readCount, 1);
  assert.equal(second.previewUrl, 'data:image/jpeg;base64,/9j/4AAQ');
  assert.equal(second.cachedAiResult?.detectedSpecies, 'Dog');

  // Verify LRU eviction at MAX_SESSION_CACHE_ENTRIES (10)
  for (let i = 0; i < MAX_SESSION_CACHE_ENTRIES + 2; i += 1) {
    const extraFile = new File([jpegBytes], `extra_${i}.jpg`, {
      type: 'image/jpeg',
      lastModified: 1000 + i,
    });
    await preparePhotoSequentially(extraFile, {
      wakeupDelayMs: 0,
      decode: async () => ({
        jpegDataUrl: `data:image/jpeg;base64,extra${i}`,
        jpegBlob: new Blob([jpegBytes], { type: 'image/jpeg' }),
        width: 100,
        height: 100,
      }),
    });
  }
  // Original file was evicted after 10 newer entries
  assert.equal(getCachedPhotoAiResult(file), null);
});
