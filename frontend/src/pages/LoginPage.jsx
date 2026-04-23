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

  const field = (name, label, type = 'text') => (
    <div>
      <label className="font-mono text-xs tracking-widest uppercase block mb-1" style={{ color: 'var(--cream-mute)' }}>{label}</label>
      <input
        type={type}
        value={form[name]}
        onChange={e => setForm(f => ({ ...f, [name]: e.target.value }))}
        required
        className="w-full px-3 py-2 rounded text-sm font-mono"
        style={{ background: 'var(--ink-mid)', border: '1px solid var(--ink-border)', color: 'var(--cream)', outline: 'none' }}
      />
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--ink-deep)' }}>
      <div className="w-full max-w-sm">
        <div className="w-5 h-px mb-4" style={{ background: 'var(--gold)' }} />
        <p className="font-mono text-xs tracking-widest uppercase mb-1" style={{ color: 'var(--gold)' }}>Trippy</p>
        <h1 className="font-display italic text-3xl mb-8" style={{ color: 'var(--cream)' }}>Welcome back.</h1>

        {/* Tabs */}
        <div className="flex mb-6 gap-1">
          {['login', 'register'].map(t => (
            <button
              key={t}
              onClick={() => { setTab(t); clearError(); setForm({ username: '', password: '', displayName: '', inviteCode: '' }); }}
              className="flex-1 py-2 font-mono text-xs tracking-widest uppercase"
              style={{
                background: tab === t ? 'var(--gold-soft)' : 'transparent',
                border: '1px solid',
                borderColor: tab === t ? 'var(--gold-line)' : 'var(--ink-border)',
                color: tab === t ? 'var(--gold)' : 'var(--cream-mute)',
                borderRadius: '4px',
              }}
            >
              {t === 'login' ? 'Sign In' : 'Register'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {tab === 'register' && field('displayName', 'Display Name')}
          {field('username', 'Username')}
          {field('password', 'Password', 'password')}
          {tab === 'register' && field('inviteCode', 'Invite Code')}

          {error && <p className="font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 font-mono text-xs tracking-widest uppercase mt-2"
            style={{ background: 'var(--gold)', color: 'var(--ink-deep)', borderRadius: '4px', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? '…' : tab === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
