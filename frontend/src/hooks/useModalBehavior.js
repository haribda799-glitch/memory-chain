import { useEffect, useRef } from 'react';

/**
 * Common modal behaviour for mobile + desktop:
 *  - locks page scroll behind the modal while it is open (restores the previous value on close)
 *  - closes on Escape using the latest `onClose` (no stale closures)
 *
 * @param {boolean} isOpen
 * @param {() => void} onClose
 */
export function useModalBehavior(isOpen, onClose) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return undefined;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onCloseRef.current?.();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);
}
