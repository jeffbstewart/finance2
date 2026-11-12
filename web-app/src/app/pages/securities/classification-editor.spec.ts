// Unit spec for ClassificationEditor (docs/design/ui-testing.md,
// inventory "SecurityDetailsPage -> ClassificationEditor"). The editor
// is a child component driven by a required `security` input, so the
// specs set the input directly rather than rendering the host page - 
// SecurityDetailsPage is a separate assignment. AllocationService and
// SecurityService are faked via installFakeApi; the clock is pinned so
// the save payload's `asOf: todayCivil()` is deterministic.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AllocationService,
  ClassAllocationSchema,
  GetAllocationResponseSchema,
  type GetAllocationResponse,
} from '../../../proto-gen/allocation_pb';
import {
  ClassificationSetSchema,
  SecurityProfileSchema,
  SecurityService,
  SecurityType,
  PricingLocus,
  TaxTreatment,
  type SetClassificationRequest,
  type SecurityProfile,
} from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { PieChartStub } from '../../../testing/chart-stubs';
import { civil, fraction } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { PieChart } from '../../shared/charts/pie-chart';
import { ClassificationEditor } from './classification-editor';

/** The seeder's five asset classes, in `asset_classes.display_order`
 *  (V004__reference_data.sql). Shared-infrastructure gap: sample-data.ts
 *  has no allocation/security-profile builders yet, so they live here. */
const CLASS_NAMES = ['Cash', 'US Stock', 'Non US Stock', 'Bond', 'Other'];

function sampleAllocation(names: string[] = CLASS_NAMES): GetAllocationResponse {
  return create(GetAllocationResponseSchema, {
    targetSet: true,
    classes: names.map((name) => create(ClassAllocationSchema, { name })),
  });
}

/** VTI as the seeder classifies it: 100% US Stock, stamped 30 days ago
 *  (fresh, so no refresh chip). */
function vtiProfile(
  overrides: {
    weights?: Record<string, ReturnType<typeof fraction>>;
    asOf?: string;
    refreshSuggested?: boolean;
    classifications?: 'none';
  } = {},
): SecurityProfile {
  const base = {
    securityId: 1n,
    ticker: 'VTI',
    description: 'Total Market ETF',
    currencyCode: 'USD',
    securityType: SecurityType.ETF,
    pricingLocus: PricingLocus.MARKET,
    taxTreatment: TaxTreatment.LOTS,
  };
  if (overrides.classifications === 'none') {
    return create(SecurityProfileSchema, base);
  }
  return create(SecurityProfileSchema, {
    ...base,
    classifications: [
      create(ClassificationSetSchema, {
        kind: 'ASSET_CLASS',
        asOf: civil(overrides.asOf ?? '2026-07-21'),
        refreshSuggested: overrides.refreshSuggested ?? false,
        weights: overrides.weights ?? { 'US Stock': fraction('1', '100%') },
      }),
    ],
  });
}

interface SavedRequest {
  securityId: bigint;
  kind: string;
  weights: Record<string, string>;
  asOf: string;
}

function savedOf(request: SetClassificationRequest): SavedRequest {
  const asOf = request.asOf;
  return {
    securityId: request.securityId,
    kind: request.kind,
    weights: Object.fromEntries(
      Object.entries(request.weights).map(([name, d]) => [name, d.value]),
    ),
    asOf: asOf
      ? `${asOf.year}-${String(asOf.month).padStart(2, '0')}-${String(asOf.day).padStart(2, '0')}`
      : '',
  };
}

