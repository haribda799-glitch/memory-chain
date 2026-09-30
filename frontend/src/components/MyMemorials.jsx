import { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { 
  useReadContract,
  useWriteContract, 
  useEstimateFeesPerGas, 
  useChainId, 
  useAccount, 
  usePublicClient,
  useSwitchChain 
} from 'wagmi';
import { baseSepolia } from 'viem/chains';
import MemorialCard from './MemorialCard';
import { useMemorials } from '../utils/useMemorials';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress } from '../config/chains';

function SkeletonCard() {
  return (
    <div className="bg-surface rounded-[16px] border border-outline-variant/20 overflow-hidden flex flex-col h-full animate-pulse shadow-sm">
      <div className="relative h-64 bg-stone-200/70" />
      <div className="p-6 space-y-4 flex flex-col flex-grow">
        <div className="space-y-2">
          <div className="h-6 bg-stone-200/80 rounded-md w-3/5" />
          <div className="h-4 bg-stone-200/60 rounded-md w-2/5" />
        </div>
        <div className="flex gap-2 pt-1">
          <div className="h-5 bg-stone-200/60 rounded-full w-20" />
          <div className="h-5 bg-stone-200/60 rounded-full w-16" />
        </div>
        <div className="mt-auto pt-4 border-t border-stone-100 flex items-center justify-between">
          <div className="h-4 bg-stone-200/60 rounded w-24" />
          <div className="h-8 bg-stone-200/80 rounded-xl w-24" />
        </div>
      </div>
    </div>
  );
}

function MyMemorialItem({ mem, onRefetch, onUpdateMemorial }) {
  const chainId = useChainId();
  const contractAddress = getContractAddress(chainId);
  const publicClient = usePublicClient();
  const { data: feeData } = useEstimateFeesPerGas();

  const { address: wagmiAddress, connector, chain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { wallets } = useWallets();
  const { user, ready, authenticated } = usePrivy();
  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const activeAddress = wagmiAddress || embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;

  const [isToggling, setIsToggling] = useState(false);
  // Strict boolean normalization — guards against 0n, undefined, null from contract
  const [localIsPublic, setLocalIsPublic] = useState(() => Boolean(mem.isPublic));

  // Sync from parent/contract updates — but SKIP while a toggle is in progress
  // to prevent stale RPC cache from overwriting the optimistic local state.
  useEffect(() => {
    if (!isToggling) {
      setLocalIsPublic(Boolean(mem.isPublic));
    }
  }, [mem.isPublic, isToggling]);

  // Read candle expiry from contract
  const { data: candleExpiryRaw } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'candle_expires_at',
    args: [BigInt(mem.tokenId)],
  });

  // Read total candles lit from contract
  const { data: totalCandlesRaw } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'total_candles_lit',
    args: [BigInt(mem.tokenId)],
  });

  const candleExpiresAt = Number(candleExpiryRaw ?? mem?.candle_expires_at ?? mem?.candleExpiresAt ?? 0);
  const totalCandlesLit = Number(totalCandlesRaw ?? mem?.total_candles_lit ?? mem?.totalCandles ?? mem?.candleCount ?? 0);

  const { writeContractAsync } = useWriteContract();

  const handleTogglePublic = async () => {
    const isAuthorized = (ready && authenticated && !!activeAddress) || (!!wagmiAddress);
    if (!isAuthorized || !activeAddress) {
      alert("Please connect your wallet first.");
      return;
    }

    if (chain?.id !== baseSepolia.id && switchChainAsync) {
      try {
        await switchChainAsync({ chainId: baseSepolia.id });
      } catch (switchErr) {
        console.error('Failed to switch network:', switchErr);
        alert('Please switch to Base Sepolia in your wallet.');
        return;
      }
    }

    setIsToggling(true);
    try {
      const gasConfig = {};
      if (feeData?.maxFeePerGas) {
        gasConfig.maxFeePerGas = (feeData.maxFeePerGas * 130n) / 100n;
      }
      if (feeData?.maxPriorityFeePerGas) {
        gasConfig.maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * 130n) / 100n;
      }

      console.log(`[toggle_public] Calling toggle_public for memorial #${mem.tokenId}, current isPublic=${localIsPublic}...`);
      const hash = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'toggle_public',
        args: [BigInt(mem.tokenId)],
        account: activeAddress,
        ...(connector ? { connector } : {}),
        ...gasConfig,
      });

      console.log(`[toggle_public] Tx submitted: ${hash}. Awaiting receipt...`);
      if (publicClient && hash) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log(`[toggle_public] Tx confirmed on-chain. Status: ${receipt.status}`);
      }

      // 1. Compute the new value with strict boolean normalization
      const nextVal = !Boolean(localIsPublic);
      console.log(`[toggle_public] Optimistic update: isPublic ${localIsPublic} → ${nextVal}`);

      // 2. Immediately toggle local state so button & badge switch on the fly
      setLocalIsPublic(nextVal);

      // 3. Optimistically update parent memorials list (all key aliases)
      if (typeof onUpdateMemorial === 'function') {
        onUpdateMemorial(mem.tokenId, {
          is_public: nextVal,
          isPublic: nextVal,
        });
      }

      // 4. Delayed background contract refetch — give Base Sepolia RPC nodes
      //    time to propagate the new state, preventing stale cache from
      //    overwriting our optimistic update via the useEffect sync guard.
      if (typeof onRefetch === 'function') {
        setTimeout(() => {
          onRefetch().catch((e) =>
            console.warn('[toggle_public] Background refetch error:', e)
          );
        }, 2500);
      }
    } catch (err) {
      console.error('Failed to toggle visibility:', err);
      const reason = err?.shortMessage || err?.metaMessages?.[0] || err?.message || 'Transaction failed';
      alert(`Failed to update visibility:\n${reason}`);
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <MemorialCard
      tokenId={mem.tokenId}
      petName={mem.petName}
      arweaveUri={mem.arweaveUri}
      arweaveTxId={mem.arweaveTxId}
      createdAt={mem.createdAt}
      ownerAddress={mem.owner}
      isPublic={Boolean(localIsPublic)}
      isHidden={mem.isHidden}
      isBanned={mem.isBanned}
      isFlagged={mem.isFlagged}
      isOwner={true}
      isTogglingVisibility={isToggling}
      onToggleVisibility={handleTogglePublic}
      species={mem.species}
      category={mem.category}
      breed={mem.breed}
      memorial={mem}
      onUpdate={onRefetch}
      candleExpiresAt={candleExpiresAt}
      totalCandlesLit={totalCandlesLit}
    />
  );
}

