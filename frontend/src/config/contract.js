// ============================================================
// Memory Chain — Contract Configuration (Vyper 0.4.3 Core)
// ============================================================
import MemoryChainCoreABI from './MemoryChainCore.json';

export const CONTRACT_ABI = MemoryChainCoreABI;

const env =
  (typeof import.meta !== 'undefined' && import.meta.env) ||
  (typeof process !== 'undefined' && process.env) ||
  {};

const rawNetwork = String(env.VITE_NETWORK || 'testnet').trim().toLowerCase();
export const IS_MAINNET =
  rawNetwork === 'mainnet' ||
  rawNetwork === 'base' ||
  rawNetwork === 'base-mainnet' ||
  rawNetwork === '8453';

export const ACTIVE_CHAIN_ID = IS_MAINNET ? 8453 : 84532;

const DEFAULT_SEPOLIA_CORE = '0x5de836cf6fc88d88eec93309663372ad723baf8f';
const DEFAULT_SEPOLIA_MODERATION = '0x7120f05831bab3742b58a0a17e7a9b64789f30f3';

const envContractAddress = String(env.VITE_CONTRACT_ADDRESS || '').trim();
const envModerationAddress = String(env.VITE_MODERATION_MODULE_ADDRESS || '').trim();

/**
 * Deployed contract addresses per chain.
 * Supports switching via VITE_NETWORK=mainnet|testnet and VITE_CONTRACT_ADDRESS.
 */
export const CONTRACT_ADDRESSES = {
  84532:
    String(env.VITE_BASE_SEPOLIA_CONTRACT_ADDRESS || '').trim() ||
    (!IS_MAINNET && envContractAddress ? envContractAddress : DEFAULT_SEPOLIA_CORE), // Base Sepolia (MemoryChainCore)
  8453:
    String(env.VITE_BASE_MAINNET_CONTRACT_ADDRESS || '').trim() ||
    envContractAddress ||
    DEFAULT_SEPOLIA_CORE, // Base Mainnet (MemoryChainCore)
};

export const MODERATION_MODULE_ADDRESSES = {
  84532:
    String(env.VITE_BASE_SEPOLIA_MODERATION_ADDRESS || '').trim() ||
    (!IS_MAINNET && envModerationAddress ? envModerationAddress : DEFAULT_SEPOLIA_MODERATION),
  8453:
    String(env.VITE_BASE_MAINNET_MODERATION_ADDRESS || '').trim() ||
    envModerationAddress ||
    DEFAULT_SEPOLIA_MODERATION,
};

export const COUNCIL_SAFE_ADDRESS =
  String(env.VITE_COUNCIL_SAFE_ADDRESS || '').trim() ||
  (IS_MAINNET
    ? '0x4C28A82cAafdaD1B8AfbC9d7aBF3a411fE2a768c'
    : '0x7D29Ae44D5041b59012e784818446088774305F5');

export const MEMORY_CHAIN_CORE_ADDRESS = CONTRACT_ADDRESSES[ACTIVE_CHAIN_ID];
export const MODERATION_MODULE_ADDRESS = MODERATION_MODULE_ADDRESSES[ACTIVE_CHAIN_ID];
