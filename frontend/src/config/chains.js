// ============================================================
// Memory Chain — Wagmi + Chain Configuration
// ============================================================
import { http } from 'wagmi';
import { createConfig } from '@privy-io/wagmi';
import { baseSepolia } from 'viem/chains';
import { CONTRACT_ADDRESSES } from './contract';

// Wagmi config strictly via @privy-io/wagmi without manual connectors array
export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  transports: {
    [baseSepolia.id]: http(),
  },
});

// Default chain for the app (testnet for MVP)
export const DEFAULT_CHAIN_ID = baseSepolia.id;

/**
 * Get the contract address for a given chain ID.
 * Falls back to the default chain if unknown.
 */
export function getContractAddress(chainId) {
  return CONTRACT_ADDRESSES[chainId] || CONTRACT_ADDRESSES[DEFAULT_CHAIN_ID];
}

/**
 * Get the block explorer URL for a given chain ID.
 */
export function getExplorerUrl(chainId) {
  const explorers = {
    [baseSepolia.id]: 'https://sepolia.basescan.org',
  };
  return explorers[chainId] || explorers[DEFAULT_CHAIN_ID];
}
