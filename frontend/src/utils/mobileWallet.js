// ============================================================
// Mobile Wallet & MetaMask Deep-Link Helpers
// ============================================================

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
 * Closes a Privy modal if it is currently stuck on "Waiting for MetaMask" / "Sign to verify"
 * after a wallet address has already been obtained in `useWallets()` or `wagmi`.
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
 * Extracts Ethereum accounts (`0x...`) from a WalletConnect v2 session object or localStorage cache.
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
 * Recovers and synchronizes WalletConnect / external mobile wallet state when the user
 * switches back from the MetaMask Mobile app to Android Chrome (`visibilitychange` / `focus`).
 */
export async function syncReturningMobileWallet({
  walletConnectors,
  wallets,
  setActiveWallet,
  reconnect,
}) {
  let foundAddress = '';

  try {
    // 1. Inspect Privy's internal wallet_connect_v2 connector if available
    const connectorsList = walletConnectors?.walletConnectors;
    if (Array.isArray(connectorsList)) {
      for (const connector of connectorsList) {
        if (connector?.connectorType !== 'wallet_connect_v2') continue;
        const wcProvider = connector.walletProvider || connector.provider;
        if (!wcProvider) continue;

        // Wake up the WalletConnect relay WebSocket if Android suspended it in background
        try {
          const relayer = wcProvider?.signer?.client?.core?.relayer;
          if (relayer && !relayer.connected && typeof relayer.transportOpen === 'function') {
            await relayer.transportOpen();
          }
        } catch {
          // Non-fatal relay wakeup
        }

        const session = wcProvider.session || wcProvider?.signer?.session;
        const sessionAccounts =
          (Array.isArray(wcProvider.accounts) && wcProvider.accounts.length > 0
            ? wcProvider.accounts
            : extractAccountsFromWcSession(session));

        if (sessionAccounts.length > 0) {
          foundAddress = sessionAccounts[0];
          connector.connected = true;
          if (typeof connector.syncAccounts === 'function') {
            await connector.syncAccounts(sessionAccounts);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[MobileWallet] Connector sync note:', err?.message || err);
  }

  try {
    // 2. Sync any connected Privy wallet into wagmi immediately
    const activeExternal = Array.isArray(wallets)
      ? wallets.find((w) => w?.address && w.walletClientType !== 'privy') || wallets.find((w) => w?.address)
      : null;

    if (activeExternal?.address) {
      foundAddress = foundAddress || activeExternal.address;
      if (typeof setActiveWallet === 'function') {
        await setActiveWallet(activeExternal);
      }
    }
    if (typeof reconnect === 'function') {
      reconnect();
    }
  } catch (err) {
    console.warn('[MobileWallet] Wagmi sync note:', err?.message || err);
  }

  if (foundAddress) {
    closeStuckPrivyModalIfConnected(true);
  }

  return foundAddress;
}
