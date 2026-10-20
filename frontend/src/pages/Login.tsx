import { useState } from 'react';
import { api, setToken } from '../api';
import type { User } from '../App';
import { useAction } from '../hooks';

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ token: string; user: User }>('POST', '/auth/login', { username, password });
      setToken(r.token);
      onLogin(r.user);
    });
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Mesa OTC</h1>
        <label>
          Usuario
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !username || !password}>
          Entrar
        </button>
        <p className="muted small">Usuarios de demostración: admin, trader, tesorero2, auditor.</p>
      </form>
    </div>
  );
}
