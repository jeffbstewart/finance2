// Unit spec for authGuard (docs/design/ui-testing.md, inventory
// "Core seams"): the shell's gate. Everything but /welcome sits behind
// it, and an unauthenticated hit must bounce to /welcome carrying the
// attempted URL in `return` - the value Welcome reads back on sign-in.
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Router,
  UrlTree,
  provideRouter,
  type ActivatedRouteSnapshot,
  type GuardResult,
  type RouterStateSnapshot,
} from '@angular/router';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GetSessionStatusResponseSchema,
  SessionService,
  UserInfoSchema,
} from '../../proto-gen/session_pb';
import { installFakeApi } from '../../testing/fake-api';
import { authGuard } from './auth.guard';
import { SessionStore } from './session';

type StatusInit = MessageInitShape<typeof GetSessionStatusResponseSchema>;

const USER = create(UserInfoSchema, { username: 'jeff', displayName: 'Jeff' });
const SIGNED_IN: StatusInit = { setupRequired: false, signedIn: true, user: USER };
const SIGNED_OUT: StatusInit = { setupRequired: false, signedIn: false };
const SETUP: StatusInit = { setupRequired: true, signedIn: false };

@Component({ template: '' })
class Blank {}

describe('authGuard', () => {
  let restoreApi: () => void;
  let statusCalls: number;
  let status: () => StatusInit;

  beforeEach(() => {
    statusCalls = 0;
    status = () => SIGNED_OUT;
    restoreApi = installFakeApi(({ service }) => {
      service(SessionService, {
        getSessionStatus: () => {
          statusCalls++;
          return status();
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([
          { path: 'welcome', component: Blank },
          { path: 'tax', canActivate: [authGuard], component: Blank },
        ]),
      ],
    });
  });

  afterEach(() => restoreApi());

  /** Runs the guard the way the router does, for an attempted URL. */
  function runGuard(url: string): Promise<GuardResult> {
    return TestBed.runInInjectionContext(
      () =>
        authGuard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot) as Promise<
          GuardResult
        >,
    );
  }

  it('admits a signed-in visitor', async () => {
    status = () => SIGNED_IN;
    await expect(runGuard('/tax')).resolves.toBe(true);
    expect(statusCalls).toBe(1);
  });

  it('redirects a signed-out visitor to /welcome remembering the url', async () => {
    const result = await runGuard('/positions/7');
    expect(result).toBeInstanceOf(UrlTree);
    const tree = result as UrlTree;
    expect(tree.root.children['primary'].segments.map((s) => s.path)).toEqual(['welcome']);
    expect(tree.queryParams).toEqual({ return: '/positions/7' });
  });

  it('carries the attempted query string into the return param', async () => {
    const tree = (await runGuard('/securities/3?tab=1')) as UrlTree;
    expect(tree.queryParams['return']).toBe('/securities/3?tab=1');
  });

  it('redirects on a fresh install too, so setup lands on the welcome card', async () => {
    status = () => SETUP;
    const result = await runGuard('/brokers');
    expect(result).toBeInstanceOf(UrlTree);
    expect((result as UrlTree).queryParams['return']).toBe('/brokers');
  });

  it('probes the session once and reuses the cached state', async () => {
    status = () => SIGNED_IN;
    await expect(runGuard('/tax')).resolves.toBe(true);
    await expect(runGuard('/brokers')).resolves.toBe(true);
    expect(statusCalls).toBe(1);
    expect(TestBed.inject(SessionStore).signedIn()).toBe(true);
  });

  it('bounces a real navigation into the welcome url the browser will show', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/tax');
    // Angular percent-encodes query-param values, so the `return` param
    // arrives escaped; Welcome reads it back through queryParamMap.
    expect(router.url).toBe('/welcome?return=%2Ftax');
  });

  it('lets a real navigation through once signed in', async () => {
    status = () => SIGNED_IN;
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/tax');
    expect(router.url).toBe('/tax');
  });
});
