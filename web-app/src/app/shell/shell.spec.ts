// Unit spec for the app Shell (docs/design/ui-testing.md, inventory
// "Shell"): the six-section nav rail, the toolbar user menu, and
// logout. The session is driven through the real SessionStore against
// a fake SessionService, so the menu's visibility is exercised the way
// the auth guard produces it in production.
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfoService } from '../../proto-gen/info_pb';
import { SessionService } from '../../proto-gen/session_pb';
import { installFakeApi } from '../../testing/fake-api';
import { settle } from '../../testing/settle';
import { Notify } from '../core/notify';
import { SessionStore } from '../core/session';
import { Shell } from './shell';

/** Stands in for every routed page so the shell's outlet has
 *  something to activate. */
@Component({ template: '<p class="stub-page">{{ label }}</p>' })
class StubPage {
  label = 'routed content';
}

describe('Shell', () => {
  let restoreApi: () => void;
  let user: { username: string; displayName: string } | undefined;
  let logoutCalls: number;
  let logoutError: ConnectError | undefined;

  beforeEach(() => {
    user = { username: 'jeff', displayName: 'Jeff Stewart' };
    logoutCalls = 0;
    logoutError = undefined;
    restoreApi = installFakeApi(({ service }) => {
      service(InfoService, {
        getInfo: () => ({
          version: '0.1.0',
          build: 'PR #82 - 2026-08-22 02:30 UTC - 7d470c5',
          pullRequest: 82,
          commit: '7d470c5',
          builtAt: '2026-08-22T02:30:00Z',
        }),
      });
      service(SessionService, {
        getSessionStatus: () => ({ setupRequired: false, signedIn: user !== undefined, user }),
        logout: () => {
          logoutCalls++;
          if (logoutError) throw logoutError;
          return {};
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([
          { path: 'welcome', component: StubPage },
          { path: 'securities', component: StubPage },
          { path: 'brokers', component: StubPage },
          { path: 'positions', component: StubPage },
          { path: 'allocation', component: StubPage },
          { path: 'tax', component: StubPage },
          { path: 'imports', component: StubPage },
        ]),
      ],
    });
  });

  afterEach(() => {
    restoreApi();
    // Material menus render into a body-level overlay that outlives
    // the fixture; drop it so the next spec cannot read a stale panel.
    for (const overlay of Array.from(document.querySelectorAll('.cdk-overlay-container'))) {
      overlay.remove();
    }
  });

  async function render(): Promise<ComponentFixture<Shell>> {
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  /** The auth guard is what fills the session store before the shell
   *  ever renders; the spec stands in for it. */
  async function loadSession(fixture: ComponentFixture<Shell>): Promise<void> {
    await TestBed.inject(SessionStore).ensureLoaded();
    await settle(fixture);
  }

  function host(fixture: ComponentFixture<Shell>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function navLinks(fixture: ComponentFixture<Shell>): HTMLAnchorElement[] {
    return Array.from(host(fixture).querySelectorAll('mat-nav-list a'));
  }

  /** The only toolbar button is the user-menu trigger (it renders
   *  solely while a user is set). */
  function menuTrigger(fixture: ComponentFixture<Shell>): HTMLButtonElement | null {
    return host(fixture).querySelector<HTMLButtonElement>('mat-toolbar button');
  }

  async function openMenu(fixture: ComponentFixture<Shell>): Promise<HTMLElement> {
    const trigger = menuTrigger(fixture);
    if (!trigger) throw new Error('user menu trigger is not rendered');
    trigger.click();
    await settle(fixture);
    const panel = document.querySelector<HTMLElement>('.mat-mdc-menu-panel');
    if (!panel) throw new Error('user menu did not open');
    return panel;
  }

  function menuItem(panel: HTMLElement, text: string): HTMLElement {
    const item = Array.from(panel.querySelectorAll<HTMLElement>('.mat-mdc-menu-item')).find((el) =>
      el.textContent!.includes(text),
    );
    if (!item) throw new Error(`no menu item containing ${text}`);
    return item;
  }

  it('renders the six sections in order with their routes and icons', async () => {
    const fixture = await render();
    const links = navLinks(fixture);
    expect(links).toHaveLength(6);
    const textOf = (a: HTMLAnchorElement, selector: string) =>
      a.querySelector(selector)!.textContent!.trim();
    expect(links.map((a) => textOf(a, '[matListItemTitle]'))).toEqual([
      'Securities',
      'Brokers',
      'Positions',
      'Allocation',
      'Tax',
      'Imports',
    ]);
    expect(links.map((a) => textOf(a, 'mat-icon'))).toEqual([
      'inventory_2',
      'account_balance',
      'trending_up',
      'pie_chart',
      'receipt_long',
      'upload_file',
    ]);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/securities',
      '/brokers',
      '/positions',
      '/allocation',
      '/tax',
      '/imports',
    ]);
    expect(host(fixture).textContent).toContain('Portfolio Manager');
  });

  it('activates the routed page inside the shell content column', async () => {
    const fixture = await render();
    expect(host(fixture).querySelector('.stub-page')).toBeNull();
    await TestBed.inject(Router).navigateByUrl('/tax');
    await settle(fixture);
    const routed = host(fixture).querySelector('mat-sidenav-content .stub-page');
    expect(routed).toBeTruthy();
    expect(routed!.textContent).toBe('routed content');
  });

  it('marks only the current section with routerLinkActive', async () => {
    const fixture = await render();
    const active = () =>
      navLinks(fixture)
        .filter((a) => a.classList.contains('active-link'))
        .map((a) => a.getAttribute('href'));
    expect(active()).toEqual([]);

    await TestBed.inject(Router).navigateByUrl('/positions');
    await settle(fixture);
    expect(active()).toEqual(['/positions']);

    await TestBed.inject(Router).navigateByUrl('/imports');
    await settle(fixture);
    expect(active()).toEqual(['/imports']);
  });

  it('shows the build stamp at the foot of the nav', async () => {
    const fixture = await render();
    const stamp = host(fixture).querySelector<HTMLElement>('.shell-build');
    expect(stamp?.textContent?.trim()).toBe('PR #82 - 2026-08-22 02:30 UTC - 7d470c5');
    expect(host(fixture).querySelector('mat-sidenav .shell-build')).toBe(stamp);
  });

  it('shows no user menu until the session store has a user', async () => {
    const fixture = await render();
    expect(menuTrigger(fixture)).toBeNull();
    expect(host(fixture).textContent).not.toContain('Jeff Stewart');

    await loadSession(fixture);
    expect(menuTrigger(fixture)).not.toBeNull();
    expect(menuTrigger(fixture)!.textContent).toContain('Jeff Stewart');
  });

  it('keeps the user menu hidden for a signed-out session', async () => {
    user = undefined;
    const fixture = await render();
    await loadSession(fixture);
    expect(TestBed.inject(SessionStore).signedIn()).toBe(false);
    expect(menuTrigger(fixture)).toBeNull();
  });

  it('labels the trigger with the username when no display name is set', async () => {
    user = { username: 'jeff', displayName: '' };
    const fixture = await render();
    await loadSession(fixture);
    expect(menuTrigger(fixture)!.textContent).toContain('jeff');
  });

  it('opens a menu with the user details line and a Logout item', async () => {
    const fixture = await render();
    await loadSession(fixture);
    const panel = await openMenu(fixture);
    const details = menuItem(panel, 'Jeff Stewart');
    expect(details.textContent!.trim()).toBe('Jeff Stewart (jeff)');
    expect(details.classList.contains('shell-user-details')).toBe(true);
    expect(details.getAttribute('disabled')).not.toBeNull();
    expect(menuItem(panel, 'Logout').textContent).toContain('logout');
  });

  it('logout calls the RPC, clears the session, and navigates to /welcome', async () => {
    const fixture = await render();
    await loadSession(fixture);
    await TestBed.inject(Router).navigateByUrl('/tax');
    await settle(fixture);

    const panel = await openMenu(fixture);
    menuItem(panel, 'Logout').click();
    await settle(fixture);

    expect(logoutCalls).toBe(1);
    expect(TestBed.inject(SessionStore).current()).toEqual({ kind: 'signedOut' });
    expect(TestBed.inject(Router).url).toBe('/welcome');
    expect(menuTrigger(fixture)).toBeNull();
  });

  it('routes a failed logout to the error snackbar and stays put', async () => {
    const fixture = await render();
    await loadSession(fixture);
    await TestBed.inject(Router).navigateByUrl('/tax');
    await settle(fixture);
    const errorSpy = vi.spyOn(TestBed.inject(Notify), 'error');
    logoutError = new ConnectError('session store unavailable', Code.Unavailable);

    await fixture.componentInstance.logout();
    await settle(fixture);

    expect(logoutCalls).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const err = errorSpy.mock.calls[0][0] as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.rawMessage).toBe('session store unavailable');
    expect(TestBed.inject(Router).url).toBe('/tax');
    // The store only clears on success, so the menu survives.
    expect(TestBed.inject(SessionStore).signedIn()).toBe(true);
    expect(menuTrigger(fixture)).not.toBeNull();
  });
});
