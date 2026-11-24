import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BulkPublishClient,
  BulkPublishError,
  buildPostBody,
  checkCharLimits,
  outcomeFor,
  parseMediaRef,
  resolveChannels,
  resolveDiscordChannel,
  RowError,
  safeEqual,
  validateRow,
} from "../supabase/functions/bulkpublish/core.ts";

const channels = [
  { id: 1, platform: "x", accountName: "acme" },
  { id: 2, platform: "linkedin", accountName: "Acme Inc" },
  { id: 3, platform: "x", accountName: "acme_support" },
  { id: 4, platform: "instagram", accountName: "acme.ig", isActive: false },
  { id: 5, platform: "discord", accountName: "Acme Server" },
];
const sets = [{ id: 9, name: "Launch", channelIds: [2, 3] }];

test("platform name selects every active channel on it", () => {
  assert.deepEqual(resolveChannels(["x"], channels).map((c) => c.id), [1, 3]);
});

test("ids, account names and sets resolve; duplicates collapse", () => {
  const ids = resolveChannels(["2", "acme", "launch", "x"], channels, sets).map((c) => c.id).sort();
  assert.deepEqual(ids, [1, 2, 3]);
});

test("inactive channels and unknown names are refused with the choices", () => {
  assert.throws(() => resolveChannels(["instagram"], channels), (e: Error) =>
    e instanceof RowError && /not found/.test(e.message) && /linkedin \(Acme Inc\)/.test(e.message));
});

test("caption limits name each platform that is over", () => {
  const targets = resolveChannels(["x", "linkedin"], channels);
  assert.equal(checkCharLimits("a".repeat(280), targets), null);
  assert.match(checkCharLimits("a".repeat(281), targets) || "", /x allows 280/);
});

test("emoji count as one character", () => {
  assert.equal(checkCharLimits("😀".repeat(280), resolveChannels(["x"], channels)), null);
});

test("discord: picks by name or id, refuses when nothing can be chosen", () => {
  const server = channels[4];
  const opts = [{ id: "111", name: "general" }, { id: "222", name: "news" }];
  assert.equal(resolveDiscordChannel("#news", server, opts), "222");
  assert.equal(resolveDiscordChannel("111", server, opts), "111");
  assert.equal(resolveDiscordChannel(null, { ...server, metadata: { channelId: "111" } }, opts), null);
  assert.throws(() => resolveDiscordChannel(null, server, opts), /#general, #news/);
  assert.throws(() => resolveDiscordChannel("random", server, opts), RowError);
});

test("row validation", () => {
  const base = {
    id: 1, caption: "hi", channels: ["x"], media: [], scheduled_at: null, timezone: null,
    request_approval: false, discord_channel: null, status: "posting", bulkpublish_post_id: null,
  };
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.doesNotThrow(() => validateRow(base, now));
  assert.throws(() => validateRow({ ...base, caption: "  " }, now), /Caption is empty/);
  assert.throws(() => validateRow({ ...base, channels: [" "] }, now), /No channels/);
  assert.throws(() => validateRow({ ...base, scheduled_at: "2026-11-24T11:00:00Z" }, now), /in the past/);
  assert.throws(() => validateRow({ ...base, scheduled_at: "soon" }, now), /not a valid time/);
});

test("media refs: storage paths and URLs", () => {
  assert.deepEqual(parseMediaRef("storage:images/launch/hero.png"), {
    kind: "storage", bucket: "images", path: "launch/hero.png", filename: "hero.png",
  });
  assert.equal(parseMediaRef("storage://images/a.jpg").kind, "storage");
  const u = parseMediaRef("https://cdn.example.com/a%20b.jpg?x=1");
  assert.equal(u.kind, "url");
  assert.equal(u.filename, "a b.jpg");
  assert.throws(() => parseMediaRef("ftp://x/y.png"), RowError);
  assert.throws(() => parseMediaRef("hero.png"), RowError);
});

test("post body: now, scheduled, approval with and without a time", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.deepEqual(buildPostBody({ caption: "hi", channelIds: [1, 2] }), {
    content: "hi", channels: [{ channelId: 1 }, { channelId: 2 }], mediaFiles: [], status: "draft",
  });

  const scheduled = buildPostBody({
    caption: "hi", channelIds: [1], scheduledAt: "2026-12-01 09:00:00+00", timezone: "Europe/Berlin",
  });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.scheduledAt, "2026-12-01T09:00:00.000Z");
  assert.equal(scheduled.timezone, "Europe/Berlin");
  assert.equal(scheduled.publishWhenApproved, undefined);

  const held = buildPostBody({ caption: "hi", channelIds: [1], requestApproval: true, now });
  assert.equal(held.status, "scheduled");
  assert.equal(held.scheduledAt, "2026-11-24T12:00:00.000Z");
  assert.equal(held.publishWhenApproved, true);
  assert.equal(held.requestApproval, true);

  const discord = buildPostBody({ caption: "hi", channelIds: [5], platformSpecific: { discord: { 5: { channelId: "1" } } } });
  assert.deepEqual(discord.platformSpecific, { discord: { 5: { channelId: "1" } } });
  assert.equal(buildPostBody({ caption: "hi", channelIds: [1], platformSpecific: {} }).platformSpecific, undefined);
});

