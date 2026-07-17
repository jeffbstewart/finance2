# Design: the Plaid investments pipeline

**Status:** Draft for Jeff's review.
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

**Adopt the proto-export architecture.** bankferry (Go) remains the only
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
   security-key-guarded credential handling" becomes unnecessary** —
   proposed amendment, Jeff's call.
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

All Plaid-facing components are Go, in bankferry-land. finance2's only
Plaid artifact is the proto contract and its importer.

### A. Credential custody (exists; extract, don't rewrite)

What bankferry has today: sandbox secret in the OS keyring; production
secret sealed in a touchvault vault behind a FIDO2 security-key touch
(ciphertext in bankferry's SQLite); client ID in keyring;
refuse-under-agent markers on the human-presence path. **Design change:
none functionally.** Work: extract `apikey.go`/`hardwarekey.go`/
`plaid.go` into a reusable Go package so B–D consume an interface
(`CredentialSource`) instead of bankferry internals.

### B. Item enrollment & item-credential storage (extract from bankferry, extend)

Extracted from bankferry's `plaid/` package (Link-token creation, the
guarded loopback Link/OAuth server, public-token exchange, keyring item
storage with JSON-versioned entries, update-mode re-link, encrypted
token backup) into a reusable Go module — working name **plaid-enroll**
— used by bankferry and by any future enrollment need. Extensions:

- **Products per item:** enrollment requests `investments` (and
  `transactions` where the same institution serves both). Product mix is
  per-item configuration, not hard-coded.
- **Item registry:** a small queryable inventory (institution, entry
  name, products, environment, link date, last-verified) so both
  fetchers and the human can see what exists. Lives beside the keyring
  entries; contains no secrets.
- **Slot-budget guard:** displays remaining trial slots and requires
  explicit human confirmation before Link-token creation in production.
- Keyring convention stays exactly bankferry's (service `"bankferry"`,
  `plaid-item-<env>-<itemID>`, versioned JSON) — nothing else reads it
  anymore under this design, so there is no cross-language migration.

### C. Transactions fetch (exists)

bankferry's current sync-cursor pipeline (`/transactions/sync` → OFX),
refactored only to consume A and B through their extracted interfaces.
No behavior change.

### D. Investments fetch → proto export (new, Go, lives in bankferry)

A new bankferry subcommand (working name `bankferry investments export`):

- Calls `/investments/holdings/get` and
  `/investments/transactions/get` for each investments-enabled item,
  via the **raw-JSON decimal-safe client pattern** (`json.Number`, never
  the SDK's float fields).
- Emits one **`InvestmentsSnapshot`** proto file per run (binary proto +
  optional JSON debug form) to a configured output directory —
  the OFX model, aimed at finance2 instead of GnuCash.
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

**Ownership:** the `.proto` lives in **finance2** (`proto/`), the public
repo whose importer defines the need — proposed file
`proto/plaid_snapshot.proto`. bankferry consumes it.

**Cross-repo sync (pick one):**
- *(leaning)* **Vendored copy + CI drift check**: bankferry commits a
  copy; a CI step curls the finance2 raw file and fails on checksum
  mismatch. Zero infrastructure, obvious failure mode.
- Buf Schema Registry (BSR): cleaner dependency semantics, one more
  external service/account.

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
2. **Contract PR**: `proto/plaid_snapshot.proto` in finance2 + this
   design's field-level refinement; agree before any fetch code.
3. **bankferry PRs**: extract A and B (plaid-enroll), add Investments
   product support + slot-budget guard, then the D exporter.
4. **Production links**, human-initiated, value order: Vanguard →
   Schwab (pending OAuth gating) → Morgan Stanley.
5. **finance2 importer (E)** lands with Phase 3/4 schema work.

## Open questions for Jeff

1. **Amend corollary 1?** Under proto export, the JVM security-key
   guard is unneeded — the guard stays Go/touchvault-only. Confirm.
2. **Institution entries:** which Plaid entry matches each real
   relationship — Vanguard brokerage vs "My Vanguard Plan" for the
   401(k)? Which of the three Morgan Stanley entries?
3. **Snapshot handoff:** shared directory on the same host, or should
   the exporter also support pushing to finance2's import endpoint
   later? (Design assumes file drop; nothing precludes adding a push.)
4. **Proto sync mechanism:** vendored-copy-with-CI-check (leaning) vs
   Buf Schema Registry?
5. **Single Plaid account confirmed?** Proto export means finance2
   needs no Plaid account of its own — the "coin a separate trial
   account" plan in MODERNIZATION.md would be dropped, and Decision 8's
   conflict dissolves. Confirm.
