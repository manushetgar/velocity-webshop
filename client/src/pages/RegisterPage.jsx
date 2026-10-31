// RegisterPage.jsx - registration form (/register): name, e-mail, password, phone and address. The server creates
// the account (and the customer in the ERP) and logs the user in at once.
//
// React state for the form.
import { useState } from 'react';
// Router: links, location (where to go afterwards) and navigation.
import { Link, useLocation, useNavigate } from 'react-router-dom';
// Registration action of the global login state.
import { useAuth } from '../state.jsx';
// Notifications.
import { useToast } from '../components/Toast.jsx';
// Address inputs and an empty address.
import AddressFields, { EMPTY_ADDRESS } from '../components/AddressFields.jsx';
// Side panel shared with the login page.
import { AuthAside } from './LoginPage.jsx';

// The registration page.
export default function RegisterPage() {
  // Registration action (state.jsx).
  const { register } = useAuth();
  // Notifications.
  const toast = useToast();
  // Navigation after the registration.
  const navigate = useNavigate();
  // Current location; state.from = the page that sent the user here.
  const location = useLocation();
  // Personal data of the form.
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '' });
  // Address of the form.
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  // Error message from the server (e.g. e-mail already registered).
  const [error, setError] = useState('');
  // true while the request runs.
  const [busy, setBusy] = useState(false);
  // Change handler for one field of the personal data.
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  // Sends the form.
  const submit = async e => {
    // No page reload.
    e.preventDefault();
    // Clear the old error.
    setError('');
    // Disable the button.
    setBusy(true);
    try {
      // POST /api/auth/register with personal data and address.
      await register({ ...form, address });
      // Welcome message.
      toast(`Welcome, ${form.name}! Your account was created.`, 'success');
      // Back to the page that needed the login (e.g. checkout), else the shop.
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      // Show the server's message.
      setError(err.message);
    } finally {
      // Enable the button again.
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
        <AuthAside title="Create your account" text="It takes a minute. Your address is used to ship your orders." />
        {/* The form as a three-column grid. */}
        <form className="auth-form form-grid three" onSubmit={submit}>
          {/* Title over the full width. */}
          <div className="span-all">
            {/* Title. */}
            <h1>Register</h1>
            {/* Hint. */}
            <p className="muted">All fields marked * are required.</p>
          </div>
          {/* Full name. */}
          <label className="span-all">Full name *<input value={form.name} onChange={set('name')} required autoFocus /></label>
          {/* E-mail (two columns). */}
          <label className="span-2">E-mail *<input type="email" value={form.email} onChange={set('email')} required /></label>
          {/* Password (at least 6 characters, checked by the browser and the server). */}
          <label>Password *<input type="password" minLength="6" value={form.password} onChange={set('password')} required placeholder="min. 6 characters" /></label>
          {/* Phone (optional). */}
          <label className="span-all">Phone<input value={form.phone} onChange={set('phone')} placeholder="optional" /></label>
          {/* Address section. */}
          <h3 className="span-all">Shipping address</h3>
          {/* Street, house number, postal code, city, country. */}
          <AddressFields value={address} onChange={setAddress} />
          {/* Error message, if any. */}
          {error && <p className="error small span-all">{error}</p>}
          {/* Button and login link. */}
          <div className="span-all">
            {/* Submit button. */}
            <button className="primary block large" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
            {/* Link to the login page. */}
            <p className="muted small center">Already registered? <Link to="/login" state={location.state}>Log in</Link></p>
          </div>
        </form>
      </div>
    </div>
  );
}