const now = Date.parse("2026-11-24T12:00:00Z");

test("outcome: all published → posted with URLs", () => {
  const u = outcomeFor({
    id: 7, status: "published",
    postPlatforms: [
      { platform: "x", channelId: 1, status: "published", platformUrl: "https://x.com/acme/status/1" },
      { platform: "linkedin", channelId: 2, status: "published", platformUrl: null },
    ],
  }, now);
  assert.equal(u.status, "posted");
  assert.equal(u.next_check_at, null);
  assert.match(u.result || "", /x: https:\/\/x.com/);
  assert.equal(u.post_urls?.length, 2);
});

test("outcome: mixed → partial; unconfirmed is never called posted", () => {
  const u = outcomeFor({
    id: 7, status: "partial",
    postPlatforms: [
      { platform: "x", status: "published", platformUrl: "u" },
      { platform: "linkedin", status: "unconfirmed" },
    ],
  }, now);
  assert.equal(u.status, "partial");
  assert.match(u.result || "", /linkedin UNCONFIRMED: .*posted twice/);
});

test("outcome: all failed → failed with each error", () => {
  const u = outcomeFor({ id: 7, status: "failed", postPlatforms: [{ platform: "x", status: "failed", errorMessage: "Duplicate" }] }, now);
  assert.equal(u.status, "failed");
  assert.match(u.result || "", /x FAILED: Duplicate/);
});

test("outcome: still publishing → check again shortly", () => {
  const u = outcomeFor({ id: 7, status: "publishing", postPlatforms: [{ platform: "x", status: "publishing" }] }, now);
  assert.equal(u.status, "posting");
  assert.equal(u.next_check_at, "2026-11-24T12:00:30.000Z");
});

test("outcome: failed post with no destinations settles instead of looping", () => {
  assert.equal(outcomeFor({ id: 7, status: "failed", postPlatforms: [] }, now).status, "failed");
  assert.equal(outcomeFor({ id: 7, status: "published", postPlatforms: [] }, now).status, "posted");
});

test("outcome: scheduled → checked a minute after its time", () => {
  const u = outcomeFor({ id: 7, status: "scheduled", scheduledAt: "2026-12-01T09:00:00.000Z", postPlatforms: [] }, now);
  assert.equal(u.status, "scheduled");
  assert.equal(u.next_check_at, "2026-12-01T09:01:00.000Z");
});

test("outcome: approval pending, rejected, approved too late", () => {
  assert.equal(outcomeFor({ id: 7, status: "scheduled", approvalStatus: "pending" }, now).status, "pending_approval");
  const rejected = outcomeFor({ id: 7, status: "draft", approvalStatus: "rejected", rejectionReason: "Off brand" }, now);
  assert.equal(rejected.status, "failed");
  assert.match(rejected.result || "", /Off brand/);
  const late = outcomeFor({ id: 7, status: "draft", approvalStatus: "approved" }, now);
  assert.equal(late.status, "failed");
  assert.match(late.result || "", /new time/);
});

test("client: bearer auth, JSON body, API errors carry status and code", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/publish")) {
      return new Response(JSON.stringify({ error: { message: "Needs approval", code: "APPROVAL_REQUIRED" } }), { status: 403 });
    }
    return new Response(JSON.stringify({ id: 7 }), { status: 201 });
  }) as unknown as typeof fetch;
  const bp = new BulkPublishClient({ apiKey: "bp_test", baseUrl: "https://example.test/", fetchImpl: fakeFetch });

  assert.deepEqual(await bp.createPost({ content: "hi" }), { id: 7 });
  assert.equal(calls[0].url, "https://example.test/api/posts");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer bp_test");
  assert.equal(calls[0].init.body, JSON.stringify({ content: "hi" }));

  await assert.rejects(bp.publishPost(7), (e: unknown) =>
    e instanceof BulkPublishError && e.status === 403 && e.code === "APPROVAL_REQUIRED");
});

test("client: media upload is multipart with the file under 'file'", async () => {
  let form: FormData | null = null;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    form = init.body as FormData;
    assert.equal((init.headers as Record<string, string>)["Content-Type"], undefined);
    return new Response(JSON.stringify({ file: { id: 3 } }), { status: 201 });
  }) as unknown as typeof fetch;
  const bp = new BulkPublishClient({ apiKey: "k", fetchImpl: fakeFetch });
  assert.deepEqual(await bp.uploadMedia(new Blob(["x"], { type: "image/png" }), "a.png"), { id: 3 });
  const file = (form as unknown as FormData).get("file") as File;
  assert.equal(file.name, "a.png");
});

test("channel sets are optional", async () => {
  const bp = new BulkPublishClient({
    apiKey: "k",
    fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
  });
  assert.deepEqual(await bp.listChannelSets(), []);
});

test("secret compare", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", "x"), false);
});
