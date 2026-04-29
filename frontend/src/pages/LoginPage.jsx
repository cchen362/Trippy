import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

function LuxInput({ label, type = 'text', autoComplete, value, onChange }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <label style={{
        fontFamily: "'DM Mono', monospace", fontSize: 10,
        letterSpacing: '0.14em', textTransform: 'uppercase',
        color: focused ? '#c9a050' : '#504438',
        transition: 'color 200ms',
      }}>{label}</label>
      <input
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          fontFamily: "'Cormorant Garamond', serif", fontSize: 18, fontWeight: 400,
          color: '#f0ebe3', background: 'rgba(13,11,9,0.7)',
          border: `1px solid ${focused ? 'rgba(201,160,80,0.5)' : 'rgba(201,160,80,0.14)'}`,
          borderRadius: 4, padding: '11px 16px', width: '100%',
          letterSpacing: '0.01em', outline: 'none',
          transition: 'border-color 200ms, box-shadow 200ms',
          boxShadow: focused
            ? '0 0 0 1px rgba(201,160,80,0.08), inset 0 1px 3px rgba(0,0,0,0.4)'
            : 'inset 0 1px 3px rgba(0,0,0,0.4)',
        }}
      />
    </div>
  );
}

function LuxButton({ children, loading, disabled }) {
  const [hov, setHov] = useState(false);
  const [press, setPress] = useState(false);
  return (
    <button
      type="submit"
      disabled={disabled || loading}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => { setHov(false); setPress(false); }}
      onMouseDown={() => setPress(true)}
      onMouseUp={() => setPress(false)}
      style={{
        fontFamily: "'DM Mono', monospace", fontSize: 11,
        letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 500,
        border: 'none', borderRadius: 3, padding: '13px 24px',
        width: '100%', cursor: (disabled || loading) ? 'wait' : 'pointer',
        background: hov ? '#d4b470' : '#c9a050',
        color: '#0d0b09',
        transform: press ? 'scale(0.985)' : 'scale(1)',
        transition: 'all 180ms cubic-bezier(0.25,0.1,0.25,1)',
        opacity: (disabled || loading) ? 0.65 : 1,
      }}
    >
      {loading ? 'Signing in…' : children}
    </button>
  );
}

