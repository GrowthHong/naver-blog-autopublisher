// 네이버 통합검색 AI 브리핑 확인: 키워드별 브리핑 내용과 인용 출처. 원고 쓰기 전 "브리핑이 이미 답한 각도"를 피하기 위해 쓴다.
// 사용: node scripts/ai-brief-check.mjs "키워드" --print
import { chromium } from "playwright-core";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
const HOME = os.homedir();
const DATA_DIR = process.env.BAP_HOME || `${HOME}/.blog-autopublisher`;
let last = { results: [] };
try { const hist = JSON.parse(await readFile(`${DATA_DIR}/state/rank-history.json`, "utf8")); last = hist[hist.length - 1] || last; } catch { /* 측정 전 */ }
const PRINT = process.argv.includes("--print");
const argKws = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const kws = argKws.length ? argKws : last.results.filter((r) => r.aiBrief).map((r) => r.keyword);
// 인자로 키워드를 주면 기본 저장 파일을 덮지 않는다(전체 수집본 보호)
const OUT = process.env.OUT || (argKws.length ? `${DATA_DIR}/state/ai-brief-last.json` : `${DATA_DIR}/state/ai-brief-raw.json`);
if (!kws.length) { console.error('사용: node scripts/ai-brief-check.mjs "키워드" ["키워드2"] --print'); process.exit(2); }
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ locale: "ko-KR", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36", viewport: { width: 1280, height: 900 } })).newPage();
const out = {};
for (const k of kws) {
  await page.goto(`https://search.naver.com/search.naver?where=nexearch&sm=top_hty&query=${encodeURIComponent(k)}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  // AI 브리핑은 스트리밍으로 채워지고 출처 링크는 마지막에 붙는다 → 블록 텍스트·링크 수가 2번 연속 안 변할 때까지 기다린다(최대 14초)
  let prev = "", stable = 0;
  for (let i = 0; i < 20 && stable < 2; i += 1) {
    await page.waitForTimeout(700);
    if (i === 2) { for (let k = 0; k < 3; k += 1) { await page.mouse.wheel(0, 700).catch(() => {}); await page.waitForTimeout(200); } await page.mouse.wheel(0, -2100).catch(() => {}); }
    const sig = await page.evaluate(() => { const r = document.querySelector('[data-block-id^="ai-briefing"]'); return r ? `${r.innerText.length}|${r.querySelectorAll("a[href]").length}` : "none"; });
    if (sig === "none" && i >= 4) break;
    stable = sig === prev ? stable + 1 : 0; prev = sig;
  }
  // "더보기/펼치기" 류 버튼이 AI 블록 안에 있으면 눌러서 전체 펼침
  for (let i = 0; i < 3; i += 1) {
    const clicked = await page.evaluate(() => {
      const root = document.querySelector('[data-block-id^="ai-briefing"]'); if (!root) return false;
      const btn = [...root.querySelectorAll("button, a")].find((b) => /더보기|펼치기|자세히|전체 보기/.test((b.innerText || "").trim()) && b.offsetParent !== null);
      if (!btn) return false; btn.click(); return true;
    });
    if (!clicked) break; await page.waitForTimeout(800);
  }
  const r = await page.evaluate(() => {
    const root = document.querySelector('[data-block-id^="ai-briefing"]'); if (!root) return null;
    const txt = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
    const bad = (h) => /search\.naver\.com|help\.naver\.com|keep\.naver\.com|^javascript:|^#/.test(h);
    // 문단 단위: 헤딩(h3/strong/굵은 텍스트) 다음 텍스트들. 간단히 모든 텍스트 노드를 순서대로 훑으며 헤딩이 바뀔 때마다 끊는다
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const paras = []; let cur = { head: "(개요)", text: "", links: [] };
    const seen = new Set();
    let node;
    while ((node = walker.nextNode())) {
      const tag = node.tagName;
      const cls = (node.className || "").toString();
      if (/^H[2-5]$/.test(tag) || /headline|heading|title/i.test(cls) && node.children.length === 0 && txt(node).length < 40 && txt(node) !== "AI 브리핑") {
        const h = txt(node); if (!h || h === "AI 브리핑") continue;
        if (cur.text || cur.links.length) paras.push(cur);
        cur = { head: h, text: "", links: [] }; continue;
      }
      if (tag === "A") { const h = node.href; if (!bad(h) && !seen.has(h)) { seen.add(h); cur.links.push({ href: h, anchor: txt(node).slice(0, 60) }); } continue; }
      if (tag === "P" || (tag === "SPAN" && node.children.length === 0 && node.parentElement?.tagName !== "A")) { const t = txt(node); if (t && !cur.text.includes(t)) cur.text += (cur.text ? " " : "") + t; }
    }
    if (cur.text || cur.links.length) paras.push(cur);
    return { fullText: txt(root).slice(0, 6000), paras, allLinks: [...root.querySelectorAll("a[href]")].map((a) => a.href).filter((h) => !bad(h)) };
  });
  out[k] = r;
  const nBlog = r ? [...new Set(r.allLinks.filter((h) => /blog\.naver\.com\/[^/]+\/\d+/.test(h)).map((h) => h.replace(/[?#].*/, "")))].length : 0;
  console.error(`${r ? "✓" : "✗ 없음"} ${k} — 문단 ${r?.paras.length ?? 0} · 블로그 인용 ${nBlog}`);
  await page.waitForTimeout(1200 + Math.random() * 800);
}
await browser.close();
await writeFile(OUT, JSON.stringify(out, null, 1));
console.error(`저장: ${OUT}`);
if (PRINT) {
  // 원고 쓰기 전 확인용 요약: 브리핑이 있는지, 무슨 말을 하는지, 누구를 인용하는지 → 브리핑이 안 다루는 각도를 고르기 위한 재료
  const kind = (u) => { let h = ""; try { h = new URL(u).host; } catch { return "기타"; } return /blog\.naver/.test(h) ? "블로그" : /kin\.naver/.test(h) ? "지식iN" : /\.go\.kr|\.or\.kr|easylaw|nps|nhis|bokjiro/.test(h) ? "공공" : /news/.test(h) ? "뉴스" : /youtube/.test(h) ? "유튜브" : "웹"; };
  const summary = Object.fromEntries(Object.entries(out).map(([k, r]) => [k, r ? { aiBrief: true, text: r.fullText.replace(/^AI 브리핑\s*/, "").slice(0, 900), sources: r.allLinks.map((u) => `${kind(u)}:${u.replace(/^https?:\/\/(www\.|m\.)?/, "").slice(0, 60)}`).slice(0, 12) } : { aiBrief: false }]));
  console.log(JSON.stringify(summary, null, 1));
}
