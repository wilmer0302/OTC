import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // test-real/ consulta redes reales: solo corre a mano con `npm run test:tron-real`, nunca en CI.
  test: { fileParallelism: false, testTimeout: 30000, hookTimeout: 60000, exclude: [...configDefaults.exclude, 'test-real/**'] },
});
