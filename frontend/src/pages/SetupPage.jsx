import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';

export default function SetupPage() {
  const { setup, error } = useAuth();
  const [form, setForm] = useState({ username: '', password: '', displayName: '' });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try { await setup(form.username, form.password, form.displayName); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--ink-deep)' }}>
      <div className="w-full max-w-sm">
        <div className="w-5 h-px mb-4" style={{ background: 'var(--gold)' }} />
        <p className="font-mono text-xs tracking-widest uppercase mb-2" style={{ color: 'var(--gold)' }}>First Launch</p>
        <h1 className="font-display italic text-3xl mb-1" style={{ color: 'var(--cream)' }}>Create Admin Account</h1>
        <p className="font-body text-sm mb-8" style={{ color: 'var(--cream-mute)' }}>You're the first. Set up your admin account to begin.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {[
            { name: 'displayName', label: 'Display Name', type: 'text' },
            { name: 'username', label: 'Username', type: 'text' },
            { name: 'password', label: 'Password', type: 'password' },
          ].map(({ name, label, type }) => (
            <div key={name}>
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
          ))}

          {error && <p className="font-mono text-xs" style={{ color: '#e05a5a' }}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 font-mono text-xs tracking-widest uppercase mt-2"
            style={{ background: 'var(--gold)', color: 'var(--ink-deep)', borderRadius: '4px', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'Setting up…' : 'Create Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
