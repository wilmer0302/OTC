// Formas de las respuestas de la API v1. Los montos llegan como texto decimal y así se conservan:
// el navegador no los convierte a número para operar, solo para dar formato.

export type Role = 'OPERADOR' | 'TESORERO' | 'CUMPLIMIENTO' | 'ADMIN' | 'AUDITOR';
export type Side = 'BUY' | 'SELL';
export type Network = 'TRON' | 'BSC';
export type Rail = 'BANK' | 'TRON' | 'BSC';
export type Asset = 'COP' | 'USDT';

export interface Actor {
  id: string;
  username: string;
  fullName?: string;
  roles: Role[];
}

export interface Me {
  user: Actor;
  mfaVerified: boolean;
  permissions: string[];
  mode: 'DEMO' | 'PRODUCTION';
}

export interface SystemInfo {
  mode: 'DEMO' | 'PRODUCTION';
  sandbox: { chain: boolean; bank: boolean };
}

export interface HistoryEntry {
  id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
  actor_name: string | null;
}

export interface Dashboard {
  today: string;
  trm: { rate: string; source: string; simulated: boolean; loadedAt: string } | null;
  counts: { orders: Record<string, number>; requests: Record<string, number>; transfers: Record<string, number> };
  completedToday: { side: Side; orders: number; usdt: string; cop: string; commission: string; margin: string | null }[];
  attention: Record<
    | 'ordersAwaitingApproval'
    | 'ordersInReview'
    | 'deliveriesToSign'
    | 'transfersInReview'
    | 'transfersFailed'
    | 'reconWithDifferences'
    | 'adjustmentsProposed'
    | 'limitChangesProposed'
    | 'destinationsProposed'
    | 'kycPending',
    number
  >;
  liquidity: { asset: Asset; accounts: number; balance: string; reserved: string; available: string }[];
}

export interface CounterpartyRow {
  id: string;
  number: string;
  kind: 'CLIENTE' | 'PROVEEDOR';
  document_type: string;
  document_number: string;
  kyc_status: 'PENDIENTE' | 'APROBADO' | 'RECHAZADO' | 'BLOQUEADO';
  legal_name: string;
  created_at: string;
}

export interface Destination {
  id: string;
  counterparty_id: string;
  rail: Rail;
  value: string;
  bank_name: string | null;
  account_type: string | null;
  holder_document: string | null;
  label: string;
  status: 'PROPUESTO' | 'APROBADO' | 'RECHAZADO' | 'REVOCADO';
  proposed_at: string;
  decided_at: string | null;
  decision_note: string | null;
  revoke_reason: string | null;
  counterparty_name?: string;
  proposed_by_name?: string;
}

export interface CounterpartyDetail extends CounterpartyRow {
  person_type: 'NATURAL' | 'JURIDICA';
  current_version: number;
  email: string | null;
  phone: string | null;
  notes: string | null;
  versions: { version: number; legal_name: string; email: string | null; phone: string | null; notes: string | null; reason: string; created_at: string; created_by_name: string }[];
  kycHistory: { from_status: string; to_status: string; note: string; created_at: string; reviewed_by_name: string }[];
  destinations: Destination[];
}

export interface RequestRow {
  id: string;
  number: string;
  side: Side;
  usdt_amount: string;
  network: Network;
  status: string;
  status_reason: string | null;
  expires_at: string;
  created_at: string;
  counterparty_name: string;
}

export interface Quote {
  id: string;
  number: string;
  request_id: string;
  side: Side;
  usdt_amount: string;
  trm_rate: string;
  margin_cop: string;
  commission_rate: string;
  base_price_cop: string;
  unit_price_cop: string;
  subtotal_cop: string;
  commission_cop: string;
  total_cop: string;
  margin_total_cop: string;
  status: string;
  status_reason: string | null;
  expires_at: string;
  created_at: string;
}

export interface QuoteRow {
  id: string;
  number: string;
  request_id: string;
  request_number: string;
  side: Side;
  network: Network;
  usdt_amount: string;
  unit_price_cop: string;
  total_cop: string;
  commission_cop: string;
  status: string;
  status_reason: string | null;
  expires_at: string;
  created_at: string;
  counterparty_name: string;
  order_id: string | null;
  order_number: string | null;
}

export interface RequestDetail extends RequestRow {
  counterparty_id: string;
  destination_id: string | null;
  quotes: Quote[];
  order: { id: string; number: string; status: string } | null;
  history: HistoryEntry[];
}

/** Lo que ve el cliente: precio todo incluido y detalle de la comisión. Nunca la TRM ni el margen. */
export interface ClientPrice {
  side: Side;
  usdtAmount: string;
  unitPriceCop: string;
  totalCop: string;
  detail: { basePriceCop: string; subtotalCop: string; commissionCop: string; totalCop: string };
}

export interface QuoteClientView {
  number: string;
  status: string;
  expiresAt: string;
  price: ClientPrice;
}

export interface OrderRow {
  id: string;
  number: string;
  side: Side;
  network: Network;
  usdt_amount: string;
  unit_price_cop: string;
  total_cop: string;
  status: string;
  payment_deadline: string;
  created_at: string;
  counterparty_name: string;
}

export interface TransferRow {
  id: string;
  number: string;
  purpose: 'COBRO' | 'ENTREGA' | 'DEVOLUCION' | 'TRASLADO';
  direction: 'IN' | 'OUT';
  rail: Rail;
  asset: Asset;
  amount: string;
  status: string;
  status_reason: string | null;
  external_ref: string | null;
  confirmations: number | null;
  sent_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  order_number: string | null;
  account_code: string;
}

