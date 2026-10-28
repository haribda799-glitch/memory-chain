// ============================================================
// Mobile Wallet, Chain Check & MetaMask Deep-Link Helpers
// ============================================================

const SYNC_COOLDOWN_MS = 3000; // Strict 3-second cooldown between returning-wallet sync checks
let lastSyncTimestamp = 0;
let syncInFlight = false;
let txInProgressCount = 0;
const syncedSessionAddresses = new Set();

/**
 * Marks whether an on-chain transaction is currently being signed or broadcast.
 * While true, returning from the MetaMask app to Chrome must NEVER trigger account/session re-syncs.
 */
export function setTxInProgress(active) {
  if (active) {
    txInProgressCount += 1;
  } else {
    txInProgressCount = Math.max(0, txInProgressCount - 1);
  }
}

export function isTxInProgress() {
  return txInProgressCount > 0;
}

/**
 * Returns true when running on a mobile browser (Android / iOS) without an injected
 * EIP-1193 provider (`window.ethereum`), i.e. outside an in-app wallet browser.
 */
export function isMobileWithoutEthereum() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  return isMobileUA && !window.ethereum;
}

/**
 * Builds the official MetaMask universal dApp deep link for the current page URL:
 * https://metamask.app.link/dapp/${host}${pathname}${search}${hash}
 * Opening this on Android/iOS launches the site directly inside MetaMask's in-app browser
 * where `window.ethereum` is natively injected without WalletConnect relay delays.
 */
export function getMetaMaskDappDeepLink() {
  if (typeof window === 'undefined') return 'https://metamask.app.link';
  const { host, pathname, search, hash } = window.location;
  return `https://metamask.app.link/dapp/${host}${pathname}${search}${hash}`;
}

/**
 * Returns true ONLY when the Privy modal is currently open in the DOM and waiting on initial
 * wallet connection (e.g. "Waiting for MetaMask" / "Connecting...").
 */
export function isPrivyWaitingForWalletModalOpen() {
  if (typeof document === 'undefined') return false;
  const dialogTitle = document.getElementById('privy-dialog-title');
  if (!dialogTitle) return false;
  const titleText = (dialogTitle.textContent || '').trim();
  return /waiting for|connecting/i.test(titleText);
}

/**
 * Closes a Privy modal if it is currently stuck on "Waiting for MetaMask" / "Sign to verify"
 * after a wallet address has already been obtained in `useWallets()` or `wagmi`.
 * Does NOT send any RPC requests to the wallet.
 */
export function closeStuckPrivyModalIfConnected(hasConnectedAddress) {
  if (!hasConnectedAddress || typeof document === 'undefined') return;
  const dialogTitle = document.getElementById('privy-dialog-title');
  if (!dialogTitle) return;
  const titleText = (dialogTitle.textContent || '').trim();
  if (/waiting for|sign to verify|connecting|switch/i.test(titleText)) {
    const closeBtn = document.querySelector('button[aria-label="close modal"]');
    if (closeBtn) {
      closeBtn.click();
    }
  }
}

/**
 * Parses a numeric chain ID from any format returned by wagmi, EIP-1193 providers,
 * or Privy wallets (number, hex string like "0x14a34", or CAIP-2 string like "eip155:84532").
 */
export function parseNumericChainId(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.includes(':')) {
      const lastPart = trimmed.split(':').pop();
      const parsed = Number(lastPart);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 16);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Resolves the connected wallet's current numeric chainId without triggering unnecessary
 * RPC calls. Checks wagmi (`chain?.id`, `accountChainId`), Privy wallet (`wallet?.chainId`),
 * `window.ethereum?.chainId`, and falls back to `connector.getChainId()`.
 */
export async function getActiveWalletChainId({
  chain,
  accountChainId,
  wallet,
  connector,
  fallbackChainId,
} = {}) {
  const fromChainObj = parseNumericChainId(chain?.id);
  if (fromChainObj) return fromChainObj;

  const fromAccount = parseNumericChainId(accountChainId);
  if (fromAccount) return fromAccount;

  const fromWallet = parseNumericChainId(wallet?.chainId);
  if (fromWallet) return fromWallet;

  if (typeof window !== 'undefined' && window.ethereum?.chainId) {
    const fromWindow = parseNumericChainId(window.ethereum.chainId);
    if (fromWindow) return fromWindow;
  }

  if (connector && typeof connector.getChainId === 'function') {
    try {
      const cid = await connector.getChainId();
      const parsed = parseNumericChainId(cid);
      if (parsed) return parsed;
    } catch {
      // ignore
    }
  }

  return parseNumericChainId(fallbackChainId);
}

