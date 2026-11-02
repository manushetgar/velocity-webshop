import { createContext, useContext, useEffect, useState } from 'react';
import { api, tokenStore } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!tokenStore.get()) return setReady(true);
    api.me().then(setUser).catch(() => tokenStore.set(null)).finally(() => setReady(true));
  }, []);

  const login = async (email, password) => {
    const { token, user } = await api.login(email, password);
    tokenStore.set(token);
    setUser(user);
  };
  const register = async data => {
    const { token, user } = await api.register(data);
    tokenStore.set(token);
    setUser(user);
  };
  const logout = async () => {
    await api.logout().catch(() => {});
    tokenStore.set(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, setUser, ready, login, register, logout, isAdmin: user?.role === 'admin' }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

const CartContext = createContext(null);
const CART_KEY = 'webshop.cart';

export function CartProvider({ children }) {
  const [items, setItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
  });

  useEffect(() => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch {}
  }, [items]);

  const add = (product, quantity = 1) =>
    setItems(prev => {
      const existing = prev.find(i => i.product.id === product.id);
      if (existing) return prev.map(i => (i.product.id === product.id ? { ...i, quantity: i.quantity + quantity } : i));
      return [...prev, { product, quantity }];
    });
  const setQuantity = (productId, quantity) =>
    setItems(prev => prev.map(i => (i.product.id === productId ? { ...i, quantity: Math.max(1, quantity) } : i)));
  const remove = productId => setItems(prev => prev.filter(i => i.product.id !== productId));
  const clear = () => setItems([]);

  const count = items.reduce((n, i) => n + i.quantity, 0);
  const total = items.reduce((sum, i) => sum + i.product.price * i.quantity, 0);

  return (
    <CartContext.Provider value={{ items, add, setQuantity, remove, clear, count, total }}>
      {children}
    </CartContext.Provider>
  );
}

export const useCart = () => useContext(CartContext);
