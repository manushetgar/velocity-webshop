// main.jsx - entry point of the React app: renders <App /> into <div id="root"> of index.html and wraps it in the
// providers that every page needs (routing, toasts, login state, cart).
//
// StrictMode: extra checks during development (e.g. effects run twice to find missing cleanups).
import { StrictMode } from 'react';
// createRoot: the React 18+ API that attaches React to a DOM element.
import { createRoot } from 'react-dom/client';
// BrowserRouter: client-side routing with normal URLs (/cart, /admin ...) via the History API.
import { BrowserRouter } from 'react-router-dom';
// Contexts for the logged-in user and the shopping cart (state.jsx).
import { AuthProvider, CartProvider } from './state.jsx';
// Context for the small notifications at the bottom of the screen (Toast.jsx).
import { ToastProvider } from './components/Toast.jsx';
// The application itself: header, pages, footer.
import App from './App.jsx';
// Global styles of the whole shop (one CSS file, no UI library).
import './styles.css';

// Find the mount point in index.html and render the component tree into it.
createRoot(document.getElementById('root')).render(
  // Development checks for the whole app.
  <StrictMode>
    {/* Routing: pages are chosen by the URL without reloading the page. */}
    <BrowserRouter>
      {/* Toasts are available on every page (useToast()). */}
      <ToastProvider>
        {/* Login state: the user is loaded once at start (GET /api/me). */}
        <AuthProvider>
          {/* Cart: kept in the browser until checkout. */}
          <CartProvider>
            {/* The application. */}
            <App />
          </CartProvider>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
