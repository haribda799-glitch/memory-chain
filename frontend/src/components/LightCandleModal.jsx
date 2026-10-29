import { useState, useEffect, useRef } from 'react';
import { useReadContract, useWriteContract, useEstimateFeesPerGas, useChainId, usePublicClient, useAccount, useSwitchChain, useBalance } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import { baseSepolia } from 'viem/chains';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress, getExplorerUrl } from '../config/chains';
import { formatTxError, isUserRejection } from '../utils/txErrors';
import { getActiveWalletChainId, setTxInProgress } from '../utils/mobileWallet';
import { useModalBehavior } from '../hooks/useModalBehavior';

const CANDLE_TIERS = [
  { type: 1, label: '1h',  duration: '1 hour',  multiplier: 1n },
  { type: 2, label: '5h',  duration: '5 hours', multiplier: 3n },
  { type: 3, label: '12h', duration: '12 hours', multiplier: 6n },
  { type: 4, label: '24h', duration: '24 hours', multiplier: 10n },
];

export const TIER_HOURS = {
  1: 1,
  2: 5,
  3: 12,
  4: 24,
};

// Mock conversion rate — replace with Chainlink oracle / CoinGecko API later
const ETH_USD_RATE = 3000;
const HIGH_DONATION_THRESHOLD = 0.01; // ETH
// Base Sepolia blocks are ~2s; a tx not mined within 3 minutes is reported as "still pending"
const RECEIPT_TIMEOUT_MS = 180_000;

