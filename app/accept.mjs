// 받은 서로이웃 신청 자동 수락 + 환영 댓글
// 목록: /rego/BothBuddyRequestToMeListAsync.naver (로그인 쿠키) → 수락은 실제 페이지(BothBuddyRequestToMeList.naver)의 [수락] 버튼 클릭
// 수락 직후 상대의 최신 글에 글 내용을 짚은 댓글 하나 → 체인(읽기·댓글·재방문) 신호를 바로 만든다
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getBrowser } from "./publisher.mjs";
import { paths } from "../lib/paths.mjs";
import { suggestComment, postComment, loadState as loadCommentState } from "./comments.mjs";

const HOME = os.homedir();
const UA_REF = (blogId) => `https://m.blog.naver.com/BothBuddyRequestToMeList.naver?blogId=${blogId}`;
const stripPrefix = (t) => t.replace(/^\)\]\}',?\s*/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statePath = (blogKey) => paths.state(`accepted-${blogKey}`);

export async function loadAccepted(blogKey) {
  try { return JSON.parse(await readFile(statePath(blogKey), "utf8")); } catch { return { accepted: {}, failed: {} }; }
}
async function saveAccepted(blogKey, st) { await mkdir(path.dirname(statePath(blogKey)), { recursive: true }); await writeFile(statePath(blogKey), JSON.stringify(st, null, 2)); }

export async function listIncoming(profile, blogId) {
  const browser = await getBrowser(profile);
  const all = [];
  for (let page = 1; page <= 5; page += 1) {
    const r = await browser.request.get(`https://m.blog.naver.com/rego/BothBuddyRequestToMeListAsync.naver?blogId=${encodeURIComponent(blogId)}&currentPage=${page}`, {
      headers: { referer: UA_REF(blogId), accept: "application/json, text/plain, */*" }, timeout: 20000,
    });
    let j; try { j = JSON.parse(stripPrefix(await r.text())); } catch { break; }
    if (j?.error) throw new Error(`받은 신청 목록 실패: ${j.error.message} — 로그인 확인`);
    const res = j.result || {};
    all.push(...(res.bothBuddyRequestToMeList || []).map((x) => ({
      blogId: x.actorBlogId, nickname: x.actorNickName, blogTitle: x.actorBlogTitle, date: x.bothBuddyRequestDate, message: x.requestMessage,
    })));
    if (page >= (res.totalPage || 1)) break;
  }
  return all;
}

// 페이지에서 해당 신청자의 [수락] 클릭 (레이어가 뜨면 [확인]까지)
async function acceptOnPage(browser, blogId, actor) {
  const page = await browser.newPage();
  const responses = [];
  page.on("response", async (r) => {
    if (/BothBuddyAccept/i.test(r.url())) { let b = ""; try { b = (await r.text()).slice(0, 300); } catch { /* */ } responses.push({ url: r.url().split("/").pop().split("?")[0], status: r.status(), body: b }); }
  });
  page.on("dialog", (d) => d.accept().catch(() => {}));
  try {
    await page.goto(UA_REF(blogId), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(".btn_ok, text=수락", { timeout: 10000 }).catch(() => {});
    await sleep(800);
    // 신청자 블록: 닉네임 또는 블로그 제목 텍스트를 포함하는 가장 가까운 항목 안의 [수락]
    const item = page.locator("li, div").filter({ hasText: actor.nickname }).filter({ has: page.locator(".btn_ok") }).last();
    const ok = item.locator(".btn_ok").first();
    if (!(await ok.count())) return { ok: false, message: "페이지에서 해당 신청을 찾지 못함" };
    await ok.click({ timeout: 5000 });
    await sleep(1800);
    // 그룹 선택/확인 레이어 처리
    for (let i = 0; i < 3; i += 1) {
      const confirm = page.locator('.lyr_popup button:has-text("확인"), .lyr_popup a:has-text("확인"), button:has-text("확인"):visible, a.btn_ok:has-text("확인")').first();
      if ((await confirm.count()) && (await confirm.isVisible().catch(() => false))) { await confirm.click({ timeout: 3000 }).catch(() => {}); await sleep(1500); } else break;
    }
    const after = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/보안문자|자동 입력 방지|일시적으로 제한|이용이 제한/.test(after)) return { ok: false, fatal: true, message: "네이버 제한 감지 — 중단" };
    const acceptResp = responses.find((r) => r.url === "BothBuddyAcceptAsync.naver");
    const success = acceptResp ? !/"error"/.test(acceptResp.body) : !after.includes(actor.nickname);
    return { ok: success, message: success ? "수락 완료" : `수락 확인 안 됨 (${acceptResp?.body?.slice(0, 80) || after.slice(0, 80)})`, responses };
  } finally { await page.close().catch(() => {}); }
}

