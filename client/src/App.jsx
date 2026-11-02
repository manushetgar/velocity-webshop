import { useEffect } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useCart } from './state.jsx';
import { CartIcon, UserIcon } from './components/Icons.jsx';
import ShopPage from './pages/ShopPage.jsx';
import ProductPage from './pages/ProductPage.jsx';
import CartPage from './pages/CartPage.jsx';
import CheckoutPage from './pages/CheckoutPage.jsx';
import ConfirmationPage from './pages/ConfirmationPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import AdminPage from './pages/AdminPage.jsx';

function RequireLogin({ children, admin = false }) {
  const { user, ready, isAdmin } = useAuth();
  const location = useLocation();
  if (!ready) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (admin && !isAdmin) return <Navigate to="/" replace />;
  return children;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

export default function App() {
  const { user, isAdmin, logout } = useAuth();
  const { count } = useCart();
  const navigate = useNavigate();

  const signOut = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="app">
      <ScrollToTop />
      <header className="topbar">
        <div className="container topbar-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">VC</span>
            <span className="brand-text">VeloCity<small>Bike Shop</small></span>
          </Link>
          <nav className="main-nav">
            <NavLink to="/" end>Shop</NavLink>
            {user && !isAdmin && <NavLink to="/account/orders">My orders</NavLink>}
            {isAdmin && <NavLink to="/admin">Admin</NavLink>}
          </nav>
          <div className="nav-right">
            {user ? (
              <>
                <NavLink to="/account" className="nav-user" title="My account">
                  <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                  <span className="nav-user-name">{user.name}</span>
                  {isAdmin && <span className="tag">admin</span>}
                </NavLink>
                <button className="link" onClick={signOut}>Log out</button>
              </>
            ) : (
              <NavLink to="/login" className="nav-login"><UserIcon /> Log in</NavLink>
            )}
            <NavLink to="/cart" className="cart-link" aria-label={`Cart, ${count} items`}>
              <CartIcon />
              <span className="cart-text">Cart</span>
              {count > 0 && <span className="badge">{count}</span>}
            </NavLink>
          </div>
        </div>
      </header>

      <main className="main">
        <Routes>
          <Route path="/" element={<ShopPage />} />
          <Route path="/products/:id" element={<ProductPage />} />
          <Route path="/cart" element={<CartPage />} />
          <Route path="/checkout" element={<RequireLogin><CheckoutPage /></RequireLogin>} />
          <Route path="/order-confirmation/:id" element={<RequireLogin><ConfirmationPage /></RequireLogin>} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/account" element={<RequireLogin><AccountPage /></RequireLogin>} />
          <Route path="/account/:tab" element={<RequireLogin><AccountPage /></RequireLogin>} />
          <Route path="/admin" element={<RequireLogin admin><AdminPage /></RequireLogin>} />
          <Route path="/admin/:tab" element={<RequireLogin admin><AdminPage /></RequireLogin>} />
          <Route path="/orders" element={<Navigate to="/account/orders" replace />} />
          <Route path="/profile" element={<Navigate to="/account" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer className="footer">
        <div className="container footer-inner">
          <div>
            <strong>VeloCity Bike Shop</strong>
            <p className="muted small">Lab 1 · Systems Integration · FH Aachen</p>
          </div>
          <p className="muted small">Products, stock and orders are managed in the Mini-ERP (SAP CAP – local or on SAP BTP).</p>
        </div>
      </footer>
    </div>
  );
}