export default function LightCandleModal({ isOpen = false, onClose = () => {}, memorialId = 0, petName = '', onSuccess = () => {}, currentExpiry = 0 }) {
  const chainId = useChainId();
  const contractAddress = getContractAddress(chainId);
  const publicClient = usePublicClient();
  const { address: wagmiAddress, isConnected, chain, chainId: accountChainId, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { wallets } = useWallets();
  const { user, authenticated, ready, login, connectWallet } = usePrivy();
  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const activeAddress = wagmiAddress || embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;

  const { data: balance } = useBalance({ address: activeAddress });

  const isBurning = currentExpiry > Math.floor(Date.now() / 1000);

  // Gas estimation with buffer
  const { data: feeData } = useEstimateFeesPerGas();

  // Read candle_price from contract
  const { data: candlePriceRaw } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'candle_price',
  });
  const minCandlePriceWei = candlePriceRaw ? BigInt(candlePriceRaw) : 100000000000000n; // 0.0001 ETH

  // Read candles_paused from contract (on-chain invariant guard)
  const { data: candlesPaused } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'candles_paused',
  });
  const isCandlesPaused = Boolean(candlesPaused);

  const [mode, setMode] = useState('tier'); // 'tier' | 'custom'
  const [selectedTier, setSelectedTier] = useState(1);
  const [usdAmount, setUsdAmount] = useState('5.00');
  const [error, setError] = useState('');
  const [isClosing, setIsClosing] = useState(false);

  const [currentTxHash, setCurrentTxHash] = useState(null);

  // Added hours & duration calculation (placed at top to prevent TDZ ReferenceError)
  const tierAddedHours = TIER_HOURS[selectedTier] || 1;
  const activeTierObj = CANDLE_TIERS.find((t) => t.type === selectedTier) || CANDLE_TIERS[0];
  const tierPriceWei = minCandlePriceWei * activeTierObj.multiplier;
  const tierEthDisplay = formatEther(tierPriceWei);
  const tierUsdDisplay = (Number(tierEthDisplay) * ETH_USD_RATE).toFixed(2);

  const customEthAmount = usdAmount ? parseFloat(usdAmount) / ETH_USD_RATE : 0;
  const customEthDisplay = customEthAmount > 0 ? customEthAmount.toFixed(6) : '0.000000';
  const customEthStr = customEthAmount > 0 && Number.isFinite(customEthAmount) ? customEthAmount.toFixed(12) : '0';
  // Absurdly large inputs make toFixed() return exponent notation, which parseEther rejects — never crash the render
  let customWei = 0n;
  try {
    customWei = parseEther(customEthStr);
  } catch {
    customWei = 0n;
  }
  const customAddedHours = minCandlePriceWei > 0n ? Math.floor(Number(customWei / minCandlePriceWei)) : 0;

  // Primary addedHours variable: in tier mode uses TIER_HOURS, in custom mode uses calculated hours
  const addedHours = mode === 'tier' ? tierAddedHours : customAddedHours;

  const now = Math.floor(Date.now() / 1000);
  const baseExpiry = currentExpiry > now ? currentExpiry : now;
  const newExpiry = baseExpiry + addedHours * 3600;

  const isBelowMin = customWei < minCandlePriceWei;
  const remainderWei = minCandlePriceWei > 0n && !isBelowMin ? customWei % minCandlePriceWei : 0n;
  const hasRemainder = remainderWei > 0n && addedHours >= 1;
  const remainderEthDisplay =
    remainderWei > 0n
      ? Number(formatEther(remainderWei))
          .toFixed(6)
          .replace(/\.?0+$/, '') || '0'
      : '0';

  const handleRoundToExactHours = () => {
    if (addedHours >= 1 && minCandlePriceWei > 0n) {
      const exactWei = BigInt(addedHours) * minCandlePriceWei;
      const exactEth = Number(formatEther(exactWei));
      const exactUsd = (exactEth * ETH_USD_RATE).toFixed(2);
      setUsdAmount(exactUsd);
    }
  };

  const requiredWei = mode === 'tier' ? tierPriceWei : customWei;
  const isInsufficientFunds = Boolean(balance?.value !== undefined && balance.value < requiredWei);

  const { writeContractAsync, isPending: isWriting, reset: resetWrite } = useWriteContract();

  /**
   * Transaction lifecycle (single source of truth, driven imperatively from handleSubmit):
   *   idle → preparing (network switch + simulation) → wallet (awaiting signature)
   *        → confirming (awaiting receipt) → success
   * The receipt is awaited inside handleSubmit, so `onSuccess` fires exactly once per
   * transaction and keeps working even if the user closes the modal while it confirms.
   */
  const [txPhase, setTxPhase] = useState('idle');
  const submittingRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  const isPreparing = txPhase === 'preparing';
  const isConfirming = txPhase === 'confirming';
  const isConfirmed = txPhase === 'success';
  const isBusy = isPreparing || isWriting || txPhase === 'wallet' || isConfirming;
  const isPriceLoading = candlePriceRaw === undefined;

  const isSubmitDisabled =
    ((isBusy ||
      isPriceLoading ||
      !activeAddress ||
      isInsufficientFunds ||
      isCandlesPaused ||
      (mode === 'custom' && isBelowMin)) &&
      !isConfirmed);

  // Reset state on modal open (a transaction still confirming in the background is left alone)
  useEffect(() => {
    if (isOpen) {
      if (!submittingRef.current) {
        setCurrentTxHash(null);
        setTxPhase('idle');
        setError('');
        if (typeof resetWrite === 'function') {
          resetWrite();
        }
      }
    }
  }, [isOpen, resetWrite]);

  const handleClose = () => {
    if (isClosing) return;
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      setError('');
      onClose();
    }, 300);
  };

  useModalBehavior(isOpen && !isClosing, handleClose);

  // The flame was already registered via onSuccess when the receipt confirmed
  const handleViewFlame = () => {
    handleClose();
  };

  /** Make sure the connected wallet is on Base Sepolia before sending anything. */
  const ensureBaseSepolia = async () => {
    const activeWallet = wallets.find((w) => w.walletClientType !== 'privy') || embeddedWallet || wallets[0];
    const currentWalletChainId = await getActiveWalletChainId({
      chain,
      accountChainId,
      wallet: activeWallet,
      connector,
      fallbackChainId: chainId,
    });
    // If already on Base Sepolia (84532), do NOT call switchChainAsync
    if (currentWalletChainId === null || currentWalletChainId === baseSepolia.id) {
      return true;
    }
    try {
      if (isConnected && switchChainAsync) {
        await switchChainAsync({ chainId: baseSepolia.id });
      } else if (activeWallet?.switchChain) {
        await activeWallet.switchChain(baseSepolia.id);
      }
      return true;
    } catch (switchErr) {
      console.error('[Candle] Failed to switch network:', switchErr);
      setError(isUserRejection(switchErr)
        ? 'Network switch was cancelled. Please switch your wallet to Base Sepolia to continue.'
        : 'Please switch your wallet network to Base Sepolia to continue.');
      return false;
    }
  };

  const handleSubmit = async () => {
    // Double-tap guard: a second tap while the wallet / network prompt is opening is ignored
    if (submittingRef.current) return;
    console.log('[Candle] Button clicked, mode:', mode);
    setError('');

    if (isCandlesPaused) {
      setError('Candle lighting is temporarily paused by the protocol.');
      return;
    }

    if (isPriceLoading) {
      setError('Loading the current candle price. Please try again in a moment.');
      return;
    }

    if (isInsufficientFunds) {
      setError('Insufficient Base Sepolia ETH balance for this offering.');
      return;
    }

    const isAuthorized = Boolean(activeAddress) || (isConnected && !!wagmiAddress) || (ready && authenticated && !!activeAddress);
    if (!isAuthorized || !activeAddress) {
      console.warn('[Candle] Wallet not connected or not ready yet');
      setError('Please connect your wallet first.');
      return;
    }

    if (mode === 'custom') {
      const usdNum = parseFloat(usdAmount);
      if (!usdAmount || isNaN(usdNum) || usdNum <= 0) {
        setError('Please enter a donation amount.');
        return;
      }

      if (customWei < minCandlePriceWei) {
        setError(`Minimum offering is ${formatEther(minCandlePriceWei)} ETH (~$${(Number(formatEther(minCandlePriceWei)) * ETH_USD_RATE).toFixed(2)})`);
        return;
      }

      // Fat Finger check for large donation amounts
      if (customEthAmount >= HIGH_DONATION_THRESHOLD) {
        const confirmed = window.confirm(
          `You are about to donate ${customEthDisplay} ETH to keep this memory alive. Are you sure you want to proceed?`
        );
        if (!confirmed) {
          return;
        }
      }
    }

    submittingRef.current = true;
    setTxInProgress(true);
    // Snapshot what is being paid for, so later UI changes cannot alter the optimistic update
    const isTierMode = mode === 'tier';
    const successPayload = isTierMode
      ? { type: 'tier', tier: selectedTier, seconds: TIER_HOURS[selectedTier] * 3600 }
      : { type: 'custom', seconds: Math.max(1, addedHours) * 3600 };

    try {
      setTxPhase('preparing');

      // Ensure wallet is connected to Base Sepolia
      const onBaseSepolia = await ensureBaseSepolia();
      if (!onBaseSepolia) {
        setTxPhase('idle');
        return;
      }

      // Gas fee estimation with +30% buffer
      const maxFeePerGas = feeData?.maxFeePerGas
        ? (feeData.maxFeePerGas * 130n) / 100n
        : undefined;

      const maxPriorityFeePerGas = feeData?.maxPriorityFeePerGas
        ? (feeData.maxPriorityFeePerGas * 130n) / 100n
        : undefined;

      const txArgs = {
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: isTierMode ? 'light_candle' : 'donate_and_light',
        args: isTierMode ? [BigInt(memorialId || 0), Number(selectedTier)] : [BigInt(memorialId || 0)],
        chainId: baseSepolia.id,
        value: requiredWei,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };

      console.log('[Candle] txArgs:', txArgs);

      // Pre-flight simulation: catch revert reasons before MetaMask opens
      if (publicClient && activeAddress) {
        try {
          await publicClient.simulateContract({
            ...txArgs,
            account: activeAddress,
          });
          console.log('[Candle] simulateContract OK — sending tx');
        } catch (simErr) {
          console.error('[Candle] simulateContract REVERT:', simErr);
          setError(formatTxError(simErr, 'This transaction would fail. Please try again.'));
          setTxPhase('idle');
          return;
        }
      } else {
        console.warn('[Candle] Skipping simulateContract: publicClient or wallet address missing');
      }

      console.log('[Candle] Sending transaction via writeContractAsync...');
      setTxPhase('wallet');
      const hash = await writeContractAsync({
        ...txArgs,
        account: activeAddress,
        ...(connector ? { connector } : {}),
      });

      console.log('[Candle] Tx submitted! Hash:', hash);
      setCurrentTxHash(hash);
      setTxPhase('confirming');

      if (!publicClient) throw new Error('Network client unavailable');
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status !== 'success') {
        throw new Error('Transaction reverted');
      }

      console.log('🔥 Candle Lit Transaction Confirmed!');
      // Fires once per confirmed tx, even if the modal was closed meanwhile
      onSuccessRef.current?.(successPayload);
      setTxPhase('success');
    } catch (err) {
      console.error('[Candle] Transaction failed or rejected:', err);
      setError(formatTxError(err, 'Transaction rejected or failed.'));
      setTxPhase('idle');
    } finally {
      setTxInProgress(false);
      submittingRef.current = false;
    }
  };

  if (!isOpen && !isClosing) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      role="dialog"
      aria-modal="true"
      aria-label={isBurning ? 'Extend the flame' : 'Light a candle'}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          isClosing ? 'opacity-0' : 'opacity-100'
        }`}
        onClick={handleClose}
      />

      {/* Modal */}
      <div 
        className={`relative w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain bg-[#fbf9f6] rounded-[20px] border border-[#E9dfd3] shadow-2xl transition-all duration-300 ${
          isClosing ? 'opacity-0 scale-95' : 'opacity-100 scale-100 animate-[modalIn_0.3s_ease-out]'
        }`}
      >
        {/* Header */}
        <div className="relative px-6 pt-6 pb-4 text-center">
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="absolute top-3 right-3 w-10 h-10 rounded-full bg-[#efeeeb] flex items-center justify-center hover:bg-[#e2e0dc] transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[#5A5047] text-lg">close</span>
          </button>

          <div className="w-14 h-14 rounded-full bg-gradient-to-b from-[#FFB598] to-[#D48C6F] flex items-center justify-center mx-auto mb-3 shadow-[0_0_20px_rgba(212,140,111,0.3)]">
            <span className="material-symbols-outlined text-white text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>local_fire_department</span>
          </div>
          <h2 className="text-xl text-[#2C2520] mb-1" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
            {isBurning ? 'Extend the Flame' : 'Light a Candle'}
          </h2>
          <p className="font-body-sm text-body-sm text-[#5A5047]">
            for <span className="italic">{petName}</span>
          </p>
        </div>

        {/* Divider */}
        <div className="w-10 h-px bg-[#D48C6F]/30 mx-auto" />

        <div className="px-6 py-5 space-y-5">
          {/* Mode Selector Tabs */}
          <div className="flex bg-[#F5efe6] p-1 rounded-xl border border-[#E9dfd3]">
            <button
              type="button"
              onClick={() => { setMode('tier'); setError(''); }}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                mode === 'tier'
                  ? 'bg-white text-[#2C2520] shadow-sm'
                  : 'text-[#8A7A6E] hover:text-[#2C2520]'
              }`}
            >
              Standard Ritual
            </button>
            <button
              type="button"
              onClick={() => { setMode('custom'); setError(''); }}
              className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
                mode === 'custom'
                  ? 'bg-white text-[#2C2520] shadow-sm'
                  : 'text-[#8A7A6E] hover:text-[#2C2520]'
              }`}
            >
              Open Offering
            </button>
          </div>

          {/* Mode 1: Duration Tier Selector */}
          {mode === 'tier' && (
            <div className="space-y-3">
              <label className="block font-label-md text-label-md text-[#5A5047] uppercase tracking-wider text-center">
                Burn Duration
              </label>
              <div className="grid grid-cols-4 gap-2">
                {CANDLE_TIERS.map((tier) => (
                  <button
                    key={tier.type}
                    type="button"
                    onClick={() => setSelectedTier(tier.type)}
                    className={`
                      py-2.5 rounded-[12px] text-sm font-semibold tracking-wide transition-all duration-200 cursor-pointer
                      ${selectedTier === tier.type
                        ? 'bg-[#D48C6F] text-white shadow-[0_2px_8px_rgba(212,140,111,0.4)] scale-[1.02]'
                        : 'bg-[#F5efe6] text-[#5A5047] border border-[#E9dfd3] hover:border-[#D48C6F]/40 hover:bg-[#F0e8dd]'
                      }
                    `}
                  >
                    {tier.label}
                  </button>
                ))}
              </div>
              <div className="text-center p-3 bg-[#F5efe6] rounded-[12px] border border-[#E9dfd3] space-y-0.5">
                <p className="text-[11px] font-semibold text-[#8A7A6E] uppercase tracking-wider">Fixed Tier Cost</p>
                <p className="text-lg font-bold text-[#2C2520]">{tierEthDisplay} ETH <span className="text-xs font-normal text-[#8A7A6E]">(~${tierUsdDisplay})</span></p>
                <p className="text-[11px] text-[#8A7A6E]">Keeps the flame alive for exactly {activeTierObj.duration}</p>
              </div>
            </div>
          )}

          {/* Mode 2: Custom Voluntary Offering Input */}
          {mode === 'custom' && (
            <div className="space-y-3">
              <label className="block font-label-md text-label-md text-[#5A5047] uppercase tracking-wider text-center">
                Custom Donation
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#8A7A6E] text-lg font-semibold">$</span>
                <input
                  type="number"
                  min="0.30"
                  step="0.50"
                  placeholder="e.g. 5.00"
                  value={usdAmount}
                  onChange={(e) => setUsdAmount(e.target.value)}
                  className="w-full pl-9 pr-4 py-3 rounded-[12px] bg-white border border-[#E9dfd3] text-[#2C2520] text-lg font-medium placeholder:text-[#c4b8aa] focus:outline-none focus:border-[#D48C6F] focus:ring-1 focus:ring-[#D48C6F]/30 transition-all"
                />
              </div>
              {customEthAmount > 0 && (
                <p className="text-center font-body-sm text-body-sm text-[#8A7A6E]">
                  ≈ {customEthDisplay} ETH <span className="text-[#b5a79a]">(@ ${ETH_USD_RATE}/ETH)</span>
                </p>
              )}
              {isBelowMin ? (
                <div className="text-center p-3 bg-red-50 rounded-[12px] border border-red-200 space-y-1">
                  <p className="text-xs font-semibold text-red-700">
                    Amount is below candle price ({formatEther(minCandlePriceWei)} ETH)
                  </p>
                  <p className="text-[11px] text-red-600">
                    Minimum donation of {formatEther(minCandlePriceWei)} ETH is required to add flame time.
                  </p>
                </div>
              ) : (
                <div className="text-center p-3 bg-[#F5efe6] rounded-[12px] border border-[#E9dfd3] space-y-1.5">
                  <p className="text-xs text-[#5A5047]">
                    Adds <strong className="text-[#2C2520]">+{addedHours} hour{addedHours !== 1 ? 's' : ''}</strong> of flame duration
                    {hasRemainder && (
                      <span className="text-[#8A7A6E]"> (+ {remainderEthDisplay} ETH extra donation to treasury)</span>
                    )}
                  </p>
                  <p className="text-[11px] text-[#8A7A6E]">
                    1 hour for each full step of {formatEther(minCandlePriceWei)} ETH
                  </p>
                  {hasRemainder && (
                    <button
                      type="button"
                      onClick={handleRoundToExactHours}
                      className="mt-1 px-3 py-1 bg-white hover:bg-amber-50 text-[#8a4f36] border border-[#d8c2ba] rounded-lg text-xs font-medium transition-colors shadow-sm cursor-pointer inline-flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-xs">tune</span>
                      Round down to exact {addedHours}h ({formatEther(BigInt(addedHours) * minCandlePriceWei)} ETH)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Paused State Banner */}
          {isCandlesPaused && (
            <div className="p-3 bg-amber-50 border border-amber-300 rounded-[12px] text-xs text-amber-800 flex items-center gap-2">
              <span className="material-symbols-outlined text-amber-600 text-base shrink-0">pause_circle</span>
              <span>⏸️ Candle lighting is temporarily paused by the protocol.</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-center text-sm text-red-600 bg-red-50 rounded-[10px] py-2 px-3">{error}</p>
          )}

          {/* Pending transaction: explorer link (useful on mobile if confirmation takes a while) */}
          {currentTxHash && (isConfirming || error) && (
            <p className="text-center text-[11px] text-[#8A7A6E]">
              <a
                href={`${getExplorerUrl(chainId)}/tx/${currentTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-[#8a4f36]"
              >
                View transaction on the block explorer
              </a>
            </p>
          )}

          {/* Success State */}
          {isConfirmed && (
            <div className="text-center bg-[#FDF8EE] border border-amber-400/40 text-amber-950 rounded-xl py-3 px-4 space-y-1">
              <p className="text-amber-950 text-sm font-semibold inline-flex items-center justify-center gap-1.5">
                <svg className="w-4 h-4 text-amber-600 shrink-0" viewBox="0 0 22 30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path d="M12.2 1.2C14.9 5.9 19.2 12.4 19.2 19.1C19.2 24.3 15.6 28.2 11 28.2C6.4 28.2 2.8 24.3 2.8 19.1C2.8 12.1 8.1 6.6 12.2 1.2Z" fill="#F59E0B" />
                  <path d="M11.6 6.4C13.7 10.2 16.6 14.9 16.6 19.9C16.6 23.9 14.2 27.0 11 27.0C7.8 27.0 5.4 23.9 5.4 19.9C5.4 14.6 9.1 10.6 11.6 6.4Z" fill="#FBBF24" />
                </svg>
                <span>Candle lit successfully!</span>
              </p>
              <p className="text-amber-900/80 text-xs">The flame now burns for {petName}.</p>
            </div>
          )}

          {/* Submit Button */}
          {!activeAddress ? (
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => login({ loginMethods: ['email'] })}
                className="w-full py-3.5 rounded-[14px] font-bold text-xs uppercase tracking-widest transition-all duration-200 cursor-pointer bg-gradient-to-r from-[#D48C6F] to-[#c07a5d] text-white hover:shadow-[0_4px_16px_rgba(212,140,111,0.4)] flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-base">mail</span>
                <span>Continue with Email</span>
              </button>
              <p className="text-[11px] text-[#8a4f36] text-center font-medium">
                Creates your built-in wallet automatically via email
              </p>
              <button
                type="button"
                onClick={() => connectWallet()}
                className="w-full py-2.5 rounded-[14px] font-semibold text-xs uppercase tracking-wider transition-all duration-200 cursor-pointer bg-white hover:bg-[#f5efe6] text-[#53433e] border border-[#d8c2ba] flex items-center justify-center gap-2"
              >
                <span className="material-symbols-outlined text-base">account_balance_wallet</span>
                <span>Connect External Wallet</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={isConfirmed ? handleViewFlame : handleSubmit}
              disabled={isSubmitDisabled}
              className={`
                w-full py-3.5 rounded-[14px] font-bold text-sm uppercase tracking-widest transition-all duration-200 cursor-pointer inline-flex items-center justify-center gap-2
                ${isSubmitDisabled
                  ? 'bg-[#E9dfd3] text-[#8A7A6E] cursor-not-allowed'
                  : isConfirmed
                    ? 'bg-[#C87D65] hover:bg-[#B56B53] text-white hover:shadow-[0_4px_14px_rgba(200,125,101,0.35)] hover:scale-[1.01] active:scale-[0.99]'
                    : 'bg-gradient-to-r from-[#D48C6F] to-[#c07a5d] text-white hover:shadow-[0_4px_16px_rgba(212,140,111,0.4)] hover:scale-[1.01] active:scale-[0.99]'
                }
              `}
            >
              {isPreparing ? (
                'Preparing...'
              ) : isWriting || txPhase === 'wallet' ? (
                'Confirming in Wallet...'
              ) : isConfirming ? (
                'Lighting Candle on-chain...'
              ) : isConfirmed ? (
                <>
                  <svg className="w-4 h-4 text-white shrink-0" viewBox="0 0 22 30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M12.2 1.2C14.9 5.9 19.2 12.4 19.2 19.1C19.2 24.3 15.6 28.2 11 28.2C6.4 28.2 2.8 24.3 2.8 19.1C2.8 12.1 8.1 6.6 12.2 1.2Z" fill="currentColor" />
                  </svg>
                  <span>VIEW THE FLAME</span>
                </>
              ) : isCandlesPaused ? (
                'Candle Lighting Paused'
              ) : isPriceLoading ? (
                'Loading Price...'
              ) : isInsufficientFunds ? (
                'Insufficient ETH Balance'
              ) : mode === 'custom' && isBelowMin ? (
                `Min. ${formatEther(minCandlePriceWei)} ETH Required`
              ) : isBurning ? (
                'Add Fuel & Time'
              ) : mode === 'tier' ? (
                'Light Candle'
              ) : (
                'Send Tribute & Ignite'
              )}
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes modalIn {
          from { opacity: 0; transform: translateY(12px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
