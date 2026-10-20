import { useEffect, useState } from 'react';
import { api, hasToken, setOnUnauthorized, setToken } from './api';
import { useLoad } from './hooks';
import Audit from './pages/Audit';
import Clients from './pages/Clients';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Orders from './pages/Orders';
import Quote from './pages/Quote';
import Settings from './pages/Settings';

export interface User {
  id: string;
  username: string;
  roles: string[];
}

const PAGES = [
  { key: 'panel', label: 'Panel', roles: [] },
  { key: 'cotizar', label: 'Cotizar', roles: ['OPERADOR', 'ADMIN'] },
  { key: 'ordenes', label: 'Órdenes', roles: [] },
  { key: 'clientes', label: 'Clientes', roles: [] },
  { key: 'config', label: 'Configuración', roles: [] },
  { key: 'auditoria', label: 'Auditoría', roles: ['ADMIN', 'AUDITOR'] },
] as const;
type PageKey = (typeof PAGES)[number]['key'];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<PageKey>('panel');
  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const system = useLoad<{ mode: string; simulatedChain: boolean; simulatedBank: boolean }>('/system');

  useEffect(() => {
    setOnUnauthorized(() => {
      setToken(null);
      setUser(null);
    });
    if (hasToken()) api<User>('GET', '/me').then(setUser).catch(() => setToken(null));
  }, []);

  const demo = system.data?.mode === 'DEMO';
  const banner = (
    <div className={`env-banner ${demo ? 'demo' : ''}`}>
      {system.data
        ? demo
          ? 'DEMO · datos ficticios · bancos y redes Tron/BSC SIMULADOS · ningún fondo real se mueve'
          : `Entorno ${system.data.mode}`
        : 'Conectando con el servidor…'}
    </div>
  );

  if (!user) {
    return (
      <>
        {banner}
        <Login onLogin={setUser} />
      </>
    );
  }

  const can = (roles: readonly string[]) => roles.length === 0 || roles.some((r) => user.roles.includes(r));
  const goOrder = (id: string) => {
    setOpenOrder(id);
    setPage('ordenes');
  };

  return (
    <>
      {banner}
      <header className="topbar">
        <strong>Mesa OTC</strong>
        <nav>
          {PAGES.filter((p) => can(p.roles)).map((p) => (
            <button key={p.key} className={page === p.key ? 'active' : ''} onClick={() => setPage(p.key)}>
              {p.label}
            </button>
          ))}
        </nav>
        <span className="who">
          {user.username} · {user.roles.join(', ')}
          <button
            className="link"
            onClick={() => {
              setToken(null);
              setUser(null);
            }}
          >
            Salir
          </button>
        </span>
      </header>
      <main>
        {page === 'panel' && <Dashboard onOpenOrder={goOrder} />}
        {page === 'cotizar' && <Quote onOrder={goOrder} />}
        {page === 'ordenes' && <Orders user={user} openId={openOrder} onOpen={setOpenOrder} />}
        {page === 'clientes' && <Clients user={user} />}
        {page === 'config' && <Settings user={user} />}
        {page === 'auditoria' && <Audit />}
      </main>
    </>
  );
}
