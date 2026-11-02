import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../state.jsx';
import { BikeArt } from '../components/ProductArt.jsx';

export function AuthAside({ title, text }) {
  return (
    <aside className="auth-aside">
      <div>
        <span className="brand-mark light">VC</span>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      <svg viewBox="0 0 120 84" className="auth-art" aria-hidden="true"><BikeArt /></svg>
      <ul>
        <li>Track all your orders and their status</li>
        <li>Save your shipping address</li>
        <li>Orders are processed directly in our ERP</li>
      </ul>
    </aside>
  );
}

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState([]);

  useEffect(() => { api.demoAccounts().then(setDemo).catch(() => {}); }, []);

  const doLogin = async (e, creds) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      const u = creds || { email, password };
      await login(u.email, u.password);
      const target = location.state?.from || (creds?.role === 'admin' ? '/admin' : '/');
      navigate(target, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container">
      <div className="auth-layout">
        <AuthAside title="Welcome back" text="Log in to check out faster and follow your orders." />
        <form className="auth-form" onSubmit={doLogin}>
          <h1>Log in</h1>
          <p className="muted">Use your account or one of the demo accounts below.</p>
          <label>E-mail<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus /></label>
          <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
          {error && <p className="error small">{error}</p>}
          <button className="primary block large" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
          <p className="muted small center">No account yet? <Link to="/register" state={location.state}>Create one</Link></p>

          {demo.length > 0 && (
            <div className="demo-box">
              <span className="demo-title">Demo accounts</span>
              {demo.map(d => (
                <div key={d.email} className="demo-row">
                  <span className={`role-dot ${d.role}`} />
                  <span>
                    <strong>{d.role === 'admin' ? 'Administrator' : 'Customer'}</strong>
                    <span className="muted small">{d.email} · {d.password}</span>
                  </span>
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
