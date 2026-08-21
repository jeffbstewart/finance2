// Canned responses mirroring the server's SampleSeeder portfolio
// (docs/design/ui-testing.md), so unit specs and e2e specs agree on
// entity names and figures. One builder per wire type the pages read;
// keep names and numbers in sync with SampleSeeder.kt.
//
// Holdings figures: the real server values positions from prices, so
// a unit fixture's dollar figures are whatever the spec needs to
// exercise sortKey/display plumbing — they are not promises about the
// e2e lane's numbers. Quantities, names, currencies, and provenance
// ARE shared with the seeder.
import { create } from '@bufbuild/protobuf';
import { AccountSummarySchema, type AccountSummary } from '../proto-gen/accounts_pb';
import {
  ClassAllocationSchema,
  ClassContributorSchema,
  GetAllocationResponseSchema,
  type GetAllocationResponse,
} from '../proto-gen/allocation_pb';
import { BrokerSummarySchema, type BrokerSummary } from '../proto-gen/brokers_pb';
import { ProvenanceSchema } from '../proto-gen/common_pb';
import {
  ImportReportSchema,
  ImportWarningSchema,
  ReportLineSchema,
  ReportSeverity,
  SnapshotRowSchema,
  SnapshotStatus,
  type ImportWarning,
  type SnapshotRow,
} from '../proto-gen/imports_pb';
import {
  AccountChoiceSchema,
  GetLotDetailsResponseSchema,
  GetPurchaseFormInfoResponseSchema,
  GetTaxReportResponseSchema,
  ListPositionsResponseSchema,
  LotRowSchema,
  MtmIncomeRowSchema,
  PositionRowSchema,
  SaleRowSchema,
  SecurityChoiceSchema,
  TaxReportRowSchema,
  type GetLotDetailsResponse,
  type GetPurchaseFormInfoResponse,
  type GetTaxReportResponse,
  type ListPositionsResponse,
} from '../proto-gen/positions_pb';
import {
  ClassificationSetSchema,
  ListMtmMarksResponseSchema,
  MtmMarkSchema,
  PricingLocus,
  PrivatePriceRowSchema,
  SecurityListingSchema,
  SecurityProfileSchema,
  SecurityType,
  SparklineSchema,
  TaxTreatment,
  type ListMtmMarksResponse,
  type PrivatePriceRow,
  type SecurityListing,
  type SecurityProfile,
} from '../proto-gen/securities_pb';
import {
  GetSessionStatusResponseSchema,
  UserInfoSchema,
  type GetSessionStatusResponse,
  type UserInfo,
} from '../proto-gen/session_pb';
import { civil, date, decimal, fraction, money, quantity, rate } from './wire';

/** The five seeded asset classes, in display order (V004 seed). */
export const CLASS_NAMES = ['Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other'] as const;

// ---------------------------------------------------------------- session

export function sampleUser(): UserInfo {
  return create(UserInfoSchema, { username: 'e2e', displayName: 'E2E' });
}

export function signedInStatus(): GetSessionStatusResponse {
  return create(GetSessionStatusResponseSchema, {
    setupRequired: false,
    signedIn: true,
    user: sampleUser(),
  });
}

export function signedOutStatus(): GetSessionStatusResponse {
  return create(GetSessionStatusResponseSchema, { setupRequired: false, signedIn: false });
}

export function setupStatus(): GetSessionStatusResponse {
  return create(GetSessionStatusResponseSchema, { setupRequired: true, signedIn: false });
}

// ---------------------------------------------------------------- brokers

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

// --------------------------------------------------------------- accounts

/** Vanguard's two USD accounts (the original fixture; merged specs
 *  depend on exactly these two). */
export function sampleAccounts(): AccountSummary[] {
  return sampleAllAccounts().filter((a) => a.brokerName === 'Vanguard' && !a.hidden);
}

/** All four seeded accounts: Brokerage, Roth IRA, EUR Brokerage, and
 *  the hidden Closed Account. Filter as the scenario needs. */
