// 네이버 블로그 통계 수집 — blog.stat.naver.com 내부 API(로그인 쿠키 공유)로 일별 조회수·방문·유입 검색어·글별 조회·유입 경로·이웃 증감을 모은다.
// 기록: ~/.hyetaek/stats-history.json (날짜별)  보고서: ~/hyetaek/stats-report.md  생성기용 유입 검색어: ~/.hyetaek/inflow-keywords.json
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getBrowser } from "./publisher.mjs";
import { paths } from "../lib/paths.mjs";

const HOME = os.homedir();
const HISTORY = paths.state("stats-history");
const REPORT = path.join(paths.reports, "stats-report.md");
const INFLOW = paths.state("inflow-keywords");
const API = "https://blog.stat.naver.com/api/blog";

export async function loadStatsHistory() {
  try { return JSON.parse(await readFile(HISTORY, "utf8")); } catch { return {}; }
}
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(Date.now() - n * 86400000); return ymd(d); };

// 열 단위(columnar) 응답을 행 배열로
function rowsOf(json, dataId) {
  const sd = (json?.result?.statDataList || []).find((x) => x.dataId === dataId);
  const data = sd?.data; if (!data?.rows || !data.columnInfo) return [];
  const n = Math.max(...data.columnInfo.map((c) => (data.rows[c] || []).length), 0);
  return Array.from({ length: n }, (_, i) => Object.fromEntries(data.columnInfo.map((c) => [c, data.rows[c]?.[i]])));
}

async function fetchStat(browser, ep, date) {
  const r = await browser.request.get(`${API}/${ep}?timeDimension=DATE&additionalTimeDimension=WEEK&startDate=${date}&exclude=`, {
    headers: { referer: "https://blog.stat.naver.com/m/blog/daily/cv", accept: "application/json" }, timeout: 20000,
  });
  if (r.status() !== 200) throw new Error(`${ep} HTTP ${r.status()} — 로그인이 풀렸을 수 있습니다`);
  return r.json();
}

// 최근 days일(오늘 제외 가능)을 다시 받아 기록을 덮어쓴다 — 통계는 하루 이틀 뒤에 확정되므로 겹쳐서 받는 게 맞다
export async function collectStats(profile, { days = 7, includeToday = true } = {}) {
  const browser = await getBrowser(profile);
  const history = await loadStatsHistory();
  const dates = [];
  for (let i = includeToday ? 0 : 1; i < days + (includeToday ? 0 : 1); i += 1) dates.push(daysAgo(i));
  for (const date of dates) {
    const [cvJ, visitJ, searchJ, relJ] = await Promise.all([
      fetchStat(browser, "daily/cv", date), fetchStat(browser, "daily/visit", date),
      fetchStat(browser, "daily/referer/search", date), fetchStat(browser, "user/relationDelta", date),
    ]);
    const pick = (rows) => rows.filter((r) => r.date === date);
    const cv = pick(rowsOf(cvJ, "cv"))[0]?.cv ?? 0;
    const visit = pick(rowsOf(visitJ, "visit"))[0]?.visit ?? 0;
    const rel = pick(rowsOf(relJ, "relationDelta"))[0] || {};
    history[date] = {
      cv, visit,
      queries: pick(rowsOf(searchJ, "refererSearch")).map((r) => ({ q: r.searchQuery, cv: r.cv })),
      posts: pick(rowsOf(cvJ, "rankCv")).map((r) => ({ uri: r.uri, title: r.title, cv: r.cv, rank: r.rank, createDate: r.createDate })),
      referers: pick(rowsOf(cvJ, "refererTotal")).map((r) => ({ domain: r.referrerDomain, search: r.referrerSearchEngine === "1", cv: r.cv })),
      neighbors: { add: rel.add ?? 0, delete: rel.delete ?? 0, friend: rel.friend ?? 0 },
      collectedAt: new Date().toISOString(),
    };
  }
  await mkdir(path.dirname(HISTORY), { recursive: true });
  await writeFile(HISTORY, JSON.stringify(history, null, 1));
  const report = await buildStatsReport(history);
  return { ok: true, dates, report };
}

function sumBy(list, key) { return list.reduce((a, x) => a + (Number(x[key]) || 0), 0); }
function aggQueries(days) {
  const m = new Map();
  for (const d of days) for (const q of d.queries || []) m.set(q.q, (m.get(q.q) || 0) + q.cv);
  return [...m.entries()].map(([q, cv]) => ({ q, cv })).sort((a, b) => b.cv - a.cv);
}

