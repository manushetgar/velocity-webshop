// state.jsx - global state of the React app, shared with React contexts:
//  - AuthProvider / useAuth(): the logged-in user, login, registration and logout
//  - CartProvider / useCart(): the shopping cart, kept in localStorage until checkout
//
// React functions: create a context, read it, run side effects, keep state.
import { createContext, useContext, useEffect, useState } from 'react';
// API calls (api.js) and the storage of the session token.
import { api, tokenStore } from './api.js';

// ---------- Auth ----------
// Context object for the login state (null until the provider renders).
const AuthContext = createContext(null);

// Provides the login state to all components below it.
export function AuthProvider({ children }) {
  // The logged-in user ({ id, name, email, role, ... }) or null.
  const [user, setUser] = useState(null);
  // false until the stored session has been checked (pages wait for it, e.g. the admin page).
  const [ready, setReady] = useState(false);

  // Runs once at start: restore the session of a token that was stored earlier.
  useEffect(() => {
    // No token stored: nobody is logged in, nothing to check.
    if (!tokenStore.get()) return setReady(true);
    // GET /api/me returns the user of the token; an invalid/expired token is removed. Ready in both cases.
    api.me().then(setUser).catch(() => tokenStore.set(null)).finally(() => setReady(true));
  // Empty dependency list: the effect runs only once.
  }, []);

  // Login: POST /api/auth/login returns a session token and the user.
  const login = async (email, password) => {
    // Wait for the server (throws with the error message on wrong credentials).
    const { token, user } = await api.login(email, password);
    // Store the token: api.js sends it with every request (Authorization: Bearer ...).
    tokenStore.set(token);
    // Remember the user: the header and protected pages update.
    setUser(user);
  };
  // Registration: POST /api/auth/register creates the account and logs the user in at once.
  const register = async data => {
    // Send the form data, receive token and user.
    const { token, user } = await api.register(data);
    // Store the token.
    tokenStore.set(token);
    // Remember the new user.
    setUser(user);
  };
  // Logout: ends the session on the server and forgets it in the browser.
  const logout = async () => {
    // POST /api/auth/logout; errors are ignored (the browser logs out anyway).
    await api.logout().catch(() => {});
    // Remove the stored token.
    tokenStore.set(null);
    // Nobody is logged in any more.
    setUser(null);
  };

  // Render the children with the login state.
  return (
    // Everything components need: the user, actions and the admin flag (role from the server).
    <AuthContext.Provider value={{ user, setUser, ready, login, register, logout, isAdmin: user?.role === 'admin' }}>
      {/* The wrapped component tree. */}
      {children}
    </AuthContext.Provider>
  );
}

// Hook for components: const { user, login, logout } = useAuth().
export const useAuth = () => useContext(AuthContext);

// ---------- Cart (kept in the browser until checkout) ----------
// Context object for the cart.
const CartContext = createContext(null);
// Key of the cart in localStorage.
const CART_KEY = 'webshop.cart';

// Provides the cart to all components below it.
export function CartProvider({ children }) {
  // Cart items [{ product, quantity }], read once from localStorage when the app starts.
  const [items, setItems] = useState(() => {
    // Broken or missing value (or storage blocked): start with an empty cart.
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
  });

  // Save the cart in localStorage whenever it changes (it survives a page reload).
  useEffect(() => {
    // Storage may be blocked (private mode): then the cart lives only in memory.
    try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch { /* ignore */ }
  // Runs again whenever `items` changes.
  }, [items]);

  // Add a product: increase the quantity if it is already in the cart, otherwise add a new line.
  const add = (product, quantity = 1) =>
    // Functional update: always works on the newest state.
    setItems(prev => {
      // The cart line of this product, if any.
      const existing = prev.find(i => i.product.id === product.id);
      // Already in the cart: a new array where only that line has the higher quantity.
      if (existing) return prev.map(i => (i.product.id === product.id ? { ...i, quantity: i.quantity + quantity } : i));
      // Not in the cart yet: append a new line.
      return [...prev, { product, quantity }];
    });
  // Change the quantity of one product (at least 1; removing is a separate action).
  const setQuantity = (productId, quantity) =>
    // Replace only the line of that product.
    setItems(prev => prev.map(i => (i.product.id === productId ? { ...i, quantity: Math.max(1, quantity) } : i)));
  // Remove one product from the cart.
  const remove = productId => setItems(prev => prev.filter(i => i.product.id !== productId));
  // Empty the cart (after a successful checkout).
  const clear = () => setItems([]);

  // Number of items in the cart (badge in the header).
  const count = items.reduce((n, i) => n + i.quantity, 0);
  // Total price of the cart (price x quantity of every line).
  const total = items.reduce((sum, i) => sum + i.product.price * i.quantity, 0);

  // Render the children with the cart.
  return (
    // Everything components need: items, actions, count and total.
    <CartContext.Provider value={{ items, add, setQuantity, remove, clear, count, total }}>
      {/* The wrapped component tree. */}
      {children}
    </CartContext.Provider>
  );
}

// Hook for components: const { items, add, total } = useCart().
export const useCart = () => useContext(CartContext);