export default function MyMemorials() {
  const { ready, authenticated, user, login } = usePrivy();
  const { wallets } = useWallets();
  const { 
    address: wagmiAddress, 
    isConnected: isWagmiConnected, 
    isConnecting, 
    isReconnecting 
  } = useAccount();

  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  const address = wagmiAddress || embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;

  // Track if auth/wallet is initializing or reconnecting
  const isAuthLoading = !ready || isConnecting || isReconnecting;
  const isConnected = (authenticated || isWagmiConnected) && Boolean(address);

  const { memorials: allMemorials, isLoading, refetch, updateMemorial } = useMemorials();

  // Defensive filtering for user's memorials
  const userMemorials = useMemo(() => {
    const userAddrLower = address ? String(address).toLowerCase() : '';
    if (!allMemorials || !userAddrLower) return [];
    return allMemorials.filter((m) => {
      if (!m?.owner) return false;
      return String(m.owner).toLowerCase() === userAddrLower;
    });
  }, [allMemorials, address]);

  // While authenticating/reconnecting or loading memorials for connected user, show graceful skeleton
  if (isAuthLoading || (isConnected && isLoading)) {
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6]">
        <div className="max-w-[1200px] mx-auto px-6 md:px-16">
          <h1 className="text-3xl text-[#1b1c1a] mb-8" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
            My Memorials
          </h1>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[0, 1, 2].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Truly unauthenticated state (not connecting, not reconnecting, ready)
  if (!isConnected) {
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="max-w-md w-full text-center p-8 bg-stone-50 border border-stone-200 rounded-[28px] shadow-sm space-y-6">
          <div className="w-16 h-16 rounded-full bg-[#ebddd5] flex items-center justify-center mx-auto text-[#8a4f36] shadow-sm">
            <span className="material-symbols-outlined text-3xl">account_balance_wallet</span>
          </div>
          <div className="space-y-2">
            <h2 className="text-2xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
              Your Pet Memorials
            </h2>
            <p className="text-sm text-[#53433e] leading-relaxed max-w-sm mx-auto">
              Connect your wallet to view, tend, and keep the flame alive for your companions.
            </p>
          </div>
          <div>
            <button
              type="button"
              onClick={login}
              className="inline-flex items-center justify-center gap-2 bg-[#8a4f36] hover:bg-[#723f2b] text-white px-7 py-3.5 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-md cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">login</span>
              <span>Connect Wallet</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (userMemorials.length === 0) {
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-5">
          <div className="w-20 h-20 rounded-full bg-[#ebddd5] flex items-center justify-center mx-auto">
            <span className="material-symbols-outlined text-4xl text-[#8a4f36]">pets</span>
          </div>
          <h2 className="text-2xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>No Memorials Yet</h2>
          <p className="text-sm text-[#53433e]">You haven't created any memorials. Honor a beloved companion today.</p>
          <Link
            to="/create"
            className="inline-flex items-center gap-2 bg-[#8a4f36] text-white px-6 py-3 rounded-2xl text-xs font-semibold uppercase tracking-wider hover:opacity-85 transition-opacity"
          >
            Create Memorial
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6]">
      <div className="max-w-[1200px] mx-auto px-6 md:px-16">
        <h1 className="text-3xl text-[#1b1c1a] mb-8" style={{ fontFamily: "'Libre Caslon Text', serif" }}>My Memorials</h1>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {userMemorials.map((mem) => (
            <MyMemorialItem
              key={mem.tokenId}
              mem={mem}
              onRefetch={refetch}
              onUpdateMemorial={updateMemorial}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
