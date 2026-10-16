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
  // 2) 통합검색 1페이지 — 블록 순서, 우리 글이 보이는 블록, AI 브리핑 유무·인용 출처
  //    통합검색은 #main_pack 바로 아래 자식 하나가 한 블록. AI 브리핑은 data-block-id="ai-briefing/..." 또는 h2 "AI 브리핑".
  //    spw_fsolid 블록(스마트블록·인기글 묶음)은 자체 제목이 없어 담긴 링크 종류로 이름 붙인다.
  await page.goto(`https://search.naver.com/search.naver?where=nexearch&sm=top_hty&query=${encodeURIComponent(keyword)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1500 + Math.random() * 500);
  for (let k = 0; k < 4; k += 1) { await page.mouse.wheel(0, 900).catch(() => {}); await sleep(250); } // 아래쪽 블록(스마트블록·인기글)은 스크롤해야 렌더링된다
  await sleep(1500);
  const main = await page.evaluate(({ blogIds, siteHost }) => {
    const txt = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
    const root = document.querySelector("#main_pack") || document.body;
    const isOurs = (h) => blogIds.some((b) => h.includes(`blog.naver.com/${b}/`) || h.includes(`blog.naver.com/${b}?`) || h.endsWith(`blog.naver.com/${b}`)) || h.includes(siteHost);
    const blocks = []; let ai = { present: false, order: null, cited: [], ourCited: false };
    let order = 0;
    for (const b of root.children) {
      const links = [...b.querySelectorAll("a[href]")].map((x) => x.href);
      const real = links.filter((h) => !/search\.naver\.com|help\.naver\.com|keep\.naver\.com|^javascript:/.test(h));
      if (!real.length && !/AI 브리핑/.test(txt(b).slice(0, 20))) continue;
      if (/ban_whale|api_sc_page_wrap|_search_option/.test(b.className || "")) continue; // 웨일 배너·페이지 번호·검색옵션은 블록이 아님
      order += 1;
      const h2 = txt(b.querySelector("h2")).slice(0, 24);
      const cnt = (re) => real.filter((h) => re.test(h)).length;
      const nBlog = cnt(/blog\.naver\.com\//), nCafe = cnt(/cafe\.naver\.com\//), nIn = cnt(/in\.naver\.com\//), nKin = cnt(/kin\.naver\.com\//), nGov = cnt(/\.go\.kr|\.or\.kr/);
      const isAi = !!b.querySelector('[data-block-id^="ai-briefing"]') || h2 === "AI 브리핑";
      let label;
      if (isAi) label = "AI 브리핑";
      else if (/관련 광고|파워링크/.test(txt(b.querySelector("h2, .title_area")) || "")) label = "광고";
      else if (h2) label = h2;
      else if (nBlog >= 5 && nCafe >= 5) label = "블로그·카페 묶음";
      else if (nBlog >= 5) label = "블로그 묶음";
      else if (nCafe >= 5) label = "카페 묶음";
      else if (nIn >= 3) label = "인플루언서 묶음";
      else if (nKin >= 3) label = "지식iN";
      else if (nGov >= 2) label = "공공·웹문서";
      else label = "기타 블록";
      const ours = real.some(isOurs);
      blocks.push({ order, label, ours, nBlog: isAi ? 0 : nBlog, nCafe, nIn, nKin }); // AI 브리핑 안의 블로그 인용은 블로그 블록으로 세지 않는다
      if (isAi && !ai.present) {
        const seen = new Set(); const cited = [];
        for (const h of real) { const k = h.replace(/[?#].*$/, ""); if (seen.has(k)) continue; seen.add(k); cited.push(k); }
        ai = { present: true, order, cited: cited.slice(0, 20), ourCited: real.some(isOurs) };
      }
    }
    const site = [...root.querySelectorAll("a[href]")].some((a) => a.href.includes(siteHost));
    return { blocks, ai, site };
  }, { blogIds: OUR_BLOGS, siteHost: SITE_HOST });
  const first = main.blocks.find((b) => b.ours);
  out.mainTop = first ? first.order : null;
  out.mainSection = first ? first.label : null;
  out.siteOnMain = main.site;
  out.sections = main.blocks.map((b) => b.label);
  const firstBlog = main.blocks.find((b) => b.nBlog >= 3);
  out.blogBlockOrder = firstBlog ? firstBlog.order : null;
  out.blogBlockLabel = firstBlog ? firstBlog.label : null;
  out.aiBrief = main.ai.present;
  out.aiOrder = main.ai.order;
  out.aiCited = main.ai.ourCited;
  const hostOf = (u) => { try { return new URL(u).host.replace(/^(www|m)\./, ""); } catch { return ""; } };
  const kinds = {};
  for (const u of main.ai.cited) { const h = hostOf(u); const k = /blog\.naver\.com/.test(h) ? "블로그" : /kin\.naver\.com/.test(h) ? "지식iN" : /youtube\.com|youtu\.be/.test(h) ? "유튜브" : /cafe\.naver\.com/.test(h) ? "카페" : /in\.naver\.com/.test(h) ? "인플루언서" : /\.go\.kr|\.or\.kr|law\.go\.kr|easylaw/.test(h) ? "공공" : /naver\.com/.test(h) ? "네이버 기타" : "웹"; kinds[k] = (kinds[k] || 0) + 1; }
  out.aiSources = kinds;
  out.aiBlogCited = main.ai.cited.filter((u) => /blog\.naver\.com\//.test(u)).slice(0, 5);
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
  console.error(`${r.captcha ? "⚠ 보안문자" : r.blogRank ? `블로그탭 ${r.blogRank}위` : "60위 밖"}${r.mainTop ? ` · 통합 1p(${r.mainSection})` : ""}${r.siteOnMain ? " · 사이트 1p" : ""}${r.aiBrief ? ` · AI브리핑${r.aiCited ? "(우리 글 인용!)" : ""}` : ""}${r.blogBlockOrder ? ` · 블로그 블록 ${r.blogBlockOrder}번째` : " · 1p에 블로그 블록 없음"} — ${t.keyword}`);
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
const aiRows = results.filter((r) => r.aiBrief);
const aiCitedN = aiRows.filter((r) => r.aiCited).length;
const noBlogBlock = results.filter((r) => !r.captcha && r.sections && !r.blogBlockOrder).length;
const aiTable = aiRows.length ? aiRows.map((r) => `| ${r.keyword} | ${r.aiOrder}번째 | ${r.aiCited ? "**인용**" : "—"} | ${Object.entries(r.aiSources || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "—"} |`).join("\n") : "| (없음) | | | |";
const sectionRows = results.filter((r) => r.sections).map((r) => `| ${r.keyword} | ${r.blogBlockOrder ? `${r.blogBlockOrder}번째 (${r.blogBlockLabel})` : "없음"} | ${(r.sections || []).slice(0, 7).join(" → ")}${(r.sections || []).length > 7 ? " → …" : ""} |`).join("\n");
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
const rows = results.map((r) => `| ${r.file.replace(/^post-\d+-/, "")} | ${r.keyword} | ${fmt(r.volume)} | ${fmt(r.blogRank)}${arrow(r.blogRank, prevRank(r.file))} | ${r.foundBlog ? (r.foundBlog === BLOG_ID ? "새" : "구") : "—"} | ${r.mainTop ? r.mainSection : "—"} | ${r.aiBrief ? (r.aiCited ? "인용" : "뜸") : "—"} | ${r.siteOnMain ? "O" : "—"} | ${r.publishedAt} |`).join("\n");
const report = `# 네이버 순위 측정 — ${date}${prev ? ` (이전 ${prev.date} 대비)` : ""}

- 측정 ${results.length}편 · 블로그탭 60위 안 ${inTop60}편 · 10위 안 ${inTop10}편 · 통합검색 1페이지 노출 ${onMain}편\n- **AI 브리핑**이 뜨는 키워드 ${aiRows.length}편, 그중 우리 글 인용 ${aiCitedN}편 · 통합검색 1페이지에 블로그 블록 자체가 없는 키워드 ${noBlogBlock}편(블로그탭 순위가 좋아도 통합검색에선 안 보임)
- 블로그탭 = 네이버 통합검색의 "블로그" 탭 60위까지 확인. 통합 = 통합검색 1페이지에 우리 글이 보이는 섹션 이름. 사이트 = hyetaek.co.kr 글이 1페이지에 보이는지.
- 측정 키워드는 state/rank-keywords.json 에서 바꿀 수 있다(없으면 제목 앞부분을 쓴다). 매주 월요일 07:30 자동 측정.

## 검색량 구간별 — 새 블로그 글만 (10월 이후 발행) 기준으로 어느 구간에서 오르는지
| 월 검색량 | 글 수 | 60위 안 | 10위 안 | 평균 순위 |
|---|---|---|---|---|
${bandRows}

## 글별
| 글 | 키워드 | 월 검색량 | 블로그탭 순위 | 블로그 | 통합 1p | AI 브리핑 | 사이트 1p | 발행일 |
|---|---|---|---|---|---|---|---|---|
${rows}

## AI 브리핑 — 뜨는 키워드와 인용 출처 구성 (여기 인용되면 블로그탭 순위와 별개로 노출)
| 키워드 | 위치 | 우리 글 | 인용 출처 |
|---|---|---|---|
${aiTable}

## 통합검색 1페이지 블록 순서 — 블로그 블록이 몇 번째에 있나
| 키워드 | 블로그 블록 | 블록 순서(앞 7개) |
|---|---|---|
${sectionRows}
`;
await writeFile(REPORT, report);
console.log(report);
