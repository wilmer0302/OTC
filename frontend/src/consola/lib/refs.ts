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
