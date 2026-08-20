import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

// Path routing with reloadable state (spec §8.2); everything except
// the welcome page sits behind the session guard inside the shell.
export const routes: Routes = [
  { path: 'welcome', loadComponent: () => import('./welcome/welcome').then((m) => m.Welcome) },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'brokers' },
      {
        path: 'brokers',
        loadComponent: () => import('./pages/brokers/brokers-page').then((m) => m.BrokersPage),
      },
      {
        path: 'brokers/:id',
        loadComponent: () =>
          import('./pages/brokers/broker-accounts-page').then((m) => m.BrokerAccountsPage),
      },
      {
        path: 'securities',
        loadComponent: () => import('./pages/placeholder').then((m) => m.Placeholder),
        data: { title: 'Securities' },
      },
      {
        path: 'positions',
        loadComponent: () => import('./pages/placeholder').then((m) => m.Placeholder),
        data: { title: 'Positions' },
      },
      {
        path: 'allocation',
        loadComponent: () => import('./pages/placeholder').then((m) => m.Placeholder),
        data: { title: 'Asset Allocation' },
      },
      {
        path: 'tax',
        loadComponent: () => import('./pages/placeholder').then((m) => m.Placeholder),
        data: { title: 'Tax Report' },
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
