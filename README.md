# 🐾 MemoryChain — Decentralized Pet Memorial

A zero-hosting decentralized memorial for beloved pets. Each memorial is a permanent, non-transferable (soulbound) NFT on Arbitrum with photos and stories stored forever on Arweave.

**No servers. No subscriptions. No recurring payments. Forever.**

## Architecture

| Layer | Technology | Payment Model |
|-------|-----------|--------------|
| Registry | Arbitrum One (Vyper ERC-721 SBT) | One-time gas for deploy + mint |
| Media storage | Arweave (via Turbo SDK) | One-time payment, stored forever |
| Frontend | Arweave permaweb | One-time payment, hosted forever |
| Domain | ArNS permabuy | One-time payment, no renewal |

## Quick Start

### Prerequisites
- Python 3.11-3.13 (Moccasin requirement)
- Node.js 18+
- MetaMask browser extension

### Smart Contract (Vyper)

```bash
# Create venv with compatible Python
uv venv --python 3.13 .venv
source .venv/bin/activate

# Install dependencies
uv pip install moccasin vyper==0.4.3 snekmate

# Compile
mox compile

# Run tests (30 tests, ~1.5s)
mox test -v

# Deploy locally
mox run script/deploy.py

# Deploy to Arbitrum Sepolia
mox wallet import deployer  # Import your private key
mox run script/deploy.py --network arbitrum-sepolia
```

### Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev    # Development server at http://localhost:5173
npm run build  # Production build → dist/
```

### Deploy to Arweave

See [docs/arns-setup.md](docs/arns-setup.md) for full instructions.

## Project Structure

```
memory-chain/
├── src/MemoryChain.vy          # Soulbound ERC-721 contract (Vyper 0.4.3)
├── tests/test_memory_chain.py  # 30 tests (pytest + Titanoboa)
├── script/deploy.py            # Contract deployment script
├── moccasin.toml               # Moccasin framework config
├── frontend/                   # React + Vite dApp
│   ├── src/config/             # Contract ABI, chain configs
│   ├── src/components/         # UI components
│   └── src/utils/arweave.js    # Arweave upload utilities
├── deploy/deploy_site.mjs      # Arweave site deployment
└── docs/arns-setup.md          # ArNS domain guide
```

## Smart Contract Features

- **Soulbound (non-transferable)**: Transfer/approve functions exist in ABI but always revert
- **ERC-5192**: Wallets that support the standard show tokens as locked
- **Permissionless minting**: Anyone can create a memorial
- **Phase 2 ready**: `mintFee` + `withdraw` for commercial use without redeploy
- **Minimal on-chain data**: Only pet name + Arweave TX pointer stored on-chain
- **Gas optimized**: snekmate ERC-721 + Arbitrum L2 calldata optimization

## License

MIT
