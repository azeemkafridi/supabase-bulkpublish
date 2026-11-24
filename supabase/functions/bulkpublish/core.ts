/**
 * Everything the function does that is not I/O against Supabase: the
 * BulkPublish API client, row validation, the post body, and reading a post's
 * outcome back into a row update. Runs unchanged in Deno and in Node, so the
 * tests in ../../../test can exercise it without a Supabase project.
 */

export const DEFAULT_BASE_URL = "https://app.bulkpublish.com";
export const APP_POSTS_URL = "https://app.bulkpublish.com/posts";

// deno-lint-ignore no-explicit-any
type Json = any;

export interface Channel {
  id: number;
  platform: string;
  accountName?: string;
  isActive?: boolean;
  metadata?: { channelId?: string } | null;
}

export interface ChannelSet {
  id: number;
  name: string;
  channelIds: number[];
}

export interface QueueRow {
  id: number;
  caption: string;
  channels: string[];
  media: string[];
  scheduled_at: string | null;
  timezone: string | null;
  request_approval: boolean;
  discord_channel: string | null;
  status: string;
  bulkpublish_post_id: number | null;
  attempts?: number;
  claimed_at?: string | null;
}

/** The columns the function writes back to a row. */
export interface RowUpdate {
  status?: string;
  result?: string | null;
  bulkpublish_post_id?: number;
  post_urls?: DestinationResult[];
  next_check_at?: string | null;
}

export interface DestinationResult {
  platform: string;
  channelId: number | null;
  status: string;
  url: string | null;
  error: string | null;
}

