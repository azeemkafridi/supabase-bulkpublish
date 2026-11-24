/**
 * BulkPublish for Supabase — the Edge Function.
 *
 * Called by the database (see supabase/migrations) with:
 *   { "id": 42 }        a row was just set to 'ready': publish it
 *   { "sweep": true }   once a minute: publish any 'ready' rows the trigger
 *                       missed, and read back the outcome of sent posts
 *
 * Secrets (supabase secrets set …):
 *   BULKPUBLISH_API_KEY         bp_… key from https://app.bulkpublish.com/developer
 *   BULKPUBLISH_WEBHOOK_SECRET  shared with the database's Vault secret
 *   BULKPUBLISH_BASE_URL        optional, defaults to https://app.bulkpublish.com
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  approvalRequiredMessage,
  BulkPublishClient,
  BulkPublishError,
  buildPostBody,
  checkCharLimits,
  outcomeFor,
  parseMediaRef,
  type QueueRow,
  resolveChannels,
  resolveDiscordChannel,
  RowError,
  type RowUpdate,
  safeEqual,
  validateRow,
} from "./core.ts";

const TABLE = "bulkpublish_posts";
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
}

async function update(db: SupabaseClient, id: number, patch: RowUpdate): Promise<void> {
  const { error } = await db.from(TABLE).update(patch).eq("id", id);
  if (error) console.error(`[bulkpublish] row ${id}: could not save result: ${error.message}`);
}

async function loadMedia(db: SupabaseClient, ref: string): Promise<{ blob: Blob; filename: string }> {
  const media = parseMediaRef(ref);
  if (media.kind === "storage") {
    const { data, error } = await db.storage.from(media.bucket).download(media.path);
    if (error || !data) {
      throw new RowError(`Could not read ${ref} from Storage: ${error?.message || "not found"}.`);
    }
    if (data.size > MAX_MEDIA_BYTES) throw new RowError(`${media.filename} is over 100 MB.`);
    return { blob: data, filename: media.filename };
  }
  const res = await fetch(media.url);
  if (!res.ok) throw new RowError(`Could not download ${media.url} (HTTP ${res.status}).`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_MEDIA_BYTES) throw new RowError(`${media.filename} is over 100 MB.`);
  const blob = await res.blob();
  if (blob.size > MAX_MEDIA_BYTES) throw new RowError(`${media.filename} is over 100 MB.`);
  return { blob, filename: media.filename };
}

/** Publish one claimed row (status already 'posting'). Never throws. */
async function publishRow(db: SupabaseClient, bp: BulkPublishClient, row: QueueRow): Promise<void> {
  let postId: number | null = null;
  try {
    validateRow(row);

    const [channels, sets] = await Promise.all([bp.listChannels(), bp.listChannelSets()]);
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
      if (!String(ref).trim()) continue;
      const { blob, filename } = await loadMedia(db, ref);
      const uploaded = await bp.uploadMedia(blob, filename);
      mediaIds.push(uploaded.id);
    }

    const post = await bp.createPost(buildPostBody({
      caption: row.caption.trim(),
      channelIds: targets.map((c) => c.id),
      mediaIds,
      scheduledAt: row.scheduled_at,
      timezone: row.timezone,
      requestApproval: row.request_approval,
      platformSpecific,
    }));
    postId = post.id;
    // Saved before anything else, so a later failure can never lead to the
    // row being posted a second time without us knowing about the first.
    await update(db, row.id, { bulkpublish_post_id: post.id });

    if (row.scheduled_at || post.approvalStatus === "pending" || post.status === "scheduled") {
      await update(db, row.id, outcomeFor(post));
      return;
    }

    try {
      await bp.publishPost(post.id);
    } catch (err) {
      if (err instanceof BulkPublishError && (err.code === "APPROVAL_REQUIRED" || err.status === 403)) {
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
    const suffix = postId
      ? ` Post ${postId} was created in BulkPublish; check it before setting this row to ready again.`
      : "";
    console.error(`[bulkpublish] row ${row.id}: ${message}`);
    await update(db, row.id, { status: "failed", result: message + suffix, next_check_at: null });
  }
}

/** Read a sent post back into its row. Never throws. */
async function checkRow(db: SupabaseClient, bp: BulkPublishClient, row: QueueRow): Promise<void> {
  try {
    const post = await bp.getPost(row.bulkpublish_post_id as number);
    await update(db, row.id, outcomeFor(post));
  } catch (err) {
    if (err instanceof BulkPublishError && err.status === 404) {
      await update(db, row.id, {
        status: "failed",
        result: `Post ${row.bulkpublish_post_id} no longer exists in BulkPublish.`,
        next_check_at: null,
      });
      return;
    }
    // Leave the row as it is; its two-minute lease brings it back.
    console.error(`[bulkpublish] row ${row.id}: check failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function run(payload: { id?: unknown; sweep?: unknown }): Promise<void> {
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
  const bp = new BulkPublishClient({
    apiKey: env("BULKPUBLISH_API_KEY"),
    baseUrl: Deno.env.get("BULKPUBLISH_BASE_URL") || undefined,
  });

  const id = Number(payload.id);
  const claim = Number.isInteger(id) && id > 0
    ? await db.rpc("bulkpublish_claim", { p_id: id, p_limit: 1 })
    : payload.sweep
    ? await db.rpc("bulkpublish_claim", { p_id: null, p_limit: 5 })
    : { data: [], error: null };
  if (claim.error) throw new Error(`claim failed: ${claim.error.message}`);
  for (const row of (claim.data || []) as QueueRow[]) await publishRow(db, bp, row);

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
