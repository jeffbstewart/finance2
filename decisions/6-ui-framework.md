# Decision 6 — UI framework

**Status:** Assessment complete (2026-08-20); recommendation below —
Jeff decides by merging.
**Relates to:** MODERNIZATION Phase 6 / decision-table row 6,
FUNCTIONAL_SPEC §8–§9.

## Constraints

- All server calls go through the **generated Connect-ES TypeScript
  client** (firm requirement): the framework must consume plain
  typed stubs, no framework-owned data layer between UI and wire.
- Spec §8 describes the UI in Material Design terms — data tables
  with sorting/pagination, dialogs, snackbars, tabs, a 3-step
  stepper, datepickers, selects, the classic indigo/pink theme.
- Claude authors the UI; framework choice affects generated-code
  reliability (a Decision 0 criterion that carries over).
- Reference repo: MediaManager's client is **Angular 22 + Angular
  Material + connect-web** — same proto pipeline (finance2's
  gen-proto.mjs was adapted from its codegen), same auth-toolkit
  cookie-session model, current major version. Historical note from
  Jeff: MediaManager previously used **Vaadin** and migrated away —
  "more trouble than it is worth." A server-driven UI framework hides
  the wire contract inside framework internals, the opposite of this
  project's proto-typed-boundary requirement; the Angular client is
  the survivor of that lesson, not an unexamined default.

## The field

| Option | For | Against |
|---|---|---|
| **Angular (current major) + Angular Material** | Spec §8 is written in Angular Material's vocabulary (the legacy app *was* Angular Material — mat-table, MatStepper, MatSnackBar, MatDatepicker, indigo/pink prebuilt theme). MediaManager is a working, current-version reference of exactly this client shape against exactly this server shape — the Decision 0 crib-a-known-good-skeleton argument again. Batteries included (router, forms, DI). | Claude can confuse Angular API generations (14→22 churn) — mitigated by MediaManager as the in-repo style reference. Verbose; heavy bundle (irrelevant on a LAN single-user app). |
| React + Vite + MUI + connect-query | Best LLM fluency of any framework; Connect's first-party `connect-query` (typed per-RPC caching) is React-only; MUI covers §8 fully. The right answer if MediaManager didn't exist. | À-la-carte stack (router/forms/state all separate choices); zero reuse from MediaManager; two mental models across the two apps. |
| Vue 3 + Vuetify | Excellent Material data tables; pleasant SFC ergonomics. | Wins no dimension decisively: no first-party connect-query, LLM reliability a notch under React, same zero-reuse cost. |
| Svelte 5 / SolidJS | Small output, nice DX. | Weak Material/data-table stories against a table-heavy spec; new idioms (runes) are where generated code is least reliable. Wrong shape. |
| Vaadin-style server-driven UI | — | Already tried and abandoned in MediaManager; incompatible with the proto-typed boundary philosophy. Excluded. |

Charts are orthogonal (ECharts or a framework wrapper serves the
pies, grouped bars, scrubber line chart, and sparklines either way)
and are chosen during Phase 6, not here.

## Recommendation

**Angular (current major) with Angular Material**, cribbing
MediaManager's client for the connect-web transport wiring
(`credentials: 'include'` against ArmeriaAppServer), cookie-session
handling, Material shell, and table/dialog idioms. React + MUI +
connect-query is the recorded runner-up should the calculus change.
