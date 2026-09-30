import { useId } from 'react';

/**
 * Animated candle flame with pulsating radial glow.
 * Pure visual component — no state, no web3 logic.
 *
 * @param {string}  petName     - Name displayed in the "burning for" text.
 * @param {boolean} compact     - If true, renders a smaller version for cards.
 * @param {boolean} showCaption - If false, suppresses internal caption text.
 */
export default function Candle({ petName, compact = false, showCaption = true }) {
  // Unique ID per instance to avoid SVG gradient collisions
  const uid = useId().replace(/:/g, '');

  const flameW = compact ? 18 : 28;
  const flameH = compact ? 28 : 42;
  const containerCls = compact
    ? 'w-12 h-12'
    : 'w-20 h-20';

  return (
    <div className="flex flex-col items-center justify-center space-y-2 py-1">
      {/* Flame container with radial glow */}
      <div className={`relative flex items-center justify-center ${containerCls}`}>
        {/* Outer pulsating glow — radial gradient via box-shadow */}
        <div
          className="absolute inset-0 rounded-full animate-[candleGlow_2.5s_ease-in-out_infinite]"
          style={{
            background: 'radial-gradient(circle, rgba(255,181,152,0.35) 0%, rgba(212,140,111,0.12) 50%, transparent 70%)',
          }}
        />
        {/* Inner hot-core glow */}
        <div
          className="absolute rounded-full animate-[candleGlow_2s_ease-in-out_infinite_0.5s]"
          style={{
            inset: compact ? '6px' : '10px',
            background: 'radial-gradient(circle, rgba(255,239,163,0.4) 0%, transparent 60%)',
          }}
        />

        {/* SVG Flame */}
        <svg
          width={flameW}
          height={flameH}
          viewBox="0 0 28 42"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="relative z-10 animate-[flameFlicker_3s_ease-in-out_infinite]"
          style={{ filter: `drop-shadow(0 0 6px rgba(255,181,152,0.6))` }}
        >
          {/* Outer flame */}
          <path
            d="M14 0C14 0 4 14 4 24C4 29.5228 8.47715 34 14 34C19.5228 34 24 29.5228 24 24C24 14 14 0 14 0Z"
            fill={`url(#outer_${uid})`}
            className="animate-[flameOpacity_1.8s_ease-in-out_infinite]"
          />
          {/* Inner bright core */}
          <path
            d="M14 10C14 10 9 19 9 24C9 26.7614 11.2386 29 14 29C16.7614 29 19 26.7614 19 24C19 19 14 10 14 10Z"
            fill={`url(#inner_${uid})`}
            className="animate-[flameOpacity_2.2s_ease-in-out_infinite_0.3s]"
          />
          {/* Hotspot */}
          <ellipse
            cx="14"
            cy="26"
            rx="3"
            ry="2"
            fill="#FFF8E1"
            opacity="0.6"
            className="animate-[flameOpacity_1.5s_ease-in-out_infinite_0.6s]"
          />
          <defs>
            <linearGradient id={`outer_${uid}`} x1="14" y1="0" x2="14" y2="34" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFD7A8" />
              <stop offset="0.45" stopColor="#D48C6F" />
              <stop offset="1" stopColor="#8A4F36" />
            </linearGradient>
            <radialGradient id={`inner_${uid}`} cx="14" cy="22" r="10" gradientUnits="userSpaceOnUse">
              <stop stopColor="#FFEFA3" />
              <stop offset="1" stopColor="#FFB598" />
            </radialGradient>
          </defs>
        </svg>
      </div>

      {/* Burning-for text (hide in compact mode or when managed externally) */}
      {!compact && showCaption && (
        <p className="font-body-sm text-body-sm text-on-surface-variant italic text-center px-4 leading-snug">
          This candle is burning for {petName || 'this beautiful soul'}.
        </p>
      )}

      <style>{`
        @keyframes flameFlicker {
          0%, 100% { transform: translateY(0) scaleX(1); }
          25%      { transform: translateY(-1.5px) scaleX(0.97); }
          50%      { transform: translateY(-2.5px) scaleX(1.03); }
          75%      { transform: translateY(-1px) scaleX(0.98); }
        }
        @keyframes flameOpacity {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.78; }
        }
        @keyframes candleGlow {
          0%, 100% { opacity: 0.7; transform: scale(1); }
          50%      { opacity: 1;   transform: scale(1.08); }
        }
      `}</style>
    </div>
  );
}
