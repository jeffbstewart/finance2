# Decision 1 — License & IP suitability assessment

**Status:** Proposed — Jeff decides (merging the accompanying LICENSE
adopts it).
**Date:** 2026-07-17.
**Recommendation: adopt Apache-2.0.** Nothing the project touches
conflicts with it. A NOTICE file is **deferred** until something
actually requires one (triggers below).

## 1. Inherited code: jlog

Verified in the legacy tree (`src/stewart.net/jlog/`): jlog is a fork
of `golang/glog`, **Apache-2.0, Copyright 2013 Google Inc.**, with four
documented local modifications (`README.stewart.net`).

**Assessment:** license-compatible, but **do not port it**. Decision 0
already replaces it with platform-standard logging (JVM: SLF4J/Logback,
as the MediaManager base uses). No jlog code in finance2 → no Google
attribution obligation. If any of it were ever ported, the Apache-2.0
header and a NOTICE entry crediting Google would be required — recorded
here as the trigger.

## 2. Cribbed code: MediaManager and the other reference repos

- **MediaManager** — MIT, Copyright (c) 2026 Jeffrey B. Stewart.
  MIT→Apache-2.0 is fully compatible; when code is cribbed (corollary 3
  extraction), carry the MIT notice — a NOTICE entry and/or a comment
  in derived files. Since the copyright holder is the same person, risk
  is nil; the attribution is hygiene for downstream users.
- **h2-kotlin-toolkit / auth-kotlin-toolkit** — MIT, same copyright
  holder; same treatment if used.
- **touchvault / bankferry** — Apache-2.0, Copyright 2026 Jeffrey B.
  Stewart, with their own NOTICE files. Same-license, same-owner;
  patterns referenced freely, code copied gets a NOTICE entry.

## 3. Assets: the Omega icon

Verified in the legacy tree (`finance/omegaIcon/README.txt` + receipt):
purchased from Iconfinder on 2018-10-05 under the **Iconfinder Basic
license** — permits commercial *use*, does **not** permit
redistribution/sublicensing, which publishing it in an Apache-2.0 repo
would effectively do.

**Assessment: excluded from finance2, confirmed.** Replacement options
(decide at Phase 6, no need now): render an Ω glyph from an OFL-licensed
font into an original SVG, use an Apache-2.0 icon set (e.g. Material
Symbols), or draw an original mark (Jeff's copyright, licensed with the
repo). Requirement recorded: **no asset lands in the repo without a
redistribution-compatible license.**

## 4. Data-provider terms (researched 2026-07-17)

Two questions per provider: (a) may we publish an open-source client
that uses the API with the user's own key; (b) may we store returned
data locally in a private DB (never committing data to the repo).

| Provider | OSS client | Local storage | Flags |
|---|---|---|---|
| **AlphaVantage** | **Explicitly welcomed** (official FAQ encourages open-source wrappers; offers their logo) | OK — personal-use grant; redistribution needs a commercial license | Wrapper etiquette: preserve their JSON/CSV error responses verbatim. Free tier ~25 req/day |
| **Tiingo** | Silent; community wrappers commonplace | OK — "internal consumption only" (§7.3) covers a private DB; redistribution needs a paid license | "Data sourced by Tiingo" attribution applies only if a redistribution license is ever obtained |
| **Finnhub** | Silent; commonplace | OK while subscribed — but **no sharing of data *or derived results***, and **stored data must be deleted when the subscription ends** | Strictest derived-results language of the group; personal plans are personal-use only |
| **Polygon.io → "Massive"** (rebranded; polygon.io/terms redirects to massive.com) | Silent; Massive publishes its own OSS SDKs | **Greyest of the group**: market-data terms say "display use only" and require **deletion on termination**; targeted at real-time/delayed exchange data — EOD aggregates are lower risk | Personal, non-commercial tier; non-professional certification applies. If chosen, prefer EOD endpoints |
| **ECB reference FX rates** | Free publication, no key, no gate | **Explicitly permitted, with attribution**: "the ECB must be cited as the source" | **The one affirmative obligation in the set**: show "Source: European Central Bank" wherever ECB rates appear (UI/reports/exports). Rates are informational — don't present them as transaction rates |
| **Plaid** | Effectively endorsed — Plaid open-sources its own quickstart integrations | OK — end-user data stored locally, authorized by the end user (who is the operator); **must be encrypted at rest**; never sell/share; never store bank login credentials | **Hard rule: client_id/secret never in the repo** (matches the `.env`/keyring policy). The MediaManager-pattern AES-encrypted H2 file satisfies the encrypted-storage requirement |

**Cross-cutting conclusions:**

1. **Nothing blocks the Apache-2.0 public client at any provider.**
2. **Provider data never lands in git** — already the plan; for Tiingo,
   Finnhub, and Massive it is also a ToS violation, not just hygiene.
   The `.gitignore`/`.aiignore` skeleton must cover the data and
   snapshot directories from the first commit.
3. **Per-user keys**: the README should state that each user of the
   public repo must obtain their own API keys under each provider's own
   terms (free tiers are personal-use).
4. **Retention duties**: Finnhub and Massive require deleting stored
   data when a subscription ends — worth a line in the eventual admin
   docs if either is chosen in Decision 4.

## 5. Planned dependency licenses (verified where load-bearing)

| Dependency | License | Note |
|---|---|---|
| H2 | MPL-2.0 / EPL-1.0 (dual) | Weak file-level copyleft; fine as an unmodified dependency |
| Flyway Community | Apache-2.0 | Confirmed still Apache-2.0 under Redgate (2026) |
| Armeria, HikariCP, gRPC, Connect-ES/protoc-gen-es | Apache-2.0 | |
| jdbi-orm / vok-orm | MIT | |
| protobuf | BSD-3 | |
| Angular | MIT | |

All compatible with an Apache-2.0 application. None are redistributed
in source form by this repo; binary/Docker distributions should carry a
generated third-party license report (MediaManager's
`THIRD_PARTY_LICENSES.md` + OWASP dependency-check pattern covers
this).

## 6. Scrapers

The legacy Morningstar HTML scraper is **not ported** (already recorded
in Decision 0): unlicensed scraping is inappropriate to publish in a
public repo, independent of license choice. Fund-composition data, if
wanted, comes from a licensed API chosen in Phase 4 or is dropped.

## 7. NOTICE file policy

No NOTICE ships today because nothing yet requires one. Triggers that
create/extend it:

- First MediaManager/toolkit-derived code lands → MIT attribution entry.
- Any jlog/glog code ports (not planned) → Google Apache-2.0 entry.
- ECB rates ship in the product → source citation in UI **and** a
  NOTICE line.
- Any copied Apache-2.0 code with its own NOTICE (touchvault/bankferry)
  → carry the relevant entries.

## Recommendation

Adopt **Apache-2.0** via the LICENSE file in this PR. Defer NOTICE per
the triggers above. Record the icon-replacement requirement for
Phase 6, the data-directory ignore requirement for the bootstrap
skeleton, and the ECB attribution + provider-retention notes for
Phases 4–6.
