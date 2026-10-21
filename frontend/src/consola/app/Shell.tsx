import { useEffect, useState, type ReactNode } from 'react';
import { system as systemApi } from '../api/endpoints';
import type { Dashboard } from '../api/types';
import { copPrice } from '../lib/format';
import { useQuery } from '../lib/hooks';
import { ROLE } from '../lib/labels';
import { NAV } from './nav';
import { href } from './router';
import { isDemo, useSession } from './session';

/** Estructura fija: franja de entorno, menú lateral con pendientes, barra superior y contenido. */
export function Shell({ active, children }: { active: string; children: ReactNode }) {
  const { me, system, can, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  // Contadores de pendientes del menú: se refrescan cada 30 segundos.
  const dash = useQuery<Dashboard>(() => systemApi.dashboard(), [], { refreshMs: 30000 });
  useEffect(() => setMenuOpen(false), [active]);

  const items = NAV.filter((n) => can(n.permission));
  return (
    <div className="app">
      <EnvBanner />
      <div className="app-body">
        <nav className={`sidebar ${menuOpen ? 'is-open' : ''}`} aria-label="Módulos">
          <div className="sidebar-brand">
            <span className="brand-mark" aria-hidden>
              OTC
            </span>
            <div>
              <strong>Mesa OTC</strong>
              <span>USDT · COP</span>
            </div>
          </div>
          <ul>
            {items.map((n, i) => {
              const count = dash.data && n.badge ? n.badge(dash.data) : 0;
              return (
                <li key={n.key}>
                  <a href={href(n.key)} className={active === n.key ? 'is-active' : ''} aria-current={active === n.key ? 'page' : undefined}>
                    <span className="nav-index">{i + 1}</span>
                    <span className="nav-label">{n.label}</span>
                    {count > 0 && (
                      <span className="nav-badge" title="Pendientes">
                        {count}
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
          <a className="sidebar-legacy" href="/" title="La demo anterior sigue disponible mientras se completa la migración">
            Abrir demo anterior
          </a>
        </nav>
        {menuOpen && <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />}
        <div className="main-col">
          <header className="topbar">
            <button className="icon-btn menu-btn" aria-label="Abrir menú" onClick={() => setMenuOpen((v) => !v)}>
              ☰
            </button>
            <div className="topbar-trm">
              {dash.data?.trm ? (
                <>
                  <span className="muted">TRM {dash.data.today}</span> <strong>{copPrice(dash.data.trm.rate)}</strong>
                  {dash.data.trm.simulated && <span className="sim-tag">SIMULADA</span>}
                </>
              ) : dash.data ? (
                <span className="text-warning">Sin TRM cargada hoy: no se puede cotizar</span>
              ) : null}
            </div>
            <div className="topbar-user">
              <div className="user-meta">
                <strong>{me.user.fullName ?? me.user.username}</strong>
                <span>{me.user.roles.map((r) => ROLE[r] ?? r).join(' · ')}</span>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={logout}>
                Cerrar sesión
              </button>
            </div>
          </header>
          <main className="content" id="contenido">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

export function EnvBanner() {
  const { system } = useSession();
  if (!isDemo(system)) return null;
  return (
    <div className="env-banner" role="note">
      <strong>DATOS SIMULADOS</strong>
      <span>Entorno de demostración: clientes, saldos, bancos y redes Tron/BSC son ficticios. Ningún fondo real se mueve.</span>
    </div>
  );
}
