# BulkPublish for Supabase

Publish and schedule social posts from a Supabase table. Insert a row, set its
`status` to `ready`, and it goes out to your connected networks through
[BulkPublish](https://bulkpublish.com). The post URLs, or the exact error,
are written back into the same row.

Works with all 15 networks BulkPublish publishes to: Facebook, Instagram,
X (Twitter), TikTok, YouTube, Threads, Bluesky, Pinterest, Google Business
Profile, LinkedIn, Mastodon, Discord, Telegram, Tumblr and Snapchat.

```sql
insert into bulkpublish_posts (caption, channels, media, status)
values (
  'We just shipped dark mode 🌙',
  '{x, linkedin, threads}',
  '{storage:marketing/dark-mode.png}',
  'ready'
);
```

A few seconds later:

| status | result |
|---|---|
| `posted` | `x: https://x.com/acme/status/…`<br>`linkedin: https://www.linkedin.com/feed/update/…`<br>`threads: https://www.threads.net/@acme/post/…` |

Use it to post from your own app (a user publishes a listing, a changelog
entry goes live), from a scheduled job, or from any tool that can write a row.

## What gets installed

- **`bulkpublish_posts`**, a table that is your posting queue.
- **A database trigger** that starts publishing as soon as a row is set to
  `ready`.
- **A once-a-minute job** that picks up anything the trigger missed and reads
  back the result of posts that were scheduled, waiting for approval, or still
  publishing.
- **The `bulkpublish` Edge Function**, which does the publishing.

Row Level Security is on for the table with no policies, so only your
server-side code (the service role) can read or write it until you add
policies of your own.

## Setup

You need a Supabase project, the [Supabase CLI](https://supabase.com/docs/guides/cli),
and a BulkPublish account with at least one connected channel.

**1. Create a BulkPublish API key** at
[app.bulkpublish.com/developer](https://app.bulkpublish.com/developer).
It starts with `bp_`. A key with publishing rights is needed (a read-only key
can't post).

**2. Get the code into your project.** Either clone this repository and link
it to your project:

```bash
git clone https://github.com/azeemkafridi/supabase-bulkpublish
cd supabase-bulkpublish
supabase link --project-ref <your-project-ref>
```

or copy `supabase/migrations/*` and `supabase/functions/bulkpublish/` into the
`supabase/` folder of a project you already manage with the CLI, and add the
`[functions.bulkpublish]` block from `supabase/config.toml` to yours.

**3. Pick a shared secret** the database uses to call the function, and save
it with your API key as function secrets:

```bash
SECRET=$(openssl rand -hex 32)
supabase secrets set BULKPUBLISH_API_KEY=bp_your_key BULKPUBLISH_WEBHOOK_SECRET=$SECRET
echo $SECRET   # you need it again in step 5
```

**4. Deploy the function and create the table:**

```bash
supabase functions deploy bulkpublish --no-verify-jwt
supabase db push
```

`--no-verify-jwt` is required: the database calls the function without a
user's sign-in, and the function checks the shared secret instead.

**5. Tell the database where the function is.** In the dashboard's SQL Editor:

```sql
select vault.create_secret('https://<your-project-ref>.supabase.co/functions/v1/bulkpublish', 'bulkpublish_function_url');
select vault.create_secret('<the secret from step 3>', 'bulkpublish_webhook_secret');
```

That's it. Insert a row with `status = 'ready'` to test it.

## Columns

You write these:

| Column | Type | What to put in it |
|---|---|---|
| `caption` | text | The post text. Checked against each network's length limit before anything is sent (X 280, Bluesky 300, Threads 500, LinkedIn 3000, Instagram and TikTok 2200, and so on). |
| `channels` | text[] | Where to post. Each value is a network name (`x`, `linkedin`, `gmb` for Google Business Profile), which means every connected account on that network; an account name; a channel id; or the name of a channel set you saved in BulkPublish. |
| `media` | text[] | Optional images, videos or documents, up to 100 MB each. Use `storage:<bucket>/<path>` for a file in this project's Storage, or any public `https://` URL. |
| `scheduled_at` | timestamptz | Optional. Empty publishes now; a future time schedules the post. |
| `timezone` | text | Optional IANA zone shown on the post in BulkPublish, such as `America/New_York`. |
| `request_approval` | boolean | Hold the post until a teammate approves it in BulkPublish. Without a time it publishes as soon as it is approved. |
| `discord_channel` | text | For Discord: the text channel to post in, by name (`#announcements`) or id. Can be left empty if the Discord connection has a default channel. |
| `status` | text | `draft` (default, ignored) or `ready` (publish it). |

These are written back for you:

| Column | Meaning |
|---|---|
| `status` | `posting` → `posted`, `partial` (some networks failed), or `failed`. Also `scheduled` and `pending_approval`, which move on by themselves once the time comes or the post is approved. |
| `result` | The post URLs, one per line, or the error. Errors name the network and say what to change. |
| `post_urls` | The same per network, as JSON: `[{ "platform", "channelId", "status", "url", "error" }]`. |
| `bulkpublish_post_id` | The post in BulkPublish, which you can open at [app.bulkpublish.com/posts](https://app.bulkpublish.com/posts). |

## Recipes

**Post when something in your app is published.** A trigger on your own table:

```sql
create or replace function public.announce_release()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.published and not coalesce(old.published, false) then
    insert into public.bulkpublish_posts (caption, channels, status)
    values (new.title || ' is out: ' || new.url, '{x, linkedin, bluesky}', 'ready');
  end if;
  return new;
end;
$$;

create trigger announce_release after insert or update of published on public.releases
for each row execute function public.announce_release();
```

**Queue a week of posts.** Insert rows with `scheduled_at` and `status = 'ready'`.
Each is sent to BulkPublish straight away as a scheduled post, so you can see
and edit it in the BulkPublish calendar; the row moves to `posted` after it
goes out.

**From your app's server code:**

```ts
await supabase.from("bulkpublish_posts").insert({
  caption: "New in the shop: the autumn collection",
  channels: ["instagram", "facebook", "pinterest"],
  media: ["storage:products/autumn.jpg"],
  status: "ready",
});
```

Use the service role key, or add an insert policy for the users you want to
allow.

**Let signed-in users see their own rows.** Add an `owner uuid default auth.uid()`
column and the policies you need. Nothing here depends on the table having
no other columns.

## Good to know

- **A row is never posted twice by accident.** Setting a row to `ready` claims
  it once, however many times the function is called. To post the same thing
  again, set it back to `ready` after it finished, or insert a new row.
- **If something goes wrong between creating the post and hearing back,** the
  row is marked `failed` with a note to check BulkPublish first, rather than
  being retried, since the post may already be live.
- **Plan limits apply.** Rows count toward your BulkPublish plan's posts and
  storage like any other post. If a limit is reached, the row fails with the
  reason.
- **Roles.** If your API key belongs to a team member who needs approval to
  publish, rows fail with a note to set `request_approval`.
- **Logs** are under Edge Functions → `bulkpublish` → Logs in the dashboard.
- **Stopping it:** `select cron.unschedule('bulkpublish-sweep');` and
  `drop trigger bulkpublish_posts_on_ready on public.bulkpublish_posts;`.

## Development

```bash
npm test           # unit tests for the publishing logic (Node 22.6+)
npm run test:sql   # runs both migrations against a throwaway local Postgres
```

`npm run test:sql` creates and drops its own database. Point it somewhere
else with `PGURL=postgres://user@host:5432`.

## Support

[help.bulkpublish.com](https://help.bulkpublish.com) or the chat on
[bulkpublish.com](https://bulkpublish.com).

## License

MIT
