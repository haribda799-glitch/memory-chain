// ============================================================
// Memory Chain — Wagmi + Chain Configuration
// ============================================================
import { http, fallback } from 'wagmi';
import { createConfig } from '@privy-io/wagmi';
import { base, baseSepolia } from 'viem/chains';
import { CONTRACT_ADDRESSES, IS_MAINNET } from './contract';

const env =
  (typeof import.meta !== 'undefined' && import.meta.env) ||
  (typeof process !== 'undefined' && process.env) ||
  {};

// Reliable public RPC endpoints for Base Mainnet (8453) with automatic fallback
export const BASE_MAINNET_RPC_URLS = [
  ...(env.VITE_BASE_MAINNET_RPC ? [String(env.VITE_BASE_MAINNET_RPC).trim()] : []),
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://1rpc.io/base',
  'https://base.drpc.org',
].filter(Boolean);

// Reliable public RPC endpoints for Base Sepolia (84532) with automatic fallback
export const BASE_SEPOLIA_RPC_URLS = [
  ...(env.VITE_BASE_SEPOLIA_RPC ? [String(env.VITE_BASE_SEPOLIA_RPC).trim()] : []),
  'https://sepolia.base.org',
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.drpc.org',
].filter(Boolean);

// Active chain determined by VITE_NETWORK ('mainnet' -> base (8453), 'testnet' -> baseSepolia (84532))
export const ACTIVE_CHAIN = IS_MAINNET ? base : baseSepolia;
export const DEFAULT_CHAIN_ID = ACTIVE_CHAIN.id;
export const ACTIVE_NETWORK_NAME = IS_MAINNET ? 'Base' : 'Base Sepolia';
export { IS_MAINNET };

// Canonical dApp metadata for WalletConnect Verify API (prevents DOMAIN_MISMATCH high-risk warnings)
export const WALLETCONNECT_METADATA = {
  name: 'Memory Chain',
  description: 'Memory Chain — Decentralized pet memorial on the blockchain.',
  url: typeof window !== 'undefined' ? window.location.origin : 'https://haribda799-glitch.github.io',
  icons: [],
};

// Wagmi config strictly via @privy-io/wagmi without manual connectors array.
// Putting ACTIVE_CHAIN first makes it the default chain while supporting both Base Mainnet and Base Sepolia.
export const wagmiConfig = createConfig({
  chains: IS_MAINNET ? [base, baseSepolia] : [baseSepolia, base],
  transports: {
    [base.id]: fallback(BASE_MAINNET_RPC_URLS.map((url) => http(url))),
    [baseSepolia.id]: fallback(BASE_SEPOLIA_RPC_URLS.map((url) => http(url))),
  },
});

/**
 * Get the contract address for a given chain ID.
 * Respects VITE_CONTRACT_ADDRESS override and falls back to the active default chain.
 */
export function getContractAddress(chainId) {
  const envOverride = String(env.VITE_CONTRACT_ADDRESS || '').trim();
  if (envOverride && (!chainId || chainId === DEFAULT_CHAIN_ID)) {
    return envOverride;
  }
  return CONTRACT_ADDRESSES[chainId] || envOverride || CONTRACT_ADDRESSES[DEFAULT_CHAIN_ID];
}

/**
 * Get the block explorer URL for a given chain ID.
 */
export function getExplorerUrl(chainId) {
  const explorers = {
    [base.id]: 'https://basescan.org',
    [baseSepolia.id]: 'https://sepolia.basescan.org',
  };
  return explorers[chainId] || explorers[DEFAULT_CHAIN_ID];
}
