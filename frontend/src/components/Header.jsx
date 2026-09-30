import { useState, useEffect } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { usePrivy, useWallets, useFundWallet } from '@privy-io/react-auth';
import { useDisconnect } from 'wagmi';
import { baseSepolia } from 'viem/chains';

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Privy Hooks
  const { ready, authenticated, login, logout, exportWallet, user, createWallet } = usePrivy();
  const { wallets } = useWallets();
  const { fundWallet } = useFundWallet();
  const { disconnect } = useDisconnect();

  // Combined logout: clear Wagmi connector cache first, then end Privy session
  const handleLogout = async (closeFn) => {
    try {
      disconnect();        // 1. Kills Wagmi connector cache (MetaMask / injected)
      await logout();     // 2. Ends Privy session
    } catch (err) {
      console.error('[Logout] Error during logout:', err);
    } finally {
      if (closeFn) closeFn();
    }
  };

  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const displayAddress = embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;
  const isUserAuthenticated = ready && authenticated;

  useEffect(() => {
    if (authenticated && !embeddedWallet && !user?.wallet) {
      createWallet();
    }
  }, [authenticated, embeddedWallet, user]);

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
          <Link
            to="/"
            className="font-headline-sm text-headline-sm text-primary cursor-pointer hover:opacity-80 transition-opacity animate-[fadeIn_1.5s_ease-in-out]"
          >
            Memory Chain
          </Link>

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
                <div className="relative">
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
                <button
                  onClick={login}
                  disabled={!ready}
                  className="bg-primary-container text-on-primary-container px-6 py-2 rounded-full font-label-md text-label-md uppercase tracking-wider hover:bg-surface-tint hover:text-on-primary transition-colors disabled:opacity-50"
                >
                  Connect Wallet
                </button>
              )}
            </div>
          </div>

          {/* Mobile burger */}
          <button className="md:hidden" onClick={() => setMenuOpen(!menuOpen)}>
            <span className="material-symbols-outlined text-on-surface-variant">{menuOpen ? 'close' : 'menu'}</span>
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
              <button
                onClick={() => { login(); setMenuOpen(false); }}
                disabled={!ready}
                className="text-left text-primary font-bold text-body-md disabled:opacity-50 pl-2"
              >
                Connect Wallet
              </button>
            )}
          </div>
        )}
      </nav>
    </>
  );
}
