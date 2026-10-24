// Interpretación de lo que dicen la red o el banco sobre una transferencia. Reglas puras:
// la decisión depende solo de la observación, de lo esperado y de los plazos.

import { addressKey, type Network } from '../counterparties/domain.js';

export interface Expected {
  /** Dirección o sentido esperado: en la red, la dirección que debe recibir; en el banco, IN u OUT. */
  to: string | null;
  direction: 'IN' | 'OUT';
  /** En la red, unidades base del token; en el banco, pesos enteros. */
  amount: string;
  /** En la red: contrato del token autorizado. Lo transferido debe ser ese contrato, no solo llamarse USDT. */
  tokenContract?: string | null;
  /** Red de la transferencia; define cómo se comparan las direcciones de origen. */
  network?: Network | null;
  /**
   * Depósitos de clientes en la red: direcciones de origen autorizadas (aprobadas por Cumplimiento
   * o con una excepción autorizada para esta transferencia). null = esta transferencia no lleva control de origen.
   */
  allowedFrom?: string[] | null;
}

export interface Observed {
  found: boolean;
  status?: 'PENDING' | 'SUCCESS' | 'FAILED' | 'SETTLED' | 'REJECTED';
  confirmations?: number;
  to?: string;
  from?: string;
  tokenContract?: string;
  direction?: 'IN' | 'OUT';
  amount?: string;
  /** Bloque de inclusión, como evidencia. */
  blockNumber?: string;
  /** La red la da por irreversible; si viene, reemplaza al conteo de confirmaciones. */
  finalized?: boolean;
  /** El lector vio algo que no cuadra (evento ambiguo, datos incompletos). */
  anomaly?: string;
  detail?: string;
}

export interface Timing {
  ageSeconds: number; // desde que se registró el envío
  pendingSeconds: number; // primer plazo: alerta
  reviewSeconds: number; // segundo plazo: revisión
  requiredConfirmations: number; // 0 en el banco
}

export type Decision =
  | { kind: 'WAIT' }
  | { kind: 'ALERT'; reason: string }
  | { kind: 'PENDING'; confirmations: number }
  | { kind: 'CONFIRM'; confirmations: number }
  | { kind: 'FAIL'; reason: string }
  | { kind: 'REVIEW'; reason: string };

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Con la red conocida se compara según sus reglas (Tron distingue mayúsculas); sin ella, sin distinguirlas. */
const sameOnNetwork = (network: Network | null | undefined, a: string, b: string) =>
  network ? addressKey(network, a) === addressKey(network, b) : sameAddress(a, b);

export function decide(obs: Observed, exp: Expected, t: Timing): Decision {
  const late = t.ageSeconds >= t.reviewSeconds;
  const slow = t.ageSeconds >= t.pendingSeconds;
  if (!obs.found) {
    if (late) return { kind: 'REVIEW', reason: `No aparece después de ${t.reviewSeconds} segundos` };
    if (slow) return { kind: 'ALERT', reason: `Sin rastro después de ${t.pendingSeconds} segundos` };
    return { kind: 'WAIT' };
  }
  if (obs.status === 'FAILED' || obs.status === 'REJECTED') {
    return { kind: 'FAIL', reason: obs.detail ?? (obs.status === 'FAILED' ? 'La red la reporta fallida' : 'El banco la rechazó') };
  }
  if (obs.anomaly) return { kind: 'REVIEW', reason: obs.anomaly };
  // Lo que se vio debe coincidir con lo autorizado, aunque la red la reporte exitosa.
  if (exp.tokenContract) {
    if (!obs.tokenContract) return { kind: 'REVIEW', reason: 'La red no informó el contrato del token; no se puede verificar' };
    if (!sameOnNetwork(exp.network, obs.tokenContract, exp.tokenContract)) {
      return { kind: 'REVIEW', reason: `El token no es el autorizado: contrato ${obs.tokenContract}` };
    }
  }
  // En la red, el monto y el destino son obligatorios: sin ellos no se puede verificar nada.
  if (exp.network) {
    if (obs.amount === undefined) return { kind: 'REVIEW', reason: 'La red no informó el monto; no se puede verificar' };
    if (obs.to === undefined) return { kind: 'REVIEW', reason: 'La red no informó el destino; no se puede verificar' };
  }
  if (obs.amount !== undefined && obs.amount !== exp.amount) {
    return { kind: 'REVIEW', reason: `El monto no coincide: se esperaba ${exp.amount} y se vio ${obs.amount}` };
  }
  if (obs.direction && obs.direction !== exp.direction) {
    return { kind: 'REVIEW', reason: `El sentido no coincide: se esperaba ${exp.direction} y se vio ${obs.direction}` };
  }
  if (obs.to !== undefined) {
    if (!exp.to) return { kind: 'REVIEW', reason: 'La cuenta de destino no tiene dirección registrada; no se puede verificar' };
    if (!sameAddress(obs.to, exp.to)) return { kind: 'REVIEW', reason: `El destino no coincide: se esperaba ${exp.to} y se vio ${obs.to}` };
  }
  if (exp.allowedFrom) {
    if (!obs.from) return { kind: 'REVIEW', reason: 'La red no informó la dirección de origen; no se puede verificar' };
    const from = obs.from;
    if (!exp.allowedFrom.some((a) => sameOnNetwork(exp.network, a, from))) {
      return { kind: 'REVIEW', reason: `Origen no autorizado: ${from} no es una billetera aprobada del cliente${exp.network ? ` en ${exp.network}` : ''}` };
    }
  }
  const confirmations = obs.confirmations ?? 0;
  // Si el lector informa la irreversibilidad (TRON: bloque solidificado), es lo que manda; si no, el conteo.
  const deep = obs.finalized !== undefined ? obs.finalized : confirmations >= t.requiredConfirmations;
  const done = obs.status === 'SETTLED' || (obs.status === 'SUCCESS' && deep);
  if (done) return { kind: 'CONFIRM', confirmations };
  if (late) {
    return {
      kind: 'REVIEW',
      reason:
        obs.finalized !== undefined
          ? `La red no la da por irreversible después de ${t.reviewSeconds} segundos`
          : `Sin el umbral de confirmaciones después de ${t.reviewSeconds} segundos (${confirmations} de ${t.requiredConfirmations})`,
    };
  }
  return { kind: 'PENDING', confirmations };
}
