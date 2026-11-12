-- Trust-class securities (docs/design/plaid-investments-pipeline.md,
-- amended 2026-08-22). `ticker` stays the portfolio-unique short
-- symbol the human chooses; it is no longer what the price feeds are
-- keyed on:
--
--   market_ticker        the provider symbol, required for MARKET
--                        locus, NULL for hand-priced securities (a
--                        401(k) collective investment trust has none)
--   cusip, isin          identifiers as the institution reports them;
--                        a second import-matching key when present
--   mirrors_security_id  the public fund this trust is the
--                        institutional class of: its classification
--                        mix applies, and its dense price history is
--                        charted beside the trust's sparse actuals
ALTER TABLE securities ADD COLUMN market_ticker VARCHAR(32);
ALTER TABLE securities ADD COLUMN cusip VARCHAR(9);
ALTER TABLE securities ADD COLUMN isin VARCHAR(12);
ALTER TABLE securities ADD COLUMN mirrors_security_id BIGINT REFERENCES securities(id);

-- Every market-priced security so far was keyed by its symbol.
UPDATE securities SET market_ticker = ticker WHERE pricing_locus = 'MARKET';
