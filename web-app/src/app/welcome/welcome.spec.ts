// Unit spec for Welcome (docs/design/ui-testing.md, inventory
// "Welcome"). SessionService is faked through installFakeApi; the
// router is stubbed at navigateByUrl so the post-auth destination is
// observable without routing into the guarded shell.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateFirstUserResponseSchema,
  GetSessionStatusResponseSchema,
  LoginResponseSchema,
  SessionService,
  UserInfoSchema,
  type CreateFirstUserRequest,
  type LoginRequest,
} from '../../proto-gen/session_pb';

type StatusInit = MessageInitShape<typeof GetSessionStatusResponseSchema>;
type LoginInit = MessageInitShape<typeof LoginResponseSchema>;
type CreateInit = MessageInitShape<typeof CreateFirstUserResponseSchema>;
import { installFakeApi } from '../../testing/fake-api';
import { settle } from '../../testing/settle';
import { Notify } from '../core/notify';
import { Welcome } from './welcome';

/** The single seeded user (SampleSeeder's portfolio has no users of
 *  its own; the e2e lane creates `e2e`). Shared-infrastructure gap:
 *  sample-data.ts carries no session/user builder yet. */
const USER = create(UserInfoSchema, { username: 'jeff', displayName: 'Jeff' });

const SIGNED_OUT = { setupRequired: false, signedIn: false };
const SETUP = { setupRequired: true, signedIn: false };
const SIGNED_IN = { setupRequired: false, signedIn: true, user: USER };

