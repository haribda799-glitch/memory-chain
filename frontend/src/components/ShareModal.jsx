import { useState, useEffect, useRef, useMemo } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useModalBehavior } from '../hooks/useModalBehavior';

// Resolution of the hidden QR canvas used only for PNG export (print-quality plaques / tags).
const EXPORT_QR_SIZE = 1024;

/**
 * Builds a clean canonical memorial link (`<origin><BASE_URL>#/memorial/<id>`) when the given URL points
 * at a memorial route, dropping stray query params and fixing a missing deploy base path.
 */
function toCanonicalMemorialUrl(rawUrl) {
  if (typeof window === 'undefined') return rawUrl;
  const match = String(rawUrl || '').match(/#\/memorial\/([^/?#&]+)/);
  if (!match) return rawUrl;
  const base = import.meta.env.BASE_URL || '/';
  return `${window.location.origin}${base}#/memorial/${match[1]}`;
}

/** Legacy clipboard fallback (non-secure contexts / old browsers). Returns true only if the copy succeeded. */
function legacyCopy(text) {
  if (typeof document === 'undefined') return false;
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.readOnly = true;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.top = '-9999px';
  textArea.style.left = '0';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);
  let ok = false;
  try {
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, text.length); // iOS Safari ignores select() alone
    ok = document.execCommand('copy') === true;
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(textArea);
  }
  return ok;
}

export default function ShareModal({
  isOpen = false,
  onClose = () => {},
  petName = '',
  memorialId = '',
  url = '',
}) {
  // 'idle' | 'copied' | 'failed'
  const [copyStatus, setCopyStatus] = useState('idle');
  const [isClosing, setIsClosing] = useState(false);
  const canvasRef = useRef(null);
  const exportCanvasRef = useRef(null);
  const linkInputRef = useRef(null);
  const copyTimerRef = useRef(null);
  const closeTimerRef = useRef(null);
  const copied = copyStatus === 'copied';

  const memorialUrl = useMemo(
    () => toCanonicalMemorialUrl(url || (typeof window !== 'undefined' ? window.location.href : '')),
    [url]
  );

  // Clear pending timers on unmount.
  useEffect(() => () => {
    clearTimeout(copyTimerRef.current);
    clearTimeout(closeTimerRef.current);
  }, []);

  // Clear the "Copied!" reset timer when the modal is closed (also when the parent closes it directly).
  useEffect(() => {
    if (isOpen) return;
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = null;
  }, [isOpen]);

  const handleClose = () => {
    if (isClosing) return;
    setIsClosing(true);
    clearTimeout(copyTimerRef.current);
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setIsClosing(false);
      setCopyStatus('idle');
      onClose();
    }, 250);
  };

  // Body scroll lock + Escape (always calls the latest handleClose).
  useModalBehavior(isOpen, handleClose);

  const handleCopy = async () => {
    let ok = false;
    const canUseClipboardApi =
      typeof navigator !== 'undefined' &&
      Boolean(navigator.clipboard?.writeText) &&
      typeof window !== 'undefined' &&
      window.isSecureContext;

    if (canUseClipboardApi) {
      try {
        await navigator.clipboard.writeText(memorialUrl);
        ok = true;
      } catch (err) {
        console.error('Failed to copy link:', err);
        ok = legacyCopy(memorialUrl);
      }
    } else {
      ok = legacyCopy(memorialUrl);
    }

    if (!ok) {
      // Help the user copy manually: select the visible link field.
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    }

    setCopyStatus(ok ? 'copied' : 'failed');
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyStatus('idle'), ok ? 2500 : 5000);
  };

  const handleDownloadQR = async () => {
    // Prefer the hidden high-resolution export canvas; fall back to the visible one.
    const canvas = exportCanvasRef.current || canvasRef.current || document.getElementById('memorial-qr-canvas');
    if (!canvas) return;

    const safeName = (petName || `memorial_${memorialId || 'tribute'}`)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '_');
    const fileName = `${safeName}_qr_code.png`;

    // Create high-res PNG for printing
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      console.error('Failed to export QR code image.');
      return;
    }

    // Mobile (iOS / Android): share the file so it can be saved to Photos / Files.
    const isTouchDevice = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    if (isTouchDevice && typeof navigator !== 'undefined' && navigator.share && typeof File !== 'undefined') {
      try {
        const file = new File([blob], fileName, { type: 'image/png' });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: `${petName ? `${petName} — ` : ''}Memorial QR Code`,
          });
          return;
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('QR file share failed, falling back to download:', err);
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = objectUrl;
    downloadLink.download = fileName;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    // Revoke on the next tick so the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
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
      className="fixed inset-0 z-[60] flex justify-center overflow-y-auto p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
    >
      {/* Backdrop */}
      <div
        className={`fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300 ${
          isClosing ? 'opacity-0' : 'opacity-100'
        }`}
      />

      {/* Modal Card */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative my-auto w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain bg-[#fdfcfa] rounded-[24px] border border-[#d8c2ba]/50 shadow-2xl transition-all duration-300 ${
          isClosing ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
        }`}
      >
        {/* Header */}
        <div className="relative px-6 pt-6 pb-3 text-center border-b border-[#f0e8e0]">
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="absolute top-3 right-3 w-10 h-10 rounded-full bg-[#f5f3f0] flex items-center justify-center hover:bg-[#e8e5e0] transition-colors cursor-pointer text-[#5A5047]"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>

          <div className="w-14 h-14 rounded-full bg-[#C87D65]/12 flex items-center justify-center mx-auto mb-3 text-[#C87D65] shadow-xs border border-[#C87D65]/20">
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
              {/* Hidden high-resolution copy used only for the PNG export */}
              <QRCodeCanvas
                ref={exportCanvasRef}
                value={memorialUrl}
                size={EXPORT_QR_SIZE}
                level="H"
                marginSize={2}
                bgColor="#FFFFFF"
                fgColor="#1B1C1A"
                aria-hidden="true"
                style={{ display: 'none' }}
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
            <span className="material-symbols-outlined text-base text-[#C87D65]">download</span>
            <span>Download QR Code (PNG)</span>
          </button>

          {/* Memorial Link Field with Copy Button */}
          <div className="space-y-1.5 pt-1">
            <label className="block text-[11px] font-semibold text-[#5A5047] uppercase tracking-wider">
              Memorial Web Link
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={linkInputRef}
                type="text"
                readOnly
                value={memorialUrl}
                onFocus={(e) => e.target.select()}
                className="flex-1 min-w-0 px-3 py-2 text-xs text-[#2C2520] bg-[#f5f0eb] border border-[#e0d0c7] rounded-xl focus:outline-none focus:border-[#C87D65] select-all truncate font-mono"
              />
              <button
                type="button"
                onClick={handleCopy}
                className={`px-4 py-2 rounded-xl font-bold transition-all uppercase tracking-wider text-xs cursor-pointer flex items-center gap-1.5 whitespace-nowrap shadow-xs active:scale-[0.98] ${
                  copied
                    ? 'bg-[#8a4f36] text-white'
                    : 'bg-[#C87D65] hover:bg-[#B56B53] text-white hover:shadow-md'
                }`}
              >
                <span className="material-symbols-outlined text-sm">
                  {copied ? 'check' : 'content_copy'}
                </span>
                <span>{copied ? 'Copied!' : 'Copy Link'}</span>
              </button>
            </div>
            {copyStatus === 'failed' && (
              <p role="alert" className="text-[11px] text-red-700 leading-relaxed">
                Copy failed — please copy the link manually
              </p>
            )}
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
