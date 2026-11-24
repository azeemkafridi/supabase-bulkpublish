<div align="center">
  <img alt="BulkPublish Logo" src="logo.svg" width="220"/>

  <h1>BulkPublish for Supabase</h1>

  <p><strong>Publish and schedule social posts to 15 networks from a Supabase table.</strong></p>

  <p>
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT">
    <img src="https://img.shields.io/badge/Platforms-15-orange.svg" alt="15 Platforms">
    <img src="https://img.shields.io/badge/Supabase-Edge%20Function-3ECF8E.svg" alt="Supabase Edge Function">
    <img src="https://img.shields.io/badge/Setup-5%20minutes-brightgreen.svg" alt="Setup in 5 minutes">
  </p>

  <p>
    <img alt="Facebook" src=".github/assets/platforms/badges/facebook.svg" width="36">
    <img alt="Instagram" src=".github/assets/platforms/badges/instagram.svg" width="36">
    <img alt="X / Twitter" src=".github/assets/platforms/badges/x.svg" width="36">
    <img alt="TikTok" src=".github/assets/platforms/badges/tiktok.svg" width="36">
    <img alt="YouTube" src=".github/assets/platforms/badges/youtube.svg" width="36">
    <img alt="Threads" src=".github/assets/platforms/badges/threads.svg" width="36">
    <img alt="Bluesky" src=".github/assets/platforms/badges/bluesky.svg" width="36">
    <img alt="Pinterest" src=".github/assets/platforms/badges/pinterest.svg" width="36">
    <img alt="Google Business" src=".github/assets/platforms/badges/gmb.svg" width="36">
    <img alt="LinkedIn" src=".github/assets/platforms/badges/linkedin.svg" width="36">
    <img alt="Mastodon" src=".github/assets/platforms/badges/mastodon.svg" width="36">
    <img alt="Discord" src=".github/assets/platforms/badges/discord.svg" width="36">
    <img alt="Telegram" src=".github/assets/platforms/badges/telegram.svg" width="36">
    <img alt="Tumblr" src=".github/assets/platforms/badges/tumblr.svg" width="36">
    <img alt="Snapchat" src=".github/assets/platforms/badges/snapchat.svg" width="36">
  </p>

  <p>
    <a href="https://app.bulkpublish.com/register"><strong>Get Started »</strong></a> ·
    <a href="#setup">Setup</a> ·
    <a href="https://app.bulkpublish.com/docs">API Docs</a> ·
    <a href="https://www.bulkpublish.com">Website</a> ·
    <a href="https://help.bulkpublish.com">Help Center</a>
  </p>

  <br/>

  <img alt="BulkPublish multi-platform composer" src=".github/assets/multi-platform-composer.webp" width="720"/>

  <br/>
  <br/>
</div>

