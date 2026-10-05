import { useParams, Link } from 'react-router-dom';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useReadContract, useChainId } from 'wagmi';
import { useState, useEffect, useRef } from 'react';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress, getExplorerUrl } from '../config/chains';
import { getArweaveUrl } from '../utils/arweave';
import Candle from './Candle';
import CandleAltar from './CandleAltar';
import LightCandleModal from './LightCandleModal';
import ReportModal from './ReportModal';
import ShareModal from './ShareModal';
import { parseMemorial } from '../utils/memorialParser';

export default function MemorialPage() {
  const { id } = useParams();
  const chainId = useChainId();
  const contractAddress = getContractAddress(chainId);
  const explorerUrl = getExplorerUrl(chainId);
  const tokenId = BigInt(id || 0);

  const { authenticated, login, user } = usePrivy();
  const { wallets } = useWallets();

  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const userAddress = embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;

  const [metadata, setMetadata] = useState(null);
  const [showCandleModal, setShowCandleModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [pendingCandleOpen, setPendingCandleOpen] = useState(false);
  const [, setReportRefreshTrigger] = useState(0);

  const handleIgniteClick = () => {
    if (!authenticated) {
      setPendingCandleOpen(true);
      login();
      return;
    }
    setShowCandleModal(true);
  };

  useEffect(() => {
    if (authenticated && userAddress && pendingCandleOpen) {
      setPendingCandleOpen(false);
      setShowCandleModal(true);
    }
  }, [authenticated, userAddress, pendingCandleOpen]);

  const { data: memorialRaw, isLoading } = useReadContract({
    address: contractAddress, abi: CONTRACT_ABI, functionName: 'memorials', args: [tokenId],
  });

  const parsedMemorial = parseMemorial(memorialRaw, id);
  const isOwner = Boolean(
    userAddress &&
    parsedMemorial?.owner &&
    userAddress.toLowerCase() === parsedMemorial.owner.toLowerCase()
  );

  const { data: isFlagged, refetch: refetchFlagged } = useReadContract({
    address: contractAddress, abi: CONTRACT_ABI, functionName: 'is_memorial_flagged', args: [tokenId],
  });

  // Read moderation epoch and report weight from contract
  const { data: reportEpochRaw, refetch: refetchReportEpoch } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'report_epoch',
    args: [tokenId],
    query: { enabled: !!tokenId },
  });

  const { data: reportWeightRaw, refetch: refetchReportWeight } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'report_weight',
    args: [tokenId],
    query: { enabled: !!tokenId },
  });

  // Read has_reported check on-chain for the connected user
  const { data: hasReportedOnChain, refetch: refetchHasReported } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'has_reported',
    args: [tokenId, userAddress],
    query: { enabled: !!userAddress && !!tokenId },
  });

  const currentEpoch = Number(reportEpochRaw ?? parsedMemorial?.report_epoch ?? 0);
  const reportWeight = Number(reportWeightRaw ?? parsedMemorial?.report_weight ?? 0);
  const userReportEpoch = Number(hasReportedOnChain || 0);

  const reportKey = userAddress && id != null
    ? `mc_reported_${userAddress.toLowerCase()}_${id}_epoch_${currentEpoch}`
    : null;

  // Keep localStorage updated if on-chain userReportEpoch confirms current epoch reporting
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage || !reportKey) return;
    if (userReportEpoch > currentEpoch && reportWeight > 0) {
      window.localStorage.setItem(reportKey, 'true');
    }
  }, [reportKey, userReportEpoch, currentEpoch, reportWeight]);

  // Strict personal report status (only true if userAddress has reported in current epoch AND on-chain report_weight > 0)
  const isLocallyReported = Boolean(
    reportKey &&
    typeof window !== 'undefined' &&
    window.localStorage &&
    window.localStorage.getItem(reportKey) === 'true'
  );

  const isReported = Boolean(
    userAddress &&
    id != null &&
    reportWeight > 0 &&
    (isLocallyReported || userReportEpoch > currentEpoch)
  );

  // Read candle expiry from contract
  const { data: candleExpiryRaw, refetch: refetchExpiry } = useReadContract({
    address: contractAddress, abi: CONTRACT_ABI, functionName: 'candle_expires_at', args: [tokenId],
  });
  const { data: totalCandlesRaw, refetch: refetchTotal } = useReadContract({
    address: contractAddress, abi: CONTRACT_ABI, functionName: 'total_candles_lit', args: [tokenId],
  });

  const now = Math.floor(Date.now() / 1000);
  const onchainExpiresAt = Number(candleExpiryRaw ?? parsedMemorial?.candle_expires_at ?? parsedMemorial?.candleExpiresAt ?? 0);
  const onchainTotal = Number(totalCandlesRaw ?? parsedMemorial?.total_candles_lit ?? parsedMemorial?.totalCandles ?? 0);

  // Local optimistic state for immediate feedback on candle lighting
  const [localExtraCandles, setLocalExtraCandles] = useState(0);
  const [localOptimisticExpiry, setLocalOptimisticExpiry] = useState(null);

  // Clean legacy candle and un-scoped / stale report keys from localStorage
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const keysToRemove = [];
      const prefix = userAddress && id != null ? `mc_reported_${userAddress.toLowerCase()}_${id}` : null;

      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key) continue;

        // Clean flat legacy keys: mc_reported_<userAddress>_<id> without epoch
        if (prefix && key === prefix) {
          keysToRemove.push(key);
        }

        // Clean stale epoch keys for this memorial (< currentEpoch or if reportWeight === 0)
        if (prefix && key.startsWith(`${prefix}_epoch_`)) {
          const match = key.match(/_epoch_(\d+)$/);
          if (match) {
            const savedEpoch = Number(match[1]);
            if (savedEpoch < currentEpoch || reportWeight === 0) {
              keysToRemove.push(key);
            }
          }
        }

        // Clean legacy candle and invalid report keys
        if (
          key.startsWith('mc_candles_') ||
          key.startsWith('mc_active_') ||
          (key.startsWith('mc_reported_') && !key.startsWith('mc_reported_0x'))
        ) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => window.localStorage.removeItem(k));
    } catch (e) {
      console.warn('Storage cleanup warning:', e);
    }
  }, [userAddress, id, currentEpoch, reportWeight]);

  // When on-chain total increases (tx mined and refetched), clear optimistic extra
  const lastOnchainTotalRef = useRef(onchainTotal);
  useEffect(() => {
    if (onchainTotal > lastOnchainTotalRef.current) {
      setLocalExtraCandles(0);
      setLocalOptimisticExpiry(null);
      lastOnchainTotalRef.current = onchainTotal;
    }
  }, [onchainTotal]);

  const totalCandles = onchainTotal + localExtraCandles;
  const candleExpiresAt = localOptimisticExpiry !== null
    ? Math.max(onchainExpiresAt, localOptimisticExpiry)
    : onchainExpiresAt;
  const expiryTimestamp = candleExpiresAt;
  const isBurning = candleExpiresAt > now;

  const handleCandleLit = (tierOrDuration = 1) => {
    const currentNow = Math.floor(Date.now() / 1000);
    const tierDurations = { 1: 3600, 2: 18000, 3: 43200, 4: 86400 };
    const duration = typeof tierOrDuration === 'number' && tierDurations[tierOrDuration]
      ? tierDurations[tierOrDuration]
      : (typeof tierOrDuration === 'number' && tierOrDuration > 86400 ? tierOrDuration : 3600);

    const baseStart = (localOptimisticExpiry && localOptimisticExpiry > currentNow)
      ? localOptimisticExpiry
      : (onchainExpiresAt > currentNow ? onchainExpiresAt : currentNow);
    const nextExpiry = baseStart + duration;

    setLocalExtraCandles((prev) => prev + 1);
    setLocalOptimisticExpiry(nextExpiry);

    refetchExpiry();
    refetchTotal();
  };

  // 🕯️ DEBUG: log candle state whenever it changes
  useEffect(() => {
    console.log('🕯️ DEBUG CANDLE:');
    console.log('  - Memorial ID:', id);
    console.log('  - contractAddress:', contractAddress);
    console.log('  - On-Chain expiresAt (raw):', candleExpiryRaw?.toString());
    console.log('  - On-Chain expiresAt (seconds):', candleExpiresAt);
    console.log('  - Expiry Timestamp:', expiryTimestamp);
    console.log('  - On-Chain expiresAt (date):', candleExpiresAt > 0 ? new Date(candleExpiresAt * 1000).toISOString() : 'never');
    console.log('  - Current Client Time (seconds):', now);
    console.log('  - Is Burning Result:', isBurning);
    console.log('  - Total Candles Lit:', totalCandles);
  }, [candleExpiryRaw, totalCandlesRaw, totalCandles, isBurning, now, candleExpiresAt, expiryTimestamp, contractAddress, id]);

  // Fetch Arweave metadata JSON
  useEffect(() => {
    if (!parsedMemorial?.arweaveUri) return;
    const txId = parsedMemorial.arweaveUri;
    fetch(getArweaveUrl(txId))
      .then(r => r.ok ? r.json() : null)
      .then(json => json && setMetadata(json))
      .catch(() => {});
  }, [parsedMemorial?.arweaveUri]);

  if (isLoading) {
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] animate-pulse">
        <div className="max-w-2xl mx-auto px-6 md:px-0 space-y-6">
          <div className="w-48 h-48 rounded-full bg-[#efeeeb] mx-auto" />
          <div className="h-10 bg-[#efeeeb] rounded w-1/2 mx-auto" />
          <div className="h-4 bg-[#efeeeb] rounded w-1/3 mx-auto" />
        </div>
      </div>
    );
  }

  if (!parsedMemorial) {
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="text-center space-y-4">
          <span className="material-symbols-outlined text-5xl text-[#d8c2ba]">help_outline</span>
          <h2 className="text-2xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>Memorial Not Found</h2>
          <Link to="/" className="inline-block text-[#8a4f36] text-sm hover:underline">← Back to Gallery</Link>
        </div>
      </div>
    );
  }

  const { owner, arweaveUri: arweaveTxId, petName, createdAt } = parsedMemorial;

  const handleShare = () => {
    setShowShareModal(true);
  };

  // Resolve image: handle ar:// URI scheme from production mints
  const rawImage = metadata?.image || '';
  const imageUrl = rawImage.startsWith('ar://')
    ? `https://arweave.net/${rawImage.slice(5)}`
    : rawImage;

  // description covers "A Brief Memory" form field; fall back to epitaph alias
  const description = metadata?.description || metadata?.epitaph || '';
  const attributes  = metadata?.attributes  || [];
  const findAttr    = (trait) => attributes.find(a => a.trait_type === trait)?.value;

  const formatDate = (val) => {
    if (!val) return null;
    const ms = typeof val === 'number' && val < 1e12 ? val * 1000 : Number(val);
    return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  const birthDate    = findAttr('Birth Date');
  const memorialDate = findAttr('Memorial Date');
  const speciesVal   = findAttr('Species');
  const breedVal     = findAttr('Breed');

  // Fix #3: check top-level fields first (written by new buildNftMetadata),
  // then fall back to attributes array for older mints
  const birthYear   = metadata?.birth_year   || findAttr('Birth Year')
    || (birthDate ? new Date(Number(birthDate) < 1e12 ? birthDate * 1000 : birthDate).getFullYear() : null);
  const passingYear = metadata?.passing_year || findAttr('Passing Year')
    || (memorialDate ? new Date(Number(memorialDate) < 1e12 ? memorialDate * 1000 : memorialDate).getFullYear() : null);

  const dateDisplay = (birthYear && passingYear)
    ? `${birthYear} – ${passingYear}`
    : (createdAt ? formatDate(Number(createdAt)) : 'Date unknown');

  const avatarGlowClass = isBurning
    ? 'border-amber-500/50 shadow-[0_0_30px_rgba(245,158,11,0.35)] animate-[avatarCandleGlow_4s_ease-in-out_infinite]'
    : 'border-surface shadow-[0_8px_30px_rgb(0,0,0,0.12)]';

  return (
    <div className="pt-20 sm:pt-24 md:pt-32 pb-12 md:pb-16 min-h-screen bg-[#fbf9f6]">
      <main className="flex-grow flex flex-col items-center px-4 w-full max-w-7xl mx-auto">

        {/* Council Ban Banner */}
        {parsedMemorial?.isBanned && (
          <div className="order-0 md:order-0 w-full max-w-2xl bg-red-50 border border-red-300 rounded-xl md:rounded-2xl p-3 md:p-4 mb-3 md:mb-6 text-center text-red-800 text-[11px] md:text-xs font-semibold flex items-center justify-center gap-2 shadow-sm">
            <span className="material-symbols-outlined text-red-600 text-base">block</span>
            This memorial has been suspended by Council moderation.
          </div>
        )}

        {/* Under Review Banner */}
        {isFlagged && (
          <div className="order-0 md:order-0 w-full max-w-2xl bg-amber-50 border border-amber-300 rounded-xl md:rounded-2xl p-3 md:p-4 mb-3 md:mb-6 text-center text-amber-800 text-[11px] md:text-xs font-semibold flex items-center justify-center gap-2 shadow-sm">
            <span className="material-symbols-outlined text-amber-600 text-base">warning</span>
            This memorial has been reported and is currently under community moderation review.
          </div>
        )}

        {/* Private / Unlisted Banner */}
        {parsedMemorial?.isPublic === false && (
          <div className="order-0 md:order-0 w-full max-w-2xl bg-stone-100/90 border border-stone-300 rounded-xl md:rounded-2xl p-2.5 md:p-3.5 mb-3 md:mb-6 text-center text-stone-700 text-[11px] md:text-xs font-semibold flex items-center justify-center gap-2 shadow-xs">
            <span className="material-symbols-outlined text-stone-600 text-base">lock</span>
            <span>Private / Unlisted Memorial (Hidden from public gallery)</span>
          </div>
        )}

        {/* Portrait & Header (Mobile: order-1, Desktop: order-1) */}
        <div className="order-1 md:order-1 flex flex-col items-center text-center space-y-2.5 sm:space-y-3 md:space-y-6 w-full max-w-2xl mx-auto mb-3 sm:mb-4 md:mb-8">
          <div className={`relative w-32 h-32 sm:w-36 sm:h-36 md:w-64 md:h-64 lg:w-72 lg:h-72 rounded-full overflow-hidden border-[3px] md:border-4 mx-auto transition-all duration-700 ${avatarGlowClass}`}>
            <img 
              alt={petName ? `Memorial for ${petName}` : 'Pet portrait'} 
              className="w-full h-full object-cover" 
              src={imageUrl || 'https://images.unsplash.com/photo-1544568100-847a948585b9?auto=format&fit=crop&w=800&q=80'}
              onError={(e) => { e.currentTarget.src = 'https://images.unsplash.com/photo-1544568100-847a948585b9?auto=format&fit=crop&w=800&q=80'; }}
            />
          </div>
          <div className="space-y-1 md:space-y-2">
            <h1 className="font-display-lg-mobile md:font-display-lg text-2xl sm:text-3xl md:text-display-lg text-[#2C2520] tracking-tight">
              {petName}
            </h1>
            <p className="font-label-md text-[11px] md:text-label-md text-[#5A5047] uppercase tracking-wider">
              {dateDisplay}
            </p>
            <div className="flex flex-wrap justify-center items-center gap-1.5 md:gap-2 pt-1 md:pt-3">
              {speciesVal ? (
                <span className="px-3 py-0.5 md:px-4 md:py-1 rounded-full bg-secondary-container text-on-secondary-container font-label-bold text-[10px] md:text-[11px] uppercase tracking-wider">
                  {speciesVal}
                </span>
              ) : (
                <span className="px-3 py-0.5 md:px-4 md:py-1 rounded-full bg-secondary-container text-on-secondary-container font-label-bold text-[10px] md:text-[11px] uppercase tracking-wider">
                  Companion
                </span>
              )}
              {breedVal && (
                <span className="px-3 py-0.5 md:px-4 md:py-1 rounded-full bg-secondary-container text-on-secondary-container font-label-bold text-[10px] md:text-[11px] uppercase tracking-wider">
                  {breedVal}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Sacred Flame Alcove & Collective Altar (Mobile: order-2, Desktop: order-3) ──────────── */}
        <div className="order-2 md:order-3 w-full max-w-md mx-auto mb-5 sm:mb-6 md:mb-16 flex flex-col items-center">
          {isBurning ? (
            <div
              className="relative w-full rounded-2xl md:rounded-3xl px-4 py-4 sm:px-5 sm:py-5 md:px-6 md:py-6 flex flex-col items-center animate-[alcoveBreath_5s_ease-in-out_infinite]"
              style={{
                background: 'radial-gradient(circle at 50% 32%, rgba(251,191,36,0.22) 0%, rgba(245,158,11,0.08) 42%, rgba(250,247,242,0) 72%)',
                border: '1px solid rgba(245,158,11,0.28)',
                boxShadow: '0 0 28px rgba(245,158,11,0.2), inset 0 0 16px rgba(245,158,11,0.08)',
              }}
            >
              {/* Central flame enlarged with warm radiant diffusion */}
              <div className="relative flex items-center justify-center my-0.5 md:my-1 transform scale-110 md:scale-125">
                <div
                  className="absolute w-24 h-24 rounded-full pointer-events-none"
                  style={{
                    background: 'radial-gradient(circle, rgba(251,191,36,0.45) 0%, rgba(245,158,11,0.2) 45%, transparent 70%)',
                    filter: 'blur(6px)',
                  }}
                />
                <Candle petName={petName} showCaption={false} />
              </div>

              <p
                className="mt-1 text-xs md:text-sm text-[#8A7A6E] italic text-center leading-relaxed"
                style={{ fontFamily: "'Libre Caslon Text', 'Georgia', serif" }}
              >
                This candle is burning for {petName || 'this beautiful soul'}.
              </p>

              <div className="mt-2 md:mt-3 bg-[#F5efe6]/80 px-3 py-1 md:px-4 md:py-1.5 rounded-full border border-[#E9dfd3]/80">
                <p className="text-[11px] md:text-xs text-[#5A5047]">
                  The flame burns until <span className="font-semibold">{formatDate(candleExpiresAt)}</span>
                </p>
              </div>

              {parsedMemorial?.isBanned ? (
                <div className="mt-3 md:mt-4 text-center p-2.5 md:p-3 bg-red-50 text-red-700 text-xs font-bold rounded-xl border border-red-200 shadow-sm w-full max-w-xs">
                  🔒 Candle lighting is disabled for suspended memorials.
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleIgniteClick}
                  className="mt-3 md:mt-4 w-full max-w-xs bg-gradient-to-r from-[#D48C6F] to-[#c07a5d] text-white px-5 py-2.5 md:px-6 md:py-3 rounded-xl md:rounded-2xl font-bold text-xs md:text-sm uppercase tracking-widest hover:shadow-[0_4px_16px_rgba(212,140,111,0.4)] transition-all transform hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
                >
                  Keep the Flame Alive
                </button>
              )}

              {/* ── Integrated Collective Altar ──────────────────── */}
              <div className="w-full border-t border-amber-900/10 my-3 md:my-4 pt-2.5 md:pt-3">
                <CandleAltar totalCandles={totalCandles} expiryTimestamp={expiryTimestamp} isBurning={true} />
              </div>
            </div>
          ) : (
            <div
              className="relative w-full rounded-2xl md:rounded-3xl px-4 py-4 sm:px-5 sm:py-5 md:px-6 md:py-6 flex flex-col items-center"
              style={{
                background: 'radial-gradient(circle at 50% 32%, rgba(200,180,160,0.12) 0%, rgba(250,247,242,0) 70%)',
                border: '1px solid rgba(180,160,140,0.2)',
              }}
            >
              <div className="w-10 h-10 md:w-14 md:h-14 rounded-full bg-[#F5efe6] flex items-center justify-center mb-2 md:mb-3">
                <span className="material-symbols-outlined text-xl md:text-2xl text-[#b5a79a]" style={{ fontVariationSettings: "'FILL' 0" }}>local_fire_department</span>
              </div>
              <h3
                className="text-base md:text-lg text-[#2C2520] mb-0.5 md:mb-1"
                style={{ fontFamily: "'Libre Caslon Text', serif" }}
              >
                The Flame Has Faded
              </h3>
              <p className="text-[11px] md:text-xs text-[#8A7A6E] max-w-xs text-center leading-relaxed mb-3 md:mb-4">
                Light a virtual candle to keep {petName}&apos;s memory shining brightly.
              </p>

              {parsedMemorial?.isBanned ? (
                <div className="text-center p-2.5 md:p-3 bg-red-50 text-red-700 text-xs font-bold rounded-xl border border-red-200 shadow-sm w-full max-w-xs">
                  🔒 Candle lighting is disabled for suspended memorials.
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleIgniteClick}
                  className="w-full max-w-xs bg-gradient-to-r from-[#D48C6F] to-[#c07a5d] text-white px-5 py-2.5 md:px-6 md:py-3.5 rounded-xl md:rounded-2xl font-bold text-xs md:text-sm uppercase tracking-widest hover:shadow-[0_4px_16px_rgba(212,140,111,0.4)] transition-all transform hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
                >
                  Ignite Memory
                </button>
              )}

              {/* ── Integrated Collective Altar ──────────────────── */}
              <div className="w-full border-t border-amber-900/10 my-3 md:my-4 pt-2.5 md:pt-3">
                <CandleAltar totalCandles={totalCandles} expiryTimestamp={0} isBurning={false} />
              </div>
            </div>
          )}
        </div>

        {/* Bio / Memory Narrative (Mobile: order-3, Desktop: order-2) */}
        {description && (
          <div className="order-3 md:order-2 w-full max-w-2xl mx-auto bg-surface p-5 sm:p-6 md:p-10 rounded-[20px] md:rounded-[24px] border border-outline-variant/20 shadow-sm text-center mb-6 md:mb-12">
            <div
              className="text-4xl md:text-6xl leading-none text-[#d8c2ba] opacity-70 select-none mb-0.5 md:mb-1"
              style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
              aria-hidden="true"
            >
              &ldquo;
            </div>
            <p className="font-body-lg text-sm sm:text-base md:text-body-lg text-on-surface leading-relaxed italic" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
              {description}
            </p>
          </div>
        )}

        {/* Footer Actions (Mobile: order-4, Desktop: order-4) */}
        <div className="order-4 md:order-4 w-full max-w-2xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6 pt-6 md:pt-8 border-t border-outline-variant/20">
          <div className="flex items-start space-x-3 text-left">
            <div className="mt-1">
              <span className="material-symbols-outlined text-primary">link</span>
            </div>
            <div>
              <p className="font-label-md text-label-md text-primary uppercase tracking-wider mb-1">Eternal Provenance</p>
              <p className="font-body-sm text-body-sm text-[#5A5047]">Secured forever on Arweave network.</p>
              {arweaveTxId && (
                <p className="font-body-sm text-body-sm text-[#5A5047] font-mono mt-1 text-xs">
                  Decentralized Ledger ID: <a href={getArweaveUrl(arweaveTxId)} target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">{arweaveTxId.slice(0, 10)}…{arweaveTxId.slice(-6)}</a>
                </p>
              )}
              {owner && (
                <p className="font-body-sm text-body-sm text-[#5A5047] font-mono mt-1 text-xs">
                  Owner: <a href={`${explorerUrl}/address/${owner}`} target="_blank" rel="noopener noreferrer" className="hover:text-primary transition-colors">{owner.slice(0, 8)}…{owner.slice(-6)}</a>
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={handleShare}
              className="flex flex-col items-center group cursor-pointer border-0 bg-transparent outline-none"
            >
              <div className="w-16 h-16 bg-[#F5efe6] p-1 rounded-[16px] border border-[#E9dfd3] shadow-sm flex items-center justify-center group-hover:bg-[#ebdcd0] transition-colors">
                <span className="material-symbols-outlined text-3xl text-[#5A5047] group-hover:text-[#8a4f36] transition-colors">share</span>
              </div>
              <span className="font-label-md text-label-md text-[#5A5047] group-hover:text-[#8a4f36] mt-2 uppercase tracking-wider transition-colors text-xs">Share</span>
            </button>

            {!isOwner && (
              isReported ? (
                <div className="flex flex-col items-center cursor-default opacity-80" title="You have reported this memorial">
                  <div className="w-16 h-16 bg-[#f0ede8] p-1 rounded-[16px] border border-[#d8c2ba] shadow-sm flex items-center justify-center text-[#8a7a6e]">
                    <span className="material-symbols-outlined text-3xl">check</span>
                  </div>
                  <span className="font-label-md text-label-md text-[#8a7a6e] mt-2 uppercase tracking-wider text-xs">
                    Reported
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (parsedMemorial?.isBanned) return;
                    setShowReportModal(true);
                  }}
                  disabled={parsedMemorial?.isBanned}
                  title={parsedMemorial?.isBanned ? 'Memorial is already banned' : 'Report memorial'}
                  className={`flex flex-col items-center group border-0 bg-transparent outline-none ${parsedMemorial?.isBanned ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <div className="w-16 h-16 bg-[#F5efe6] p-1 rounded-[16px] border border-[#E9dfd3] shadow-sm flex items-center justify-center group-hover:bg-[#ebdcd0] transition-colors">
                    <span className="material-symbols-outlined text-3xl text-amber-700 group-hover:text-amber-800 transition-colors">flag</span>
                  </div>
                  <span className="font-label-md text-label-md text-[#5A5047] group-hover:text-[#8a4f36] mt-2 uppercase tracking-wider transition-colors text-xs">
                    {parsedMemorial?.isBanned ? 'Banned' : 'Report'}
                  </span>
                </button>
              )
            )}
          </div>
        </div>
      </main>

      {/* Candle Modal */}
      <LightCandleModal
        isOpen={showCandleModal}
        onClose={() => setShowCandleModal(false)}
        memorialId={id}
        petName={petName}
        onSuccess={handleCandleLit}
        currentExpiry={expiryTimestamp}
      />

      {/* Report Modal */}
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        memorialId={id}
        petName={petName}
        ownerAddress={parsedMemorial?.owner}
        epoch={currentEpoch}
        reportWeight={reportWeight}
        onSuccess={() => {
          setReportRefreshTrigger((p) => p + 1);
          refetchHasReported();
          refetchReportEpoch();
          refetchReportWeight();
          if (refetchFlagged) refetchFlagged();
        }}
      />

      {/* Share Modal */}
      <ShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        petName={petName}
        memorialId={id}
        url={typeof window !== 'undefined' ? window.location.href : ''}
      />

      <style>{`
        @keyframes pulse-shadow {
          0%, 100% { box-shadow: 0 0 20px 5px rgba(251, 146, 60, 0.1); }
          50% { box-shadow: 0 0 35px 10px rgba(251, 146, 60, 0.25); }
        }
        @keyframes alcoveBreath {
          0%, 100% {
            box-shadow: 0 0 25px rgba(245, 158, 11, 0.18), inset 0 0 15px rgba(245, 158, 11, 0.06);
            border-color: rgba(245, 158, 11, 0.22);
          }
          50% {
            box-shadow: 0 0 35px rgba(245, 158, 11, 0.32), inset 0 0 22px rgba(245, 158, 11, 0.12);
            border-color: rgba(245, 158, 11, 0.38);
          }
        }
        @keyframes flameFloat {
          0%, 100% {
            transform: translateY(0);
            opacity: 0.92;
          }
          50% {
            transform: translateY(-2.5px);
            opacity: 1;
          }
        }
        @keyframes avatarCandleGlow {
          0%, 100% {
            box-shadow: 0 0 22px 2px rgba(245, 158, 11, 0.3), 0 0 45px 6px rgba(251, 191, 36, 0.18);
            border-color: rgba(245, 158, 11, 0.5);
          }
          50% {
            box-shadow: 0 0 36px 6px rgba(245, 158, 11, 0.48), 0 0 60px 10px rgba(251, 191, 36, 0.28);
            border-color: rgba(245, 158, 11, 0.8);
          }
        }
      `}</style>
    </div>
  );
}
