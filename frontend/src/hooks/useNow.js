import { useEffect, useState } from 'react';

const nowInSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Reactive "current time" in unix seconds.
 *
 * Mount ONCE per page (e.g. Gallery / My Memorials) and pass the value down as a prop,
 * so a list of N cards shares a single timer instead of running N intervals.
 * Re-rendering on each tick is what lets expired candles go out without a page reload.
 *
 * - Ticks every `intervalMs` (default 15s).
 * - Resyncs immediately when the tab becomes visible again (browsers throttle background timers).
 * - `enabled = false` turns the hook into a no-op (no timer, no listeners), which lets a component
 *   fall back to its own clock only when a parent did not supply one.
 *
 * @param {number}  [intervalMs=15000]
 * @param {boolean} [enabled=true]
 * @returns {number} current unix time in seconds
 */
export function useNow(intervalMs = 15000, enabled = true) {
  const [now, setNow] = useState(nowInSeconds);

  useEffect(() => {
    if (!enabled) return undefined;

    const tick = () => setNow(nowInSeconds());
    tick(); // catch up right away in case the component was idle before being enabled

    const interval = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs, enabled]);

  return now;
}

export default useNow;
