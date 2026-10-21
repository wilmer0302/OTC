// Interpretación de lo que dicen la red o el banco sobre una transferencia. Reglas puras:
// la decisión depende solo de la observación, de lo esperado y de los plazos.

export interface Expected {
  /** Dirección o sentido esperado: en la red, la dirección que debe recibir; en el banco, IN u OUT. */
  to: string | null;
  direction: 'IN' | 'OUT';
  /** En la red, unidades base del token; en el banco, pesos enteros. */
  amount: string;
}

export interface Observed {
  found: boolean;
  status?: 'PENDING' | 'SUCCESS' | 'FAILED' | 'SETTLED' | 'REJECTED';
  confirmations?: number;
  to?: string;
  direction?: 'IN' | 'OUT';
  amount?: string;
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
  // Lo que se vio debe coincidir con lo autorizado, aunque la red la reporte exitosa.
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
  const confirmations = obs.confirmations ?? 0;
  const done = obs.status === 'SETTLED' || (obs.status === 'SUCCESS' && confirmations >= t.requiredConfirmations);
  if (done) return { kind: 'CONFIRM', confirmations };
  if (late) return { kind: 'REVIEW', reason: `Sin el umbral de confirmaciones después de ${t.reviewSeconds} segundos (${confirmations} de ${t.requiredConfirmations})` };
  return { kind: 'PENDING', confirmations };
}
