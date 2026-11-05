// ============================================================
// Memory Chain — Contract Configuration (Vyper 0.4.3 Core)
// ============================================================
import MemoryChainCoreABI from './MemoryChainCore.json';

export const CONTRACT_ABI = MemoryChainCoreABI;

const env =
  (typeof import.meta !== 'undefined' && import.meta.env) ||
  (typeof process !== 'undefined' && process.env) ||
  {};

const rawNetwork = String(env.VITE_NETWORK || 'mainnet').trim().toLowerCase();
export const IS_MAINNET =
  rawNetwork !== 'testnet' &&
  rawNetwork !== 'sepolia' &&
  rawNetwork !== 'base-sepolia' &&
  rawNetwork !== '84532';

export const ACTIVE_CHAIN_ID = IS_MAINNET ? 8453 : 84532;

export const DEFAULT_MAINNET_CORE = '0xB5467c3189907428a7feD5F7cb6C084AE8d743B2';
export const DEFAULT_MAINNET_MODERATION = '0xc25e0a5d32ded38ae39ebdae9323287460bf7426';
export const DEFAULT_MAINNET_SAFE = '0x4C28A82cAafdaD1B8AfbC9d7aBF3a411fE2a768c';

export const DEFAULT_SEPOLIA_CORE = '0x5de836cf6fc88d88eec93309663372ad723baf8f';
export const DEFAULT_SEPOLIA_MODERATION = '0x7120f05831bab3742b58a0a17e7a9b64789f30f3';
export const DEFAULT_SEPOLIA_SAFE = '0x7D29Ae44D5041b59012e784818446088774305F5';

const envContractAddress = String(env.VITE_CONTRACT_ADDRESS || '').trim();
const envModerationAddress = String(env.VITE_MODERATION_MODULE_ADDRESS || '').trim();

/**
 * Deployed contract addresses per chain.
 * Defaults to Base Mainnet (8453) with contract 0xB5467c3189907428a7feD5F7cb6C084AE8d743B2.
 */
export const CONTRACT_ADDRESSES = {
  8453:
    String(env.VITE_BASE_MAINNET_CONTRACT_ADDRESS || '').trim() ||
    (IS_MAINNET && envContractAddress ? envContractAddress : DEFAULT_MAINNET_CORE), // Base Mainnet (MemoryChainCore)
  84532:
    String(env.VITE_BASE_SEPOLIA_CONTRACT_ADDRESS || '').trim() ||
    (!IS_MAINNET && envContractAddress ? envContractAddress : DEFAULT_SEPOLIA_CORE), // Base Sepolia (MemoryChainCore)
};

export const MODERATION_MODULE_ADDRESSES = {
  8453:
    String(env.VITE_BASE_MAINNET_MODERATION_ADDRESS || '').trim() ||
    (IS_MAINNET && envModerationAddress ? envModerationAddress : DEFAULT_MAINNET_MODERATION),
  84532:
    String(env.VITE_BASE_SEPOLIA_MODERATION_ADDRESS || '').trim() ||
    (!IS_MAINNET && envModerationAddress ? envModerationAddress : DEFAULT_SEPOLIA_MODERATION),
};

export const COUNCIL_SAFE_ADDRESS =
  String(env.VITE_COUNCIL_SAFE_ADDRESS || '').trim() ||
  (IS_MAINNET ? DEFAULT_MAINNET_SAFE : DEFAULT_SEPOLIA_SAFE);

export const MEMORY_CHAIN_CORE_ADDRESS = CONTRACT_ADDRESSES[ACTIVE_CHAIN_ID];
export const MODERATION_MODULE_ADDRESS = MODERATION_MODULE_ADDRESSES[ACTIVE_CHAIN_ID];
