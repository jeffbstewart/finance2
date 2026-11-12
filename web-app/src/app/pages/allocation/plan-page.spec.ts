// Unit specs for the trading-plan pages (docs/design/ui-testing.md,
// inventory "PlansPage", "PlanPage", "PlanStepDialog"). The services
// are faked through installFakeApi; dialogs are spied at the page's
// own injector (MatDialogModule re-provides MatDialog).
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { create } from '@bufbuild/protobuf';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountService } from '../../../proto-gen/accounts_pb';
import { SecurityService } from '../../../proto-gen/securities_pb';
import {
  PlanStatus,
  PlanSchema,
  PlanStepInputSchema,
  PlanStepSchema,
  PlanSummarySchema,
  ProjectionSchema,
  SellCandidateSchema,
  SellOrder,
  StepKind,
  TradingPlanService,
  type Plan,
  type PlanStepInput,
  type SellCandidate,
} from '../../../proto-gen/trading_plan_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { sampleAccounts, sampleAllSecurities } from '../../../testing/sample-data';
import { settle } from '../../../testing/settle';
import { date, decimal, fraction, money } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { PlanPage } from './plan-page';
import { PlanStepDialog, type PlanStepDialogData } from './plan-step-dialog';
import { PlansPage } from './plans-page';

function summary(overrides: Partial<{ planId: bigint; name: string; status: PlanStatus; stepCount: number; lastPrintedAt: string }> = {}) {
  return create(PlanSummarySchema, {
    planId: 7n,
    name: 'Autumn rebalance',
    status: PlanStatus.PLAN_OPEN,
    createdAt: '2026-08-22T15:00:00Z',
    updatedAt: '2026-08-22T15:30:00Z',
    stepCount: 0,
    ...overrides,
  });
}

type StepFields = { kind: StepKind; accountId?: bigint; toAccountId?: bigint; securityId?: bigint; shares?: { value: string }; amount?: { value: string }; note?: string };

function step(position: number, input: StepFields, extra: Partial<{ ticker: string; accountName: string; toAccountName: string; problems: string[] }> = {}) {
  return create(PlanStepSchema, {
    stepId: BigInt(position),
    position,
    input: create(PlanStepInputSchema, {
      kind: input.kind,
      accountId: input.accountId ?? 2n,
      toAccountId: input.toAccountId ?? 0n,
      securityId: input.securityId ?? 0n,
      shares: input.shares,
      amount: input.amount,
      note: input.note ?? '',
    }),
    accountName: extra.accountName ?? 'Roth IRA',
    toAccountName: extra.toAccountName ?? '',
    ticker: extra.ticker ?? '',
    amount: money('400.00', { display: '$400.00' }),
    problems: extra.problems ?? [],
  });
}

/** A plan with two steps and a two-class projection. */
function samplePlan(steps = [
  step(1, { kind: StepKind.STEP_ADD_EXTERNAL, amount: decimal('1000'), note: 'Q3' }),
  step(2, { kind: StepKind.STEP_BUY, securityId: 1n, amount: decimal('400') }, { ticker: 'VTI' }),
]): Plan {
  return create(PlanSchema, {
    summary: summary({ stepCount: steps.length }),
    projection: create(ProjectionSchema, {
      steps,
      currentTotal: money('4500.00', { display: '$4,500.00' }),
      projectedTotal: money('5500.00', { display: '$5,500.00' }),
      externalIn: money('1000.00', { display: '$1,000.00' }),
      externalOut: money('0', { display: '$0.00' }),
      executable: steps.every((s) => !s.problems.length),
      pricedAt: '2026-08-22T15:31:00Z',
      classes: [
        { name: 'US Stock', beforeFraction: fraction('0.5', '50.0%'), afterFraction: fraction('0.6', '60.0%'), targetFraction: fraction('0.6', '60.0%'), before: money('2250', { display: '$2,250.00' }), after: money('3300', { display: '$3,300.00' }), delta: money('0', { display: '$0.00' }) },
        { name: 'Cash', beforeFraction: fraction('0.5', '50.0%'), afterFraction: fraction('0.4', '40.0%'), before: money('2250', { display: '$2,250.00' }), after: money('2200', { display: '$2,200.00' }) },
      ],
      accounts: [
        { accountId: 2n, brokerName: 'Vanguard', name: 'Roth IRA', taxDeferred: true, sweepBefore: money('55.25', { display: '$55.25' }), sweepAfter: money('655.25', { display: '$655.25' }), valueBefore: money('1000', { display: '$1,000.00' }), valueAfter: money('2000', { display: '$2,000.00' }) },
      ],
    }),
  });
}

