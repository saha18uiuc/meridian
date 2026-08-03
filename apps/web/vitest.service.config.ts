import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` exists to make a build fail when a server module is pulled into a client
      // bundle. Under Vitest there is no bundle and no client, and its React-Server-Components
      // export map resolves to a module that throws on import, so it is stubbed here. The guarantee
      // it provides is a build-time one and is not weakened by this.
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    name: 'service',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/service/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./test/setup-service.ts'],
    testTimeout: 30_000,
  },
});
