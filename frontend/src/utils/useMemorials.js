import { useState, useEffect, useCallback } from 'react';
import { usePublicClient, useChainId } from 'wagmi';
import { CONTRACT_ABI } from '../config/contract';
import { getContractAddress } from '../config/chains';
import { getArweaveUrl } from './arweave';

/**
 * Normalizes any Arweave URI (raw txId, ar://, or http/https) into a fetchable gateway URL.
 */
function resolveArweaveFetchUrl(uri) {
  if (!uri) return '';
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  if (uri.startsWith('ar://')) {
    return getArweaveUrl(uri.slice(5));
  }
  return getArweaveUrl(uri);
}

export function useMemorials() {
  const chainId = useChainId();
  const contractAddress = getContractAddress(chainId);
  const publicClient = usePublicClient();

  const [memorials, setMemorials] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const updateMemorial = useCallback((tokenId, patch) => {
    setMemorials((prev) =>
      prev.map((item) => (Number(item.tokenId) === Number(tokenId) ? { ...item, ...patch } : item))
    );
  }, []);

  const fetchMemorials = useCallback(async () => {
    if (!publicClient || !contractAddress) {
      setIsLoading(false);
      return;
    }
    setMemorials((prev) => {
      if (!prev || prev.length === 0) setIsLoading(true);
      return prev;
    });
    setError(null);

    try {
      const countBigInt = await publicClient.readContract({
        address: contractAddress,
        abi: CONTRACT_ABI,
        functionName: 'memorial_count',
      });

      const count = Number(countBigInt || 0);
      console.log('📊 Total Memorials Count:', count);

      const fetchSingleMemorial = async (i) => {
        try {
          const raw = await publicClient.readContract({
            address: contractAddress,
            abi: CONTRACT_ABI,
            functionName: 'memorials',
            args: [BigInt(i)],
          });

          if (!raw) return null;

          // Safe property extraction (works for Array/Tuple and Object)
          const owner = Array.isArray(raw) ? raw[0] : (raw.owner || '');
          const arweaveUri = Array.isArray(raw) ? raw[1] : (raw.arweave_uri || raw.arweaveUri || raw.arweaveTxId || '');
          const petName = Array.isArray(raw) ? raw[2] : (raw.pet_name || raw.petName || '');
          const createdAt = Array.isArray(raw) ? Number(raw[3] || 0) : Number(raw.created_at || raw.createdAt || 0);
          const isPublic = Array.isArray(raw) ? Boolean(raw[4]) : Boolean(raw.is_public ?? raw.isPublic);
          const isHiddenStruct = Array.isArray(raw) ? Boolean(raw[5]) : Boolean(raw.is_hidden ?? raw.isHidden);
          const isBannedStruct = Array.isArray(raw) ? Boolean(raw[6]) : Boolean(raw.is_banned ?? raw.isBanned);

          const rawMemorial = {
            owner,
            arweaveUri,
            petName,
            createdAt,
            isPublic,
            isHidden: isHiddenStruct,
            isBanned: isBannedStruct,
            category: 'other',
          };

          let isVisible = isPublic && !isHiddenStruct && !isBannedStruct;
          try {
            isVisible = await publicClient.readContract({
              address: contractAddress,
              abi: CONTRACT_ABI,
              functionName: 'is_memorial_visible',
              args: [BigInt(i)],
            });
          } catch (e) {
            console.warn(`Failed to check visible status for #${i}:`, e);
          }

          let isHidden = isHiddenStruct || isBannedStruct;
          try {
            isHidden = await publicClient.readContract({
              address: contractAddress,
              abi: CONTRACT_ABI,
              functionName: 'is_memorial_hidden',
              args: [BigInt(i)],
            });
          } catch (e) {
            console.warn(`Failed to check hide status for #${i}:`, e);
          }

          let isFlagged = false;
          try {
            isFlagged = await publicClient.readContract({
              address: contractAddress,
              abi: CONTRACT_ABI,
              functionName: 'is_memorial_flagged',
              args: [BigInt(i)],
            });
          } catch (e) {
            console.warn(`Failed to check flag status for #${i}:`, e);
          }

          // Safe Arweave Metadata Fetch
          let metadata = null;
          let photoUrl = null;
          let story = '';
          let species = 'companion';
          let breed = '';
          let category = rawMemorial.category || 'other';
          let isMetadataLoaded = false;
          let isMetadataLoading = false;

          if (arweaveUri) {
            isMetadataLoading = true;
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
            try {
              const fetchUrl = resolveArweaveFetchUrl(arweaveUri);
              const res = await fetch(fetchUrl, {
                ...(controller ? { signal: controller.signal } : {}),
              });
              if (timer) clearTimeout(timer);

              if (res.ok) {
                metadata = await res.json();
                photoUrl = metadata?.image || metadata?.photo_url || metadata?.photoUrl || null;
                story = metadata?.description || metadata?.story || metadata?.epitaph || '';
                const attrs = Array.isArray(metadata?.attributes) ? metadata.attributes : [];
                const findAttr = (trait) => attrs.find((a) => a.trait_type === trait)?.value;
                const attrSpecies = findAttr('Species');
                const attrBreed = findAttr('Breed');
                species = metadata?.species || attrSpecies || 'companion';
                breed = metadata?.breed || attrBreed || '';
                category = metadata?.category || (species && species.toLowerCase() !== 'companion' ? species.toLowerCase() : rawMemorial.category || 'other');
                isMetadataLoaded = true;
              } else {
                console.warn(`[useMemorials] HTTP ${res.status} fetching Arweave metadata for #${i}: ${fetchUrl}`);
                photoUrl = null;
                story = 'Metadata temporarily unavailable';
                species = 'companion';
                breed = '';
                category = rawMemorial.category || 'other';
                isMetadataLoaded = true;
              }
            } catch (fetchErr) {
              if (timer) clearTimeout(timer);
              console.warn(`[useMemorials] Network error fetching Arweave metadata for #${i}:`, fetchErr);
              photoUrl = null;
              story = 'Metadata temporarily unavailable';
              species = 'companion';
              breed = '';
              category = rawMemorial.category || 'other';
              isMetadataLoaded = true;
            } finally {
              isMetadataLoading = false;
            }
          } else {
            isMetadataLoaded = true;
            isMetadataLoading = false;
          }

          return {
            id: i,
            tokenId: i,
            owner: String(owner || ''),
            arweave_uri: String(arweaveUri || ''),
            arweaveUri: String(arweaveUri || ''),
            pet_name: String(petName || ''),
            petName: String(petName || ''),
            photo_url: photoUrl,
            photoUrl: photoUrl,
            image: photoUrl,
            story: story || (metadata ? '' : 'Metadata temporarily unavailable'),
            description: story || (metadata ? '' : 'Metadata temporarily unavailable'),
            metadata,
            category: category || rawMemorial.category || 'other',
            species: species || 'companion',
            breed: breed || '',
            isMetadataLoaded: true,
            isMetadataLoading: false,
            isMetaLoading: false,
            isLoadingMetadata: false,
            created_at: Number(createdAt || 0),
            createdAt: Number(createdAt || 0),
            is_public: Boolean(isPublic),
            isPublic: Boolean(isPublic),
            is_hidden: Boolean(isHiddenStruct),
            is_banned: Boolean(isBannedStruct),
            isBanned: Boolean(isBannedStruct),
            isHidden: Boolean(isHidden),
            isVisible: Boolean(isVisible),
            isFlagged: Boolean(isFlagged),
          };
        } catch (itemErr) {
          console.error(`[useMemorials] Error loading memorial #${i}:`, itemErr);
          const rawMemorial = { category: 'other' };
          // Safe fallback memorial object on failure
          return {
            id: i,
            tokenId: i,
            owner: '',
            arweave_uri: '',
            arweaveUri: '',
            pet_name: `Memorial #${i}`,
            petName: `Memorial #${i}`,
            photo_url: null,
            photoUrl: null,
            image: null,
            story: 'Metadata temporarily unavailable',
            description: 'Metadata temporarily unavailable',
            metadata: null,
            category: rawMemorial.category || 'other',
            species: 'companion',
            breed: '',
            isMetadataLoaded: true,
            isMetadataLoading: false,
            isMetaLoading: false,
            isLoadingMetadata: false,
            created_at: 0,
            createdAt: 0,
            is_public: false,
            isPublic: false,
            is_hidden: false,
            is_banned: false,
            isBanned: false,
            isHidden: false,
            isVisible: false,
            isFlagged: false,
          };
        }
      };

      const promises = [];
      for (let i = 1; i <= count; i++) {
        promises.push(fetchSingleMemorial(i));
      }

      const results = await Promise.allSettled(promises);
      const list = results
        .filter((r) => r.status === 'fulfilled' && r.value !== null)
        .map((r) => r.value);

      setMemorials(list);
    } catch (err) {
      console.error('Error fetching memorials:', err);
      setError(err);
      setMemorials([]);
    } finally {
      setIsLoading(false);
    }
  }, [publicClient, contractAddress]);

  useEffect(() => {
    fetchMemorials();
  }, [fetchMemorials]);

  return { memorials, isLoading, error, refetch: fetchMemorials, updateMemorial };
}
