import { defineConfig } from '@playwright/test';

// E2E suite: drives the real viewer (real engine worker, real pdf.js) in
// Chromium against the Vite dev server. Extension-shell behavior (URL
// redirect, permissions) is out of scope — see docs/manual-checklist.md.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4273',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run dev -- --port 4273 --strictPort',
    url: 'http://localhost:4273/viewer.html',
    reuseExistingServer: !process.env.CI,
  },
});
