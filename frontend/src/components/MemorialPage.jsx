import { useParams, Link } from 'react-router-dom';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useReadContract, useChainId } from 'wagmi';
import { useState, useEffect, useRef } from 'react';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress, getExplorerUrl } from '../config/chains';
import { getArweaveUrl, isMockTxId, TESTNET_TEMPORARY_STORAGE_NOTICE } from '../utils/arweave';
import Candle from './Candle';
import CandleAltar from './CandleAltar';
import LightCandleModal from './LightCandleModal';
import ReportModal from './ReportModal';
import ShareModal from './ShareModal';
import { parseMemorial } from '../utils/memorialParser';

/**
 * Classic memorial arch radii.
 * Tailwind's `rounded-t-full rounded-b-*` cannot be used here: CSS scales ALL corner
 * radii down proportionally when adjacent radii exceed the box size, which collapses
 * the soft bottom corners to ~0px. Explicit elliptical radii avoid that scaling.
 * With a 4:5 frame, 50% horizontal / 40% vertical produces a true semicircular vault.
 */
const ARCH_OUTER_RADIUS = '50% 50% 1rem 1rem / 40% 40% 1rem 1rem';
const ARCH_INNER_RADIUS = '50% 50% 0.75rem 0.75rem / 40% 40% 0.75rem 0.75rem';

const FALLBACK_PORTRAIT = 'https://images.unsplash.com/photo-1544568100-847a948585b9?auto=format&fit=crop&w=800&q=80';

// Placeholder values entered in the creation form that must never be displayed.
const EMPTY_TRAIT_VALUES = new Set(['', 'no', 'none', 'n/a', 'na', 'unknown', '-', '—', 'null', 'undefined']);
const cleanTrait = (value) => {
  const text = String(value ?? '').trim();
  return EMPTY_TRAIT_VALUES.has(text.toLowerCase()) ? '' : text;
};

/**
 * Human-friendly flame expiry label.
 *  - < 24h left: "Oct 23, 16:14 (48m left)" (exact time + remaining hours/minutes)
 *  - >= 24h left: "Oct 25, 2026, 15:00"
 * 24-hour clock (`h23`) avoids the "24:00" quirk of `hour12: false`.
 */
function formatFlameExpiry(expiresAtSec, nowSec) {
  const expiresMs = Number(expiresAtSec) * 1000;
  if (!Number.isFinite(expiresMs) || expiresMs <= 0) return '';
  const secondsLeft = Math.max(0, Number(expiresAtSec) - nowSec);
  const timeOpts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const expiryDate = new Date(expiresMs);

  if (secondsLeft >= 86400) {
    return expiryDate.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...timeOpts });
  }

  const hours = Math.floor(secondsLeft / 3600);
  const minutes = Math.floor((secondsLeft % 3600) / 60);
  const left = hours > 0 ? `${hours}h ${minutes}m left` : minutes > 0 ? `${minutes}m left` : '<1m left';
  const when = expiryDate.toLocaleString('en-US', { month: 'short', day: 'numeric', ...timeOpts });
  return `${when} (${left})`;
}

/** Multi-layer solid filled candle flame tongue inside the arch base medallion (no hollow center). */
function MedallionFlame() {
  return (
    <svg
      width="22"
      height="30"
      viewBox="0 0 22 30"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className="relative z-10 animate-[medallionFlameFlicker_2.6s_ease-in-out_infinite]"
      style={{ filter: 'drop-shadow(0 0 6px rgba(245, 158, 11, 0.75))' }}
    >
      {/* 1. Outer layer: soft amber-orange (#F59E0B) with organic flame tongue tip */}
      <path
        d="M12.2 1.2C14.9 5.9 19.2 12.4 19.2 19.1C19.2 24.3 15.6 28.2 11 28.2C6.4 28.2 2.8 24.3 2.8 19.1C2.8 12.1 8.1 6.6 12.2 1.2Z"
        fill="#F59E0B"
      />
      {/* 2. Middle layer: solid golden-yellow (#FBBF24) filling the flame body */}
      <path
        d="M11.6 6.4C13.7 10.2 16.6 14.9 16.6 19.9C16.6 23.9 14.2 27.0 11 27.0C7.8 27.0 5.4 23.9 5.4 19.9C5.4 14.6 9.1 10.6 11.6 6.4Z"
        fill="#FBBF24"
      />
      {/* 3. Inner glowing core at the base: warm white light (#FEF3C7) */}
      <path
        d="M11 15.0C12.3 17.4 13.6 20.0 13.6 22.6C13.6 24.9 12.5 26.5 11 26.5C9.5 26.5 8.4 24.9 8.4 22.6C8.4 20.0 9.7 17.4 11 15.0Z"
        fill="#FEF3C7"
      />
    </svg>
  );
}

