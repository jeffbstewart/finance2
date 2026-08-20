import { Component, inject } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';

/** Stand-in page: each section is replaced by its real screen in the
 *  Phase 6 PR stack. */
@Component({
  selector: 'app-placeholder',
  imports: [MatCardModule],
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ title() }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <p>This screen arrives in an upcoming pull request.</p>
      </mat-card-content>
    </mat-card>
  `,
})
export class Placeholder {
  private readonly route = inject(ActivatedRoute);
  readonly title = toSignal(this.route.data.pipe(map((d) => (d['title'] as string) ?? '')), {
    initialValue: '',
  });
}
