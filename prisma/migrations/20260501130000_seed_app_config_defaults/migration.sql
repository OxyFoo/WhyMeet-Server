-- Seed default runtime settings in app_config.
-- Safe to run multiple times: existing values are preserved.
INSERT INTO "app_config" ("key", "valueInt") VALUES
    ('counter.search.daily.free', 3),
    ('counter.search.daily.premium', 20),
    ('counter.swipe.daily.free', 20),
    ('counter.swipe.daily.premium', -1),
    ('counter.activity_open.daily.free', 3),
    ('counter.activity_open.daily.premium', 25),
    ('counter.search.initial', 5),
    ('subscription.boost.days', 10)
ON CONFLICT ("key") DO NOTHING;
