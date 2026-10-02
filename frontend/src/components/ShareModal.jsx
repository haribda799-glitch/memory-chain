import { useState, useEffect, useRef } from 'react';
import { QRCodeCanvas } from 'qrcode.react';

export default function ShareModal({
  isOpen = false,
  onClose = () => {},
  petName = '',
  memorialId = '',
  url = '',
}) {
  const [copied, setCopied] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const canvasRef = useRef(null);

  const memorialUrl = url || (typeof window !== 'undefined' ? window.location.href : '');

  const handleClose = () => {
    if (isClosing) return;
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      setCopied(false);
      onClose();
    }, 250);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(memorialUrl);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = memorialUrl;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      console.error('Failed to copy link:', err);
    }
  };

  const handleDownloadQR = () => {
    const canvas = canvasRef.current || document.getElementById('memorial-qr-canvas');
    if (!canvas) return;

    // Create high-res PNG for printing
    const pngUrl = canvas.toDataURL('image/png');
    const downloadLink = document.createElement('a');
    downloadLink.href = pngUrl;
    const safeName = (petName || `memorial_${memorialId || 'tribute'}`)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '_');
    downloadLink.download = `${safeName}_qr_code.png`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
  };

  const canNativeShare = typeof navigator !== 'undefined' && Boolean(navigator.share);
  const handleNativeShare = async () => {
    if (!canNativeShare) return;
    try {
      await navigator.share({
        title: `${petName ? `${petName} — ` : ''}Eternal Memorial`,
        text: `In loving memory of ${petName || 'a beloved pet'} on Memory Chain`,
        url: memorialUrl,
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Native share failed:', err);
      }
    }
  };

  if (!isOpen && !isClosing) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300 ${
          isClosing ? 'opacity-0' : 'opacity-100'
        }`}
      />

      {/* Modal Card */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative w-full max-w-md bg-[#fdfcfa] rounded-[24px] border border-[#d8c2ba]/50 shadow-2xl overflow-hidden transition-all duration-300 ${
          isClosing ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
        }`}
      >
        {/* Header */}
        <div className="relative px-6 pt-6 pb-3 text-center border-b border-[#f0e8e0]">
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-[#f5f3f0] flex items-center justify-center hover:bg-[#e8e5e0] transition-colors cursor-pointer text-[#5A5047]"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>

          <div className="w-14 h-14 rounded-full bg-amber-100/80 flex items-center justify-center mx-auto mb-3 text-amber-800 shadow-sm border border-amber-200/50">
            <span className="material-symbols-outlined text-2xl">qr_code_2</span>
          </div>

          <h2
            id="share-modal-title"
            className="text-xl text-[#1b1c1a] mb-1 font-serif tracking-tight"
            style={{ fontFamily: "'Libre Caslon Text', serif" }}
          >
            Share Eternal Memorial
          </h2>
          <p className="text-xs text-[#53433e]">
            for <span className="font-semibold italic text-[#2C2520]">{petName || (memorialId ? `Memorial #${memorialId}` : 'Beloved Pet')}</span>
          </p>
        </div>

        {/* Content */}
        <div className="px-6 py-5 space-y-4">
          {/* QR Code Container */}
          <div className="flex flex-col items-center">
            <div className="p-4 bg-white rounded-2xl border border-[#e9dfd3] shadow-sm flex items-center justify-center">
              <QRCodeCanvas
                ref={canvasRef}
                id="memorial-qr-canvas"
                value={memorialUrl}
                size={220}
                level="H"
                marginSize={2}
                bgColor="#FFFFFF"
                fgColor="#1B1C1A"
                className="w-44 h-44 md:w-52 md:h-52"
              />
            </div>
            <p className="text-[11px] text-[#7A6B60] text-center mt-2.5 max-w-xs leading-relaxed">
              Scan with any mobile camera to visit this tribute or print the QR code for a collar tag or keepsake.
            </p>
          </div>

          {/* Download QR Button */}
          <button
            type="button"
            onClick={handleDownloadQR}
            className="w-full py-2.5 px-4 rounded-xl border border-[#d8c2ba] bg-[#fbf5f2] hover:bg-[#f3ebe4] text-[#53433e] hover:text-[#2C2520] font-semibold text-xs tracking-wider uppercase transition-all duration-150 flex items-center justify-center gap-2 cursor-pointer shadow-xs active:scale-[0.99]"
          >
            <span className="material-symbols-outlined text-base text-[#C16226]">download</span>
            <span>Download QR Code (PNG)</span>
          </button>

          {/* Memorial Link Field with Copy Button */}
          <div className="space-y-1.5 pt-1">
            <label className="block text-[11px] font-semibold text-[#5A5047] uppercase tracking-wider">
              Memorial Web Link
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={memorialUrl}
                onFocus={(e) => e.target.select()}
                className="flex-1 min-w-0 px-3 py-2 text-xs text-[#2C2520] bg-[#f5f0eb] border border-[#e0d0c7] rounded-xl focus:outline-none focus:border-[#C16226] select-all truncate font-mono"
              />
              <button
                type="button"
                onClick={handleCopy}
                className={`px-4 py-2 rounded-xl font-bold transition-all uppercase tracking-wider text-xs cursor-pointer flex items-center gap-1.5 whitespace-nowrap shadow-xs active:scale-[0.98] ${
                  copied
                    ? 'bg-emerald-700 text-white'
                    : 'bg-gradient-to-r from-[#C16226] to-[#A8551F] text-white hover:shadow-md'
                }`}
              >
                <span className="material-symbols-outlined text-sm">
                  {copied ? 'check' : 'content_copy'}
                </span>
                <span>{copied ? 'Copied!' : 'Copy Link'}</span>
              </button>
            </div>
          </div>

          {/* Optional Native Share (Mobile) */}
          {canNativeShare && (
            <button
              type="button"
              onClick={handleNativeShare}
              className="w-full py-2.5 px-4 rounded-xl border border-[#e8dfd7] bg-white hover:bg-[#fcfaf7] text-[#5A5047] hover:text-[#2C2520] font-medium text-xs tracking-wider uppercase transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">share</span>
              <span>Share via Apps...</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
