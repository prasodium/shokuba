import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Many tests run real Git or a real process. A Windows CI runner takes several seconds for
    // what a laptop does in a fraction of one, so the 5s default fails good tests there. A test
    // that really hangs still fails, only after 30s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
