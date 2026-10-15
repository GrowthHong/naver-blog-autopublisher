// 색인 누락 감지 — 블로그 글 목록을 받아 최근 14일 글이 네이버 블로그탭에 검색되는지 확인한다.
// 24시간 지나도 안 잡히면 '누락 의심', 72시간이면 '누락'으로 표시하고 macOS 알림을 띄운다.
// 덤으로 발행기 큐에 남은 원고가 이미 블로그에 올라가 있으면(중복 발행 위험) 알려준다.
// 사용: node scripts/index-check.mjs   기록: <데이터폴더>/state/index-history.json  보고서: <데이터폴더>/reports/index-report.md
import { chromium } from "playwright-core";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";

const HOME = os.homedir();
const DATA_DIR = process.env.BAP_HOME || `${HOME}/.blog-autopublisher`;
const _cfg = JSON.parse(await readFile(`${DATA_DIR}/config.json`, "utf8").catch(() => "{}"));
const _blogs = JSON.parse(await readFile(`${DATA_DIR}/blogs.json`, "utf8").catch(() => "{}"));
const _key = _cfg.active && _blogs[_cfg.active] ? _cfg.active : Object.keys(_blogs)[0];
if (!_key) { console.error("설정된 블로그가 없습니다. 발행기 설정 탭에서 먼저 저장하세요."); process.exit(1); }
const BLOG_ID = _blogs[_key].blogId;
const REPORTS = `${DATA_DIR}/reports`; const STATE = `${DATA_DIR}/state`;
const QUEUE_DIR = `${DATA_DIR}/blogs/${_key}/drafts`;
const HISTORY = `${STATE}/index-history.json`;
const REPORT = `${REPORTS}/index-report.md`;
const WINDOW_DAYS = 14;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 3600000;

async function postList() {
  const items = [];
  for (let page = 1; page <= 5; page += 1) {
    const r = await fetch(`https://m.blog.naver.com/api/blogs/${BLOG_ID}/post-list?categoryNo=0&itemCount=30&page=${page}`, { headers: { "User-Agent": UA, Referer: `https://m.blog.naver.com/${BLOG_ID}` } });
    const j = await r.json();
    const got = j?.result?.items || [];
    items.push(...got);
    if (got.length < 30) break;
  }
  return items.map((it) => ({ logNo: String(it.logNo), title: it.titleWithInspectMessage, addDate: it.addDate, readCount: it.readCount, searchYn: it.searchYn, url: `https://blog.naver.com/${BLOG_ID}/${it.logNo}` }));
}

async function isIndexed(page, post) {
  // 제목을 따옴표로 감싸 정확 일치 검색 — 흔한 제목은 따옴표 없이 검색하면 상위 30개에 안 보여 누락으로 오판한다
  await page.goto(`https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query=${encodeURIComponent(`"${post.title}"`)}`, { waitUntil: "networkidle", timeout: 40000 }).catch(() => {});
  await sleep(700 + Math.random() * 500);
  const body = await page.locator("body").innerText().catch(() => "");
  if (/보안문자|자동 입력 방지|비정상적인 요청/.test(body)) return { captcha: true };
  const hit = await page.evaluate(({ blogId, logNo }) => {
    const links = [...document.querySelectorAll("a[href]")].map((a) => a.href);
    const idxExact = links.findIndex((h) => h.includes(`blog.naver.com/${blogId}/${logNo}`));
    const anyOurs = links.some((h) => new RegExp(`blog\\.naver\\.com/${blogId}/\\d+`).test(h));
    return { exact: idxExact >= 0, anyOurs };
  }, { blogId: BLOG_ID, logNo: post.logNo });
  return { indexed: hit.exact, anyOurs: hit.anyOurs };
}

function statusOf(rec, now) {
  if (rec.indexedAt) return "색인됨";
  const age = now - rec.addDate;
  if (age < 24 * H) return "대기(24시간 미만)";
  if (age < 72 * H) return "누락 의심";
  return "누락";
}

