// 발행한 블로그 글이 네이버에서 몇 위인지 측정 — 블로그탭 순위(50위까지) + 통합검색 1페이지 노출 여부
// 사용: node scripts/rank-check.mjs (전체) | node scripts/rank-check.mjs "키워드" (하나만)
// 기록: <데이터폴더>/state/rank-history.json  보고서: <데이터폴더>/reports/rank-report.md
import { chromium } from "playwright-core";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const DATA_DIR = process.env.BAP_HOME || `${HOME}/.blog-autopublisher`;
const _cfg = JSON.parse(await readFile(`${DATA_DIR}/config.json`, "utf8").catch(() => "{}"));
const _blogs = JSON.parse(await readFile(`${DATA_DIR}/blogs.json`, "utf8").catch(() => "{}"));
const _key = _cfg.active && _blogs[_cfg.active] ? _cfg.active : Object.keys(_blogs)[0];
if (!_key) { console.error("설정된 블로그가 없습니다. 발행기 설정 탭에서 먼저 저장하세요."); process.exit(1); }
const BLOG_ID = _blogs[_key].blogId;
const REPORTS = `${DATA_DIR}/reports`; const STATE = `${DATA_DIR}/state`;
const NEW_BLOG_SINCE = "2000-01-01";
const OUR_BLOGS = [BLOG_ID];
const SITE_HOST = _blogs[_key].siteUrl ? new URL(_blogs[_key].siteUrl).host : "__none__";
const PUBLISHED = `${DATA_DIR}/blogs/${_key}/drafts/published`;
const KEYWORDS_FILE = `${STATE}/rank-keywords.json`;
const HISTORY = `${STATE}/rank-history.json`;
const REPORT = `${REPORTS}/rank-report.md`;
const RANK_WINDOW = 60; // 블로그탭 60위까지 확인
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadTargets(only) {
  if (only) return [{ file: "(수동)", keyword: only }];
  const map = JSON.parse(await readFile(KEYWORDS_FILE, "utf8"));
  const files = (await readdir(PUBLISHED)).filter((f) => f.endsWith(".md")).sort();
  const targets = [];
  for (const f of files) {
    const slug = f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
    const title = (await readFile(path.join(PUBLISHED, f), "utf8")).split("\n")[0].replace(/^제목:\s*/, "");
    const keyword = map[slug] || title.split(/[,，]/)[0].trim();
    targets.push({ file: slug, title, keyword, publishedAt: f.slice(0, 10), fromMap: !!map[slug] });
  }
  return targets;
}

// 검색량(네이버 검색광고 API) — keyword-check.mjs 재사용
async function volumes(keywords) {
  try {
    const { stdout } = await promisify(execFile)("node", [new URL("./keyword-check.mjs", import.meta.url).pathname, ...keywords], { maxBuffer: 4e6 });
    const d = JSON.parse(stdout);
    return Object.fromEntries(d.rows.map((r) => [r.keyword, r.volume]));
  } catch { return {}; }
}

