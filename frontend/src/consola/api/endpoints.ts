import { get, post, type WriteOptions } from './client';
import type * as T from './types';

// Una función por operación de la API v1, agrupadas por módulo. Las pantallas solo usan estas
// funciones; ninguna arma URLs ni decide reglas de negocio por su cuenta.

type W = WriteOptions;

export const system = {
  info: () => get<T.SystemInfo>('/system'),
  dashboard: () => get<T.Dashboard>('/dashboard'),
};

export const auth = {
  me: () => get<T.Me>('/me'),
  csrf: () => get<{ csrfToken: string }>('/auth/csrf'),
  login: (username: string, password: string) =>
    post<{ user: T.Actor; mfa: 'ENROLL' | 'REQUIRED'; csrfToken: string }>('/auth/login', { username, password }),
  enroll: () => post<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll'),
  verify: (code: string) => post<{ csrfToken: string; user: T.Actor }>('/auth/mfa/verify', { code }),
  logout: () => post<{ ok: true }>('/auth/logout'),
};

export const counterparties = {
  list: (q: { search?: string; kyc?: string } = {}) => get<T.CounterpartyRow[]>('/counterparties', q),
  get: (id: string) => get<T.CounterpartyDetail>(`/counterparties/${id}`),
  create: (body: Record<string, unknown>, o: W) => post<{ id: string }>('/counterparties', body, o),
  update: (id: string, body: Record<string, unknown>, o: W) => post(`/counterparties/${id}/versions`, body, o),
  decideKyc: (id: string, status: string, note: string, o: W) => post(`/counterparties/${id}/kyc`, { status, note }, o),
  proposeDestination: (id: string, body: Record<string, unknown>, o: W) => post(`/counterparties/${id}/destinations`, body, o),
  destinations: (status: string) => get<T.Destination[]>('/destinations', { status }),
  decideDestination: (id: string, approve: boolean, note: string, o: W) => post(`/destinations/${id}/decision`, { approve, note }, o),
  revokeDestination: (id: string, reason: string, o: W) => post(`/destinations/${id}/revoke`, { reason }, o),
  originPolicy: () => get<{ networks: T.Network[]; maxNetworksPerClient: number }>('/origins/policy'),
  proposeOrigin: (id: string, body: { network: string; address: string; label: string }, o: W) => post(`/counterparties/${id}/origins`, body, o),
  origins: (status: T.OriginAddress['status']) => get<T.OriginAddress[]>('/origins', { status }),
  decideOrigin: (id: string, approve: boolean, note: string, o: W) => post(`/origins/${id}/decision`, { approve, note }, o),
  revokeOrigin: (id: string, reason: string, o: W) => post(`/origins/${id}/revoke`, { reason }, o),
};

export const pricing = {
  trm: () => get<T.TrmRow[]>('/trm'),
  recordTrm: (rate: string, o: W) => post<T.TrmRow>('/trm', { rate }, o),
  rules: () => get<T.PricingRule[]>('/pricing-rules'),
  setRule: (body: Record<string, unknown>, o: W) => post('/pricing-rules', body, o),
};

export const limits = {
  effective: (counterpartyId?: string) => get<T.Limits>('/limits', { counterpartyId }),
  changes: (status?: string) => get<T.LimitChange[]>('/limit-changes', { status }),
  propose: (body: Record<string, unknown>, o: W) => post('/limit-changes', body, o),
  decide: (id: string, approve: boolean, note: string, o: W) => post(`/limit-changes/${id}/decision`, { approve, note }, o),
};

export const requests = {
  list: (q: { status?: string; counterpartyId?: string } = {}) => get<T.RequestRow[]>('/requests', q),
  get: (id: string) => get<T.RequestDetail>(`/requests/${id}`),
  create: (body: { counterpartyId: string; side: T.Side; usdtAmount: string; network: T.Network; destinationId?: string | null }, o: W) =>
    post<T.RequestDetail>('/requests', body, o),
  cancel: (id: string, reason: string, o: W) => post(`/requests/${id}/cancel`, { reason }, o),
  quote: (id: string, o: W) => post<{ quote: T.Quote; client: T.QuoteClientView }>(`/requests/${id}/quotes`, {}, o),
};

export const quotes = {
  list: (q: { status?: string; requestId?: string } = {}) => get<T.QuoteRow[]>('/quotes', q),
  withdraw: (id: string, reason: string, o: W) => post(`/quotes/${id}/withdraw`, { reason }, o),
  accept: (id: string, o: W) => post<{ order: { id: string; number: string }; alreadyAccepted: boolean }>(`/quotes/${id}/accept`, {}, o),
};

export const orders = {
  list: (q: { status?: string; counterpartyId?: string } = {}) => get<T.OrderRow[]>('/orders', q),
  get: (id: string) => get<T.OrderDetail>(`/orders/${id}`),
  receipt: (id: string) => get<T.Receipt>(`/orders/${id}/receipt`),
  registerPayment: (id: string, reference: string, fromRef: string | null, o: W) => post(`/orders/${id}/payment`, { reference, fromRef }, o),
  approve: (id: string, note: string | null, o: W) => post(`/orders/${id}/approve`, { note }, o),
  review: (id: string, reason: string, o: W) => post(`/orders/${id}/review`, { reason }, o),
  resolveReview: (id: string, action: 'RESUME' | 'CANCEL', note: string, o: W) => post(`/orders/${id}/review/resolve`, { action, note }, o),
  cancel: (id: string, reason: string, o: W) => post(`/orders/${id}/cancel`, { reason }, o),
};

