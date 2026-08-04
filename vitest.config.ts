import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          setupFiles: ['tests/helpers/setup.ts'],
          // Every suite runs against one shared local Postgres. Parallel files would interleave
          // fixture writes and produce failures that look like isolation bugs but are not.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          // Component tests render in jsdom and touch no external service, so they carry none of
          // the shared-Postgres ordering constraint the integration project needs — free to run
          // in parallel, on the default timeouts.
          name: 'component',
          environment: 'jsdom',
          include: ['tests/**/*.test.tsx'],
          setupFiles: ['tests/helpers/setup-component.ts'],
        },
      },
    ],
  },
});
