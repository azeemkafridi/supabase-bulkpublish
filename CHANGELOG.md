# Changelog

## 1.0.0 (2026-11-24)

- First release. A `bulkpublish_posts` table, a trigger that publishes rows
  set to `ready`, a once-a-minute run that reads back results, and the
  `bulkpublish` Edge Function.
- Media from this project's Storage (`storage:<bucket>/<path>`), any public
  URL, or the BulkPublish media library (`bulkpublish:<id>`).
- Passing errors are retried; a row already sent can't be set to `ready`
  again until it finishes.
- Scheduling, team approval, Discord channel choice and channel sets.
