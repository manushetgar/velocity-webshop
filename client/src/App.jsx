// App.jsx - the frame of the shop: header with navigation and cart, the page routing (which URL shows which
// page) and the footer. The pages themselves are in pages/.
//
// React hook for side effects.
import { useEffect } from 'react';
// Router building blocks: links, active-aware links, redirects, the route table and location/navigation hooks.
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
// Login state and cart (state.jsx).
import { useAuth, useCart } from './state.jsx';
// Icons of the header.
import { CartIcon, UserIcon } from './components/Icons.jsx';
// Product list (start page).
import ShopPage from './pages/ShopPage.jsx';
// Product details.
import ProductPage from './pages/ProductPage.jsx';
// Shopping cart.
import CartPage from './pages/CartPage.jsx';
// Checkout (address + order summary).
import CheckoutPage from './pages/CheckoutPage.jsx';
// Order confirmation.
import ConfirmationPage from './pages/ConfirmationPage.jsx';
// Login.
import LoginPage from './pages/LoginPage.jsx';
// Registration.
import RegisterPage from './pages/RegisterPage.jsx';
// My account: profile, orders, password.
import AccountPage from './pages/AccountPage.jsx';
// Admin area.
import AdminPage from './pages/AdminPage.jsx';

// Guard for pages that need a login (admin = true: only admins). Wraps the page element in the route table.
function RequireLogin({ children, admin = false }) {
  // Login state.
  const { user, ready, isAdmin } = useAuth();
  // Current URL (to come back here after the login).
  const location = useLocation();
  // The stored session is still being checked: show a short loading text instead of redirecting too early.
  if (!ready) return <p className="muted">Loading…</p>;
  // Not logged in: go to the login page and remember where the user wanted to go.
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  // Admin page, but the user is a customer: back to the shop.
  if (admin && !isAdmin) return <Navigate to="/" replace />;
  // Allowed: show the page.
  return children;
}

// Scrolls to the top whenever the page (URL path) changes, like a normal page load would.
function ScrollToTop() {
  // Path of the current URL.
  const { pathname } = useLocation();
  // braces matter: newer Chrome versions return a Promise from scrollTo, and an effect may only return a cleanup function
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  // Renders nothing.
  return null;
}

// The application component.
export default function App() {
  // Logged-in user, admin flag and logout action.
  const { user, isAdmin, logout } = useAuth();
  // Number of items in the cart (badge).
  const { count } = useCart();
  // Navigation function (used after logout).
  const navigate = useNavigate();

  // Logout button: end the session, then go to the start page.
  const signOut = async () => {
    // POST /api/auth/logout and forget the token.
    await logout();
    // Back to the shop.
    navigate('/');
  };

  // Layout of every page: header, the current page, footer.
  return (
    // Outer frame (sticky footer layout in styles.css).
    <div className="app">
      {/* Scroll reset on page changes. */}
      <ScrollToTop />
      {/* Top bar. */}
      <header className="topbar">
        {/* Centered content width. */}
        <div className="container topbar-inner">
          {/* Logo, links to the start page. */}
          <Link to="/" className="brand">
            {/* Square logo mark. */}
            <span className="brand-mark">VC</span>
            {/* Shop name with sub title. */}
            <span className="brand-text">VeloCity<small>Bike Shop</small></span>
          </Link>
          {/* Main navigation. */}
          <nav className="main-nav">
            {/* Shop (active only on exactly '/'). */}
            <NavLink to="/" end>Shop</NavLink>
            {/* Customers: link to their orders. */}
            {user && !isAdmin && <NavLink to="/account/orders">My orders</NavLink>}
            {/* Admins: link to the admin area. */}
            {isAdmin && <NavLink to="/admin">Admin</NavLink>}
          </nav>
          {/* Right side: account and cart. */}
          <div className="nav-right">
            {/* Logged in: account link and logout; otherwise a login link. */}
            {user ? (
              // Fragment: two elements without an extra wrapper.
              <>
                {/* Link to My account. */}
                <NavLink to="/account" className="nav-user" title="My account">
                  {/* Round avatar with the first letter of the name. */}
                  <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                  {/* Name (hidden on small screens). */}
                  <span className="nav-user-name">{user.name}</span>
                  {/* Admin badge. */}
                  {isAdmin && <span className="tag">admin</span>}
                </NavLink>
                {/* Logout button. */}
                <button className="link" onClick={signOut}>Log out</button>
              </>
            ) : (
              // Not logged in: login link.
              <NavLink to="/login" className="nav-login"><UserIcon /> Log in</NavLink>
            )}
            {/* Cart link with the number of items (also read out by screen readers). */}
            <NavLink to="/cart" className="cart-link" aria-label={`Cart, ${count} items`}>
              {/* Cart icon. */}
              <CartIcon />
              {/* Text (hidden on small screens). */}
              <span className="cart-text">Cart</span>
              {/* Badge only when the cart is not empty. */}
              {count > 0 && <span className="badge">{count}</span>}
            </NavLink>
          </div>
        </div>
      </header>

      {/* The current page. */}
      <main className="main">
        {/* Route table: the first route whose path matches the URL is rendered. */}
        <Routes>
          {/* Start page: product list. */}
          <Route path="/" element={<ShopPage />} />
          {/* Product details, :id = product id. */}
          <Route path="/products/:id" element={<ProductPage />} />
          {/* Cart (no login needed). */}
          <Route path="/cart" element={<CartPage />} />
          {/* Checkout needs a login. */}
          <Route path="/checkout" element={<RequireLogin><CheckoutPage /></RequireLogin>} />
          {/* Confirmation after a successful order. */}
          <Route path="/order-confirmation/:id" element={<RequireLogin><ConfirmationPage /></RequireLogin>} />
          {/* Login page. */}
          <Route path="/login" element={<LoginPage />} />
          {/* Registration page. */}
          <Route path="/register" element={<RegisterPage />} />
          {/* My account (default tab). */}
          <Route path="/account" element={<RequireLogin><AccountPage /></RequireLogin>} />
          {/* My account with a tab: profile, orders, password. */}
          <Route path="/account/:tab" element={<RequireLogin><AccountPage /></RequireLogin>} />
          {/* Admin area (admins only). */}
          <Route path="/admin" element={<RequireLogin admin><AdminPage /></RequireLogin>} />
          {/* Admin area with a tab: products, orders, customers, connectors, files, suppliers. */}
          <Route path="/admin/:tab" element={<RequireLogin admin><AdminPage /></RequireLogin>} />
          {/* old links */}
          <Route path="/orders" element={<Navigate to="/account/orders" replace />} />
          {/* Old profile link. */}
          <Route path="/profile" element={<Navigate to="/account" replace />} />
          {/* Any other URL: back to the start page. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {/* Footer. */}
      <footer className="footer">
        {/* Centered content width. */}
        <div className="container footer-inner">
          {/* Left: shop name and course. */}
          <div>
            {/* Shop name. */}
            <strong>VeloCity Bike Shop</strong>
            {/* Course. */}
            <p className="muted small">Lab 1 · Systems Integration · FH Aachen</p>
          </div>
          {/* Right: where the data lives. */}
          <p className="muted small">Products, stock and orders are managed in the Mini-ERP (SAP CAP – local or on SAP BTP).</p>
        </div>
      </footer>
    </div>
  );
}
