import { defineConfig } from 'vitest/config';
export default defineConfig({
  base: './',
  build: { target: 'es2020', sourcemap: false },
  server: { host: '0.0.0.0', port: 4381, strictPort: true },
  test: { include: ['tests/unit/**/*.test.ts', 'server/**/*.test.mjs'], environment: 'node' },
});