export function sampleAllAccounts(): AccountSummary[] {
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
      sweepProvenance: create(ProvenanceSchema, { source: 'manual' }),
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
      sweepProvenance: create(ProvenanceSchema, { source: 'plaid' }),
      investmentValue: money('19000.00', { display: '$19,000.00' }),
    }),
    create(AccountSummarySchema, {
      accountId: 3n,
      brokerId: 2n,
      brokerName: 'EuroBank',
      name: 'EUR Brokerage',
      accountNumber: 'X-3',
      currencyCode: 'EUR',
      taxDeferred: false,
      sweepBalance: money('250.00', { currency: 'EUR', display: '€250.00' }),
      sweepProvenance: create(ProvenanceSchema, { source: 'manual' }),
      investmentValue: money('10400.00', { currency: 'EUR', display: '€10,400.00' }),
    }),
    create(AccountSummarySchema, {
      accountId: 4n,
      brokerId: 1n,
      brokerName: 'Vanguard',
      name: 'Closed Account',
      accountNumber: 'X-4',
      currencyCode: 'USD',
      taxDeferred: false,
      hidden: true,
      sweepBalance: money('0', { display: '$0.00' }),
      investmentValue: money('0', { display: '$0.00' }),
    }),
  ];
}

/** The buy/rebalance form's account choices (visible accounts, ordered
 *  by broker name then account name — EuroBank first). */
export function sampleAccountChoices(): GetPurchaseFormInfoResponse['accounts'] {
  return [
    create(AccountChoiceSchema, {
      accountId: 3n,
      brokerName: 'EuroBank',
      name: 'EUR Brokerage',
      currencyCode: 'EUR',
      taxDeferred: false,
      sweeps: money('250.00', { currency: 'EUR', display: '€250.00' }),
    }),
    create(AccountChoiceSchema, {
      accountId: 1n,
      brokerName: 'Vanguard',
      name: 'Brokerage',
      currencyCode: 'USD',
      taxDeferred: false,
      sweeps: money('500.00', { display: '$500.00' }),
    }),
    create(AccountChoiceSchema, {
      accountId: 2n,
      brokerName: 'Vanguard',
      name: 'Roth IRA',
      currencyCode: 'USD',
      taxDeferred: true,
      sweeps: money('55.25', { display: '$55.25' }),
    }),
  ];
}

export function sampleSecurityChoices(): GetPurchaseFormInfoResponse['securities'] {
  return [
    create(SecurityChoiceSchema, {
      securityId: 2n, ticker: 'BONDX', description: 'Aggregate Bond Fund',
      currencyCode: 'USD', securityType: SecurityType.MUTUAL_FUND,
    }),
    create(SecurityChoiceSchema, {
      securityId: 4n, ticker: 'EUFUND', description: 'European Index Fund',
      currencyCode: 'EUR', securityType: SecurityType.MUTUAL_FUND,
    }),
    create(SecurityChoiceSchema, {
      securityId: 3n, ticker: 'GOLD', description: 'Gold coins in a vault',
      currencyCode: 'USD', securityType: SecurityType.PRIVATE_INVESTMENT,
    }),
    create(SecurityChoiceSchema, {
      securityId: 1n, ticker: 'VTI', description: 'Total Market ETF',
      currencyCode: 'USD', securityType: SecurityType.ETF,
    }),
  ];
}

export function samplePurchaseFormInfo(): GetPurchaseFormInfoResponse {
  return create(GetPurchaseFormInfoResponseSchema, {
    accounts: sampleAccountChoices(),
    securities: sampleSecurityChoices(),
  });
}

// ------------------------------------------------------------- securities

/** VTI, EUFUND, and hidden GHOST (the original fixture; merged specs
 *  depend on exactly these three). */
export function sampleSecurities(): SecurityListing[] {
  const all = sampleAllSecurities();
  // Original order: VTI, EUFUND, GHOST (specs index into it).
  return ['VTI', 'EUFUND', 'GHOST'].map((t) => all.find((l) => l.ticker === t)!);
}

