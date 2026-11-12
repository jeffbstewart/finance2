-- Reference-data population, separate from DDL by ruling (build-scope
-- §9). The five spec asset classes (FUNCTIONAL_SPEC §4.2); a future
-- class (e.g. 'Commodities', build-scope §6) is a new versioned
-- migration like this one.
INSERT INTO asset_classes (name, display_order) VALUES
    ('Cash', 1),
    ('US Stock', 2),
    ('Non US Stock', 3),
    ('Bond', 4),
    ('Other', 5);
