/**
 * useCandleEvents.js — Lightweight on-chain compatibility hook.
 *
 * NOTE: Network event querying (getLogs) has been removed in favor of
 * direct on-chain state (candle_expires_at & total_candles_lit).
 */

/**
 * Remove legacy mc_candles_* and mc_active_* keys from localStorage
 */
export function clearOldCandleStorage() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const keysToRemove = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && (key.startsWith('mc_candles_') || key.startsWith('mc_active_'))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch (err) {
    console.warn('[useCandleEvents] Cleanup warning:', err);
  }
}

// Automatic cleanup on module initialization
clearOldCandleStorage();

export const CANDLE_TIERS = {
  1: 3600,   // 1 hour
  2: 18000,  // 5 hours
  3: 43200,  // 12 hours
  4: 86400,  // 24 hours
};

export const CANDLE_DURATIONS = CANDLE_TIERS;

/**
 * Lightweight compatibility hook without getLogs or network overhead.
 */
export function useCandleEvents(memorialId, candleExpiresAt = 0, totalCandlesLit = 0) {
  if (typeof candleExpiresAt === 'object' && candleExpiresAt !== null) {
    totalCandlesLit = candleExpiresAt.totalCandlesLit ?? candleExpiresAt.totalCandles ?? 0;
    candleExpiresAt = candleExpiresAt.candleExpiresAt ?? candleExpiresAt.expiryTimestamp ?? 0;
  }

  const now = Math.floor(Date.now() / 1000);
  const expiry = Number(candleExpiresAt || 0);
  const total = Math.max(0, Number(totalCandlesLit || 0));
  const isBurning = expiry > now;

  return {
    activeCount: isBurning ? total : 0,
    totalCandles: total,
    isBurning,
    isLoading: false,
    triggerOptimisticLit: () => {},
    refetch: () => Promise.resolve(),
  };
}

export const triggerOptimisticCandle = () => {};
export const fetchCandleEventsForMemorial = () => Promise.resolve();

export const useActiveCandles = useCandleEvents;
export default useCandleEvents;
