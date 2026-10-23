import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { base32Decode, base32Encode, hotp, totpAt, verifyTotp } from '../../src/modules/identity/totp.js';
import { decrypt, encrypt } from '../../src/platform/crypto.js';
import { runIdempotent } from '../../src/platform/idempotency.js';
import {
  baseUnitsToUsdt,
  parseCopInteger,
  parseCopPrice,
  parseRate,
  parseUsdtAmount,
  usdtToBaseUnits,
} from '../../src/platform/money.js';
import { inTransaction } from '../../src/platform/tx.js';
import { actorOf, expectCode, MFA_KEY, setupEnv, type Env } from './helpers.js';

describe('importes y decimales', () => {
  it('acepta USDT con hasta 6 decimales y rechaza el resto', () => {
    expect(parseUsdtAmount('1000.123456').toFixed()).toBe('1000.123456');
    expect(() => parseUsdtAmount('1.1234567')).toThrow(/6 decimales/);
    expect(() => parseUsdtAmount('0')).toThrow(/mayor que cero/);
    expect(() => parseUsdtAmount('-5')).toThrow();
    expect(() => parseUsdtAmount('1e3')).toThrow(/sin signos ni exponentes/);
    expect(() => parseUsdtAmount(' 10')).toThrow();
  });

  it('pesos enteros, precios con centavos y tasas acotadas', () => {
    expect(parseCopInteger('4015000').toFixed()).toBe('4015000');
    expect(() => parseCopInteger('10.5')).toThrow(/pesos enteros/);
    expect(parseCopPrice('4000.25', 'TRM').toFixed()).toBe('4000.25');
    expect(() => parseCopPrice('4000.255', 'TRM')).toThrow(/2 decimales/);
    expect(parseCopPrice('0', 'Margen', { allowZero: true }).toFixed()).toBe('0');
    expect(parseRate('0.001', 'Comisión').toFixed()).toBe('0.001');
    expect(() => parseRate('0.2', 'Comisión')).toThrow(/10 %/);
  });

  it('convierte a unidades base de cada red sin perder precisión', () => {
    expect(usdtToBaseUnits(parseUsdtAmount('1000.5'), 'TRON')).toBe('1000500000');
    expect(usdtToBaseUnits(parseUsdtAmount('1000.5'), 'BSC')).toBe('1000500000000000000000');
    expect(usdtToBaseUnits(parseUsdtAmount('0.000001'), 'BSC')).toBe('1000000000000');
    expect(baseUnitsToUsdt('1000500000000000000000', 'BSC').toFixed()).toBe('1000.5');
    expect(baseUnitsToUsdt('1', 'TRON').toFixed()).toBe('0.000001');
  });
});

describe('segundo factor (TOTP, RFC 6238)', () => {
  // Vectores oficiales del RFC 6238 con el secreto ASCII "12345678901234567890", 8 dígitos.
  const secret = Buffer.from('12345678901234567890');
  it('coincide con los vectores del RFC', () => {
    expect(hotp(secret, 1n, 8)).toBe('94287082');
    expect(hotp(secret, 37037036n, 8)).toBe('07081804');
    expect(hotp(secret, 41152263n, 8)).toBe('89005924');
  });

  it('codifica y decodifica base32', () => {
    expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(secret)).toBe(true);
  });

  it('acepta un paso de desfase y nunca el mismo código dos veces', () => {
    const b32 = base32Encode(secret);
    const t = new Date('2026-10-20T12:00:00Z');
    const code = totpAt(b32, t);
    const step = verifyTotp(b32, code, new Date(t.getTime() + 30_000), null);
    expect(step).not.toBeNull();
    expect(verifyTotp(b32, code, t, step)).toBeNull(); // reutilizado
    expect(verifyTotp(b32, code, new Date(t.getTime() + 120_000), null)).toBeNull(); // muy viejo
    expect(verifyTotp(b32, '12345', t, null)).toBeNull();
  });
});

