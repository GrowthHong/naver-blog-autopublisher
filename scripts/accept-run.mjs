// 받은 서로이웃 신청 수락 + 환영 댓글 실행기 — 서버 경유 우선, 아니면 직접
import { readFile } from "node:fs/promises";
import { paths } from "../lib/paths.mjs";
const PORT = process.env.PORT || 5071;
let ok = false;
try { const r = await fetch(`http://localhost:${PORT}/api/neighbors/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ welcome: true, max: 10 }), signal: AbortSignal.timeout(900000) }); const j = await r.json(); ok = true; console.log(`서버 경유: 대기 ${j.total}건, 처리 ${j.processed}건`); } catch { /* 서버 꺼짐 */ }
if (!ok) {
  const cfg = JSON.parse(await readFile(paths.config, "utf8").catch(() => "{}")); const blogs = JSON.parse(await readFile(paths.blogs, "utf8").catch(() => "{}"));
  const key = cfg.active && blogs[cfg.active] ? cfg.active : Object.keys(blogs)[0]; if (!key) { console.log("설정된 블로그 없음"); process.exit(0); }
  const { acceptIncoming } = await import("../app/accept.mjs"); const { useCommentContext } = await import("../app/comments.mjs"); const { closeBrowser } = await import("../app/publisher.mjs");
  useCommentContext({ key, persona: blogs[key].persona, topicWords: blogs[key].topicWords, label: blogs[key].label });
  try { const j = await acceptIncoming(paths.profile(key), key, blogs[key].blogId, { welcome: true, max: 10, onLog: (m) => console.log(m) }); console.log(`직접: 대기 ${j.total}건, 처리 ${j.processed}건`); } finally { await closeBrowser(); }
}
process.exit(0);
