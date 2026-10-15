// 키워드 검색량·경쟁도 판정 — 현재 블로그 지수에서 상위노출 가능한 키워드만 통과시킨다
// 1순위: 네이버 검색광고 API(<데이터폴더>/searchad.json에 키가 있으면) → 월간 검색수(PC+모바일)
// 2순위(키 없음): 자동완성 등장 여부(수요 증거) + 블로그 전체 문서수 + 최근 30일 신규 문서수(경쟁 강도)
// 사용: node scripts/keyword-check.mjs "키워드1" "키워드2" ...   → JSON + 표 출력, 통과 키워드만 pass:true
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import os from "node:os";

const DATA_DIR = process.env.BAP_HOME || `${os.homedir()}/.blog-autopublisher`;
const KEY_PATH = `${DATA_DIR}/searchad.json`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/127.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keywords = process.argv.slice(2).map((k) => k.trim()).filter(Boolean);
if (!keywords.length) { console.error('사용: node keyword-check.mjs "키워드" ...'); process.exit(2); }

// 기준 — 신규·저지수 블로그용. 검색량이 있으면 그걸 쓰고, 없으면 문서수 기준만으로 판단
const RULE = {
  volMin: 100, volMax: 20000,        // 월간 검색수 — 신규 블로그 롱테일 구간 (복지 키워드는 100~3,000이 노릴 자리)
  ratioMax: 4,                       // 전체 블로그 문서수 / 월 검색수 — 4 이하면 공략 가능
  docsMax: 40000,                    // 검색량 모를 때: 전체 문서수 상한
  recentMax: 400,                    // 최근 30일 신규 문서 상한 (경쟁 강도)
};

async function searchAdVolumes(list) {
  let cfg;
  try { cfg = JSON.parse(await readFile(KEY_PATH, "utf8")); } catch { return null; }
  const { customerId, accessLicense, secretKey } = cfg;
  if (!customerId || !accessLicense || !secretKey) return null;
  const out = {};
  const related = {}; // hint(공백제거) → [{kw, vol}] 검색량순
  for (let i = 0; i < list.length; i += 5) {
    const chunk = list.slice(i, i + 5);
    const ts = Date.now().toString();
    const uri = "/keywordstool";
    const sig = createHmac("sha256", secretKey).update(`${ts}.GET.${uri}`).digest("base64");
    const q = new URLSearchParams({ hintKeywords: chunk.map((k) => k.replace(/\s+/g, "")).join(","), showDetail: "1" });
    const res = await fetch(`https://api.searchad.naver.com${uri}?${q}`, {
      headers: { "X-Timestamp": ts, "X-API-KEY": accessLicense, "X-Customer": String(customerId), "X-Signature": sig },
    });
    if (!res.ok) { console.error("검색광고 API 오류", res.status, (await res.text()).slice(0, 120)); return null; }
    const data = await res.json();
    const toNum = (v) => (typeof v === "string" && v.startsWith("<") ? 5 : Number(v) || 0);
    const rows = (data.keywordList ?? []).map((row) => ({ kw: row.relKeyword, vol: toNum(row.monthlyPcQcCnt) + toNum(row.monthlyMobileQcCnt), comp: row.compIdx }));
    for (const r of rows) out[r.kw.replace(/\s+/g, "")] = { pc: 0, mobile: r.vol, comp: r.comp };
    for (const h of chunk) {
      const hk = h.replace(/\s+/g, "");
      const core = hk.slice(0, Math.min(4, hk.length));
      related[hk] = rows.filter((r) => r.kw.replace(/\s+/g, "").includes(core) && r.vol >= 50).sort((a, b) => b.vol - a.vol).slice(0, 10);
    }
    await sleep(300);
  }
  out.__related = related;
  return out;
}

async function autocomplete(k) {
  try {
    const u = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(k)}&con=1&frm=nv&ans=2&r_format=json&r_enc=UTF-8&st=100`;
    const j = await (await fetch(u, { headers: { "User-Agent": UA, Referer: "https://www.naver.com/" } })).json();
    const items = (j.items ?? []).flat().map((x) => (Array.isArray(x) ? x[0] : x)).filter(Boolean);
    return { present: items.some((s) => s.replace(/\s+/g, "") === k.replace(/\s+/g, "")), related: items.slice(0, 5) };
  } catch { return { present: false, related: [] }; }
}

// 네이버 오픈API(블로그 검색) — 실제 총 문서수. <데이터폴더>/naver-openapi.json {clientId, clientSecret}
let OPENAPI = null;
try { OPENAPI = JSON.parse(await readFile(`${DATA_DIR}/naver-openapi.json`, "utf8")); } catch { OPENAPI = null; }
async function openApiDocs(k) {
  if (!OPENAPI?.clientId) return null;
  const h = { "X-Naver-Client-Id": OPENAPI.clientId, "X-Naver-Client-Secret": OPENAPI.clientSecret };
  try {
    const all = await (await fetch(`https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(k)}&display=1`, { headers: h })).json();
    const recentRes = await (await fetch(`https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(k)}&display=100&sort=date`, { headers: h })).json();
    const cutoff = Date.now() - 30 * 864e5;
    const items = recentRes.items ?? [];
    const within = items.filter((it) => { const d = it.postdate; return d && new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`).getTime() >= cutoff; }).length;
    // 최신 100건이 모두 30일 안이면 그 이상이라는 뜻 → 100+ 로 표기
    return { total: all.total ?? null, recent30: within >= 100 ? 100 : within, recentCapped: within >= 100 };
  } catch { return null; }
}