let history = {};
try { history = JSON.parse(await readFile(HISTORY, "utf8")); } catch { /* 첫 실행 */ }
const now = Date.now();
const posts = await postList();
const recent = posts.filter((p) => now - p.addDate < WINDOW_DAYS * 86400000);
const toCheck = recent.filter((p) => !history[p.logNo]?.indexedAt);
let captcha = false;
if (toCheck.length) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ locale: "ko-KR", userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  for (const p of toCheck) {
    const r = await isIndexed(page, p);
    if (r.captcha) { captcha = true; break; }
    const rec = history[p.logNo] || { title: p.title, addDate: p.addDate, url: p.url, checks: [] };
    rec.title = p.title; rec.searchYn = p.searchYn;
    rec.checks.push({ at: new Date().toISOString(), indexed: r.indexed });
    if (r.indexed && !rec.indexedAt) rec.indexedAt = new Date().toISOString();
    history[p.logNo] = rec;
    console.error(`${r.indexed ? "✅ 색인" : "— 미색인"} (${Math.round((now - p.addDate) / H)}시간) ${p.title}`);
    await sleep(1200 + Math.random() * 800);
  }
  await browser.close();
}
for (const p of recent) if (!history[p.logNo]) history[p.logNo] = { title: p.title, addDate: p.addDate, url: p.url, checks: [] };
await writeFile(HISTORY, JSON.stringify(history, null, 1));

// 큐에 남은 원고 중 이미 블로그에 올라간 제목 (중복 발행 위험)
const queueFiles = (await readdir(QUEUE_DIR)).filter((f) => /^post-.*\.md$/.test(f)).sort();
const blogTitles = new Set(posts.map((p) => p.title.replace(/\s+/g, "")));
const dupes = [];
for (const f of queueFiles) {
  const title = (await readFile(`${QUEUE_DIR}/${f}`, "utf8")).split("\n")[0].replace(/^제목:\s*/, "").trim();
  if (blogTitles.has(title.replace(/\s+/g, ""))) dupes.push({ file: f, title });
}

// 보고서
const rows = recent.map((p) => {
  const rec = history[p.logNo]; const st = statusOf(rec, now);
  const hours = Math.round((now - p.addDate) / H);
  const firstIdx = rec.indexedAt ? `${Math.max(0, Math.round((new Date(rec.indexedAt) - p.addDate) / H))}시간 안` : "—";
  return { ...p, st, hours, firstIdx };
});
const problems = rows.filter((r) => /누락/.test(r.st));
const kst = (t) => new Date(t).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);
const md = `# 색인 확인 — ${kst(Date.now())}

- 최근 ${WINDOW_DAYS}일 글 ${recent.length}편 · 색인됨 ${rows.filter((r) => r.st === "색인됨").length} · 대기 ${rows.filter((r) => r.st.startsWith("대기")).length} · 누락 의심 ${rows.filter((r) => r.st === "누락 의심").length} · 누락 ${rows.filter((r) => r.st === "누락").length}${captcha ? " · ⚠ 네이버 보안문자로 중단됨" : ""}
- 확인 방법: 글 제목을 따옴표로 감싸 네이버 블로그탭에서 정확 일치 검색 → 우리 글 URL이 결과에 있으면 색인. 하루 4번(09·13·18·22시) 자동 확인. "색인까지"는 발행 후 처음 확인된 시각 기준이라 실제보다 늦게 잡힐 수 있다.
${dupes.length ? `\n## ⚠ 큐에 남아 있는데 이미 블로그에 올라간 원고 (다시 발행하면 중복)\n${dupes.map((d) => `- ${d.file} — "${d.title}" → 발행기에서 [발행 완료 처리]로 보관하세요`).join("\n")}\n` : ""}
## 글별
| 발행 | 글 | 경과 | 상태 | 색인까지 |
|---|---|---|---|---|
${rows.map((r) => `| ${kst(r.addDate).slice(5)} | ${r.title.slice(0, 38)} | ${r.hours}h | ${r.st} | ${r.firstIdx} |`).join("\n")}
`;
await writeFile(REPORT, md);
console.log(md);

// macOS 알림: 누락(의심) 또는 중복 위험이 있으면
const msgs = [];
if (problems.length) msgs.push(`색인 ${problems[0].st}: ${problems[0].title.slice(0, 30)}${problems.length > 1 ? ` 외 ${problems.length - 1}편` : ""}`);
if (dupes.length) msgs.push(`큐에 이미 발행된 원고 ${dupes.length}편 (중복 발행 주의)`);
if (msgs.length && process.platform === "darwin") execFile("osascript", ["-e", `display notification ${JSON.stringify(msgs.join(" / "))} with title "블로그 자동발행기" subtitle "색인 확인"`]);
else if (msgs.length && process.platform === "win32") execFile("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show("${msgs.join(" / ").replace(/["`$]/g, "")}", "블로그 자동발행기 - 색인 확인") | Out-Null`], () => {});
