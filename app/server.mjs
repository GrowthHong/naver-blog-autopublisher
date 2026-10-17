// 네이버 블로그 자동발행기 — 로컬 웹 UI (배포판)
// 원고 생성(클로드) → 검사 → 크롬 자동 입력·예약 설정 → 사람이 발행 클릭. 이웃·댓글·통계까지 한 곳에서.
import http from "node:http";
import { readFile, readdir, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { checkPost } from "../scripts/seo-rules.mjs";
import { APP_DIR, DATA_DIR, paths, ensureDirs } from "../lib/paths.mjs";
import { fillEditor, openLogin, openBlog, autoBuddyRequest, closeBrowser, inspectPostwrite, probeBuddyFeed, fetchAsBlog, evalOnPage, evalOnOpenPage, buddyTry, buddyTryPc } from "./publisher.mjs";
import { DAILY_CAP, discoverCandidates, loadCandidates, markRequested, markSkipped, todayRequestedCount, useBlogContext, useIntro } from "./neighbors.mjs";
import { job as generateJob, startGeneration } from "./generator.mjs";
import { collectStats, buildStatsReport, useStatsContext } from "./stats.mjs";
import { listIncoming, acceptIncoming } from "./accept.mjs";
import { loadState as loadCommentState, useCommentContext, listCandidates as listCommentCandidates, suggestComment, postComment, markSkipped as skipComment } from "./comments.mjs";
import { execFile } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
ensureDirs();
const CONFIG_PATH = paths.config;
async function loadUserCfg() { try { return JSON.parse(await readFile(CONFIG_PATH, "utf8")); } catch { return {}; } }

// ── 예약 발행 슬롯 ──
// 하루 발행 수 = 설정한 예약 시각 개수(기본 08:30, 20:30 → 2편). 네이버는 예약 글 목록을 API로 내주지 않으므로,
// 우리가 기록한 예약(schedule.json)을 매번 실제 블로그 글 목록과 대조해 정리한다:
//  - 예약 시각보다 먼저 올라간 글 = 사용자가 "현재"로 바로 발행함 → 예약에서 빼고 그날 발행 수에 넣는다
//  - 예약 시각이 3시간 넘게 지났는데 안 올라온 글 = 발행 버튼이 안 눌렸거나 제목이 바뀜 → 예약에서 빼고 알려 준다
// 그날 발행 수(올라간 글 + 남은 예약)가 하루 슬롯 수에 차면 다음 날로 넘어간다.
const SCHEDULE_PATH = paths.state("schedule");
async function loadSchedule() { try { return JSON.parse(await readFile(SCHEDULE_PATH, "utf8")); } catch { return {}; } }
async function recordSchedule(file, at, title) { const s = await loadSchedule(); s[file] = { at, title }; await writeFile(SCHEDULE_PATH, JSON.stringify(s, null, 2)); }
function parseTimes(u) {
  const raw = u.publishTimes !== undefined ? u.publishTimes : (u.publishTime !== undefined ? u.publishTime : "20:30");
  if (raw === "" || raw === null) return []; // 예약 안 함(즉시 발행)
  return [...new Set(String(raw).split(/[,\s]+/).filter((t) => /^\d{2}:\d{2}$/.test(t)))].sort();
}
const normTitle = (t) => String(t || "").replace(/\s+/g, "");
const kstDateOf = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
let _pubCache = { blogId: null, at: 0, items: [] };
async function fetchPublished(blogId) {
  if (_pubCache.blogId === blogId && Date.now() - _pubCache.at < 60000) return _pubCache.items;
  try {
    const r = await fetch(`https://m.blog.naver.com/api/blogs/${blogId}/post-list?categoryNo=0&itemCount=30&page=1`, { headers: { "User-Agent": "Mozilla/5.0", Referer: `https://m.blog.naver.com/${blogId}` } });
    const items = ((await r.json())?.result?.items || []).map((x) => ({ logNo: String(x.logNo), title: String(x.titleWithInspectMessage || ""), addDate: Number(x.addDate) || 0 }));
    _pubCache = { blogId, at: Date.now(), items };
  } catch { /* 네트워크 없음 → 이전 캐시 */ }
  return _pubCache.items;
}
async function titleOfFile(blog, file) {
  try { return (await readFile(path.join(blog.draftsDir, file), "utf8")).split("\n")[0].replace(/^제목:\s*/, "").trim(); } catch { /* 보관됨 */ }
  try { const pd = publishedDirOf(blog); const f = (await readdir(pd)).find((x) => x.endsWith(file)); if (f) return (await readFile(path.join(pd, f), "utf8")).split("\n")[0].replace(/^제목:\s*/, "").trim(); } catch { /* 없음 */ }
  return null;
}
async function reconcileSchedule(blog) {
  const s = await loadSchedule();
  const published = await fetchPublished(blog.blogId);
  const byTitle = new Map(published.map((p) => [normTitle(p.title), p]));
  const now = Date.now(); const reserved = []; const notes = []; let changed = false;
  for (const [file, v] of Object.entries(s)) {
    const at = typeof v === "string" ? v : v?.at; if (!at) { delete s[file]; changed = true; continue; }
    let title = typeof v === "string" ? null : v.title;
    if (!title) { title = await titleOfFile(blog, file); if (title) { s[file] = { at, title }; changed = true; } }
    const atMs = new Date(at).getTime();
    const pub = title ? byTitle.get(normTitle(title)) : null;
    if (pub) {
      if (pub.addDate < atMs - 10 * 60000) notes.push({ kind: "immediate", file, title, at, publishedAt: pub.addDate });
      delete s[file]; changed = true; continue;
    }
    if (atMs < now - 3 * 3600000) { notes.push({ kind: "stale", file, title, at }); delete s[file]; changed = true; continue; }
    reserved.push({ file, title, at });
  }
  if (changed) await writeFile(SCHEDULE_PATH, JSON.stringify(s, null, 2));
  const occ = {};
  for (const p of published) { const d = kstDateOf(p.addDate); occ[d] = (occ[d] || 0) + 1; }
  for (const x of reserved) { const d = kstDateOf(new Date(x.at).getTime()); occ[d] = (occ[d] || 0) + 1; }
  reserved.sort((a, b) => a.at.localeCompare(b.at));
  return { reserved, published, notes, occ };
}
async function nextPublishSlot(times, blog) {
  if (!times.length) return { at: null };
  const { reserved, occ, notes } = await reconcileSchedule(blog);
  const perDay = times.length;
  const taken = new Set(reserved.map((x) => new Date(new Date(x.at).getTime() + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ")));
  const nowMs = Date.now(); const nowKst = new Date(nowMs + 9 * 3600000);
  let day = Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate());
  for (let i = 0; i < 90; i += 1) {
    const key = new Date(day).toISOString().slice(0, 10);
    if ((occ[key] || 0) < perDay) {
      for (const t of times) {
        const [h, m] = t.split(":").map(Number);
        const atMs = day + (h * 60 + m) * 60000 - 9 * 3600000; // KST → UTC
        if (atMs < nowMs + 20 * 60000) continue; // 20분 안쪽 슬롯은 못 잡는다
        if (taken.has(`${key} ${t}`)) continue;
        return { at: new Date(atMs).toISOString(), kst: `${key} ${t}`, perDay, dayCount: occ[key] || 0, queueAhead: reserved.length, notes };
      }
    }
    day += 86400000;
  }
  return { at: null };
}
const PORT = Number(process.env.PORT) || 5071;

// ── 블로그 설정 (blogs.json) — 설정 화면에서 쓴다. 비어 있으면 첫 실행 안내가 뜬다 ──
const DEFAULT_THEME = { heading: "#0f4c5c", number: "#b91c1c" };
async function loadBlogs() { try { return JSON.parse(await readFile(paths.blogs, "utf8")); } catch { return {}; } }
async function saveBlogs(blogs) { await mkdir(path.dirname(paths.blogs), { recursive: true }); await writeFile(paths.blogs, JSON.stringify(blogs, null, 2)); }
function normalizeBlog(key, raw) {
  const list = (v) => (Array.isArray(v) ? v : String(v || "").split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);
  return {
    key,
    label: String(raw.label || raw.blogId || key).trim(),
    blogId: String(raw.blogId || "").trim(),
    blogName: String(raw.blogName || raw.label || "").trim(),      // 글 하단 고정 문구에 쓰는 블로그 이름
    topicDescription: String(raw.topicDescription || "").trim(),   // 어떤 글을 쓰는 블로그인지 한 문단
    audience: String(raw.audience || "").trim(),                   // 독자
    intro: String(raw.intro || "").trim(),                         // 서로이웃 인사용 내 소개 한 줄
    persona: String(raw.persona || "").trim(),                     // 댓글 쓸 때의 화자
    keywords: list(raw.keywords),                                  // 이웃 후보 검색어
    topicWords: list(raw.topicWords),                              // 댓글 후보 우선순위 단어
    siteUrl: String(raw.siteUrl || "").trim(),                     // 연동 사이트(선택) — 딥링크·유입 통계
    postType: raw.postType || "info",                           // 글 유형: info·review·howto·trend·essay (prompts/post-types.json)
    styleProfile: raw.styleProfile || "default",
    theme: raw.theme || DEFAULT_THEME,
    draftsDir: paths.drafts(key), profile: paths.profile(key),
    promptFile: path.join(paths.prompts, "draft-prompt.md"), promptCwd: paths.drafts(key),
    gitPull: false,
  };
}
async function loadConfig() { return loadUserCfg(); }
async function activeBlog() {
  const config = await loadConfig();
  const blogs = await loadBlogs();
  const key = config.active && blogs[config.active] ? config.active : Object.keys(blogs)[0];
  if (!key) return null;
  const blog = normalizeBlog(key, blogs[key]);
  ensureDirs(key);
  useBlogContext({ key: blog.key, keywords: blog.keywords, messages: null });
  useIntro(blog.intro);
  useCommentContext(blog);
  useStatsContext(blog);
  return blog;
}
const publishedDirOf = (blog) => path.join(blog.draftsDir, "published");

function parseDraft(raw) {
  const lines = raw.split("\n");
  let title = "";
  const bodyLines = [];
  for (const line of lines) {
    if (!title && line.startsWith("제목:")) {
      title = line.slice(3).trim();
      continue;
    }
    bodyLines.push(line);
  }
  return { title, body: bodyLines.join("\n").trim() };
}

async function listDrafts(blog) {
  await mkdir(blog.draftsDir, { recursive: true }).catch(() => {});
  const files = (await readdir(blog.draftsDir)).filter((f) => f.endsWith(".md") && f.startsWith("post-"));
  const drafts = [];
  for (const file of files.sort()) {
    const raw = await readFile(path.join(blog.draftsDir, file), "utf8");
    const { title, body } = parseDraft(raw);
    const check = await checkPost({ title, body, publishedDir: publishedDirOf(blog) });
    drafts.push({ file, title, bodyPreview: body.slice(0, 120), seoOk: check.ok, failCount: check.failed.length });
  }
  return drafts;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const autoJob = { running: false, stopRequested: false, total: 0, results: [] };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(path.join(ROOT, "public/index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const config = await loadConfig();
      const blogsNow = await loadBlogs();
      const blog = await activeBlog();
      if (!blog) return json(res, 200, { needsSetup: true, drafts: [], blogs: [], userCfg: config, dataDir: DATA_DIR });
      return json(res, 200, {
        needsSetup: false,
        drafts: await listDrafts(blog),
        blogId: blog.blogId,
        active: blog.key,
        blogs: Object.keys(blogsNow).map((k) => ({ key: k, label: blogsNow[k].label || blogsNow[k].blogId || k, blogId: blogsNow[k].blogId })),
        blog: { ...blog, draftsDir: undefined, profile: undefined, promptFile: undefined, promptCwd: undefined },
        userCfg: config,
        dataDir: DATA_DIR,
      });
    }
    // ── 첫 실행 설정 / 블로그 설정 저장 ──
    if (req.method === "GET" && url.pathname === "/api/blogs") {
      const types = JSON.parse(await readFile(path.join(paths.prompts, "post-types.json"), "utf8").catch(() => "{}"));
      return json(res, 200, { blogs: await loadBlogs(), config: await loadConfig(), postTypes: Object.fromEntries(Object.entries(types).map(([k, v]) => [k, { label: v.label, hint: v.hint }])) });
    }
    if (req.method === "POST" && url.pathname === "/api/blogs") {
      const body = await readBody(req);
      const blogsNow = await loadBlogs();
      const key = String(body.key || body.blogId || "main").replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || "main";
      if (!String(body.blogId || "").trim()) return json(res, 400, { ok: false, message: "네이버 블로그 아이디는 꼭 필요합니다" });
      blogsNow[key] = { ...(blogsNow[key] || {}), ...body, key };
      delete blogsNow[key].draftsDir; delete blogsNow[key].profile;
      await saveBlogs(blogsNow);
      const config = await loadConfig();
      if (!config.active || !blogsNow[config.active]) config.active = key;
      if (config.publishTime === undefined) config.publishTime = "20:30";
      if (config.publishTimes === undefined) config.publishTimes = config.publishTime || "20:30";
      if (!config.dailyTarget) config.dailyTarget = 1;
      await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
      await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
      ensureDirs(key);
      return json(res, 200, { ok: true, key });
    }
    if (req.method === "POST" && url.pathname === "/api/keys") {
      // 선택 항목: 네이버 검색광고 API 키(검색량), NAVER API HUB 검색 API 키(경쟁 구성), 클로드 장기 토큰
      const body = await readBody(req);
      if (body.searchad && body.searchad.customerId) await writeFile(paths.searchad, JSON.stringify(body.searchad, null, 2), { mode: 0o600 });
      if (body.openapi && body.openapi.keyId && body.openapi.key) await writeFile(paths.openapi, JSON.stringify({ keyId: String(body.openapi.keyId).trim(), key: String(body.openapi.key).trim() }, null, 2), { mode: 0o600 });
      if (body.oauthToken !== undefined) { if (String(body.oauthToken).trim()) await writeFile(paths.oauthToken, String(body.oauthToken).trim(), { mode: 0o600 }); }
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/") && !["/api/state", "/api/blogs", "/api/keys", "/api/config"].includes(url.pathname) && !(await activeBlog())) {
      return json(res, 400, { ok: false, message: "먼저 설정 탭에서 블로그 정보를 저장하세요." });
    }
    if (req.method === "GET" && url.pathname === "/api/draft") {
      const blog = await activeBlog();
      const file = path.basename(url.searchParams.get("file") ?? "");
      const raw = await readFile(path.join(blog.draftsDir, file), "utf8");
      const { title, body } = parseDraft(raw);
      return json(res, 200, { file, title, body, check: await checkPost({ title, body, publishedDir: publishedDirOf(blog) }) });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readBody(req);
      const config = await loadConfig();
      const blogsNow = await loadBlogs();
      if (body.active !== undefined && blogsNow[body.active]) config.active = body.active;
      if (body.buddyDailyCap !== undefined) {
        config.buddyDailyCap = Math.max(1, Math.min(100, Number(body.buddyDailyCap) || 30));
      }
      if (body.dailyTarget !== undefined || body.publishMax !== undefined || body.publishTime !== undefined || body.publishTimes !== undefined || body.publishTopic !== undefined) {
        const u = config;
        if (body.publishTimes !== undefined || body.publishTime !== undefined) {
          const raw = body.publishTimes !== undefined ? body.publishTimes : body.publishTime;
          const list = [...new Set(String(raw ?? "").split(/[,\s]+/).filter((t) => /^\d{2}:\d{2}$/.test(t)))].sort();
          u.publishTimes = list.join(","); u.publishTime = list[0] || "";
        }
        if (body.publishTopic !== undefined) u.publishTopic = String(body.publishTopic || "비즈니스·경제");
        if (body.dailyTarget !== undefined) u.dailyTarget = Math.max(1, Math.min(10, Number(body.dailyTarget) || 3));
        if (body.publishMax !== undefined) u.publishMax = Math.max(0, Math.min(20, Number(body.publishMax) || 0));
      }
      await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
      return json(res, 200, { ok: true, config });
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const blog = await activeBlog();
      return json(res, 200, await openLogin(blog.profile));
    }
    if (req.method === "POST" && url.pathname === "/api/fill") {
      const { file } = await readBody(req);
      const blog = await activeBlog();
      const raw = await readFile(path.join(blog.draftsDir, path.basename(file)), "utf8");
      const { title, body } = parseDraft(raw);
      const check = await checkPost({ title, body, publishedDir: publishedDirOf(blog) });
      if (!check.ok) {
        return json(res, 400, { ok: false, message: `SEO 검사 미통과 ${check.failed.length}건 — 수정 후 진행하세요.`, check });
      }
      const u = await loadUserCfg();
      const publish = { topic: u.publishTopic ?? "비즈니스·경제", scheduleAt: null };
      let slotNote = null;
      const times = parseTimes(u); // 비어 있으면 예약 안 함(즉시 발행)
      if (times.length) {
        const slot = await nextPublishSlot(times, blog);
        if (!slot.at) return json(res, 400, { ok: false, message: "앞으로 90일 안에 빈 예약 슬롯이 없습니다. 설정의 예약 시각을 확인하세요." });
        publish.scheduleAt = slot.at; slotNote = slot;
      }
      const result = await fillEditor({ blogId: blog.blogId, title, body, imagesDir: path.join(blog.draftsDir, "images"), profile: blog.profile, theme: blog.theme, publish });
      if (result.ok && slotNote) await recordSchedule(path.basename(file), slotNote.at, title);
      return json(res, 200, { ...result, schedule: slotNote });
    }
    // ── 발행 점검: 큐 원고를 블로그 글 목록(최근 60편)과 대조 → 올라간 글 / 예약된 글 / 미발행 ──
    if (req.method === "GET" && url.pathname === "/api/publish-check") {
      const blog = await activeBlog();
      const kstOf = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ");
      const files = existsSync(blog.draftsDir) ? (await readdir(blog.draftsDir)).filter((f) => /^post-.*\.md$/.test(f)).sort() : [];
      let posts = [];
      for (const page of [1, 2]) {
        try { const r = await fetch(`https://m.blog.naver.com/api/blogs/${blog.blogId}/post-list?categoryNo=0&itemCount=30&page=${page}`, { headers: { "User-Agent": "Mozilla/5.0", Referer: `https://m.blog.naver.com/${blog.blogId}` } }); posts.push(...(((await r.json())?.result?.items) || []).map((x) => ({ logNo: String(x.logNo), title: String(x.titleWithInspectMessage || ""), addDate: Number(x.addDate) || 0 }))); } catch { /* 네트워크 */ }
      }
      const byTitle = new Map(posts.map((x) => [normTitle(x.title), x]));
      const sched = await reconcileSchedule(blog);
      const reservedByFile = Object.fromEntries(sched.reserved.map((x) => [x.file, x]));
      const rows = [];
      for (const f of files) {
        const title = (await readFile(path.join(blog.draftsDir, f), "utf8")).split("\n")[0].replace(/^제목:\s*/, "").trim();
        const exact = byTitle.get(normTitle(title));
        const prefix = exact ? null : posts.find((x) => normTitle(x.title).slice(0, 12) === normTitle(title).slice(0, 12));
        const hit = exact || prefix;
        if (hit) rows.push({ file: f, title, state: "published", match: exact ? "exact" : "prefix", blogTitle: hit.title, publishedAt: kstOf(hit.addDate), publishedDate: kstOf(hit.addDate).slice(0, 10), url: `https://blog.naver.com/${blog.blogId}/${hit.logNo}` });
        else if (reservedByFile[f]) rows.push({ file: f, title, state: "reserved", reservedAt: kstOf(new Date(reservedByFile[f].at).getTime()) });
        else rows.push({ file: f, title, state: "pending" });
      }
      const u = await loadUserCfg(); const times = parseTimes(u);
      const next = times.length ? await nextPublishSlot(times, blog) : null;
      return json(res, 200, { checkedAt: kstOf(Date.now()), blogChecked: posts.length, rows, summary: { published: rows.filter((r) => r.state === "published").length, reserved: rows.filter((r) => r.state === "reserved").length, pending: rows.filter((r) => r.state === "pending").length }, notes: sched.notes.map((n) => ({ ...n, at: kstOf(new Date(n.at).getTime()), publishedAt: n.publishedAt ? kstOf(n.publishedAt) : null })), nextSlot: next?.kst || null, perDay: times.length, todayCount: sched.occ[new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)] || 0, latest: posts.slice(0, 5).map((x) => ({ title: x.title, at: kstOf(x.addDate) })) });
    }
    if (req.method === "POST" && url.pathname === "/api/archive") {
      const { file, date: dateArg } = await readBody(req);
      const blog = await activeBlog();
      const publishedDir = publishedDirOf(blog);
      if (!existsSync(publishedDir)) await mkdir(publishedDir, { recursive: true });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateArg || "")) ? String(dateArg) : new Date().toISOString().slice(0, 10);
      const safe = path.basename(file);
      await rename(path.join(blog.draftsDir, safe), path.join(publishedDir, `${date}-${safe}`));
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/debug/buddyfeed") {
      const blog = await activeBlog();
      return json(res, 200, await probeBuddyFeed(blog.profile, url.searchParams.get("u") || undefined));
    }
    if (req.method === "GET" && url.pathname === "/api/debug/fetch") {
      const blog = await activeBlog();
      const m = url.searchParams.get("m") || "GET";
      const b = url.searchParams.get("b");
      return json(res, 200, await fetchAsBlog(blog.profile, url.searchParams.get("u"), { method: m, body: b ?? undefined }));
    }
    if (req.method === "POST" && url.pathname === "/api/debug/eval") {
      const blog = await activeBlog();
      const { u, script } = await readBody(req);
      return json(res, 200, await evalOnPage(blog.profile, u, script));
    }
    if (req.method === "POST" && url.pathname === "/api/debug/eval-open") {
      const blog = await activeBlog();
      const { pattern, script, frame } = await readBody(req);
      return json(res, 200, await evalOnOpenPage(blog.profile, pattern || "postwrite|PostWrite", script, { frame }));
    }
    if (req.method === "POST" && url.pathname === "/api/debug/buddytry") {
      const blog = await activeBlog();
      const { blogId, message, shot, relation } = await readBody(req);
      return json(res, 200, await buddyTry(blogId, message, blog.profile, shot, relation || "both"));
    }
    if (req.method === "POST" && url.pathname === "/api/debug/buddytrypc") {
      const blog = await activeBlog();
      const { blogId, message, shot } = await readBody(req);
      return json(res, 200, await buddyTryPc(blogId, message, blog.profile, shot));
    }
    if (req.method === "GET" && url.pathname === "/api/debug/postwrite") {
      const blog = await activeBlog();
      return json(res, 200, await inspectPostwrite(blog.blogId, blog.profile));
    }
    // ── 새 원고 즉시 생성 (클로드 CLI 실행) ──
    if (req.method === "POST" && url.pathname === "/api/drafts/generate") {
      const { topic, notes } = await readBody(req);
      const blog = await activeBlog();
      return json(res, 200, await startGeneration(String(topic ?? ""), blog, String(notes ?? "")));
    }
    if (req.method === "GET" && url.pathname === "/api/drafts/generate/status") {
      return json(res, 200, generateJob);
    }
    // ── 오늘 홈: 큐·예약·이웃·댓글·성과·점검·시즌을 한 번에 ──
    if (req.method === "GET" && url.pathname === "/api/today") {
      const blog = await activeBlog();
      const readJson = async (p, fb) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fb; } };
      const todayKst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      const kstOf = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ");
      // 큐 + 예약
      const files = existsSync(blog.draftsDir) ? (await readdir(blog.draftsDir)).filter((f) => /^post-.*\.md$/.test(f)).sort() : [];
      const u = await loadUserCfg();
      const times = parseTimes(u);
      const sched = await reconcileSchedule(blog); // 실제 글 목록과 대조해 정리된 예약
      const reservedByFile = Object.fromEntries(sched.reserved.map((x) => [x.file, x.at]));
      const queue = [];
      for (const f of files) {
        const title = (await readFile(path.join(blog.draftsDir, f), "utf8")).split("\n")[0].replace(/^제목:\s*/, "").trim();
        queue.push({ file: f, title, scheduled: reservedByFile[f] ? kstOf(reservedByFile[f]) : null });
      }
      const next = times.length ? await nextPublishSlot(times, blog) : null;
      const scheduledDays = [...new Set(sched.reserved.map((x) => kstOf(x.at).slice(0, 10)))].filter((d) => d >= todayKst).sort();
      const perDay = times.length;
      const publishing = {
        perDay, times,
        todayCount: sched.occ[todayKst] || 0,
        todayPublished: sched.published.filter((p) => kstDateOf(p.addDate) === todayKst).map((p) => ({ title: p.title, at: kstOf(p.addDate) })),
        upcoming: sched.reserved.map((x) => ({ file: x.file, title: x.title, at: kstOf(x.at) })),
        immediate: sched.notes.filter((n) => n.kind === "immediate").map((n) => ({ title: n.title, plannedAt: kstOf(n.at), publishedAt: kstOf(n.publishedAt) })),
        stale: sched.notes.filter((n) => n.kind === "stale").map((n) => ({ file: n.file, title: n.title, plannedAt: kstOf(n.at) })),
      };
      // 블로그에 이미 올라간 제목 (중복 발행 경고) — 공개 API
      let dupes = [];
      try {
        const r = await fetch(`https://m.blog.naver.com/api/blogs/${blog.blogId}/post-list?categoryNo=0&itemCount=30&page=1`, { headers: { "User-Agent": "Mozilla/5.0", Referer: `https://m.blog.naver.com/${blog.blogId}` } });
        const titles = new Set(((await r.json())?.result?.items || []).map((x) => String(x.titleWithInspectMessage || "").replace(/\s+/g, "")));
        dupes = queue.filter((q) => titles.has(q.title.replace(/\s+/g, ""))).map((q) => q.file);
      } catch { /* 네트워크 없음 */ }
      // 이웃·댓글
      let incoming = null; try { incoming = (await listIncoming(blog.profile, blog.blogId)).length; } catch { /* 로그인 풀림 등 */ }
      const cs = await loadCommentState(blog.key);
      const commentsToday = Object.values(cs.done || {}).filter((d) => (d.at || "").slice(0, 10) === todayKst || kstOf(d.at || 0).slice(0, 10) === todayKst).length;
      const buddyToday = await todayRequestedCount();
      // 성과
      const sh = await readJson(paths.state("stats-history"), {});
      const dates = Object.keys(sh).sort();
      const last7 = dates.slice(-7), prev7 = dates.slice(-14, -7);
      const sum = (ds) => ds.reduce((a, d) => a + (sh[d]?.cv || 0), 0);
      const stats = dates.length ? { cv7: sum(last7), cvPrev7: prev7.length ? sum(prev7) : null, lastDate: dates.at(-1), lastCv: sh[dates.at(-1)]?.cv ?? 0, spark: last7.map((d) => sh[d]?.cv || 0), topQuery: (sh[dates.at(-1)]?.queries || [])[0]?.q || null } : null;
      const rh = await readJson(paths.state("rank-history"), []);
      const rl = rh.at?.(-1);
      const rank = rl ? { date: rl.date, total: rl.results.length, in60: rl.results.filter((r) => r.blogRank).length, top10: rl.results.filter((r) => r.blogRank && r.blogRank <= 10).length, best: rl.results.filter((r) => r.blogRank).sort((a, b) => a.blogRank - b.blogRank).slice(0, 3).map((r) => ({ keyword: r.keyword, rank: r.blogRank })) } : null;
      // 점검(색인)
      const ih = await readJson(paths.state("index-history"), {});
      const nowMs = Date.now();
      const idxProblems = Object.values(ih).filter((r) => !r.indexedAt && nowMs - r.addDate > 24 * 3600000 && nowMs - r.addDate < 14 * 86400000).map((r) => ({ title: r.title, hours: Math.round((nowMs - r.addDate) / 3600000) }));
      const idxWaiting = Object.values(ih).filter((r) => !r.indexedAt && nowMs - r.addDate <= 24 * 3600000).length;
      // 시즌
      const season = await readJson(paths.state("season-calendar"), null);
      const seasonNow = season?.now ? { month: season.now.month, writeNow: season.now.writeNow || [], stillOk: season.now.stillOk || [] } : null;
      // 오늘 할 일 (데이터에서 도출)
      const todo = [];
      if (dupes.length) todo.push({ tab: "drafts", text: `큐에 이미 발행된 원고 ${dupes.length}편 → [발행 완료 처리]로 보관`, level: "warn" });
      if (incoming) todo.push({ tab: "neighbors", text: `받은 서로이웃 신청 ${incoming}건 → 수락 + 환영 댓글`, level: "do" });
      if (idxProblems.length) todo.push({ tab: "drafts", text: `색인 안 된 글 ${idxProblems.length}편 (${idxProblems[0].title.slice(0, 18)}…) 확인`, level: "warn" });
      const tomorrow = new Date(Date.now() + 9 * 3600000 + 86400000).toISOString().slice(0, 10);
      if (perDay && queue.length) {
        const todayLeft = Math.max(0, perDay - (sched.occ[todayKst] || 0));
        const tomorrowLeft = Math.max(0, perDay - (sched.occ[tomorrow] || 0));
        const todayLater = times.filter((t) => t > new Date(Date.now() + 9 * 3600000 + 20 * 60000).toISOString().slice(11, 16)).length; // 오늘 아직 잡을 수 있는 시각 수
        const todayNeed = Math.min(todayLeft, todayLater);
        if (todayNeed) todo.push({ tab: "drafts", text: `오늘 발행 ${sched.occ[todayKst] || 0}/${perDay} → 원고 ${todayNeed}편 자동 입력 (다음 슬롯 ${next?.kst?.slice(5) || "-"})`, level: "do" });
        else if (tomorrowLeft) todo.push({ tab: "drafts", text: `내일(${tomorrow.slice(5)}) 예약 ${sched.occ[tomorrow] || 0}/${perDay} → 원고 ${tomorrowLeft}편 자동 입력`, level: "do" });
      }
      if (publishing.immediate.length) todo.push({ tab: "drafts", text: `예약 대신 바로 발행한 글 ${publishing.immediate.length}편(${publishing.immediate[0].title.slice(0, 14)}…) → 예약 목록에서 뺐고 그날 발행 수에 넣었습니다`, level: "info" });
      if (publishing.stale.length) todo.push({ tab: "drafts", text: `예약 시각이 지났는데 안 올라온 글 ${publishing.stale.length}편(${publishing.stale[0].title.slice(0, 14)}…) → 발행 버튼이 안 눌렸는지 확인`, level: "warn" });
      if (!queue.length) todo.push({ tab: "drafts", text: "큐가 비어 있음 → [새 원고 생성]", level: "do" });
      if (commentsToday < 10) todo.push({ tab: "comments", text: `이웃 글 댓글 ${commentsToday}/10 → 댓글 탭에서 ${10 - commentsToday}개 더`, level: "do" });
      if (seasonNow?.writeNow?.length) {
        const written = new Set([...queue.map((q) => q.title), ...(existsSync(publishedDirOf(blog)) ? await readdir(publishedDirOf(blog)) : [])].join(" ").replace(/\s+/g, ""));
        const pick = seasonNow.writeNow.filter((t) => !written.has(t.replace(/\s+/g, "")) && ![...queue.map((q) => q.title)].some((ti) => ti.includes(t.split(" ")[0]))).slice(0, 3);
        if (pick.length) todo.push({ tab: "drafts", text: `지금 쓸 시즌 주제: ${pick.join(", ")} (다음 달 검색 피크)`, level: "idea" });
      }
      return json(res, 200, { todayKst, queue: { count: queue.length, items: queue, nextSlot: next?.kst || null, scheduledDays, dupes }, publishing, incoming, commentsToday, buddyToday, buddyCap: (await loadConfig()).buddyDailyCap ?? DAILY_CAP, stats, rank, index: { problems: idxProblems, waiting: idxWaiting }, season: seasonNow, todo });
    }
    // ── 받은 서로이웃 신청 수락 + 환영 댓글 ──
    if (req.method === "GET" && url.pathname === "/api/neighbors/incoming") {
      const blog = await activeBlog();
      return json(res, 200, { incoming: await listIncoming(blog.profile, blog.blogId) });
    }
    if (req.method === "POST" && url.pathname === "/api/neighbors/accept") {
      const blog = await activeBlog();
      const { welcome = true, max = 10 } = await readBody(req).catch(() => ({}));
      return json(res, 200, await acceptIncoming(blog.profile, blog.key, blog.blogId, { welcome: welcome !== false, max: Number(max) || 10, onLog: (m) => console.log("[accept]", m) }));
    }
    // ── 블로그 통계 수집 (유입 검색어·조회수·글별·경로·이웃) ──
    if (req.method === "POST" && url.pathname === "/api/stats/collect") {
      const blog = await activeBlog();
      const { days } = await readBody(req).catch(() => ({}));
      return json(res, 200, await collectStats(blog.profile, { days: Number(days) || 7 }));
    }
    if (req.method === "GET" && url.pathname === "/api/stats/report") {
      return json(res, 200, { report: await buildStatsReport() });
    }
    // ── 이웃 새 글 댓글 (체인 지표: 읽기·댓글·재방문) ──
    if (req.method === "GET" && url.pathname === "/api/comments/feed") {
      const blog = await activeBlog();
      return json(res, 200, await listCommentCandidates(blog.profile, blog.key));
    }
    if (req.method === "POST" && url.pathname === "/api/comments/suggest") {
      const blog = await activeBlog();
      const { title, brief } = await readBody(req);
      return json(res, 200, await suggestComment({ title, brief, blogKey: blog.key }));
    }
    if (req.method === "POST" && url.pathname === "/api/comments/post") {
      const blog = await activeBlog();
      const b = await readBody(req);
      if (!b.text || String(b.text).trim().length < 10) return json(res, 400, { ok: false, message: "댓글 내용이 너무 짧습니다" });
      return json(res, 200, await postComment(blog.profile, blog.key, { ...b, text: String(b.text).trim() }));
    }
    if (req.method === "POST" && url.pathname === "/api/comments/skip") {
      const blog = await activeBlog();
      const { blogId, logNo } = await readBody(req);
      await skipComment(blog.key, blogId, logNo);
      return json(res, 200, { ok: true });
    }
    // ── 이웃 관리 (발굴 자동, 신청 클릭은 사람) ──
    if (req.method === "GET" && url.pathname === "/api/neighbors") {
      await activeBlog();
      const cache = await loadCandidates();
      const config = await loadConfig();
      return json(res, 200, { ...cache, todayCount: await todayRequestedCount(), cap: config.buddyDailyCap ?? DAILY_CAP });
    }
    if (req.method === "POST" && url.pathname === "/api/neighbors/refresh") {
      const config = await loadConfig();
      const blog = await activeBlog();
      const cfgR = await loadConfig();
      const cache = await discoverCandidates(blog.blogId, Math.max(30, cfgR.buddyDailyCap ?? 30)); // 하루 상한만큼은 한 번에 확보
      return json(res, 200, { ...cache, todayCount: await todayRequestedCount(), cap: config.buddyDailyCap ?? DAILY_CAP });
    }
    if (req.method === "POST" && url.pathname === "/api/neighbors/open") {
      const { blogId, message } = await readBody(req);
      const blog = await activeBlog();
      return json(res, 200, await openBlog(String(blogId), String(message ?? ""), blog.profile));
    }
    if (req.method === "POST" && url.pathname === "/api/neighbors/requested") {
      const { blogId, name } = await readBody(req);
      await activeBlog();
      const config = await loadConfig();
      return json(res, 200, await markRequested(String(blogId), name, config.buddyDailyCap ?? DAILY_CAP));
    }
    if (req.method === "POST" && url.pathname === "/api/neighbors/skip") {
      const { blogId } = await readBody(req);
      await activeBlog();
      return json(res, 200, await markSkipped(String(blogId)));
    }
    // ── 완전 자동 신청 (사용자 명시 선택) — 무작위 간격, 제한 감지 시 즉시 중단 ──
    if (req.method === "POST" && url.pathname === "/api/neighbors/auto/start") {
      if (autoJob.running) return json(res, 409, { ok: false, message: "이미 자동 신청이 실행 중입니다." });
      const { count } = await readBody(req);
      const blog = await activeBlog();
      const config = await loadConfig();
      const cap = config.buddyDailyCap ?? 30;
      const already = await todayRequestedCount();
      const need = Math.max(0, Math.min(Number(count) || 10, cap - already));
      let { candidates } = await loadCandidates();
      // 후보가 요청 수보다 적으면 자동으로 더 찾아 채운다 (상한까지 신청하려는데 후보가 모자라는 문제)
      if (candidates.length < need) candidates = (await discoverCandidates(blog.blogId, Math.max(30, need * 2))).candidates;
      const todo = candidates.slice(0, need);
      if (!todo.length) {
        return json(res, 400, { ok: false, message: already >= cap ? `오늘 상한(${cap}건)에 이미 도달했습니다.` : "후보가 없습니다. [후보 새로 찾기]를 먼저 실행하세요." });
      }
      autoJob.running = true;
      autoJob.stopRequested = false;
      autoJob.results = [];
      autoJob.total = todo.length;
      (async () => {
        for (const c of todo) {
          if (autoJob.stopRequested) break;
          const r = await autoBuddyRequest(c.blogId, c.message, blog.profile);
          autoJob.results.push({ blogId: c.blogId, name: c.blogName || c.nickName, ...r });
          if (r.ok) await markRequested(c.blogId, c.blogName || c.nickName, cap);
          else if (r.skip) await markSkipped(c.blogId);
          if (r.fatal) break;
          // 무작위 간격 12~40초 — 기계적으로 일정한 패턴 방지
          await new Promise((resolve) => setTimeout(resolve, 12000 + Math.random() * 28000));
        }
        autoJob.running = false;
      })();
      return json(res, 200, { ok: true, message: `자동 신청 시작: ${todo.length}건 (간격 12~40초, 제한 감지 시 즉시 중단)` });
    }
    if (req.method === "GET" && url.pathname === "/api/neighbors/auto/status") {
      await activeBlog();
      return json(res, 200, { ...autoJob, todayCount: await todayRequestedCount() });
    }
    if (req.method === "POST" && url.pathname === "/api/neighbors/auto/stop") {
      autoJob.stopRequested = true;
      return json(res, 200, { ok: true, message: "다음 건부터 중단합니다." });
    }
    json(res, 404, { ok: false, message: "not found" });
  } catch (error) {
    json(res, 500, { ok: false, message: String(error?.message ?? error) });
  }
});

server.listen(PORT, () => {
  console.log(`[blog-autopublisher] http://localhost:${PORT} — 데이터 폴더: ${DATA_DIR}`);
});

// 정상 종료: 크롬을 먼저 닫아 로그인 세션을 보존한다 (kill -9 금지)
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await closeBrowser();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