Turn a Supabase table into your social media queue. Insert a row, set its
`status` to `ready`, and it goes out to your connected accounts through
[BulkPublish](https://www.bulkpublish.com). The post URLs, or the exact reason a
network refused it, are written back into the same row, so your app always
knows what went out.

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

## Contents

- [Why BulkPublish for Supabase?](#why-bulkpublish-for-supabase)
- [Use cases](#use-cases)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [The table](#the-table)
- [Statuses](#statuses)
- [Recipes](#recipes)
- [Supported networks](#supported-networks)
- [Plans and API requests](#plans-and-api-requests)
- [Good to know](#good-to-know)
- [Troubleshooting](#troubleshooting)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Development](#development)
- [More from BulkPublish](#more-from-bulkpublish)

## Why BulkPublish for Supabase?

- **Plain SQL, no SDK.** Anything that can write a row can post: your app, a
  database trigger, a scheduled job, the Table Editor, a no-code tool.
- **15 networks, one row.** Facebook, Instagram, X, TikTok, YouTube, Threads,
  Bluesky, Pinterest, Google Business Profile, LinkedIn, Mastodon, Discord,
  Telegram, Tumblr and Snapchat.
- **Results come back to you.** Every row ends up `posted`, `partial` or
  `failed`, with the live URL for each network or the error in plain words.
- **Media straight from Supabase Storage.** Point at `storage:<bucket>/<path>`;
  no public links needed.
- **Safe by default.** Row Level Security is on, the work functions are closed
  to your app's users, and a row is never posted twice by accident.
- **Scheduling and team approval** carried over from BulkPublish: schedule for
  later, or hold a post until a teammate approves it.
- **Open source, MIT.** One table, one trigger, one scheduled job and one Edge
  Function, all in this repository for you to read and change.

## Use cases

- **Announce what happens in your app.** A product goes live, a changelog
  entry is published, an event opens registration, a listing is approved:
  a trigger on your own table inserts the post.
- **User-generated posting.** Let your users schedule posts to the business's
  accounts from your own interface, with approval before anything goes out.
- **Content calendars.** Plan a week or a month of posts in a table (or import
  them from CSV in the Table Editor) and let them go out on time.
- **AI-generated content.** Write captions with your own model or agent,
  insert them, and keep the outcome next to the prompt that produced it.
- **Internal tools.** Build a posting dashboard on Supabase without writing
  any social network integration yourself.

## How it works

1. You insert or update a row so its `status` is `ready`.
2. A trigger on the table calls the `bulkpublish` Edge Function in your project.
3. The function checks the row (channels exist, caption fits each network,
   media can be read), uploads any media, and creates the post in BulkPublish.
4. Posts without a time are published straight away; scheduled and approval
   posts stay in BulkPublish until their time or approval.
5. A job that runs every minute reads back the outcome and writes the URLs or
   errors into the row. It also picks up any row the trigger missed.

Everything runs inside your own Supabase project. Your BulkPublish API key is
stored as a function secret and never leaves the function.

## Requirements

- A [Supabase](https://supabase.com) project (the free plan works).
- The [Supabase CLI](https://supabase.com/docs/guides/cli).
- A [BulkPublish account](https://app.bulkpublish.com/register) with at least
  one connected channel. See [Plans and API requests](#plans-and-api-requests)
  for which plan you need.

## Setup

**1. Create a BulkPublish API key.** In BulkPublish go to **Settings →
Developer** ([app.bulkpublish.com/developer](https://app.bulkpublish.com/developer))
and create a key. It starts with `bp_` and is shown once. A key that can
publish is needed; a read-only key can't post.

**2. Get the code into your project.** Either clone this repository and link
it to your project:

```bash
git clone https://github.com/azeemkafridi/supabase-bulkpublish
cd supabase-bulkpublish
supabase login
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

**6. Send a test post.** Use a network you have connected:

```sql
insert into bulkpublish_posts (caption, channels, status)
values ('Hello from Supabase 👋', '{linkedin}', 'ready');

select status, result from bulkpublish_posts order by id desc limit 1;
```

That's it. The row should read `posted` with the post's URL within a minute.

## The table

`bulkpublish_posts` is created in the `public` schema.

**You write these:**

| Column | Type | What to put in it |
|---|---|---|
| `caption` | text | The post text. Checked against each network's length limit before anything is sent (X 280, Bluesky 300, Threads 500, LinkedIn 3000, Instagram and TikTok 2200, and so on). |
| `channels` | text[] | Where to post. Each value is a network name (`x`, `linkedin`, `gmb` for Google Business Profile), which means every connected account on that network; an account name; a channel id; or the name of a channel set you saved in BulkPublish. |
| `media` | text[] | Optional images, videos or documents. Use `storage:<bucket>/<path>` for a file in this project's Storage or any public `https://` URL (up to 50 MB each), or `bulkpublish:<media id>` for a file already in your BulkPublish media library (any size it accepts; use this for long videos). |
| `scheduled_at` | timestamptz | Optional. Empty publishes now; a future time schedules the post. A time that has already passed by the time the row is picked up publishes now. |
| `timezone` | text | Optional IANA zone shown on the post in BulkPublish, such as `America/New_York`. |
| `request_approval` | boolean | Hold the post until a teammate approves it in BulkPublish. Without a time it publishes as soon as it is approved. |
| `discord_channel` | text | For Discord: the text channel to post in, by name (`#announcements`) or id. Can be left empty if the Discord connection has a default channel. |
| `status` | text | `draft` (the default, ignored) or `ready` (publish it). |

**Written back for you:**

| Column | Meaning |
|---|---|
| `status` | Where the row stands; see [Statuses](#statuses). |
| `result` | The post URLs, one per line, or the error. Errors name the network and say what to change. |
| `post_urls` | The same per network, as JSON: `[{ "platform", "channelId", "status", "url", "error" }]`. |
| `bulkpublish_post_id` | The post in BulkPublish, which you can open at [app.bulkpublish.com/posts](https://app.bulkpublish.com/posts). |
| `attempts`, `claimed_at`, `next_check_at`, `created_at`, `updated_at` | Bookkeeping. |

## Statuses

| Status | Meaning | Moves on by itself? |
|---|---|---|
| `draft` | Not sent. The default for new rows. | No |
| `ready` | Set this to publish the row. | Yes, within seconds |
| `posting` | Being sent, or published and waiting for the networks to confirm. | Yes |
| `retrying` | BulkPublish was briefly busy or unreachable; tried again next minute, up to five times. | Yes |
| `scheduled` | Created in BulkPublish for its time; visible in your BulkPublish calendar. | Yes, after its time |
| `pending_approval` | Waiting for a teammate to approve it in BulkPublish. | Yes, once approved or rejected |
| `posted` | Live on every network it was sent to. | Finished |
| `partial` | Live on some networks; `result` says which failed and why. | Finished |
| `failed` | Not posted; `result` says why. | Finished |

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

**From your app's server code:**

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

await supabase.from("bulkpublish_posts").insert({
  caption: "New in the shop: the autumn collection",
  channels: ["instagram", "facebook", "pinterest"],
  media: ["storage:products/autumn.jpg"],
  status: "ready",
});
```

Use a server-side key, or add an insert policy for the users you want to allow.

**Queue a week of posts.** Insert rows with `scheduled_at` and `status = 'ready'`.
Each is sent to BulkPublish straight away as a scheduled post, so you can see
and edit it in the BulkPublish calendar; the row moves to `posted` after it
goes out.

```sql
insert into bulkpublish_posts (caption, channels, scheduled_at, timezone, status)
select 'Tip #' || n || ': ' || tip, '{linkedin, threads}',
       date_trunc('day', now()) + (n || ' days 09:00')::interval, 'Europe/London', 'ready'
from unnest(array['Plan ahead', 'Batch your work', 'Measure what matters']) with ordinality as t(tip, n);
```

**Hold posts for review.** Set `request_approval = true`. The row stays
`pending_approval` until a teammate with the approver role approves it in
BulkPublish, then publishes (or, if rejected, fails with the reason).

**Post to Discord.** Add `discord` to `channels` and name the text channel:

```sql
insert into bulkpublish_posts (caption, channels, discord_channel, status)
values ('Release notes are up', '{discord}', '#announcements', 'ready');
```

**Let signed-in users see their own rows.** Add an owner column and policies;
nothing here depends on the table having no other columns:

```sql
alter table bulkpublish_posts add column owner uuid default auth.uid();
create policy "own rows: read" on bulkpublish_posts for select to authenticated using (owner = auth.uid());
create policy "own rows: write" on bulkpublish_posts for insert to authenticated with check (owner = auth.uid());
grant select, insert on bulkpublish_posts to authenticated;
```

**React to the result.** The row is updated in place, so you can listen with
Realtime, or add your own trigger on `status` changing to `posted` or `failed`
(for example to notify the author).

## Supported networks

Use these names in `channels`, or an account name, channel id or channel set.

| Network | Name in `channels` | Caption limit |
|---|---|---|
| Facebook | `facebook` | 63,206 |
| Instagram | `instagram` | 2,200 |
| X (Twitter) | `x` | 280 |
| TikTok | `tiktok` | 2,200 |
| YouTube | `youtube` | 5,000 |
| Threads | `threads` | 500 |
| Bluesky | `bluesky` | 300 |
| Pinterest | `pinterest` | 500 |
| Google Business Profile | `gmb` | 1,500 |
| LinkedIn | `linkedin` | 3,000 |
| Mastodon | `mastodon` | 500 |
| Discord | `discord` | 2,000 |
| Telegram | `telegram` | 4,096 |
| Tumblr | `tumblr` | 32,768 |
| Snapchat | `snapchat` | 160 |

Each network has its own media rules too (YouTube needs a video, TikTok a
video or images). If a post does not meet them, the row fails with the
network's reason. The [platform guide](https://github.com/azeemkafridi/bulkpublish-api/blob/main/guides/platforms.md)
has the details.

## Plans and API requests

Posts made this way count toward your BulkPublish plan like any other post,
and every call the function makes counts toward the plan's daily API
requests.

| | Free | Lifetime | Pro | Business |
|---|---|---|---|---|
| Daily API requests | 10 | 1,000 | 5,000 | 50,000 |

Each row uses about three requests (reading your channels, creating the post,
publishing it), plus one per file it uploads, plus one each time its result
is read back: usually once or twice, then less often for a post that takes
long, and once an hour while it waits for approval.

The free plan is enough to try it with a post or two a day; for regular use
you need a paid plan. See [pricing](https://www.bulkpublish.com/pricing/).

## Good to know

- **A row is never posted twice by accident.** Setting a row to `ready` claims
  it once, however many times the function is called. While a row is
  `posting`, `retrying`, `scheduled` or `pending_approval`, setting it to
  `ready` is refused with an error, since that would make a second post. Once
  it has finished (`posted`, `partial` or `failed`) you can set it to `ready`
  to send it again. To re-send one that is still in progress anyway, set it
  to `draft` first.
- **If something goes wrong between creating the post and hearing back,** the
  row is marked `failed` with a note to check BulkPublish first, rather than
  being retried, since the post may already be live.
- **Passing errors are retried.** If BulkPublish is briefly unreachable or
  busy before a post is created, the row shows `retrying` and is tried again a
  minute later, up to five times in all. Running out of the day's API requests
  is not retried; the row fails and says so.
- **Rows that never settle stop being checked after 14 days** (for example a
  post nobody approves), with a note pointing to the post in BulkPublish.
- **Editing a row after it was sent does not change the post.** Change a
  scheduled post in BulkPublish itself, or delete it there and set the row to
  `ready` again.
- **Roles.** If your API key belongs to a team member who needs approval to
  publish, rows fail with a note to set `request_approval`.
- **Database key.** The function reaches your table with the server key
  Supabase gives every function (`SUPABASE_SECRET_KEYS`, or
  `SUPABASE_SERVICE_ROLE_KEY` on older projects). There is nothing to set.
- **The shared secret** travels in a request header, which the database keeps
  in its outgoing request queue for a short while. Treat it as a project
  secret, and change it if you share database access with someone who should
  not call the function.

## Troubleshooting

**Rows stay `ready`.** The database cannot reach the function.
- Check both Vault secrets exist:
  `select name from vault.decrypted_secrets where name like 'bulkpublish_%';`
  Without them the database logs "add the bulkpublish_function_url and
  bulkpublish_webhook_secret Vault secrets".
- Look at the function's recent answers:
  `select status_code, content from net._http_response order by created desc limit 5;`
  A `401` means the Vault secret and `BULKPUBLISH_WEBHOOK_SECRET` differ; a
  `404` means the URL or function name is wrong.
- Check the job exists: `select jobname, schedule from cron.job;` should list
  `bulkpublish-sweep`.

**Rows fail with "BulkPublish API 401".** The API key is wrong or was
deleted. Set a new one with `supabase secrets set BULKPUBLISH_API_KEY=…`.

**Rows fail with "Daily API quota exceeded".** The plan's API requests for the
day are used up. They reset at midnight UTC; set the rows to `ready` again
then, or upgrade.

**Rows fail with "Channel … not found".** The value in `channels` matches no
connected account. The error lists the ones that do; reconnect the account in
BulkPublish if it is missing.

**Anything else.** The function's logs are under **Edge Functions →
`bulkpublish` → Logs** in the Supabase dashboard, and every post is visible at
[app.bulkpublish.com/posts](https://app.bulkpublish.com/posts).

To change a Vault secret later, use `vault.update_secret` (secret names are
unique, so running `create_secret` again fails):

```sql
select vault.update_secret(
  (select id from vault.secrets where name = 'bulkpublish_webhook_secret'),
  '<new secret>');
```

## Updating and uninstalling

**Updating:** pull the latest version of this repository, then run
`supabase functions deploy bulkpublish --no-verify-jwt` and `supabase db push`.
Your rows are kept. See the [changelog](CHANGELOG.md).

**Pausing:** `select cron.unschedule('bulkpublish-sweep');` and
`alter table bulkpublish_posts disable trigger user;` stop all sending. Undo
with `alter table bulkpublish_posts enable trigger user;` and by running the
`cron.schedule` statement from the second migration again.

**Removing everything** (this deletes the table and its rows):

```sql
select cron.unschedule('bulkpublish-sweep');
drop table if exists public.bulkpublish_posts;
drop function if exists public.bulkpublish_on_ready();
drop function if exists public.bulkpublish_invoke(jsonb);
drop function if exists public.bulkpublish_claim(bigint, int);
drop function if exists public.bulkpublish_due_checks(int);
drop function if exists public.bulkpublish_touch();
delete from vault.secrets where name in ('bulkpublish_function_url', 'bulkpublish_webhook_secret');
```

Then `supabase functions delete bulkpublish` and
`supabase secrets unset BULKPUBLISH_API_KEY BULKPUBLISH_WEBHOOK_SECRET`.

## Development

```bash
npm test           # unit tests for the publishing logic (Node 22.6+)
npm run test:sql   # runs both migrations against a throwaway local Postgres
```

`npm run test:sql` creates and drops its own database. Point it somewhere
else with `PGURL=postgres://user@host:5432`.

To run the whole thing locally against a stand-in API (needs Docker and the
Supabase CLI):

```bash
node test/e2e/mock-api.mjs            # stand-in API on :8787, key bp_test_key
supabase start                        # applies both migrations
printf 'BULKPUBLISH_API_KEY=bp_test_key\nBULKPUBLISH_WEBHOOK_SECRET=local-secret\nBULKPUBLISH_BASE_URL=http://host.docker.internal:8787\n' > supabase/functions/.env
supabase functions serve bulkpublish --no-verify-jwt --env-file supabase/functions/.env
```

Then, in `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres`:

```sql
select vault.create_secret('http://host.docker.internal:54321/functions/v1/bulkpublish', 'bulkpublish_function_url');
select vault.create_secret('local-secret', 'bulkpublish_webhook_secret');
insert into bulkpublish_posts (caption, channels, status) values ('Hello', '{x, linkedin}', 'ready');
```

The stand-in API answers like the real one. A caption containing `XFAIL`
makes X refuse the post, `NOROLE` refuses publishing for lack of a role,
`GET /__fail429?n=2` refuses the next two requests, and `GET /__approve/<post id>`
approves a held post. `GET /__log` lists every request it received.

Repository layout:

```
supabase/
  config.toml                          function settings
  migrations/
    20261124000000_bulkpublish_queue.sql   table, claiming and checks
    20261124000001_bulkpublish_wiring.sql  trigger, minute job, Vault lookup
  functions/bulkpublish/
    index.ts                           the Edge Function
    core.ts                            API client and row logic (tested)
test/                                  unit, SQL and end-to-end tests
```

Issues and pull requests are welcome.

## More from BulkPublish

| | |
|---|---|
| **[BulkPublish API](https://github.com/azeemkafridi/bulkpublish-api)** | REST API, Python and Node SDKs, MCP server for AI assistants |
| **[Zapier](https://zapier.com/apps/bulkpublish/integrations)** | Search "BulkPublish" in Zapier |
| **[n8n](https://github.com/azeemkafridi/n8n-nodes-bulkpublish)** | Community node `n8n-nodes-bulkpublish` |
| **[Homebrew](https://github.com/azeemkafridi/homebrew-bulkpublish)** | `brew tap azeemkafridi/bulkpublish && brew install bulkpublish` |

## Links

| Resource | URL |
|----------|-----|
| Dashboard | [app.bulkpublish.com](https://app.bulkpublish.com) |
| API Docs | [app.bulkpublish.com/docs](https://app.bulkpublish.com/docs) |
| Website | [bulkpublish.com](https://www.bulkpublish.com) |
| Help Center | [help.bulkpublish.com](https://help.bulkpublish.com) |
| Pricing | [bulkpublish.com/pricing](https://www.bulkpublish.com/pricing/) |
| Email | support@bulkpublish.com |

## License

[MIT](LICENSE)
