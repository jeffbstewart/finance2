import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Notify } from '../core/notify';
import { SessionStore } from '../core/session';

/** The application shell (spec §8.2): top toolbar with the sign-in
 *  widget, a permanently open left nav with the five sections, and
 *  the routed content in a padded center column. */
@Component({
  selector: 'app-shell',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatMenuModule,
    MatSidenavModule,
    MatToolbarModule,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);

  readonly user = this.session.user;

  readonly sections = [
    { path: '/securities', label: 'Securities', icon: 'inventory_2' },
    { path: '/brokers', label: 'Brokers', icon: 'account_balance' },
    { path: '/positions', label: 'Positions', icon: 'trending_up' },
    { path: '/allocation', label: 'Allocation', icon: 'pie_chart' },
    { path: '/tax', label: 'Tax', icon: 'receipt_long' },
  ];

  async logout(): Promise<void> {
    try {
      await this.session.logout();
      await this.router.navigateByUrl('/welcome');
    } catch (err) {
      this.notify.error(err);
    }
  }
}
