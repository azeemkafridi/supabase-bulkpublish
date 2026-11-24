/**
 * BulkPublish for Supabase — the Edge Function.
 *
 * Called by the database (see supabase/migrations) with:
 *   { "id": 42 }        a row was just set to 'ready': publish it
 *   { "sweep": true }   once a minute: publish 'ready' rows the trigger missed
 *                       and 'retrying' ones, and read back sent posts
 *
 * Secrets (supabase secrets set …):
 *   BULKPUBLISH_API_KEY         bp_… key from https://app.bulkpublish.com/developer
 *   BULKPUBLISH_WEBHOOK_SECRET  shared with the database's Vault secret
 *   BULKPUBLISH_BASE_URL        optional, defaults to https://app.bulkpublish.com
 *
 * SUPABASE_URL and SUPABASE_SECRET_KEYS (or, on older projects,
 * SUPABASE_SERVICE_ROLE_KEY) are provided by Supabase.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  approvalRequiredMessage,
  BulkPublishClient,
  isTransient,
  MAX_ATTEMPTS,
  needsChannelSets,
  BulkPublishError,
  buildPostBody,
  checkCharLimits,
  effectiveSchedule,
  nextUtcMidnight,
  outcomeFor,
  parseMediaRef,
  type QueueRow,
  resolveChannels,
  resolveDiscordChannel,
  RowError,
  type RowUpdate,
  safeEqual,
  serverKey,
  validateRow,
} from "./core.ts";

const TABLE = "bulkpublish_posts";
// How long a sweep keeps taking new rows; leaves room inside the function's
// time limit for the row already started.
const SWEEP_BUDGET_MS = 60_000;
const SWEEP_MAX_ROWS = 5;
// Files are held in memory while they are passed on, and a function has
// 256 MB. Larger files: upload them in BulkPublish and use bulkpublish:<id>.
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 60_000;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
}

/** Write to a row. Throws if the write fails, so nothing carries on blind. */
async function update(db: SupabaseClient, id: number, patch: RowUpdate): Promise<void> {
  const { error } = await db.from(TABLE).update(patch).eq("id", id);
  if (error) throw new Error(`could not save to row ${id}: ${error.message}`);
}

/** The last write for a row; logs instead of throwing. */
async function finish(db: SupabaseClient, id: number, patch: RowUpdate): Promise<void> {
  try {
    await update(db, id, patch);
  } catch (err) {
    console.error(`[bulkpublish] ${err instanceof Error ? err.message : err}`);
  }
}

const tooBig = (name: string) =>
  new RowError(`${name} is over 50 MB. Upload it in BulkPublish and use bulkpublish:<media id> instead.`);

/** A BulkPublish media id for one entry of the row's media list. */
async function mediaId(db: SupabaseClient, bp: BulkPublishClient, ref: string): Promise<number> {
  const media = parseMediaRef(ref);
  if (media.kind === "library") return media.id;

  let blob: Blob;
  if (media.kind === "storage") {
    const { data, error } = await db.storage.from(media.bucket).download(media.path);
    if (error || !data) {
      throw new RowError(`Could not read ${ref} from Storage: ${error?.message || "not found"}.`);
    }
    blob = data;
  } else {
    let res: Response;
    try {
      res = await fetch(media.url, { signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) });
    } catch (err) {
      throw new RowError(`Could not download ${media.url}: ${err instanceof Error ? err.message : err}.`);
    }
    if (!res.ok) throw new RowError(`Could not download ${media.url} (HTTP ${res.status}).`);
    if (Number(res.headers.get("content-length") || 0) > MAX_MEDIA_BYTES) {
      await res.body?.cancel();
      throw tooBig(media.filename);
    }
    blob = await res.blob();
  }
  if (blob.size > MAX_MEDIA_BYTES) throw tooBig(media.filename);
  const uploaded = await bp.uploadMedia(blob, media.filename);
  return uploaded.id;
}

