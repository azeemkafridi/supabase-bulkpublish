-- BulkPublish for Supabase: the queue table and the two functions the Edge
-- Function uses to take work from it.
--
-- Plain Postgres only, so this file can be checked against any database.
-- The wiring that needs Supabase's own extensions (pg_net, pg_cron, Vault)
-- lives in the next migration.

create table if not exists public.bulkpublish_posts (
  id                  bigint generated always as identity primary key,

  -- What to post (you write these)
  caption             text        not null default '',
  -- Platform names ('x', 'linkedin'), account names, channel ids or channel
  -- set names. A platform name means every active channel on that platform.
  channels            text[]      not null default '{}',
  -- Public http(s) URLs, or 'storage:<bucket>/<path>' for a file in this
  -- project's Storage.
  media               text[]      not null default '{}',
  -- Empty = publish as soon as the row is set to 'ready'.
  scheduled_at        timestamptz,
  -- IANA time zone shown on the post in BulkPublish, e.g. 'Europe/Berlin'.
  timezone            text,
  -- Hold the post until a teammate approves it in BulkPublish.
  request_approval    boolean     not null default false,
  -- The Discord text channel (name or id) for rows that post to Discord.
  discord_channel     text,

  -- Set to 'ready' to publish. Everything after that is written back for you.
  status              text        not null default 'draft'
    check (status in ('draft', 'ready', 'retrying', 'posting', 'scheduled',
                      'pending_approval', 'posted', 'partial', 'failed')),
  result              text,
  bulkpublish_post_id bigint,
  -- [{ platform, channelId, status, url, error }], one per destination.
  post_urls           jsonb       not null default '[]'::jsonb,

  -- Bookkeeping for the Edge Function.
  attempts            int         not null default 0,
  claimed_at          timestamptz,
  next_check_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.bulkpublish_posts is
  'Social posts to publish through BulkPublish. Set status to ''ready'' to publish a row.';

create index if not exists bulkpublish_posts_ready_idx
  on public.bulkpublish_posts (id) where status in ('ready', 'retrying');
create index if not exists bulkpublish_posts_check_idx
  on public.bulkpublish_posts (next_check_at)
  where status in ('posting', 'scheduled', 'pending_approval');

-- Only the service role (which the Edge Function uses) can read or write the
-- table until you add policies of your own. New tables get no API grants by
-- default, so the service role is granted explicitly.
alter table public.bulkpublish_posts enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.bulkpublish_posts to service_role';
  end if;
end;
$$;

create or replace function public.bulkpublish_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status = 'ready' and old.status is distinct from 'ready' then
    -- A row already sent to BulkPublish would become a second post.
    if old.status in ('posting', 'retrying', 'scheduled', 'pending_approval') then
      raise exception 'Row % is % in BulkPublish (post %). Wait until it is posted or failed, or set status to draft first to send it again anyway.',
        old.id, old.status, coalesce(old.bulkpublish_post_id::text, 'not created yet')
        using errcode = 'check_violation';
    end if;
    -- Setting a row to 'ready' yourself starts its attempt count afresh.
    new.attempts := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists bulkpublish_posts_touch on public.bulkpublish_posts;
create trigger bulkpublish_posts_touch
  before update on public.bulkpublish_posts
  for each row execute function public.bulkpublish_touch();

-- Claim rows that are 'ready' (or 'retrying' after a passing error) by
-- moving them to 'posting'. A row can only be
-- claimed once, however many invocations race for it, so it is never posted
-- twice. Pass an id to claim that row, or null to claim the oldest few.
-- Claiming clears what a previous run wrote, so a row set to 'ready' again
-- after it ran is tracked as the new post it becomes.
create or replace function public.bulkpublish_claim(p_id bigint default null, p_limit int default 5)
returns setof public.bulkpublish_posts
language sql
security definer
set search_path = ''
as $$
  update public.bulkpublish_posts p
     set status = 'posting', claimed_at = now(), result = null,
         -- Not read back while the function is still working on it.
         next_check_at = now() + interval '15 minutes',
         attempts = p.attempts + 1, bulkpublish_post_id = null, post_urls = '[]'::jsonb
   where p.id in (
           select q.id
             from public.bulkpublish_posts q
            where q.status in ('ready', 'retrying')
              and (p_id is null or q.id = p_id)
            order by q.id
            limit greatest(1, least(coalesce(p_limit, 5), 20))
              for update skip locked)
  returning p.*;
$$;

-- Rows whose BulkPublish post should be read again: published but not yet
-- confirmed, scheduled and due, or waiting for approval. Each returned row is
-- leased for two minutes so two invocations do not check it at once.
--
-- Also fails rows stranded in 'posting' with no BulkPublish post for 15
-- minutes (the function stopped between claiming a row and creating its
-- post). They are not retried by themselves: the post may exist.
--
-- And stops following rows that have not settled in 14 days (a post never
-- approved, or one whose result cannot be read), so none is checked forever.
create or replace function public.bulkpublish_due_checks(p_limit int default 20)
returns setof public.bulkpublish_posts
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bulkpublish_posts
     set status = 'failed',
         result = 'Stopped before BulkPublish confirmed a post. Check your BulkPublish posts '
               || 'before setting this row to ready again, or it may be posted twice.'
   where status = 'posting'
     and bulkpublish_post_id is null
     and claimed_at < now() - interval '15 minutes';

  update public.bulkpublish_posts
     set status = 'failed', next_check_at = null,
         result = 'Stopped checking after 14 days. See post ' || bulkpublish_post_id
               || ' at https://app.bulkpublish.com/posts for where it stands.'
   where status in ('posting', 'pending_approval')
     and claimed_at < now() - interval '14 days'
     and (scheduled_at is null or scheduled_at < now() - interval '14 days');

  return query
  update public.bulkpublish_posts p
     set next_check_at = now() + interval '2 minutes'
   where p.id in (
           select q.id
             from public.bulkpublish_posts q
            where q.status in ('posting', 'scheduled', 'pending_approval')
              and q.bulkpublish_post_id is not null
              and coalesce(q.next_check_at, '-infinity') <= now()
            order by q.next_check_at nulls first
            limit greatest(1, least(coalesce(p_limit, 20), 50))
              for update skip locked)
  returning p.*;
end;
$$;

revoke all on function public.bulkpublish_claim(bigint, int) from public;
revoke all on function public.bulkpublish_due_checks(int) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.bulkpublish_claim(bigint, int) from anon, authenticated';
    execute 'revoke all on function public.bulkpublish_due_checks(int) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.bulkpublish_claim(bigint, int) to service_role';
    execute 'grant execute on function public.bulkpublish_due_checks(int) to service_role';
  end if;
end;
$$;
