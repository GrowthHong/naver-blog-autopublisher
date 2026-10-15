// 통계 수집 실행기 — 발행기 서버가 켜져 있으면 서버 경유, 아니면 크롬 프로필을 직접 연다
import { readFile } from "node:fs/promises";
import { paths } from "../lib/paths.mjs";
const PORT = process.env.PORT || 5071;
let ok = false;
try { const r = await fetch(`http://localhost:${PORT}/api/stats/collect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ days: 7 }), signal: AbortSignal.timeout(180000) }); const j = await r.json(); ok = true; console.log(j.ok ? `서버 경유 수집: ${j.dates?.join(", ")}` : `실패: ${j.message}`); } catch { /* 서버 꺼짐 */ }
if (!ok) {
  const cfg = JSON.parse(await readFile(paths.config, "utf8").catch(() => "{}")); const blogs = JSON.parse(await readFile(paths.blogs, "utf8").catch(() => "{}"));
  const key = cfg.active && blogs[cfg.active] ? cfg.active : Object.keys(blogs)[0]; if (!key) { console.log("설정된 블로그 없음"); process.exit(0); }
  const { collectStats, useStatsContext } = await import("../app/stats.mjs"); const { closeBrowser } = await import("../app/publisher.mjs");
  useStatsContext({ siteUrl: blogs[key].siteUrl });
  try { const r = await collectStats(paths.profile(key), { days: 7 }); console.log(`직접 수집: ${r.dates.join(", ")}`); } finally { await closeBrowser(); }
}
process.exit(0);
