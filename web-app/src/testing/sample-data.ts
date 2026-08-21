// Canned responses mirroring the server's SampleSeeder portfolio
// (docs/design/ui-testing.md), so unit specs and e2e specs agree on
// entity names. Extend per page as specs need — keep names in sync
// with SampleSeeder.kt.
import { create } from '@bufbuild/protobuf';
import { BrokerSummarySchema, type BrokerSummary } from '../proto-gen/brokers_pb';
import { AccountSummarySchema, type AccountSummary } from '../proto-gen/accounts_pb';
import {
  SecurityListingSchema,
  SparklineSchema,
  type SecurityListing,
} from '../proto-gen/securities_pb';
import { decimal, money } from './wire';

export function sampleBrokers(): BrokerSummary[] {
  return [
    create(BrokerSummarySchema, {
      brokerId: 1n,
      name: 'Vanguard',
      totalHoldings: money('52000.00', { display: '$52,000.00' }),
      sweeps: money('555.25', { display: '$555.25' }),
    }),
    create(BrokerSummarySchema, {
      brokerId: 2n,
      name: 'EuroBank',
      totalHoldings: money('12000.00', { display: '$12,000.00' }),
      sweeps: money('290.00', { display: '$290.00' }),
    }),
    create(BrokerSummarySchema, {
      brokerId: 3n,
      name: 'Old Broker',
      hidden: true,
      totalHoldings: money('0', { display: '$0.00' }),
      sweeps: money('0', { display: '$0.00' }),
    }),
  ];
}

export function sampleAccounts(): AccountSummary[] {
  return [
    create(AccountSummarySchema, {
      accountId: 1n,
      brokerId: 1n,
      brokerName: 'Vanguard',
      name: 'Brokerage',
      accountNumber: 'X-1',
      currencyCode: 'USD',
      taxDeferred: false,
      sweepBalance: money('500.00', { display: '$500.00' }),
      investmentValue: money('9000.00', { display: '$9,000.00' }),
    }),
    create(AccountSummarySchema, {
      accountId: 2n,
      brokerId: 1n,
      brokerName: 'Vanguard',
      name: 'Roth IRA',
      accountNumber: 'X-2',
      currencyCode: 'USD',
      taxDeferred: true,
      sweepBalance: money('55.25', { display: '$55.25' }),
      investmentValue: money('19000.00', { display: '$19,000.00' }),
    }),
  ];
}

export function sampleSecurities(): SecurityListing[] {
  return [
    create(SecurityListingSchema, {
      securityId: 1n,
      ticker: 'VTI',
      description: 'Total Market ETF',
      sparkline: create(SparklineSchema, {
        adjustedCloses: ['198.0', '199.5', '200.1', '201.9'].map((v) => decimal(v)),
      }),
    }),
    create(SecurityListingSchema, {
      securityId: 4n,
      ticker: 'EUFUND',
      description: 'European Index Fund',
    }),
    create(SecurityListingSchema, {
      securityId: 5n,
      ticker: 'GHOST',
      description: 'Hidden test security',
      hidden: true,
    }),
  ];
}
