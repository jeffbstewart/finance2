# Decision 4 - market-data price providers

**Status:** Assessment complete (2026-08-19); recommendation below - 
Jeff decides. Target: **at least two providers** behind the pluggable
interface (ruling, 2026-08-19).
**Relates to:** MODERNIZATION Phase 4 / decision-table row 4,
FUNCTIONAL_SPEC sec. 6.1, docs/design/initial-build-scope.md sec. 7.

## Requirements (from the spec)

Per public ticker: daily bars - date, raw close, split/dividend-
**adjusted close**, open/high/low, dividend amount, split coefficient,
volume. Coverage for stocks, ETFs, **and mutual funds** (the
discriminating requirement - several providers skip funds). Two fetch
depths: recent (~1 month) and full history. Not real-time - a day
stale is fine. Volume is tiny: one user, dozens of tickers, and the
price module caches with a multi-hour TTL, so tens of requests per day
even without care.

Constraints: ToS must permit an open-source *client* (we never commit
provider data - repo policy); API key in `.env`; every shipped source
validated against its live API in an integration-test mode
(MODERNIZATION goal 4).

## The field (verified 2026-08-19, links below)

| Provider | Adjusted daily + divs/splits | Mutual funds | Free tier | Paid | Verdict |
|---|---|---|---|---|---|
| **Tiingo** | Yes - EOD endpoint returns exactly the spec's field list (`adjClose`, `divCash`, `splitFactor`, OHLCV) | **Yes** - 80k+ assets incl. MF NAVs (posted ~midnight ET), history to 1962 | **250 calls/day**, full history | $10-30/mo tiers if ever needed | **Primary** |
| **EODHD** | Yes - EOD API includes adjusted close (splits+dividends), splits and dividends endpoints | **Yes** (MF NAVs next morning) | 20 calls/day, **past year only** | EUR 19.99/mo "All World" removes both limits | **Fallback** |
| Twelve Data | EOD endpoint; dividend-adjustment gating across plans is murky | Partially (plan-dependent) | 800 calls/day, 8/min | $29+/mo | Honorable mention; gating too unclear to rely on |
| Alpha Vantage | **Adjusted daily is premium-only** ($49.99/mo); free tier is raw OHLCV at 25 calls/day | Partial | 25 calls/day, raw only | $49.99/mo+ | Fails the adjusted-close requirement on free; poor value paid |
| Polygon.io | Yes (stocks/ETFs) | **No mutual funds** | 5 calls/min | $29+/mo | Fails the MF requirement |
| Finnhub | Historical candles moved to paid | Weak | Quote-only free | $50+/mo | Fails on free tier |
| Yahoo/scraping | - | - | - | - | Excluded on the same ToS grounds as Morningstar (spec sec. 6.3) |

Legacy context: IEX Cloud is dead (Aug 2024) and Alpha Vantage - the
legacy survivor - lost its free adjusted-daily endpoint, which is what
made this decision necessary.

## Recommendation

**Tiingo primary, EODHD fallback.**

- **Tiingo** is a near-perfect fit: its EOD response is the spec's
  field list verbatim, mutual funds are first-class, full history is
  one request, and 250 calls/day is ~10x this app's ceiling. Free.
- **EODHD** as the second provider: same field coverage including
  funds. Its free tier (20 calls/day, one year of history) is exactly
  shaped for **fallback duty** - the "recent (~1 month)" fetch depth
  when Tiingo is down or quota-limited. If the fallback ever needs
  full history (e.g. Tiingo has an extended outage during a
  first-fetch of a new ticker), EUR 19.99/mo removes the limits; nothing
  in the design depends on paying.
- Failover semantics: the price module tries the primary; a typed
  quota/outage detection triggers the fallback for that request.
  Provider order is configuration (`.env`), per the spec's
  "provider choice is configuration."
- Both keys ride `.env` (`TIINGO_API_KEY`, `EODHD_API_KEY`);
  integration tests hit the live APIs only when the key is present,
  and skip otherwise, so CI needs no secrets.
- **Persistence boundary (clarified, Jeff 2026-08-19):** fetched
  prices persist to the **local encrypted database only** (a
  market_prices table with provenance - it doubles as the spec sec. 6.1
  restart-surviving cache). Provider data never enters the source
  repo: no committed responses, no captured test fixtures (unit tests
  use synthetic JSON shaped like the API). The committed CPI snapshot
  is not an exception to this rule - it is public-domain US
  government data, per the Phase 1 licensing assessment.

Sources: [Tiingo EOD product](https://www.tiingo.com/products/end-of-day-stock-price-data),
[Tiingo corporate actions](https://www.tiingo.com/documentation/corporate-actions/splits),
[Alpha Vantage premium](https://www.alphavantage.co/premium/),
[Alpha Vantage docs](https://www.alphavantage.co/documentation/),
[EODHD EOD API](https://eodhd.com/financial-apis/api-for-historical-data-and-volumes),
[EODHD historical prices](https://eodhd.com/lp/historical-eod-api),
[Twelve Data docs](https://twelvedata.com/docs).
