#!/usr/bin/env bash
# Run both migrations against a throwaway local Postgres database and check
# claiming, leasing, the stranded-row sweep and the ready trigger.
#
# Supabase's own extensions (pg_net, pg_cron, Vault) are replaced by small
# stand-ins that record what would have been sent.
#
#   PGURL=postgres://localhost:5432 npm run test:sql
set -euo pipefail

BASE="${PGURL:-postgres://localhost:5432}"
DB="bp_supabase_test_$$"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Supabase's roles are cluster-wide; create the ones missing here and drop
# only those afterwards.
MADE_ROLES=()
for r in service_role anon authenticated; do
  if [ -z "$(psql "$BASE/postgres" -qAtc "select 1 from pg_roles where rolname = '$r'")" ]; then
    psql "$BASE/postgres" -qc "create role $r nologin" >/dev/null
    MADE_ROLES+=("$r")
  fi
done
cleanup() {
  psql "$BASE/postgres" -qc "drop database if exists $DB" >/dev/null
  for r in "${MADE_ROLES[@]+"${MADE_ROLES[@]}"}"; do psql "$BASE/postgres" -qc "drop role if exists $r" >/dev/null; done
}
trap cleanup EXIT
psql "$BASE/postgres" -qc "create database $DB" >/dev/null
P=(psql "$BASE/$DB" -v ON_ERROR_STOP=1 -qAt)

"${P[@]}" <<'SQL'
create schema extensions;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create schema net;
create table net.calls (url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int)
returns bigint language sql as $$ insert into net.calls values (url, body, headers); select 1::bigint $$;
create schema cron;
create table cron.jobs (name text, schedule text, command text);
create function cron.schedule(name text, schedule text, command text)
returns bigint language sql as $$ insert into cron.jobs values (name, schedule, command); select 1::bigint $$;
SQL

"${P[@]}" -f "$DIR/supabase/migrations/20261124000000_bulkpublish_queue.sql"
grep -v '^create extension' "$DIR/supabase/migrations/20261124000001_bulkpublish_wiring.sql" | "${P[@]}"
# Applying twice must work (re-running the setup is a normal thing to do).
"${P[@]}" -f "$DIR/supabase/migrations/20261124000000_bulkpublish_queue.sql"

fail() { echo "FAIL: $*"; exit 1; }
eq() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

# Without Vault secrets a ready row is still saved; nothing is sent.
"${P[@]}" -c "insert into bulkpublish_posts (caption, channels, status) values ('no secrets', '{x}', 'ready')"
eq "$("${P[@]}" -c "select count(*) from net.calls")" 0 "call without secrets"

"${P[@]}" -c "insert into vault.decrypted_secrets values ('bulkpublish_function_url', 'https://ref.supabase.co/functions/v1/bulkpublish'), ('bulkpublish_webhook_secret', 's3cret')"

# Drafts do not call the function; ready rows do, with the secret header.
"${P[@]}" -c "insert into bulkpublish_posts (caption, channels) values ('draft', '{x}')"
eq "$("${P[@]}" -c "select count(*) from net.calls")" 0 "draft insert"
"${P[@]}" -c "update bulkpublish_posts set status = 'ready' where caption = 'draft'"
eq "$("${P[@]}" -c "select body->>'id', headers->>'x-bulkpublish-secret' from net.calls")" "2|s3cret" "ready trigger"
"${P[@]}" -c "update bulkpublish_posts set caption = 'edited' where id = 2"
eq "$("${P[@]}" -c "select count(*) from net.calls")" 1 "non-status update does not re-trigger"

eq "$("${P[@]}" -c "select count(*) from cron.jobs where name = 'bulkpublish-sweep' and schedule = '* * * * *'")" 1 "cron job"

# Claim by id: only once.
eq "$("${P[@]}" -c "select id from bulkpublish_claim(2, 1)")" 2 "claim by id"
eq "$("${P[@]}" -c "select count(*) from bulkpublish_claim(2, 1)")" 0 "second claim of same row"
eq "$("${P[@]}" -c "select status from bulkpublish_posts where id = 2")" posting "claimed status"

# Sweep claim takes the remaining ready rows, oldest first, capped by limit.
"${P[@]}" -c "insert into bulkpublish_posts (caption, channels, status) select 'bulk ' || g, '{x}', 'ready' from generate_series(1, 6) g"
eq "$("${P[@]}" -c "select string_agg(id::text, ',' order by id) from bulkpublish_claim(null, 5)")" "1,3,4,5,6" "sweep claim"

# Due checks: only rows with a post id, due, in a waiting status; each leased.
"${P[@]}" -c "update bulkpublish_posts set bulkpublish_post_id = 100 + id, next_check_at = now() - interval '1 second' where id in (3, 4)"
"${P[@]}" -c "update bulkpublish_posts set status = 'scheduled', bulkpublish_post_id = 105, next_check_at = now() + interval '1 day' where id = 5"
eq "$("${P[@]}" -c "select string_agg(id::text, ',' order by id) from bulkpublish_due_checks(20)")" "3,4" "due checks"
eq "$("${P[@]}" -c "select count(*) from bulkpublish_due_checks(20)")" 0 "leased rows not returned again"

# A row stuck in posting with no post for 15 minutes is failed, not retried.
"${P[@]}" -c "update bulkpublish_posts set claimed_at = now() - interval '16 minutes' where id = 6"
"${P[@]}" -c "select count(*) from bulkpublish_due_checks(20)" >/dev/null
eq "$("${P[@]}" -c "select status from bulkpublish_posts where id = 6")" failed "stranded row"
eq "$("${P[@]}" -c "select status from bulkpublish_posts where id = 1")" posting "fresh posting row untouched"

# updated_at moves on update; bad statuses are refused.
eq "$("${P[@]}" -c "select updated_at > created_at from bulkpublish_posts where id = 2")" t "updated_at"
if "${P[@]}" -c "update bulkpublish_posts set status = 'published' where id = 2" 2>/dev/null; then fail "status check"; fi

# Clients cannot call the work functions or read the table.
eq "$("${P[@]}" -c "select has_function_privilege('anon', 'public.bulkpublish_claim(bigint,int)', 'execute')")" f "anon claim"
eq "$("${P[@]}" -c "select has_function_privilege('authenticated', 'public.bulkpublish_invoke(jsonb)', 'execute')")" f "authenticated invoke"
eq "$("${P[@]}" -c "select has_function_privilege('service_role', 'public.bulkpublish_due_checks(int)', 'execute')")" t "service_role checks"
eq "$("${P[@]}" -c "select relrowsecurity from pg_class where relname = 'bulkpublish_posts'")" t "RLS on"

echo "sql: all checks passed"
