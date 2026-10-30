import { useState, useEffect, useRef, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import BrandLogo from './BrandLogo';
import { usePrivy, useWallets, useFundWallet } from '@privy-io/react-auth';
import { useSetActiveWallet } from '@privy-io/wagmi';
import { useAccount, useDisconnect } from 'wagmi';
import { baseSepolia } from 'viem/chains';
import {
  isMobileWithoutEthereum,
  getMetaMaskDappDeepLink,
  syncReturningMobileWallet,
  closeStuckPrivyModalIfConnected,
  isPrivyWaitingForWalletModalOpen,
  isTxInProgress,
} from '../utils/mobileWallet';

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const burgerButtonRef = useRef(null);
  const userMenuRef = useRef(null);
  const loggingOutRef = useRef(false);
  const { pathname } = useLocation();

  // Privy & Wagmi Hooks
  const {
    ready,
    authenticated,
    login,
    connectWallet,
    logout,
    exportWallet,
    user,
    createWallet,
    walletConnectors,
  } = usePrivy();
  const { wallets } = useWallets();
  const { address: wagmiAddress, isConnected: isWagmiConnected, connector, status: wagmiStatus } = useAccount();
  const { setActiveWallet } = useSetActiveWallet();
  const { fundWallet } = useFundWallet();
  const { disconnect } = useDisconnect();
  const lastSyncedWalletRef = useRef('');

  // Combined logout: clear external wallet sessions, Wagmi connector cache, and Privy session
  const handleLogout = async (closeFn) => {
    // Block the embedded-wallet auto-sync while sessions are being torn down (prevents an Email wallet
    // from being re-activated in wagmi right after logout, before the user connects MetaMask).
    loggingOutRef.current = true;
    lastSyncedWalletRef.current = '';
    try {
      for (const w of wallets) {
        if (w.walletClientType !== 'privy' && typeof w.disconnect === 'function') {
          try {
            await w.disconnect();
          } catch {
            // ignore individual wallet disconnect error
          }
        }
      }
      disconnect(); // 1. Kills Wagmi connector cache (MetaMask / WalletConnect / injected)
      if (authenticated) {
        await logout(); // 2. Ends Privy SIWE/email session if active
      }
    } catch (err) {
      console.error('[Logout] Error during logout:', err);
    } finally {
      if (closeFn) closeFn();
      setTimeout(() => {
        loggingOutRef.current = false;
      }, 1500);
    }
  };

  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const externalWallet = wallets.find((w) => w.walletClientType !== 'privy');
  const displayAddress =
    wagmiAddress ||
    externalWallet?.address ||
    embeddedWallet?.address ||
    user?.wallet?.address ||
    wallets[0]?.address;

  // Treat the user as connected as soon as Wagmi or Privy useWallets() provides an active address,
  // even when external wallet connection ran in 1-step connectWallet() mode (authenticated === false).
  const isUserAuthenticated = Boolean(displayAddress) || (ready && authenticated);
  const showMobileMetaMaskDeepLink = isMobileWithoutEthereum();

  useEffect(() => {
    if (authenticated && !embeddedWallet && !externalWallet && !wagmiAddress && !user?.wallet) {
      createWallet();
    }
  }, [authenticated, embeddedWallet, externalWallet, wagmiAddress, user, createWallet]);

  // After F5 the Privy Email (embedded) wallet initializes later than wagmi, leaving wagmi's connector
  // disconnected while useWallets() already holds the wallet. Re-attach ONLY the embedded wallet here:
  // external wallets (MetaMask / WalletConnect) are restored by wagmi's own reconnect, and forcing them
  // would trigger extra prompts in mobile MetaMask.
  useEffect(() => {
    if (!ready || !authenticated || !embeddedWallet?.address) {
      lastSyncedWalletRef.current = '';
      return;
    }
    if (loggingOutRef.current || isTxInProgress()) return;
    if (wagmiStatus === 'connecting' || wagmiStatus === 'reconnecting') return;

    // Never hijack an external-wallet session: only Email users (or users with no external wallet)
    const prefersEmbedded = Boolean(user?.email) || !externalWallet;
    if (!prefersEmbedded) return;

    if (isWagmiConnected && connector && wagmiAddress) {
      lastSyncedWalletRef.current = '';
      return;
    }

    if (typeof setActiveWallet === 'function') {
      const syncKey = `privy:${embeddedWallet.address.toLowerCase()}`;
      if (lastSyncedWalletRef.current !== syncKey) {
        lastSyncedWalletRef.current = syncKey;
        Promise.resolve(setActiveWallet(embeddedWallet)).catch((err) => {
          lastSyncedWalletRef.current = '';
          console.warn('[Header] setActiveWallet sync note:', err?.message || err);
        });
      }
    }
  }, [
    ready,
    authenticated,
    user,
    embeddedWallet,
    externalWallet,
    isWagmiConnected,
    connector,
    wagmiAddress,
    wagmiStatus,
    setActiveWallet,
  ]);

  // Close the mobile burger menu and the desktop wallet menu on every route change (incl. browser Back)
  useEffect(() => {
    setMenuOpen(false);
    setUserMenuOpen(false);
  }, [pathname]);

  // Close the desktop wallet menu on an outside tap / click
  useEffect(() => {
    if (!userMenuOpen) return undefined;
    const handlePointerDown = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [userMenuOpen]);

  // Once an address is available, dismiss any Privy modal stuck on "Waiting for MetaMask"
  // without sending any extra RPC requests to the wallet.
  useEffect(() => {
    if (displayAddress) {
      closeStuckPrivyModalIfConnected(true);
    }
  }, [displayAddress]);

  // Recover WalletConnect / mobile MetaMask connection ONLY when returning to Chrome while
  // the initial "Waiting for MetaMask" modal is open and no wallet address is connected yet.
  const handleVisibilityOrFocus = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (isTxInProgress()) return;

    const alreadyConnected = Boolean(displayAddress) || Boolean(isWagmiConnected);
    if (alreadyConnected) {
      closeStuckPrivyModalIfConnected(true);
      return;
    }

    if (!isPrivyWaitingForWalletModalOpen()) {
      return;
    }

    syncReturningMobileWallet({
      walletConnectors,
      wallets,
      hasConnectedAddress: alreadyConnected,
    });
  }, [walletConnectors, wallets, displayAddress, isWagmiConnected]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
    window.addEventListener('pageshow', handleVisibilityOrFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      window.removeEventListener('pageshow', handleVisibilityOrFocus);
    };
  }, [handleVisibilityOrFocus]);

  // Clear residual browser focus on the mobile burger button when Privy modal closes or auth state changes
  useEffect(() => {
    burgerButtonRef.current?.blur();
  }, [authenticated, isUserAuthenticated, menuOpen]);

  const networkName = 'Base Sepolia';
  const truncate = (addr) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';

  const handleShowPrivyWallet = async () => {
    if (displayAddress) {
      try {
        await fundWallet({
          address: displayAddress,
          options: { chain: baseSepolia },
        });
      } catch (err) {
        console.error('Fund wallet error:', err);
      }
    }
  };

  const handleFundForMemorial = async () => {
    if (displayAddress) {
      try {
        await fundWallet({
          address: displayAddress,
          options: {
            chain: baseSepolia,
            amount: '0.008',
            asset: 'native-currency',
          },
        });
      } catch (err) {
        console.error('Fund memorial error:', err);
      }
    }
  };

  return (
    <>
      <nav className="bg-surface/80 backdrop-blur-md border-b border-outline-variant/15 fixed top-0 w-full z-50 transition-all duration-300">
        <div className="flex justify-between items-center px-margin-mobile md:px-margin-desktop py-4 max-w-container-max mx-auto">
          
          {/* Logo */}
          <BrandLogo className="animate-[fadeIn_1.5s_ease-in-out]" />

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center space-x-8 font-body-md text-body-md">
            <NavLink
              to="/"
              className={({ isActive }) =>
                isActive 
                  ? 'text-primary font-bold'
                  : 'text-on-surface-variant hover:text-primary transition-colors cursor-pointer'
              }
            >
              Memorials
            </NavLink>
            <NavLink
              to="/my"
              className={({ isActive }) =>
                isActive 
                  ? 'text-primary font-bold'
                  : 'text-on-surface-variant hover:text-primary transition-colors cursor-pointer'
              }
            >
              My Memorials
            </NavLink>
            <NavLink
              to="/create"
              className={({ isActive }) =>
                isActive 
                  ? 'text-primary font-bold'
                  : 'text-on-surface-variant hover:text-primary transition-colors cursor-pointer'
              }
            >
              Create
            </NavLink>

            {/* Wallet / Network Logic */}
            <div className="flex items-center space-x-4">
              {isUserAuthenticated && (
                <span className="border border-outline-variant/30 text-on-surface-variant px-4 py-1.5 rounded-full text-sm">
                  {networkName}
                </span>
              )}
              {isUserAuthenticated ? (
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => setUserMenuOpen(!userMenuOpen)}
                    className="border border-outline-variant/30 text-on-surface-variant px-4 py-1.5 rounded-full text-sm hover:bg-surface-tint hover:text-on-primary transition-colors flex items-center gap-2"
                  >
                    {truncate(displayAddress)}
                    <span className="material-symbols-outlined text-[16px]">expand_more</span>
                  </button>
                  {userMenuOpen && (
                    <div className="absolute right-0 mt-2 w-64 bg-surface border border-outline-variant/15 rounded-xl shadow-lg p-2 flex flex-col space-y-1 z-50">
                      {!displayAddress ? (
                        <div className="px-4 py-3 text-sm text-[#85736d] italic">Initializing wallet...</div>
                      ) : (
                        <>
                          {embeddedWallet && (
                            <>
                              <button onClick={() => { handleShowPrivyWallet(); setUserMenuOpen(false); }} className="text-left px-3 py-2 text-sm text-on-surface hover:bg-surface-tint rounded-lg flex items-center gap-2">
                                <span className="material-symbols-outlined text-[18px]">qr_code</span> Receive Funds
                              </button>
                              <button onClick={() => { handleFundForMemorial(); setUserMenuOpen(false); }} className="text-left px-3 py-2 text-sm text-on-surface hover:bg-surface-tint rounded-lg flex items-center gap-2">
                                <span className="material-symbols-outlined text-[18px]">payments</span> Fund Memorial
                              </button>
                              <button onClick={() => { exportWallet(); setUserMenuOpen(false); }} className="text-left px-3 py-2 text-sm text-on-surface hover:bg-surface-tint rounded-lg flex items-center gap-2">
                                <span className="material-symbols-outlined text-[18px]">key</span> Export Key
                              </button>
                              <div className="h-px bg-outline-variant/15 my-1" />
                            </>
                          )}
                          <button onClick={() => handleLogout(() => setUserMenuOpen(false))} className="text-left px-3 py-2 text-sm text-error hover:bg-error-container rounded-lg flex items-center gap-2">
                            <span className="material-symbols-outlined text-[18px]">logout</span> Disconnect
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.currentTarget.blur();
                      login({ loginMethods: ['email'] });
                    }}
                    disabled={!ready}
                    title="Sign in with Email — automatic built-in wallet"
                    className="bg-[#c27357] hover:bg-[#8a4f36] text-white px-5 py-2 rounded-full text-xs font-semibold uppercase tracking-wider transition-colors disabled:opacity-50 outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40 inline-flex items-center gap-1.5 shadow-xs cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[16px] text-white">mail</span>
                    <span>Sign in with Email</span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.currentTarget.blur();
                      connectWallet();
                    }}
                    disabled={!ready}
                    title="Connect an external Web3 wallet (MetaMask, WalletConnect)"
                    className="border border-outline-variant/40 text-on-surface-variant px-4 py-2 rounded-full text-xs font-semibold uppercase tracking-wider hover:bg-surface-tint hover:text-white transition-colors disabled:opacity-50 outline-none focus:outline-none inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[15px]">account_balance_wallet</span>
                    <span>Connect Wallet</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Mobile burger */}
          <button
            ref={burgerButtonRef}
            type="button"
            aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={menuOpen}
            className="md:hidden w-10 h-10 inline-flex items-center justify-center rounded-lg shrink-0 outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
            onClick={(e) => {
              e.currentTarget.blur();
              setMenuOpen((prev) => !prev);
            }}
          >
            <span className="material-symbols-outlined text-on-surface-variant leading-none select-none">
              {menuOpen ? 'close' : 'menu'}
            </span>
          </button>
        </div>

        {/* Mobile dropdown */}
        {menuOpen && (
          <div className="md:hidden bg-surface border-t border-outline-variant/15 px-margin-mobile py-4 flex flex-col space-y-4 shadow-lg">
            <NavLink to="/" className="text-on-surface-variant text-body-md" onClick={() => setMenuOpen(false)}>Memorials</NavLink>
            <NavLink to="/my" className="text-on-surface-variant text-body-md" onClick={() => setMenuOpen(false)}>My Memorials</NavLink>
            <NavLink to="/create" className="text-on-surface-variant text-body-md" onClick={() => setMenuOpen(false)}>Create Memorial</NavLink>
            
            <div className="h-px bg-outline-variant/15 w-full my-2" />

            {isUserAuthenticated ? (
              <div className="flex flex-col space-y-4 pl-2">
                <span className="text-xs text-on-surface-variant uppercase tracking-wider font-bold">Wallet Actions</span>
                {embeddedWallet && (
                  <>
                    <button onClick={() => { handleShowPrivyWallet(); setMenuOpen(false); }} className="text-left text-on-surface-variant text-body-md flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px]">qr_code</span> Receive Funds
                    </button>
                    <button onClick={() => { handleFundForMemorial(); setMenuOpen(false); }} className="text-left text-on-surface-variant text-body-md flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px]">payments</span> Fund Memorial
                    </button>
                    <button onClick={() => { exportWallet(); setMenuOpen(false); }} className="text-left text-on-surface-variant text-body-md flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px]">key</span> Export Private Key
                    </button>
                  </>
                )}
                <button
                  onClick={() => handleLogout(() => setMenuOpen(false))}
                  className="text-left text-error text-body-md flex items-center gap-2"
                >
                  <span className="material-symbols-outlined text-[18px]">logout</span> Disconnect ({truncate(displayAddress)})
                </button>
              </div>
            ) : (
              <div className="flex flex-col space-y-3 pl-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    setMenuOpen(false);
                    burgerButtonRef.current?.blur();
                    login({ loginMethods: ['email'] });
                  }}
                  disabled={!ready}
                  className="w-full text-left bg-[#f5efe6] hover:bg-[#ebddd5] border border-[#d8c2ba]/70 rounded-2xl px-4 py-3 disabled:opacity-50 flex items-center gap-3 outline-none focus:outline-none transition-colors"
                >
                  <span className="material-symbols-outlined text-[20px] text-[#8a4f36]">mail</span>
                  <div className="flex flex-col">
                    <span className="text-primary font-bold text-body-md leading-tight">Sign in with Email</span>
                    <span className="text-[11px] text-[#85736d] font-medium">Automatic built-in wallet</span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.blur();
                    setMenuOpen(false);
                    burgerButtonRef.current?.blur();
                    connectWallet();
                  }}
                  disabled={!ready}
                  className="text-left text-on-surface-variant text-sm font-medium disabled:opacity-50 flex items-center gap-2 px-2 py-1 outline-none focus:outline-none"
                >
                  <span className="material-symbols-outlined text-[18px]">account_balance_wallet</span>
                  <span>Connect External Wallet</span>
                </button>
                {showMobileMetaMaskDeepLink && (
                  <a
                    href={getMetaMaskDappDeepLink()}
                    onClick={() => setMenuOpen(false)}
                    className="text-left text-[#8a4f36] font-medium text-xs flex items-center gap-2 px-2 hover:underline"
                  >
                    <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                    <span>Open in MetaMask App</span>
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </nav>
    </>
  );
}
