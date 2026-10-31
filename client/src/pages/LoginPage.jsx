// LoginPage.jsx - login form (/login) with one-click demo accounts. After the login the user goes back to the page
// that needed the login (e.g. the checkout), admins to the admin area.
//
// React hooks: effect (load the demo accounts), state (form fields).
import { useEffect, useState } from 'react';
// Router: links, the current location (where to go back to) and navigation.
import { Link, useLocation, useNavigate } from 'react-router-dom';
// API calls.
import { api } from '../api.js';
// Login action of the global login state.
import { useAuth } from '../state.jsx';
// Bike drawing for the side panel.
import { BikeArt } from '../components/ProductArt.jsx';

// Side panel of the login and registration pages: title, text, picture and the advantages of an account.
export function AuthAside({ title, text }) {
  // The panel markup.
  return (
    // Dark panel next to the form.
    <aside className="auth-aside">
      {/* Top part. */}
      <div>
        {/* Logo mark. */}
        <span className="brand-mark light">VC</span>
        {/* Title (different on login and registration). */}
        <h2>{title}</h2>
        {/* Short text. */}
        <p>{text}</p>
      </div>
      {/* Bike drawing (decorative). */}
      <svg viewBox="0 0 120 84" className="auth-art" aria-hidden="true"><BikeArt /></svg>
      {/* Advantages of an account. */}
      <ul>
        {/* Order tracking. */}
        <li>Track all your orders and their status</li>
        {/* Saved address. */}
        <li>Save your shipping address</li>
        {/* ERP processing. */}
        <li>Orders are processed directly in our ERP</li>
      </ul>
    </aside>
  );
}

// The login page.
export default function LoginPage() {
  // Login action (state.jsx).
  const { login } = useAuth();
  // Navigation after the login.
  const navigate = useNavigate();
  // Current location; state.from = the page that sent the user here.
  const location = useLocation();
  // E-mail field.
  const [email, setEmail] = useState('');
  // Password field.
  const [password, setPassword] = useState('');
  // Error message of the last attempt.
  const [error, setError] = useState('');
  // true while the login request runs (disables the buttons).
  const [busy, setBusy] = useState(false);
  // Demo accounts from the server (empty if DEMO_MODE=false).
  const [demo, setDemo] = useState([]);

  // Load the demo accounts once (GET /api/demo-accounts); errors are ignored (the box is simply not shown).
  useEffect(() => { api.demoAccounts().then(setDemo).catch(() => {}); }, []);

  // Logs in with the form fields, or with a demo account (creds) when its button is clicked.
  const doLogin = async (e, creds) => {
    // Prevent the normal form submit (page reload); e is null for demo buttons.
    e?.preventDefault();
    // Clear the old error.
    setError('');
    // Disable the buttons.
    setBusy(true);
    try {
      // The demo account, or the values typed into the form.
      const u = creds || { email, password };
      // POST /api/auth/login and remember the session.
      await login(u.email, u.password);
      // Where to go: the page that needed the login, else the admin area for admins, else the shop.
      const target = location.state?.from || (creds?.role === 'admin' ? '/admin' : '/');
      // Go there; replace = the login page is not kept in the browser history.
      navigate(target, { replace: true });
    } catch (err) {
      // Wrong e-mail or password: show the message.
      setError(err.message);
    } finally {
      // Enable the buttons again.
      setBusy(false);
    }
  };

  // The page markup.
  return (
    // Centered page width.
    <div className="container">
      {/* Side panel + form. */}
      <div className="auth-layout">
        {/* Side panel. */}
        <AuthAside title="Welcome back" text="Log in to check out faster and follow your orders." />
        {/* The login form; Enter or the button submits it. */}
        <form className="auth-form" onSubmit={doLogin}>
          {/* Title. */}
          <h1>Log in</h1>
          {/* Hint. */}
          <p className="muted">Use your account or one of the demo accounts below.</p>
          {/* E-mail input (browser checks the format). */}
          <label>E-mail<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></label>
          {/* Password input. */}
          <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
          {/* Error message, if any. */}
          {error && <p className="error small">{error}</p>}
          {/* Submit button. */}
          <button className="primary block large" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
          {/* Link to the registration; passes on where to go afterwards. */}
          <p className="muted small center">No account yet? <Link to="/register" state={location.state}>Create one</Link></p>

          {/* Box with the demo accounts (only if the server returned some). */}
          {demo.length > 0 && (
            // Demo box.
            <div className="demo-box">
              {/* Title. */}
              <span className="demo-title">Demo accounts</span>
              {/* One row per demo account. */}
              {demo.map(d => (
                // One demo account.
                <div key={d.email} className="demo-row">
                  {/* Colored dot: admin or customer. */}
                  <span className={`role-dot ${d.role}`} />
                  {/* Role and login data. */}
                  <span>
                    {/* Role. */}
                    <strong>{d.role === 'admin' ? 'Administrator' : 'Customer'}</strong>
                    {/* E-mail and password (demo values only). */}
                    <span className="muted small">{d.email} · {d.password}</span>
                  </span>
                  {/* Logs in with this account. */}
                  <button type="button" className="small-btn" disabled={busy} onClick={() => doLogin(null, d)}>Log in</button>
                </div>
              ))}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
