// Ayudas de formato para referencias externas. Solo avisan antes de enviar: el servidor valida y la
// red o el banco confirman que existan.

export function refHint(rail: string): string {
  if (rail === 'TRON') return 'Hash de la transacción en Tron: 64 caracteres hexadecimales, sin 0x.';
  if (rail === 'BSC') return 'Hash de la transacción en BSC: 0x seguido de 64 caracteres hexadecimales.';
  return 'Referencia que entrega el banco: letras, números o guiones (4 a 64).';
}

export function refError(rail: string, v: string): string | null {
  if (rail === 'TRON') return /^[0-9a-fA-F]{64}$/.test(v) ? null : 'Debe tener 64 caracteres hexadecimales, sin 0x';
  if (rail === 'BSC') return /^0x[0-9a-fA-F]{64}$/.test(v) ? null : 'Debe empezar por 0x y tener 64 caracteres hexadecimales';
  return /^[A-Za-z0-9-]{4,64}$/.test(v) ? null : 'Solo letras, números y guiones (4 a 64)';
}

/** Destinos de pago del cliente: cuenta bancaria o dirección de billetera según la red. */
export function destinationHint(rail: string): string {
  if (rail === 'TRON') return 'Dirección Tron: empieza por T y tiene 34 caracteres.';
  if (rail === 'BSC') return 'Dirección BSC: 0x seguido de 40 caracteres hexadecimales.';
  return 'Número de cuenta: solo dígitos, 6 a 20.';
}

export function destinationError(rail: string, v: string): string | null {
  if (rail === 'TRON') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(v) ? null : 'Debe empezar por T y tener 34 caracteres válidos';
  if (rail === 'BSC') return /^0x[0-9a-fA-F]{40}$/.test(v) ? null : 'Debe empezar por 0x y tener 40 caracteres hexadecimales';
  return /^\d{6,20}$/.test(v) ? null : 'Solo dígitos, 6 a 20';
}