async function blogDocs(k, period) {
  const p = new URLSearchParams({ countPerPage: "7", currentPage: "1", keyword: k, orderBy: "sim", type: "post" });
  if (period) { const end = new Date(), start = new Date(Date.now() - 30 * 864e5); const f = (d) => d.toISOString().slice(0, 10); p.set("rangeType", "PERIOD"); p.set("startDate", f(start)); p.set("endDate", f(end)); }
  try {
    const t = await (await fetch(`https://section.blog.naver.com/ajax/SearchList.naver?${p}`, { headers: { "User-Agent": UA, Referer: "https://section.blog.naver.com/Search/Post.naver" } })).text();
    return JSON.parse(t.replace(/^\)\]\}',?\s*/, "")).result?.totalCount ?? null;
  } catch { return null; }
}

const vols = await searchAdVolumes(keywords);
const rows = [];
for (const k of keywords) {
  const ac = await autocomplete(k);
  let docs, recent, capped = false;
  const oa = await openApiDocs(k);
  if (oa) { docs = oa.total; recent = oa.recent30; capped = oa.recentCapped; }
  else {
    docs = await blogDocs(k, false); await sleep(400);
    recent = await blogDocs(k, true); await sleep(400);
    if (docs !== null && docs >= 1000) { docs = null; recent = null; capped = true; } // section 검색은 1,000에서 잘려 판정 불가
  }
  const v = vols?.[k.replace(/\s+/g, "")];
  const apiRelatedEarly = vols?.__related?.[k.replace(/\s+/g, "")] ?? [];
  // 광고 제한 키워드(기초연금·국민연금 등 정책명)는 API가 "<10"에 연관 0으로 응답 — 수요 없음이 아니라 측정 불가
  const restricted = v && v.pc + v.mobile <= 10 && apiRelatedEarly.length <= 1 && (await autocomplete(k)).present;
  const volume = v && !restricted ? v.pc + v.mobile : null;
  const ratio = volume && docs ? docs / volume : null;
  let pass, reason;
  if (restricted) {
    pass = null; reason = `광고 제한 키워드 — API 검색량 없음(자동완성 O, 수요 있음). 롱테일 변형("${k} 조건/나이/서류" 등)으로 다시 조회하거나 대체 판정`;
  } else if (volume !== null) {
    pass = volume >= RULE.volMin && volume <= RULE.volMax && (ratio === null || ratio <= RULE.ratioMax) && (recent === null || recent <= RULE.recentMax);
    reason = `검색량 ${volume}/월 · 문서 ${docs} · 비율 ${ratio?.toFixed(1)} · 30일 ${recent}`;
  } else {
    if (docs === null) { pass = null; reason = `자동완성 ${ac.present ? "O" : "X"} · 문서수 측정 불가(1,000+) — 오픈API 키 필요`; }
    else { pass = ac.present && docs <= RULE.docsMax && (recent === null || recent <= RULE.recentMax); reason = `자동완성 ${ac.present ? "O" : "X"} · 문서 ${docs} · 30일 ${recent}${capped ? "+" : ""}${!ac.present ? " (수요 증거 없음)" : ""}`; }
  }
  const apiRelated = vols?.__related?.[k.replace(/\s+/g, "")] ?? [];
  rows.push({ keyword: k, volume, docs, recent30d: recent, ratio: ratio && +ratio.toFixed(2), autocomplete: ac.present, related: ac.related, apiRelated, pass, reason });
}
console.log(JSON.stringify({ source: vols ? "searchad-api" : "proxy(autocomplete+docs)", rules: RULE, rows }, null, 1));
console.error("\n" + rows.map((r) => `${r.pass === null ? "?" : r.pass ? "✅" : "✗"} ${r.keyword} — ${r.reason}` + (r.apiRelated.length ? `\n     연관(검색량순): ${r.apiRelated.map((x) => `${x.kw}(${x.vol})`).join(", ")}` : "")).join("\n"));
if (!vols && !OPENAPI) console.error("\n※ 정확한 판정을 하려면 키가 필요합니다: 검색광고 API(<데이터폴더>/searchad.json) 또는 네이버 오픈API(<데이터폴더>/naver-openapi.json)");
process.exit(rows.some((r) => r.pass) ? 0 : 1);
