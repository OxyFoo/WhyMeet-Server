-- Track in-place account recreations (same id + email reused after self-deletion).
-- The original `users_email_key` unique index stays in place; recreation reuses
-- the existing user row instead of inserting a new one.
ALTER TABLE "users" ADD COLUMN "recreatedAt" TIMESTAMP(3);
