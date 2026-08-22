// The one place the SPA touches the wire: typed Connect-ES clients
// generated from proto/ (firm requirement - a hallucinated field or
// RPC is a compile error). gRPC-Web straight to ArmeriaAppServer, no
// proxy; the HttpOnly session cookie rides on credentials: 'include'.
import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { SessionService } from '../../proto-gen/session_pb';
import { BrokerService } from '../../proto-gen/brokers_pb';
import { AccountService } from '../../proto-gen/accounts_pb';
import { SecurityService } from '../../proto-gen/securities_pb';
import { PositionService } from '../../proto-gen/positions_pb';
import { AllocationService } from '../../proto-gen/allocation_pb';
import { ImportService } from '../../proto-gen/imports_pb';
import { InfoService } from '../../proto-gen/info_pb';
import { TradingPlanService } from '../../proto-gen/trading_plan_pb';

const transport = createGrpcWebTransport({
  baseUrl: location.origin,
  fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
});

export const api = {
  session: createClient(SessionService, transport),
  brokers: createClient(BrokerService, transport),
  accounts: createClient(AccountService, transport),
  securities: createClient(SecurityService, transport),
  positions: createClient(PositionService, transport),
  allocation: createClient(AllocationService, transport),
  imports: createClient(ImportService, transport),
  info: createClient(InfoService, transport),
  plans: createClient(TradingPlanService, transport),
} as const;
