# Composite index for the Inbox history query (PR-B)

**Status: proposal. NOT a migration and NOT applied.** It needs explicit authorization and is created by hand, outside the migration runner.

## Why
The thread now asks for `WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 101` (and the same with a
`(created_at, id) <` keyset cursor). Only `idx_messages_conversation (conversation_id)` exists, so PostgreSQL reads **every** row of the
conversation, sorts them, and keeps 101. Read-only `EXPLAIN` on production (conversation with 1,239 messages, 2026-11-10):

```
Limit -> Sort (created_at DESC, id DESC) -> Bitmap Heap Scan on messages
           Recheck Cond: conversation_id = ...  ->  Bitmap Index Scan on idx_messages_conversation
```

`messages` is ~1.5M rows / 501 MB heap / 1000 MB total (rows are ~900 bytes wide). With the proposed DESC composite index, the planner can use a forward index scan
(or index-only scan where possible) and stop after 101 rows without sorting the full thread. The page works without the index (correctness does not depend on it);
the index only bounds the cost of long threads.

## SQL
```sql
-- Cannot run inside a transaction, so it is NOT in supabase/migrations/.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation_created_id
  ON public.messages (conversation_id, created_at DESC, id DESC);
```
Rollback: `DROP INDEX CONCURRENTLY IF EXISTS public.idx_messages_conversation_created_id;` (no application change needed).

## Safe procedure
1. Off-peak. Check there is no long transaction / blocking lock: `select pid, state, now()-xact_start from pg_stat_activity where xact_start < now() - interval '1 minute';`
2. Disk headroom: expect roughly 60-100 MB (1.5M entries of uuid + timestamptz + uuid + btree overhead). Current free space is ~60 GB.
3. `SET statement_timeout = 0; SET lock_timeout = '5s';` then run the `CREATE INDEX CONCURRENTLY` above in its own session (psql, autocommit). It takes
   a `SHARE UPDATE EXCLUSIVE` lock: reads and writes continue; concurrent index builds wait for older transactions, so step 1 matters.
4. Verify it is valid: `select indisvalid from pg_index where indexrelid = 'public.idx_messages_conversation_created_id'::regclass;` must be `t`.
   If it is `f` (interrupted build), `DROP INDEX CONCURRENTLY` it and retry.
5. Confirm the plan with `EXPLAIN` (no ANALYZE): an Index Scan using the new composite index (a forward scan for its DESC order), no separate Sort node. Do not require the literal `Backward` keyword.
6. Optional but recommended separately: `ANALYZE public.messages;` The planner's row estimates for `messages` are stale (`pg_stat_user_tables`
   reports ~28k live tuples against ~1.5M real rows; no autovacuum/autoanalyze has run on it).

## Cost
One extra index to maintain on every message insert/status update that touches indexed columns (status updates do not change these
columns, so they stay HOT-eligible where possible). Insert rate is low (hundreds per hour); the overhead is negligible.
