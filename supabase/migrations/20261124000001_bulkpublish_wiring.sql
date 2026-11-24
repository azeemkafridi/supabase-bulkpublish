-- BulkPublish for Supabase: call the Edge Function when a row becomes
-- 'ready', and once a minute to pick up anything missed and to read back the
-- outcome of posts already sent.
--
-- Needs two Vault secrets (see README → Setup):
--   bulkpublish_function_url    https://<project-ref>.supabase.co/functions/v1/bulkpublish
--   bulkpublish_webhook_secret  the same value as the function's BULKPUBLISH_WEBHOOK_SECRET

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function public.bulkpublish_invoke(payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  fn_url text;
  fn_secret text;
begin
  select decrypted_secret into fn_url
    from vault.decrypted_secrets where name = 'bulkpublish_function_url';
  select decrypted_secret into fn_secret
    from vault.decrypted_secrets where name = 'bulkpublish_webhook_secret';

  if fn_url is null or fn_secret is null then
    raise warning 'BulkPublish: add the bulkpublish_function_url and bulkpublish_webhook_secret Vault secrets to start publishing';
    return;
  end if;

  perform net.http_post(
    url := fn_url,
    body := payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bulkpublish-secret', fn_secret),
    timeout_milliseconds := 10000);
end;
$$;

revoke all on function public.bulkpublish_invoke(jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.bulkpublish_invoke(jsonb) from anon, authenticated';
  end if;
end;
$$;

-- A row set to 'ready' is published straight away. A failure to reach the
-- function never blocks your write: the once-a-minute run picks the row up.
create or replace function public.bulkpublish_on_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.bulkpublish_invoke(jsonb_build_object('id', new.id));
  exception when others then
    raise warning 'BulkPublish: could not start publishing row %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists bulkpublish_posts_on_ready on public.bulkpublish_posts;
create trigger bulkpublish_posts_on_ready
  after insert or update of status on public.bulkpublish_posts
  for each row
  when (new.status = 'ready')
  execute function public.bulkpublish_on_ready();

-- Once a minute: publish rows the trigger missed and read back results.
select cron.schedule(
  'bulkpublish-sweep',
  '* * * * *',
  $$select public.bulkpublish_invoke('{"sweep": true}'::jsonb)$$
);
