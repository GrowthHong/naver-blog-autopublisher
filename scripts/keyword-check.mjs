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
  ratioMax: 4,                       // [오픈API 없을 때만] 블로그 문서수 / 월 검색수 — 4 이하면 공략 가능
  docsMax: 40000,                    // [오픈API 없을 때만] 검색량 모를 때: 전체 문서수 상한
  recentMax: 400,                    // [오픈API 없을 때만] 최근 30일 신규 문서 상한
  // [오픈API 있을 때] 상위 10개 결과의 구성으로 판정. 근거: 2026-10-10 우리 블로그 21개 키워드 실측 —
  //   블로그탭 1페이지에 오른 4개(장기요양등급 신청·치매 검사 무료·보청기 국가지원·농지연금 수령액)는 모두 상위10 중 14일내 글 ≤4, 제목에 키워드 전부 포함 ≤8.
  //   14일내 글이 6개 이상인 3개(독감 무료접종·에너지바우처 신청·국민연금 조기수령)는 전부 순위 밖. API total(넓은 매칭 문서수)은 순위와 무관해 참고값으로만 둔다.
  fresh14Max: 5,                     // 상위10 중 14일 이내 글 수 상한 — 6개 이상이면 매일 새 글로 갈리는 키워드(신규 블로그는 못 버팀)
  exactTitleMax: 8,                  // 상위10 중 제목에 키워드 토큰을 전부 담은 글 수 상한 — 9개 이상이면 정면 포화
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

