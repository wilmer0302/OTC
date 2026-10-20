// Cliente HTTP. El frontend no calcula precios ni decide estados: solo llama a la API.

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

let token: string | null = sessionStorage.getItem('otc.token');
let onUnauthorized: () => void = () => {};

export function setToken(t: string | null) {
  token = t;
  if (t) sessionStorage.setItem('otc.token', t);
  else sessionStorage.removeItem('otc.token');
}
export const hasToken = () => !!token;
export const setOnUnauthorized = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = any>(method: string, path: string, body?: unknown, idempotent = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotent) headers['idempotency-key'] = crypto.randomUUID();
  const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(data.code ?? 'ERROR', data.message ?? `Error ${res.status}`, res.status);
  }
  return data as T;
}
