import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChainId, useWriteContract, useWaitForTransactionReceipt, useAccount, useReadContract, useBalance, useSwitchChain } from 'wagmi';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { formatEther, decodeEventLog } from 'viem';
import { baseSepolia } from 'viem/chains';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress } from '../config/chains';
import {
  uploadToArweave, uploadJsonToArweave, buildNftMetadata,
} from '../utils/arweave';
import ShareModal from './ShareModal';

const SPECIES_OPTIONS = ['Dog', 'Cat', 'Horse', 'Fish', 'Rabbit', 'Hamster', 'Turtle', 'Other'];

const STEPS = ['Basic Info', 'Story', 'Preservation'];

/* ── Minimal underline input ──────────────────────────────── */
const inputBase = 'w-full bg-transparent border-b border-[#d8c2ba] focus:border-[#8a4f36] focus:ring-0 outline-none px-0 py-2 text-[18px] leading-7 text-[#1b1c1a] placeholder-[#85736d] transition-colors';
const labelBase = 'block text-[11px] font-semibold tracking-widest uppercase text-[#53433e] mb-2';

export default function CreateMemorial() {
  const { ready, authenticated, user } = usePrivy();
  const { wallets } = useWallets();
  const chainId = useChainId();
  const navigate = useNavigate();
  const contractAddress = getContractAddress(chainId);
  const { switchChainAsync } = useSwitchChain();

  const embeddedWallet = wallets.find((w) => w.walletClientType === 'privy');
  // Fallback to the first available wallet if not using embedded
  const userAddress = embeddedWallet?.address || user?.wallet?.address || wallets[0]?.address;
  const { address: wagmiAddress, connector, chain } = useAccount();
  const activeUserAddress = wagmiAddress || userAddress;
  const { data: balance } = useBalance({ address: activeUserAddress });
  const isConnected = ready && authenticated;

  // Form state
  const [step, setStep] = useState(0); // Wizard step 0-2
  const [petName, setPetName] = useState('');
  const [species, setSpecies] = useState('');
  const [breed, setBreed] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [memorialDate, setMemorialDate] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [passingYear, setPassingYear] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState(null);
  const [photoPreview, setPhotoPreview] = useState('');
  const [isPublic, setIsPublic] = useState(false);

  // AI Verification State
  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);
  const [detectedPerson, setDetectedPerson] = useState(false);
  const [detectedAnimal, setDetectedAnimal] = useState(true);
  const [humanConsentGiven, setHumanConsentGiven] = useState(false);

  // Submission state
  const [flowStep, setFlowStep] = useState(0); // 0=idle,1=media,2=metadata,3=minting
  const [error, setError] = useState('');
  const [isMinting, setIsMinting] = useState(false);
  const [txHash, setTxHash] = useState(null);
  const [mintedIsPublic, setMintedIsPublic] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);

  const { writeContractAsync } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isReceiptError, data: receipt } = useWaitForTransactionReceipt({ hash: txHash });

  // Decode created memorial tokenId from transaction logs
  const createdTokenId = useMemo(() => {
    if (!receipt?.logs) return null;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: CONTRACT_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'MemorialCreated' && decoded.args?.tokenId !== undefined) {
          return decoded.args.tokenId.toString();
        }
      } catch {
        // Not this event
      }
    }
    return null;
  }, [receipt]);

  // Handle transaction receipt error
  useEffect(() => {
    if (isReceiptError) {
      setError('Transaction reverted on-chain. Please verify and try again.');
      setTxHash(null);
      setIsMinting(false);
      setFlowStep(0);
    }
  }, [isReceiptError]);

  // Draft recovery state
  const [draft, setDraft] = useState(null);

  // Check for saved draft on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('draft_memorial');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.metadataTxId && parsed.petName) {
          setDraft(parsed);
        }
      }
    } catch (err) {
      console.warn('[Draft] Error loading draft:', err);
    }
  }, []);

  // Clear draft on successful transaction confirmation
  useEffect(() => {
    if (isSuccess) {
      localStorage.removeItem('draft_memorial');
      setDraft(null);
    }
  }, [isSuccess]);

  // Read creation_fee from contract
  const { data: creationFeeRaw, refetch: refetchCreationFee } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'creation_fee',
  });
  const creationFee = creationFeeRaw ? BigInt(creationFeeRaw) : 2_000_000_000_000_000n; // fallback 0.002 ETH

  // Read creation_paused from contract (on-chain invariant guard)
  const { data: creationPaused } = useReadContract({
    address: contractAddress,
    abi: CONTRACT_ABI,
    functionName: 'creation_paused',
  });
  const isCreationPaused = Boolean(creationPaused);

  const isInsufficientFunds = Boolean(balance?.value !== undefined && balance.value < creationFee);

  /* ── AI Image Analysis ─────────────────────────────────── */
  const analyzeImage = async (imageFile) => {
    try {
      setIsAnalyzingImage(true);
      setDetectedPerson(false);
      setDetectedAnimal(true);
      setHumanConsentGiven(false);

      // Dynamic import to optimize bundle size
      await import('@tensorflow/tfjs');
      const cocoSsd = await import('@tensorflow-models/coco-ssd');
      const blazeface = await import('@tensorflow-models/blazeface');

      // Create HTMLImageElement to pass to models
      const img = new Image();
      img.src = URL.createObjectURL(imageFile);
      await new Promise((resolve) => { img.onload = resolve; });

      // Run face detector (BlazeFace) + COCO-SSD in parallel
      let faces = [];
      let predictions = [];

      try {
        const faceModel = await blazeface.load();
        faces = await faceModel.estimateFaces(img, false);
      } catch (faceErr) {
        console.warn('[AI Analysis] Face detection warning:', faceErr);
      }

      try {
        const objectModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
        predictions = await objectModel.detect(img);
      } catch (objErr) {
        console.warn('[AI Analysis] Object detection warning:', objErr);
      }

      const animalClasses = ['cat', 'dog', 'bird', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'];
      const hasPerson = (faces && faces.length > 0) || predictions.some(p => p.class === 'person' && p.score > 0.35);
      const hasAnimal = predictions.some(p => animalClasses.includes(p.class) && p.score > 0.20);

      setDetectedPerson(hasPerson);
      setDetectedAnimal(hasAnimal);
    } catch (err) {
      console.error('[AI Analysis] Error:', err);
      // On ML error do not block user — set default values
      setDetectedPerson(false);
      setDetectedAnimal(true);
    } finally {
      setIsAnalyzingImage(false);
    }
  };

  /* ── Photo handlers ────────────────────────────────────── */
  const handlePhotoSelect = useCallback((file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError('Photo must be under 10 MB'); return; }
    setPhoto(file);
    setPhotoPreview(URL.createObjectURL(file));
    setError('');
    analyzeImage(file);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('border-[#8a4f36]');
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('image/')) handlePhotoSelect(file);
  }, [handlePhotoSelect]);

  /* ── Submit flow: Arweave upload → mint ──────────────── */
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isConnected) { setError('Please connect your wallet first'); return; }
    if (!connector) {
      console.error("Wallet connector is missing or Privy was blocked.");
      setError("Wallet connection failed. Please disable your adblocker or reconnect your wallet.");
      return;
    }
    if (!petName.trim()) { setError('Pet name is required'); return; }
    if (detectedPerson && !humanConsentGiven) {
      setError('Please confirm consent for the person detected in the photo');
      return;
    }
    if (isCreationPaused) {
      setError('Memorial creation is temporarily paused by the protocol. Please try again later.');
      return;
    }
    if (isInsufficientFunds) {
      setError('Insufficient ETH Balance to mint memorial.');
      return;
    }
    if (chain?.id !== baseSepolia.id) {
      try {
        await switchChainAsync({ chainId: baseSepolia.id });
      } catch (switchErr) {
        console.error('[CreateMemorial] Failed to switch network:', switchErr);
        setError('Please switch your wallet network to Base Sepolia to continue.');
        return;
      }
    }
    setError('');

    try {
      setFlowStep(1);
      let imageTxId = '';
      if (photo) imageTxId = await uploadToArweave(photo, [{ name: 'Pet-Name', value: petName }]);

      setFlowStep(2);
      const metadata = buildNftMetadata({ petName, description, birthDate, memorialDate, birthYear, passingYear, species, breed, imageTxId, ownerAddress: userAddress });
      const metadataTxId = await uploadJsonToArweave(metadata);

      // Save draft immediately after Arweave metadata upload succeeds
      const draftData = {
        metadataTxId,
        petName,
        isPublic,
        photoPreview,
        createdAt: Date.now(),
      };
      localStorage.setItem('draft_memorial', JSON.stringify(draftData));
      setDraft(draftData);

      setFlowStep(3);
      setIsMinting(true);
      setMintedIsPublic(Boolean(isPublic));
      console.log('[CreateMemorial] Triggering writeContractAsync...');

      // Fetch latest creation fee dynamically to guarantee sending the exact amount required by the contract
      let currentFee = creationFee;
      try {
        const { data: latestFee } = await refetchCreationFee();
        if (latestFee) currentFee = BigInt(latestFee);
      } catch (fErr) {
        console.warn('[CreateMemorial] Failed to refetch latest fee, using cached:', fErr);
      }

      const hash = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'create_memorial',
        args: [petName, metadataTxId, isPublic],
        value: currentFee,
        account: userAddress,
        connector,
        chainId: baseSepolia.id,
      });

      console.log('[CreateMemorial] Success Tx Hash:', hash);
      // Immediately clear local draft upon receiving tx hash to prevent duplicate submissions
      localStorage.removeItem('draft_memorial');
      setDraft(null);
      setTxHash(hash);
    } catch (err) {
      console.error('[CreateMemorial] Minting error:', err);
      let errMsg = err.shortMessage || err.message || 'Something went wrong';
      if (errMsg.includes('Exact creation fee required')) {
        errMsg = 'The exact creation fee is required by the contract. The fee has been refreshed, please try again.';
        refetchCreationFee();
      }
      setError(`Minting failed: ${errMsg}`);
      alert(`Minting failed: ${errMsg}`);
      setIsMinting(false);
      setFlowStep(0);
    }
  };

  /* ── Resume draft flow ─────────────────────────────────── */
  const handleResumeDraft = async (targetDraft = draft) => {
    if (!targetDraft || !targetDraft.metadataTxId) return;
    if (isSubmitting) return; // Prevent double mint click
    if (!isConnected) { setError('Please connect your wallet first'); return; }
    if (!connector) {
      setError("Wallet connection failed. Please disable your adblocker or reconnect your wallet.");
      return;
    }
    if (isCreationPaused) {
      setError('Memorial creation is temporarily paused by the protocol. Please try again later.');
      return;
    }
    if (isInsufficientFunds) {
      setError('Insufficient ETH Balance to mint memorial.');
      return;
    }
    if (chain?.id !== baseSepolia.id) {
      try {
        await switchChainAsync({ chainId: baseSepolia.id });
      } catch (switchErr) {
        console.error('[CreateMemorial] Failed to switch network:', switchErr);
        setError('Please switch your wallet network to Base Sepolia to continue.');
        return;
      }
    }
    setError('');

    try {
      setFlowStep(3);
      setIsMinting(true);
      if (targetDraft.petName) setPetName(targetDraft.petName);
      const draftPublic = Boolean(targetDraft.isPublic ?? false);
      setIsPublic(draftPublic);
      setMintedIsPublic(draftPublic);

      // Fetch latest creation fee dynamically to guarantee sending the exact amount required by the contract
      let currentFee = creationFee;
      try {
        const { data: latestFee } = await refetchCreationFee();
        if (latestFee) currentFee = BigInt(latestFee);
      } catch (fErr) {
        console.warn('[CreateMemorial] Failed to refetch latest fee, using cached:', fErr);
      }

      const hash = await writeContractAsync({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'create_memorial',
        args: [targetDraft.petName, targetDraft.metadataTxId, draftPublic],
        value: currentFee,
        account: userAddress,
        connector,
        chainId: baseSepolia.id,
      });

      console.log('[CreateMemorial] Resumed Tx Hash:', hash);
      // Immediately clear local draft upon receiving tx hash to prevent duplicate submissions
      localStorage.removeItem('draft_memorial');
      setDraft(null);
      setTxHash(hash);
    } catch (err) {
      console.error('[CreateMemorial] Resume minting error:', err);
      let errMsg = err.shortMessage || err.message || 'Something went wrong';
      if (errMsg.includes('Exact creation fee required')) {
        errMsg = 'The exact creation fee is required by the contract. The fee has been refreshed, please try again.';
        refetchCreationFee();
      }
      setError(`Minting failed: ${errMsg}`);
      setIsMinting(false);
      setFlowStep(0);
    }
  };

  const handleDiscardDraft = () => {
    localStorage.removeItem('draft_memorial');
    setDraft(null);
  };

  const isEOA = connector?.name && !connector.name.toLowerCase().includes('privy');

  const isSubmitting = flowStep > 0 || isMinting || isConfirming || (Boolean(txHash) && !isSuccess);

  /* ── Success screen ────────────────────────────────────── */
  if (isSuccess) {
    const isPublicTribute = Boolean(mintedIsPublic);
    const memorialTargetUrl = createdTokenId ? `/memorial/${createdTokenId}` : '/my';
    const memorialShareUrl = createdTokenId
      ? `${typeof window !== 'undefined' ? window.location.origin : ''}/#/memorial/${createdTokenId}`
      : (typeof window !== 'undefined' ? window.location.href : '');

    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="max-w-lg w-full text-center space-y-6 bg-white/80 backdrop-blur-sm border border-[#e0d0c7] p-8 md:p-10 rounded-[32px] shadow-sm animate-fadeIn">
          <div className="w-20 h-20 rounded-full bg-[#ebddd5] flex items-center justify-center mx-auto shadow-inner text-[#8a4f36]">
            <span className="material-symbols-outlined text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>
              favorite
            </span>
          </div>

          <div className="space-y-2">
            <h2 className="text-3xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
              Memorial Created
            </h2>
            {petName && (
              <p className="text-xs uppercase tracking-widest text-[#8a4f36] font-semibold">
                For {petName}
              </p>
            )}
          </div>

          {isPublicTribute ? (
            <p className="text-[#53433e] text-sm md:text-base leading-relaxed max-w-md mx-auto">
              Memorial preserved on-chain! Your tribute is now visible in the public sanctuary.
            </p>
          ) : (
            <div className="space-y-3 max-w-md mx-auto">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold uppercase tracking-wider">
                <span className="material-symbols-outlined text-sm">lock</span>
                <span>Private / Unlisted</span>
              </div>
              <p className="text-[#53433e] text-sm md:text-base leading-relaxed">
                Memorial preserved on-chain! As a private tribute, it will not appear in the public gallery. Access is exclusive via direct link or QR code.
              </p>
            </div>
          )}

          {/* Action buttons */}
          <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
            {isPublicTribute ? (
              <>
                <button
                  type="button"
                  onClick={() => navigate(memorialTargetUrl)}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#8a4f36] text-white px-7 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider hover:opacity-90 transition-opacity shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">visibility</span>
                  <span>View Memorial</span>
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/')}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 border border-[#d8c2ba] text-[#53433e] hover:bg-[#f5efe6] px-7 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">explore</span>
                  <span>Browse Gallery</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate(memorialTargetUrl)}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-[#8a4f36] text-white px-7 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider hover:opacity-90 transition-opacity shadow-sm cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">arrow_forward</span>
                  <span>Open Memorial</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowShareModal(true)}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-2 border border-[#d8c2ba] bg-[#fbf5f2] text-[#8a4f36] hover:bg-[#f3ebe4] hover:text-[#2C2520] px-7 py-3.5 rounded-2xl text-xs font-semibold uppercase tracking-wider transition-colors shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-base">qr_code_2</span>
                  <span>Share / Get QR Code</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Share Modal for Unlisted Memorial QR Code */}
        <ShareModal
          isOpen={showShareModal}
          onClose={() => setShowShareModal(false)}
          petName={petName}
          memorialId={createdTokenId || ''}
          url={memorialShareUrl}
        />
      </div>
    );
  }

  /* ── Not connected ─────────────────────────────────────── */
  if (!isConnected) {
    return (
      <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6] flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-5">
          <span className="material-symbols-outlined text-5xl text-[#d8c2ba]">account_balance_wallet</span>
          <h2 className="text-2xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>Connect Your Wallet</h2>
          <p className="text-[#53433e] text-sm">Please connect your wallet to create a memorial.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-28 md:pt-32 pb-16 min-h-screen bg-[#fbf9f6]">
      <div className="max-w-2xl mx-auto px-6 md:px-0">
        {/* Progress bar */}
        <div className="mb-10">
          <div className="flex justify-between items-end mb-3">
            <h1 className="text-3xl text-[#1b1c1a]" style={{ fontFamily: "'Libre Caslon Text', serif" }}>
              Begin the Memorial
            </h1>
            <span className="text-xs font-semibold tracking-widest uppercase text-[#85736d]">
              Step {step + 1} of {STEPS.length}: {STEPS[step]}
            </span>
          </div>
          <div className="w-full h-1 bg-[#e4e2df] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#8a4f36] rounded-full transition-all duration-500"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Draft recovery banner */}
        {draft && (
          <div className="mb-6 bg-[#fffbf2] border border-[#e8d5b7] rounded-2xl p-4 md:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm animate-fadeIn">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-[#8a4f36] text-2xl shrink-0 mt-0.5">restore_page</span>
              <div>
                <h4 className="text-sm font-semibold text-[#1b1c1a]">Unfinished Memorial Found</h4>
                <p className="text-xs text-[#53433e] mt-0.5 leading-relaxed">
                  Arweave preservation record for <span className="font-semibold italic">{draft.petName}</span> is saved on your device. Skip media re-upload and complete the on-chain minting.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto justify-end shrink-0">
              <button
                type="button"
                onClick={handleDiscardDraft}
                disabled={isSubmitting}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold text-[#85736d] hover:bg-[#ebdcd1]/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => handleResumeDraft(draft)}
                disabled={isSubmitting || isInsufficientFunds || isCreationPaused}
                className="px-4 py-2 rounded-xl text-xs font-semibold uppercase tracking-wider bg-[#8a4f36] text-white hover:opacity-90 transition-opacity shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>{isConfirming || txHash ? 'Confirming…' : 'Minting…'}</span>
                  </>
                ) : (
                  <>
                    <span>
                      {isCreationPaused
                        ? 'Creation Paused'
                        : isInsufficientFunds
                          ? `Insufficient ETH (${formatEther(creationFee)} ETH required)`
                          : 'Resume Minting'}
                    </span>
                    {!isInsufficientFunds && !isCreationPaused && (
                      <span className="material-symbols-outlined text-sm">arrow_forward</span>
                    )}
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Upload flow progress (during submission) */}
        {isSubmitting && (
          <div className="mb-6 bg-[#f5f3f0] rounded-2xl p-4 flex flex-col gap-2">
            {[
              { n: 1, label: 'Uploading photo to Arweave' },
              { n: 2, label: 'Uploading metadata to Arweave' },
              { n: 3, label: 'Minting on-chain' },
            ].map(({ n, label }) => (
              <div key={n} className={`flex items-center gap-3 text-sm ${flowStep >= n ? 'text-[#8a4f36]' : 'text-[#85736d]'}`}>
                {flowStep > n
                  ? <span className="material-symbols-outlined text-base text-[#8a4f36]">check_circle</span>
                  : flowStep === n
                    ? <span className="inline-block w-4 h-4 border-2 border-[#8a4f36] border-t-transparent rounded-full animate-spin" />
                    : <span className="w-4 h-4 rounded-full border border-[#d8c2ba] inline-block" />
                }
                {label}
              </div>
            ))}
          </div>
        )}

        {isCreationPaused && (
          <div className="mb-6 bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-sm text-amber-800 flex items-center gap-2">
            <span>⏸️ Memorial creation is temporarily paused by the protocol.</span>
          </div>
        )}

        {error && (
          <div className="mb-6 bg-[#ffdad6] border border-[#ba1a1a]/20 rounded-xl px-4 py-3 text-sm text-[#93000a]">
            {error}
          </div>
        )}

        {/* ── WIZARD STEP 0: Basic Info ── */}
        {step === 0 && (
          <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-8 space-y-8">
            {/* Photo drop zone */}
            <div>
              <label className={labelBase}>Pet Portrait</label>
              {photoPreview ? (
                <div className="space-y-3">
                  <div className="relative rounded-2xl overflow-hidden">
                    <img src={photoPreview} alt="Preview" className="w-full max-h-64 object-cover" />
                    <button
                      type="button"
                      onClick={() => {
                        setPhoto(null);
                        setPhotoPreview('');
                        setDetectedPerson(false);
                        setDetectedAnimal(true);
                        setHumanConsentGiven(false);
                      }}
                      className="absolute top-3 right-3 bg-white/80 backdrop-blur-sm text-[#1b1c1a] w-8 h-8 rounded-full flex items-center justify-center hover:bg-white transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  </div>

                  {/* AI Analysis Indicator */}
                  {isAnalyzingImage && (
                    <div className="bg-[#fcf8f5] border border-[#d8c2ba]/40 rounded-xl p-3 flex items-center gap-2.5 text-xs text-[#8a4f36]">
                      <span className="inline-block w-3.5 h-3.5 border-2 border-[#8a4f36] border-t-transparent rounded-full animate-spin" />
                      <span className="font-medium">AI checking image background...</span>
                    </div>
                  )}

                  {/* Human Detection Consent Checkbox */}
                  {!isAnalyzingImage && detectedPerson && (
                    <div className="bg-[#fff8f6] border border-[#d8c2ba] rounded-xl p-4 flex items-start gap-3">
                      <input
                        type="checkbox"
                        id="humanConsent"
                        checked={humanConsentGiven}
                        onChange={(e) => setHumanConsentGiven(e.target.checked)}
                        className="mt-1 accent-[#8a4f36] cursor-pointer w-4 h-4"
                      />
                      <label htmlFor="humanConsent" className="text-xs text-[#53433e] leading-relaxed cursor-pointer">
                        <span className="font-semibold text-[#1b1c1a] block mb-0.5">On-chain Privacy Notice</span>
                        A person was detected in this photo. I confirm I have explicit consent to publish their image permanently on Arweave.
                      </label>
                    </div>
                  )}

                  {/* Animal Detection Info Notice */}
                  {!isAnalyzingImage && !detectedAnimal && (
                    <div className="bg-[#fffdfa] border border-[#e4d3c3] rounded-xl p-4 flex items-start gap-3 text-xs text-[#53433e]">
                      <span className="material-symbols-outlined text-[#d48c6f] text-base shrink-0 mt-0.5">info</span>
                      <p>
                        We couldn't automatically detect a pet in this image (e.g., if it's a silhouette, paw print, or memorial object). That is completely fine — feel free to proceed if this is the photo you want.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  className="w-full h-40 border-2 border-dashed border-[#d8c2ba]/60 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-[#f5f3f0] hover:border-[#8a4f36]/40 transition-colors group"
                  onDrop={handleDrop}
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-[#8a4f36]'); }}
                  onDragLeave={(e) => e.currentTarget.classList.remove('border-[#8a4f36]')}
                  onClick={() => document.getElementById('photo-input').click()}
                >
                  <span className="material-symbols-outlined text-4xl text-[#d8c2ba] group-hover:text-[#8a4f36] transition-colors mb-2">add_photo_alternate</span>
                  <p className="text-sm text-[#53433e]">Drag a photo here, or <span className="text-[#8a4f36] underline">browse</span></p>
                  <p className="text-xs text-[#85736d] mt-1">JPG or PNG · max 10 MB</p>
                  <input id="photo-input" type="file" accept="image/*" className="hidden" onChange={(e) => handlePhotoSelect(e.target.files[0])} />
                </div>
              )}
            </div>

            {/* Pet name */}
            <div>
              <label className={labelBase} htmlFor="petName">Pet Name *</label>
              <input
                className={inputBase} id="petName" type="text"
                value={petName} onChange={(e) => setPetName(e.target.value)}
                placeholder="e.g. Luna" maxLength={128}
              />
            </div>

            {/* Species + Breed */}
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className={labelBase}>Species</label>
                <select className={`${inputBase} cursor-pointer`} value={species} onChange={(e) => setSpecies(e.target.value)}>
                  <option value="">Select…</option>
                  {SPECIES_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className={labelBase}>Breed</label>
                <input className={inputBase} type="text" value={breed} onChange={(e) => setBreed(e.target.value)} placeholder="e.g. Beagle" />
              </div>
            </div>
          </div>
        )}

        {/* ── WIZARD STEP 1: Story ── */}
        {step === 1 && (
          <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-8 space-y-8">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className={labelBase}>Birth Date</label>
                <input className={inputBase} type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Memorial Date</label>
                <input className={inputBase} type="date" value={memorialDate} onChange={(e) => setMemorialDate(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Birth Year (if exact date unknown)</label>
                <input className={inputBase} type="number" placeholder="e.g. 2012" value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
              </div>
              <div>
                <label className={labelBase}>Passing Year (if exact date unknown)</label>
                <input className={inputBase} type="number" placeholder="e.g. 2024" value={passingYear} onChange={(e) => setPassingYear(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={labelBase} htmlFor="bio">A Brief Memory</label>
              <textarea
                id="bio" rows={5}
                className="w-full bg-[#fbf9f6] border border-[#d8c2ba]/40 rounded-xl p-4 text-base text-[#1b1c1a] placeholder-[#85736d] focus:border-[#8a4f36] focus:ring-1 focus:ring-[#8a4f36] outline-none transition-all resize-none"
                placeholder="Tell us about their favourite toy, habit, or memory…"
                value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))}
              />
              <p className="text-right text-xs text-[#85736d] mt-1">{description.length}/500</p>
            </div>
          </div>
        )}

        {/* ── WIZARD STEP 2: Preservation (review + mint) ── */}
        {step === 2 && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-8 space-y-4">
              <h3 className="text-xl text-[#1b1c1a] mb-2" style={{ fontFamily: "'Libre Caslon Text', serif" }}>Review your Memorial</h3>
              {photoPreview && <img src={photoPreview} alt="Preview" className="w-full max-h-48 object-cover rounded-xl" />}
              <div className="space-y-2 text-sm text-[#53433e]">
                <p><span className="font-semibold text-[#1b1c1a]">Name:</span> {petName || '—'}</p>
                {species && <p><span className="font-semibold text-[#1b1c1a]">Species:</span> {species}{breed ? ` · ${breed}` : ''}</p>}
                {(birthDate || memorialDate) && (
                  <p><span className="font-semibold text-[#1b1c1a]">Dates:</span> {birthDate || '?'} – {memorialDate || '?'}</p>
                )}
                {description && <p className="italic leading-relaxed">"{description}"</p>}
                <p><span className="font-semibold text-[#1b1c1a]">Visibility:</span> {isPublic ? 'Public Gallery' : 'Unlisted (Private)'}</p>
                <p><span className="font-semibold text-[#1b1c1a]">Creation Fee:</span> {formatEther(creationFee)} ETH</p>
              </div>
            </div>

            {/* Chain preservation & wallet notice */}
            <div className="bg-[#f5f3f0] rounded-2xl border border-[#d8c2ba]/20 p-5 flex gap-4 items-start">
              <span className="material-symbols-outlined text-[#8a4f36] mt-0.5">link</span>
              <div>
                <p className="text-xs font-semibold tracking-widest uppercase text-[#8a4f36] mb-1">Eternal Provenance</p>
                <p className="text-sm text-[#53433e] leading-relaxed">
                  Photo and metadata will be uploaded to Arweave, then the memorial NFT will be minted on Base as a soulbound token. This is permanent.
                </p>
                {isEOA && (
                  <p className="text-xs text-[#85736d] mt-2 border-t border-[#d8c2ba]/30 pt-2 flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm text-[#8a4f36]">info</span>
                    <span><strong className="font-semibold">{connector?.name || 'External Wallet'} connected:</strong> You will be asked to confirm 1 on-chain transaction after Arweave preservation completes.</span>
                  </p>
                )}
              </div>
            </div>

            {/* Privacy Toggle */}
            <div className="bg-white rounded-2xl border border-[#d8c2ba]/30 p-6 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex-1 pr-4">
                  <label className="block text-[11px] font-semibold tracking-widest uppercase text-[#53433e] mb-1">Show in public gallery</label>
                  <p className="text-sm text-[#85736d]">Allow others to discover this memorial</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isPublic}
                  onClick={() => setIsPublic(!isPublic)}
                  className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 ${
                    isPublic ? 'bg-[#8a4f36]' : 'bg-[#d8c2ba]'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform duration-200 ${
                      isPublic ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
              <p className="text-[11px] text-[#85736d] italic leading-relaxed">
                If disabled, the memorial will appear only in your personal dashboard and be accessible via a direct link.
                Note: data on Arweave is permanent — hiding removes the card from the site catalog but does not encrypt it on the blockchain.
              </p>
            </div>

            <form onSubmit={handleSubmit}>
              <button
                type="submit"
                disabled={isSubmitting || !petName.trim() || isInsufficientFunds || isCreationPaused}
                className="w-full flex items-center justify-center gap-3 bg-[#d48c6f] text-white py-4 rounded-2xl text-sm font-semibold tracking-wider uppercase hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? (
                  <>
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>{isConfirming || txHash ? 'Confirming on-chain…' : 'Minting…'}</span>
                  </>
                ) : isCreationPaused ? (
                  <><span>Memorial Creation Paused</span></>
                ) : isInsufficientFunds ? (
                  <><span>Insufficient ETH Balance ({formatEther(creationFee)} ETH required)</span></>
                ) : (
                  <><span>Preserve Forever ({formatEther(creationFee)} ETH)</span><span className="material-symbols-outlined text-base">arrow_forward</span></>
                )}
              </button>
            </form>
          </div>
        )}

        {/* ── Navigation ── */}
        {!isSubmitting && (
          <div className="flex justify-between items-center pt-6 border-t border-[#d8c2ba]/30 mt-6">
            <button
              type="button"
              onClick={() => step > 0 ? setStep(s => s - 1) : navigate(-1)}
              className="px-6 py-3 border border-[#665d56] text-[#665d56] rounded-2xl text-xs font-semibold tracking-widest uppercase hover:bg-[#efeeeb] transition-colors"
            >
              Back
            </button>
            {step < 2 && (
              <button
                type="button"
                onClick={() => {
                  if (step === 0) {
                    if (!petName.trim()) { setError('Pet name is required'); return; }
                    if (isAnalyzingImage) { setError('AI image analysis in progress...'); return; }
                    if (detectedPerson && !humanConsentGiven) {
                      setError('Please confirm consent for the detected person in the photo');
                      return;
                    }
                  }
                  setError('');
                  setStep(s => s + 1);
                }}
                disabled={isAnalyzingImage || (step === 0 && detectedPerson && !humanConsentGiven)}
                className="flex items-center gap-2 bg-[#d48c6f] text-white px-8 py-3 rounded-2xl text-xs font-semibold tracking-widest uppercase hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>Continue</span>
                <span className="material-symbols-outlined text-base">arrow_forward</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
