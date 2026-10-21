// Cliente HTTP de la API v1. Solo transporta: no calcula precios, saldos ni permisos.
// La sesión vive en una cookie HttpOnly que el navegador envía sola; aquí solo se guarda en memoria
// el token anti-CSRF (nunca en localStorage) y se añaden las cabeceras que pide el servidor.

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onSessionLost: (reason: string) => void = () => {};

export const setCsrf = (token: string | null) => {
  csrfToken = token;
};
export const setOnSessionLost = (fn: (reason: string) => void) => {
  onSessionLost = fn;
};

export interface WriteOptions {
  /** Clave de idempotencia: la misma clave en un reintento no repite la operación. */
  idempotencyKey?: string;
  /** Código del segundo factor para acciones que lo piden otra vez. */
  mfaCode?: string;
}

export const newIdempotencyKey = () => crypto.randomUUID();

// Estos códigos significan que la sesión ya no sirve; los demás 401 (por ejemplo, un código del
// segundo factor equivocado en una aprobación) se muestran junto a la acción sin cerrar la sesión.
const SESSION_LOST = new Set(['UNAUTHENTICATED', 'MFA_REQUIRED']);

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: WriteOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  if (opts.mfaCode) headers['x-mfa-code'] = opts.mfaCode;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('NETWORK', 'No hay conexión con el servidor. Revisa tu red e intenta de nuevo.', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.code ?? (res.status >= 500 ? 'INTERNAL' : 'ERROR');
    const err = new ApiError(code, data?.message ?? `Error ${res.status}`, res.status, data?.requestId);
    if (res.status === 401 && SESSION_LOST.has(code) && !path.startsWith('/auth/')) onSessionLost(code);
    throw err;
  }
  return data as T;
}

export const get = <T>(path: string, query?: Record<string, string | number | undefined | null>) => {
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  return request<T>('GET', qs ? `${path}?${qs}` : path);
};

export const post = <T>(path: string, body: unknown = {}, opts?: WriteOptions) => request<T>('POST', path, body, opts);
