// Modal.jsx - dialog window over the page (forms in the admin area, reports). Closes with Escape, the x button or a
// click on the dark background.
//
// React hook for the keyboard listener.
import { useEffect } from 'react';

// Props: title, close handler, content, optional footer (buttons), wide = larger dialog.
export default function Modal({ title, onClose, children, footer, wide = false }) {
  // While the dialog is open: listen for the Escape key.
  useEffect(() => {
    // Escape closes the dialog.
    const onKey = e => e.key === 'Escape' && onClose();
    // Register the listener on the whole window.
    window.addEventListener('keydown', onKey);
    // Cleanup: remove the listener when the dialog closes.
    return () => window.removeEventListener('keydown', onKey);
  // Register again only if the close handler changes.
  }, [onClose]);

  // The dialog markup.
  return (
    // Dark background; a click on it (not on the dialog itself) closes the dialog.
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      {/* The dialog box; role/aria attributes tell screen readers that this is a modal dialog. */}
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {/* Head: title and close button. */}
        <div className="modal-head">
          {/* Title. */}
          <h3>{title}</h3>
          {/* Close button (x). */}
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        {/* Content of the dialog. */}
        <div className="modal-body">{children}</div>
        {/* Optional footer (e.g. Save / Cancel buttons). */}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
