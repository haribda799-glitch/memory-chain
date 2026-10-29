import { useId } from 'react';
import { Link } from 'react-router-dom';

export default function BrandLogo({ className = '', showSubtitle = true }) {
  const gradId = useId();
  const archGradId = `mc-arch-${gradId}`;
  const flameGradId = `mc-flame-${gradId}`;

  return (
    <Link
      to="/"
      className={`group inline-flex items-center gap-2.5 no-underline cursor-pointer select-none ${className}`}
      aria-label="Memory Chain — Eternal Sanctuary"
    >
      {/* Medallion Emblem */}
      <span className="w-9 h-9 rounded-full bg-[#F5EFE6] border border-[#E5D7C3] flex items-center justify-center shrink-0 shadow-2xs transition-all duration-300 group-hover:border-[#D4A359]/70 group-hover:bg-[#FAF5EC] group-hover:shadow-[0_0_14px_rgba(212,163,89,0.22)]">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="overflow-visible"
        >
          <defs>
            <linearGradient id={archGradId} x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#D4A359" />
              <stop offset="55%" stopColor="#C87D65" />
              <stop offset="100%" stopColor="#A65D47" />
            </linearGradient>
            <linearGradient id={flameGradId} x1="12" y1="6.5" x2="12" y2="16.5" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#F3C66F" />
              <stop offset="55%" stopColor="#DF8B57" />
              <stop offset="100%" stopColor="#C87D65" />
            </linearGradient>
          </defs>

          {/* Memorial Arch Outline */}
          <path
            d="M5.5 19.2V10.5C5.5 6.91 8.41 4 12 4C15.59 4 18.5 6.91 18.5 10.5V19.2"
            stroke={`url(#${archGradId})`}
            strokeWidth="1.5"
            strokeLinecap="round"
          />

          {/* Subtle Inner Sanctuary Halo */}
          <path
            d="M7.6 17.5V10.7C7.6 8.16 9.57 6.1 12 6.1C14.43 6.1 16.4 8.16 16.4 10.7V17.5"
            stroke={`url(#${archGradId})`}
            strokeWidth="0.75"
            strokeOpacity="0.38"
            strokeLinecap="round"
          />

          {/* Minimalist Candle Flame (glows gently on hover) */}
          <g className="origin-[12px_15px] transition-all duration-300 group-hover:scale-110 group-hover:drop-shadow-[0_0_5px_rgba(212,163,89,0.65)]">
            <path
              d="M12 7.4C13.2 9.4 14.8 11.4 14.8 13.5C14.8 15.15 13.55 16.4 12 16.4C10.45 16.4 9.2 15.15 9.2 13.5C9.2 11.4 10.8 9.4 12 7.4Z"
              fill={`url(#${flameGradId})`}
            />
            <path
              d="M12 11.1C12.55 12.05 13.2 12.95 13.2 13.9C13.2 14.65 12.68 15.2 12 15.2C11.32 15.2 10.8 14.65 10.8 13.9C10.8 12.95 11.45 12.05 12 11.1Z"
              fill="#FFF6E0"
            />
          </g>

          {/* Eternity Link / Base Arc */}
          <path
            d="M4.5 19.3C7.2 20.6 9.6 21 12 21C14.4 21 16.8 20.6 19.5 19.3"
            stroke={`url(#${archGradId})`}
            strokeWidth="1.35"
            strokeLinecap="round"
          />
          <path
            d="M9.4 19.2C10.2 18.2 11.05 17.8 12 17.8C12.95 17.8 13.8 18.2 14.6 19.2"
            stroke={`url(#${archGradId})`}
            strokeWidth="1.15"
            strokeLinecap="round"
          />
        </svg>
      </span>

      {/* Two-Tone Typography + Micro-Subtitle */}
      <span className="flex flex-col justify-center">
        <span
          className="text-[21px] md:text-[22px] leading-tight tracking-tight"
          style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
        >
          <span className="font-medium text-[#2C221E] transition-colors duration-300 group-hover:text-[#1b1411]">
            Memory
          </span>{' '}
          <span className="italic font-normal text-[#B56B53] transition-colors duration-300 group-hover:text-[#9E5943]">
            Chain
          </span>
        </span>
        {showSubtitle && (
          <span className="text-[9px] uppercase tracking-[0.22em] text-stone-400 font-sans block -mt-0.5">
            Eternal Sanctuary
          </span>
        )}
      </span>
    </Link>
  );
}
