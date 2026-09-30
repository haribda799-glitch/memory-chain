/**
 * Universal safe normalizer for Vyper 0.4.3 Memorial struct.
 * Handles both Tuple/Array responses and Object responses from Viem/Wagmi.
 * Converts BigInt fields (createdAt, id) to primitive JavaScript numbers to prevent React rendering crashes.
 */
export const parseMemorial = (rawMemorial, id = 0) => {
  if (!rawMemorial) return null;

  try {
    // If response is a Tuple/Array from Vyper struct output
    if (Array.isArray(rawMemorial)) {
      const arweaveUri = String(rawMemorial[1] || '');
      const petName = String(rawMemorial[2] || '');
      const createdAt = rawMemorial[3] ? Number(rawMemorial[3]) : 0;
      const isPublic = Boolean(rawMemorial[4]);
      const isHidden = Boolean(rawMemorial[5]);
      const isBanned = Boolean(rawMemorial[6]);

      return {
        id: Number(id),
        tokenId: Number(id),
        owner: String(rawMemorial[0] || ''),
        arweave_uri: arweaveUri,
        arweaveUri,
        pet_name: petName,
        petName,
        created_at: createdAt,
        createdAt,
        is_public: isPublic,
        isPublic,
        is_hidden: isHidden,
        isHidden,
        is_banned: isBanned,
        isBanned,
      };
    }

    // If response is a named Object from Viem decoding
    const arweaveUri = String(rawMemorial.arweave_uri || rawMemorial.arweaveUri || rawMemorial.arweaveTxId || '');
    const petName = String(rawMemorial.pet_name || rawMemorial.petName || '');
    const createdAt = rawMemorial.created_at ? Number(rawMemorial.created_at) : (rawMemorial.createdAt ? Number(rawMemorial.createdAt) : 0);
    const isPublic = Boolean(rawMemorial.is_public ?? rawMemorial.isPublic);
    const isHidden = Boolean(rawMemorial.is_hidden ?? rawMemorial.isHidden);
    const isBanned = Boolean(rawMemorial.is_banned ?? rawMemorial.isBanned);

    return {
      id: Number(id),
      tokenId: Number(id),
      owner: String(rawMemorial.owner || ''),
      arweave_uri: arweaveUri,
      arweaveUri,
      pet_name: petName,
      petName,
      created_at: createdAt,
      createdAt,
      is_public: isPublic,
      isPublic,
      is_hidden: isHidden,
      isHidden,
      is_banned: isBanned,
      isBanned,
    };
  } catch (err) {
    console.error('[parseMemorial] Error normalizing memorial struct:', err);
    return null;
  }
};
