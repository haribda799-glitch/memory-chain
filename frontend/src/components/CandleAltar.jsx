export default function CandleAltar({
  memorial,
  totalCandles: propTotalCandles,
  expiryTimestamp: propExpiryTimestamp,
  isBurning: propIsBurning,
  className = '',
}) {
  const now = Math.floor(Date.now() / 1000);

  const expiresAt = Number(memorial?.candle_expires_at ?? propExpiryTimestamp ?? 0);
  const totalCandles = Math.max(0, Number(memorial?.total_candles_lit ?? propTotalCandles ?? 0));
  const isBurning = propIsBurning !== undefined ? propIsBurning : (expiresAt > now);

  const maxDisplay = 5;
  const flameCount = (isBurning && totalCandles > 0) ? Math.min(totalCandles, maxDisplay) : 0;
  const extraCount = (isBurning && totalCandles > maxDisplay) ? totalCandles - maxDisplay : 0;

  return (
    <div className={`w-full flex flex-col items-center justify-center py-0.5 ${className}`}>
      {/* ── Active Flame Row or Extinguished Status ── */}
      {isBurning && totalCandles > 0 ? (
        <>
          <div className="flex items-center justify-center gap-2 py-0.5">
            {Array.from({ length: flameCount }).map((_, index) => (
              <span
                key={index}
                className="flex items-center justify-center transform hover:scale-125 transition-transform duration-200"
                title={`${totalCandles} candle${totalCandles > 1 ? 's' : ''} burning together`}
              >
                <svg
                  width="14"
                  height="20"
                  viewBox="0 0 22 30"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="animate-[flameFloat_3s_ease-in-out_infinite]"
                  style={{
                    filter: 'drop-shadow(0 0 4px rgba(245, 158, 11, 0.65))',
                    animationDelay: `${index * 0.35}s`,
                  }}
                >
                  <path
                    d="M12.2 1.2C14.9 5.9 19.2 12.4 19.2 19.1C19.2 24.3 15.6 28.2 11 28.2C6.4 28.2 2.8 24.3 2.8 19.1C2.8 12.1 8.1 6.6 12.2 1.2Z"
                    fill="#F59E0B"
                  />
                  <path
                    d="M11.6 6.4C13.7 10.2 16.6 14.9 16.6 19.9C16.6 23.9 14.2 27.0 11 27.0C7.8 27.0 5.4 23.9 5.4 19.9C5.4 14.6 9.1 10.6 11.6 6.4Z"
                    fill="#FBBF24"
                  />
                  <path
                    d="M11 15.0C12.3 17.4 13.6 20.0 13.6 22.6C13.6 24.9 12.5 26.5 11 26.5C9.5 26.5 8.4 24.9 8.4 22.6C8.4 20.0 9.7 17.4 11 15.0Z"
                    fill="#FEF3C7"
                  />
                </svg>
              </span>
            ))}

            {extraCount > 0 && (
              <span className="text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded-full bg-amber-100/90 text-amber-900 border border-amber-300/50 shadow-xs">
                +{extraCount}
              </span>
            )}
          </div>

          {/* Subtitle for burning state */}
          <p
            className="text-[11px] leading-snug text-[#7A6B60] text-center mt-1 tracking-wide"
            style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
          >
            {totalCandles} {totalCandles === 1 ? 'candle' : 'candles'} burning together in loving memory
          </p>
        </>
      ) : (
        /* Symmetrically centered extinguished state */
        <div className="flex flex-col items-center justify-center text-center gap-1 text-[#8A7A6E]">
          <svg
            width="15"
            height="19"
            viewBox="0 0 16 22"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="text-[#9E8E80] opacity-75"
            aria-hidden="true"
          >
            <path
              d="M8 2C8 2 3 7.4 3 12.4C3 15.6 5.2 18.2 8 18.2C10.8 18.2 13 15.6 13 12.4C13 7.4 8 2 8 2Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="currentColor"
              fillOpacity="0.1"
            />
            <path
              d="M8 10.2C8.9 11.6 9.6 12.8 9.6 14C9.6 15.1 8.9 15.9 8 15.9C7.1 15.9 6.4 15.1 6.4 14C6.4 12.8 7.1 11.6 8 10.2Z"
              fill="currentColor"
              fillOpacity="0.28"
            />
            <path
              d="M5.5 20.2H10.5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
          <div
            className="text-center leading-tight"
            style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
          >
            <p className="text-[11.5px] text-[#7D6E62] italic tracking-wide">
              The flame has rested
            </p>
            <p className="text-[10.5px] text-[#9A8B7E] tracking-wide mt-0.5">
              {totalCandles} {totalCandles === 1 ? 'candle' : 'candles'} lit in loving memory
            </p>
          </div>
        </div>
      )}

      <style>{`
        @keyframes flameFloat {
          0%, 100% { transform: translateY(0); opacity: 0.92; }
          50%      { transform: translateY(-2.5px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
