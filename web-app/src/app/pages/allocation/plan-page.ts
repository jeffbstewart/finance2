import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import type { AccountSummary } from '../../../proto-gen/accounts_pb';
import type { SecurityListing } from '../../../proto-gen/securities_pb';
import {
  PlanStatus,
  StepKind,
  type ClassProjection,
  type Plan,
  type PlanStep,
  type PlanStepInput,
} from '../../../proto-gen/trading_plan_pb';
import { api } from '../../core/api';
import { Notify } from '../../core/notify';
import { PlanStepDialog, type PlanStepDialogData } from './plan-step-dialog';

const KIND_LABELS: Record<StepKind, string> = {
  [StepKind.STEP_KIND_UNSPECIFIED]: '',
  [StepKind.STEP_BUY]: 'Buy',
  [StepKind.STEP_SELL]: 'Sell',
  [StepKind.STEP_TRANSFER]: 'Transfer',
  [StepKind.STEP_ADD_EXTERNAL]: 'Add from outside',
  [StepKind.STEP_DRAW_EXTERNAL]: 'Draw to outside',
};

/**
 * One trading plan (docs/design/trading-plan.md): the steps the human
 * composed, in order, and the projection of the portfolio after them -
 * Before / After / Target per class, per-account sweeps and values, the
 * cash in and out, and whether the plan is executable as written. Every
 * edit replaces the steps on the server and re-scores at current
 * prices. Printing is the browser's; the print stylesheet lays the
 * whole plan out as one document. finance2 never executes anything.
 */
@Component({
  selector: 'app-plan-page',
  imports: [
    MatButtonModule,
    MatCardModule,
    MatDialogModule,
    MatIconModule,
    MatMenuModule,
    MatTableModule,
    MatTooltipModule,
    RouterLink,
  ],
  templateUrl: './plan-page.html',
  styleUrl: './plan-page.scss',
})
export class PlanPage {
  /** Router param (withComponentInputBinding). */
  readonly id = input.required<string>();

  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);

  readonly plan = signal<Plan | undefined>(undefined);
  readonly accounts = signal<AccountSummary[]>([]);
  readonly securities = signal<SecurityListing[]>([]);
  readonly busy = signal(false);

  readonly StepKind = StepKind;
  readonly PlanStatus = PlanStatus;
  readonly stepColumns = ['position', 'kind', 'account', 'security', 'shares', 'amount', 'price', 'gain', 'note', 'actions'];
  readonly classColumns = ['name', 'before', 'after', 'target', 'delta', 'actions'];
  readonly accountColumns = ['account', 'sweepBefore', 'sweepAfter', 'valueBefore', 'valueAfter'];

  readonly projection = computed(() => this.plan()?.projection);
  readonly summary = computed(() => this.plan()?.summary);
  readonly archived = computed(() => this.summary()?.status === PlanStatus.PLAN_ARCHIVED);
  readonly steps = computed<PlanStep[]>(() => this.projection()?.steps ?? []);
  /** Steps grouped by account in execution order, for the printed checklist. */
  readonly stepsByAccount = computed(() => {
    const groups = new Map<string, PlanStep[]>();
    for (const s of this.steps()) {
      const key = s.accountName || '(unknown account)';
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    return Array.from(groups, ([account, steps]) => ({ account, steps }));
  });

  private get planId(): bigint {
    return BigInt(this.id());
  }

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const [plan, accounts, securities] = await Promise.all([
        api.plans.getPlan({ planId: this.planId }),
        api.accounts.listAccounts({}),
        api.securities.listSecurities({}),
      ]);
      this.plan.set(plan.plan);
      this.accounts.set(accounts.accounts);
      this.securities.set(securities.securities);
    } catch (err) {
      this.notify.error(err);
    }
  }

  kindLabel(step: PlanStep): string {
    return KIND_LABELS[step.input?.kind ?? StepKind.STEP_KIND_UNSPECIFIED];
  }

  /** "Roth IRA" or "Brokerage -> Roth IRA" for a transfer. */
  accountLabel(step: PlanStep): string {
    return step.toAccountName ? `${step.accountName} -> ${step.toAccountName}` : step.accountName;
  }

  private inputs(): PlanStepInput[] {
    return this.steps().map((s) => s.input!).filter(Boolean);
  }

  private async save(steps: PlanStepInput[], announce: string): Promise<void> {
    this.busy.set(true);
    try {
      const response = await api.plans.setPlanSteps({ planId: this.planId, steps });
      this.plan.set(response.plan);
      this.notify.success(announce);
    } catch (err) {
      this.notify.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  /** Opens the step dialog; for Sell/Buy from a class row, with that
   *  class's candidate picker first. */
  addStep(kind: StepKind, className?: string): void {
    const data: PlanStepDialogData = { kind, accounts: this.accounts(), securities: this.securities(), className };
    this.dialog
      .open(PlanStepDialog, { data, width: className ? '900px' : undefined })
      .afterClosed()
      .subscribe((step: PlanStepInput | undefined) => {
        if (!step) return;
        void this.save([...this.inputs(), step], 'Step added');
      });
  }

  sellFrom(c: ClassProjection): void {
    this.addStep(StepKind.STEP_SELL, c.name);
  }

  buyInto(c: ClassProjection): void {
    this.addStep(StepKind.STEP_BUY, c.name);
  }

  editStep(step: PlanStep): void {
    const data: PlanStepDialogData = {
      kind: step.input!.kind,
      accounts: this.accounts(),
      securities: this.securities(),
      existing: step.input,
    };
    this.dialog
      .open(PlanStepDialog, { data })
      .afterClosed()
      .subscribe((edited: PlanStepInput | undefined) => {
        if (!edited) return;
        const steps = this.inputs().map((s, i) => (i === step.position - 1 ? edited : s));
        void this.save(steps, 'Step updated');
      });
  }

  removeStep(step: PlanStep): void {
    void this.save(this.inputs().filter((_, i) => i !== step.position - 1), 'Step removed');
  }

  move(step: PlanStep, delta: -1 | 1): void {
    const steps = this.inputs();
    const from = step.position - 1;
    const to = from + delta;
    if (to < 0 || to >= steps.length) return;
    [steps[from], steps[to]] = [steps[to], steps[from]];
    void this.save(steps, 'Step moved');
  }

  async print(): Promise<void> {
    try {
      const response = await api.plans.markPlanPrinted({ planId: this.planId });
      this.plan.set({ ...this.plan()!, summary: response.summary });
    } catch (err) {
      this.notify.error(err);
      return;
    }
    window.print();
  }

  async setArchived(archived: boolean): Promise<void> {
    try {
      await api.plans.setPlanStatus({
        planId: this.planId,
        status: archived ? PlanStatus.PLAN_ARCHIVED : PlanStatus.PLAN_OPEN,
      });
      this.notify.success(archived ? 'Plan archived' : 'Plan reopened');
      await this.reload();
    } catch (err) {
      this.notify.error(err);
    }
  }

  async deletePlan(): Promise<void> {
    const name = this.summary()?.name ?? 'this plan';
    if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
    try {
      await api.plans.deletePlan({ planId: this.planId });
      this.notify.success('Plan deleted');
      await this.router.navigateByUrl('/allocation/plans');
    } catch (err) {
      this.notify.error(err);
    }
  }

  timestamp(iso: string): string {
    return iso ? iso.replace('T', ' ').replace(/\.\d+/, '').replace(/([+-]\d\d:\d\d|Z)$/, '') : '';
  }
}