describe('PlansPage', () => {
  let restoreApi: () => void;
  let listRequests: boolean[];
  let created: string[];

  beforeEach(() => {
    listRequests = [];
    created = [];
    restoreApi = installFakeApi(({ service }) => {
      service(TradingPlanService, {
        listPlans: (request) => {
          listRequests.push(request.includeArchived);
          const open = [summary({ planId: 7n, name: 'Autumn rebalance', stepCount: 2 })];
          const archived = [summary({ planId: 3n, name: 'Spring', status: PlanStatus.PLAN_ARCHIVED, lastPrintedAt: '2026-04-01T10:00:00Z' })];
          return { plans: request.includeArchived ? [...open, ...archived] : open };
        },
        createPlan: (request) => {
          created.push(request.name);
          return { plan: samplePlan([]) };
        },
      });
    });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideRouter([])] });
  });

  afterEach(() => restoreApi());

  async function render() {
    const fixture = TestBed.createComponent(PlansPage);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: unknown }): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function rows(fixture: { nativeElement: unknown }): string[][] {
    return Array.from(host(fixture).querySelectorAll('tr[mat-row]'), (row) =>
      Array.from(row.querySelectorAll('td'), (c) => c.textContent!.replace(/\s+/g, ' ').trim()),
    );
  }

  it('lists open plans, newest first, and reveals archived ones on the toggle', async () => {
    const fixture = await render();
    expect(listRequests).toEqual([false]);
    expect(rows(fixture)).toEqual([['Autumn rebalance', '2', '2026-08-22 15:30:00', '']]);
    expect(host(fixture).querySelector('td a')!.getAttribute('href')).toBe('/allocation/plans/7');

    host(fixture).querySelector<HTMLElement>('mat-slide-toggle button')!.click();
    await settle(fixture);
    expect(listRequests).toEqual([false, true]);
    expect(rows(fixture)[1]).toEqual(['Spring(archived)', '0', '2026-08-22 15:30:00', '2026-04-01 10:00:00']);
  });

  it('creates a plan from the name box and opens it', async () => {
    const fixture = await render();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const success = vi.spyOn(TestBed.inject(Notify), 'success');
    const input = host(fixture).querySelector<HTMLInputElement>('input[matInput]')!;
    input.value = '  Winter  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
    Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent!.includes('Create'))!.click();
    await settle(fixture);
    expect(created).toEqual(['Winter']);
    expect(success).toHaveBeenCalledWith('Winter created');
    expect(navigate).toHaveBeenCalledWith(['/allocation/plans', 7n]);
  });
});

