-- contact_chat_media_candidates() decides whether a Storage object is still used by a message of ANOTHER chat by scanning the whole
-- messages table (~1.56 M rows, ~61 k pages read per call) because messages.media_url has no index. That fixed cost is paid once per
-- bulk-delete batch and, on a cold cache, exceeds the API role's 8 s statement_timeout (SQLSTATE 57014).
-- Index only: no data, function, grant, policy or timeout change; delete semantics are unchanged. Partial on IS NOT NULL (equality lookups
-- imply it). Measured on a copy of the production column: ~16 MB, because the ~38 k distinct URLs are heavily duplicated and btree
-- deduplicates them. Plain CREATE INDEX like the rest of the repo (migrations run inside a transaction); on a live database it may be
-- built first with CREATE INDEX CONCURRENTLY IF NOT EXISTS using the same name and predicate, which makes this file a no-op.
-- It is consumed by 20261119000002 (EXISTS probe in contact_chat_media_candidates); apply this file first.

CREATE INDEX IF NOT EXISTS idx_messages_media_url ON public.messages (media_url) WHERE media_url IS NOT NULL;
