// ============================================================
// On-chain mint deduplication for create_memorial
// ============================================================
//
// Mobile wallets (MetaMask over WalletConnect on Android) often sign AND broadcast the
// transaction but lose the response when the user switches back to the browser, surfacing
// "An unknown RPC error occurred." to the dApp. Before ever sending a second create_memorial
// for the same Arweave metadata upload, we look the upload up on-chain.

const DEFAULT_LOG_LOOKBACK_BLOCKS = 3000n; // ~100 minutes on Base Sepolia (2s blocks)
const DEFAULT_SCAN_LAST_MEMORIALS = 60;

function sameAddress(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

function readMemorialFields(raw) {
  if (!raw) return { owner: '', arweaveUri: '' };
  if (Array.isArray(raw)) return { owner: raw[0], arweaveUri: raw[1] };
  return { owner: raw.owner, arweaveUri: raw.arweave_uri ?? raw.arweaveUri };
}

/**
 * Looks for a memorial whose Arweave URI is exactly `metadataTxId` (unique per upload). `owner` is
 * optional: when omitted, any owner matches — a draft minted from MetaMask must still be detected
 * when the user later resumes from a different (e.g. Privy Email) account.
 *
 * 1. Recent `MemorialCreated` logs filtered by the indexed owner (also yields the tx hash).
 * 2. Fallback when logs are unavailable (RPC range limits / older txs): reads the latest
 *    `memorials(id)` entries directly from contract storage.
 *
 * @returns {Promise<{ tokenId: string, txHash: string | null } | null>}
 */
export async function findMintedMemorial({
  publicClient,
  contractAddress,
  abi,
  owner,
  metadataTxId,
  logLookbackBlocks = DEFAULT_LOG_LOOKBACK_BLOCKS,
  scanLastMemorials = DEFAULT_SCAN_LAST_MEMORIALS,
}) {
  if (!publicClient || !contractAddress || !metadataTxId) return null;

  // 1. Event logs (cheap, gives the tx hash so the normal receipt flow can finish)
  const eventAbi = Array.isArray(abi) ? abi.find((x) => x?.type === 'event' && x?.name === 'MemorialCreated') : null;
  if (eventAbi) {
    try {
      const latestBlock = await publicClient.getBlockNumber();
      const fromBlock = latestBlock > logLookbackBlocks ? latestBlock - logLookbackBlocks : 0n;
      const logs = await publicClient.getLogs({
        address: contractAddress,
        event: eventAbi,
        ...(owner ? { args: { owner } } : {}),
        fromBlock,
        toBlock: latestBlock,
      });
      for (let i = logs.length - 1; i >= 0; i -= 1) {
        const log = logs[i];
        if (log?.args?.arweave_uri === metadataTxId && log?.args?.tokenId !== undefined) {
          return { tokenId: String(log.args.tokenId), txHash: log.transactionHash || null };
        }
      }
    } catch (err) {
      console.warn('[MintRecovery] Log lookup unavailable, falling back to storage scan:', err?.shortMessage || err?.message || err);
    }
  }

  // 2. Storage scan of the most recent memorials
  try {
    const countRaw = await publicClient.readContract({
      address: contractAddress,
      abi,
      functionName: 'memorial_count',
    });
    const count = Number(countRaw || 0);
    if (!count) return null;
    const firstId = Math.max(1, count - scanLastMemorials + 1);
    const ids = [];
    for (let id = count; id >= firstId; id -= 1) ids.push(id);

    let entries;
    try {
      const results = await publicClient.multicall({
        allowFailure: true,
        contracts: ids.map((id) => ({
          address: contractAddress,
          abi,
          functionName: 'memorials',
          args: [BigInt(id)],
        })),
      });
      entries = results.map((r) => (r?.status === 'success' ? r.result : null));
    } catch {
      entries = await Promise.all(
        ids.map((id) =>
          publicClient
            .readContract({ address: contractAddress, abi, functionName: 'memorials', args: [BigInt(id)] })
            .catch(() => null)
        )
      );
    }

    for (let i = 0; i < ids.length; i += 1) {
      const { owner: memOwner, arweaveUri } = readMemorialFields(entries[i]);
      if (arweaveUri === metadataTxId && (!owner || sameAddress(memOwner, owner))) {
        return { tokenId: String(ids[i]), txHash: null };
      }
    }
  } catch (err) {
    console.warn('[MintRecovery] Storage scan failed:', err?.shortMessage || err?.message || err);
  }
  return null;
}

/**
 * Polls `findMintedMemorial` a few times (a broadcast tx may still be pending in the mempool).
 * Stops early as soon as the memorial is found.
 */
export async function waitForMintedMemorial(params, { attempts = 8, intervalMs = 4000, shouldStop } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (typeof shouldStop === 'function' && shouldStop()) return null;
    const found = await findMintedMemorial(params);
    if (found) return found;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/** True for wallet / RPC failures where the tx may still have been broadcast (never for user rejection). */
export function isAmbiguousSendError(err) {
  let current = err;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const code = current?.code;
    if (code === -32603 || code === -32000 || code === -32005) return true;
    const name = current?.name || '';
    if (/UnknownRpcError|InternalRpcError|TimeoutError|HttpRequestError|LimitExceededRpcError|TransactionReceiptNotFound/i.test(name)) {
      return true;
    }
    const text = `${current?.shortMessage || ''} ${current?.message || ''}`;
    if (/unknown rpc error|internal json-rpc|timed? ?out|request expired|session|relay|network error|failed to fetch/i.test(text)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
