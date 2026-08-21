// Node-side RPC access for the e2e lane: session bootstrap plus the
// test-only reset/seed calls (docs/design/ui-testing.md). Login and
// first-user creation go over raw gRPC-Web fetches so the Set-Cookie
// header is read directly; everything after rides a connect client
// with the cookie attached.
import { create, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import {
  CreateFirstUserRequestSchema,
  LoginRequestSchema,
} from '../../src/proto-gen/session_pb';
import { TestSupportService } from '../../src/proto-gen/testsupport_pb';
import { BASE_URL, SETUP_TOKEN } from '../playwright.config';

export const E2E_USER = { username: 'e2e', password: 'correct-horse-battery-e2e', displayName: 'E2E' };

function frame(bytes: Uint8Array): ArrayBuffer {
  const framed = new Uint8Array(5 + bytes.length);
  new DataView(framed.buffer).setUint32(1, bytes.length);
  framed.set(bytes, 5);
  return framed.buffer as ArrayBuffer;
}

async function rawUnary<S extends DescMessage>(
  method: string,
  schema: S,
  message: MessageShape<S>,
): Promise<Response> {
  return fetch(`${BASE_URL}/finance.SessionService/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
    body: frame(toBinary(schema, message)),
  });
}

function grpcStatusOf(response: Response): string | null {
  return response.headers.get('grpc-status');
}

function sessionCookieOf(response: Response): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    const match = /^finance_session=([^;]+)/.exec(cookie);
    if (match) return match[1];
  }
  return null;
}

/** First run creates the user; later runs log in. Returns the session
 *  cookie value. */
export async function ensureSession(): Promise<string> {
  const created = await rawUnary(
    'CreateFirstUser',
    CreateFirstUserRequestSchema,
    create(CreateFirstUserRequestSchema, {
      username: E2E_USER.username,
      password: E2E_USER.password,
      displayName: E2E_USER.displayName,
      setupToken: SETUP_TOKEN,
    }),
  );
  const cookie = sessionCookieOf(created);
  if (cookie && grpcStatusOf(created) === null) return cookie;

  const loggedIn = await rawUnary(
    'Login',
    LoginRequestSchema,
    create(LoginRequestSchema, {
      username: E2E_USER.username,
      password: E2E_USER.password,
    }),
  );
  const loginCookie = sessionCookieOf(loggedIn);
  if (!loginCookie) {
    throw new Error(
      `e2e login failed (grpc-status ${grpcStatusOf(loggedIn) ?? 'in body'}) — is the e2e server up with SETUP_TOKEN set?`,
    );
  }
  return loginCookie;
}

/** A connect client for the test-only fixture service, cookie attached. */
export function testSupportClient(cookie: string) {
  const transport = createGrpcWebTransport({
    baseUrl: BASE_URL,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), cookie: `finance_session=${cookie}` },
      }),
  });
  return createClient(TestSupportService, transport);
}

/** Wipe + reseed the canonical portfolio; returns the seeded id map. */
export async function resetAndSeed(cookie: string): Promise<Record<string, bigint>> {
  const client = testSupportClient(cookie);
  await client.resetPortfolio({});
  const seeded = await client.seedSamplePortfolio({});
  return { ...seeded.ids };
}