describe('PlanPage', () => {
  let restoreApi: () => void;
  let plan: Plan;
  let setRequests: PlanStepInput[][];
  let printed: bigint[];
  let statusRequests: PlanStatus[];

  beforeEach(() => {
    plan = samplePlan();
    setRequests = [];
    printed = [];
    statusRequests = [];
    restoreApi = installFakeApi(({ service }) => {
      service(TradingPlanService, {
        getPlan: () => ({ plan }),
        setPlanSteps: (request) => {
          setRequests.push(request.steps);
          return { plan };
        },
        markPlanPrinted: (request) => {
          printed.push(request.planId);
          return { summary: summary({ stepCount: 2, lastPrintedAt: '2026-08-22T16:00:00Z' }) };
        },
        setPlanStatus: (request) => {
          statusRequests.push(request.status);
          return {};
        },
        deletePlan: () => ({}),
      });
      service(AccountService, { listAccounts: () => ({ accounts: sampleAccounts() }) });
      service(SecurityService, { listSecurities: () => ({ securities: sampleAllSecurities() }) });
    });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideRouter([])] });
    vi.stubGlobal('print', vi.fn());
  });

  afterEach(() => {
    restoreApi();
    vi.unstubAllGlobals();
  });

  async function render(id = '7') {
    const fixture = TestBed.createComponent(PlanPage);
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function host(fixture: { nativeElement: HTMLElement }): HTMLElement {
    return fixture.nativeElement;
  }

  function text(fixture: { nativeElement: HTMLElement }): string {
    return host(fixture).textContent!.replace(/\s+/g, ' ');
  }

  function dialogOf(fixture: { debugElement: { injector: { get(t: unknown): unknown } } }): MatDialog {
    return fixture.debugElement.injector.get(MatDialog) as MatDialog;
  }

  /** The value under the readonly stat whose label is `label`. */
  function statValue(fixture: { nativeElement: HTMLElement }, label: string): string {
    const stat = Array.from(host(fixture).querySelectorAll('.readonly-stat')).find(
      (s) => s.querySelector('.stat-label')?.textContent?.trim() === label,
    );
    return stat?.querySelector('.stat-value')?.textContent?.trim() ?? '';
  }

  /** A toolbar step button by its label (the mat-icon ligature text precedes it). */
  function stepButton(fixture: { nativeElement: HTMLElement }, label: string): HTMLButtonElement {
    const found = Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('.controls-row button')).find(
      (b) => b.textContent!.replace(/\s+/g, ' ').trim().endsWith(label),
    );
    if (!found) throw new Error(`no step button ${label}`);
    return found;
  }

  it('renders the totals, the allocation before and after, the steps, and the accounts', async () => {
    const fixture = await render();
    const t = text(fixture);
    expect(t).toContain('Autumn rebalance');
    expect(t).toContain('$4,500.00');
    expect(t).toContain('$5,500.00');
    expect(statValue(fixture, 'Executable as written')).toBe('Yes');
    expect(t).toContain('US Stock');
    expect(t).toContain('50.0%');
    expect(t).toContain('60.0%');
    expect(t).toContain('Add from outside');
    expect(t).toContain('VTI');
    expect(t).toContain('Roth IRA');
    expect(t).toContain('$655.25');
    expect(t).toContain('finance2 does not execute trades');
    // The printed checklist groups steps by account.
    expect(host(fixture).querySelectorAll('.checklist li')).toHaveLength(2);
    expect(host(fixture).querySelector('.checklist h4')!.textContent).toContain('Roth IRA');
  });

  it('shows a problem on its step and marks the plan not executable', async () => {
    plan = samplePlan([step(1, { kind: StepKind.STEP_DRAW_EXTERNAL, amount: decimal('5000') }, { problems: ['Roth IRA sweep would be ($4,944.75)'] })]);
    const fixture = await render();
    expect(statValue(fixture, 'Executable as written')).toBe('No - see steps');
    expect(text(fixture)).toContain('Roth IRA sweep would be');
    expect(host(fixture).querySelector('tr.has-problem')).not.toBeNull();
  });

  it('adding a step sends every step back in order and announces it', async () => {
    const fixture = await render();
    const added = create(PlanStepInputSchema, { kind: StepKind.STEP_SELL, accountId: 1n, securityId: 1n, shares: decimal('3') });
    const open = vi.spyOn(dialogOf(fixture), 'open').mockReturnValue({ afterClosed: () => of(added) } as never);
    const success = vi.spyOn(TestBed.inject(Notify), 'success');
    stepButton(fixture, 'Sell').click();
    await settle(fixture);
    const [component, config] = open.mock.calls[0] as [unknown, { data: PlanStepDialogData }];
    expect(component).toBe(PlanStepDialog);
    expect(config.data.kind).toBe(StepKind.STEP_SELL);
    expect(config.data.className).toBeUndefined();
    expect(setRequests).toHaveLength(1);
    expect(setRequests[0].map((s) => s.kind)).toEqual([StepKind.STEP_ADD_EXTERNAL, StepKind.STEP_BUY, StepKind.STEP_SELL]);
    expect(success).toHaveBeenCalledWith('Step added');
  });

  it('Sell... on a class row opens the dialog with that class for the picker', async () => {
    const fixture = await render();
    const open = vi.spyOn(dialogOf(fixture), 'open').mockReturnValue({ afterClosed: () => of(undefined) } as never);
    host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Sell from US Stock"]')!.click();
    await settle(fixture);
    const config = open.mock.calls[0][1] as { data: PlanStepDialogData };
    expect(config.data.className).toBe('US Stock');
    expect(config.data.kind).toBe(StepKind.STEP_SELL);
    expect(setRequests).toEqual([]); // dismissed: nothing saved
  });

  it('moves, removes, and edits steps by replacing the ordered list', async () => {
    const fixture = await render();
    host(fixture).querySelectorAll<HTMLButtonElement>('button[aria-label="Move down"]')[0].click();
    await settle(fixture);
    expect(setRequests[0].map((s) => s.kind)).toEqual([StepKind.STEP_BUY, StepKind.STEP_ADD_EXTERNAL]);
    host(fixture).querySelectorAll<HTMLButtonElement>('button[aria-label="Remove step"]')[1].click();
    await settle(fixture);
    expect(setRequests[1].map((s) => s.kind)).toEqual([StepKind.STEP_ADD_EXTERNAL]);
    const edited = create(PlanStepInputSchema, { kind: StepKind.STEP_ADD_EXTERNAL, accountId: 2n, amount: decimal('2000'), note: 'Q3 doubled' });
    vi.spyOn(dialogOf(fixture), 'open').mockReturnValue({ afterClosed: () => of(edited) } as never);
    host(fixture).querySelectorAll<HTMLButtonElement>('button[aria-label="Edit step"]')[0].click();
    await settle(fixture);
    expect(setRequests[2][0].note).toBe('Q3 doubled');
    expect(setRequests[2]).toHaveLength(2);
  });

  it('printing stamps the plan first, then prints', async () => {
    const fixture = await render();
    host(fixture).querySelector<HTMLButtonElement>('button[aria-label="Print plan"]')!.click();
    await settle(fixture);
    expect(printed).toEqual([7n]);
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(text(fixture)).toContain('Last printed 2026-08-22 16:00:00');
  });

  it('an archived plan disables every editing control and offers Reopen', async () => {
    plan = { ...samplePlan(), summary: summary({ status: PlanStatus.PLAN_ARCHIVED, stepCount: 2 }) };
    const fixture = await render();
    expect(text(fixture)).toContain('archived');
    const editing = Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('button[aria-label="Edit step"], button[aria-label="Sell from US Stock"]'));
    expect(editing.length).toBeGreaterThan(0);
    expect(editing.every((b) => b.disabled)).toBe(true);
  });
});