/** Publish one claimed row (status already 'posting'). Never throws. */
async function publishRow(db: SupabaseClient, bp: BulkPublishClient, row: QueueRow): Promise<void> {
  let postId: number | null = null;
  try {
    validateRow(row);
    const scheduledAt = effectiveSchedule(row.scheduled_at);

    // Every call counts toward the plan's daily API requests, so channel sets
    // are only fetched when a value is not a channel, platform or account.
    const channels = await bp.listChannels();
    const sets = needsChannelSets(row.channels, channels) ? await bp.listChannelSets() : [];
    const targets = resolveChannels(row.channels, channels, sets);
    const tooLong = checkCharLimits(row.caption, targets);
    if (tooLong) throw new RowError(tooLong);

    const platformSpecific: Record<string, Record<number, { channelId: string }>> = {};
    for (const c of targets.filter((t) => t.platform === "discord")) {
      const wanted = row.discord_channel?.trim() || null;
      const options = wanted || !c.metadata?.channelId ? await bp.getChannelOptions(c.id) : [];
      const discordId = resolveDiscordChannel(wanted, c, options);
      if (discordId) (platformSpecific.discord ||= {})[c.id] = { channelId: discordId };
    }

    const mediaIds: number[] = [];
    for (const ref of row.media || []) {
      if (String(ref).trim()) mediaIds.push(await mediaId(db, bp, ref));
    }

    const post = await bp.createPost(buildPostBody({
      caption: row.caption.trim(),
      channelIds: targets.map((c) => c.id),
      mediaIds,
      scheduledAt,
      timezone: row.timezone,
      requestApproval: row.request_approval,
      platformSpecific,
    }));
    postId = post.id;
    // Saved before anything else, so the row always knows its post.
    await update(db, row.id, { bulkpublish_post_id: post.id });

    if (scheduledAt || post.approvalStatus === "pending" || post.status === "scheduled") {
      await update(db, row.id, outcomeFor(post));
      return;
    }

    try {
      await bp.publishPost(post.id);
    } catch (err) {
      if (err instanceof BulkPublishError && err.code === "APPROVAL_REQUIRED") {
        await update(db, row.id, { status: "failed", result: approvalRequiredMessage(post.id), next_check_at: null });
        return;
      }
      throw err;
    }
    await update(db, row.id, {
      status: "posting",
      result: `Publishing post ${post.id}…`,
      next_check_at: new Date(Date.now() + 20_000).toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Nothing was created yet and the error should pass: hand the row to the
    // once-a-minute run as 'retrying' (which does not re-fire the trigger).
    if (!postId && isTransient(err) && (row.attempts ?? 1) < MAX_ATTEMPTS) {
      console.warn(`[bulkpublish] row ${row.id}: will retry: ${message}`);
      await finish(db, row.id, { status: "retrying", result: `Retrying: ${message}`, next_check_at: null });
      return;
    }
    const suffix = postId
      ? ` Post ${postId} was created in BulkPublish; check it before setting this row to ready again.`
      : "";
    console.error(`[bulkpublish] row ${row.id}: ${message}`);
    await finish(db, row.id, { status: "failed", result: message + suffix, next_check_at: null });
  }
}

/** Read a sent post back into its row. Never throws. */
async function checkRow(db: SupabaseClient, bp: BulkPublishClient, row: QueueRow): Promise<void> {
  try {
    const post = await bp.getPost(row.bulkpublish_post_id as number);
    await update(db, row.id, outcomeFor(post, Date.now(), row.claimed_at ?? null));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BulkPublishError && err.status === 404) {
      await finish(db, row.id, {
        status: "failed",
        result: `Post ${row.bulkpublish_post_id} no longer exists in BulkPublish.`,
        next_check_at: null,
      });
    } else if (err instanceof BulkPublishError && err.status === 401) {
      await finish(db, row.id, {
        status: "failed",
        result: `The API key was refused, so post ${row.bulkpublish_post_id} can't be checked. ` +
          `Set a valid BULKPUBLISH_API_KEY and see the post at https://app.bulkpublish.com/posts.`,
        next_check_at: null,
      });
    } else if (err instanceof BulkPublishError && err.code === "DAILY_QUOTA_EXCEEDED") {
      // Checking again before the allowance resets would only use it up.
      await finish(db, row.id, { next_check_at: nextUtcMidnight() });
    } else {
      // Left as it is; its two-minute lease brings it back.
      console.error(`[bulkpublish] row ${row.id}: check failed: ${message}`);
    }
  }
}

async function run(payload: { id?: unknown; sweep?: unknown }): Promise<void> {
  const key = serverKey((name) => Deno.env.get(name));
  if (!key) throw new Error("Missing SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(env("SUPABASE_URL"), key, {
    auth: { persistSession: false },
  });
  const bp = new BulkPublishClient({
    apiKey: env("BULKPUBLISH_API_KEY"),
    baseUrl: Deno.env.get("BULKPUBLISH_BASE_URL") || undefined,
  });

  const claimOne = async (id: number | null): Promise<QueueRow | null> => {
    const { data, error } = await db.rpc("bulkpublish_claim", { p_id: id, p_limit: 1 });
    if (error) throw new Error(`claim failed: ${error.message}`);
    return ((data || []) as QueueRow[])[0] || null;
  };

  const id = Number(payload.id);
  if (Number.isInteger(id) && id > 0) {
    const row = await claimOne(id);
    if (row) await publishRow(db, bp, row);
  } else if (payload.sweep) {
    // One row at a time, so rows not reached stay 'ready' for the next run
    // rather than being claimed and stranded if time runs out.
    const started = Date.now();
    for (let n = 0; n < SWEEP_MAX_ROWS && Date.now() - started < SWEEP_BUDGET_MS; n++) {
      const row = await claimOne(null);
      if (!row) break;
      await publishRow(db, bp, row);
    }
  }

  if (payload.sweep) {
    const due = await db.rpc("bulkpublish_due_checks", { p_limit: 20 });
    if (due.error) throw new Error(`check failed: ${due.error.message}`);
    for (const row of (due.data || []) as QueueRow[]) await checkRow(db, bp, row);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = Deno.env.get("BULKPUBLISH_WEBHOOK_SECRET") || "";
  const given = req.headers.get("x-bulkpublish-secret") || "";
  if (!secret || !safeEqual(given, secret)) return new Response("Unauthorized", { status: 401 });

  let payload: { id?: unknown; sweep?: unknown };
  try {
    payload = await req.json();
  } catch {
    return new Response("Expected a JSON body", { status: 400 });
  }

  const work = run(payload).catch((err) => console.error(`[bulkpublish] ${err instanceof Error ? err.message : err}`));
  // Answer the database at once and keep working: uploads can take longer
  // than the caller waits.
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(work);
  } else {
    await work;
  }
  return new Response(JSON.stringify({ accepted: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
});
