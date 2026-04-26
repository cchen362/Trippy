import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function LoginPage() {
  const { login, register, error, clearError } = useAuth();
  const [tab, setTab] = useState('login');
  const [form, setForm] = useState({ username: '', password: '', displayName: '', inviteCode: '' });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    clearError();
    try {
      if (tab === 'login') await login(form.username, form.password);
      else await register(form.username, form.password, form.displayName, form.inviteCode);
    } finally { setLoading(false); }
  };

  const field = (name, label, type = 'text', autoComplete = undefined) => (
    <div className="login-field">
      <label className="login-label" htmlFor={`login-${name}`}>{label}</label>
      <input
        id={`login-${name}`}
        type={type}
        autoComplete={autoComplete}
        value={form[name]}
        onChange={e => setForm(f => ({ ...f, [name]: e.target.value }))}
        required
        className="login-input"
      />
    </div>
  );

  return (
    <div className="login-shell">
      <main className="login-content" aria-label="Trippy account access">
        <section className="login-intro">
          <div className="login-gold-rule" />
          <p className="login-eyebrow">Private itinerary</p>
          <h1>Open your travel dossier.</h1>
          <p className="login-copy">
            Sign in to continue shaping the route, reservations, and quiet details of your next journey.
          </p>
        </section>

        <section className="login-card" aria-label="Account form">
          <div className="login-card-head">
            <p className="login-card-label">Trippy <span /> Access</p>
            <div className="login-route" aria-hidden="true">
              <span>Home</span>
              <i />
              <span>Afar</span>
            </div>
          </div>

          <div className="login-card-body">
            <div className="login-tabs" role="tablist" aria-label="Account access mode">
              {['login', 'register'].map(t => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => { setTab(t); clearError(); setForm({ username: '', password: '', displayName: '', inviteCode: '' }); }}
                  className="login-tab"
                  data-active={tab === t}
                >
                  {t === 'login' ? 'Sign In' : 'Register'}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit} className="login-form">
              {tab === 'register' && field('displayName', 'Display Name', 'text', 'name')}
              {field('username', 'Username', 'text', 'username')}
              {field('password', 'Password', 'password', tab === 'register' ? 'new-password' : 'current-password')}
              {tab === 'register' && field('inviteCode', 'Invite Code', 'text', 'one-time-code')}

              {error && <p className="login-error">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="login-submit"
              >
                {loading ? '...' : tab === 'login' ? 'Open Dossier' : 'Create Dossier'}
              </button>
            </form>
          </div>
        </section>
      </main>

      <style>{`
        .login-shell {
          position: relative;
          min-height: 100vh;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 28px 20px;
          background:
            radial-gradient(circle at 82% 10%, rgba(201, 168, 76, 0.14), transparent 18rem),
            radial-gradient(circle at 16% 92%, rgba(240, 234, 216, 0.045), transparent 18rem),
            var(--ink-deep);
        }

        .login-shell::before {
          content: '';
          position: absolute;
          inset: 0;
          pointer-events: none;
          background:
            linear-gradient(135deg, rgba(255, 255, 255, 0.035), transparent 34%),
            linear-gradient(180deg, transparent 0%, rgba(13, 11, 9, 0.36) 100%);
        }

        .login-content {
          position: relative;
          z-index: 2;
          width: min(100%, 390px);
        }

        .login-intro {
          margin-bottom: 22px;
        }

        .login-gold-rule {
          width: 24px;
          height: 1px;
          margin-bottom: 14px;
          background: var(--gold);
        }

        .login-eyebrow,
        .login-card-label,
        .login-label,
        .login-tab,
        .login-submit,
        .login-error {
          font-family: 'DM Mono', monospace;
          text-transform: uppercase;
        }

        .login-eyebrow {
          margin: 0 0 8px;
          color: var(--gold);
          font-size: 11px;
          letter-spacing: 0.28em;
        }

        .login-intro h1 {
          margin: 0;
          color: var(--cream);
          font-family: 'Playfair Display', serif;
          font-size: 40px;
          font-style: italic;
          font-weight: 400;
          line-height: 0.98;
        }

        .login-copy {
          margin: 12px 0 0;
          max-width: 30rem;
          color: var(--cream-dim);
          font-family: 'Cormorant Garamond', serif;
          font-size: 18px;
          font-weight: 300;
          line-height: 1.28;
        }

        .login-card {
          overflow: hidden;
          border: 1px solid var(--ink-border);
          border-radius: 12px;
          background: linear-gradient(180deg, rgba(35, 32, 24, 0.97), rgba(28, 26, 23, 0.98));
          box-shadow: 0 26px 90px rgba(0, 0, 0, 0.36);
        }

        .login-card-head {
          padding: 18px 18px 15px;
          border-bottom: 1px solid var(--ink-border);
        }

        .login-card-label {
          margin: 0;
          color: var(--gold);
          font-size: 10px;
          letter-spacing: 0.24em;
        }

        .login-card-label span {
          display: inline-block;
          width: 3px;
          height: 3px;
          margin: 0 7px 2px;
          border-radius: 50%;
          background: var(--gold);
        }

        .login-route {
          display: flex;
          align-items: center;
          gap: 11px;
          margin-top: 19px;
        }

        .login-route span {
          color: var(--cream);
          font-family: 'Playfair Display', serif;
          font-size: 32px;
          font-style: italic;
          line-height: 1;
        }

        .login-route i {
          position: relative;
          flex: 1;
          height: 1px;
          background: repeating-linear-gradient(
            to right,
            rgba(201, 168, 76, 0.42) 0,
            rgba(201, 168, 76, 0.42) 2px,
            transparent 2px,
            transparent 7px
          );
        }

        .login-route i::before,
        .login-route i::after {
          content: '';
          position: absolute;
          top: -3px;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: rgba(201, 168, 76, 0.72);
        }

        .login-route i::before { left: 0; }
        .login-route i::after { right: 0; }

        .login-card-body {
          padding: 18px;
        }

        .login-tabs {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 6px;
          margin-bottom: 18px;
        }

        .login-tab {
          min-height: 42px;
          border: 1px solid var(--ink-border);
          border-radius: 8px;
          background: transparent;
          color: var(--cream-mute);
          font-size: 10px;
          letter-spacing: 0.2em;
          transition: border-color 180ms ease, background 180ms ease, color 180ms ease;
        }

        .login-tab[data-active='true'] {
          border-color: var(--gold-line);
          background: var(--gold-soft);
          color: var(--gold);
        }

        .login-form {
          display: flex;
          flex-direction: column;
          gap: 15px;
        }

        .login-label {
          display: block;
          margin-bottom: 7px;
          color: var(--cream-mute);
          font-size: 10px;
          letter-spacing: 0.24em;
        }

        .login-input {
          width: 100%;
          min-height: 48px;
          border: 1px solid var(--ink-border);
          border-radius: 8px;
          background: rgba(13, 11, 9, 0.48);
          color: var(--cream);
          font-family: 'DM Mono', monospace;
          font-size: 14px;
          outline: none;
          padding: 0 13px;
          transition: border-color 180ms ease, background 180ms ease, box-shadow 180ms ease;
        }

        .login-input:focus {
          border-color: var(--gold-line);
          background: rgba(13, 11, 9, 0.68);
          box-shadow: 0 0 0 3px rgba(201, 168, 76, 0.08);
        }

        .login-error {
          margin: 0;
          color: #e08a7a;
          font-size: 11px;
          letter-spacing: 0.08em;
          line-height: 1.45;
        }

        .login-submit {
          width: 100%;
          min-height: 50px;
          margin-top: 3px;
          border: 0;
          border-radius: 8px;
          background: var(--gold);
          color: var(--ink-deep);
          font-size: 10px;
          letter-spacing: 0.24em;
          transition: opacity 180ms ease, transform 180ms ease;
        }

        .login-submit:not(:disabled):hover {
          transform: translateY(-1px);
        }

        .login-submit:disabled {
          cursor: wait;
          opacity: 0.6;
        }

        @media (min-width: 900px) {
          .login-shell {
            justify-content: center;
            padding: 56px clamp(48px, 8vw, 118px);
          }

          .login-content {
            width: min(100%, 430px);
          }

          .login-intro h1 {
            font-size: clamp(44px, 4.8vw, 72px);
          }

          .login-copy {
            font-size: 20px;
          }
        }

        @media (max-width: 420px) {
          .login-shell {
            align-items: flex-start;
            padding: 24px 18px;
          }

          .login-intro h1 {
            font-size: 36px;
          }

          .login-copy {
            font-size: 17px;
          }
        }
      `}</style>
    </div>
  );
}
