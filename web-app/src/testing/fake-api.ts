// In-memory fake backend for unit specs (docs/design/ui-testing.md).
//
// The app's `api` singleton builds its clients at module load, so
// specs don't swap the transport - they swap the *clients*:
//
//   const restore = installFakeApi(({ service }) => {
//     service(BrokerService, {
//       listBrokers: () => ({ brokers: [ ... ], totalHoldings: money('0') }),
//     });
//   });
//   // ... test ...
//   restore();   // afterEach
//
// createRouterTransport runs the real generated clients against these
// TypeScript implementations - same serialization, no network. Any
// RPC a spec doesn't implement rejects with UNIMPLEMENTED, which
// surfaces as the page's error snackbar: unhandled calls are loud,
// never silent.
import { createClient, createRouterTransport } from '@connectrpc/connect';
import { SessionService } from '../proto-gen/session_pb';
import { BrokerService } from '../proto-gen/brokers_pb';
import { AccountService } from '../proto-gen/accounts_pb';
import { SecurityService } from '../proto-gen/securities_pb';
import { PositionService } from '../proto-gen/positions_pb';
import { AllocationService } from '../proto-gen/allocation_pb';
import { ImportService } from '../proto-gen/imports_pb';
import { InfoService } from '../proto-gen/info_pb';
import { TradingPlanService } from '../proto-gen/trading_plan_pb';
import { api } from '../app/core/api';

type Routes = Parameters<typeof createRouterTransport>[0];

/** Replaces the singleton's clients with fakes; returns the restore. */
export function installFakeApi(routes: Routes): () => void {
  const transport = createRouterTransport(routes);
  const previous = { ...api };
  Object.assign(api, {
    session: createClient(SessionService, transport),
    brokers: createClient(BrokerService, transport),
    accounts: createClient(AccountService, transport),
    securities: createClient(SecurityService, transport),
    positions: createClient(PositionService, transport),
    allocation: createClient(AllocationService, transport),
    imports: createClient(ImportService, transport),
    info: createClient(InfoService, transport),
    plans: createClient(TradingPlanService, transport),
  });
  return () => {
    Object.assign(api, previous);
  };
}
