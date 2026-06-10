import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Source tests only. Without this, vitest's default glob also picks up any
    // compiled `dist/__tests__/*.test.js` left over from an earlier build — the
    // stale copies that made markdown's suite the second latent failure the
    // 0.9.10 release-test gate surfaced (batch-6). Mirrors every other train
    // package (upg-spec, upg-sdk, …).
    include: ['src/**/*.test.ts'],
  },
})
