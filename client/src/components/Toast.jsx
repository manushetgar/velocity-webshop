// Toast.jsx - small notifications that disappear by themselves ("Added to cart", error messages).
// Any component calls const toast = useToast(); toast('text', 'success' | 'error' | 'info').
//
// React functions: context, memoized callback, reading a context, state.
import { createContext, useCallback, useContext, useState } from 'react';

// Context with the show function (the default does nothing, so a missing provider never crashes).
const ToastContext = createContext(() => {});

// Small, self-dismissing notifications (bottom right)
export function ToastProvider({ children }) {
  // The notifications currently shown: [{ id, text, kind }].
  const [toasts, setToasts] = useState([]);

  // Shows a notification; useCallback keeps the same function for the whole lifetime (stable for effects).
  const show = useCallback((text, kind = 'info') => {
    // Random id to find this notification again when it is removed.
    const id = Math.random().toString(36).slice(2);
    // Add it to the list (functional update: works with the newest list).
    setToasts(t => [...t, { id, text, kind }]);
    // Remove it again after 2.8 seconds.
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2800);
  // No dependencies: the function never changes.
  }, []);

  // Render the app and the notification area.
  return (
    // All components below can call show() through useToast().
    <ToastContext.Provider value={show}>
      {/* The wrapped component tree. */}
      {children}
      {/* Fixed area at the bottom right; aria-live makes screen readers read new messages. */}
      <div className="toasts" role="status" aria-live="polite">
        {/* One box per notification; the kind sets the color (success, error, info). */}
        {toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

// Hook for components: returns the show function.
export const useToast = () => useContext(ToastContext);
