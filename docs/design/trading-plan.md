# Trading plans: propose, project, print

Status: proposal for Jeff's ruling, 2026-08-22. Replaces the buy-only
rebalance planner of spec sec. 5.5 (`ScoreRebalance`) with a plan the
human composes step by step; the allocation view then shows what the
portfolio looks like after the plan, and the plan prints.

## The hard rule

finance2 never executes anything. A plan is a document the human
takes to the brokerage and carries out by hand; the app records the
result afterwards through the existing purchase, sale, holding, and
sweep flows. Nothing here talks to a broker, and nothing here mutates
lots, holdings, or sweeps. The rule is stated in the proto, in the
service, and on the printed page.

## Why the current planner does not fit

`ScoreRebalance` answers one question: "how much of everything must I
buy so the most overweight class lands on target without selling".
It sizes the whole portfolio to `max(classValue / targetFraction)`,
which a small class with a small target (gold at 5% against a 1.5%
target) blows up to several times the current value; Before and After
are computed over different totals, so they disagree before a single
trade is planned. It cannot sell, cannot move money between accounts,
and has no notion of money arriving from or leaving to the outside.

What is wanted instead: "I propose to sell $X of class Q in account A,
buy $Y of class R in account B, add $Z to account C from outside, draw
$W from account D to outside - here are the securities - what does the
allocation look like, and give me the list to execute."

## Domain model

A **plan** is a named, dated, ordered list of **steps**, saved until
the human archives it. Every step names exactly one account (two for
a transfer between accounts). Amounts are in the account's currency;
the projection converts to the reporting currency through the dated
FX rate, as the views already do.

| Step | Fields | Effect on the projection |
|---|---|---|
| **Buy** | account, security, shares *or* cost | holdings/lots + shares at the plan price; sweep - cost |
| **Sell** | account, security, shares *or* proceeds | holdings/lots - shares at the plan price; sweep + proceeds |
| **Transfer between accounts** | from account, to account, amount | sweep from - amount; sweep to + amount (in-kind transfers are out of scope) |
| **Add from outside** | account, amount | sweep + amount (the dollars exist outside the investment accounts) |
| **Draw to outside** | account, amount | sweep - amount (retirement drawdown) |

Steps carry an optional free-text note ("Q3 contribution", "RMD").
Asset class is not a field on a step: the human picks the security,
and the class effect follows from the security's classification
weights, exactly as the allocation view computes today. A "sell $X of
class Q in account A" proposal is therefore made by picking one or
more securities in that account; the step editor shows the account's
positions grouped by class with their class weights, so picking to a
class is easy, but the record is always concrete securities.

Prices: a step is priced at the **latest price the app holds** for the
security at the time the plan is scored (market close or the latest
private price), and the plan remembers that price per step so the
printed page shows the assumption. Re-scoring refreshes prices; the
printed plan is a snapshot and says when it was priced.

Shares-or-dollars: the human enters one; the other is derived at the
plan price (mutual funds and trusts bought in dollars, everything else
in whole shares - the existing `boughtInDollars` rule). Derived values
are shown, never silently rounded into the stored value.

### Projection

Scoring a plan produces the **projected portfolio**: every account's
sweep and positions after all steps are applied in order, and from
that, the same outputs the allocation page shows today -
per-class value and fraction, per-account value and sweep - plus:

- **Before / After side by side**, both over their own true totals
  (current total; projected total = current total + adds - draws +
  nothing else, since buys and sells move value between cash and
  positions without changing it). With no steps, Before equals After
  to the cent and sums to 100%.
- **Deltas per class** against the target (`after - target`), so the
  human sees what the plan leaves over or under, without the app
  proposing what to do about it.
- **Per-account cash check**: a step that would take a sweep below
  zero is flagged on that step and the plan is marked *not executable
  as written* (still scorable, still printable, so the human can see
  what it would take). Nothing is auto-adjusted.