describe('PlanStepDialog', () => {
  let restoreApi: () => void;
  let closed: unknown[];
  let sellRequests: { className: string; order: SellOrder }[];
  let candidates: SellCandidate[];

  beforeEach(() => {
    closed = [];
    sellRequests = [];
    candidates = [
      create(SellCandidateSchema, {
        accountId: 2n, accountName: 'Roth IRA', taxDeferred: true, securityId: 1n, ticker: 'VTI',
        classWeight: fraction('1', '100%'), held: fraction('12', '12'), valueInClass: money('2400', { display: '$2,400.00' }),
        planPrice: money('200', { display: '$200.00' }),
      }),
      create(SellCandidateSchema, {
        accountId: 1n, accountName: 'Brokerage', taxDeferred: false, securityId: 1n, ticker: 'VTI',
        classWeight: fraction('1', '100%'), held: fraction('50', '50'), valueInClass: money('10000', { display: '$10,000.00' }),
        planPrice: money('200', { display: '$200.00' }),
        estShortTermGain: money('100', { display: '$100.00' }), estLongTermGain: money('1500', { display: '$1,500.00' }),
        gainPerDollar: fraction('0.16', '+16.0%'), nextLongTermDate: date('2026-09-10'),
      }),
    ];
    restoreApi = installFakeApi(({ service }) => {
      service(TradingPlanService, {
        getSellCandidates: (request) => {
          sellRequests.push({ className: request.className, order: request.order });
          return { candidates, orderCaption: 'Ordered by tax consequence: ...' };
        },
        getBuyCandidates: () => ({ candidates: [] }),
      });
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: MatDialogRef, useValue: { close: (v: unknown) => closed.push(v) } },
      ],
    });
  });

  afterEach(() => restoreApi());

  async function render(data: PlanStepDialogData) {
    TestBed.overrideProvider(MAT_DIALOG_DATA, { useValue: data });
    const fixture = TestBed.createComponent(PlanStepDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  const base = () => ({ accounts: sampleAccounts(), securities: sampleAllSecurities() });

  it('a sell from a class shows the candidates with the stated order, then the form once one is picked', async () => {
    const fixture = await render({ kind: StepKind.STEP_SELL, className: 'US Stock', ...base() });
    const host = fixture.nativeElement as HTMLElement;
    expect(sellRequests).toEqual([{ className: 'US Stock', order: SellOrder.TAX_COST }]);
    const t = host.textContent!.replace(/\s+/g, ' ');
    expect(t).toContain('Ordered by tax consequence');
    expect(t).toContain('no tax on sale');
    expect(t).toContain('+16.0%');
    expect(t).toContain('long-term from 2026-09-10');
    expect(host.querySelector('mat-select[required]')).toBeNull(); // no form yet

    host.querySelector<HTMLButtonElement>('button[aria-label="Sell VTI in Brokerage"]')!.click();
    await settle(fixture);
    expect(fixture.componentInstance.accountId).toBe(1n);
    expect(fixture.componentInstance.securityId).toBe(1n);
    expect(host.querySelector('.candidates')).toBeNull();
    expect(host.textContent).toContain('Enter by');
  });

  it('submits a complete trade step as a PlanStepInput with shares or amount, never both', async () => {
    const fixture = await render({ kind: StepKind.STEP_BUY, ...base() });
    const c = fixture.componentInstance;
    c.accountId = 2n;
    c.securityId = 1n;
    c.entry = 'shares';
    c.shares = ' 3 ';
    c.note = ' two lots ';
    expect(c.complete()).toBe(true);
    c.submit();
    const step = closed[0] as PlanStepInput;
    expect(step.kind).toBe(StepKind.STEP_BUY);
    expect(step.accountId).toBe(2n);
    expect(step.securityId).toBe(1n);
    expect(step.shares?.value).toBe('3');
    expect(step.amount).toBeUndefined();
    expect(step.note).toBe('two lots');
  });

  it('a transfer needs a different destination account', async () => {
    const transfer = await render({ kind: StepKind.STEP_TRANSFER, ...base() });
    transfer.componentInstance.accountId = 1n;
    transfer.componentInstance.toAccountId = 1n;
    transfer.componentInstance.amount = '100';
    expect(transfer.componentInstance.complete()).toBe(false);
    transfer.componentInstance.toAccountId = 2n;
    expect(transfer.componentInstance.complete()).toBe(true);
  });

  it('a draw needs only an account and a positive amount', async () => {
    const draw = await render({ kind: StepKind.STEP_DRAW_EXTERNAL, ...base() });
    draw.componentInstance.accountId = 2n;
    draw.componentInstance.amount = '-5';
    expect(draw.componentInstance.complete()).toBe(false);
    draw.componentInstance.amount = '300';
    expect(draw.componentInstance.complete()).toBe(true);
    draw.componentInstance.submit();
    const step = closed.at(-1) as PlanStepInput;
    expect(step.kind).toBe(StepKind.STEP_DRAW_EXTERNAL);
    expect(step.amount?.value).toBe('300');
    expect(step.securityId).toBe(0n);
  });
});