async function measure(page, keyword) {
  const out = { keyword, blogRank: null, blogPostUrl: null, mainTop: null, mainSection: null, siteOnMain: false, captcha: false };
  // 1) 블로그탭 순위 — 블로그탭은 페이지 번호가 아니라 스크롤로 다음 결과를 불러온다. 50건 모일 때까지 스크롤.
  // ssc=tab.blog.all 이 실제 "블로그" 탭(한 번에 30건, 스크롤마다 30건 추가). where=blog 는 다른 정렬의 묶음 화면이라 쓰지 않는다.
  await page.goto(`https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_jum&query=${encodeURIComponent(keyword)}`, { waitUntil: "networkidle", timeout: 40000 }).catch(() => {});
  await sleep(800 + Math.random() * 500);
  const body0 = await page.locator("body").innerText().catch(() => "");
  if (/보안문자|자동 입력 방지|비정상적인 요청/.test(body0)) { out.captcha = true; return out; }
  const collect = () => page.evaluate(() => {
    // 결과 글 링크를 화면 순서대로 (한 항목에 썸네일·제목·본문 링크가 같은 URL로 여러 번 있어 URL로 중복 제거)
    const seen = new Set(); const res = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const m = a.href.match(/^https?:\/\/(?:m\.)?blog\.naver\.com\/([\w.-]+)\/(\d+)/);
      if (!m) continue;
      const key = `${m[1]}/${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key); res.push({ key, href: a.href, blogId: m[1] });
    }
    return res;
  });
  let links = await collect();
  let stale = 0;
  for (let i = 0; i < 6 && links.length < RANK_WINDOW && stale < 2; i += 1) {
    // 추가 로딩은 실제 스크롤 이벤트로만 걸린다 — 한 번에 크게 내리지 말고 단계적으로
    for (let k = 0; k < 6; k += 1) { await page.mouse.wheel(0, 800).catch(() => {}); await sleep(150); }
    await sleep(1200 + Math.random() * 500);
    const next = await collect();
    stale = next.length > links.length ? 0 : stale + 1;
    links = next;
  }
  if (process.env.RANK_DEBUG) console.error(`  수집 ${links.length}건: ${links.slice(0, 3).map((l) => l.key).join(", ")}`);
  const idx = links.findIndex((l) => OUR_BLOGS.includes(l.blogId));
  if (idx >= 0) { out.blogRank = idx + 1; out.blogPostUrl = links[idx].href; out.foundBlog = links[idx].blogId; }
  out.blogChecked = links.length;
  // 2) 통합검색 1페이지 — 우리 블로그/사이트가 어느 섹션에 보이는지
  await page.goto(`https://search.naver.com/search.naver?where=nexearch&sm=top_hty&query=${encodeURIComponent(keyword)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(900 + Math.random() * 700);
  const main = await page.evaluate(({ blogIds, siteHost }) => {
    const sections = [...document.querySelectorAll("section, div.api_subject_bx, div.sc_new")];
    let found = null; let site = false;
    sections.forEach((sec, i) => {
      const head = (sec.querySelector("h2, h3, [class*=headline], .api_title, .mod_title_area .title, .title_area strong, .title_area a")?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20);
      const as = [...sec.querySelectorAll("a[href]")];
      if (as.some((a) => a.href.includes(siteHost))) site = true;
      if (!found && as.some((a) => blogIds.some((b) => a.href.includes(`blog.naver.com/${b}`)))) found = { section: head || `섹션${i + 1}`, order: i + 1 };
    });
    return { found, site };
  }, { blogIds: OUR_BLOGS, siteHost: SITE_HOST });
  out.mainTop = main.found ? main.found.order : null;
  out.mainSection = main.found ? main.found.section : null;
  out.siteOnMain = main.site;
  return out;
}

const reportOnly = process.argv.includes("--report");
const only = reportOnly ? undefined : process.argv[2];
const targets = reportOnly ? [] : await loadTargets(only);
const vol = only || reportOnly ? {} : await volumes(targets.map((t) => t.keyword));
const browser = reportOnly ? null : await chromium.launch({ channel: "chrome", headless: true });
const ctx = reportOnly ? null : await browser.newContext({ locale: "ko-KR", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36", viewport: { width: 1280, height: 900 } });
const page = reportOnly ? null : await ctx.newPage();
let results = [];
for (const t of targets) {
  const r = await measure(page, t.keyword);
  results.push({ ...t, ...r, volume: vol[t.keyword] ?? null });
  console.error(`${r.captcha ? "⚠ 보안문자" : r.blogRank ? `블로그탭 ${r.blogRank}위` : "60위 밖"}${r.mainTop ? ` · 통합 1p(${r.mainSection})` : ""}${r.siteOnMain ? " · 사이트 1p" : ""} — ${t.keyword}`);
  if (r.captcha) break;
  await sleep(1500 + Math.random() * 1500);
}
if (browser) await browser.close();
if (only) { console.log(JSON.stringify(results, null, 1)); process.exit(0); }

// 기록 + 보고서
let history = [];
try { history = JSON.parse(await readFile(HISTORY, "utf8")); } catch { /* 첫 측정 */ }
let date = new Date().toISOString().slice(0, 10);
if (reportOnly) { const last = history.pop(); if (!last) { console.error("기록 없음"); process.exit(1); } results = last.results; date = last.date; }
history = history.filter((h) => h.date !== date); // 같은 날 다시 돌리면 덮어쓴다
const prev = history.length ? history[history.length - 1] : null;
history.push({ date, results });
await writeFile(HISTORY, JSON.stringify(history, null, 1));

const prevRank = (file) => prev?.results.find((r) => r.file === file)?.blogRank ?? null;
const fmt = (n) => (n == null ? "—" : String(n));
const arrow = (now, before) => { if (!prev) return ""; if (before == null && now == null) return ""; if (before == null) return " (신규)"; if (now == null) return " (↓이탈)"; if (now < before) return ` (↑${before - now})`; if (now > before) return ` (↓${now - before})`; return " (=)"; };
const inTop10 = results.filter((r) => r.blogRank && r.blogRank <= 10).length;
const inTop60 = results.filter((r) => r.blogRank).length;
const onMain = results.filter((r) => r.mainTop).length;
const byBand = { "100미만": [], "100~1,000": [], "1,000~3,000": [], "3,000~10,000": [], "10,000이상": [], "측정불가": [] };
for (const r of results) {
  if (r.publishedAt < NEW_BLOG_SINCE) continue; // 구간 통계는 새 블로그 글만 (구 블로그는 색인 자체가 안 됨)
  const v = r.volume; const band = v == null ? "측정불가" : v < 100 ? "100미만" : v < 1000 ? "100~1,000" : v < 3000 ? "1,000~3,000" : v < 10000 ? "3,000~10,000" : "10,000이상";
  byBand[band].push(r);
}
const bandRows = Object.entries(byBand).filter(([, v]) => v.length).map(([b, v]) => {
  const ranked = v.filter((r) => r.blogRank); const top10 = ranked.filter((r) => r.blogRank <= 10);
  return `| ${b} | ${v.length} | ${ranked.length} | ${top10.length} | ${ranked.length ? Math.round(ranked.reduce((a, r) => a + r.blogRank, 0) / ranked.length) : "—"} |`;
}).join("\n");
const rows = results.map((r) => `| ${r.file.replace(/^post-\d+-/, "")} | ${r.keyword} | ${fmt(r.volume)} | ${fmt(r.blogRank)}${arrow(r.blogRank, prevRank(r.file))} | ${r.foundBlog ? (r.foundBlog === BLOG_ID ? "새" : "구") : "—"} | ${r.mainTop ? r.mainSection : "—"} | ${r.siteOnMain ? "O" : "—"} | ${r.publishedAt} |`).join("\n");
const report = `# 네이버 순위 측정 — ${date}${prev ? ` (이전 ${prev.date} 대비)` : ""}

- 측정 ${results.length}편 · 블로그탭 60위 안 ${inTop60}편 · 10위 안 ${inTop10}편 · 통합검색 1페이지 노출 ${onMain}편
- 블로그탭 = 네이버 통합검색의 "블로그" 탭 60위까지 확인. 통합 = 통합검색 1페이지에 우리 글이 보이는 섹션 이름. 사이트 = hyetaek.co.kr 글이 1페이지에 보이는지.
- 측정 키워드는 state/rank-keywords.json 에서 바꿀 수 있다(없으면 제목 앞부분을 쓴다). 매주 월요일 07:30 자동 측정.

## 검색량 구간별 — 새 블로그 글만 (10월 이후 발행) 기준으로 어느 구간에서 오르는지
| 월 검색량 | 글 수 | 60위 안 | 10위 안 | 평균 순위 |
|---|---|---|---|---|
${bandRows}

## 글별
| 글 | 키워드 | 월 검색량 | 블로그탭 순위 | 블로그 | 통합 1p | 사이트 1p | 발행일 |
|---|---|---|---|---|---|---|---|
${rows}
`;
await writeFile(REPORT, report);
console.log(report);
