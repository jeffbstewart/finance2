-- Monthly US CPI-U index observations (FRED series CPIAUCSL), the
-- data behind inflation-adjusted presentation (FUNCTIONAL_SPEC §5.7).
-- Seeded from the embedded snapshot at startup and refreshed weekly in
-- the background; month is the first of the month.
CREATE TABLE cpi_observations (
    obs_month DATE PRIMARY KEY,
    index_value NUMERIC(12,4) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