- **Taxable sells: estimated realized gain.** For a sell in a taxable
  account the projection runs the sale through the existing lot rules
  (the sale-preview arithmetic in the positions rules, FIFO or the
  account's method as recorded) and reports estimated short- and
  long-term gain at the plan price. This is the one place the plan
  uses tax knowledge, and it is labelled *estimate at plan price*.
  Tax-deferred accounts report no gain.
- **Wash-sale flag** (optional, later): a sell at a loss with a buy of
  the same security within 30 days in any account is flagged. Not in
  the first cut.

The app never proposes a step, never ranks candidates, and never
says a plan is good. Targets and deltas are shown because the human
set the target; nothing else is opinion.

### Persistence

Plans are saved (`trading_plans`, `trading_plan_steps`), with status
**draft** -> **printed** (the human printed it; it is frozen and
re-scoring makes a copy) -> **archived**. A printed plan keeps its
step prices and its projection as scored, so the record of "what I
decided and on what numbers" survives price changes. Executing is not
a status: the app cannot know, and the positions pages are where the
real trades get recorded afterwards.

## Wire contract (sketch)

```
service TradingPlanService {
  rpc ListPlans(ListPlansRequest) returns (ListPlansResponse);
  rpc GetPlan(GetPlanRequest) returns (GetPlanResponse);        // steps + projection
  rpc CreatePlan(CreatePlanRequest) returns (CreatePlanResponse);
  rpc SetPlanSteps(SetPlanStepsRequest) returns (SetPlanStepsResponse); // replace all, re-score
  rpc MarkPlanPrinted(MarkPlanPrintedRequest) returns (MarkPlanPrintedResponse);
  rpc ArchivePlan(ArchivePlanRequest) returns (ArchivePlanResponse);
}

message PlanStep {
  int64 step_id; int32 position;
  StepKind kind;            // BUY, SELL, TRANSFER, ADD_EXTERNAL, DRAW_EXTERNAL
  int64 account_id; int64 to_account_id;   // to_account_id for TRANSFER
  int64 security_id;        // BUY, SELL
  Decimal shares; Decimal amount;          // one entered, the other derived
  FormattedMoney plan_price;               // as scored
  string note;
  repeated string problems;                // "sweep would go to -$1,200.00"
  FormattedMoney est_short_term_gain, est_long_term_gain;  // taxable SELL only
}

message Projection {
  repeated ClassAllocation before; repeated ClassAllocation after;   // existing message
  repeated AccountProjection accounts;     // sweep before/after, value before/after
  FormattedMoney current_total, projected_total, external_in, external_out;
  bool executable;
  string priced_at;                        // ISO instant
}
```

`ScoreRebalance` and the `TradeSide` enum are retired once the new
page ships; the candidate-fund suggestion logic is deleted rather than
carried over (it is the app proposing trades).

## UI

One page, **Plan**, under Allocation:

1. **Header**: plan name, date, status; *Before / After* totals;
   *Print* (browser print of a print stylesheet - no PDF library);
   *Archive*.
2. **Steps table**, in order, one row per step: kind, account(s),
   security, shares, amount, plan price, note, problems. Add-step
   buttons: *Buy*, *Sell*, *Transfer*, *Add from outside*, *Draw to
   outside*. Reorder by drag or up/down. Each opens a small dialog;
   Buy/Sell dialogs list the account's eligible securities (for Sell,
   only what the account holds, with held quantity shown).
3. **Projection**: the allocation table as today with Before, After,
   Target, Delta per class; below it, per-account rows with sweep
   before/after and value before/after; the cash check and the
   taxable-gain estimates inline where they apply.
4. **Printed page**: the steps as a checklist with boxes, grouped by
   account in execution order, each with "at approximately $price";
   then the projection summary; then the footer: *Priced on <date>.
   finance2 does not execute trades. Record the actual fills on the
   Positions page afterwards.*

The existing Rebalance page and its buy dialog are removed when Plan
lands (their specs and e2e with them).

## Out of scope, deliberately

