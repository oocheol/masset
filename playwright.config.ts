import { defineConfig, devices } from '@playwright/test';

const runId = process.env.ASSET_QA_RUN_ID ?? new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) throw new Error('ASSET_QA_RUN_ID must be a safe directory name of at most 80 characters.');
process.env.ASSET_QA_RUN_ID = runId; // Workers reuse the coordinator's timestamp when reloading this config.

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'output/playwright/report', open: 'never' }]],
  outputDir: `output/playwright/results/${runId}`,
  use: { baseURL: 'http://127.0.0.1:1420', channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium-browser-only', use: { ...devices['Desktop Chrome'], viewport: {width: 1500, height: 960} } }],
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
