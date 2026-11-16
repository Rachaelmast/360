import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type User } from './api.ts';
import { useRoute, Alert } from './ui.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { FindFacility } from './pages/FindFacility.tsx';
import { Leads } from './pages/Leads.tsx';
import { Facility } from './pages/Facility.tsx';
import { Batches } from './pages/Batches.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import './styles.css';

const NAV = [
  ['dashboard', 'Dashboard'],
  ['find', 'Find Facility'],
  ['leads', 'Facility Leads'],
  ['batches', 'Batch Import'],
  ['settings', 'Settings'],
] as const;

function Login({ onDone }: { onDone: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { onDone((await api<{ user: User }>('/api/auth/login', { body: { email, password } })).user); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      }}>
        <div className="row"><Logo /><div><b>SkyBridge Healthcare</b><div className="muted small">Facility Lead Finder</div></div></div>
        {err && <Alert kind="error">{err}</Alert>}
        <label className="field"><span>Email</span><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

const Logo = () => (
  <div className="logo" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 32 32"><path d="M4 22l8-11 6 7 3-4 7 8z" fill="white" /></svg>
  </div>
);

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const route = useRoute();
  useEffect(() => {
    api<{ user: User }>('/api/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null));
    const out = () => setUser(null);
    window.addEventListener('lf:signed-out', out);
    return () => window.removeEventListener('lf:signed-out', out);
  }, []);
  if (user === undefined) return null;
  if (!user) return <Login onDone={setUser} />;
  const [page, id] = route.path;
  let body;
  switch (page) {
    case 'find': body = <FindFacility route={route} />; break;
    case 'leads': body = <Leads route={route} />; break;
    case 'facility': body = <Facility id={id} user={user} />; break;
    case 'batches': body = <Batches id={id} />; break;
    case 'settings': body = <SettingsPage user={user} />; break;
    default: body = <Dashboard />;
  }
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><Logo /><div><b>SkyBridge</b><small>Facility Lead Finder</small></div></div>
        <nav className="nav">
          {NAV.map(([p, label]) => <a key={p} href={`#/${p}`} className={page === p || (p === 'leads' && page === 'facility') || (p === 'dashboard' && !page) ? 'active' : ''}>{label}</a>)}
        </nav>
        <div className="me">
          <div style={{ color: '#fff' }}>{user.name}</div>
          <div>{user.email} · {user.role}</div>
          <button className="small" onClick={async () => { await api('/api/auth/logout', { body: {} }); setUser(null); }}>Sign out</button>
        </div>
      </aside>
      <main className="main">{body}</main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
