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
        loadComponent: () =>
          import('./pages/securities/securities-page').then((m) => m.SecuritiesPage),
      },
      {
        path: 'securities/:id',
        loadComponent: () =>
          import('./pages/securities/security-details-page').then((m) => m.SecurityDetailsPage),
      },
      {
        path: 'securities/:id/prices',
        loadComponent: () =>
          import('./pages/securities/private-prices-page').then((m) => m.PrivatePricesPage),
      },
      {
        path: 'positions',
        loadComponent: () =>
          import('./pages/positions/positions-page').then((m) => m.PositionsPage),
      },
      {
        path: 'positions/:id',
        loadComponent: () =>
          import('./pages/positions/lot-details-page').then((m) => m.LotDetailsPage),
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
