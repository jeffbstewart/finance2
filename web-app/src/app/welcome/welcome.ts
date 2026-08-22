import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ActivatedRoute, Router } from '@angular/router';
import { Notify } from '../core/notify';
import { SessionStore } from '../core/session';

/**
 * The unauthenticated landing page (spec sec. 8.2): sign-in, or - on a
 * fresh install - the create-the-first-account flow (build-scope sec. 8),
 * which requires the setup token printed in the server log.
 */
@Component({
  selector: 'app-welcome',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressBarModule,
  ],
  templateUrl: './welcome.html',
  styleUrl: './welcome.scss',
})
export class Welcome {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly notify = inject(Notify);

  readonly state = this.session.current;
  readonly busy = signal(false);

  username = '';
  password = '';
  displayName = '';
  setupToken = '';

  constructor() {
    void this.session.ensureLoaded().then((state) => {
      if (state.kind === 'signedIn') void this.enter();
    });
  }

  async signIn(): Promise<void> {
    await this.run(async () => {
      await this.session.login(this.username.trim(), this.password);
      await this.enter();
    });
  }

  async createAccount(): Promise<void> {
    await this.run(async () => {
      await this.session.createFirstUser(
        this.username.trim(),
        this.password,
        this.displayName.trim(),
        this.setupToken.trim(),
      );
      this.notify.success('Welcome! Your account is ready.');
      await this.enter();
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  private async enter(): Promise<void> {
    const returnUrl = this.route.snapshot.queryParamMap.get('return') ?? '/brokers';
    await this.router.navigateByUrl(returnUrl);
  }
}