/** A promise plus its resolver, for pinning the in-flight busy state. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Welcome', () => {
  let restoreApi: () => void;
  let queryParams: Record<string, string>;
  let statusCalls: number;
  let status: () => StatusInit | Promise<StatusInit>;
  let loginRequests: { username: string; password: string }[];
  let login: (request: LoginRequest) => Promise<LoginInit>;
  let createRequests: {
    username: string;
    password: string;
    displayName: string;
    setupToken: string;
  }[];
  let createFirstUser: (request: CreateFirstUserRequest) => Promise<CreateInit>;
  let navigate: ReturnType<typeof vi.spyOn>;

  // The component reads only `snapshot.queryParamMap`; a getter keeps
  // the stub live so each test can set `return` before rendering.
  const routeStub = {
    snapshot: {
      get queryParamMap() {
        return convertToParamMap(queryParams);
      },
    },
  };

  beforeEach(() => {
    queryParams = {};
    statusCalls = 0;
    status = () => SIGNED_OUT;
    loginRequests = [];
    login = async (request) => {
      loginRequests.push({ username: request.username, password: request.password });
      return { user: USER };
    };
    createRequests = [];
    createFirstUser = async (request) => {
      createRequests.push({
        username: request.username,
        password: request.password,
        displayName: request.displayName,
        setupToken: request.setupToken,
      });
      return { user: USER };
    };
    restoreApi = installFakeApi(({ service }) => {
      service(SessionService, {
        getSessionStatus: () => {
          statusCalls++;
          return status();
        },
        login: (request) => login(request),
        createFirstUser: (request) => createFirstUser(request),
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: routeStub },
      ],
    });
    navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    restoreApi();
    vi.restoreAllMocks();
  });

  /** Renders without settling — the status probe is still in flight. */
  function mount() {
    const fixture = TestBed.createComponent(Welcome);
    fixture.detectChanges();
    return fixture;
  }

  async function render() {
    const fixture = mount();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: HTMLElement }): HTMLElement {
    return fixture.nativeElement;
  }

  function textOf(fixture: { nativeElement: HTMLElement }): string {
    return host(fixture).textContent!;
  }

  function inputNamed(fixture: { nativeElement: HTMLElement }, name: string): HTMLInputElement {
    const input = host(fixture).querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!input) throw new Error(`no input named ${name}`);
    return input;
  }

  function typeInto(fixture: { nativeElement: HTMLElement }, name: string, value: string): void {
    const input = inputNamed(fixture, name);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  function submitButton(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
    const button = host(fixture).querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!button) throw new Error('no submit button');
    return button;
  }

  /** Fires the form's ngSubmit the way the browser would. */
  function submitForm(fixture: { nativeElement: HTMLElement }): void {
    const form = host(fixture).querySelector('form');
    if (!form) throw new Error('no form');
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }

  it('shows the sign-in card before the status resolves (no setup flash)', () => {
    const fixture = mount();
    expect(textOf(fixture)).toContain('Please log in');
    expect(textOf(fixture)).not.toContain('Create the account for this server');
  });

  it('renders the sign-in card for a signed-out visitor', async () => {
    const fixture = await render();
    expect(textOf(fixture)).toContain('Portfolio Manager');
    expect(textOf(fixture)).toContain('Please log in');
    expect(submitButton(fixture).textContent).toContain('Log in');
    expect(host(fixture).querySelectorAll('input')).toHaveLength(2);
    expect(host(fixture).querySelector('input[name="setupToken"]')).toBeNull();
    expect(host(fixture).querySelector('mat-progress-bar')).toBeNull();
    expect(statusCalls).toBe(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('renders the create-first-user card when setup is required', async () => {
    status = () => SETUP;
    const fixture = await render();
    expect(textOf(fixture)).toContain('Welcome to Portfolio Manager');
    expect(textOf(fixture)).toContain('Create the account for this server');
    expect(textOf(fixture)).toContain('The setup token is');
    expect(submitButton(fixture).textContent).toContain('Create account');
    // Username, display name, password, setup token.
    expect(host(fixture).querySelectorAll('input')).toHaveLength(4);
    expect(inputNamed(fixture, 'setupToken')).toBeTruthy();
    expect(inputNamed(fixture, 'password').type).toBe('password');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates straight to /brokers when the session is already signed in', async () => {
    status = () => SIGNED_IN;
    await render();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/brokers');
  });

  it('honors the return query param when already signed in', async () => {
    status = () => SIGNED_IN;
    queryParams = { return: '/positions/7' };
    await render();
    expect(navigate).toHaveBeenCalledWith('/positions/7');
  });

  it('signs in with trimmed username and untouched password, then enters', async () => {
    const fixture = await render();
    typeInto(fixture, 'username', '  jeff  ');
    typeInto(fixture, 'password', '  spaces are significant  ');
    submitForm(fixture);
    await settle(fixture);

    expect(loginRequests).toEqual([
      { username: 'jeff', password: '  spaces are significant  ' },
    ]);
    expect(navigate).toHaveBeenCalledWith('/brokers');
    expect(host(fixture).querySelector('mat-progress-bar')).toBeNull();
    expect(submitButton(fixture).disabled).toBe(false);
  });

  it('returns to the remembered url after signing in', async () => {
    queryParams = { return: '/securities/3?tab=1' };
    const fixture = await render();
    typeInto(fixture, 'username', 'jeff');
    typeInto(fixture, 'password', 'pw');
    submitForm(fixture);
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith('/securities/3?tab=1');
  });

  it('creates the first user with trimmed fields and reports success', async () => {
    status = () => SETUP;
    const fixture = await render();
    const success = vi.spyOn(TestBed.inject(Notify), 'success');
    typeInto(fixture, 'username', ' jeff ');
    typeInto(fixture, 'displayName', ' Jeff Stewart ');
    typeInto(fixture, 'password', 'correct-horse-battery');
    typeInto(fixture, 'setupToken', ' token-from-the-log ');
    submitForm(fixture);
    await settle(fixture);

    expect(createRequests).toEqual([
      {
        username: 'jeff',
        password: 'correct-horse-battery',
        displayName: 'Jeff Stewart',
        setupToken: 'token-from-the-log',
      },
    ]);
    expect(success).toHaveBeenCalledWith('Welcome! Your account is ready.');
    expect(navigate).toHaveBeenCalledWith('/brokers');
  });

  it('disables submit and shows the progress bar while a sign-in is in flight', async () => {
    const gate = deferred<LoginInit>();
    login = async () => gate.promise;
    const fixture = await render();
    typeInto(fixture, 'username', 'jeff');
    typeInto(fixture, 'password', 'pw');

    submitForm(fixture);
    await settle(fixture);
    expect(fixture.componentInstance.busy()).toBe(true);
    expect(submitButton(fixture).disabled).toBe(true);
    expect(host(fixture).querySelector('mat-progress-bar')).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    gate.resolve({ user: USER });
    await settle(fixture);
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(submitButton(fixture).disabled).toBe(false);
    expect(host(fixture).querySelector('mat-progress-bar')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/brokers');
  });

  it('ignores a second submit while the first is still running', async () => {
    const gate = deferred<LoginInit>();
    login = async (request) => {
      loginRequests.push({ username: request.username, password: request.password });
      return gate.promise;
    };
    const fixture = await render();
    typeInto(fixture, 'username', 'jeff');
    typeInto(fixture, 'password', 'pw');

    const first = fixture.componentInstance.signIn();
    const second = fixture.componentInstance.signIn();
    gate.resolve({ user: USER });
    await Promise.all([first, second]);
    await settle(fixture);

    expect(loginRequests).toHaveLength(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('routes a rejected sign-in to the error snackbar and stays on the page', async () => {
    const fixture = await render();
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    login = async () => {
      throw new ConnectError('invalid username or password', Code.Unauthenticated);
    };
    typeInto(fixture, 'username', 'jeff');
    typeInto(fixture, 'password', 'wrong');
    submitForm(fixture);
    await settle(fixture);

    expect(error).toHaveBeenCalledTimes(1);
    const err = error.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('invalid username or password');
    expect(navigate).not.toHaveBeenCalled();
    // busy() is released in `finally`, so the form is usable again.
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(submitButton(fixture).disabled).toBe(false);
    expect(textOf(fixture)).toContain('Please log in');
  });

  it('routes a rejected create-first-user to the error snackbar', async () => {
    status = () => SETUP;
    const fixture = await render();
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    const success = vi.spyOn(TestBed.inject(Notify), 'success');
    createFirstUser = async () => {
      throw new ConnectError(
        'setup token missing or incorrect — it is printed in the server log at startup',
        Code.PermissionDenied,
      );
    };
    typeInto(fixture, 'username', 'jeff');
    typeInto(fixture, 'password', 'correct-horse-battery');
    typeInto(fixture, 'setupToken', 'nope');
    submitForm(fixture);
    await settle(fixture);

    expect(error).toHaveBeenCalledTimes(1);
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toContain('setup token');
    expect(success).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(textOf(fixture)).toContain('Create the account for this server');
  });

  it('keeps the sign-in card up while the status probe has not settled', async () => {
    // BUG: the constructor's `void this.session.ensureLoaded().then(...)`
    // has no rejection handler, so a failing GetSessionStatus yields an
    // unhandled promise rejection and never reaches the error snackbar —
    // the page silently sits on the sign-in card. Pinned here with a
    // probe that never settles, because a *rejecting* probe fails the
    // vitest run itself on the unhandled rejection.
    const gate = deferred<StatusInit>();
    status = () => gate.promise;
    const fixture = mount();
    const error = vi.spyOn(TestBed.inject(Notify), 'error');
    await settle(fixture);

    expect(error).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(textOf(fixture)).toContain('Please log in');
    expect(submitButton(fixture).disabled).toBe(false);

    gate.resolve(SETUP);
    await settle(fixture);
    expect(textOf(fixture)).toContain('Create the account for this server');
  });
});
