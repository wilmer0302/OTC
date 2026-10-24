import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Reglas de arquitectura que se verifican en cada corrida de pruebas.

const SRC = join(import.meta.dirname, '../../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
const modules = files(join(SRC, 'modules'));

describe('arquitectura', () => {
  it('las reglas de dominio son puras: no tocan base de datos, HTTP ni integraciones', () => {
    const domains = modules.filter((f) => f.endsWith('domain.ts'));
    expect(domains.length).toBeGreaterThanOrEqual(9);
    for (const f of domains) {
      for (const imp of importsOf(f)) {
        const allowed = imp === 'zod' || imp.endsWith('/platform/money.js') || /^\.\.\/[a-z]+\/domain\.js$/.test(imp) || imp === './domain.js';
        expect(allowed, `${relative(SRC, f)} importa ${imp}`).toBe(true);
      }
    }
  });

  it('ningún módulo de negocio usa una integración concreta: solo las interfaces', () => {
    for (const f of modules) {
      for (const imp of importsOf(f)) {
        const concrete = ['integrations/sandbox', 'integrations/tron/', 'integrations/router', 'integrations/factory', 'adapters/'].some((x) => imp.includes(x));
        expect(concrete, `${relative(SRC, f)} importa ${imp}`).toBe(false);
      }
    }
  });

  it('el backend v1 no depende de los servicios de la demo anterior, salvo la auditoría encadenada y la fecha de Bogotá', () => {
    for (const f of [...modules, ...files(join(SRC, 'platform'))]) {
      for (const imp of importsOf(f).filter((i) => i.includes('/services/'))) {
        expect(['../../services/audit.js', '../services/audit.js', '../../services/trm.js', '../services/context.js'], `${relative(SRC, f)} importa ${imp}`).toContain(imp);
      }
    }
  });
});
