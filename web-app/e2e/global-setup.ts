// One login for the whole e2e run: the session cookie lands in a
// Playwright storageState that every spec reuses, and in a sidecar
// file the seed helper reads (docs/design/ui-testing.md).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STORAGE_STATE } from './playwright.config';
import { ensureSession } from './support/api';

export const COOKIE_FILE = join(__dirname, '.auth', 'cookie.txt');

export default async function globalSetup(): Promise<void> {
  const cookie = await ensureSession();
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(COOKIE_FILE, cookie);
  writeFileSync(
    STORAGE_STATE,
    JSON.stringify({
      cookies: [
        {
          name: 'finance_session',
          value: cookie,
          domain: 'localhost',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
}
