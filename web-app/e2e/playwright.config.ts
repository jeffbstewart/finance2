// E2E lane (docs/design/ui-testing.md): real server, real browser.
// The webServer boots finance2 on a scratch DB with test support on;
// global setup creates/logs in the single user once and every spec
// reuses that session via storageState.
import { defineConfig } from '@playwright/test';

export const BASE_URL = 'http://localhost:19092';
export const SETUP_TOKEN = 'e2e-setup-token';
import { join } from 'node:path';

export const STORAGE_STATE = join(__dirname, '.auth', 'state.json');

export default defineConfig({
  testDir: './specs',
  outputDir: './.results',
  fullyParallel: false, // one shared server + database
  workers: 1,
  timeout: 30_000,
  globalSetup: './global-setup.ts',
  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/start-server.mjs',
    url: `${BASE_URL}/app/`,
    reuseExistingServer: !process.env['CI'],
    timeout: 240_000,
    cwd: '..',
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
