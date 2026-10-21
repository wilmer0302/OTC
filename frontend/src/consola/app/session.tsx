import { createContext, useContext } from 'react';
import type { Me, SystemInfo } from '../api/types';

export interface Session {
  me: Me;
  system: SystemInfo | null;
  /** Solo decide qué botones mostrar; el servidor vuelve a verificar cada permiso. */
  can: (permission: string) => boolean;
  logout: () => void;
}

export const SessionCtx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('Sin sesión');
  return s;
}

export const useCan = () => useSession().can;
export const isDemo = (s: SystemInfo | null) => s?.mode === 'DEMO';