// 사이트(hyetaek.co.kr) 글 유입 구역 — 홈 시즌·TOP5·관련글·목록·검색·직접 (사이트 API, 합계만)
let SITE_URL = null; // 블로그 설정 siteUrl (혜택수첩처럼 같은 코드의 사이트가 있을 때만)
export function useStatsContext(blog) { SITE_URL = blog?.siteUrl || null; }
async function fetchSiteFromReport(days = 7) {
  if (!SITE_URL) return {};
  try {
    const r = await fetch(`${SITE_URL.replace(/\/$/, "")}/api/article-views?report=from&days=${days}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return j?.days || {};
  } catch { return {}; }
}
const FROM_LABEL = { hero: "홈 히어로", season: "홈 이번 달 챙길 것", top5: "홈 먼저 확인할 혜택", cat: "홈 주제별", list: "목록(전체글·카테고리)", related: "글 끝 관련 콘텐츠", popular: "사이드 많이 보는 글", finder: "혜택 찾기 결과", news: "새 소식", "search-naver": "네이버 검색", "search-google": "구글 검색", "search-other": "기타 검색", blog: "네이버 블로그", internal: "사이트 내 이동", direct: "직접 접속", external: "외부 링크" };

export async function buildStatsReport(history) {
  history = history || (await loadStatsHistory());
  const siteFrom = await fetchSiteFromReport(7);
  const fromTotal = {};
  for (const d of Object.values(siteFrom)) for (const [k, v] of Object.entries(d)) fromTotal[k] = (fromTotal[k] || 0) + Number(v);
  const fromRows = Object.entries(fromTotal).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${FROM_LABEL[k] || k} | ${v} |`).join("\n");
  const dates = Object.keys(history).sort();
  if (!dates.length) return "기록 없음";
  const last7 = dates.slice(-7).map((d) => ({ date: d, ...history[d] }));
  const prev7 = dates.slice(-14, -7).map((d) => ({ date: d, ...history[d] }));
  const tot = (arr, k) => sumBy(arr, k);
  const diff = (a, b) => (b == null || !prev7.length ? "" : a - b >= 0 ? ` (+${a - b})` : ` (${a - b})`);
  const queries = aggQueries(last7);
  const refer = new Map();
  for (const d of last7) for (const r of d.referers || []) refer.set(r.domain, (refer.get(r.domain) || 0) + r.cv);
  const referRows = [...refer.entries()].sort((a, b) => b[1] - a[1]).map(([d, c]) => `| ${d} | ${c} |`).join("\n");
  const postMap = new Map();
  for (const d of last7) for (const p of d.posts || []) { const e = postMap.get(p.uri) || { title: p.title, cv: 0, createDate: p.createDate }; e.cv += p.cv; postMap.set(p.uri, e); }
  const postRows = [...postMap.entries()].sort((a, b) => b[1].cv - a[1].cv).slice(0, 15).map(([u, p]) => `| ${p.title.slice(0, 40)} | ${p.cv} | ${p.createDate?.slice(0, 11) || ""} |`).join("\n");
  const searchCv = last7.reduce((a, d) => a + (d.referers || []).filter((r) => r.search).reduce((s, r) => s + r.cv, 0), 0);
  const homeCv = last7.reduce((a, d) => a + (d.referers || []).filter((r) => /메인/.test(r.domain)).reduce((s, r) => s + r.cv, 0), 0);
  const dayRows = last7.map((d) => `| ${d.date} | ${d.cv} | ${d.visit} | ${(d.queries || []).length} | +${d.neighbors?.add ?? 0}/-${d.neighbors?.delete ?? 0} |`).join("\n");
  // 생성기용 유입 검색어 저장 (최근 14일 합산)
  const q14 = aggQueries(dates.slice(-14).map((d) => history[d]));
  await writeFile(INFLOW, JSON.stringify({ updatedAt: new Date().toISOString(), note: "최근 14일 실제 유입 검색어(조회수순). 원고 제목·소제목에 이 표현을 살릴 것", queries: q14.slice(0, 60) }, null, 1));
  const md = `# 블로그 통계 — ${last7[0].date} ~ ${last7.at(-1).date}${prev7.length ? " (전주 대비)" : ""}

- 조회수 ${tot(last7, "cv")}${diff(tot(last7, "cv"), tot(prev7, "cv"))} · 방문 ${tot(last7, "visit")}${diff(tot(last7, "visit"), tot(prev7, "visit"))} · 검색 유입 ${searchCv} · 네이버 메인(홈판) 유입 ${homeCv} · 유입 검색어 ${queries.length}종
- 이웃 증감 +${last7.reduce((a, d) => a + (d.neighbors?.add || 0), 0)} / -${last7.reduce((a, d) => a + (d.neighbors?.delete || 0), 0)}
- 출처: blog.stat.naver.com (네이버 블로그 통계). 매일 08:10 자동 수집. 유입 검색어 상위 60개는 state/inflow-keywords.json 에 저장되어 원고 생성기가 읽는다.

## 일별
| 날짜 | 조회수 | 방문 | 검색어 종류 | 이웃 |
|---|---|---|---|---|
${dayRows}

## 유입 검색어 (7일 합산) — 사람들이 실제로 친 말
| 검색어 | 조회 |
|---|---|
${queries.slice(0, 40).map((q) => `| ${q.q} | ${q.cv} |`).join("\n") || "| (없음) | |"}

## 글별 조회수 (7일 합산)
| 글 | 조회 | 발행 |
|---|---|---|
${postRows || "| (없음) | | |"}

## 유입 경로 (7일 합산)
| 경로 | 조회 |
|---|---|
${referRows || "| (없음) | |"}

## 연동 사이트 — 글을 열게 만든 구역 (7일)
| 구역 | 글 조회 |
|---|---|
${fromRows || "| (연동 사이트 없음 또는 집계 전) | |"}
`;
  await mkdir(path.dirname(REPORT), { recursive: true });
  await writeFile(REPORT, md);
  return md;
}
