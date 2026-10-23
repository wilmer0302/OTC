// Configuración leída del entorno. El modo DEMO es el único disponible hoy:
// no existen adaptadores reales de bancos ni de blockchain.

export type AppMode = 'DEMO' | 'PRODUCTION';

export interface Config {
  mode: AppMode;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  corsOrigin: string;
  /** Llave AES-256 (64 hex) para cifrar secretos del segundo factor. Viene del gestor de secretos. */
  mfaKeyHex: string;
  /** Cookie de sesión solo por HTTPS. Únicamente la demo local en http://localhost la desactiva. */
  cookieSecure: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function requiredHexKey(name: string): string {
  const value = required(name);
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} debe tener 64 caracteres hexadecimales (32 bytes)`);
  return value;
}

export function loadConfig(): Config {
  const mode = (process.env.APP_MODE ?? 'DEMO').toUpperCase();
  if (mode !== 'DEMO' && mode !== 'PRODUCTION') {
    throw new Error(`APP_MODE inválido: ${mode}. Usa DEMO.`);
  }
  if (mode === 'PRODUCTION') {
    throw new Error(
      'El modo PRODUCTION no está disponible: no hay adaptadores reales de bancos ni de blockchain configurados.',
    );
  }
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
  return {
    mode,
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret,
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    mfaKeyHex: requiredHexKey('MFA_ENCRYPTION_KEY'),
    cookieSecure: process.env.COOKIE_SECURE !== 'false',
  };
}
