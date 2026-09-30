// ============================================================
// Memory Chain — Deploy Frontend to Arweave (Turbo SDK)
// ============================================================
// Usage:
//   1. Build the frontend: cd frontend && npm run build
//   2. Set ARWEAVE_WALLET_PATH in .env (path to JWK wallet file)
//   3. Run: node deploy/deploy_site.mjs
//
// Prerequisites:
//   - Arweave JWK wallet with Turbo Credits
//   - Buy credits at https://turbo.ar.io/ (one-time, not subscription)
//   - npm install @ardrive/turbo-sdk (in this directory)
//
// The script uploads the entire dist/ folder as a manifest to Arweave.
// The manifest ID can then be linked to an ArNS name.
// ============================================================

import { TurboFactory, ArweaveSigner } from '@ardrive/turbo-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_PATH = path.resolve(__dirname, '../frontend/dist');
const WALLET_PATH = process.env.ARWEAVE_WALLET_PATH || './arweave-wallet.json';

async function deploy() {
  // Check dist exists
  if (!fs.existsSync(DIST_PATH)) {
    console.error('❌ dist/ not found. Run `cd frontend && npm run build` first.');
    process.exit(1);
  }

  // Load wallet
  const walletPath = path.resolve(WALLET_PATH);
  if (!fs.existsSync(walletPath)) {
    console.error(`❌ Arweave wallet not found at: ${walletPath}`);
    console.error('   Set ARWEAVE_WALLET_PATH in .env or place arweave-wallet.json in project root.');
    process.exit(1);
  }

  console.log('📦 Loading Arweave wallet...');
  const jwk = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const signer = new ArweaveSigner(jwk);
  const turbo = TurboFactory.authenticated({ signer });

  // Check balance
  const balance = await turbo.getBalance();
  console.log(`💰 Turbo Credits balance: ${balance.winc} winc`);

  // Upload folder
  console.log(`🚀 Uploading ${DIST_PATH} to Arweave...`);
  const result = await turbo.uploadFolder({
    folderPath: DIST_PATH,
    manifestOptions: {
      indexFile: 'index.html',
      fallbackFile: 'index.html', // SPA fallback
    },
    dataItemOpts: {
      tags: [
        { name: 'App-Name', value: 'MemoryChain' },
        { name: 'App-Version', value: '1.0.0' },
        { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
      ],
    },
  });

  console.log('\n✅ Deployed to Arweave!');
  console.log(`   Manifest ID: ${result.manifestId}`);
  console.log(`   Live at:     https://arweave.net/${result.manifestId}`);
  console.log('\n📝 Next steps:');
  console.log('   1. Link this manifest to your ArNS name (see docs/arns-setup.md)');
  console.log(`   2. Update your ANT record to point to: ${result.manifestId}`);
}

deploy().catch((err) => {
  console.error('❌ Deploy failed:', err.message);
  process.exit(1);
});
