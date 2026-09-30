// ============================================================
// Memory Chain — Contract Configuration (Vyper 0.4.3 Core)
// ============================================================
import MemoryChainCoreABI from './MemoryChainCore.json';

export const CONTRACT_ABI = MemoryChainCoreABI;

/**
 * Deployed contract addresses per chain.
 */
export const CONTRACT_ADDRESSES = {
  84532: '0x5de836cf6fc88d88eec93309663372ad723baf8f', // Base Sepolia (MemoryChainCore)
};

export const MODERATION_MODULE_ADDRESSES = {
  84532: '0x7120f05831bab3742b58a0a17e7a9b64789f30f3',
};

export const COUNCIL_SAFE_ADDRESS = '0x7D29Ae44D5041b59012e784818446088774305F5';

export const MEMORY_CHAIN_CORE_ADDRESS = CONTRACT_ADDRESSES[84532];
export const MODERATION_MODULE_ADDRESS = MODERATION_MODULE_ADDRESSES[84532];