- Any suggestion of what to trade (build-scope ruling: no advice).
- In-kind transfers, options, short positions, margin.
- Tax-lot *selection* for a planned sell (the estimate uses the
  account's recorded method); choosing lots is done when the real sale
  is recorded.
- Tracking execution against the plan.

## Layers

1. Rules and projection (`rules/TradingPlan.kt`): pure functions from
   a plan plus current positions, sweeps, prices, classifications to a
   `Projection`; property tests that Before == After with no steps,
   value is conserved across buys/sells, and external adds/draws change
   the total by exactly their amount.
2. Schema, service, wire: `trading_plans` tables, `TradingPlanService`,
   taxable-gain estimate through the existing lot rules.
3. UI: the Plan page, step dialogs, print stylesheet; removal of the
   Rebalance page and `ScoreRebalance`.
4. Optional: wash-sale flag; plan copy from a printed plan.

Questions for the ruling:

- Should a **Transfer** support an in-kind move (security, shares)
  between two accounts at the same broker? Cheap to add later; omitted
  now for clarity.
- Is the printed plan per **account** (one sheet per brokerage to
  carry) or one sheet for the whole plan? The sketch does both: one
  page, grouped by account.
- Should printing freeze the plan (proposed) or should plans stay
  editable and printing just stamp a date?

## Amendment: assisted selection - ordering facts, not recommending (2026-08-22)

A class is over its target and the human decides to sell some of it.
The app can help choose *what* to sell within that decision by laying
out the tax consequence of each candidate, computed from the human's
own records at the plan price, and ordering by it. That stays on the
right side of the no-advice line as long as three things hold:

1. Every number is a computed consequence of a sale the human has
   already chosen to make - never a reason to make one. The app
   orders; it does not suggest the decision, the amount, or the class.
2. The ordering key is shown and switchable. No tax *rates* are ever
   assumed, so the app never says "this saves you $X in tax"; it says
   "this realizes a $1,200 short-term loss".
3. Everything is labelled *estimate at plan price*, and the sale's
   real lot selection happens when the real sale is recorded.

### The Sell picker, per class

From the projection's class row (over target), **Sell...** opens the
picker for that class: every position that contributes to the class,
across all visible accounts, one row per position (account, security,
class weight, held quantity, value in class), with the consequence of
selling it computed through the existing lot rules at the plan price:

| Column | Source |
|---|---|
| Tax status | account: tax-deferred -> *no tax on sale*; taxable -> gains apply |
| Est. gain if sold in full | lot rules at plan price, by the account's recorded method; split short/long term |
| Gain per dollar sold | est. gain / value - the comparable figure across positions of different sizes |
| Holding period flags | lots that cross from short- to long-term within N days (a sale today vs after that date) |
| Wash-sale flag | a buy of the same security within 30 days before, in any account, or already in this plan |

Default ordering, stated in a caption the human can change with one
click: **tax-deferred accounts first** (rebalancing there realizes
nothing), then **taxable positions at a loss** (largest loss per
dollar first), then **taxable long-term gains** (smallest per dollar
first), then **short-term gains**. Alternative orderings offered:
*largest position first*, *by account*, *none*. Picking a row opens
the Sell step dialog prefilled with the security and account; the
human types the shares or dollars. A partial sale's estimate is
recomputed for the amount entered (lot rules run on the partial
quantity by the recorded method).

What the picker will not do: pick a quantity, suggest selling the
whole overweight, or rank across classes. It ranks within the class
the human opened.

### The Buy picker, per class

Symmetric and simpler: from a class under target, **Buy...** lists the
securities whose classification carries weight in that class, across
accounts with cash available, with the account's tax status and
available sweep. Ordering: *tax-deferred accounts first* (income
producers belong there - the human's own rule, recorded in the
target's rationale text), then by available cash. No expense-ratio,
performance, or "best fund" ranking: that would be choosing a fund.

### Projection additions

- Per taxable account, the plan's **estimated realized gain** total,
  short and long term, and the **loss harvested** total - so a plan
  that sells losers to offset gains shows the net.
- Lots crossing the one-year line during the plan's window are
  listed, since "wait three weeks and it is long-term" is a fact
  worth a line.

### Tests
Property: ordering is a pure function of (positions, lots, plan
price, key) and is stable; tax-deferred rows always precede taxable
under the default key; a position at a loss never sorts below a
position at a gain under the default key. The gain estimates reuse
the lot-rules tests' fixtures so the picker and the real sale agree.
