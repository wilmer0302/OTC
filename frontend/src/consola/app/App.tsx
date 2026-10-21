import { useCallback, useEffect, useState } from 'react';
import { setCsrf, setOnSessionLost } from '../api/client';
import { auth, system as systemApi } from '../api/endpoints';
import type { Me, SystemInfo } from '../api/types';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { ToastProvider } from '../ui/Feedback';
import { Loading } from '../ui/Layout';
import { MODULES } from '../modules';
import { Login } from './Login';
import { NAV } from './nav';
import { useRoute } from './router';
import { SessionCtx, type Session } from './session';
import { Shell } from './Shell';

type State = { kind: 'loading' } | { kind: 'login'; step?: 'code'; notice?: string } | { kind: 'in'; me: Me };

export default function App() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const route = useRoute();

  const loadMe = useCallback(async () => {
    try {
      const me = await auth.me();
      if (!me.mfaVerified) return setState({ kind: 'login', step: 'code' });
      // Tras recargar la página el token anti-CSRF se pide de nuevo (solo vive en memoria).
      setCsrf((await auth.csrf()).csrfToken);
      setState({ kind: 'in', me });
    } catch {
      setState({ kind: 'login' });
    }
  }, []);

  useEffect(() => {
    systemApi.info().then(setSystem, () => setSystem(null));
    setOnSessionLost(() => {
      setCsrf(null);
      setState({ kind: 'login', notice: 'Tu sesión terminó. Inicia sesión de nuevo.' });
    });
    loadMe();
  }, [loadMe]);

  useEffect(() => {
    document.title = system?.mode === 'DEMO' ? 'Mesa OTC · DATOS SIMULADOS' : 'Mesa OTC';
  }, [system]);

  if (state.kind === 'loading') return <Loading label="Conectando con el servidor…" />;
  if (state.kind === 'login') return <Login system={system} initialStep={state.step} notice={state.notice} onDone={loadMe} />;

  const session: Session = {
    me: state.me,
    system,
    can: (p) => state.me.permissions.includes(p),
    logout: async () => {
      await auth.logout().catch(() => undefined);
      setCsrf(null);
      setState({ kind: 'login' });
    },
  };

  const key = route.path[0] ?? 'inicio';
  const nav = NAV.find((n) => n.key === key) ?? NAV[0];
  const Page = MODULES[nav.key];
  return (
    <SessionCtx.Provider value={session}>
      <ToastProvider>
        <Shell active={nav.key}>
          <ErrorBoundary resetKey={window.location.hash}>
            <Page route={route} />
          </ErrorBoundary>
        </Shell>
      </ToastProvider>
    </SessionCtx.Provider>
  );
}