/**
 * Extracts Ethereum accounts (`0x...`) from a WalletConnect v2 session object.
 */
function extractAccountsFromWcSession(session) {
  if (!session?.namespaces?.eip155?.accounts) return [];
  const raw = session.namespaces.eip155.accounts;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const accounts = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const parts = entry.split(':');
    const addr = parts[parts.length - 1];
    if (addr && /^0x[a-fA-F0-9]{40}$/.test(addr) && !seen.has(addr.toLowerCase())) {
      seen.add(addr.toLowerCase());
      accounts.push(addr);
    }
  }
  return accounts;
}

/**
 * Quietly checks if a primary wallet connection completed while the user was in the MetaMask app:
 * - NEVER runs if an address is already connected (`hasConnectedAddress` or `wallets` has an address).
 * - NEVER runs while a transaction is in progress (`isTxInProgress()`).
 * - ONLY runs when the Privy connection modal ("Waiting for MetaMask") is actively open in the DOM.
 * - Strictly rate-limited to at most once every 3 seconds (`SYNC_COOLDOWN_MS`).
 * - Once an address is obtained, simply closes the stuck Privy modal without sending new RPC requests.
 */
export async function syncReturningMobileWallet({
  walletConnectors,
  wallets,
  hasConnectedAddress = false,
} = {}) {
  // 1. Never run during an active transaction
  if (isTxInProgress()) {
    return '';
  }

  // 2. Check if we already have an address from wagmi or Privy useWallets()
  const existingWalletAddress = Array.isArray(wallets)
    ? wallets.find((w) => w?.address && w.walletClientType !== 'privy')?.address ||
      wallets.find((w) => w?.address)?.address ||
      ''
    : '';

  if (hasConnectedAddress || existingWalletAddress) {
    closeStuckPrivyModalIfConnected(true);
    return existingWalletAddress;
  }

  // 3. Only run when the initial "Waiting for MetaMask" / "Connecting" Privy modal is explicitly open
  if (!isPrivyWaitingForWalletModalOpen()) {
    return '';
  }

  // 4. Enforce strict 3-second cooldown & single-flight lock so visibilitychange + focus + pageshow
  //    never fire multiple syncs in a row
  const now = Date.now();
  if (syncInFlight || now - lastSyncTimestamp < SYNC_COOLDOWN_MS) {
    return '';
  }
  syncInFlight = true;
  lastSyncTimestamp = now;

  let foundAddress = '';

  try {
    const connectorsList = walletConnectors?.walletConnectors;
    if (Array.isArray(connectorsList)) {
      for (const connector of connectorsList) {
        if (connector?.connectorType !== 'wallet_connect_v2') continue;
        const wcProvider = connector.walletProvider || connector.provider;
        if (!wcProvider) continue;

        const session = wcProvider.session || wcProvider?.signer?.session;
        const sessionAccounts =
          Array.isArray(wcProvider.accounts) && wcProvider.accounts.length > 0
            ? wcProvider.accounts
            : extractAccountsFromWcSession(session);

        if (sessionAccounts.length > 0) {
          foundAddress = sessionAccounts[0];
          const addrKey = foundAddress.toLowerCase();
          connector.connected = true;
          // Only notify Privy's internal connector once for this session address
          if (!syncedSessionAddresses.has(addrKey) && typeof connector.syncAccounts === 'function') {
            syncedSessionAddresses.add(addrKey);
            await connector.syncAccounts(sessionAccounts);
          }
          break;
        }
      }
    }
  } catch (err) {
    console.warn('[MobileWallet] Passive session check note:', err?.message || err);
  } finally {
    syncInFlight = false;
  }

  if (foundAddress) {
    closeStuckPrivyModalIfConnected(true);
  }

  return foundAddress;
}
