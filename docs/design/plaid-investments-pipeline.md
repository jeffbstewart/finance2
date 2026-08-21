# Design: the Plaid investments pipeline

**Status:** Accepted with rulings (Jeff, 2026-07-17) — see decisions
inline; the only remaining open question is which Plaid institution
entries match the real account relationships.
**Date:** 2026-07-17.
**Relates to:** Decision 0 corollaries 1–2
([decisions/0-implementation-language.md](../../decisions/0-implementation-language.md)),
Decision 8 (portfolio composition), MODERNIZATION.md Phase 4.

## What this designs

Separation of the Plaid integration into independent concerns:

- **A. Client-account credential custody** — the Plaid `client_id` +
  `secret` per environment.
- **B. Item enrollment & item-credential storage** — Link flows, token
  exchange, access-token storage, item lifecycle.
- **C. Transactions fetch** — bankferry's existing product.
- **D. Investments fetch** — new, feeding finance2.

Plus the architecture question Jeff raised mid-design: should finance2
(Kotlin) talk to Plaid at all, or should we **define a Protocol Buffer
contract for "investment information from Plaid," have bankferry produce
it, and have finance2 only consume it?**

## Recommendation up front

**Adopt the proto-export architecture.** *(Decided: yes — Jeff,
2026-07-17, with the rulings noted inline below: proto lives with the
writer in bankferry, no large bankferry refactoring, no JVM
security-key support, file-drop handoff configured in `.env`,
duplicated proto with no sync tooling for now, single Plaid account.)* bankferry (Go) remains the only
program that ever holds Plaid credentials or calls Plaid; it grows an
investments fetcher that emits a proto-typed snapshot file; finance2
imports that file and never touches Plaid, its secrets, or the keyring.

Why this beats the finance2-talks-to-Plaid alternative (including the
earlier shared-keyring idea):

1. **Credential isolation is absolute.** The threat named in Decision 0
   corollary 1 is an agent hallucination burning the ~10
   lifetime-available Plaid trial slots. Under this design, no code in
   finance2 — and no agent working in the finance2 repo — can reach
   Plaid credentials *at all*. The only guard needed is the one that
   already exists (touchvault security-key seal + refuse-under-agent
   markers in bankferry). **Corollary 1's "JVM implementation of
   security-key-guarded credential handling" is rescinded** —
   confirmed by Jeff, 2026-07-17.
2. **One Plaid client, one language.** All Plaid API surface stays in Go
   next to the proven code: the plaid-go Link lifecycle, the
   decimal-safe raw-JSON data client (`json.Number` — the official SDKs
   decode money as floats), keyring item storage. No JVM keyring shim,
   no plaid-java, no second implementation to keep honest.
3. **It matches how bankferry already works.** bankferry is an exporter
   by design: it fetches transactions and emits OFX files for GnuCash.
   An investments-snapshot proto is a second export format under the
   same operational model — a human-initiated run, gated by a security
   key touch, producing files another program ingests.
4. **The contract is compile-time typed on both ends.** The `.proto` is
   the single source of truth; Go generates the writer, Kotlin generates
   the reader. Drift is a compile error — the same philosophy as
   finance2's own API boundary.
5. **Accepted costs:** data freshness is batch, not live (fine — finance2
   already surfaces staleness for manually priced instruments, and
   institution-reported holdings update daily at best); bankferry's
   scope grows; the shared `.proto` needs a cross-repo sync mechanism
   (below).

The superseded alternative for the record: sharing access tokens via the
OS keyring with a Kotlin Plaid client in finance2 (Jeff's earlier
proposal, recorded in Decision 0) — it works, but requires the JVM
security-key guard, a JVM keyring compatibility shim, credentials
resident in two runtimes, and a second decimal-safe Plaid client. Every
one of those disappears under proto export.

## The coverage gate

Before any of this executes, we need a reason to believe Plaid's
**Investments** product actually covers the target institutions.
Priority order by value: **Vanguard > Schwab > Morgan Stanley**.

Evidence gathered 2026-07-17 (public sources; see caveats):

