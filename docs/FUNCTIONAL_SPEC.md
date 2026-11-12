# Portfolio Manager - Functional Specification

This document specifies the functionality of the legacy `finance` application
(Go backend + Angular SPA + MySQL, at `../finance`) so it can be recreated in
this repository. It describes **what the system does**, not how to build it.
It deliberately avoids naming specific libraries or dependency versions;
where the legacy implementation choice matters as a design cue, it is given
in broad strokes only (e.g. "a Material Design component library with an
indigo/pink theme").

Legacy behaviors that are clearly defects are flagged inline as **[legacy
bug]** and collected in sec. 12; the rewrite should fix these rather than
reproduce them, unless noted otherwise.

---

## 1. Overview

A personal investment-portfolio tracker for an individual (or small set of
individuals), delivered as a single-page web application with a server
backend and a relational database. It tracks:

- **Brokerages** and the **accounts** held at them (including uninvested
  "sweep" cash balances).
- **Securities** (stocks, ETFs, mutual funds, private investments) with rich
  classification metadata: asset-class mix, sector weights, market-cap mix,
  credit quality, region weights, expense ratio.
- **Purchase lots** and **sales** against those lots, with cost basis,
  short/long-term gain tracking, and a capital-gains tax report.
- **Prices**: automatic daily price history for publicly traded securities
  from an external market-data provider; hand-entered price history for
  privately traded investments.
- **Asset allocation**: current vs. target allocation across five asset
  classes, with drift analysis and a buy-side rebalancing planner.
- **Inflation**: US CPI data used to present prices and cost bases in
  constant dollars.

### 1.1 High-level architecture (broad strokes)

Three cooperating pieces, preserved from the legacy design:

1. **Web/API server** - serves the SPA and a JSON data API; owns the
   database; performs all pricing/allocation/tax computations server-side.
2. **Price service** - a separate long-running daemon that fronts the
   external market-data API. It absorbs provider rate limits, coalesces
   duplicate requests, and caches responses (in memory with a several-hour
   TTL, persisted to disk across restarts) so the web tier stays responsive.
   The web server talks to it over an internal RPC interface. Read-only:
   price *edits* (private securities) never go through it.
3. **Relational database** - system of record for everything except public
   price history (which is always fetched from the price service).

The legacy split (UI on one port, data API on another, with CORS between
them) is an artifact, not a requirement; a single origin is acceptable and
simpler. The rewrite must, however, keep the **public vs. private pricing
split** (sec. 5.6) and the **price-service isolation of external API quotas**.

---

## 2. Licensing constraints (Apache-2.0)

The rewrite is intended to be Apache-2.0. A scrub of the legacy repo found
the following. Items marked **BLOCKER** must not be carried into this repo.

| Item | Status | Action |
|---|---|---|
| **Omega app icon** (`omegaIcon/` - Iconfinder purchase #1590630, Basic license) | **BLOCKER.** The Iconfinder Basic license is non-transferable and forbids redistribution "alone - even for free" and placement on any website in downloadable form. A public Apache-2.0 repo violates it. | Do not copy. Design or commission a new logo/favicon. Note the icon also exists as the legacy `ui/src/favicon.ico` (byte-identical) and inside the generated `ui-packr.go` blob - none of these may be carried over, and they should be purged from history if history is imported. `receipt.pdf` in that directory is a personal purchase record and must not be published regardless. |
| **"Tax" nav icon** (Iconfinder #135035, purchased Basic license, inline SVG in the leftnav) | **BLOCKER** for the same reason. | Replace with an original or permissively licensed icon. |
| Free Iconfinder nav icons (#197221 "Brokers", #322420 "Positions" - "free for commercial use, include link to author"; #2203521 "Allocation" - free) | Redistribution unclear; attribution requirement was never actually rendered in the legacy UI. | Replace all nav icons with a single coherent icon set (e.g. the icon font that ships with the chosen component library). Do not copy the SVGs. |
| **Morningstar HTML test fixtures** (`morningstar_test.go` contains captured Morningstar page content) | Morningstar's copyrighted material. | Do not carry over. The scraper itself is dead (sec. 6.3) and is not part of this spec's required scope. |
| Morningstar scraping (runtime) | ToS concern (automated collection) and the scraped endpoints are long dead. | Dropped from the rewrite; see sec. 6.3 for the replacement requirement. |
| CPI dataset (FRED series CPIAUCSL, a compiled-in snapshot + runtime fetch) | US government work product - public domain. FRED's terms ask for attribution on redistribution. | Fine to use. Add a NOTICE line attributing BLS/FRED if a snapshot is embedded. |
| `jlog` (Apache-2.0 fork of google/glog) | Compatible **with obligations**: retain the LICENSE, Google copyright headers, and a statement of modifications, if the fork is reused. | Prefer not to carry it at all (use an ordinary logging approach); if carried, keep the notices. |
| Legacy `currency` package headers ("All Rights Reserved", J. Stewart) | Contradicts the repo's MIT license, but the author owns it. | If any legacy code is ported, replace headers with Apache-2.0 ones. The legacy repo root is MIT (author-owned) - relicensing owner-authored code is fine. |
| Legacy Go/npm third-party deps | All permissive (BSD/MIT/ISC/Apache/MPL-2.0/public-domain); no GPL. Font Awesome free icons are CC BY 4.0 (attribution) - legacy used one Google-logo glyph. | Whatever the rewrite pulls in, keep an eye on attribution-required assets that get *embedded* in shipped bundles. |

**Branding note:** the legacy app's identity is "Omega: Portfolio Manager" with
an omega logo. The name can stay; the omega *artwork* cannot. A simple
original Omega glyph rendered from a font, or a fresh design, is fine.

---

## 3. Users, authentication, and authorization

### 3.1 Sign-in

- Authentication is **federated sign-in with Google** (no local passwords).
  The SPA obtains a Google identity token client-side; the server verifies
  the token (signature against Google's published keys, audience = the app's
  OAuth client ID, issuer, expiry, verified email required) and establishes
  its own session.
- Server session: a signed+encrypted cookie carrying `{displayName, email}`.
  Legacy used a 7-day identity cookie plus a 90-day session cookie of which
  only the identity cookie was ever consulted. The rewrite should have **one**
  coherent session mechanism with:
  - `Secure`, `HttpOnly`, `SameSite` set properly (legacy identity cookie was
    not HttpOnly, not Secure, and had a request-scoped Path - all bugs).
  - **Logout must actually invalidate the session** ([legacy bug]: logout
    cleared the unused cookie and left the operative one valid for 7 days).
  - Google's signing keys must be re-fetched on rotation ([legacy bug]:
    cached forever; key rotation broke logins until restart).
- The SPA keeps sign-in state across page reloads (legacy kept it only in
  memory, so a refresh appeared to log the user out even though the server
  session persisted - [legacy bug]).

### 3.2 Authorization and multi-user model

- The identity key is the **verified email address**.
- Data model supports many users and many portfolios with a user<->portfolio
  **grant** join (multi-user portfolio sharing was designed in but never
  surfaced; the rewrite should keep the shape in the schema, UI not
  required).
- Effective legacy behavior to preserve: each signed-in user operates on
  their own single portfolio named `default`, **auto-created on first
  authenticated request**.
- **Decision required (recommend: add one):** legacy had **no allowlist** - 
  any Google account in the world with a verified email could sign in and
  get a portfolio. For a personal app exposed to the internet this should be
  a configured allowlist of emails, with everyone else rejected at login.

### 3.3 Secrets

Runtime secrets (DB password, OAuth client credentials, session/cookie keys,
market-data API key) load from configuration outside the repo (the successor
of the legacy `secrets.json`; the modernization plan calls for `.env`-style
config). Never committed.

---

## 4. Domain model

### 4.1 Entity graph

```
User (email) --< Grant >-- Portfolio
                              |--< Broker --< Account --< PurchaseLot --< SaleRecord
                              |--< Security --< PrivatePrice     (PurchaseLot -> Security)
                              |        `-- classification weight sets (see below)
                              `--< TargetAllocationEntry -- AssetClass
```

### 4.2 Entities

**Broker** - `id`, `name`, `hidden` flag, optional logo. Derived at read
time: total sweeps, total investment value across its accounts.

**Account** - `id`, broker, `name` (nickname), `accountNumber` (the broker's
account identifier, a string), `taxDeferred` (bool - excludes this account's
sales from the tax report), `sweepBalance` (uninvested cash, maintained by
hand via the edit-account form), `hidden` flag. Derived: `investmentValue`
(current priced value of holdings).

**Security** - `id`, `ticker`, `description`, `securityType` (Stock / ETF /
Mutual Fund / Private Investment / Unknown), `publiclyTraded` flag,
`netExpenseRatio`, `hidden` flag, and classification **weight maps** (each a
map from a seeded enumeration value to a fraction):

- **Asset allocation** over asset classes: Cash, US Stock, Non US Stock,
  Bond, Other.
- **Sector weights** over either 11 equity sectors (Morningstar taxonomy:
  Basic Materials, Consumer Cyclical, Financial Services, Real Estate,
  Communication Services, Energy, Industrials, Technology, Consumer
  Defensive, Healthcare, Utilities) or 18 bond sectors (US Treasury,
  Corporate Bond, Agency MBS Pass-Through, Municipal, ...).
- **Market-cap mix**: Giant, Large, Medium, Small, Micro, Unknown.
- **Region weights** over 12 regions (United States, Canada, Latin America,
  United Kingdom, Europe Developed, Europe Emerging, Africa/Middle East,
  Japan, Australasia, Asia Developed, Asia Emerging, Other), with a
  country->region lookup table (~200 rows) for folding country data into
  regions. (Fix the legacy seed-data typos: "Isreal", "Singaport",
  "Guadaloupe", "Cote dlovoire", "Kirbati", "Lichtenstein".)
- **Credit quality** over bond ratings: AAA, AA, A, BBB, BB, B, Below B,
  Not Rated.

**PurchaseLot** (a.k.a. position detail) - `id`, account, security,
`dateBought`, `quantity` (shares), `pricePerShare`, `purchaseCosts`
(commission for the lot). Derived, never stored: `stillHeld` share count
(quantity minus shares sold), split into short-term/long-term buckets.

**SaleRecord** - a sale of shares of one ticker from one account on a date
at a price with total sale costs, allocated across one or more purchase
lots. Storage is one row per (sale, lot) with sale costs apportioned across
lots **proportionally to shares sold**. Derived: per-sale gain, split
short/long term.

**PrivatePrice** - `(security, date, price)` history rows for privately
traded securities only.

**TargetAllocationEntry** - `(portfolio, assetClass, fraction)`; the five
fractions must sum to 1 (+/-0.0001), enforced at write time.

### 4.3 Data-representation rules

- **Precision**: all money amounts, share quantities, and fractions are
  exact **4-decimal fixed-point** values. No binary floating point in the
  domain or the database. Arithmetic must be exact; overflow and
  divide-by-zero are errors, not silent wraps.
- **Currency**: values carry a currency unit. Mixed-currency arithmetic is
  an error. Division of money by money yields a unitless fraction and is the
  only sanctioned money/money operation. Default/assumed currency is USD;
  parsing accepts `$1,234.56`, bare `1234.56`, and accounting-style
  negatives `($1,234.56)`. The multi-currency machinery existed end-to-end
  in legacy but the app is effectively USD-only (CPI data is USD-only);
  the rewrite may keep the unit field without building currency UX.
- **Display formatting is a server responsibility**: every money/share/
  fraction value crosses the API as `{display: string, sort: number}` (plus
  the exact amount where the client can edit it). The UI renders `display`
  verbatim and sorts by `sort`. Money display uses accounting formatting
  (comma grouping, parenthesized negatives, currency symbol, up to 4
  decimals).
- **Dates** are calendar dates with no time zone: `{year, month, day}`.
  Purchase/sale/price dates never carry a time of day.
- **Database types** ([legacy bug] to fix): legacy stored money, quantities,
  and dates as *formatted strings* (`$1,234.5678`, `"31 Oct 2015"`), making
  DB-side sorting, filtering, and arithmetic impossible. The rewrite uses
  native DECIMAL and DATE column types.
- **Uniqueness scoping** ([legacy bug] to fix): tickers unique per
  portfolio (legacy: globally unique); account nicknames unique per broker
  (legacy: globally unique).
- **Soft hide**: brokers, accounts, and securities have a `hidden` flag.
  Hidden items are excluded from all normal views and totals but remain in
  the data (and still appear in choice lists where legacy included them,
  e.g. the add-purchase form). Both hide **and unhide** must work (legacy
  never implemented the unhide endpoints - the UI needs a way to list and
  reveal hidden items).

---

## 5. Business rules and computations

All computations are performed **server-side**; the UI is a renderer.

### 5.1 Lots, shares held, and cost basis

- Shares still held per lot = purchased quantity - sum shares sold from that
  lot. Lots with |stillHeld| <= 0.0001 are treated as closed and dropped from
  holdings views.
- Still-held shares are classified **short-term vs. long-term** by lot age:
  long-term when held more than one year. (Legacy had two thresholds - ">1
  year" in one path and ">366 days" in another; the rewrite picks the tax
  rule: more than one year, computed calendar-correctly.)
- When a sale consumes shares from a lot, long-term shares are consumed
  first, then short-term (FIFO by tax class).
- Lot cost basis = stillHeld x purchasePricePerShare + purchaseCosts
  pro-rated by the fraction of the lot still held.
- A **position** is the per-ticker aggregate across lots: total/short/long
  shares and basis.

### 5.2 Pricing and gains

- Current value of a position = shares held x latest price (short/long split
  maintained). Gain = current value - basis.
- Account investment value = sum its positions' current values. Broker totals
  = sum account sweeps and sum account investment values. Grand totals across
  brokers shown on the brokerages page.
- Pricing many positions fans out concurrently server-side (legacy: ~10-20
  workers); a request-level failure of any price lookup fails the request
  with an error.

### 5.3 Sale gain and tax report

- Per-sale gain = (salePricePerShare - purchasePricePerShare) x sharesSold
  - proRatedPurchaseCosts - saleCosts, classified short/long term by holding
  period at sale date.
- The **tax report** lists all sales in a date range across the portfolio,
  excluding sales in tax-deferred accounts, with per-sale detail (broker,
  account, ticker, both dates, both prices, both cost columns, gain) and
  running totals of short-term, long-term, and total gain.
  ([legacy bug] the query wasn't portfolio-scoped; the rewrite scopes it.)

### 5.4 Asset allocation

- **Current allocation**: each priced position's total value is distributed
  across asset classes using its security's asset-allocation weight map
  (one fund can contribute to several classes). The sum of all non-hidden
  accounts' sweep balances is added to the **Cash** class as a synthetic
  "Sweeps" position. Portfolio total = sum class buckets.
- **Target allocation**: the stored per-class fractions. If none is stored,
  behave sensibly (prompt to set one; do not silently invent a default - 
  legacy defaulted to 100% "Other").
- **Drift**: per class, current fraction = classValue / portfolioTotal;
  target quantity = portfolioTotal x targetFraction; delta = target -
  current (in dollars). Exposed per class along with the contributing
  positions (ticker, shares, fraction of that position allocated to the
  class, dollar contribution).

### 5.5 Rebalancing planner (buy-side what-if)

An interactive planner: the user picks a destination account, optionally
adds hypothetical new cash, and builds a tentative list of purchases; the
server re-scores the plan on every change. Nothing is persisted - the
output is a shopping list.

- **Rebalance total**: if the user specified funds to invest, total =
  current portfolio value + sweeps + added funds. Otherwise **buy-only
  mode**: the new total is the smallest portfolio value at which the most
  overweight non-Cash class reaches its target without selling anything
  (max over classes of classValue / targetFraction).
- The user's tentative trades convert to per-class dollar allocations.
  **Mutual funds are bought in dollars** (shares derived = value/price);
  other securities are bought in whole shares (value derived =
  sharesxprice). This distinction is load-bearing in the math and the buy
  dialog.
- Per class the planner reports: current, post-trade ("rebalance"), and
  target fractions and dollar amounts; delta; residual error (current +
  spent - target); and **candidate funds** to buy: securities whose weight
  in that class is >= 0.9, with suggested whole-share counts
  (floor(need / (price x classFraction))) and cost, ordered by concentration.
- Plan-level figures: current total, added funds, spent so far, remaining
  to spend.
- Sell-side planning was a stub in legacy; it is **optional** in the
  rewrite (the UI slot exists - see sec. 9.14).

### 5.6 Public vs. private pricing

- **Publicly traded** securities: price history and latest price come from
  the price service (external provider). Manual price CRUD is rejected.
- **Privately traded** securities: price history is hand-entered rows in
  the local database (latest = newest dated entry); the external provider
  is never consulted. Full add/edit/delete of history entries.
- Adjusted close: providers supply split/dividend-adjusted closes for
  public tickers; for private securities adjusted = raw.

### 5.7 Inflation adjustment

- CPI source: US CPI-U, all items, seasonally adjusted (FRED series
  CPIAUCSL), monthly index. Index for an arbitrary date is linearly
  interpolated between surrounding monthly points; flat extrapolation is
  allowed a couple of months before the first and ~4 months past the last
  point (publication lag); outside that range it is an error.
- Time-value conversion: `amount x Index(destination)/Index(origin)`.
- Used to present (a) purchase prices/costs/basis/gains of lots in today's
  dollars ("adjust costs for inflation" checkbox), and (b) price history in
  constant dollars for charts.
- The rewrite should apply inflation adjustment **at presentation time in
  one consistent direction** (legacy had two wrappers adjusting in opposite
  directions - [legacy bug]) and must **refresh CPI data periodically**
  (legacy fetched once at startup and died if the fetch failed; the rewrite
  should start from an embedded/cached snapshot and refresh in the
  background).

### 5.8 Technical indicators

Computed server-side over the date-ascending adjusted-close history with a
20-sample moving window, returned alongside security details:

- **SMA**: mean of the window.
- **EMA**: multiplier 2/(20+1), seeded with the first window's mean.
- **Bollinger bands**: mean +/- 2 standard deviations, plus the mean.

### 5.9 Guard rails (invariants enforced on mutation)

- Hide account: only when its investment value is zero.
- Hide brokerage: only when it has no visible accounts.
- Hide security: only when it has no open lots.
- Delete account / broker / security: only when nothing references them
  (empty account; broker with no accounts; security with no lots, prices,
  or weights).
- Target allocation fractions must sum to 1 (+/-0.0001).
- Sale: shares sold per lot must not exceed that lot's still-held shares;
  the per-lot amounts must sum to the sale's total shares. (Legacy skipped
  server-side validation of sales - the rewrite validates.)
- Editing a lot that already has sales must not silently corrupt those
  sales (legacy allowed moving a purchase to another account/security out
  from under its sales - [legacy bug]; the rewrite should reject or cascade
  coherently).

---

## 6. External data sources

### 6.1 Market data (prices)

- Required data per public ticker: daily bars - date, raw close,
  split/dividend-adjusted close, open/high/low, dividend amount, split
  coefficient, volume. Coverage for stocks, ETFs, **and mutual funds**.
  Two fetch depths: recent (~1 month) and full history.
- Operations: latest price (may be up to a day stale - this is explicitly
  not a real-time system) and full daily history.
- The price service must implement, provider-independently:
  - **Pluggable providers** behind one interface (legacy had AlphaVantage
    and IEX Cloud; IEX is defunct and AlphaVantage's adjusted-daily endpoint
    went premium - provider choice is open, treat it as configuration).
  - **Response caching** with a multi-hour TTL, persisted across restarts.
  - **Rate limiting** tuned to the provider's quota, with a wait queue.
  - **Request coalescing**: concurrent requests for the same ticker share
    one upstream fetch.
  - Clean typed detection of quota-exceeded responses.
- Do **not** reproduce: the hard-coded personal prefetch ticker list, the
  API key appearing in cache keys, and the legacy concurrency bugs (worker
  leak, double-callback, race in pending-request bookkeeping).

### 6.2 Inflation data

FRED CPIAUCSL CSV (see sec. 5.7). Embed a snapshot for offline startup; refresh
periodically; attribute BLS/FRED in a NOTICE.

### 6.3 Security classification metadata

Legacy auto-populated a new security's description, type, weight maps, and
expense ratio by **scraping Morningstar's HTML at add time**. That is gone
entirely in the rewrite - no crawling of public sources' pages, period
(ToS-incompatible with an open-source release, and the scraped page
structures are long dead anyway). Nothing Morningstar-specific survives:
no scraper code, no captured-HTML test fixtures, no Morningstar URLs.

**Catalog of the data the scrape supplied** - this is the shopping list for
evaluating a professional/licensed data source, and equally the field list
for the manual-entry UI:

| Field | Shape | Notes |
|---|---|---|
| Description | free text | fund/company name |
| Security type | enum | Stock / ETF / Mutual Fund / Private Investment / Unknown |
| Net expense ratio | fraction | funds/ETFs; 0 for stocks |
| Asset allocation | fractions over 5 classes | Cash, US Stock, Non US Stock, Bond, Other; drives the allocation dashboard and rebalancer - the one map the app cannot function without |
| Sector weights | fractions over 11 equity sectors **or** 18 bond sectors | equity vs. bond set auto-detected by which keys are present |
| Market-cap mix | fractions over Giant / Large / Medium / Small / Micro | equity funds |
| Credit quality | fractions over AAA / AA / A / BBB / BB / B / Below B / Not Rated | bond funds |
| Country weights | fractions per country, folded to 12 **region weights** via the seeded country->region table | legacy persisted only the folded regions; same is fine |

Each weight map's fractions nominally sum to ~1 (top-N truncation plus an
"Other" remainder is acceptable, as the legacy country handling did).

**Two supported population paths:**

1. **Manual entry (required, the baseline)**: adding a security takes just
   a ticker; every field above is then enterable and editable in the UI.
   The edit-weights forms in sec. 9.10 cover asset class, sector, and market
   cap; the rewrite extends editability to description, type,
   publicly/privately-traded, expense ratio, region weights, and credit
   quality (legacy left several of these read-only or stubbed). The
   classification taxonomies above deliberately match what fund fact
   sheets and Morningstar's public pages display, so a user can read a
   fund's page and key in what they see by hand - that is fine; automated
   collection is not.
2. **Professional data source (optional, later)**: a licensed, ToS-clean
   API supplying some or all of the fields above slots in behind a single
   "populate these fields for ticker X" seam, pre-filling the same
   editable forms rather than bypassing them.

---

## 7. API surface (functional)

The SPA is served with proper SPA deep-link fallback ([legacy bug]: none - 
deep links 404'd). The data API is JSON over HTTP with the session cookie;
unauthenticated requests get 401/403. Legacy conventions worth **not**
keeping: plain-text error bodies, missing Content-Type headers, misused
status codes (500 for missing params, an invalid status 55). The rewrite
returns structured JSON errors with correct status codes.

Required capabilities (legacy endpoint names in parentheses as a
cross-reference; exact paths are the rewrite's choice):

**Session** - login with a Google identity token (`/login`); logout
(`/logout`); a "who am I" check so the SPA can restore state on reload
(new).

**Brokers** - list all with per-broker and grand totals (`/brokers`);
create (`/addbroker`); rename (`/updatebroker`); delete (`/deletebroker`);
hide/unhide (`/hidebrokerage`, `/showbrokerage`); one broker's accounts
with totals (`/accounts`).

**Accounts** - list all accounts across brokers (`/allaccounts`); account
overview with priced positions (`/account`); create (`/addaccount`); update
incl. sweep balance (`/updateaccount`); delete (`/deleteaccount`);
hide/unhide (`/hideaccount`, `/showaccount`); per-ticker lot detail within
an account, including its sale history (`/accountpositiondetails`).

**Positions & trades** - all positions priced (`/positions`); per-ticker
lot details portfolio-wide, optionally inflation-adjusted and filterable by
account (`/positions?ticker=...`); form-support data for the purchase dialog
(`/addpurchaseinfo`); add/edit/delete a purchase lot (`/addpurchase`);
record a multi-lot sale (`/addsale`); delete a sale (`/deletesale`); tax
report over a date range (`/taxreport`).

**Securities & prices** - list securities (`/tickers`); security details
with full price history, chart data, and technical indicators
(`/securitydetails`, `/tickerDetails` - legacy had two near-duplicates;
one endpoint with options suffices); add by ticker (`/addsecurity`);
hide/unhide (`/hidesecurity`, `/showsecurity`); edit classification weight
maps (`/updateassetclassweights`, `/updatesectorweights`,
`/updatemarketcapweights` - extend per sec. 6.3); manual price-history CRUD for
private securities (`/addpricev2`, `/updateprice`, `/deleteprice`).

**Allocation** - current vs. target allocation summary (`/allocation`);
set target allocation (`/setallocation`); rebalance what-if scoring
(`/rebalance`).

Legacy also served hard-coded inline SVG logos for four specific brokers
(`/brokerlogo`) - replace with a real per-broker logo upload or drop logos
entirely (the DB columns existed but were never wired). **Decision
required; recommend dropping logos initially** and showing the broker name.

---

## 8. UI - global specification

### 8.1 Broad-stroke design language

- A **Material Design component library** with the classic indigo primary /
  pink accent theme (the legacy look): colored top toolbar, cards, raised
  buttons, FABs, dialogs, snackbars, tabs, steppers, data tables with
  sorting and pagination, datepickers, selects.
- **Charts**: pie/donut charts, grouped vertical bar charts, a line chart
  with a timeline scrubber, and tiny inline **sparklines** in table rows.
  Legacy pie palette was a reordered 12-color ColorBrewer Set3
  (`#FCCDE5 #8DD3C7 #BEBADA #FB8072 #80B1D3 #FDB462 #B3DE69 #FFFFB3
  #D9D9D9 #BC80BD #CCEBC5 #FFED6F`); line-chart series used
  `#1CBCD8 #FF8D60 #FF586B #AAAAAA`. Any coherent categorical palette is
  fine; keep slices clickable where specified.
- **Iconography**: one icon set from the component library for all actions
  (add, edit, delete, cart) **and** the left-nav items (replacing the
  legacy Iconfinder SVGs - see sec. 2).

### 8.2 Shell and navigation

- Top toolbar: app logo (new artwork), title **"Portfolio Manager"**,
  right-aligned sign-in widget (avatar + menu with name/email and Logout
  when signed in; a Google sign-in button when not).
- Permanently open left sidenav with five entries, highlighting the active
  one: **Securities**, **Brokers**, **Positions**, **Allocation**, **Tax**.
- Routed content in a padded center column; every page is a single card
  with a title, content, and an actions row. Legacy used hash-fragment URLs
  and query-string state; the rewrite should use normal path routing with
  path params, preserving the *statefulness* (every page reachable and
  reloadable by URL, including the selected tab on the security page).
- Unauthenticated access to any page redirects to a **welcome page**
  ("Please log in") that remembers the attempted URL and returns there
  after sign-in.

### 8.3 UX conventions

- All tables: column sorting (sensible defaults per page), pagination,
  totals in a footer row where specified. Sorting of formatted values uses
  the numeric `sort` field, never the display string.
- Every mutation gives feedback via a **snackbar** (short for success,
  longer for errors) and reloads the affected view. No raw `alert()`s.
- **Add confirmation dialogs for destructive actions** (legacy deleted
  lots, prices, accounts with no confirmation - a footgun to fix).
- Forms: submit button validates the whole form and surfaces per-field
  errors on attempted submit; cancel returns to the previous page.
- Currency inputs accept `$` and comma-formatted text.
- Row-level controls may reveal on hover; multi-select checkbox columns
  (with a master toggle) feed the sell flow.
- No client-side polling; data loads on navigation and after mutations.
  (Fix the legacy sparkline N+1: one full security-details fetch per table
  row. Batch or embed sparkline data in the list responses.)

---

## 9. UI - pages and dialogs

### 9.1 Brokerages (nav: Brokers)

Card "Brokerages". Table of brokers: **Name** (links to the broker's
accounts page), **Total Holdings**, **Sweeps**; footer grand totals. Pie
chart "Total Holdings By Broker" (slice click navigates to the broker).
FAB: add broker. Needs a way to reveal hidden brokerages (new - see sec. 4.3).

### 9.2 Add / edit broker

Add: card "Add New Broker", one required text field **Brokerage Name**,
Cancel/Submit. Edit: same single-field form pre-filled, titled "Edit
Broker".

### 9.3 Broker accounts

Card "Accounts at {broker}". Table: **Name** and **Account** (both link to
the account page), **Tax Deferred**, **Sweep Balance**, **Investment
Value**; footer totals. Pie "Total Holdings by Account" (investment +
sweeps; clickable). Actions: add account (FAB), edit broker (FAB), and - 
only when the broker has zero visible accounts - a "Hide this empty
brokerage" button.

### 9.4 Add / edit account

Add: fields **Account Name** (required), **Account Number** (required),
**Tax Status** (select: Taxable / Tax Deferred). Edit adds **Sweeps
Balance** (currency text, required) - this form is where cash balances are
maintained by hand.

### 9.5 Account positions

Card "Positions at {broker} : {account}". Table of positions: **Ticker**
(links to lot detail, sec. 9.7), **Sparkline** (6-month adjusted-close trend),
**Shares**, **Basis**, **Current Value**, **ST Gain**, **LT Gain**. Pie
"Total Holdings by Security" (clickable). Actions: FAB add -> Buy dialog
(sec. 9.8) with the account preselected; FAB edit account; FAB delete account
(enabled only when empty); "Hide this empty account" button when empty.

### 9.6 All positions (nav: Positions)

Same table and pie as sec. 9.5 but portfolio-wide; tickers link to the
security-holdings page (sec. 9.11). Default sort: current value descending.

### 9.7 Lot details for a ticker in one account

Card "Positions for {ticker} in {broker} : {account}". Table of lots with a
select-checkbox column plus: **ID**, **Bought**, **Shares**, **buy
$/share**, **now $/share**, **Comm.**, **Shares Still Held**, **Basis**,
**Current Value**, **ST Gain**, **LT Gain**; hover controls per row: edit
(Buy dialog in edit mode) and delete (with confirmation). Card action:
**Sell** - enabled when >=1 lot is checked - opens the Sell dialog (sec. 9.9).
This page should also show the account's **sale history** for the ticker
(the API returned it; legacy UI never rendered it - worth adding).

### 9.8 Buy Security dialog

Modal, "Purchase Security" / "Edit Position". Fields: **Date** (datepicker,
required), **Account** (select, required), **Security** (select
"{ticker}: {description}", required), **Shares** (number >= 0, required),
**Price Per Share** and **Commission** (currency text, required).
Cancel/Submit; parent view reloads on close.

### 9.9 Sell Security dialog

Modal, 3-step linear stepper:

1. **Sale Summary** - read-only broker/account/ticker; editable **Sale
   Date**, **Shares to Sell**, **Price Per Share**, **Commission** (all
   required, non-negative; helper text: "If you paid no commission, enter
   0 here.").
2. **Pick Lots** - "Please pick {N} shares from these lots:" - the checked
   lots (ID, Bought, Shares Still Held, buy $/share) each with a **Sell
   Shares** input capped at the lot's still-held shares; cross-validation
   that the per-lot amounts sum to the step-1 total.
3. **Submit** - confirmation sentence and the **Sell Lots** button.

Back/Next gated on step validity.

### 9.10 Security details (tabbed)

Header: "{ticker}: {description}", "Publicly/Privately Traded", and **Net
Expense Ratio** with a working edit affordance (legacy stub). Selected tab
is reflected in the URL. Tabs:

1. **Price History** - line chart of adjusted daily close with timeline
   scrubber; **Technical Indicators** select (None / Bollinger Bands / SMA
   / EMA) overlays the chosen series; **Duration** select (All / 1 Year /
   1 Quarter / 1 Month) filters client-side; a toggle for
   inflation-adjusted display (designed in legacy, never wired - wire it).
   For privately traded securities, a button to the price-history editor
   (sec. 9.12).
2. **Asset Allocation** - pie of the five classes plus an inline edit form:
   one percent field per class, read-only until "Edit ... Weights" is
   clicked; per-field 0-100 validation and a must-sum-to-100 cross
   validator; Cancel / Save.
3. **Sector Weights** (when present) - same pie + edit-form pattern over
   the equity or bond sector set (auto-detected).
4. **Market Cap** (when present) - same pattern over the five cap sizes.
5. **Region** (when present) - pie; make editable (legacy read-only).
6. **Credit Quality** (when present) - pie; make editable. ([legacy bug]:
   a template typo meant this tab never rendered at all.)

Card action: **Holdings** -> sec. 9.11.

### 9.11 Security holdings across accounts

Card "Positions for {ticker} in All Accounts". Checkbox **"Adjust costs for
inflation"** (reloads; affected column headers get a * footnote). Lot table
as sec. 9.7 plus an **Account** column. Actions: **Security Details** -> sec. 9.10;
**Hide this Security** when no positions remain.

### 9.12 Private price history editor

Card "Edit Privately Traded Price History for {ticker}". Table: **Date**,
**Price**, hover edit/delete controls (delete confirms). FAB add. Add/edit
use a small dialog: **Date** (datepicker) + **Price Per Share**, both
required (actually validated, unlike legacy).

### 9.13 Allocation dashboard (nav: Allocation)

Card "Asset Allocation". Two clickable pies: **Current Allocation** and
**Target Allocation** (the target pie carries an edit affordance opening
the target-allocation dialog). Two grouped bar charts: current-vs-target
percent per class, and delta dollars per class ("Asset Changes Required
Without Investing"). Table: **Asset Class** (links to sec. 9.15), **Total
Holdings**, **Target Holdings**, **Delta**, **Percent**, **Target
Percent**; footer total. Card action: **Rebalance through Purchases**.

**Edit Target Asset Allocation dialog**: five percent fields (Bonds, Cash,
Non US Stock, Other, US Stock), each 0-100, must sum to 100; Cancel/Submit.

### 9.14 Rebalance planner

Card "Rebalance". "The Plan" form: **Account** select (shows each
account's sweeps), **Add Funds to Sweeps** (currency text), read-only
**Spent So Far** and **Still to Spend**. Re-scores via the server on every
change. **Rebalance Purchases** table (the cart): Ticker, Buy Shares, Cost,
remove-from-cart action. **Allocation** table: **Name**, **Before**,
**After**, **Target**, **Residual Imbalance**, and per-class actions: a
**buy** button (disabled when the class is at/over target) opening the
Rebalance-Buy dialog; a sell affordance is optional (legacy stub).

**Rebalance-Buy dialog** ("Propose Security Purchase for Rebalance"):
**Security** select from the class's candidate funds (auto-fills suggested
shares, price, cost), **Shares** and **Net Cost** as mutually updating
fields (edit either; the other recomputes via price), **Price Per Share**
read-only. Submit adds the trade to the cart; no server mutation.

### 9.15 Allocation class details

Card "Positions in {assetClass}". Table: **Ticker** (links to sec. 9.10),
**Sparkline**, **Contribution to {class}** (dollars); pie of contributions.

### 9.16 Tax report (nav: Tax)

Card "Tax Report", defaulting to the previous calendar year. **From**/**To**
datepickers (From <= To) + Submit. Table: **Broker**, **Account**,
**Ticker**, **Date Bought**, **Date Sold**, **Purchase Price/Share**,
**Sale Price/Share**, **Purchase Costs**, **Sale Costs**, **Short Term
Gain**, **Long Term Gain** (zero values rendered blank); footer totals.

### 9.17 Securities list (nav: Securities)

Card "Securities". Table: **Ticker** (links to sec. 9.10), **Sparkline**,
**Description**. FAB: add security (sec. 9.18). Needs a way to reveal hidden
securities (new).

### 9.18 Add security

Card "Add New Security". **Ticker** (required), Cancel/Submit. Post-add,
classification data is entered manually via sec. 9.10's edit forms (see sec. 6.3 - 
the legacy Morningstar auto-populate is gone).

---

## 10. Non-functional requirements

- **Startup resilience**: the server must start without internet access
  (embedded/cached CPI snapshot; lazy provider connections). External
  fetches happen in the background with retry; failures degrade the
  affected feature, not the process.
- **Caching discipline**: legacy cached portfolios, securities, accounts,
  and price sources in-process, mostly without locks and often forever.
  The rewrite should either not cache at that layer or cache with correct
  invalidation and thread safety.
- **Concurrency**: bulk pricing fans out; all shared state is
  race-free.
- **Testability**: business rules (lots/FIFO/gains, allocation, rebalance,
  inflation, fixed-point/currency arithmetic, technical indicators) are
  unit-testable without a live database or network; database code testable
  against a mock or embedded DB (legacy used SQL mocking to good effect - 
  preserve that property).
- **Config over hard-coding**: server URLs, ports, allowed origin, OAuth
  client, provider API keys, DB coordinates all come from configuration.
  (Legacy hard-coded the API base URL in the SPA, the CORS origin, broker
  logos, and a personal prefetch ticker list.)
- **Not real-time**: prices may be a day stale by design; nothing needs
  sub-daily updates.

---

## 11. Explicitly out of scope / dropped from legacy

- Morningstar scraping (dead endpoints, ToS risk) - replaced by manual
  entry (sec. 6.3).
- IEX Cloud provider (service shut down) - providers are pluggable config.
- Hard-coded inline SVG broker logos and the unused logo DB columns
  (pending the sec. 7 decision).
- The legacy `historical_investment_value` and `country_weights` proto
  fields (never persisted or rendered). Country->region mapping stays as
  seed data.
- The deprecated duplicate endpoints (`/addprice` vs `/addpricev2`, the
  `/securitydetails` vs `/tickerDetails` split).
- Multi-currency UX (the unit field remains in the data model; everything
  visible is USD).
- The legacy two-port UI/data split and its CORS shim, if the rewrite
  serves one origin.

## 12. Legacy defect register (fix, don't port)

Collected from the code read; each is specified correctly above.

1. Logout didn't invalidate the operative auth cookie; cookie flags weak
   (sec. 3.1). Google signing keys cached forever (sec. 3.1).
2. No user allowlist - any Google account got a portfolio (sec. 3.2).
3. Money/dates stored as formatted strings; no DB-side ordering (sec. 4.3).
4. Global (not scoped) uniqueness of tickers and account nicknames (sec. 4.3).
5. Tax-report query not portfolio-scoped (sec. 5.3). Two different long-term
   thresholds (sec. 5.1).
6. Unhide endpoints unimplemented; hidden items unreachable (sec. 4.3).
7. Sale validation absent server-side; lots editable out from under their
   sales (sec. 5.9).
8. `/positions?ticker&id` account filter kept only the last matching lot.
9. Security-details endpoint 500'd for public tickers via an unsupported
   chart-URL call; inflation flag on the details call was dropped by the
   SPA; credit-quality tab never rendered (template typo); sector-weights
   tab referenced nonexistent component state; expense-ratio edit and
   rebalance-sell were `alert()` stubs.
10. Invalid HTTP status 55; 500s for missing params; plain-text errors;
    missing Content-Type; CORS origin/port mismatch; no SPA deep-link
    fallback; dead favicon handler.
11. Sparkline N+1 fetches (sec. 8.3). Sign-in state lost on page reload (sec. 3.1).
12. Price-server concurrency bugs: worker-goroutine leak on coalesced
    requests, missing return causing double fetch/callback, race on the
    pending-request map (sec. 6.1). IEX adjusted-close JSON tag typo made all
    adjusted closes zero.
13. CPI fetched once at startup, process dies offline (sec. 10); inflation
    applied in opposite directions by two code paths (sec. 5.7).
14. Snackbar typo "position deteted"; seed-data country typos (sec. 4.2).
15. In-process caches without locks or invalidation (sec. 10).
