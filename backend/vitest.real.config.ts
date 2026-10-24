import { defineConfig } from 'vitest/config';

// Pruebas contra una red real, solo de lectura. Se ejecutan a mano desde un entorno con salida a la red.
export default defineConfig({
  test: { include: ['test-real/**/*.test.ts'], fileParallelism: false, testTimeout: 60000 },
});