export interface TransferDetail extends TransferRow {
  order_id: string | null;
  account_id: string;
  destination_id: string | null;
  to_account_id: string | null;
  to_account_code: string | null;
  counterparty_ref: string | null;
  retry_of: string | null;
  history: HistoryEntry[];
}

export interface Observation {
  id: string;
  source: string;
  sandbox: boolean;
  payload: Record<string, unknown>;
  outcome: string;
  note: string | null;
  observed_at: string;
}

export interface Instruction {
  transfer: string;
  rail: Rail;
  asset: Asset;
  amount: string;
  amountBaseUnits: string | null;
  from: { account: string; name: string; ref: string | null };
  to: { kind: string; value: string; bank?: string | null };
  note: string;
}

export interface OrderDetail extends OrderRow {
  counterparty_id: string;
  request_id: string;
  quote_id: string;
  base_price_cop: string;
  subtotal_cop: string;
  commission_cop: string;
  margin_total_cop: string;
  trm_rate: string;
  trm_source: string;
  margin_cop: string;
  commission_rate: string;
  approval_policy: ApprovalPolicy;
  required_approvals: number;
  status_reason: string | null;
  review_from: string | null;
  reservations: { id: string; status: string; amount: string; account: string }[];
  approvals: { created_at: string; note: string | null; approved_by_name: string }[];
  transfers: TransferRow[];
  history: HistoryEntry[];
}

export interface Receipt {
  number: string;
  status: string;
  network: Network;
  paymentDeadline: string;
  price: ClientPrice;
  payTo: { asset: Asset; amount: string; account?: string; network?: Network; address?: string };
  receiveAt: { rail: Rail; bank: string | null; value: string };
}

export interface LiquidityAccount {
  id: string;
  code: string;
  name: string;
  asset: Asset;
  liquidity_type: 'BANK' | 'WALLET' | 'EXCHANGE';
  network: Network | null;
  external_ref: string | null;
  is_default: boolean;
  balance: string;
  reserved: string;
  available: string;
}

export interface LedgerEntry {
  id: string;
  seq: string;
  kind: string;
  description: string | null;
  order_id: string | null;
  transfer_id: string | null;
  reverses_entry_id: string | null;
  created_at: string;
  /** Monto con signo: positivo entra a la cuenta, negativo sale. */
  lines: { account: string; asset: Asset; amount: string | number }[];
}

export interface ReconRunRow {
  id: string;
  business_date: string;
  status: 'ABIERTO' | 'CUADRADO' | 'CON_DIFERENCIAS' | 'CERRADO';
  account_code: string;
  open_items: number;
}

export interface ReconItem {
  id: string;
  number: string;
  status: string;
  status_reason: string | null;
  expected_amount: string | null;
  observed_amount: string | null;
  external_ref: string | null;
  direction: 'IN' | 'OUT' | null;
  source: string | null;
  occurred_at: string | null;
  transfer_id: string | null;
  transfer_number: string | null;
  adjustment_id: string | null;
}

export interface ReconRun extends ReconRunRow {
  account_id: string;
  status_reason: string | null;
  closed_at: string | null;
  items: ReconItem[];
}

export interface AuditRecord {
  id: string;
  at: string;
  actor_id: string | null;
  actor: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  data: Record<string, unknown> | null;
  hash: string;
}

export interface AuditVerify {
  ok: boolean;
  chain: { ok: boolean; checked?: number; brokenAt?: string | null };
  anchors: { ok?: boolean; checked: number; brokenAnchor?: string | null };
}

export interface Anchor {
  id: string;
  audit_id: string;
  hash: string;
  records: number;
  note: string | null;
  created_at: string;
}

export interface UserRow {
  id: string;
  username: string;
  full_name: string;
  roles: Role[];
  active: boolean;
  locked_until: string | null;
  created_at: string;
  mfa_enrolled: boolean;
}

export interface DeskSettings {
  quote_ttl_seconds: number;
  payment_window_seconds: number;
  request_ttl_seconds: number;
  price_move_threshold_bps: number;
  tron_confirmations: number;
  bsc_confirmations: number;
  transfer_pending_seconds: number;
  transfer_review_seconds: number;
  created_at?: string;
  reason?: string;
}

export interface PricingRule {
  id: string;
  counterparty_id: string | null;
  min_usdt: string;
  buy_margin_cop: string;
  sell_margin_cop: string;
  commission_rate: string;
  active: boolean;
  reason: string;
  created_at: string;
}

export interface TrmRow {
  id: string;
  valid_date: string;
  rate: string;
  source: string;
  simulated: boolean;
  created_at: string;
}

export interface Limits {
  orderMaxUsdt: string;
  clientDailyUsdt: string;
  deskDailyUsdt: string;
  openExposureUsdt: string;
  openExposureCop: string;
  approval: ApprovalPolicy;
}

export interface LimitChange {
  id: string;
  kind: string;
  counterparty_id: string | null;
  value: Record<string, string>;
  status: 'PROPUESTO' | 'VIGENTE' | 'RECHAZADO';
  reason: string;
  proposed_at: string;
  decided_at: string | null;
  decision_note: string | null;
  proposed_by_name: string;
  decided_by_name: string | null;
}

export type ApprovalPolicy = { policy: 'SINGLE' | 'ALL' } | { policy: 'THRESHOLD'; thresholdCop: string };

export interface Adjustment {
  id: string;
  number: string;
  amount: string;
  reason: string;
  status: 'PROPUESTO' | 'APROBADO' | 'RECHAZADO';
  status_reason: string | null;
  created_at: string;
  decided_at: string | null;
  account_code: string;
  asset: Asset;
  item_id: string | null;
  item_number: string | null;
  run_id: string | null;
  proposed_by: string;
  proposed_by_name: string;
  decided_by_name: string | null;
}
