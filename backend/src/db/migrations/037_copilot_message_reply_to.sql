-- Plan 32 D-32-4 (R3): each assistant row records the question row it answers.
--
-- Additive only — one new nullable column on copilot_messages, no change to any existing row.
-- Set by the co-pilot route for every assistant row written from now on, so removing a stopped
-- exchange pairs a question with its reply exactly, never by message order. NULL means a row
-- written before this migration (no backfill by design): the remove service pairs those by
-- order, and refuses rather than guess when another user's question sits between the two.
ALTER TABLE copilot_messages ADD COLUMN reply_to TEXT;
