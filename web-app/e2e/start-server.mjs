// Boots finance2 for the e2e lane on a scratch database with test
// support enabled. Invoked by Playwright's webServer (cwd: web-app).
// Requires a built SPA (npm run check) — the server serves ../spa.
import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = resolve(process.cwd(), '..');
if (!existsSync(join(repoRoot, 'spa', 'index.html'))) {
  console.error('spa/ is missing — run `npm run check` before the e2e lane');
  process.exit(1);
}

const dbDir = join(tmpdir(), 'finance2-e2e');
rmSync(dbDir, { recursive: true, force: true });
mkdirSync(dbDir, { recursive: true });

const gradlew = join(repoRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const child = spawn(gradlew, ['--no-daemon', 'run'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    DB_PATH: join(dbDir, 'db'),
    H2_PASSWORD: 'e2e-password',
    H2_FILE_PASSWORD: 'e2e-file-password',
    COOKIE_SECURE: 'false',
    PORT: '19092',
    INTERNAL_PORT: '19093',
    FINANCE2_TEST_SUPPORT: 'true',
    SETUP_TOKEN: 'e2e-setup-token',
  },
});

child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill());
}
