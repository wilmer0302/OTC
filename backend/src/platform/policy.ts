// Políticas de control de la mesa que no son parámetros del día a día. Esta es la única
// configuración central de cada una: el servidor la consulta aquí y en ningún otro lugar.
// Se pueden ajustar por entorno con su variable; si la variable no existe vale el valor por defecto.

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  return n;
}

export const POLICY = {
  /** Redes blockchain distintas que un cliente puede tener habilitadas para depositar (con al menos una dirección viva). */
  maxOriginNetworksPerClient: intFromEnv('ORIGIN_MAX_NETWORKS', 4, 1, 10),
};
