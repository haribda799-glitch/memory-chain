import { useId } from 'react';

/**
 * CandleAltar — Pure on-chain sacred collective flame & memorial counter component.
 *
 * Rules:
 * - If isBurning && totalCandles > 0:
 *   * Math.min(totalCandles, 7) glowing flame icons.
 *   * If totalCandles > 7: `+{totalCandles - 7} more`
 *   * Subtitle: `{totalCandles} {totalCandles === 1 ? 'candle' : 'candles'} burning together in loving memory`
 * - If !isBurning:
 *   * Delicate extinguished silhouette.
 *   * Subtitle: `The flame has rested · {totalCandles} {totalCandles === 1 ? 'candle' : 'candles'} lit in loving memory`
 */
export default function CandleAltar({
  memorial,
  totalCandles: propTotalCandles,
  expiryTimestamp: propExpiryTimestamp,
  isBurning: propIsBurning,
  className = '',
}) {
  const uid = useId().replace(/:/g, '');
  const now = Math.floor(Date.now() / 1000);

  const expiresAt = Number(memorial?.candle_expires_at ?? propExpiryTimestamp ?? 0);
  const totalCandles = Math.max(0, Number(memorial?.total_candles_lit ?? propTotalCandles ?? 0));
  const isBurning = propIsBurning !== undefined ? propIsBurning : (expiresAt > now);

  const maxDisplay = 7;
  const flameCount = (isBurning && totalCandles > 0) ? Math.min(totalCandles, maxDisplay) : 0;
  const extraCount = (isBurning && totalCandles > maxDisplay) ? totalCandles - maxDisplay : 0;

  return (
    <div className={`w-full flex flex-col items-center py-1 ${className}`}>
      {/* ── Active Flame Row or Extinguished Status ── */}
      {isBurning && totalCandles > 0 ? (
        <>
          <div className="flex items-center justify-center gap-2.5 py-1">
            {Array.from({ length: flameCount }).map((_, index) => (
              <span
                key={index}
                className="flex items-center justify-center transform hover:scale-125 transition-transform duration-200"
                title={`${totalCandles} candle${totalCandles > 1 ? 's' : ''} burning together`}
              >
                <svg
                  width="14"
                  height="20"
                  viewBox="0 0 15 22"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="animate-[flameFloat_3s_ease-in-out_infinite]"
                  style={{
                    filter: 'drop-shadow(0 0 4px rgba(245, 158, 11, 0.65))',
                    animationDelay: `${index * 0.35}s`,
                  }}
                >
                  <path
                    d="M7.5 0C7.5 0 1.5 7.5 1.5 13C1.5 16.5 4.2 19.5 7.5 19.5C10.8 19.5 13.5 16.5 13.5 13C13.5 7.5 7.5 0 7.5 0Z"
                    fill={`url(#altarFlameGrad_${uid})`}
                  />
                  <path
                    d="M7.5 7C7.5 7 4.5 11 4.5 13.5C4.5 15.2 5.8 16.5 7.5 16.5C9.2 16.5 10.5 15.2 10.5 13.5C10.5 11 7.5 7 7.5 7Z"
                    fill="#FEF3C7"
                    opacity="0.85"
                  />
                </svg>
              </span>
            ))}

            {extraCount > 0 && (
              <span className="text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-full bg-amber-100/90 text-amber-900 border border-amber-300/50 shadow-sm">
                +{extraCount} more
              </span>
            )}
          </div>

          {/* Subtitle for burning state */}
          <p
            className="text-[11px] text-[#7A6B60] text-center mt-1 tracking-wide"
            style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
          >
            {totalCandles} {totalCandles === 1 ? 'candle' : 'candles'} burning together in loving memory
          </p>
        </>
      ) : (
        /* Muted Extinguished Status */
        <div className="flex items-center justify-center gap-1.5 py-1 text-[#8A7A6E]">
          <svg
            width="14"
            height="18"
            viewBox="0 0 15 22"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="opacity-50 flex-shrink-0"
          >
            <path
              d="M7.5 1.5C7.5 1.5 2 7.5 2 13C2 16.5 4.5 19.5 7.5 19.5C10.5 19.5 13 16.5 13 13C13 7.5 7.5 1.5 7.5 1.5Z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeDasharray="2.5 1.5"
              fill="currentColor"
              fillOpacity="0.06"
            />
            <path
              d="M7.5 19.5V14"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <circle cx="7.5" cy="8" r="1.5" fill="currentColor" fillOpacity="0.25" />
          </svg>
          <span
            className="text-xs text-[#8A7A6E] italic tracking-wide text-center"
            style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
          >
            The flame has rested · {totalCandles} {totalCandles === 1 ? 'candle' : 'candles'} lit in loving memory
          </span>
        </div>
      )}

      {/* Shared Gradient Defs */}
      <svg width="0" height="0" className="absolute pointer-events-none">
        <defs>
          <linearGradient id={`altarFlameGrad_${uid}`} x1="7.5" y1="0" x2="7.5" y2="20" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FDE68A" />
            <stop offset="0.45" stopColor="#F59E0B" />
            <stop offset="1" stopColor="#B45309" />
          </linearGradient>
        </defs>
      </svg>

      <style>{`
        @keyframes flameFloat {
          0%, 100% { transform: translateY(0); opacity: 0.92; }
          50%      { transform: translateY(-2.5px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