export class BulkPublishError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Minimal BulkPublish API client over fetch. Auth: `Authorization: Bearer bp_…`. */
export class BulkPublishClient {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl || fetch;
  }

  async request(method: string, path: string, init: { body?: unknown; form?: FormData } = {}): Promise<Json> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": "supabase-bulkpublish/1.0.0",
    };
    let body: BodyInit | undefined;
    if (init.form) {
      body = init.form;
    } else if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body });
    const text = await res.text();
    let data: Json = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON; the text itself is the message
    }
    if (!res.ok) {
      const message = data?.error?.message || text || res.statusText;
      const code = data?.error?.code;
      throw new BulkPublishError(
        `BulkPublish API ${res.status}: ${message}${code ? ` (${code})` : ""}`,
        res.status,
        code,
      );
    }
    return data;
  }

  async listChannels(): Promise<Channel[]> {
    const data = await this.request("GET", "/api/channels");
    return data?.channels || [];
  }

  /** Channel sets are optional; an error here should not stop a row. */
  async listChannelSets(): Promise<ChannelSet[]> {
    try {
      const data = await this.request("GET", "/api/channel-sets");
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async getChannelOptions(channelId: number): Promise<{ id: string; name: string }[]> {
    const data = await this.request("GET", `/api/channels/${channelId}/options`);
    return data?.items || [];
  }

  async uploadMedia(file: Blob, filename: string): Promise<{ id: number }> {
    const form = new FormData();
    form.append("file", file, filename);
    const data = await this.request("POST", "/api/media", { form });
    return data.file;
  }

  createPost(body: Json): Promise<Json> {
    return this.request("POST", "/api/posts", { body });
  }

  publishPost(id: number): Promise<Json> {
    return this.request("POST", `/api/posts/${id}/publish`);
  }

  getPost(id: number): Promise<Json> {
    return this.request("GET", `/api/posts/${id}`);
  }
}

/** Per-platform caption limits, checked before anything is uploaded. */
export const CHAR_LIMITS: Record<string, number> = {
  x: 280,
  threads: 500,
  bluesky: 300,
  mastodon: 500,
  pinterest: 500,
  gmb: 1500,
  linkedin: 3000,
  instagram: 2200,
  tiktok: 2200,
  youtube: 5000,
  facebook: 63206,
  discord: 2000,
  telegram: 4096,
  tumblr: 32768,
  snapchat: 160,
};

/** A problem with the row itself: written back as-is, nothing was sent. */
export class RowError extends Error {}

/** How many times a row is tried when the error is a passing one. */
export const MAX_ATTEMPTS = 5;

/**
 * Worth trying again in a minute: too many requests in the last minute, a
 * server error, or no answer at all. The daily request allowance is not: it
 * resets at midnight UTC, so retrying only fails the same way.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof RowError) return false;
  if (err instanceof BulkPublishError) {
    if (err.code === "DAILY_QUOTA_EXCEEDED") return false;
    return err.status === 429 || err.status >= 500;
  }
  return err instanceof TypeError; // fetch's network failure
}

/** Is any value in the row's channels list not a channel id, platform or account name? */
export function needsChannelSets(values: string[], channels: Channel[]): boolean {
  const active = channels.filter((c) => c.isActive !== false);
  return values.some((raw) => {
    const lower = String(raw).trim().toLowerCase();
    if (!lower) return false;
    return !active.some((c) =>
      String(c.id) === lower || (c.platform || "").toLowerCase() === lower ||
      (c.accountName || "").toLowerCase() === lower
    );
  });
}

/**
 * Resolve the row's `channels` values against the account's channels.
 * Each value may be a channel id, a platform name (every active channel on
 * it), an account name, or a channel set name.
 */
export function resolveChannels(values: string[], channels: Channel[], sets: ChannelSet[] = []): Channel[] {
  const active = channels.filter((c) => c.isActive !== false);
  const resolved = new Map<number, Channel>();

  for (const raw of values) {
    const value = String(raw).trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    const byId = active.find((c) => String(c.id) === value);
    const byPlatform = active.filter((c) => (c.platform || "").toLowerCase() === lower);
    const byAccount = active.filter((c) => (c.accountName || "").toLowerCase() === lower);
    const set = sets.find((s) => (s.name || "").toLowerCase() === lower);
    const bySet = set ? active.filter((c) => (set.channelIds || []).some((id) => String(id) === String(c.id))) : [];

    const matches = byId ? [byId] : byPlatform.length ? byPlatform : byAccount.length ? byAccount : bySet;
    if (!matches.length) {
      if (set) {
        throw new RowError(
          `Channel set "${set.name}" has no connected channels. Review it at https://app.bulkpublish.com/channels.`,
        );
      }
      const available = [...new Set(active.map((c) => `${c.platform} (${c.accountName})`))];
      throw new RowError(
        `Channel "${value}" not found. Use a platform name, account name, channel id or channel set name. ` +
          `Connected: ${available.join(", ") || "none"}.` +
          (sets.length ? ` Channel sets: ${sets.map((s) => s.name).join(", ")}.` : ""),
      );
    }
    for (const c of matches) resolved.set(c.id, c);
  }
  return [...resolved.values()];
}

/** null when the caption fits every target platform, else the message to write back. */
export function checkCharLimits(caption: string, targets: Channel[]): string | null {
  const length = [...caption].length;
  const over: string[] = [];
  for (const platform of new Set(targets.map((c) => c.platform))) {
    const limit = CHAR_LIMITS[platform];
    if (limit && length > limit) over.push(`${platform} allows ${limit}`);
  }
  if (!over.length) return null;
  return `Caption is ${length} characters, over the limit: ${over.join(", ")}. Shorten it or remove the channel.`;
}

/**
 * The Discord text channel id for one connected server, or null when nothing
 * was asked for and the connection has its own default.
 */
export function resolveDiscordChannel(
  wanted: string | null,
  channel: Channel,
  options: { id: string; name: string }[],
): string | null {
  const names = options.map((o) => `#${o.name}`).join(", ") || "none found";
  if (!wanted) {
    if (channel.metadata?.channelId) return null;
    throw new RowError(
      `Discord needs a channel to post in. Set discord_channel to one of the channels in "${channel.accountName}": ${names}.`,
    );
  }
  const value = wanted.trim().replace(/^#/, "").toLowerCase();
  const match = options.find((o) => String(o.id) === value) ||
    options.find((o) => (o.name || "").toLowerCase() === value);
  if (!match) {
    throw new RowError(`Discord channel "${wanted}" not found in "${channel.accountName}". Available: ${names}.`);
  }
  return String(match.id);
}

/** Basic checks on a row before any request is made. */
export function validateRow(row: QueueRow, now = Date.now()): void {
  if (!row.caption || !row.caption.trim()) {
    throw new RowError("Caption is empty. Add the post text, then set status to ready again.");
  }
  if (!row.channels || !row.channels.some((c) => String(c).trim())) {
    throw new RowError("No channels. Add at least one platform, account name or channel id to channels.");
  }
  if (row.scheduled_at && Number.isNaN(Date.parse(row.scheduled_at))) {
    throw new RowError(`scheduled_at "${row.scheduled_at}" is not a valid time.`);
  }
}

/**
 * The time to schedule for, or null to publish now. A time that has already
 * passed (the row was picked up late) publishes now rather than failing.
 */
export function effectiveSchedule(scheduledAt: string | null, now = Date.now()): string | null {
  if (!scheduledAt) return null;
  const t = Date.parse(scheduledAt);
  return Number.isNaN(t) || t <= now ? null : scheduledAt;
}

export type MediaRef =
  | { kind: "storage"; bucket: string; path: string; filename: string }
  | { kind: "url"; url: string; filename: string }
  | { kind: "library"; id: number };

/**
 * `storage:<bucket>/<path>` for this project's Storage, `bulkpublish:<id>` for
 * a file already in the BulkPublish media library, otherwise an http(s) URL.
 */
export function parseMediaRef(ref: string): MediaRef {
  const value = String(ref).trim();
  const library = /^bulkpublish:(\d+)$/i.exec(value);
  if (library) return { kind: "library", id: Number(library[1]) };
  const storage = /^storage:\/{0,2}([^/]+)\/(.+)$/i.exec(value);
  if (storage) {
    const path = storage[2];
    return { kind: "storage", bucket: storage[1], path, filename: path.split("/").pop() || "file" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RowError(`Media "${value}" is not a URL. Use https://…, storage:<bucket>/<path> or bulkpublish:<media id>.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RowError(`Media "${value}" must be an http(s) URL or storage:<bucket>/<path>.`);
  }
  const last = decodeURIComponent(url.pathname.split("/").pop() || "");
  return { kind: "url", url: url.toString(), filename: last || "file" };
}

/**
 * The POST /api/posts body for one row.
 *
 * A row with no time is created as a draft and published straight after. With
 * approval requested and no time it is created scheduled for now instead,
 * because approval only applies to scheduled posts; `publishWhenApproved`
 * then sends it as soon as it is approved.
 */
export function buildPostBody(args: {
  caption: string;
  channelIds: number[];
  mediaIds?: number[];
  scheduledAt?: string | null;
  timezone?: string | null;
  requestApproval?: boolean;
  platformSpecific?: Record<string, unknown> | null;
  now?: number;
}): Json {
  const { caption, channelIds, mediaIds = [], scheduledAt = null, timezone = null, requestApproval = false } = args;
  const body: Json = {
    content: caption,
    channels: channelIds.map((channelId) => ({ channelId })),
    mediaFiles: mediaIds,
    status: scheduledAt || requestApproval ? "scheduled" : "draft",
  };
  if (scheduledAt) {
    body.scheduledAt = new Date(scheduledAt).toISOString();
    if (timezone) body.timezone = timezone;
  } else if (requestApproval) {
    body.scheduledAt = new Date(args.now ?? Date.now()).toISOString();
    body.publishWhenApproved = true;
  }
  if (requestApproval) body.requestApproval = true;
  if (args.platformSpecific && Object.keys(args.platformSpecific).length) body.platformSpecific = args.platformSpecific;
  return body;
}

const PENDING = new Set(["pending", "publishing", "processing", "uploading"]);
const minutesFrom = (now: number, minutes: number) => new Date(now + minutes * 60_000).toISOString();

function destinations(post: Json): DestinationResult[] {
  return (post?.postPlatforms || []).map((p: Json) => ({
    platform: p.platform,
    channelId: p.channelId ?? null,
    status: p.status,
    url: p.platformUrl || null,
    error: p.status === "unconfirmed"
      ? "The platform did not confirm the post. Check the account before retrying, or it may be posted twice."
      : p.errorMessage || null,
  }));
}

/**
 * Read a BulkPublish post back into a row update. Called right after a post is
 * created, and again on each check until the row settles.
 */
export function outcomeFor(post: Json, now = Date.now(), claimedAt: string | null = null): RowUpdate {
  const id = post?.id;
  const dests = destinations(post);

  if (post?.approvalStatus === "pending") {
    return {
      status: "pending_approval",
      result: `Waiting for a teammate to approve post ${id} at ${APP_POSTS_URL}.`,
      post_urls: dests,
      // Each check is one API request; approval can take a day.
      next_check_at: minutesFrom(now, 60),
    };
  }
  if (post?.approvalStatus === "rejected") {
    return {
      status: "failed",
      result: `Rejected in review${post.rejectionReason ? `: ${post.rejectionReason}` : ""}. ` +
        `Edit the row and set it to ready to submit a new post.`,
      post_urls: dests,
      next_check_at: null,
    };
  }
  if (post?.status === "draft") {
    return {
      status: "failed",
      result: post?.approvalStatus === "approved"
        ? `Post ${id} was approved after its time had passed, so it was not published. ` +
          `Choose a new time for it at ${APP_POSTS_URL}.`
        : `Post ${id} is a draft in BulkPublish and was not published. Publish it from ${APP_POSTS_URL}.`,
      post_urls: dests,
      next_check_at: null,
    };
  }
  if (post?.status === "scheduled") {
    const at = Date.parse(post.scheduledAt);
    const due = Number.isNaN(at) ? now : at;
    return {
      status: "scheduled",
      result: `Scheduled for ${post.scheduledAt} (post ${id}).`,
      post_urls: dests,
      next_check_at: new Date(Math.max(due, now) + 60_000).toISOString(),
    };
  }

  const settledPost = ["published", "partial", "failed"].includes(post?.status);
  if (!dests.length && settledPost) {
    return {
      status: post.status === "published" ? "posted" : post.status,
      result: post.status === "published" ? `Published (post ${id}).` : `Post ${id} ${post.status}. See ${APP_POSTS_URL}.`,
      post_urls: [],
      next_check_at: null,
    };
  }
  const pending = dests.filter((d) => PENDING.has(d.status));
  if (!dests.length || pending.length) {
    // Each check is one API request. Most posts settle within minutes; one
    // held back by a network's own daily limit can take hours.
    const claimed = claimedAt ? Date.parse(claimedAt) : NaN;
    const ageMinutes = Number.isNaN(claimed) ? 0 : (now - claimed) / 60_000;
    return {
      status: "posting",
      result: `Publishing post ${id}…`,
      post_urls: dests,
      next_check_at: minutesFrom(now, ageMinutes < 10 ? 0.5 : ageMinutes < 60 ? 5 : 30),
    };
  }

  const ok = dests.filter((d) => d.status === "published");
  const lines = dests.map((d) =>
    d.status === "published"
      ? `${d.platform}: ${d.url || "published"}`
      : `${d.platform} ${d.status === "unconfirmed" ? "UNCONFIRMED" : "FAILED"}: ${d.error || "unknown error"}`
  );
  return {
    status: ok.length === dests.length ? "posted" : ok.length ? "partial" : "failed",
    result: lines.join("\n"),
    post_urls: dests,
    next_check_at: null,
  };
}

/** Message for a publish refused because the key's role cannot publish. */
export function approvalRequiredMessage(postId: number): string {
  return `Your BulkPublish role can't publish directly (post ${postId} was left as a draft). ` +
    `Set request_approval to true and the row to ready again, then a teammate approves it.`;
}

/** Constant-time string compare for the shared secret. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Midnight UTC after `now`, when the daily API request allowance resets. */
export function nextUtcMidnight(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 1)).toISOString();
}

/**
 * The key the function uses to reach its own database. New projects provide
 * SUPABASE_SECRET_KEYS (JSON, keyed by name); older ones the legacy
 * SUPABASE_SERVICE_ROLE_KEY.
 */
export function serverKey(get: (name: string) => string | undefined): string | null {
  const keys = get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const parsed = JSON.parse(keys);
      const key = parsed?.default ?? Object.values(parsed || {})[0];
      if (typeof key === "string" && key) return key;
    } catch {
      // fall through to the legacy key
    }
  }
  return get("SUPABASE_SERVICE_ROLE_KEY") || null;
}