/** Every seeded listing, ticker-ordered as the server lists them. */
export function sampleAllSecurities(): SecurityListing[] {
  return [
    create(SecurityListingSchema, {
      securityId: 2n,
      ticker: 'BONDX',
      description: 'Aggregate Bond Fund',
      sparkline: create(SparklineSchema, { adjustedCloses: ['10.0', '10.5'].map((v) => decimal(v)) }),
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
    create(SecurityListingSchema, {
      securityId: 3n,
      ticker: 'GOLD',
      description: 'Gold coins in a vault',
      sparkline: create(SparklineSchema, { adjustedCloses: ['3100.0', '3358.5'].map((v) => decimal(v)) }),
    }),
    create(SecurityListingSchema, {
      securityId: 6n,
      ticker: 'SOLO',
      description: 'Priced, never held',
      // Exactly one close: the sparkline renders no path.
      sparkline: create(SparklineSchema, { adjustedCloses: [decimal('42.0')] }),
    }),
    create(SecurityListingSchema, {
      securityId: 1n,
      ticker: 'VTI',
      description: 'Total Market ETF',
      sparkline: create(SparklineSchema, {
        adjustedCloses: ['198.0', '199.5', '200.1', '201.9'].map((v) => decimal(v)),
      }),
    }),
  ];
}

function assetClassSet(name: string, asOf: string, refreshSuggested = false) {
  return create(ClassificationSetSchema, {
    kind: 'ASSET_CLASS',
    asOf: civil(asOf),
    refreshSuggested,
    weights: { [name]: fraction('1', '100%') },
  });
}

/** Profiles mirroring the seeder; pick by ticker. */
export function sampleProfile(ticker: 'VTI' | 'BONDX' | 'GOLD' | 'EUFUND' | 'SOLO'): SecurityProfile {
  switch (ticker) {
    case 'VTI':
      return create(SecurityProfileSchema, {
        securityId: 1n, ticker, description: 'Total Market ETF', currencyCode: 'USD',
        securityType: SecurityType.ETF, pricingLocus: PricingLocus.MARKET,
        taxTreatment: TaxTreatment.LOTS, netExpenseRatio: fraction('0.0003', '0.03%'),
        classifications: [assetClassSet('US Stock', '2026-07-20')],
      });
    case 'BONDX':
      return create(SecurityProfileSchema, {
        securityId: 2n, ticker, description: 'Aggregate Bond Fund', currencyCode: 'USD',
        securityType: SecurityType.MUTUAL_FUND, pricingLocus: PricingLocus.MANUAL,
        taxTreatment: TaxTreatment.LOTS, netExpenseRatio: fraction('0.0005', '0.05%'),
        classifications: [assetClassSet('Bond', '2026-07-20')],
      });
    case 'GOLD':
      return create(SecurityProfileSchema, {
        securityId: 3n, ticker, description: 'Gold coins in a vault', currencyCode: 'USD',
        securityType: SecurityType.PRIVATE_INVESTMENT, pricingLocus: PricingLocus.MANUAL,
        taxTreatment: TaxTreatment.LOTS,
        classifications: [assetClassSet('Other', '2025-07-15', true)],
      });
    case 'EUFUND':
      return create(SecurityProfileSchema, {
        securityId: 4n, ticker, description: 'European Index Fund', currencyCode: 'EUR',
        securityType: SecurityType.MUTUAL_FUND, pricingLocus: PricingLocus.MANUAL,
        taxTreatment: TaxTreatment.MARK_TO_MARKET, netExpenseRatio: fraction('0.0012', '0.12%'),
        classifications: [assetClassSet('Non US Stock', '2026-07-20')],
      });
    case 'SOLO':
      return create(SecurityProfileSchema, {
        securityId: 6n, ticker, description: 'Priced, never held', currencyCode: 'USD',
        securityType: SecurityType.STOCK, pricingLocus: PricingLocus.MANUAL,
        taxTreatment: TaxTreatment.LOTS,
      });
  }
}

export function samplePrivatePrices(): PrivatePriceRow[] {
  // GOLD's two prices, newest first as the server lists them.
  return [
    create(PrivatePriceRowSchema, {
      priceId: 2n, date: date('2026-08-16'), price: money('3358.50', { display: '$3,358.50' }),
    }),
    create(PrivatePriceRowSchema, {
      priceId: 1n, date: date('2026-05-23'), price: money('3100.00', { display: '$3,100.00' }),
    }),
  ];
}

/** EUFUND's two chained marks (lastYear−1 and lastYear, seeded at
 *  €9,500 × 1.05 and €10,000 × 1.08 over the $9,911 floor). */
export function sampleMtmMarks(lastYear = new Date().getFullYear() - 1): ListMtmMarksResponse {
  return create(ListMtmMarksResponseSchema, {
    acquisitionCostUsd: money('9911.00', { display: '$9,911.00' }),
    marks: [
      create(MtmMarkSchema, {
        markId: 1n, taxYear: lastYear - 1, markDate: date(`${lastYear - 1}-12-31`),
        quantity: quantity('100'), fmvLocal: money('9500.00', { currency: 'EUR', display: '€9,500.00' }),
        fxRate: rate('1.05000000'), fmvUsd: money('9975.00', { display: '$9,975.00' }),
        basisBefore: money('9911.00', { display: '$9,911.00' }),
        basisAfter: money('9975.00', { display: '$9,975.00' }),
        ordinaryIncome: money('64.00', { display: '$64.00' }),
      }),
      create(MtmMarkSchema, {
        markId: 2n, taxYear: lastYear, markDate: date(`${lastYear}-12-31`),
        quantity: quantity('100'), fmvLocal: money('10000.00', { currency: 'EUR', display: '€10,000.00' }),
        fxRate: rate('1.08000000'), fmvUsd: money('10800.00', { display: '$10,800.00' }),
        basisBefore: money('9975.00', { display: '$9,975.00' }),
        basisAfter: money('10800.00', { display: '$10,800.00' }),
        ordinaryIncome: money('825.00', { display: '$825.00' }),
      }),
    ],
  });
}

// ------------------------------------------------------------- positions

export function samplePositions(): ListPositionsResponse {
  return create(ListPositionsResponseSchema, {
    positions: [
      create(PositionRowSchema, {
        securityId: 1n, ticker: 'VTI', shares: quantity('47'),
        basis: money('6000.00', { display: '$6,000.00' }),
        currentValue: money('9489.30', { display: '$9,489.30' }),
        shortTermGain: money('300.00', { display: '$300.00' }),
        longTermGain: money('1200.00', { display: '$1,200.00' }),
      }),
      create(PositionRowSchema, {
        securityId: 2n, ticker: 'BONDX', shares: quantity('100'),
        basis: money('1000.00', { display: '$1,000.00' }),
        currentValue: money('1050.00', { display: '$1,050.00' }),
        shortTermGain: money('50.00', { display: '$50.00' }),
        longTermGain: money('0', { display: '$0.00' }),
      }),
      create(PositionRowSchema, {
        securityId: 3n, ticker: 'GOLD', shares: quantity('5'),
        basis: money('0', { display: '$0.00' }),
        currentValue: money('16792.50', { display: '$16,792.50' }),
        shortTermGain: money('0', { display: '$0.00' }),
        longTermGain: money('0', { display: '$0.00' }),
        provenance: create(ProvenanceSchema, { source: 'plaid' }),
      }),
    ],
    totalBasis: money('7000.00', { display: '$7,000.00' }),
    totalValue: money('27331.80', { display: '$27,331.80' }),
    totalShortTermGain: money('350.00', { display: '$350.00' }),
    totalLongTermGain: money('1200.00', { display: '$1,200.00' }),
  });
}

/** VTI's Brokerage lots after the seeded sales (19 + 16 still held),
 *  with the previous-year sale in the history. */
export function sampleLotDetails(lastYear = new Date().getFullYear() - 1): GetLotDetailsResponse {
  return create(GetLotDetailsResponseSchema, {
    inflationAdjusted: false,
    lots: [
      create(LotRowSchema, {
        lotId: 1n, accountId: 1n, accountName: 'Brokerage', bought: date(`${lastYear - 1}-03-01`),
        shares: quantity('30'), buyPricePerShare: money('150.00', { display: '$150.00' }),
        currentPricePerShare: money('201.90', { display: '$201.90' }),
        commission: money('5.00', { display: '$5.00' }), sharesStillHeld: quantity('19'),
        basis: money('2853.17', { display: '$2,853.17' }),
        currentValue: money('3836.10', { display: '$3,836.10' }),
        shortTermGain: money('0', { display: '$0.00' }),
        longTermGain: money('982.93', { display: '$982.93' }),
      }),
      create(LotRowSchema, {
        lotId: 2n, accountId: 1n, accountName: 'Brokerage', bought: date(`${lastYear}-01-20`),
        shares: quantity('20'), buyPricePerShare: money('180.00', { display: '$180.00' }),
        currentPricePerShare: money('201.90', { display: '$201.90' }),
        commission: money('5.00', { display: '$5.00' }), sharesStillHeld: quantity('16'),
        basis: money('2884.00', { display: '$2,884.00' }),
        currentValue: money('3230.40', { display: '$3,230.40' }),
        shortTermGain: money('346.40', { display: '$346.40' }),
        longTermGain: money('0', { display: '$0.00' }),
      }),
    ],
    sales: [
      create(SaleRowSchema, {
        saleId: 1n, sold: date(`${lastYear}-06-15`), shares: quantity('10'),
        pricePerShare: money('190.00', { display: '$190.00' }),
        saleCosts: money('9.00', { display: '$9.00' }),
        shortTermGain: money('35.40', { display: '$35.40' }),
        longTermGain: money('233.60', { display: '$233.60' }),
      }),
    ],
  });
}

// ------------------------------------------------------------ allocation

/** The five seeded classes with the 10/40/20/20/10 target. Current
 *  values are illustrative; contributors carry the seeded tickers. */
export function sampleAllocation(targetSet = true): GetAllocationResponse {
  const classes = [
    { name: 'Cash', current: '555.25', target: '0.1', contributors: [] as string[] },
    { name: 'US Stock', current: '9489.30', target: '0.4', contributors: ['VTI'] },
    { name: 'Non US Stock', current: '12064.00', target: '0.2', contributors: ['EUFUND'] },
    { name: 'Bond', current: '1050.00', target: '0.2', contributors: ['BONDX'] },
    { name: 'Other', current: '16792.50', target: '0.1', contributors: ['GOLD'] },
  ];
  const total = 39951.05;
  const fmt = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return create(GetAllocationResponseSchema, {
    targetSet,
    portfolioTotal: money(total.toFixed(2), { display: fmt(total) }),
    classes: classes.map((c, i) =>
      create(ClassAllocationSchema, {
        name: c.name,
        current: money(c.current, { display: fmt(Number(c.current)) }),
        currentFraction: fraction((Number(c.current) / total).toFixed(4)),
        target: money((total * Number(c.target)).toFixed(2), { display: fmt(total * Number(c.target)) }),
        targetFraction: fraction(c.target, `${Number(c.target) * 100}%`),
        delta: money((total * Number(c.target) - Number(c.current)).toFixed(2), {
          display: fmt(total * Number(c.target) - Number(c.current)),
        }),
        contributors: c.contributors.map((ticker) =>
          create(ClassContributorSchema, {
            securityId: BigInt(i + 1), ticker, shares: quantity('1'),
            classWeight: fraction('1', '100%'),
            contribution: money(c.current, { display: fmt(Number(c.current)) }),
          }),
        ),
      }),
    ),
  });
}

// ------------------------------------------------------------------- tax

/** The default (previous calendar year) report: the seeded VTI sale
 *  plus the EUFUND PFIC mark. */
export function sampleTaxReport(lastYear = new Date().getFullYear() - 1): GetTaxReportResponse {
  return create(GetTaxReportResponseSchema, {
    rows: [
      create(TaxReportRowSchema, {
        brokerName: 'Vanguard', accountName: 'Brokerage', ticker: 'VTI',
        bought: date(`${lastYear - 1}-03-01`), sold: date(`${lastYear}-06-15`),
        purchasePricePerShare: money('150.00', { display: '$150.00' }),
        salePricePerShare: money('190.00', { display: '$190.00' }),
        purchaseCosts: money('1.00', { display: '$1.00' }),
        saleCosts: money('5.40', { display: '$5.40' }),
        shortTermGain: money('0', { display: '$0.00' }),
        longTermGain: money('233.60', { display: '$233.60' }),
      }),
      create(TaxReportRowSchema, {
        brokerName: 'Vanguard', accountName: 'Brokerage', ticker: 'VTI',
        bought: date(`${lastYear}-01-20`), sold: date(`${lastYear}-06-15`),
        purchasePricePerShare: money('180.00', { display: '$180.00' }),
        salePricePerShare: money('190.00', { display: '$190.00' }),
        purchaseCosts: money('1.00', { display: '$1.00' }),
        saleCosts: money('3.60', { display: '$3.60' }),
        shortTermGain: money('35.40', { display: '$35.40' }),
        longTermGain: money('0', { display: '$0.00' }),
      }),
    ],
    totalShortTermGain: money('35.40', { display: '$35.40' }),
    totalLongTermGain: money('233.60', { display: '$233.60' }),
    totalGain: money('269.00', { display: '$269.00' }),
    mtmRows: [
      create(MtmIncomeRowSchema, {
        ticker: 'EUFUND', taxYear: lastYear, markDate: date(`${lastYear}-12-31`),
        fmvUsd: money('10800.00', { display: '$10,800.00' }),
        basisBefore: money('9975.00', { display: '$9,975.00' }),
        ordinaryIncome: money('825.00', { display: '$825.00' }),
      }),
    ],
    totalMtmOrdinaryIncome: money('825.00', { display: '$825.00' }),
  });
}

// --------------------------------------------------------------- imports

/** The processed sample's warnings, attributed to Vanguard's two
 *  accounts (ListImportWarnings with no filter). */
export function sampleImportWarnings(): ImportWarning[] {
  return [
    create(ImportWarningSchema, {
      snapshotId: 2n,
      asOf: date('2026-08-10'),
      accountId: 2n,
      brokerId: 1n,
      accountName: 'Roth IRA',
      message: 'Vanguard "Roth IRA" …5678: ticker INTLX is not a known security — add it by hand and re-process',
    }),
    create(ImportWarningSchema, {
      snapshotId: 2n,
      asOf: date('2026-08-10'),
      accountId: 1n,
      brokerId: 1n,
      accountName: 'Brokerage',
      message:
        'Vanguard "Brokerage" …1234: VTI — institution reports 12 shares, lots hold 10 (taxable accounts are never changed by imports; reconcile the lots by hand)',
    }),
  ];
}

export function sampleSnapshots(): SnapshotRow[] {
  return [
    create(SnapshotRowSchema, {
      snapshotId: 1n,
      filename: 'vanguard-sample.pb',
      uploadedAt: '2026-08-18T14:00:00Z',
      asOf: date('2026-08-18'),
      schemaVersion: 1,
      status: SnapshotStatus.UPLOADED,
    }),
    create(SnapshotRowSchema, {
      snapshotId: 2n,
      filename: 'processed-sample.pb',
      uploadedAt: '2026-08-10T09:30:00Z',
      asOf: date('2026-08-10'),
      schemaVersion: 1,
      status: SnapshotStatus.PROCESSED,
      processedAt: '2026-08-10T09:31:00Z',
      report: create(ImportReportSchema, {
        holdingsUpdated: 1,
        sweepsUpdated: 1,
        lines: [
          create(ReportLineSchema, {
            severity: ReportSeverity.WARNING,
            message: 'Vanguard "Roth IRA" …5678: ticker INTLX is not a known security — add it by hand and re-process',
          }),
          create(ReportLineSchema, {
            severity: ReportSeverity.INFO,
            message: 'Vanguard "Roth IRA" …5678: 1 holding(s) updated',
          }),
        ],
      }),
    }),
  ];
}