| Institution | Investments support | Evidence | Caveats |
|---|---|---|---|
| **Vanguard** | **Yes** — Plaid's own institution page lists supported products "Assets, Balance, Transactions, **Investments**" | [plaid.com/institutions/vanguard](https://plaid.com/institutions/vanguard/); Plaid changelog: Vanguard **migrated to OAuth Feb 19, 2025**, improving link reliability | Vanguard brokerage vs. retirement ("My Vanguard Plan") are historically **separate institution entries**; which entry covers which of Jeff's accounts must be confirmed |
| **Charles Schwab** | **Yes** (secondary sources) — listed among Plaid Investments-supported brokerages; Schwab↔Plaid OAuth live since 2021 | [Plaid OAuth guide](https://plaid.com/docs/link/oauth/); [TradesViz supported-broker list](https://www.tradesviz.com/plaid-supported-brokers/); [Plaid newsletter June 2021](https://plaid.com/blog/newsletter-june-2021/) | **Schwab OAuth access is gated**: it must be explicitly requested in the Plaid dashboard and can take **up to six weeks after Production approval**. Whether bankferry's current (trial / limited-production) tier can get Schwab access at all is the key open check |
| **Morgan Stanley** | **Yes** — Plaid's institution page for "Morgan Stanley Client Serv" lists "Assets, Balance, Transactions, **Investments**" | [plaid.com/institutions/morgan-stanley-client-serv](https://plaid.com/institutions/morgan-stanley-client-serv/) | Multiple Morgan Stanley entries exist (Client Serv, Alight–Morgan Stanley, Solium Shareworks). Which one matches Jeff's relationship must be confirmed |

**Caveats on this evidence:** Plaid's institution marketing pages are
generated and can lag or overstate per-account-type data quality;
"Investments supported" says nothing about whether a specific 401(k)
recordkeeper relationship returns holdings. Treat the table as
sufficient to justify the design work, not as final validation.

**Definitive verification, in cost order (before burning anything):**

1. **Sandbox institution-directory query — zero slot cost.** A small
   bankferry-side script calls `/institutions/search` (sandbox
   credentials, no Item creation) filtered to `products=["investments"]`
   for each of: Vanguard, My Vanguard Plan, Charles Schwab, Morgan
   Stanley (all entries). This yields Plaid's authoritative per-entry
   product flags plus OAuth status. Human-run (sandbox creds live in
   the OS keyring).
2. **Dashboard check** for Schwab OAuth availability on the current
   account tier, and trial Investments product availability.
3. **One production link per institution — costs one slot each, ~3 of
   ~10.** Only after 1–2 pass, in value order (Vanguard first), each
   run human-initiated behind the security-key touch. If Vanguard
   returns good holdings data, the design is validated; Schwab and
   Morgan Stanley follow as budget and gating allow.

**Slot-budget ledger:** the design should assume ~3 production slots for
the three institutions plus headroom for re-links; the enrollment tool
(B) must display remaining budget and require explicit confirmation
before any operation that could consume a slot.

## Component design

*(Ruling, Jeff 2026-07-17: **no large refactorings**. The A/B
extraction into reusable packages proposed in the draft is dropped —
the concerns below remain the map of responsibilities, but they stay
where they are inside bankferry. The work is exactly two additions:
request the Investments product at enrollment, and a separate export
command.)*

All Plaid-facing components are Go, inside bankferry. finance2's only
Plaid artifacts are its copy of the proto contract and its importer.

### A. Credential custody (exists; unchanged)

What bankferry has today stays as-is: sandbox secret in the OS keyring;
production secret sealed in a touchvault vault behind a FIDO2
security-key touch (ciphertext in bankferry's SQLite); client ID in
keyring; refuse-under-agent markers on the human-presence path.

### B. Item enrollment & item-credential storage (exists; one addition)

bankferry's existing Link flow, guarded loopback Link/OAuth server,
public-token exchange, keyring item storage, update-mode re-link, and
encrypted token backup all stay in place. The one change: **add
`investments` to the products requested** when linking (alongside
`transactions` where the institution serves both; existing items reach
the same state via update-mode re-link). Slot discipline stays a human
process: production Link runs are deliberate, security-key-gated, and
budgeted (~3 of ~10 slots planned) — no new tooling built for it.

### C. Transactions fetch (exists; unchanged)

bankferry's current sync-cursor pipeline (`/transactions/sync` → OFX).
No behavior change, no refactor.

### D. Investments fetch → proto export (new command in bankferry)

A new bankferry subcommand (working name `bankferry investments export`):

- Calls `/investments/holdings/get` and
  `/investments/transactions/get` for each investments-enabled item,
  via the **raw-JSON decimal-safe client pattern** (`json.Number`, never
  the SDK's float fields).
- Emits one **`InvestmentsSnapshot`** proto file per run (binary proto +
  optional JSON debug form) to an output directory **configured in
  bankferry's `.env`** — the OFX model, aimed at finance2 instead of
  GnuCash. finance2's importer reads from a directory configured in
  *its* `.env`; pointing both at the same path is the deployment
  convention (file drop — ruling on draft question 3).
- Snapshot semantics: full state per run (holdings are levels, not
  deltas); investment transactions carry a fetch window. finance2
  reconciles; bankferry stays stateless beyond fetch bookkeeping.

### E. finance2 importer (Kotlin; later phase)

Reads snapshot files, upserts into finance2's DB with provenance
(`source=plaid`, institution entry, `as_of`, imported-at), drives the
reconciliation views MODERNIZATION.md Phase 4 describes. **No Plaid
code, no secrets, no keyring, no network.** Import is file-drop or
manual pick; staleness surfaces in reporting like manual prices do.

## The proto contract

**Ownership (ruling, Jeff 2026-07-17):** the `.proto` lives **with the
writer, in bankferry** — that copy is the primary source of the
contract. finance2 carries a **duplicate copy** for its own codegen.

**Cross-repo sync (ruling):** plain duplication, no registry and no CI
drift check for now — skew is expected to be rare. Convention: any
contract change lands in bankferry first, and the same PR's description
notes that finance2's copy must be updated; `schema_version` bumps on
any breaking change so a stale reader fails loudly rather than
misreads.

**Shape (to be refined in the contract PR — field-level review is its
own step):**

```proto
message InvestmentsSnapshot {
  string schema_version;        // contract version, e.g. "1"
  Date as_of;                    // civil date, no timezone games
  string plaid_environment;      // "sandbox" | "production"
  repeated ItemSnapshot items;
}
message ItemSnapshot {
  string institution_entry;      // Plaid institution name, e.g. "Vanguard"
  string item_ref;               // opaque, stable per item — NOT the access token
  repeated Account accounts;
}
message Account {
  string account_ref;            // Plaid account_id (opaque)
  string name; string type; string subtype;
  Money institution_value;       // institution-reported
  repeated Holding holdings;
  repeated InvestmentTransaction transactions;
}
message Holding {
  SecurityRef security;
  Decimal quantity;
  Money cost_basis;              // as reported; may be absent
  Money institution_price;       // institution-reported price
  Date price_as_of;
}
message SecurityRef {
  string plaid_security_id;
  string ticker; string cusip; string isin;   // any may be empty
  string name; string type;
  string currency_code;          // ISO 4217
  bool is_cash_equivalent;
}
message Decimal { string value; }             // exact decimal string — never float/double
message Money   { Decimal amount; string currency_code; }
message Date    { int32 year; int32 month; int32 day; }
```

Hard rules: **no float/double anywhere near money or quantities**
(string-encoded decimals end to end, honoring the raw-JSON fetch);
**no secrets in the snapshot** (no access tokens, no request IDs tied to
credentials); snapshots contain real account names and values, so
**snapshot files are data, never repo content** — the output directory
is git-ignored and `.aiignore`-relevant in both repos per finance2's
public-repo hygiene goal.

## Execution order

1. **Coverage verification** (sandbox directory query + dashboard
   check) — gates everything; zero slot cost.
2. **Contract PR in bankferry**: `plaid_snapshot.proto` (primary
   source) + field-level refinement of the shape above; agreed before
   any fetch code. finance2 duplicates the file when its importer work
   starts.
3. **bankferry PRs**: add the Investments product to enrollment, then
   the D export command. No refactoring beyond what those two changes
   require.
4. **Production links**, human-initiated, value order: Vanguard →
   Schwab (pending OAuth gating) → Morgan Stanley.
5. **finance2 importer (E)** lands with Phase 3/4 schema work.

## Rulings and open questions

Rulings (Jeff, 2026-07-17) on the draft's five questions:

1. **Corollary 1 rescinded** — no JVM security-key support; credential
   guarding stays Go/touchvault-only in bankferry.
2. **Contract agreed** — with the primary source living with the
   writer, in bankferry (not finance2 as drafted).
3. **Snapshot handoff: file drop**, output/input locations configured
   in each project's `.env`.
4. **Proto sync: duplicate the file in both projects** for now; no
   registry, no CI check — skew expected to be rare.
5. **Single Plaid account: yes** — finance2 coins no account of its
   own; MODERNIZATION.md's separate-trial-account plan is dropped.

Additional ruling: **no large bankferry refactorings** — the draft's
extraction of credential custody and enrollment into reusable packages
is dropped; Decision 0 corollary 2 shrinks to "add Investments to
enrollment + a separate export command."

Still open:

- **Institution entries:** which Plaid entry matches each real
  relationship — Vanguard brokerage vs "My Vanguard Plan" for the
  401(k)? Which of the three Morgan Stanley entries (Client Serv,
  Alight, Solium Shareworks)? Answered by the step-1 sandbox directory
  query plus Jeff's knowledge of the accounts.

## Amendment: Docker-era handoff (ruling, Jeff 2026-08-20)

Ruling 3's file drop assumed finance2 and bankferry share a
filesystem; the always-running Docker container broke that assumption.
Superseding rulings:

- **Handoff is a browser upload through the authenticated session.**
  bankferry still writes snapshot files to its `.env`-configured
  output directory; the human uploads one from finance2's Import
  screen. No shared filesystem, no machine credentials, no new
  unauthenticated surface. (Embedding Plaid functions in finance2 was
  considered and rejected again: beyond the standing credential-
  isolation ruling, the production secret sits behind a FIDO2
  security-key *touch* — a headless container cannot provide one.)
- **Snapshots archive verbatim in the database** (encrypted at rest),
  so processing bugs can be fixed and the same bytes re-run.
- **Upload and processing are separate steps** with an explicit status
  marker (`UPLOADED` / `PROCESSED` / `FAILED`). Processing is freely
  repeatable — including revisiting a snapshot after lot edits to
  refresh the taxable comparison, and after creating/linking a local
  account that did not exist at upload time.
- **Contract details:** `schema_version` is an integer;
  `plaid_environment` is dropped (no cross-server sandbox exports).
- **Processing semantics (v1):** linked tax-deferred accounts get
  holdings quantities and sweeps upserted with `plaid` provenance;
  taxable accounts are compared against the hand-maintained lots and
  reported, never mutated; unknown tickers are flagged for the human
  to add by hand (no auto-creation); vanished holdings are flagged,
  never deleted. Plaid account → finance2 account links are explicit,
  human-made, and persist across snapshots. Investment transactions
  ride along in the archive but are not processed yet.
- The contract was authored in finance2 first (bootstrap); on cloning
  to bankferry, that copy becomes the primary source per ruling 2.

## Amendment: warnings on the broker and account views (2026-08-21)

The first real bankferry export showed that a report buried on the
Import screen does not prompt anyone to fix anything. Each `ReportLine`
now carries the finance2 `account_id` it concerns (0 for lines with
none — an unlinked Plaid account, a failed run), and
`ImportService.ListImportWarnings` returns the WARNING lines of the
**most recently processed** snapshot (by `processed_at`, so re-running
an older archive after lot fixes makes it current), attributed to
account and broker and filterable by either. The Brokerages list
badges each broker with its count, a broker's accounts page lists the
warnings with per-account badges, and the account-scoped positions
page shows the account's own — all pointing back to the Import screen
to re-process once fixed. Lines with no account stay on the Import
screen only.

## Amendment: trust-class securities and the 401(k) sweep (2026-08-21)

The first export showed two things the v1 processor could not handle.

- **Securities without tickers.** Most of a 401(k) is collective
  investment trusts — the "Tr" class of a public fund — which Plaid
  reports with a name and a stable `plaid_security_id` but no ticker.
  Ticker matching still comes first; otherwise a **human-made link**
  (`plaid_security_links`, keyed by `plaid_security_id`, persistent
  across snapshots, chosen in a "Securities in {file}" panel on the
  Import screen) says which finance2 security it is. The human adds
  that security by hand with a ticker of their choosing and MANUAL
  pricing — §6.3's no-auto-creation rule stands. For matched
  MANUAL-locus securities the processor records the institution price
  as a private price (source `plaid`, on Plaid's price date) in both
  account kinds: prices belong to the security, and nothing else will
  ever price a trust fund.
- **The sweep.** bankferry fills `cash_balance` from Plaid's
  `balances.available`, which a 401(k) reports as the whole account;
  v1 believed it and booked the entire balance as sweep. The processor
  now believes `cash_balance` only when it is less than the account
  value (or nothing but cash is held); otherwise sweep is the sum of
  cash-equivalent holdings, else the account value less every valued
  holding, else left unchanged with a warning. (bankferry could stop
  exporting `available` as cash; archived snapshots need this logic
  regardless.)
