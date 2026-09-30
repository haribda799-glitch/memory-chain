import { useState, useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt, useChainId, useAccount, useReadContract, useSwitchChain, useEstimateFeesPerGas } from 'wagmi';
import { baseSepolia } from 'viem/chains';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress } from '../config/chains';

const REPORT_REASONS = [
  'Inappropriate or offensive content',
  'Spam or commercial advertising',
  'Copyright or privacy violation',
  'Other',
];

export default function ReportModal({
  isOpen = false,
  onClose = () => {},
  memorialId = 0,
  petName = '',
  ownerAddress = '',
  epoch: propEpoch,
  reportWeight: propReportWeight,
  onSuccess,
}) {
  const chainId = useChainId();
  const contractAddress = getContractAddress(chainId);
  const { address: wagmiAddress, isConnected, chain, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { wallets } = useWallets();
  const { user, login } = usePrivy();
  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const activeAddress = wagmiAddress || embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;

  const [selectedReason, setSelectedReason] = useState(REPORT_REASONS[0]);
  const [error, setError] = useState('');
  const [isClosing, setIsClosing] = useState(false);

  const { data: feeData } = useEstimateFeesPerGas();

  // Read has_created_memorial for Sybil Guard check
  const { data: hasCreatedMemorial } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'has_created_memorial',
    args: [activeAddress],
    query: { enabled: !!activeAddress },
  });

  // Read report_epoch from contract if not passed
  const { data: onchainReportEpoch, refetch: refetchReportEpoch } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'report_epoch',
    args: [BigInt(memorialId || 0)],
    query: { enabled: !!memorialId && propEpoch === undefined },
  });

  // Read report_weight from contract if not passed
  const { data: onchainReportWeight, refetch: refetchReportWeight } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'report_weight',
    args: [BigInt(memorialId || 0)],
    query: { enabled: !!memorialId && propReportWeight === undefined },
  });

  const epoch = Number(propEpoch ?? onchainReportEpoch ?? 0);
  const reportWeight = Number(propReportWeight ?? onchainReportWeight ?? 0);

  // Read on-chain has_reported check
  const { data: hasReported, refetch: refetchHasReported } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'has_reported',
    args: [BigInt(memorialId || 0), activeAddress],
    query: { enabled: !!activeAddress && !!memorialId },
  });

  // Fetch memorial data to get owner if not passed as prop
  const { data: memorialRaw } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'memorials',
    args: [BigInt(memorialId || 0)],
    query: { enabled: !ownerAddress && !!memorialId },
  });

  const memorialOwner = ownerAddress || (Array.isArray(memorialRaw) ? memorialRaw[0] : memorialRaw?.owner);
  const isBanned = Array.isArray(memorialRaw) ? Boolean(memorialRaw[6]) : Boolean(memorialRaw?.is_banned ?? memorialRaw?.isBanned);
  const hasMemorials = Number(hasCreatedMemorial) > 0 || hasCreatedMemorial === true;
  const isOwnMemorial = !!activeAddress && !!memorialOwner && String(memorialOwner).toLowerCase() === String(activeAddress).toLowerCase();

  const userReportEpoch = Number(hasReported || 0);
  const reportKey = activeAddress && memorialId
    ? `mc_reported_${activeAddress.toLowerCase()}_${memorialId}_epoch_${epoch}`
    : null;

  // On-chain check: user reported in current epoch if userReportEpoch > epoch AND reportWeight > 0
  const hasReportedOnChainCurrentEpoch = userReportEpoch > epoch && reportWeight > 0;

  // Local storage: report flag set for current epoch AND on-chain reportWeight > 0
  const isLocallyReported = Boolean(
    reportKey &&
    reportWeight > 0 &&
    typeof window !== 'undefined' &&
    window.localStorage &&
    window.localStorage.getItem(reportKey) === 'true'
  );

  const alreadyReported = Boolean(activeAddress) && (hasReportedOnChainCurrentEpoch || isLocallyReported);

  // Synchronize on-chain report to localStorage if on-chain confirms user reported in current epoch
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage || !reportKey) return;
    if (hasReportedOnChainCurrentEpoch) {
      window.localStorage.setItem(reportKey, 'true');
    }
  }, [reportKey, hasReportedOnChainCurrentEpoch]);

  // Clean flat legacy keys and stale epoch keys for this memorial
  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage || !activeAddress || !memorialId) return;
    try {
      const flatKey = `mc_reported_${activeAddress.toLowerCase()}_${memorialId}`;
      window.localStorage.removeItem(flatKey);

      const prefix = `mc_reported_${activeAddress.toLowerCase()}_${memorialId}_epoch_`;
      const keysToRemove = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const match = k.match(/_epoch_(\d+)$/);
          if (match) {
            const savedEpoch = Number(match[1]);
            if (savedEpoch < epoch || reportWeight === 0) {
              keysToRemove.push(k);
            }
          }
        }
      }
      keysToRemove.forEach((k) => window.localStorage.removeItem(k));
    } catch (e) {
      console.warn('[ReportModal] Storage cleanup warning:', e);
    }
  }, [activeAddress, memorialId, epoch, reportWeight]);

  const { writeContractAsync, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) {
      if (typeof window !== 'undefined' && window.localStorage && reportKey) {
        window.localStorage.setItem(reportKey, 'true');
        if (activeAddress && memorialId) {
          window.localStorage.removeItem(`mc_reported_${activeAddress.toLowerCase()}_${memorialId}`);
        }
      }
      if (refetchHasReported) refetchHasReported();
      if (refetchReportEpoch) refetchReportEpoch();
      if (refetchReportWeight) refetchReportWeight();
      if (onSuccess) {
        onSuccess();
      }
    }
  }, [isSuccess, reportKey, activeAddress, memorialId, onSuccess]);

  const handleClose = () => {
    if (isClosing) return;
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      setError('');
      onClose();
    }, 300);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSubmit = async () => {
    console.log('[Report] Submit clicked, reason:', selectedReason);
    setError('');

    if (!isConnected && !embeddedWallet) {
      alert('Please connect your wallet first.');
      return;
    }

    if (isBanned) {
      setError('This memorial has already been banned by Council moderation.');
      return;
    }

    if (!hasMemorials) {
      setError('Sybil Guard: You must own at least one memorial on Memory Chain to submit a report.');
      return;
    }

    if (isOwnMemorial) {
      setError('You cannot report your own memorial.');
      return;
    }

    if (alreadyReported) {
      setError('You have already reported this memorial.');
      return;
    }

    if (!connector) {
      console.error('Wallet connector is missing or Privy was blocked.');
      setError('Wallet connection failed. Please disable your adblocker or reconnect your wallet.');
      return;
    }

    if (chain?.id !== baseSepolia.id) {
      try {
        await switchChainAsync({ chainId: baseSepolia.id });
      } catch (switchErr) {
        console.error('[Report] Switch chain error:', switchErr);
        alert('Please switch network to Base Sepolia.');
        return;
      }
    }

    try {
      const gasConfig = {};
      if (feeData?.maxFeePerGas) {
        gasConfig.maxFeePerGas = (feeData.maxFeePerGas * 130n) / 100n;
      }
      if (feeData?.maxPriorityFeePerGas) {
        gasConfig.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * 130n) / 100n;
      }

      const hash = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'report_memorial',
        args: [BigInt(memorialId || 0)],
        account: activeAddress,
        connector,
        chainId: baseSepolia.id,
        ...gasConfig,
      });

      console.log('[Report] Submitted tx hash:', hash);
    } catch (err) {
      console.error('[Report] Transaction failed:', err);
      const msg = err?.shortMessage || err?.message || 'Report transaction failed';
      if (msg.includes('Sybil Guard') || msg.includes('Must own a memorial')) {
        setError('Sybil Guard Notice: You must own a memorial on Memory Chain to report content.');
      } else if (msg.includes('Already reported')) {
        setError('You have already reported this memorial.');
      } else {
        setError(msg);
      }
    }
  };

  if (!isOpen && !isClosing) return null;

  const isDisabled = isPending || isConfirming || !hasMemorials || isOwnMemorial || alreadyReported || isBanned;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={handleClose}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300 ${
          isClosing ? 'opacity-0' : 'opacity-100'
        }`}
      />

      {/* Modal Card */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-md bg-[#fdfcfa] rounded-[24px] border border-[#d8c2ba]/40 shadow-2xl overflow-hidden transition-all duration-300 ${
          isClosing ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
        }`}
      >
        {/* Header */}
        <div className="relative px-6 pt-6 pb-4 text-center">
          <button
            type="button"
            onClick={handleClose}
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-[#f5f3f0] flex items-center justify-center hover:bg-[#e8e5e0] transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[#5A5047] text-lg">close</span>
          </button>

          <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-3 text-amber-700 shadow-sm">
            <span className="material-symbols-outlined text-2xl">flag</span>
          </div>

          <h2 className="text-xl text-[#1b1c1a] mb-1" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
            Report Memorial
          </h2>
          <p className="text-xs text-[#53433e]">
            for <span className="font-semibold italic">{petName || `Memorial #${memorialId}`}</span>
          </p>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div className="mb-2">
            {!activeAddress ? (
              <div className="p-5 text-sm text-[#53433e] bg-[#fbf5f2] border border-[#e0d0c7] rounded-2xl flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-full bg-amber-50 border border-amber-200/60 flex items-center justify-center text-amber-700 shadow-sm">
                  <span className="material-symbols-outlined text-2xl">account_balance_wallet</span>
                </div>
                <div className="space-y-1">
                  <strong className="block text-[#1b1c1a] font-medium text-sm">Authentication Required</strong>
                  <p className="text-xs text-[#7A6B60] leading-relaxed max-w-xs">
                    Please connect your wallet to submit a report for review.
                  </p>
                </div>
              </div>
            ) : isSuccess ? (
              <div className="bg-green-50 border border-green-200 rounded-xl py-3 px-4 text-xs text-green-700 text-center space-y-1">
                <p className="font-semibold">✨ Report Submitted</p>
                <p className="text-green-600">Thank you for helping keep the gallery safe.</p>
              </div>
            ) : isBanned ? (
              <div className="p-3 mb-1 text-sm text-red-800 bg-red-50 border border-red-200 rounded-xl flex items-center gap-3">
                <span className="material-symbols-outlined text-red-600 text-[20px] flex-shrink-0">block</span>
                <span>This memorial has already been banned by Council moderation.</span>
              </div>
            ) : !hasMemorials ? (
              <div className="p-3 mb-1 text-sm text-[#53433e] bg-[#f5f0eb] border border-[#e0d0c7] rounded-xl flex items-start gap-3">
                <span className="material-symbols-outlined text-[#C16226] text-[20px] mt-0.5 flex-shrink-0">security</span>
                <div>
                  <strong className="block text-[#1b1c1a] font-medium mb-0.5">Sybil Guard Active</strong>
                  <span>You must own at least one memorial to submit a report.</span>
                </div>
              </div>
            ) : isOwnMemorial ? (
              <div className="p-3 mb-1 text-sm text-[#53433e] bg-[#f5f0eb] border border-[#e0d0c7] rounded-xl flex items-center gap-3">
                <span className="material-symbols-outlined text-[#8a7570] text-[20px] flex-shrink-0">lock</span>
                <span>You cannot report your own memorial.</span>
              </div>
            ) : alreadyReported ? (
              <div className="p-3 mb-1 text-sm text-[#53433e] bg-[#f5f0eb] border border-[#e0d0c7] rounded-xl flex items-center gap-3">
                <span className="material-symbols-outlined text-green-600 text-[20px] flex-shrink-0">check_circle</span>
                <span>You have already reported this memorial.</span>
              </div>
            ) : (
              <p className="text-xs text-[#7A6B60] text-center leading-relaxed">
                Community moderation protects the sanctity of Memory Chain. To prevent spam, reporting requires owning at least one memorial (Sybil Guard).
              </p>
            )}
          </div>

          {/* Reason Selection Radio Group (shown if eligible to report) */}
          {Boolean(activeAddress) && !isBanned && !isOwnMemorial && !alreadyReported && !isSuccess && hasMemorials && (
            <div className="space-y-2 pt-1">
              <label className="block text-xs font-semibold text-[#5A5047] uppercase tracking-wider mb-2">
                Reason for report:
              </label>
              {REPORT_REASONS.map((reason) => {
                const isSelected = selectedReason === reason;
                return (
                  <label
                    key={reason}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-xs cursor-pointer transition-all ${
                      isSelected
                        ? 'border-[#C16226] bg-[#fbf5f2] font-semibold text-[#2C2520] shadow-sm'
                        : 'border-[#E9dfd3] bg-[#fdfcfa] text-[#5A5047] hover:bg-[#F5efe6]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="report_reason"
                      value={reason}
                      checked={isSelected}
                      onChange={() => setSelectedReason(reason)}
                      className="w-4 h-4 text-[#C16226] border-[#d8c2ba] focus:ring-[#C16226] accent-[#C16226]"
                    />
                    <span>{reason}</span>
                  </label>
                );
              })}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl py-2.5 px-3 text-xs text-red-700 text-center">
              {error}
            </div>
          )}

          {/* Action Button */}
          {!activeAddress ? (
            <button
              type="button"
              onClick={login}
              className="w-full py-3.5 rounded-xl font-bold transition-all uppercase tracking-wider text-xs cursor-pointer bg-gradient-to-r from-[#C16226] to-[#A8551F] text-white hover:shadow-md flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined text-base">login</span>
              <span>Connect Wallet</span>
            </button>
          ) : isSuccess || alreadyReported ? (
            <button
              type="button"
              onClick={handleClose}
              className="w-full py-3 rounded-xl bg-stone-100 hover:bg-stone-200 text-stone-700 font-medium transition cursor-pointer"
            >
              Close
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isDisabled}
              className={`w-full py-3.5 rounded-xl font-bold transition-all uppercase tracking-wider text-xs cursor-pointer ${
                isDisabled
                  ? 'bg-[#e8e2dc] text-[#a09080] cursor-not-allowed opacity-80'
                  : 'bg-gradient-to-r from-[#C16226] to-[#A8551F] text-white hover:shadow-md'
              }`}
            >
              {isPending
                ? 'Submitting...'
                : isConfirming
                  ? 'Confirming on Base Sepolia...'
                  : 'Submit Report'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
