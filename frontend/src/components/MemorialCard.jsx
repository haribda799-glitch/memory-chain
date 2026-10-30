import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useReadContract, useWriteContract, useAccount, useEstimateFeesPerGas, useChainId, usePublicClient } from 'wagmi';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { getArweaveUrl } from '../utils/arweave';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress } from '../config/chains';
import { useNow } from '../hooks/useNow';
import CandleAltar from './CandleAltar';
import ReportModal from './ReportModal';

const PLACEHOLDER = 'https://images.unsplash.com/photo-1544568100-847a948585b9?auto=format&fit=crop&w=800&q=80';

/**
 * Resolve any Arweave image URL to a displayable HTTP URL.
 * Handles ar://, http://, https:// and plain txId-based URLs.
 */
function resolveImageUrl(raw) {
  if (!raw) return '';
  if (raw.startsWith('ar://')) return `https://arweave.net/${raw.slice(5)}`;
  return raw;
}

export default function MemorialCard({
  tokenId,
  petName,
  arweaveUri,
  arweaveTxId,
  createdAt,
  isPublic: isPublicRaw,
  isFlagged,
  isHidden,
  isBanned,
  isOwner,
  isTogglingVisibility,
  onToggleVisibility,
  ownerAddress,
  refetch,
  onUpdate,
  species: propSpecies,
  category: propCategory,
  breed: propBreed,
  memorial,
  candleExpiresAt: propCandleExpiresAt,
  totalCandlesLit: propTotalCandlesLit,
  activeCount: propActiveCount,
  now: propNow,
}) {
  // Shared clock (unix seconds) supplied by the page so all cards tick together on one timer.
  // Only when no parent provides it does the card run its own clock.
  const ownNow = useNow(15000, propNow === undefined);

  // Strict boolean normalization — guards against 0n, undefined, null from contract/props
  const isPublic = Boolean(isPublicRaw);

  const txId = arweaveUri || arweaveTxId || '';
  const [metadata, setMetadata] = useState(null);
  const [, setIsMetaLoading] = useState(Boolean(txId));
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [isMining, setIsMining] = useState(false);
  const menuRef = useRef(null);

  const chainId = useChainId();
  const contractAddress = getContractAddress(chainId);
  const publicClient = usePublicClient();

  const { address: wagmiAddress, connector } = useAccount();
  const { wallets } = useWallets();
  const { user } = usePrivy();
  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const activeAddress = wagmiAddress || embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;

  // Read contract owner (Admin)
  const { data: contractOwner } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'owner',
  });

  const isAdmin = !!activeAddress && !!contractOwner && contractOwner.toLowerCase() === activeAddress.toLowerCase();

  // Read report weight for this memorial
  const { data: reportWeightRaw, refetch: refetchReportCount } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'report_weight',
    args: [BigInt(tokenId)],
  });

  const reportWeight = Number(reportWeightRaw || 0);
  const hasReports = reportWeight > 0 || Boolean(isFlagged) || Boolean(isBanned);
  const isBannedEffective = Boolean(isBanned) || Boolean(isHidden);

  const { writeContractAsync, isPending: isAdminPending } = useWriteContract();
  const { data: feeData } = useEstimateFeesPerGas();

  const handleAdminDismiss = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!connector) {
      console.error("Wallet connector is missing or Privy was blocked.");
      alert("Wallet connection failed. Please disable your adblocker or reconnect your wallet.");
      return;
    }
    setIsMining(true);
    try {
      const gasConfig = {};
      if (feeData?.maxFeePerGas) {
        gasConfig.maxFeePerGas = (feeData.maxFeePerGas * 130n) / 100n;
      }
      if (feeData?.maxPriorityFeePerGas) {
        gasConfig.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * 130n) / 100n;
      }

      const tx = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'dismiss_reports',
        args: [BigInt(tokenId)],
        account: activeAddress,
        connector,
        ...gasConfig,
      });
      console.log('[Admin] Dismiss reports tx submitted:', tx);

      if (publicClient && tx) {
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log('[Admin] Dismiss reports tx mined!');
      }

      if (refetchReportCount) await refetchReportCount();
      if (typeof refetch === 'function') await refetch();
      if (typeof onUpdate === 'function') await onUpdate();
    } catch (err) {
      console.error('[Admin] Dismiss failed — full error:', err);
      console.error('[Admin] shortMessage:', err?.shortMessage);
      console.error('[Admin] cause:', err?.cause);
      console.error('[Admin] metaMessages:', err?.metaMessages);
      const reason = err?.shortMessage || err?.metaMessages?.[0] || err?.message || 'Dismiss failed';
      alert(`[Admin Dismiss Error]\n${reason}`);
    } finally {
      setIsMining(false);
    }
  };

  const handleAdminBan = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!connector) {
      console.error("Wallet connector is missing or Privy was blocked.");
      alert("Wallet connection failed. Please disable your adblocker or reconnect your wallet.");
      return;
    }
    setIsMining(true);
    try {
      const gasConfig = {};
      if (feeData?.maxFeePerGas) {
        gasConfig.maxFeePerGas = (feeData.maxFeePerGas * 130n) / 100n;
      }
      if (feeData?.maxPriorityFeePerGas) {
        gasConfig.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * 130n) / 100n;
      }

      const tx = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'force_ban',
        args: [BigInt(tokenId)],
        account: activeAddress,
        connector,
        ...gasConfig,
      });
      console.log('[Admin] Force ban tx submitted:', tx);

      if (publicClient && tx) {
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log('[Admin] Force ban tx mined!');
      }

      if (refetchReportCount) await refetchReportCount();
      if (typeof refetch === 'function') await refetch();
      if (typeof onUpdate === 'function') await onUpdate();
    } catch (err) {
      console.error('[Admin] Force ban failed — full error:', err);
      console.error('[Admin] shortMessage:', err?.shortMessage);
      console.error('[Admin] cause:', err?.cause);
      console.error('[Admin] metaMessages:', err?.metaMessages);
      const reason = err?.shortMessage || err?.metaMessages?.[0] || err?.message || 'Force ban failed';
      alert(`[Admin Ban Error]\n${reason}`);
    } finally {
      setIsMining(false);
    }
  };

  const handleAdminUnban = async (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!connector) {
      console.error("Wallet connector is missing or Privy was blocked.");
      alert("Wallet connection failed. Please disable your adblocker or reconnect your wallet.");
      return;
    }
    setIsMining(true);
    try {
      const gasConfig = {};
      if (feeData?.maxFeePerGas) {
        gasConfig.maxFeePerGas = (feeData.maxFeePerGas * 130n) / 100n;
      }
      if (feeData?.maxPriorityFeePerGas) {
        gasConfig.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * 130n) / 100n;
      }

      const tx = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'unban_memorial',
        args: [BigInt(tokenId)],
        account: activeAddress,
        connector,
        ...gasConfig,
      });
      console.log('[Admin] Unban tx submitted:', tx);

      if (publicClient && tx) {
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log('[Admin] Unban tx mined!');
      }

      if (refetchReportCount) await refetchReportCount();
      if (typeof refetch === 'function') await refetch();
      if (typeof onUpdate === 'function') await onUpdate();
    } catch (err) {
      console.error('[Admin] Unban failed — full error:', err);
      console.error('[Admin] shortMessage:', err?.shortMessage);
      console.error('[Admin] cause:', err?.cause);
      console.error('[Admin] metaMessages:', err?.metaMessages);
      const reason = err?.shortMessage || err?.metaMessages?.[0] || err?.message || 'Unban failed';
      alert(`[Admin Unban Error]\n${reason}`);
    } finally {
      setIsMining(false);
    }
  };

  // Read candle expiry from contract (skipped if provided via props)
  const { data: candleExpiryRaw } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'candle_expires_at',
    args: [BigInt(tokenId)],
    query: {
      enabled: propCandleExpiresAt === undefined,
    },
  });

  // Read total candles lit from contract (skipped if provided via props)
  const { data: totalCandlesRaw } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'total_candles_lit',
    args: [BigInt(tokenId)],
    query: {
      enabled: propTotalCandlesLit === undefined,
    },
  });

  const now = propNow ?? ownNow;
  const candleExpiresAt = Number(
    propCandleExpiresAt ??
    candleExpiryRaw ??
    memorial?.candle_expires_at ??
    memorial?.candleExpiresAt ??
    0
  );
  const totalCandlesLit = Number(
    propTotalCandlesLit ??
    totalCandlesRaw ??
    memorial?.total_candles_lit ??
    memorial?.totalCandles ??
    memorial?.candleCount ??
    0
  );
  const isBurning = candleExpiresAt > now;

  // Close dropdown on click outside
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [isMenuOpen]);

  // Fetch Arweave metadata JSON so we can show real photo, dates, species, breed
  useEffect(() => {
    if (!txId) {
      setIsMetaLoading(false);
      return;
    }
    let isCancelled = false;
    setIsMetaLoading(true);

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = setTimeout(() => {
      if (controller) controller.abort();
      if (!isCancelled) setIsMetaLoading(false);
    }, 4000);

    fetch(getArweaveUrl(txId), { ...(controller ? { signal: controller.signal } : {}) })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!isCancelled && json) {
          setMetadata(json);
        }
      })
      .catch((err) => {
        console.warn(`[MemorialCard] Metadata fetch error for #${tokenId}:`, err);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (!isCancelled) {
          setIsMetaLoading(false);
        }
      });

    return () => {
      isCancelled = true;
      clearTimeout(timeoutId);
      if (controller) controller.abort();
    };
  }, [txId, tokenId]);

  // --- Image ---
  const rawImage  = metadata?.image || '';
  const imageUrl  = resolveImageUrl(rawImage) || (txId ? getArweaveUrl(txId) : '');

  // --- Dates ---
  const attrs       = Array.isArray(metadata?.attributes) ? metadata.attributes : [];
  const findAttr    = (trait) =>
    attrs.find((a) => String(a?.trait_type || '').trim().toLowerCase() === trait.toLowerCase())?.value;
  const birthYear   = metadata?.birth_year   || findAttr('Birth Year');
  const passingYear = metadata?.passing_year || findAttr('Passing Year');

  const safeCreatedAt = Number(createdAt || 0);
  const displayDate = (birthYear && passingYear)
    ? `${birthYear} – ${passingYear}`
    : (safeCreatedAt > 0
        ? new Date(safeCreatedAt * 1000).toLocaleDateString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
          })
        : '');

  // --- Badges ---
  const rawSpecies =
    metadata?.species ||
    findAttr('Species') ||
    findAttr('Animal') ||
    propSpecies ||
    propCategory ||
    memorial?.metadata?.species ||
    memorial?.species ||
    '';
  const cleanSpecies = /^(companion|other|unknown|none)$/i.test(String(rawSpecies).trim())
    ? ''
    : String(rawSpecies).trim();
  const breed = String(
    metadata?.breed || findAttr('Breed') || propBreed || memorial?.breed || ''
  ).trim();

  return (
    <>
      <div className="bg-surface rounded-[16px] border border-outline-variant/20 overflow-hidden group hover:shadow-sm transition-shadow duration-300 flex flex-col h-full">
        <Link to={`/memorial/${tokenId}`} className="no-underline flex flex-col flex-grow">
          {/* Photo */}
          <div className="relative h-64 shrink-0 overflow-hidden">
            <img
              src={imageUrl || PLACEHOLDER}
              alt={`Memorial for ${petName}`}
              className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
              loading="lazy"
              onError={(e) => { e.currentTarget.src = PLACEHOLDER; }}
            />

            {/* Top-Left Status Badge */}
            <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
              {isBannedEffective ? (
                <div className="px-3 py-1 bg-red-600 text-white text-xs font-bold rounded-full shadow-md flex items-center gap-1 uppercase tracking-wider">
                  <span className="material-symbols-outlined text-xs">gavel</span>
                  <span>Banned by Admin</span>
                </div>
              ) : hasReports ? (
                <div className="px-3 py-1 bg-amber-600/95 backdrop-blur-md text-white text-xs font-bold rounded-full shadow-md flex items-center gap-1 uppercase tracking-wider">
                  <span className="material-symbols-outlined text-xs">warning</span>
                  <span>Under Review</span>
                </div>
              ) : null}
            </div>

            {/* Top-Right Unlisted Badge */}
            {isPublic === false && (
              <div className="absolute top-3 right-3 flex items-center gap-2 z-10">
                <div
                  className="px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-white/95 text-[11px] font-semibold flex items-center gap-1 shadow-md uppercase tracking-wider"
                  title="Private/Unlisted Memorial (Hidden from Public Gallery)"
                >
                  <span className="material-symbols-outlined text-xs">lock</span>
                  <span>Private/Unlisted</span>
                </div>
              </div>
            )}
          </div>

          {/* Card Body */}
          <div className="p-6 flex flex-col flex-grow">
            <div className="flex justify-between items-start mb-4">
              <div className="flex-1 min-w-0 pr-2">
                <h3 className="font-headline-sm text-headline-sm text-on-surface">
                  {petName || `Memorial #${tokenId}`}
                </h3>
                {displayDate && (
                  <p className="font-body-sm text-body-sm text-on-surface-variant mt-1">{displayDate}</p>
                )}
                {/* Dynamic species / breed badges (only shown when species or breed is actually set) */}
                {(cleanSpecies || breed) && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {cleanSpecies && (
                      <span className="px-3 py-1 rounded-full bg-secondary-container text-on-secondary-container font-label-md text-label-md text-[10px] tracking-wider uppercase">
                        {cleanSpecies.toUpperCase()}
                      </span>
                    )}
                    {breed && (
                      <span className="px-3 py-1 rounded-full bg-secondary-container text-on-secondary-container font-label-md text-label-md text-[10px] tracking-wider uppercase">
                        {breed}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-auto pt-4 border-t border-outline-variant/15 flex flex-col gap-3">
              {isBurning && totalCandlesLit > 0 ? (
                <div
                  className="w-full min-h-[78px] rounded-2xl py-2.5 px-3 flex flex-col items-center justify-center transition-all duration-300 group-hover:border-amber-400/40"
                  style={{
                    background: 'radial-gradient(circle at 50% 50%, rgba(251,191,36,0.14) 0%, rgba(250,247,242,0) 70%)',
                    border: '1px solid rgba(245,158,11,0.25)',
                    boxShadow: '0 0 16px rgba(245,158,11,0.12), inset 0 0 10px rgba(245,158,11,0.05)',
                  }}
                  title="Shared flame of remembrance"
                >
                  <CandleAltar totalCandles={totalCandlesLit} expiryTimestamp={candleExpiresAt} isBurning={true} />
                </div>
              ) : (
                <div
                  className="w-full min-h-[78px] rounded-2xl py-2.5 px-3 flex flex-col items-center justify-center transition-all duration-300 border border-outline-variant/20 bg-[#F5efe6]/35 group-hover:bg-[#F5efe6]/70 group-hover:border-[#d8c2ba]/60"
                  title="The flame has rested · Click to rekindle"
                >
                  <CandleAltar totalCandles={totalCandlesLit} expiryTimestamp={0} isBurning={false} />
                </div>
              )}
            </div>
          </div>
        </Link>

        {/* Owner Visibility Controls (outside the <Link> so taps never navigate on touch screens) */}
        {isOwner && onToggleVisibility && (
          <div className="px-6 pb-6 -mt-3 w-full">
          <div className="pt-3 border-t border-outline-variant/15 w-full">
            {isBannedEffective ? (
              <div className="text-center p-2.5 bg-red-50 text-red-700 text-xs font-bold rounded-xl border border-red-200 w-full shadow-xs flex items-center justify-center gap-1.5">
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Visibility locked due to admin ban</span>
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleVisibility();
                }}
                disabled={isTogglingVisibility}
                className={`w-full min-h-[44px] py-2.5 px-3 rounded-xl text-xs font-semibold transition-all shadow-xs flex items-center justify-center gap-2 touch-manipulation ${
                  isTogglingVisibility
                    ? 'bg-amber-100 text-amber-900 border border-amber-300 opacity-80 cursor-wait'
                    : isPublic
                      ? 'bg-[#F5EFE6] text-[#7C5843] border border-[#E5D7C3] hover:bg-[#EFE5D8] cursor-pointer'
                      : 'bg-stone-100 text-stone-600 border border-stone-200/80 hover:bg-stone-200/70 cursor-pointer'
                }`}
              >
                {isTogglingVisibility ? (
                  <>
                    <svg className="animate-spin h-3.5 w-3.5 text-current inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                    </svg>
                    <span>Updating...</span>
                  </>
                ) : isPublic ? (
                  <>
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M3.6 9h16.8" />
                      <path d="M3.6 15h16.8" />
                      <path d="M11.5 3a17 17 0 0 0 0 18" />
                      <path d="M12.5 3a17 17 0 0 1 0 18" />
                    </svg>
                    <span>Public (Click to Hide)</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="4" y="11" width="16" height="10" rx="2" ry="2" />
                      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                    </svg>
                    <span>Hidden from Gallery (Click to Publish)</span>
                  </>
                )}
              </button>
            )}
          </div>
          </div>
        )}

        {/* Admin Controls Panel */}
        {isAdmin && hasReports && (
          <div className="p-4 bg-red-50 border-t border-red-200 flex flex-col gap-2 z-20">
            <div className="text-xs text-red-800 font-bold w-full text-center tracking-wider uppercase">
              🛡️ ADMIN CONTROLS
            </div>
            <div className="flex gap-2 w-full">
              <button 
                type="button"
                onClick={handleAdminDismiss}
                disabled={isAdminPending || isMining || isBanned}
                title={isBanned ? 'Cannot dismiss banned memorial; unban first' : 'Dismiss reports'}
                className="flex-1 bg-white text-green-700 border border-green-300 py-1.5 rounded-lg text-xs font-bold hover:bg-green-50 transition-colors disabled:opacity-50 shadow-sm"
              >
                {isAdminPending ? 'Confirming...' : isMining ? 'Mining...' : '✅ DISMISS'}
              </button>
              {isBanned ? (
                <button 
                  type="button"
                  onClick={handleAdminUnban}
                  disabled={isAdminPending || isMining}
                  className="flex-1 bg-emerald-600 text-white py-1.5 rounded-lg text-xs font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50 shadow-sm"
                >
                  {isAdminPending ? 'Confirming...' : isMining ? 'Mining...' : '🔓 UNBAN'}
                </button>
              ) : (
                <button 
                  type="button"
                  onClick={handleAdminBan}
                  disabled={isAdminPending || isMining}
                  className="flex-1 bg-red-600 text-white py-1.5 rounded-lg text-xs font-bold hover:bg-red-700 transition-colors disabled:opacity-50 shadow-sm"
                >
                  {isAdminPending ? 'Confirming...' : isMining ? 'Mining...' : '🚨 FORCE BAN'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Mounted only while open so Gallery cards don't each fire the modal's RPC reads */}
      {showReportModal && (
        <ReportModal
          isOpen={showReportModal}
          onClose={() => setShowReportModal(false)}
          memorialId={tokenId}
          petName={petName}
        />
      )}
    </>
  );
}