async function latestPost(blogId) {
  const r = await fetch(`https://m.blog.naver.com/api/blogs/${blogId}/post-list?categoryNo=0&itemCount=5&page=1`, { headers: { "User-Agent": "Mozilla/5.0", Referer: `https://m.blog.naver.com/${blogId}` } });
  const j = await r.json().catch(() => null);
  const it = (j?.result?.items || []).find((x) => x.commentCnt !== undefined) || j?.result?.items?.[0];
  return it ? { logNo: String(it.logNo), title: it.titleWithInspectMessage, brief: (it.briefContents || "").replace(/\s+/g, " ").slice(0, 260) } : null;
}

// 전체 처리: 받은 신청을 순서대로 수락하고(최대 max), 각 상대의 최신 글에 환영 댓글
export async function acceptIncoming(profile, blogKey, blogId, { welcome = true, max = 10, onLog } = {}) {
  const log = (m) => { onLog?.(m); };
  const browser = await getBrowser(profile);
  const st = await loadAccepted(blogKey);
  const incoming = await listIncoming(profile, blogId);
  const results = [];
  for (const actor of incoming.slice(0, max)) {
    const r = await acceptOnPage(browser, blogId, actor);
    const entry = { ...actor, accept: r.ok, message: r.message, comment: null };
    if (r.ok) st.accepted[actor.blogId] = { at: new Date().toISOString(), nickname: actor.nickname };
    else st.failed[actor.blogId] = { at: new Date().toISOString(), message: r.message };
    log(`${r.ok ? "✅" : "✗"} 수락 ${actor.nickname} — ${r.message}`);
    if (r.ok && welcome) {
      try {
        const cs = await loadCommentState(blogKey);
        const post = await latestPost(actor.blogId);
        if (post && !cs.done[`${actor.blogId}/${post.logNo}`]) {
          const sug = await suggestComment({ title: post.title, brief: post.brief, blogKey });
          if (sug.text) {
            const text = `서로이웃 감사합니다. ${sug.text}`;
            const cr = await postComment(profile, blogKey, { blogId: actor.blogId, logNo: post.logNo, text, title: post.title, nickname: actor.nickname });
            entry.comment = cr.ok ? text : `실패: ${cr.message}`;
            log(`   ${cr.ok ? "💬 댓글" : "✗ 댓글 실패"} ${actor.nickname}: ${(cr.ok ? text : cr.message).slice(0, 60)}`);
            if (cr.fatal) { results.push(entry); break; }
          } else entry.comment = `문안 실패: ${sug.error}`;
        } else entry.comment = post ? "이미 댓글 단 글" : "최근 글 없음";
      } catch (e) { entry.comment = `오류: ${String(e?.message ?? e).slice(0, 80)}`; }
    }
    results.push(entry);
    if (r.fatal) break;
    await sleep(8000 + Math.random() * 12000);
  }
  await saveAccepted(blogKey, st);
  return { ok: true, total: incoming.length, processed: results.length, results };
}