// 네이버 오픈API(블로그 검색) — 상위10 경쟁 구성. <데이터폴더>/naver-openapi.json {keyId, key}(NAVER API HUB) 또는 {clientId, clientSecret}(구 개발자센터)
let OPENAPI = null;
try { OPENAPI = JSON.parse(await readFile(`${DATA_DIR}/naver-openapi.json`, "utf8")); } catch { OPENAPI = null; }
// 키 형식 두 가지: ① NAVER API HUB(네이버클라우드, 2026-07-31 이후 신규 발급은 이것뿐) {keyId, key}  ② 구 개발자센터 {clientId, clientSecret}
function openApiReq(path) {
  if (OPENAPI?.keyId && OPENAPI?.key) return { url: `https://naverapihub.apigw.ntruss.com/search/v1/${path}`, headers: { "X-NCP-APIGW-API-KEY-ID": OPENAPI.keyId, "X-NCP-APIGW-API-KEY": OPENAPI.key } };
  if (OPENAPI?.clientId) return { url: `https://openapi.naver.com/v1/search/${path}.json`, headers: { "X-Naver-Client-Id": OPENAPI.clientId, "X-Naver-Client-Secret": OPENAPI.clientSecret } };
  return null;
}
let OUR_BLOG_RE = /$^/; // blogs.json에 등록된 블로그 아이디 전부
try { const b = JSON.parse(await readFile(`${DATA_DIR}/blogs.json`, "utf8")); const ids = Object.values(b).map((x) => x?.blogId).filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); if (ids.length) OUR_BLOG_RE = new RegExp(`blog\\.naver\\.com/(${ids.join("|")})(/|$)`); } catch {}
const stripHtml = (t) => t.replace(/<[^>]+>/g, "").replace(/&quot;|&amp;|&lt;|&gt;|&#39;/g, " ").replace(/\s+/g, "");
const daysAgo = (pd) => Math.round((Date.now() - new Date(`${pd.slice(0, 4)}-${pd.slice(4, 6)}-${pd.slice(6, 8)}`).getTime()) / 864e5);
// 오픈API로 상위 100개(정확도순)를 받아 경쟁 구성을 잰다. total은 넓은 매칭이라 순위 예측력이 없어 참고값.
async function openApiCompetition(k) {
  const req = openApiReq("blog");
  if (!req) return null;
  try {
    const j = await (await fetch(`${req.url}?query=${encodeURIComponent(k)}&display=100`, { headers: req.headers })).json();
    if (j.total === undefined && j.items === undefined) {
      const code = j?.error?.errorCode ?? j?.errorCode;
      if (code === "210") console.error("오픈API: 이 Application에 검색 API 구독이 없습니다 → 네이버클라우드 콘솔 NAVER API HUB → Application → 해당 앱 → 구독/서비스 선택에서 '검색' 추가");
      else console.error(`오픈API 응답 이상: ${JSON.stringify(j).slice(0, 160)}`);
      return null;
    }
    const items = j.items ?? [];
    const top = items.slice(0, 10);
    const toks = k.split(/\s+/).filter(Boolean);
    const ages = top.map((it) => daysAgo(it.postdate)).sort((x, y) => x - y);
    const ourIdx = items.findIndex((it) => OUR_BLOG_RE.test(it.link));
    return {
      total: j.total ?? null,
      fresh14: ages.filter((d) => d <= 14).length,
      fresh30: ages.filter((d) => d <= 30).length,
      medianAge: ages.length ? ages[Math.floor(ages.length / 2)] : null,
      exactTitle: top.filter((it) => { const t = stripHtml(it.title); return toks.every((x) => t.includes(x)); }).length,
      naverShare: top.filter((it) => /blog\.naver\.com/.test(it.link)).length,
      ourApiRank: ourIdx >= 0 ? ourIdx + 1 : null,
      ourUrl: ourIdx >= 0 ? items[ourIdx].link : null,
    };
  } catch (e) { console.error(`오픈API 호출 실패: ${String(e.message).slice(0, 100)}`); return null; }
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
  let docs = null, recent = null, capped = false, comp = null;
  comp = await openApiCompetition(k);
  if (comp) { docs = comp.total; }
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
  const ratio = !comp && volume && docs ? docs / volume : null;
  let pass, reason;
  const compTxt = comp ? `상위10: 14일내 ${comp.fresh14} · 제목일치 ${comp.exactTitle} · 중앙나이 ${comp.medianAge}일${comp.ourApiRank ? ` · 우리글 API ${comp.ourApiRank}위` : ""}` : null;
  const compOk = comp ? comp.fresh14 <= RULE.fresh14Max && comp.exactTitle <= RULE.exactTitleMax : null;
  const compWhy = comp && !compOk ? (comp.fresh14 > RULE.fresh14Max ? ` ✗ 매일 새 글로 갈리는 키워드(14일내 ${comp.fresh14}/10)` : ` ✗ 제목 정면 포화(${comp.exactTitle}/10)`) : "";
  if (restricted) {
    pass = null; reason = `광고 제한 키워드 — API 검색량 없음(자동완성 O, 수요 있음). 롱테일 변형("${k} 조건/나이/서류" 등)으로 다시 조회하거나 대체 판정` + (compTxt ? ` · ${compTxt}${compWhy}` : "");
  } else if (volume !== null && comp) {
    pass = volume >= RULE.volMin && volume <= RULE.volMax && compOk;
    reason = `검색량 ${volume}/월 · ${compTxt}${compWhy}${volume < RULE.volMin ? " ✗ 검색량 부족" : volume > RULE.volMax ? " ✗ 검색량 과다(대형 키워드)" : ""}`;
  } else if (volume !== null) {
    pass = volume >= RULE.volMin && volume <= RULE.volMax && (ratio === null || ratio <= RULE.ratioMax) && (recent === null || recent <= RULE.recentMax);
    reason = `검색량 ${volume}/월 · 문서 ${docs} · 비율 ${ratio?.toFixed(1)} · 30일 ${recent}`;
  } else if (comp) {
    // 검색량 없음(검색광고 키 없음 등): 자동완성 + 상위10 구성으로만
    pass = ac.present && compOk; reason = `자동완성 ${ac.present ? "O" : "X"} · ${compTxt}${compWhy}${!ac.present ? " (수요 증거 없음)" : ""}`;
  } else {
    if (docs === null) { pass = null; reason = `자동완성 ${ac.present ? "O" : "X"} · 문서수 측정 불가(1,000+) — 오픈API 키 필요`; }
    else { pass = ac.present && docs <= RULE.docsMax && (recent === null || recent <= RULE.recentMax); reason = `자동완성 ${ac.present ? "O" : "X"} · 문서 ${docs} · 30일 ${recent}${capped ? "+" : ""}${!ac.present ? " (수요 증거 없음)" : ""}`; }
  }
  const apiRelated = vols?.__related?.[k.replace(/\s+/g, "")] ?? [];
  rows.push({ keyword: k, volume, docs, recent30d: recent, ratio: ratio && +ratio.toFixed(2), top10: comp && { fresh14: comp.fresh14, fresh30: comp.fresh30, medianAge: comp.medianAge, exactTitle: comp.exactTitle, naverShare: comp.naverShare }, ourApiRank: comp?.ourApiRank ?? null, ourUrl: comp?.ourUrl ?? null, autocomplete: ac.present, related: ac.related, apiRelated, pass, reason });
}
console.log(JSON.stringify({ source: `${vols ? "searchad-api" : "proxy(autocomplete)"}+${OPENAPI ? "openapi-top10" : "section-docs"}`, rules: RULE, rows }, null, 1));
console.error("\n" + rows.map((r) => `${r.pass === null ? "?" : r.pass ? "✅" : "✗"} ${r.keyword} — ${r.reason}` + (r.apiRelated.length ? `\n     연관(검색량순): ${r.apiRelated.map((x) => `${x.kw}(${x.vol})`).join(", ")}` : "")).join("\n"));
if (!vols && !OPENAPI) console.error("\n※ 정확한 판정을 하려면 키가 필요합니다: 검색광고 API(<데이터폴더>/searchad.json) 또는 네이버 오픈API(<데이터폴더>/naver-openapi.json)");
process.exit(rows.some((r) => r.pass) ? 0 : 1);
