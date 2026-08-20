import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ConnectError } from '@connectrpc/connect';

/** Mutation feedback per spec §8.3: short snackbar on success, longer
 *  on error, no raw alert()s. */
@Injectable({ providedIn: 'root' })
export class Notify {
  private readonly snackBar = inject(MatSnackBar);

  success(message: string): void {
    this.snackBar.open(message, undefined, { duration: 2500 });
  }

  info(message: string): void {
    this.snackBar.open(message, undefined, { duration: 4000 });
  }

  error(err: unknown, fallback = 'Something went wrong'): void {
    this.snackBar.open(messageOf(err, fallback), 'Dismiss', { duration: 8000 });
  }
}

/** A user-facing message from a ConnectError (the server writes its
 *  INVALID_ARGUMENT / FAILED_PRECONDITION descriptions for humans). */
export function messageOf(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof ConnectError) {
    return err.rawMessage || fallback;
  }
  return err instanceof Error ? err.message : fallback;
}
