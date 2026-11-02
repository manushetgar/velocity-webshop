import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../state.jsx';
import { useToast } from '../components/Toast.jsx';
import AddressFields, { EMPTY_ADDRESS } from '../components/AddressFields.jsx';
import { AuthAside } from './LoginPage.jsx';

export default function RegisterPage() {
  const { register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '' });
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  const submit = async e => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await register({ ...form, address });
      toast(`Welcome, ${form.name}! Your account was created.`, 'success');
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container">
      <div className="auth-layout">
        <AuthAside title="Create your account" text="It takes a minute. Your address is used to ship your orders." />
        <form className="auth-form form-grid three" onSubmit={submit}>
          <div className="span-all">
            <h1>Register</h1>
            <p className="muted">All fields marked * are required.</p>
          </div>
          <label className="span-all">Full name *<input value={form.name} onChange={set('name')} required autoFocus /></label>
          <label className="span-2">E-mail *<input type="email" value={form.email} onChange={set('email')} required /></label>
          <label>Password *<input type="password" minLength="6" value={form.password} onChange={set('password')} required placeholder="min. 6 characters" /></label>
          <label className="span-all">Phone<input value={form.phone} onChange={set('phone')} placeholder="optional" /></label>
          <h3 className="span-all">Shipping address</h3>
          <AddressFields value={address} onChange={setAddress} />
          {error && <p className="error small span-all">{error}</p>}
          <div className="span-all">
            <button className="primary block large" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
            <p className="muted small center">Already registered? <Link to="/login" state={location.state}>Log in</Link></p>
          </div>
        </form>
      </div>
    </div>
  );
}
