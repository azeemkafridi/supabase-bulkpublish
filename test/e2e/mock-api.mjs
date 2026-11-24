// Stand-in BulkPublish API for the local end-to-end run. Responses have the
// shapes of the real API calls the function makes. Control endpoints start with /__.
import http from "node:http";

const KEY = "bp_test_key";
const channels = [
  { id: 1, platform: "x", accountName: "acme", isActive: true },
  { id: 2, platform: "linkedin", accountName: "Acme Inc", isActive: true },
  { id: 5, platform: "discord", accountName: "Acme Server", isActive: true, metadata: {} },
];
const sets = [{ id: 9, name: "Launch", channelIds: [1, 2] }];
const posts = new Map();
const log = [];
let nextPost = 100, nextMedia = 500;
const failures = { 429: 0 };

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const body = await readBody(req);

  if (p === "/__log") return json(res, 200, log);
  if (p === "/__posts") return json(res, 200, [...posts.values()]);
  if (p === "/__fail429") { failures[429] = Number(url.searchParams.get("n") || 1); return json(res, 200, failures); }
  const approve = /^\/__approve\/(\d+)$/.exec(p);
  if (approve) {
    const post = posts.get(Number(approve[1]));
    post.approvalStatus = "approved";
    post.status = "publishing";
    setTimeout(() => settle(post), 1500);
    return json(res, 200, post);
  }

  const entry = { method: req.method, path: p, at: new Date().toISOString(), bytes: body.length };
  log.push(entry);
  if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error: { message: "Invalid API key", code: "UNAUTHORIZED" } });
  if (failures[429] > 0) { failures[429]--; return json(res, 429, { error: { message: "Too many requests", code: "RATE_LIMITED" } }); }

  if (req.method === "GET" && p === "/api/channels") return json(res, 200, { channels });
  if (req.method === "GET" && p === "/api/channel-sets") return json(res, 200, sets);
  if (req.method === "GET" && p === "/api/channels/5/options") {
    return json(res, 200, { type: "discord_channel", items: [{ id: "111", name: "general" }, { id: "222", name: "news" }] });
  }
  if (req.method === "POST" && p === "/api/media") {
    const name = /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1];
    entry.file = name;
    return json(res, 201, { file: { id: nextMedia++, originalName: name, size: body.length } });
  }
  if (req.method === "POST" && p === "/api/posts") {
    const b = JSON.parse(body.toString());
    entry.body = b;
    const post = {
      id: nextPost++,
      content: b.content,
      status: b.status,
      scheduledAt: b.scheduledAt || null,
      approvalStatus: b.requestApproval ? "pending" : "none",
      rejectionReason: null,
      mediaFiles: b.mediaFiles,
      platformSpecific: b.platformSpecific || null,
      postPlatforms: b.channels.map((c) => {
        const ch = channels.find((x) => x.id === c.channelId);
        return { id: c.channelId * 1000, channelId: c.channelId, platform: ch.platform, status: "pending", platformUrl: null, errorMessage: null };
      }),
    };
    posts.set(post.id, post);
    return json(res, 201, post);
  }
  const pub = /^\/api\/posts\/(\d+)\/publish$/.exec(p);
  if (req.method === "POST" && pub) {
    const post = posts.get(Number(pub[1]));
    if (!post) return json(res, 404, { error: { message: "Not found" } });
    if (post.content.includes("NOROLE")) return json(res, 403, { error: { message: "Approval required", code: "APPROVAL_REQUIRED" } });
    post.status = "publishing";
    setTimeout(() => settle(post), 1500);
    return json(res, 200, post);
  }
  const get = /^\/api\/posts\/(\d+)$/.exec(p);
  if (req.method === "GET" && get) {
    const post = posts.get(Number(get[1]));
    if (!post) return json(res, 404, { error: { message: "Post not found", code: "NOT_FOUND" } });
    // A scheduled post whose time has come goes out when it is read.
    if (post.status === "scheduled" && post.approvalStatus !== "pending" && Date.parse(post.scheduledAt) <= Date.now()) settle(post);
    return json(res, 200, post);
  }
  return json(res, 404, { error: { message: `No route ${req.method} ${p}` } });
}).listen(8787, "0.0.0.0", () => console.log("mock api on :8787"));

function settle(post) {
  for (const d of post.postPlatforms) {
    if (post.content.includes("XFAIL") && d.platform === "x") {
      d.status = "failed";
      d.errorMessage = "X refused the post: duplicate content";
    } else {
      d.status = "published";
      d.platformUrl = `https://${d.platform}.example/post/${post.id}`;
    }
  }
  const ok = post.postPlatforms.filter((d) => d.status === "published").length;
  post.status = ok === post.postPlatforms.length ? "published" : ok ? "partial" : "failed";
}
