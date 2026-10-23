/**
 * Shared, user-friendly (English-only) formatting of wallet / transaction errors.
 * Works with viem / wagmi error objects (BaseError chain with `cause`, `shortMessage`, `name`, `code`).
 */

function walkErrorChain(err, visit) {
  let current = err;
  let depth = 0;
  while (current && depth < 8) {
    if (visit(current)) return true;
    current = current.cause;
    depth += 1;
  }
  return false;
}

function collectText(err) {
  const parts = [];
  walkErrorChain(err, (e) => {
    if (typeof e === 'string') parts.push(e);
    else {
      if (e.shortMessage) parts.push(e.shortMessage);
      if (e.message) parts.push(e.message);
      if (e.details) parts.push(e.details);
      if (e.reason) parts.push(e.reason);
    }
    return false;
  });
  return parts.join(' | ');
}

/** True when the user dismissed / rejected the request in their wallet (MetaMask, WalletConnect, Privy). */
export function isUserRejection(err) {
  if (!err) return false;
  const matched = walkErrorChain(err, (e) =>
    e?.name === 'UserRejectedRequestError' ||
    e?.code === 4001 ||
    e?.code === 'ACTION_REJECTED'
  );
  if (matched) return true;
  return /user (rejected|denied|cancel+ed)|rejected the request|request rejected|user closed|denied transaction/i.test(collectText(err));
}

/** Extracts a Vyper / Solidity revert reason string if present. */
function extractRevertReason(err) {
  let reason = '';
  walkErrorChain(err, (e) => {
    if (typeof e?.reason === 'string' && e.reason) { reason = e.reason; return true; }
    if (typeof e?.data?.errorName === 'string' && e.data.errorName === 'Error' && e.data.args?.[0]) {
      reason = String(e.data.args[0]);
      return true;
    }
    return false;
  });
  return reason;
}

/** Friendly copy for known contract assert messages (MemoryChainCore.vy). */
const REVERT_MESSAGES = {
  'Creation paused': 'Memorial creation is temporarily paused by the protocol.',
  'Exact creation fee required': 'The creation fee changed. Please try again so the latest fee is used.',
  'Candles paused': 'Candle lighting is temporarily paused by the protocol.',
  'Incorrect payment for tier': 'The candle price changed. Please try again so the latest price is used.',
  'Donation below candle price': 'The offering is below the current candle price.',
  'Memorial is banned': 'This memorial has been suspended by moderation.',
  'Memorial already banned': 'This memorial has already been suspended by moderation.',
  'Invalid memorial': 'This memorial does not exist.',
  'Invalid candle type': 'Invalid candle duration selected.',
  'Already reported': 'You have already reported this memorial.',
  'Sybil Guard: Must own a memorial to report': 'Only memorial owners can report. Create a memorial first.',
};

/**
 * Converts any wallet / RPC / contract error into a short English sentence suitable for the UI.
 * @param {unknown} err
 * @param {string} [fallback]
 */
export function formatTxError(err, fallback = 'Transaction failed. Please try again.') {
  if (!err) return fallback;
  if (isUserRejection(err)) return 'Transaction cancelled in your wallet.';

  const text = collectText(err);

  if (/insufficient funds|exceeds the balance|total cost .* exceeds/i.test(text)) {
    return 'Insufficient Base Sepolia ETH to cover the amount plus network fees. Top up your wallet from a faucet and try again.';
  }
  if (/chain mismatch|does not match the target chain|switch.*chain|unsupported chain|wrong network/i.test(text)) {
    return 'Please switch your wallet network to Base Sepolia and try again.';
  }
  if (/connector not connected|not connected|no account|account not found/i.test(text)) {
    return 'Wallet is not connected. Please reconnect your wallet and try again.';
  }
  if (/WaitForTransactionReceiptTimeoutError|timed out while waiting/i.test(text)) {
    return 'The transaction is taking longer than expected. It may still confirm. Please check the block explorer.';
  }
  if (/nonce too low|replacement transaction underpriced|already known/i.test(text)) {
    return 'A previous transaction from your wallet is still pending. Please wait a moment and try again.';
  }

  const reason = extractRevertReason(err);
  if (reason) return REVERT_MESSAGES[reason] || `Transaction reverted: ${reason}`;
  for (const [key, message] of Object.entries(REVERT_MESSAGES)) {
    if (text.includes(key)) return message;
  }

  if (/reverted/i.test(text)) return 'The transaction was reverted by the contract.';
  if (/network|fetch|timeout|HTTP request failed/i.test(text)) {
    return 'Network error while contacting Base Sepolia. Please check your connection and try again.';
  }

  const short = (err && typeof err === 'object' && err.shortMessage) || '';
  return short && short.length <= 160 ? short : fallback;
}