export const transfers = {
  list: (q: { status?: string; purpose?: string; rail?: string; search?: string } = {}) => get<T.TransferRow[]>('/transfers', q),
  get: (id: string) => get<T.TransferDetail>(`/transfers/${id}`),
  observations: (id: string) => get<T.Observation[]>(`/transfers/${id}/observations`),
  instruction: (id: string) => get<T.Instruction>(`/transfers/${id}/instruction`),
  prepareSigning: (id: string, o: W) => post<{ transfer: T.TransferRow; instruction: T.Instruction }>(`/transfers/${id}/signing`, {}, o),
  registerSent: (id: string, reference: string, o: W) => post(`/transfers/${id}/sent`, { reference }, o),
  cancel: (id: string, reason: string, o: W) => post(`/transfers/${id}/cancel`, { reason }, o),
  retry: (id: string, reason: string, o: W) => post(`/transfers/${id}/retry`, { reason }, o),
  check: (id: string) => post(`/transfers/${id}/check`),
  resolveReview: (id: string, to: 'CONFIRMADA' | 'FALLIDA' | 'PENDIENTE', note: string, o: W) =>
    post(`/transfers/${id}/review/resolve`, { to, note }, o),
  originExceptions: (id: string) => get<T.OriginException[]>(`/transfers/${id}/origin-exceptions`),
  pendingOriginExceptions: () => get<T.OriginException[]>('/origin-exceptions', { status: 'SOLICITADA' }),
  requestOriginException: (id: string, reason: string, o: W) => post(`/transfers/${id}/origin-exception`, { reason }, o),
  decideOriginException: (id: string, approve: boolean, note: string, o: W) => post(`/origin-exceptions/${id}/decision`, { approve, note }, o),
  internal: (body: { fromAccountId: string; toAccountId: string; amount: string; reason: string }, o: W) =>
    post('/transfers/internal', body, o),
};

export const liquidity = {
  summary: () => get<T.LiquidityAccount[]>('/liquidity'),
  ledger: (q: { orderId?: string; accountId?: string } = {}) => get<T.LedgerEntry[]>('/ledger', q),
  verify: () => get<{ ok: boolean; mismatches: { code: string; balance: string; ledger: string }[] }>('/ledger/verify'),
  createAccount: (body: Record<string, unknown>, o: W) => post('/accounts', body, o),
  openingBalance: (id: string, amount: string, reason: string, o: W) => post(`/accounts/${id}/opening-balance`, { amount, reason }, o),
};

export const reconciliation = {
  list: (q: { date?: string; status?: string } = {}) => get<T.ReconRunRow[]>('/reconciliations', q),
  get: (id: string) => get<T.ReconRun>(`/reconciliations/${id}`),
  fetch: (accountId: string, date: string) => post<{ runId: string; status: string; lines: number }>('/reconciliations/fetch', { accountId, date }),
  importStatement: (accountId: string, date: string, lines: { reference: string; direction: 'IN' | 'OUT'; amount: string; occurredAt: string }[], o: W) =>
    post<{ runId: string; status: string; lines: number }>('/reconciliations/import', { accountId, date, lines }, o),
  sendToReview: (itemId: string, note: string, o: W) => post(`/reconciliation-items/${itemId}/review`, { note }, o),
  clear: (itemId: string, note: string, o: W) => post(`/reconciliation-items/${itemId}/clear`, { note }, o),
  adjustments: (q: { status?: string; runId?: string } = {}) => get<T.Adjustment[]>('/adjustments', q),
  proposeAdjustment: (itemId: string, amount: string, reason: string, o: W) => post('/adjustments', { itemId, amount, reason }, o),
  decideAdjustment: (id: string, approve: boolean, note: string, o: W) => post(`/adjustments/${id}/decision`, { approve, note }, o),
  close: (id: string, note: string | null, o: W) => post(`/reconciliations/${id}/close`, { note }, o),
};

export const audit = {
  list: (q: Record<string, string | number | undefined>) => get<{ items: T.AuditRecord[]; next: string | null }>('/audit', q),
  verify: () => get<T.AuditVerify>('/audit/verify'),
  anchors: () => get<T.Anchor[]>('/audit/anchors'),
  createAnchor: (note: string | null, o: W) => post<T.Anchor>('/audit/anchors', { note }, o),
  history: (entity: string, id: string) => get<T.HistoryEntry[]>(`/history/${entity}/${id}`),
};

export const users = {
  list: () => get<T.UserRow[]>('/users'),
  create: (body: { username: string; fullName: string; password: string; roles: T.Role[] }, o: W) => post('/users', body, o),
  setRoles: (id: string, roles: T.Role[], o: W) => post(`/users/${id}/roles`, { roles }, o),
  disable: (id: string, reason: string, o: W) => post(`/users/${id}/disable`, { reason }, o),
  enable: (id: string, reason: string, o: W) => post(`/users/${id}/enable`, { reason }, o),
  resetMfa: (id: string, reason: string, o: W) => post(`/users/${id}/mfa-reset`, { reason }, o),
};

export const settings = {
  get: () => get<T.DeskSettings>('/settings'),
  update: (body: Record<string, unknown>, o: W) => post('/settings', body, o),
};

// Solo existe en modo DEMO: el servidor no publica estas rutas en producción.
export const sandbox = {
  simulateTransfer: (id: string, body: { status: string; confirmations?: number; amount?: string; failReason?: string; fromAddress?: string; tokenContract?: string }) =>
    post(`/sandbox/transfers/${id}/simulate`, body),
  simulateMovement: (accountId: string, body: { reference: string; direction: 'IN' | 'OUT'; amount: string }) =>
    post(`/sandbox/accounts/${accountId}/movements`, body),
};