describe('cifrado de secretos en reposo', () => {
  it('descifra lo que cifra y detecta alteraciones', () => {
    const sealed = encrypt(MFA_KEY, 'JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decrypt(MFA_KEY, sealed)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('otro dato').toString('base64');
    expect(() => decrypt(MFA_KEY, parts.join('.'))).toThrow();
    expect(() => decrypt(Buffer.alloc(32, 1), sealed)).toThrow();
  });
});

describe('plataforma con base de datos', () => {
  let env: Env;
  beforeAll(async () => {
    env = await setupEnv();
  });
  afterAll(async () => env.close());

  it('las migraciones son versionadas y no se pueden reescribir', async () => {
    const r = await env.db.query('SELECT name, checksum FROM schema_migrations ORDER BY name');
    expect(r.rows.map((x) => x.name).slice(0, 3)).toEqual(['001_init.sql', '002_plataforma.sql', '003_identidad.sql']);
    expect(r.rows.every((x) => /^[0-9a-f]{64}$/.test(x.checksum))).toBe(true);
    expect(await migrate(env.db)).toEqual([]); // nada pendiente: aplicar dos veces no hace nada
    await env.db.query(`UPDATE schema_migrations SET checksum = 'alterada' WHERE name = '002_plataforma.sql'`);
    await expect(migrate(env.db)).rejects.toThrow(/cambió después de aplicarse/);
    const real = r.rows.find((x) => x.name === '002_plataforma.sql').checksum;
    await env.db.query(`UPDATE schema_migrations SET checksum = $1 WHERE name = '002_plataforma.sql'`, [real]);
  });

  it('ninguna migración borra datos ni tablas', async () => {
    const dir = join(import.meta.dirname, '..', '..', 'migrations');
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.sql'))) {
      const sql = (await readFile(join(dir, f), 'utf8')).replace(/--.*$/gm, '');
      expect(sql, f).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|COLUMN)\b|\bDELETE\s+FROM\b|\bTRUNCATE\b/i);
    }
  });

  it('la idempotencia repite la respuesta, rechaza otro cuerpo y no ejecuta dos veces', async () => {
    const admin = await actorOf(env.db, 'admin');
    let runs = 0;
    const action = async () => {
      runs++;
      return { statusCode: 201, body: { n: runs } };
    };
    const scope = { key: 'clave-de-prueba-1', userId: admin.id, route: 'POST /x', body: { a: 1 } };
    const first = await inTransaction(env.db, (tx) => runIdempotent(tx, scope, action));
    const again = await inTransaction(env.db, (tx) => runIdempotent(tx, scope, action));
    expect(first).toEqual({ statusCode: 201, body: { n: 1 }, replayed: false });
    expect(again).toEqual({ statusCode: 201, body: { n: 1 }, replayed: true });
    await expectCode(
      inTransaction(env.db, (tx) => runIdempotent(tx, { ...scope, body: { a: 2 } }, action)),
      'IDEMPOTENCY_MISMATCH',
    );

    // Dos solicitudes simultáneas con la misma clave: una sola ejecución.
    const scope2 = { ...scope, key: 'clave-de-prueba-2' };
    const slow = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 100));
      return { statusCode: 200, body: { n: runs } };
    };
    const before = runs;
    const [a, b] = await Promise.all([
      inTransaction(env.db, (tx) => runIdempotent(tx, scope2, slow)),
      inTransaction(env.db, (tx) => runIdempotent(tx, scope2, slow)),
    ]);
    expect(runs - before).toBe(1);
    expect(a.body).toEqual(b.body);
  });

  it('reintenta la transacción completa ante un conflicto de serialización', async () => {
    let attempts = 0;
    const result = await inTransaction(env.db, async (tx) => {
      attempts++;
      await tx.query('SELECT 1');
      if (attempts === 1) throw Object.assign(new Error('conflicto simulado'), { code: '40001' });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('el historial de estados es de solo agregar', async () => {
    await env.db.query(
      `INSERT INTO otc.state_events (entity, entity_id, to_status) VALUES ('prueba', gen_random_uuid(), 'X')`,
    );
    await expect(env.db.query('DELETE FROM otc.state_events')).rejects.toThrow(/solo-agregar/);
    await expect(env.db.query(`UPDATE otc.state_events SET note = 'x'`)).rejects.toThrow(/solo-agregar/);
  });
});
