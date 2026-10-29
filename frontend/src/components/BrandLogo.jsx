import { useId } from 'react';
import { Link } from 'react-router-dom';

export default function BrandLogo({ className = '' }) {
  const uid = useId();
  const archGradId = `mc-arch-frame-${uid}`;
  const archFillId = `mc-arch-fill-${uid}`;
  const flameGradId = `mc-flame-outer-${uid}`;

  return (
    <Link
      to="/"
      className={`group inline-flex items-center gap-3 no-underline cursor-pointer select-none ${className}`}
      aria-label="Memory Chain"
    >
      {/* Sacred Memorial Arch with Living Golden Flame */}
      <span className="relative inline-flex items-center justify-center w-8 h-9 md:w-9 md:h-10 shrink-0 transition-transform duration-300 group-hover:scale-[1.04]">
        <svg
          viewBox="0 0 36 40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          className="w-full h-full overflow-visible"
        >
          <defs>
            {/* Golden-Terracotta Arch Border Gradient (#D4A359 -> #B56B53) */}
            <linearGradient id={archGradId} x1="4" y1="2" x2="32" y2="38" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#D4A359" />
              <stop offset="52%" stopColor="#C87D65" />
              <stop offset="100%" stopColor="#B56B53" />
            </linearGradient>

            {/* Warm Illuminated Sanctuary Interior (#FDF8EE with radial golden glow) */}
            <radialGradient id={archFillId} cx="18" cy="21" r="14" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#FEF3C7" />
              <stop offset="52%" stopColor="#FDF6E2" />
              <stop offset="100%" stopColor="#FDF8EE" />
            </radialGradient>

            {/* Living Flame Outer Petal Gradient (#FBBF24 -> #EA580C) */}
            <linearGradient id={flameGradId} x1="18" y1="10" x2="18" y2="28" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#FBBF24" />
              <stop offset="55%" stopColor="#F59E0B" />
              <stop offset="100%" stopColor="#EA580C" />
            </linearGradient>
          </defs>

          {/* Outer Sacred Arch Silhouette (Vaulted Top + Softly Rounded Base) */}
          <path
            d="M3.5 17.5C3.5 9.492 9.992 3 18 3C26.008 3 32.5 9.492 32.5 17.5V33.2C32.5 35.3 30.8 37 28.7 37H7.3C5.2 37 3.5 35.3 3.5 33.2V17.5Z"
            fill={`url(#${archFillId})`}
            stroke={`url(#${archGradId})`}
            strokeWidth="1.8"
          />

          {/* Noble Inner Double-Frame Arch Line */}
          <path
            d="M6.6 17.6C6.6 11.3 11.7 6.2 18 6.2C24.3 6.2 29.4 11.3 29.4 17.6V32.4C29.4 33.45 28.55 34.3 27.5 34.3H8.5C7.45 34.3 6.6 33.45 6.6 32.4V17.6Z"
            stroke={`url(#${archGradId})`}
            strokeWidth="0.85"
            strokeOpacity="0.48"
          />

          {/* Soft Golden Halo Around the Flame */}
          <circle
            cx="18"
            cy="20.2"
            r="8.4"
            fill="#F59E0B"
            opacity="0.22"
            className="mc-logo-halo"
          />

          {/* Multi-Layered Living Golden Flame */}
          <g className="mc-logo-flame">
            {/* Outer Flame Petal (#FBBF24 -> #EA580C) */}
            <path
              d="M18 9.8C20.1 13.3 23.8 17.2 23.8 21.7C23.8 25.25 21.2 28 18 28C14.8 28 12.2 25.25 12.2 21.7C12.2 17.2 15.9 13.3 18 9.8Z"
              fill={`url(#${flameGradId})`}
            />
            {/* Warm Golden Mid-Layer */}
            <path
              d="M18 13.2C19.45 15.7 21.9 18.5 21.9 21.9C21.9 24.35 20.15 26.3 18 26.3C15.85 26.3 14.1 24.35 14.1 21.9C14.1 18.5 16.55 15.7 18 13.2Z"
              fill="#FBBF24"
              opacity="0.88"
            />
            {/* Bright Inner Heart of the Flame (#FEF3C7) */}
            <path
              d="M18 16.7C18.9 18.35 20.2 20.2 20.2 22.3C20.2 23.8 19.22 25 18 25C16.78 25 15.8 23.8 15.8 22.3C15.8 20.2 17.1 18.35 18 16.7Z"
              fill="#FEF3C7"
            />
          </g>

          {/* Subtle Golden Altar Cradle Under the Flame */}
          <path
            d="M12.6 30.4C14.3 31.35 16.1 31.8 18 31.8C19.9 31.8 21.7 31.35 23.4 30.4"
            stroke={`url(#${archGradId})`}
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeOpacity="0.7"
          />
        </svg>
      </span>

      {/* Vertically Centered Two-Tone Brand Title */}
      <span
        className="inline-flex items-baseline gap-1.5 text-[22px] md:text-[25px] leading-none tracking-tight"
        style={{ fontFamily: "'Libre Caslon Text', Georgia, serif" }}
      >
        <span className="font-medium text-[#2C221E] transition-colors duration-300 group-hover:text-[#1b1411]">
          Memory
        </span>
        <span className="italic font-normal text-[#B56B53] transition-colors duration-300 group-hover:text-[#9E5943]">
          Chain
        </span>
      </span>
    </Link>
  );
}
