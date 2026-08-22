import { Injectable, computed, signal } from '@angular/core';
import type { UserInfo } from '../../proto-gen/session_pb';
import { api } from './api';

export type SessionState =
  | { kind: 'unknown' }
  | { kind: 'setup' }
  | { kind: 'signedOut' }
  | { kind: 'signedIn'; user: UserInfo };

/** Client-side session mirror of SessionService (build-scope sec. 8):
 *  state survives reloads via GetSessionStatus (legacy defect 11's
 *  lost-on-reload sign-in cannot recur). */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly state = signal<SessionState>({ kind: 'unknown' });

  readonly current = this.state.asReadonly();
  readonly signedIn = computed(() => this.state().kind === 'signedIn');
  readonly user = computed(() => {
    const s = this.state();
    return s.kind === 'signedIn' ? s.user : undefined;
  });

  async refresh(): Promise<SessionState> {
    const status = await api.session.getSessionStatus({});
    const next: SessionState = status.setupRequired
      ? { kind: 'setup' }
      : status.signedIn && status.user
        ? { kind: 'signedIn', user: status.user }
        : { kind: 'signedOut' };
    this.state.set(next);
    return next;
  }

  async ensureLoaded(): Promise<SessionState> {
    return this.state().kind === 'unknown' ? this.refresh() : this.state();
  }

  async login(username: string, password: string): Promise<void> {
    const response = await api.session.login({ username, password });
    if (response.user) this.state.set({ kind: 'signedIn', user: response.user });
  }

  async createFirstUser(
    username: string,
    password: string,
    displayName: string,
    setupToken: string,
  ): Promise<void> {
    const response = await api.session.createFirstUser({
      username,
      password,
      displayName,
      setupToken,
    });
    if (response.user) this.state.set({ kind: 'signedIn', user: response.user });
  }

  async logout(): Promise<void> {
    await api.session.logout({});
    this.state.set({ kind: 'signedOut' });
  }
}
