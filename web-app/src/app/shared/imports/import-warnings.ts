import { Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import type { ImportWarning } from '../../../proto-gen/imports_pb';

/**
 * The reconciliation warnings the last snapshot run left against the
 * accounts in view (pipeline design §E, amended 2026-08-21): shown on
 * the broker and account pages so the human is prompted to fix lots,
 * add securities, or delete vanished holdings, then re-process. Renders
 * nothing when there is nothing to fix.
 */
@Component({
  selector: 'app-import-warnings',
  imports: [MatIconModule, RouterLink],
  template: `
    @if (warnings().length) {
      <section class="import-warnings" role="status">
        <h3 class="import-warnings-title">
          <mat-icon inline>warning</mat-icon>
          Import reconciliation — {{ warnings().length }} item(s) to fix
          @if (asOf()) {
            <span class="import-warnings-asof">(snapshot as of {{ asOf() }})</span>
          }
        </h3>
        <ul>
          @for (w of warnings(); track $index) {
            <li>
              @if (showAccount()) {
                <a [routerLink]="['/positions']" [queryParams]="{ account: w.accountId }">{{
                  w.accountName
                }}</a
                >:
              }
              {{ w.message }}
            </li>
          }
        </ul>
        <p class="import-warnings-foot">
          After fixing, <a routerLink="/imports">re-process the snapshot</a> to clear these.
        </p>
      </section>
    }
  `,
  styles: `
    .import-warnings {
      margin: 8px 0 16px;
      padding: 8px 16px;
      border-left: 4px solid #f9a825;
      background: rgba(249, 168, 37, 0.08);
      border-radius: 4px;
    }

    .import-warnings-title {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 4px 0 8px;
      font-size: 16px;
      font-weight: 500;
      color: #7a4f01;
    }

    .import-warnings-asof {
      font-weight: 400;
      opacity: 0.7;
    }

    ul {
      margin: 0;
      padding-left: 20px;
      font-size: 14px;
    }

    li {
      padding: 2px 0;
    }

    .import-warnings-foot {
      margin: 8px 0 4px;
      font-size: 13px;
      opacity: 0.8;
    }
  `,
})
export class ImportWarnings {
  readonly warnings = input<ImportWarning[]>([]);
  /** Prefix each line with a link to its account (broker-wide lists). */
  readonly showAccount = input(false);

  readonly asOf = computed(() => this.warnings()[0]?.asOf?.display ?? '');
}
