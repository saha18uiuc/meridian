import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  esbuild: { jsx: 'automatic' },
  test: {
    name: 'component',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/component/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./test/setup-component.ts'],
    globals: true,
  },
});
