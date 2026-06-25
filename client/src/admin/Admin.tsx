import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { AdminApi, login } from '../lib/api';
import { AdminCtx } from './AdminContext';
import './admin.css';

export default function Admin() {
  const [api, setApi] = useState<AdminApi | null>(null);
  const [pwInput, setPwInput] = useState('');
  const [msg, setMsg] = useState('');
  const [live, setLive] = useState(false);

  useEffect(() => {
    const pw = sessionStorage.getItem('imag_pw');
    if (!pw) return;
    const a = new AdminApi(pw);
    a.ok().then((ok) => { if (ok) setApi(a); else sessionStorage.removeItem('imag_pw'); });
  }, []);
  useEffect(() => { if (api) api.config().then((c) => setLive(c.liveGeneration)).catch(() => {}); }, [api]);

  const doLogin = async () => {
    const r = await login(pwInput);
    if (r.ok) { sessionStorage.setItem('imag_pw', pwInput); setApi(new AdminApi(pwInput)); }
    else setMsg('Wrong password.');
  };

  if (!api) {
    return (
      <div className="admin"><div className="card login">
        <h2 style={{ marginBottom: 12 }}>Parent Console</h2>
        <div className="row" style={{ justifyContent: 'center' }}>
          <input type="password" placeholder="Password" value={pwInput}
            onChange={(e) => setPwInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') doLogin(); }} />
          <button className="act" onClick={doLogin}>Enter</button>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>{msg}</p>
      </div></div>
    );
  }

  const tabs = [['log', 'Activity Log'], ['content', 'Content'], ['kids', 'Kids'], ['schedule', 'Scheduling'], ['reading', 'Reading'], ['settings', 'Settings']];
  return (
    <AdminCtx.Provider value={api}>
      <div className="admin">
        <header>
          <h1>🧒 Wondry: Parent Console</h1>
          <span className={`live ${live ? 'on' : ''}`}>generation: {live ? 'LIVE (Claude)' : 'mock'}</span>
        </header>
        <nav>{tabs.map(([to, label]) => <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}</nav>
        <main><Outlet /></main>
      </div>
    </AdminCtx.Provider>
  );
}