describe('ClassificationEditor', () => {
  let restoreApi: () => void;
  let allocationCalls: number;
  let saved: SavedRequest[];
  let allocationResponds: () => GetAllocationResponse;
  let saveResponds: () => void;

  beforeEach(() => {
    // Only Date is faked: settle() relies on real setTimeout.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 7, 21));
    allocationCalls = 0;
    saved = [];
    allocationResponds = () => sampleAllocation();
    saveResponds = () => {};
    restoreApi = installFakeApi(({ service }) => {
      service(AllocationService, {
        getAllocation: () => {
          allocationCalls++;
          return allocationResponds();
        },
      });
      service(SecurityService, {
        setClassification: (request) => {
          saveResponds();
          saved.push(savedOf(request));
          return {};
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    TestBed.overrideComponent(ClassificationEditor, {
      remove: { imports: [PieChart] },
      add: { imports: [PieChartStub] },
    });
  });

  afterEach(() => {
    restoreApi();
    vi.useRealTimers();
  });

  async function render(security = vtiProfile()) {
    const fixture = TestBed.createComponent(ClassificationEditor);
    fixture.componentRef.setInput('security', security);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  function textOf(fixture: ComponentFixture<ClassificationEditor>): string {
    return (fixture.nativeElement as HTMLElement).textContent!;
  }

  function pieStub(fixture: ComponentFixture<ClassificationEditor>): PieChartStub | null {
    const el = fixture.debugElement.query((node) => node.componentInstance instanceof PieChartStub);
    return el ? (el.componentInstance as PieChartStub) : null;
  }

  /** The button whose label contains `text` (mat-icon text is inside
   *  the button too, so match on contains, not equality). */
  function buttonFor(
    fixture: ComponentFixture<ClassificationEditor>,
    text: string,
  ): HTMLButtonElement {
    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((b) => b.textContent!.includes(text));
    if (!button) throw new Error(`no button labelled ${text}`);
    return button;
  }

  /** The weight input for a class, located by its mat-label ("Bond %"). */
  function weightInput(
    fixture: ComponentFixture<ClassificationEditor>,
    name: string,
  ): HTMLInputElement {
    const field = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('mat-form-field'),
    ).find((f) => f.querySelector('mat-label')?.textContent?.trim() === `${name} %`);
    const input = field?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error(`no weight field for ${name}`);
    return input;
  }

  function weightLabels(fixture: ComponentFixture<ClassificationEditor>): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('mat-form-field mat-label'),
      (label) => label.textContent!.trim(),
    );
  }

  function weightValues(fixture: ComponentFixture<ClassificationEditor>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const label of weightLabels(fixture)) {
      const name = label.replace(/ %$/, '');
      out[name] = weightInput(fixture, name).value;
    }
    return out;
  }

  /** Types into a weight field the way a user does, so ngModelChange
   *  fires the validator - assigning `row.percent` never re-renders
   *  under zoneless and never revalidates. */
  async function typeWeight(
    fixture: ComponentFixture<ClassificationEditor>,
    name: string,
    value: string,
  ): Promise<void> {
    const input = weightInput(fixture, name);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
  }

  function validationError(fixture: ComponentFixture<ClassificationEditor>): string | null {
    const el = (fixture.nativeElement as HTMLElement).querySelector('.validation-error');
    return el ? el.textContent!.trim() : null;
  }

  async function beginEdit(fixture: ComponentFixture<ClassificationEditor>): Promise<void> {
    buttonFor(fixture, 'Edit Asset Class Weights').click();
    await settle(fixture);
  }

  describe('view mode', () => {
    it('renders the mix as pie slices with the as-of stamp', async () => {
      const fixture = await render(
        vtiProfile({
          weights: {
            'US Stock': fraction('0.6', '60%'),
            Bond: fraction('0.4', '40%'),
          },
          asOf: '2026-07-21',
        }),
      );
      const slices = pieStub(fixture)!.slices();
      expect(slices.map((s) => s.name).sort()).toEqual(['Bond', 'US Stock']);
      const usStock = slices.find((s) => s.name === 'US Stock')!;
      expect(usStock.id).toBe('US Stock');
      expect(usStock.value).toBe(0.6);
      expect(usStock.display).toBe('60%');
      expect(textOf(fixture)).toContain('As of 2026-07-21');
      expect(textOf(fixture)).not.toContain('refresh suggested');
      expect(allocationCalls).toBe(0); // class names are fetched only on edit
    });

    it('zero-pads a single-digit month and day in the as-of stamp', async () => {
      const fixture = await render(vtiProfile({ asOf: '2026-01-05' }));
      expect(textOf(fixture)).toContain('As of 2026-01-05');
    });

    it('drops zero-weight classes from the pie', async () => {
      const fixture = await render(
        vtiProfile({
          weights: {
            'US Stock': fraction('1', '100%'),
            Bond: fraction('0', '0%'),
          },
        }),
      );
      expect(pieStub(fixture)!.slices().map((s) => s.name)).toEqual(['US Stock']);
    });

    it('shows the refresh chip for a stale mix (the seeder GOLD case)', async () => {
      const fixture = await render(
        vtiProfile({
          weights: { Other: fraction('1', '100%') },
          asOf: '2025-06-16',
          refreshSuggested: true,
        }),
      );
      expect(textOf(fixture)).toContain('refresh suggested');
      expect(fixture.nativeElement.querySelector('.refresh-chip')).toBeTruthy();
    });

    it('shows the empty note instead of a pie when nothing is classified', async () => {
      const fixture = await render(vtiProfile({ classifications: 'none' }));
      expect(pieStub(fixture)).toBeNull();
      expect(textOf(fixture)).toContain('No asset class mix yet - enter the weights to the right.');
      expect(textOf(fixture)).not.toContain('As of');
    });

    it('ignores classification sets of other kinds', async () => {
      const security = create(SecurityProfileSchema, {
        securityId: 1n,
        ticker: 'VTI',
        classifications: [
          create(ClassificationSetSchema, {
            kind: 'SECTOR',
            asOf: civil('2026-07-21'),
            weights: { Technology: fraction('1', '100%') },
          }),
        ],
      });
      const fixture = await render(security);
      expect(pieStub(fixture)).toBeNull();
      expect(textOf(fixture)).toContain('No asset class mix yet');
    });
  });

  describe('entering edit mode', () => {
    it('fetches the class names and prefills the current weights', async () => {
      const fixture = await render(
        vtiProfile({ weights: { 'US Stock': fraction('0.75', '75%'), Bond: fraction('0.25', '25%') } }),
      );
      await beginEdit(fixture);
      expect(allocationCalls).toBe(1);
      expect(weightLabels(fixture)).toEqual([
        'Cash %',
        'US Stock %',
        'Non US Stock %',
        'Bond %',
        'Other %',
      ]);
      expect(weightValues(fixture)).toEqual({
        Cash: '0',
        'US Stock': '75',
        'Non US Stock': '0',
        Bond: '25',
        Other: '0',
      });
      expect(validationError(fixture)).toBeNull();
    });

    it('appends classified names the allocation no longer lists', async () => {
      allocationResponds = () => sampleAllocation(['Cash', 'US Stock']);
      const fixture = await render(
        vtiProfile({ weights: { 'US Stock': fraction('0.5', '50%'), Retired: fraction('0.5', '50%') } }),
      );
      await beginEdit(fixture);
      expect(weightLabels(fixture)).toEqual(['Cash %', 'US Stock %', 'Retired %']);
      expect(weightValues(fixture)['Retired']).toBe('50');
    });

    it('starts every row at 0 for an unclassified security', async () => {
      const fixture = await render(vtiProfile({ classifications: 'none' }));
      await beginEdit(fixture);
      expect(Object.values(weightValues(fixture))).toEqual(['0', '0', '0', '0', '0']);
    });

    it('routes a getAllocation failure to the error snackbar and stays in view mode', async () => {
      const notify = TestBed.inject(Notify);
      const errorSpy = vi.spyOn(notify, 'error');
      allocationResponds = () => {
        throw new ConnectError('allocation unavailable', Code.Unavailable);
      };
      const fixture = await render();
      await beginEdit(fixture);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe('allocation unavailable');
      expect(fixture.componentInstance.editing()).toBe(false);
      expect(weightLabels(fixture)).toEqual([]);
      expect(textOf(fixture)).toContain('Edit Asset Class Weights');
    });

    it('cancel returns to view mode without saving', async () => {
      const fixture = await render();
      await beginEdit(fixture);
      await typeWeight(fixture, 'Bond', '100');
      buttonFor(fixture, 'Cancel').click();
      await settle(fixture);
      expect(fixture.componentInstance.editing()).toBe(false);
      expect(saved).toEqual([]);
      expect(textOf(fixture)).toContain('Edit Asset Class Weights');
    });
  });

  describe('validation', () => {
    async function edit() {
      const fixture = await render();
      await beginEdit(fixture);
      return fixture;
    }

    it('rejects a non-numeric entry with the per-class message', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'Bond', 'abc');
      expect(validationError(fixture)).toBe('Bond: enter a number between 0 and 100');
      expect(buttonFor(fixture, 'Save').disabled).toBe(true);
    });

    it('rejects a negative entry as non-numeric (the pattern excludes signs)', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'Bond', '-5');
      expect(validationError(fixture)).toBe('Bond: enter a number between 0 and 100');
    });

    it('rejects an empty entry', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'US Stock', '');
      expect(validationError(fixture)).toBe('US Stock: enter a number between 0 and 100');
    });

    it('rejects more than two decimal places', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'US Stock', '99.999');
      expect(validationError(fixture)).toBe('US Stock: at most two decimal places');
    });

    it('accepts exactly two decimal places', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'US Stock', '66.67');
      await typeWeight(fixture, 'Bond', '33.33');
      expect(validationError(fixture)).toBeNull();
      expect(buttonFor(fixture, 'Save').disabled).toBe(false);
    });

    it('rejects a value over 100', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'US Stock', '150');
      expect(validationError(fixture)).toBe('US Stock: must be between 0 and 100');
    });

    it('reports the sum with the running total when the weights miss 100', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'US Stock', '60');
      expect(validationError(fixture)).toBe('Weights must sum to 100 (currently 60)');
      await typeWeight(fixture, 'Bond', '30');
      expect(validationError(fixture)).toBe('Weights must sum to 100 (currently 90)');
      await typeWeight(fixture, 'Non US Stock', '10');
      expect(validationError(fixture)).toBeNull();
    });

    it('tolerates a +/-0.01 rounding drift but not +/-0.02', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'US Stock', '99.99');
      expect(validationError(fixture)).toBeNull();
      await typeWeight(fixture, 'US Stock', '99.98');
      expect(validationError(fixture)).toBe('Weights must sum to 100 (currently 99.98)');

      // Overshoot has to be spread across rows: the per-class 0-100
      // bound runs first, so a single 100.01 row never reaches the sum
      // check (see the dedicated case below).
      await typeWeight(fixture, 'US Stock', '50.01');
      await typeWeight(fixture, 'Bond', '50');
      expect(validationError(fixture)).toBeNull();
      await typeWeight(fixture, 'US Stock', '50.02');
      expect(validationError(fixture)).toBe('Weights must sum to 100 (currently 100.02)');
    });

    it('applies the 0-100 bound before the sum tolerance, so 100.01 in one row fails', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'US Stock', '100.01');
      expect(validationError(fixture)).toBe('US Stock: must be between 0 and 100');
    });

    it('reports the first offending row, per-class errors before the sum', async () => {
      const fixture = await edit();
      await typeWeight(fixture, 'Cash', 'x');
      await typeWeight(fixture, 'Bond', 'y');
      expect(validationError(fixture)).toBe('Cash: enter a number between 0 and 100');
    });

    it('validates only on ngModelChange - a Save click revalidates a never-touched form', async () => {
      // The editor seeds `validationError` to null on beginEdit and only
      // recomputes it in revalidate() (ngModelChange), so an unclassified
      // security opens with all-zero rows and an *enabled* Save button.
      // Clicking it validates, blocks the write, and shows the message.
      const fixture = await render(vtiProfile({ classifications: 'none' }));
      await beginEdit(fixture);
      expect(validationError(fixture)).toBeNull();
      expect(buttonFor(fixture, 'Save').disabled).toBe(false);
      buttonFor(fixture, 'Save').click();
      await settle(fixture);
      expect(saved).toEqual([]);
      expect(validationError(fixture)).toBe('Weights must sum to 100 (currently 0)');
      expect(fixture.componentInstance.editing()).toBe(true);
    });
  });

  describe('saving', () => {
    it('writes the fractions, drops zero rows, and stamps today', async () => {
      const fixture = await render();
      await beginEdit(fixture);
      await typeWeight(fixture, 'US Stock', '60');
      await typeWeight(fixture, 'Non US Stock', '20');
      await typeWeight(fixture, 'Bond', '20');
      buttonFor(fixture, 'Save').click();
      await settle(fixture);
      expect(saved).toEqual([
        {
          securityId: 1n,
          kind: 'ASSET_CLASS',
          weights: { 'US Stock': '0.6', 'Non US Stock': '0.2', Bond: '0.2' },
          asOf: '2026-08-21',
        },
      ]);
      // Cash and Other stayed at 0 and never reach the wire.
      expect(Object.keys(saved[0].weights)).not.toContain('Cash');
      expect(Object.keys(saved[0].weights)).not.toContain('Other');
    });

    it('sends exact decimal shifts, never float division', async () => {
      const fixture = await render();
      await beginEdit(fixture);
      await typeWeight(fixture, 'US Stock', '33.33');
      await typeWeight(fixture, 'Non US Stock', '33.33');
      await typeWeight(fixture, 'Bond', '33.34');
      buttonFor(fixture, 'Save').click();
      await settle(fixture);
      expect(saved[0].weights).toEqual({
        'US Stock': '0.3333',
        'Non US Stock': '0.3333',
        Bond: '0.3334',
      });
    });

    it('notifies, leaves edit mode, and emits saved on success', async () => {
      const notify = TestBed.inject(Notify);
      const successSpy = vi.spyOn(notify, 'success');
      const fixture = await render();
      const savedEvents: void[] = [];
      fixture.componentInstance.saved.subscribe(() => savedEvents.push(undefined));
      await beginEdit(fixture);
      await typeWeight(fixture, 'US Stock', '100');
      buttonFor(fixture, 'Save').click();
      await settle(fixture);
      expect(successSpy).toHaveBeenCalledWith('Asset class mix saved');
      expect(savedEvents).toHaveLength(1);
      expect(fixture.componentInstance.editing()).toBe(false);
      expect(fixture.componentInstance.busy()).toBe(false);
      expect(textOf(fixture)).toContain('Edit Asset Class Weights');
    });

    it('routes a server rejection to the error snackbar and keeps the form open', async () => {
      const notify = TestBed.inject(Notify);
      const errorSpy = vi.spyOn(notify, 'error');
      const fixture = await render();
      const savedEvents: void[] = [];
      fixture.componentInstance.saved.subscribe(() => savedEvents.push(undefined));
      await beginEdit(fixture);
      await typeWeight(fixture, 'US Stock', '100');
      saveResponds = () => {
        throw new ConnectError('weights must sum to 1', Code.InvalidArgument);
      };
      buttonFor(fixture, 'Save').click();
      await settle(fixture);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect((errorSpy.mock.calls[0][0] as ConnectError).rawMessage).toBe('weights must sum to 1');
      expect(savedEvents).toEqual([]);
      expect(fixture.componentInstance.editing()).toBe(true);
      expect(fixture.componentInstance.busy()).toBe(false);
      expect(weightValues(fixture)['US Stock']).toBe('100'); // entries survive
    });

    it('saves an all-cash mix for a previously unclassified security', async () => {
      const fixture = await render(vtiProfile({ classifications: 'none' }));
      await beginEdit(fixture);
      await typeWeight(fixture, 'Cash', '100');
      buttonFor(fixture, 'Save').click();
      await settle(fixture);
      expect(saved[0].weights).toEqual({ Cash: '1' });
    });
  });

  describe('parent reload', () => {
    it('a new security input forces view mode, dropping stale rows', async () => {
      const fixture = await render();
      await beginEdit(fixture);
      await typeWeight(fixture, 'Bond', '100');
      expect(fixture.componentInstance.editing()).toBe(true);

      // What SecurityDetailsPage.reload() does after (saved) fires.
      fixture.componentRef.setInput(
        'security',
        vtiProfile({ weights: { Bond: fraction('1', '100%') } }),
      );
      await settle(fixture);
      expect(fixture.componentInstance.editing()).toBe(false);
      expect(weightLabels(fixture)).toEqual([]);
      expect(pieStub(fixture)!.slices().map((s) => s.name)).toEqual(['Bond']);
    });
  });
});
