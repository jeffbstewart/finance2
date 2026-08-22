import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionStore } from './session';

/** Unauthenticated access redirects to the welcome page, remembering
 *  the attempted URL for after sign-in (spec sec. 8.2). */
export const authGuard: CanActivateFn = async (_route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const current = await session.ensureLoaded();
  if (current.kind === 'signedIn') return true;
  return router.createUrlTree(['/welcome'], { queryParams: { return: state.url } });
};