/** Multi-layer solid filled mini flame glyph used inside the compact mobile tribute box. */
function MiniFlame({ delay = 0, unlit = false }) {
  if (unlit) {
    return (
      <svg width="13" height="18" viewBox="0 0 22 30" fill="none" aria-hidden="true" className="shrink-0 text-[#b5a79a]">
        <path
          d="M12.2 1.8C14.8 6.3 18.8 12.5 18.8 19.0C18.8 24.0 15.3 27.8 11 27.8C6.7 27.8 3.2 24.0 3.2 19.0C3.2 12.2 8.2 6.9 12.2 1.8Z"
          stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2" fill="currentColor" fillOpacity="0.08"
        />
      </svg>
    );
  }
  return (
    <svg
      width="13" height="18" viewBox="0 0 22 30" fill="none" aria-hidden="true"
      className="shrink-0 animate-[flameFloat_3s_ease-in-out_infinite]"
      style={{ filter: 'drop-shadow(0 0 3px rgba(245,158,11,0.55))', animationDelay: `${delay}s` }}
    >
      {/* 1. Outer layer: soft amber-orange (#F59E0B) */}
      <path
        d="M12.2 1.2C14.9 5.9 19.2 12.4 19.2 19.1C19.2 24.3 15.6 28.2 11 28.2C6.4 28.2 2.8 24.3 2.8 19.1C2.8 12.1 8.1 6.6 12.2 1.2Z"
        fill="#F59E0B"
      />
      {/* 2. Middle layer: solid golden-yellow (#FBBF24) */}
      <path
        d="M11.6 6.4C13.7 10.2 16.6 14.9 16.6 19.9C16.6 23.9 14.2 27.0 11 27.0C7.8 27.0 5.4 23.9 5.4 19.9C5.4 14.6 9.1 10.6 11.6 6.4Z"
        fill="#FBBF24"
      />
      {/* 3. Inner glowing core at the base: warm white light (#FEF3C7) */}
      <path
        d="M11 15.0C12.3 17.4 13.6 20.0 13.6 22.6C13.6 24.9 12.5 26.5 11 26.5C9.5 26.5 8.4 24.9 8.4 22.6C8.4 20.0 9.7 17.4 11 15.0Z"
        fill="#FEF3C7"
      />
    </svg>
  );
}

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

  // Live clock: re-rendering on every tick is what lets an expired flame go out without a manual page reload.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const interval = setInterval(tick, 15000);
    // Browsers heavily throttle timers in background tabs — resync immediately when the user returns.
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

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

  // Exact-moment extinguish: besides the 15s ticker, schedule a one-shot timer for the expiry second
  // so the flame goes out right when the time runs out rather than up to 15s later.
  useEffect(() => {
    if (!(candleExpiresAt > 0)) return undefined;
    const msLeft = (candleExpiresAt - Math.floor(Date.now() / 1000)) * 1000;
    if (msLeft <= 0) return undefined;
    // setTimeout overflows above ~24.8 days; the 15s ticker covers anything longer.
    const timeout = setTimeout(
      () => setNow(Math.floor(Date.now() / 1000)),
      Math.min(msLeft + 500, 2147483647)
    );
    return () => clearTimeout(timeout);
  }, [candleExpiresAt]);

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
      <div className="pt-[4.5rem] sm:pt-24 md:pt-32 pb-12 md:pb-16 min-h-screen bg-[#fbf9f6] animate-pulse">
        <div className="max-w-2xl mx-auto px-6 md:px-0 space-y-4 md:space-y-6">
          <div
            className="h-[min(18rem,40vh)] sm:h-[min(20rem,44vh)] md:h-80 aspect-[4/5] bg-[#efeeeb] mx-auto"
            style={{ borderRadius: ARCH_OUTER_RADIUS }}
          />
          <div className="h-8 md:h-10 bg-[#efeeeb] rounded w-1/2 mx-auto" />
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

  const attributes  = metadata?.attributes  || [];
  const findAttr    = (trait) => attributes.find(a => a.trait_type === trait)?.value;

  // Strict priority for user-entered epitaph/bio/message over the generic fallback or technical testnet notice
  const isTechnicalNotice = (val) => {
    const t = String(val ?? '').trim();
    return (
      !t ||
      t.startsWith('This memorial was created on testnet with temporary storage') ||
      t === 'Metadata temporarily unavailable'
    );
  };

  const defaultFallbackEpitaph = `In loving memory of ${petName || 'this beloved companion'}. Forever on the blockchain.`;
  const isGenericFallback = (val) =>
    String(val ?? '').trim().toLowerCase() === defaultFallbackEpitaph.toLowerCase();

  let localSavedEpitaph = '';
  if (typeof window !== 'undefined' && window.localStorage && petName) {
    try {
      localSavedEpitaph = window.localStorage.getItem(`mc_epitaph_${String(petName).trim().toLowerCase()}`) || '';
    } catch {
      localSavedEpitaph = '';
    }
  }

  const candidateEpitaphs = [
    metadata?.bio,
    metadata?.epitaph,
    metadata?.message,
    metadata?.story,
    findAttr('Epitaph'),
    findAttr('Bio'),
    findAttr('Story'),
    metadata?.description,
    localSavedEpitaph,
  ]
    .map((v) => String(v ?? '').trim())
    .filter((v) => !isTechnicalNotice(v));

  // 1. Prefer custom user-entered text (distinct from the generic fallback)
  // 2. Otherwise use any non-technical text in metadata
  // 3. Otherwise use the generic fallback
  const customUserEpitaph = candidateEpitaphs.find((v) => !isGenericFallback(v));
  const description = customUserEpitaph || candidateEpitaphs[0] || defaultFallbackEpitaph;

  const rawDescCheck = String(metadata?.description || metadata?.epitaph || '').trim();
  const isTestnetTemporaryStorage =
    isMockTxId(arweaveTxId) ||
    Boolean(metadata?.isTemporaryStoragePlaceholder) ||
    rawDescCheck.startsWith('This memorial was created on testnet with temporary storage');

  const birthDate    = findAttr('Birth Date');
  const memorialDate = findAttr('Memorial Date');
  // Placeholder answers ("no", "none", "n/a", ...) are filtered out entirely
  const breedVal     = cleanTrait(metadata?.breed || findAttr('Breed'));

  // Fix #3: check top-level fields first (written by new buildNftMetadata),
  // then fall back to attributes array for older mints
  const birthYear   = metadata?.birth_year   || findAttr('Birth Year')
    || (birthDate ? new Date(Number(birthDate) < 1e12 ? birthDate * 1000 : birthDate).getFullYear() : null);
  const passingYear = metadata?.passing_year || findAttr('Passing Year')
    || (memorialDate ? new Date(Number(memorialDate) < 1e12 ? memorialDate * 1000 : memorialDate).getFullYear() : null);

  const formatShortDate = (val) => {
    const ms = Number(val) < 1e12 ? Number(val) * 1000 : Number(val);
    return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const dateDisplay = (birthYear && passingYear)
    ? `${birthYear} – ${passingYear}`
    : (createdAt ? formatShortDate(createdAt) : '');

  // Single elegant subtitle line: "Golden Retriever • 2025 – 2026" / "Beloved Companion • Oct 5, 2026"
  const lineage = breedVal || 'Beloved Companion';

  const archGlowClass = isBurning
    ? 'shadow-[0_12px_45px_rgba(245,158,11,0.3)] animate-[archCandleGlow_4s_ease-in-out_infinite]'
    : 'shadow-[0_10px_30px_rgba(60,40,20,0.12)]';

  // Compact mobile tribute box copy
  const candlesCount = totalCandles;
  const candleWord = candlesCount === 1 ? 'candle' : 'candles';
  const tributeHeadline = isBurning
    ? `${candlesCount} ${candleWord} burning in loving memory`
    : candlesCount > 0
      ? `${candlesCount} ${candleWord} lit in loving memory`
      : 'Be the first to light a candle';
  const tributeSubline = isBurning
    ? `Flame active until ${formatFlameExpiry(candleExpiresAt, now)}`
    : 'The flame is resting';

  return (
    <div className="pt-[4.5rem] sm:pt-24 md:pt-32 pb-12 md:pb-16 min-h-screen bg-[#fbf9f6]">
      <main className="flex-grow flex flex-col items-center gap-3 sm:gap-4 md:gap-6 px-4 w-full max-w-7xl mx-auto">

        {/* Council Ban Banner */}
        {parsedMemorial?.isBanned && (
          <div className="order-0 md:order-0 w-full max-w-2xl bg-red-50 border border-red-300 rounded-xl md:rounded-2xl p-2.5 md:p-4 text-center text-red-800 text-[11px] md:text-xs font-semibold flex items-center justify-center gap-2 shadow-sm">
            <span className="material-symbols-outlined text-red-600 text-base">block</span>
            This memorial has been suspended by Council moderation.
          </div>
        )}

        {/* Under Review Banner */}
        {isFlagged && (
          <div className="order-0 md:order-0 w-full max-w-2xl bg-amber-50 border border-amber-300 rounded-xl md:rounded-2xl p-2.5 md:p-4 text-center text-amber-800 text-[11px] md:text-xs font-semibold flex items-center justify-center gap-2 shadow-sm">
            <span className="material-symbols-outlined text-amber-600 text-base">warning</span>
            This memorial has been reported and is currently under community moderation review.
          </div>
        )}

        {/* Private / Unlisted Compact Capsule */}
        {parsedMemorial?.isPublic === false && (
          <div className="order-0 md:order-0 inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-amber-950/5 border border-amber-900/10 text-xs text-stone-600 mb-2">
            <span aria-hidden="true">🔒</span>
            <span>Private Memorial · Hidden from public gallery</span>
          </div>
        )}

        {/* Memorial Arch Portrait, Altar Flame & Header (Mobile: order-1, Desktop: order-1) */}
        <div className="order-1 md:order-1 flex flex-col items-center text-center w-full max-w-2xl mx-auto md:mb-4">
          {/* Double-framed classic memorial arch */}
          <div
            className={`relative h-[min(18rem,40vh)] sm:h-[min(20rem,44vh)] md:h-80 aspect-[4/5] p-1.5 bg-gradient-to-b from-amber-200/50 via-amber-100/20 to-amber-500/30 border border-amber-500/35 transition-shadow duration-700 ${archGlowClass}`}
            style={{ borderRadius: ARCH_OUTER_RADIUS }}
          >
            <div className="relative w-full h-full overflow-hidden" style={{ borderRadius: ARCH_INNER_RADIUS }}>
              <img
                alt={petName ? `Memorial for ${petName}` : 'Pet portrait'}
                className="w-full h-full object-cover"
                src={imageUrl || FALLBACK_PORTRAIT}
                onError={(e) => { e.currentTarget.src = FALLBACK_PORTRAIT; }}
              />
              {/* Warm bottom-up vignette so the altar flame reads with depth */}
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-gradient-to-t from-amber-950/35 via-transparent to-transparent pointer-events-none"
              />
            </div>
          </div>

          {/* High-contrast medallion candle holder at the base of the arch */}
          {isBurning ? (
            <div
              className="w-12 h-12 rounded-full bg-[#FFFDF9] border-2 border-amber-400/80 shadow-[0_4px_20px_rgba(245,158,11,0.45)] flex items-center justify-center -mt-6 z-10 relative animate-[medallionPulse_3s_ease-in-out_infinite]"
              title={`Candle burning for ${petName || 'this beloved companion'}`}
            >
              <div
                aria-hidden="true"
                className="absolute -inset-2.5 bg-amber-400/25 blur-lg rounded-full pointer-events-none"
              />
              <MedallionFlame />
            </div>
          ) : (
            <div
              className="w-11 h-11 rounded-full bg-[#FFFDF9] border border-amber-900/15 shadow-sm flex items-center justify-center -mt-5 z-10 relative"
              title="The flame is resting"
            >
              <span className="material-symbols-outlined text-xl text-[#b5a79a]" style={{ fontVariationSettings: "'FILL' 0" }}>local_fire_department</span>
            </div>
          )}

          <h1
            className="mt-2 text-3xl sm:text-4xl md:text-display-lg font-serif tracking-wide md:tracking-normal text-[#2C2520] leading-tight"
            style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
          >
            {petName}
          </h1>
          <p className="mt-1 md:mt-2 text-[13px] md:text-sm text-[#6B5E54] tracking-wide">
            {lineage}
            {dateDisplay && (
              <>
                <span className="mx-2 text-amber-600/70" aria-hidden="true">•</span>
                {dateDisplay}
              </>
            )}
          </p>
        </div>

        {/* ── Compact Tribute Box (Mobile only: order-2) ──────────── */}
        <section
          aria-label="Candle tribute"
          className="order-2 md:hidden mt-1 px-4 py-3.5 rounded-2xl bg-amber-50/70 border border-amber-900/10 max-w-sm w-full mx-auto flex flex-col items-center text-center"
        >
          <div className="flex flex-col items-center w-full">
            {/* Row 1: centered row of up to 5 mini-flame icons (+N badge if > 5) */}
            <div className="flex items-center justify-center gap-1.5 mb-1.5">
              {isBurning && candlesCount > 0 ? (
                <>
                  {Array.from({ length: Math.min(candlesCount, 5) }).map((_, i) => (
                    <MiniFlame key={i} delay={i * 0.35} />
                  ))}
                  {candlesCount > 5 && (
                    <span className="text-xs font-medium text-amber-700 bg-amber-100/80 px-1.5 py-0.5 rounded-full">
                      +{candlesCount - 5}
                    </span>
                  )}
                </>
              ) : (
                <MiniFlame unlit />
              )}
            </div>

            {/* Row 2: centered candle count headline */}
            <p
              className="text-[13px] text-[#4A4038] leading-snug text-center"
              style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
            >
              {tributeHeadline}
            </p>

            {/* Row 3: centered active-until subtitle */}
            <p className="mt-0.5 text-[11px] text-[#8A7A6E] text-center">{tributeSubline}</p>
          </div>

          {parsedMemorial?.isBanned ? (
            <div className="mt-3 w-full text-center p-2.5 bg-red-50 text-red-700 text-xs font-bold rounded-xl border border-red-200">
              🔒 Candle lighting is disabled for suspended memorials.
            </div>
          ) : (
            <button
              type="button"
              onClick={handleIgniteClick}
              className="mt-3 w-full bg-gradient-to-r from-[#D48C6F] to-[#c07a5d] text-white py-2.5 rounded-xl font-bold text-xs uppercase tracking-widest shadow-[0_4px_14px_rgba(192,122,93,0.3)] active:scale-[0.98] transition-transform cursor-pointer"
            >
              {isBurning ? 'Keep the Flame Alive' : 'Light a Candle'}
            </button>
          )}
        </section>

        {/* ── Sacred Flame Alcove & Collective Altar (Desktop only: order-3) ──────────── */}
        <div className="hidden md:flex md:order-3 w-full max-w-md mx-auto md:mb-10 flex-col items-center">
          {isBurning ? (
            <div
              className="relative w-full rounded-2xl md:rounded-3xl px-4 py-3.5 sm:px-5 sm:py-4 md:px-6 md:py-6 flex flex-col items-center animate-[alcoveBreath_5s_ease-in-out_infinite]"
              style={{
                background: 'radial-gradient(circle at 50% 32%, rgba(251,191,36,0.22) 0%, rgba(245,158,11,0.08) 42%, rgba(250,247,242,0) 72%)',
                border: '1px solid rgba(245,158,11,0.28)',
                boxShadow: '0 0 28px rgba(245,158,11,0.2), inset 0 0 16px rgba(245,158,11,0.08)',
              }}
            >
              {/* Central flame enlarged with warm radiant diffusion */}
              <div className="relative flex items-center justify-center -my-1.5 sm:-my-1 md:my-1 transform scale-95 sm:scale-105 md:scale-125">
                <div
                  className="absolute w-20 h-20 md:w-24 md:h-24 rounded-full pointer-events-none"
                  style={{
                    background: 'radial-gradient(circle, rgba(251,191,36,0.45) 0%, rgba(245,158,11,0.2) 45%, transparent 70%)',
                    filter: 'blur(6px)',
                  }}
                />
                <Candle petName={petName} showCaption={false} />
              </div>

              <p
                className="mt-0.5 md:mt-1 text-xs md:text-sm text-[#8A7A6E] italic text-center leading-snug"
                style={{ fontFamily: "'Libre Caslon Text', 'Georgia', serif" }}
              >
                This candle is burning for {petName || 'this beautiful soul'}.
              </p>

              <div className="mt-1.5 md:mt-3 bg-[#F5efe6]/80 px-3 py-0.5 md:px-4 md:py-1.5 rounded-full border border-[#E9dfd3]/80">
                <p className="text-[11px] md:text-xs text-[#5A5047]">
                  The flame burns until <span className="font-semibold">{formatFlameExpiry(candleExpiresAt, now)}</span>
                </p>
              </div>

              {parsedMemorial?.isBanned ? (
                <div className="mt-2.5 md:mt-4 text-center p-2.5 md:p-3 bg-red-50 text-red-700 text-xs font-bold rounded-xl border border-red-200 shadow-sm w-full max-w-xs">
                  🔒 Candle lighting is disabled for suspended memorials.
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleIgniteClick}
                  className="mt-2.5 md:mt-4 w-full max-w-xs bg-gradient-to-r from-[#D48C6F] to-[#c07a5d] text-white px-5 py-2.5 md:px-6 md:py-3 rounded-xl md:rounded-2xl font-bold text-xs md:text-sm uppercase tracking-widest hover:shadow-[0_4px_16px_rgba(212,140,111,0.4)] transition-all transform hover:scale-[1.02] active:scale-[0.98] cursor-pointer"
                >
                  Keep the Flame Alive
                </button>
              )}

              {/* ── Integrated Collective Altar ──────────────────── */}
              <div className="w-full border-t border-amber-900/10 mt-2.5 md:mt-4 pt-2 md:pt-3">
                <CandleAltar totalCandles={totalCandles} expiryTimestamp={expiryTimestamp} isBurning={true} />
              </div>
            </div>
          ) : (
            <div
              className="relative w-full rounded-2xl md:rounded-3xl px-4 py-3.5 sm:px-5 sm:py-4 md:px-6 md:py-6 flex flex-col items-center"
              style={{
                background: 'radial-gradient(circle at 50% 32%, rgba(200,180,160,0.12) 0%, rgba(250,247,242,0) 70%)',
                border: '1px solid rgba(180,160,140,0.2)',
              }}
            >
              <div className="w-9 h-9 md:w-14 md:h-14 rounded-full bg-[#F5efe6] flex items-center justify-center mb-1.5 md:mb-3">
                <span className="material-symbols-outlined text-lg md:text-2xl text-[#b5a79a]" style={{ fontVariationSettings: "'FILL' 0" }}>local_fire_department</span>
              </div>
              <h3
                className="text-base md:text-lg text-[#2C2520] mb-0.5 md:mb-1"
                style={{ fontFamily: "'Libre Caslon Text', serif" }}
              >
                The Flame Has Faded
              </h3>
              <p className="text-[11px] md:text-xs text-[#8A7A6E] max-w-xs text-center leading-snug mb-2.5 md:mb-4">
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
              <div className="w-full border-t border-amber-900/10 mt-2.5 md:mt-4 pt-2 md:pt-3">
                <CandleAltar totalCandles={totalCandles} expiryTimestamp={0} isBurning={false} />
              </div>
            </div>
          )}
        </div>

        {/* Bio / Memory Narrative (Mobile: order-3, Desktop: order-2) */}
        {description && (
          <div className="order-3 md:order-2 w-full max-w-2xl mx-auto bg-surface p-5 sm:p-6 md:p-10 rounded-[20px] md:rounded-[24px] border border-outline-variant/20 shadow-sm text-center mb-3 md:mb-6">
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

        {/* Subtle technical footnote for testnet temporary storage (kept out of the poetic Quote Card) */}
        {isTestnetTemporaryStorage && (
          <p className="order-5 md:order-5 text-xs text-stone-400 text-center max-w-md mx-auto pt-2 leading-relaxed">
            {TESTNET_TEMPORARY_STORAGE_NOTICE}
          </p>
        )}
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
        @keyframes archCandleGlow {
          0%, 100% {
            box-shadow: 0 12px 45px rgba(245, 158, 11, 0.3);
            border-color: rgba(245, 158, 11, 0.35);
          }
          50% {
            box-shadow: 0 14px 58px rgba(245, 158, 11, 0.44);
            border-color: rgba(245, 158, 11, 0.6);
          }
        }
        @keyframes medallionPulse {
          0%, 100% {
            box-shadow: 0 4px 20px rgba(245, 158, 11, 0.45), 0 0 10px rgba(251, 191, 36, 0.25);
            border-color: rgba(251, 191, 36, 0.8);
          }
          50% {
            box-shadow: 0 4px 26px rgba(245, 158, 11, 0.65), 0 0 18px rgba(251, 191, 36, 0.45);
            border-color: rgba(245, 158, 11, 0.95);
          }
        }
        @keyframes medallionFlameFlicker {
          0%, 100% {
            transform: translateY(0) scale(1);
          }
          50% {
            transform: translateY(-1.5px) scale(1.04);
          }
        }
      `}</style>
    </div>
  );
}