function LoginCard({ isDesktop, tab, setTab, form, setForm, onSubmit, loading, error, clearError }) {
  const isRegister = tab === 'register';

  const field = (name, label, type = 'text', autoComplete) => (
    <LuxInput
      label={label}
      type={type}
      autoComplete={autoComplete}
      value={form[name]}
      onChange={v => setForm(f => ({ ...f, [name]: v }))}
    />
  );

  return (
    <div style={{
      width: isDesktop ? 390 : '100%',
      background: 'rgba(10,8,7,0.92)',
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      border: '1px solid rgba(201,160,80,0.16)',
      borderRadius: 4,
      padding: isDesktop ? '48px 48px 44px' : '36px 32px 32px',
      position: 'relative',
      flexShrink: 0,
      animation: 'lp-fadeUp 0.9s cubic-bezier(0.25,0.1,0.25,1) both, lp-cardGlow 6s 1s ease-in-out infinite',
    }}>
      {/* Gold crown line */}
      <div style={{
        position: 'absolute', top: -1, left: '20%', right: '20%', height: 1,
        background: 'linear-gradient(90deg, transparent, #c9a050 40%, #c9a050 60%, transparent)',
        animation: 'lp-goldBar 4s ease-in-out infinite',
      }} />

      {/* Wordmark */}
      <div style={{ textAlign: 'center', marginBottom: isDesktop ? 32 : 28 }}>
        <div style={{
          fontFamily: "'Cormorant Garamond', serif", fontSize: isDesktop ? 12 : 11,
          fontWeight: 300, color: '#f0ebe3',
          letterSpacing: '0.42em', textTransform: 'uppercase',
          marginBottom: isDesktop ? 10 : 8,
        }}>Trippy</div>
        <div style={{
          width: isDesktop ? 28 : 24, height: 1,
          background: 'rgba(201,160,80,0.5)',
          margin: '0 auto',
        }} />
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 0,
        marginBottom: isDesktop ? 32 : 28,
        borderBottom: '1px solid rgba(201,160,80,0.1)',
      }}>
        {[{ key: 'login', label: 'Sign in' }, { key: 'register', label: 'Register' }].map(({ key, label }) => {
          const active = tab === key;
          return (
            <button key={key} type="button" onClick={() => { setTab(key); clearError(); setForm({ username: '', password: '', displayName: '', inviteCode: '' }); }} style={{
              flex: 1, background: 'none', border: 'none', cursor: 'pointer',
              paddingBottom: isDesktop ? 12 : 10, paddingTop: 4,
              fontFamily: "'DM Mono', monospace",
              fontSize: isDesktop ? 10 : 9,
              letterSpacing: '0.14em', textTransform: 'uppercase',
              color: active ? '#c9a050' : '#3a3028',
              borderBottom: active ? '1px solid #c9a050' : '1px solid transparent',
              marginBottom: -1,
              transition: 'color 200ms, border-color 200ms',
            }}>{label}</button>
          );
        })}
      </div>

      {/* Tagline */}
      <div style={{ textAlign: 'center', marginBottom: isDesktop ? 28 : 24 }}>
        <div style={{
          fontFamily: "'Playfair Display', serif", fontStyle: 'italic',
          fontSize: isDesktop ? 34 : 28, fontWeight: 500,
          color: '#f0ebe3', letterSpacing: '-0.02em',
          lineHeight: 1.15, marginBottom: isDesktop ? 8 : 6,
        }}>
          {isRegister ? 'Join us.' : 'Welcome back.'}
        </div>
        <p style={{
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: isDesktop ? 15 : 14,
          color: '#504438', letterSpacing: '0.02em',
        }}>
          {isRegister ? 'Create your member account.' : 'Your journeys are waiting.'}
        </p>
      </div>

      {/* Form */}
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: isDesktop ? 18 : 16 }}>
        {isRegister && field('displayName', 'Display Name', 'text', 'name')}
        {field('username', 'Username', 'text', 'username')}
        {field('password', 'Password', 'password', isRegister ? 'new-password' : 'current-password')}
        {isRegister && field('inviteCode', 'Invite Code', 'text', 'one-time-code')}

        {!isRegister && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: -4 }}>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: 9,
              letterSpacing: '0.12em', textTransform: 'uppercase',
              color: '#3a3028', cursor: 'default',
            }}>Forgot password</span>
          </div>
        )}

        {error && (
          <p style={{
            margin: 0, color: '#e08a7a',
            fontFamily: "'DM Mono', monospace",
            fontSize: 11, letterSpacing: '0.08em', lineHeight: 1.45,
            textTransform: 'uppercase',
          }}>{error}</p>
        )}

        <div style={{ marginTop: isDesktop ? 6 : 4 }}>
          <LuxButton loading={loading} disabled={loading}>
            {isRegister ? 'Create account' : 'Sign in'}
          </LuxButton>
        </div>
      </form>

      {/* Bottom gold line */}
      <div style={{
        position: 'absolute', bottom: -1, left: '20%', right: '20%', height: 1,
        background: 'linear-gradient(90deg, transparent, rgba(201,160,80,0.2), transparent)',
      }} />
    </div>
  );
}

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
    } finally {
      setLoading(false);
    }
  };

  const cardProps = { tab, setTab, form, setForm, onSubmit: handleSubmit, loading, error, clearError };

  return (
    <>
      {/* Mobile layout */}
      <div className="lp-mobile">
        <div className="lp-medallion-wrap">
          <img src="/assets/mobile-vignette.png" alt="" className="lp-medallion-img" />
          <div className="lp-medallion-fade" />
        </div>
        <div className="lp-mobile-card-wrap">
          <LoginCard isDesktop={false} {...cardProps} />
        </div>
      </div>

      {/* Desktop layout */}
      <div className="lp-desktop">
        <div className="lp-desktop-overlay" />
        <div className="lp-desktop-card-wrap">
          <LoginCard isDesktop={true} {...cardProps} />
        </div>
      </div>

      <style>{`
        @keyframes lp-fadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes lp-cardGlow {
          0%, 100% { box-shadow: 0 8px 48px rgba(0,0,0,0.75), 0 0 0 1px rgba(201,160,80,0.1); }
          50%       { box-shadow: 0 8px 60px rgba(0,0,0,0.8), 0 0 24px rgba(201,160,80,0.06), 0 0 0 1px rgba(201,160,80,0.18); }
        }
        @keyframes lp-goldBar {
          0%   { opacity: 0.4; transform: scaleX(0.6); }
          50%  { opacity: 0.9; transform: scaleX(1); }
          100% { opacity: 0.4; transform: scaleX(0.6); }
        }

        input:-webkit-autofill {
          -webkit-box-shadow: 0 0 0 100px #1a1410 inset !important;
          -webkit-text-fill-color: #f0ebe3 !important;
          caret-color: #f0ebe3;
        }
        input::placeholder { color: #3a3028; }

        /* ── Mobile (default) ─────────────────────── */
        .lp-mobile {
          display: flex;
          flex-direction: column;
          align-items: center;
          min-height: 100vh;
          overflow-x: hidden;
          background: #0d0b09;
        }
        .lp-desktop { display: none; }

        .lp-medallion-wrap {
          position: relative;
          width: min(80vw, 320px);
          flex-shrink: 0;
          margin-top: clamp(16px, 4vh, 40px);
          animation: lp-fadeUp 0.8s cubic-bezier(0.25,0.1,0.25,1) both;
        }
        .lp-medallion-img {
          width: 100%;
          height: auto;
          display: block;
        }
        .lp-medallion-fade {
          position: absolute;
          inset: 0;
          background: radial-gradient(ellipse 80% 60% at 50% 110%, #0d0b09 0%, transparent 70%);
          pointer-events: none;
        }

        .lp-mobile-card-wrap {
          width: 100%;
          max-width: 390px;
          padding: 0 20px 48px;
          animation: lp-fadeUp 0.9s 0.2s cubic-bezier(0.25,0.1,0.25,1) both;
        }

        /* ── Desktop (≥800px) ─────────────────────── */
        @media (min-width: 800px) {
          .lp-mobile  { display: none; }
          .lp-desktop {
            display: flex;
            align-items: center;
            position: relative;
            width: 100%;
            min-height: 100vh;
            padding-left: clamp(120px, 18vw, 260px);
            background-image: url('/assets/illustration-login.png');
            background-size: cover;
            background-position: center right;
          }
          .lp-desktop-overlay {
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, rgba(13,11,9,0.18) 0%, transparent 28%);
            pointer-events: none;
          }
          .lp-desktop-card-wrap {
            position: relative;
            z-index: 2;
          }
        }
      `}</style>
    </>
  );
}
