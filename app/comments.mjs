// 이웃 새 글에 댓글 달기 — 네이버 모바일 이웃 피드(buddy-feed) API로 후보를 모으고,
// 클로드로 댓글 문안을 제안하고, 로그인된 크롬으로 댓글을 등록한다.
// 이웃 수 자체는 노출 지표가 아니고 '체인'(읽기·댓글·재방문)이 지표라서, 댓글이 서로이웃 신청보다 중요하다.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { getBrowser } from "./publisher.mjs";
import { paths } from "../lib/paths.mjs";

const HOME = os.homedir();
const FEED_API = "https://query.blog.naver.com/mweb/buddy-feed/ab/cards";
// 댓글 후보 우선순위용 주제어 — 블로그 설정(topicWords)에서 받는다
let TOPIC_WORDS = {};
let PERSONA = {};
export function useCommentContext(blog) {
  TOPIC_WORDS[blog.key] = blog.topicWords || [];
  PERSONA[blog.key] = blog.persona || `${blog.label || "이 블로그"} 운영자`;
}

function statePath(blogKey) { return paths.state(`comments-${blogKey}`); }
export async function loadState(blogKey) {
  try { return JSON.parse(await readFile(statePath(blogKey), "utf8")); } catch { return { done: {}, skipped: {} }; }
}
async function saveState(blogKey, st) {
  await mkdir(path.dirname(statePath(blogKey)), { recursive: true });
  await writeFile(statePath(blogKey), JSON.stringify(st, null, 2));
}
export function todayDoneCount(st) {
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(st.done).filter((d) => (d.at || "").slice(0, 10) === today).length;
}

const unescapeHtml = (s) => String(s ?? "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

// 이웃 피드에서 이웃이 쓴 새 글만 모은다 (추천 글·광고 카드는 제외)
export async function fetchBuddyFeed(profile, pages = 2) {
  const browser = await getBrowser(profile);
  const posts = [];
  const exposed = [];
  let pagingParam;
  for (let p = 0; p < pages; p++) {
    const body = {
      feedType: "TOTAL",
      campsParam: { appVersion: "UNKNOWN", deviceModel: "UNKNOWN", isWifi: false, os: "MAC", osVersion: "10.15.7" },
      exposedContentKeys: exposed.slice(-60),
    };
    if (pagingParam) body.pagingParam = pagingParam;
    const r = await browser.request.post(FEED_API, {
      headers: { referer: "https://m.blog.naver.com/FeedList.naver", accept: "application/json, text/plain, */*", "content-type": "application/json" },
      data: body, timeout: 20000,
    });
    let j;
    try { j = await r.json(); } catch { break; }
    if (!j?.isSuccess) {
      if (p === 0) throw new Error(`피드 API 실패 (${r.status()}): ${j?.error?.message || "응답 없음"} — 네이버 로그인 상태를 확인하세요`);
      break;
    }
    for (const c of j.result.cardList || []) {
      const card = c.card;
      if (c.cardType !== "buddy_post" || !card?.logNo) continue;
      exposed.push({ type: "POST", key: Number(card.logNo) });
      posts.push({
        blogId: card.blogIdOrDomainId, logNo: String(card.logNo), nickname: card.nickname, blogName: card.blogName,
        title: unescapeHtml(card.title), brief: unescapeHtml(card.briefContents).replace(/\s+/g, " ").slice(0, 260),
        addDate: card.addDate, commentOn: card.commentOn !== false,
        thumb: card.thumbnailList?.[0]?.thumbnailUrl || null,
        url: `https://m.blog.naver.com/${card.blogIdOrDomainId}/${card.logNo}`,
      });
    }
    pagingParam = j.result.pagingParam;
    if (!pagingParam) break;
  }
  // 같은 글 중복 제거
  const seen = new Set();
  return posts.filter((p) => { const k = `${p.blogId}/${p.logNo}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function listCandidates(profile, blogKey) {
  const st = await loadState(blogKey);
  const feed = await fetchBuddyFeed(profile, 2);
  const words = TOPIC_WORDS[blogKey] || [];
  const now = Date.now();
  const candidates = feed
    .filter((p) => p.commentOn && !st.done[`${p.blogId}/${p.logNo}`] && !st.skipped[`${p.blogId}/${p.logNo}`])
    .map((p) => {
      const hay = p.title + " " + p.brief.slice(0, 120);
      const hit = words.filter((w) => hay.includes(w));
      return { ...p, topicHits: hit, hoursAgo: Math.max(0, Math.round((now - p.addDate) / 3600000)), done: st.done[`${p.blogId}/${p.logNo}`] || null };
    })
    .sort((a, b) => (b.topicHits.length - a.topicHits.length) || (b.addDate - a.addDate));
  return { candidates, todayCount: todayDoneCount(st), total: feed.length };
}

export async function markSkipped(blogKey, blogId, logNo) {
  const st = await loadState(blogKey);
  st.skipped[`${blogId}/${logNo}`] = { at: new Date().toISOString() };
  await saveState(blogKey, st);
}

// 댓글 문안 제안 — 클로드 CLI(짧은 프롬프트, haiku). 실패하면 text 빈 문자열
export function suggestComment({ title, brief, blogKey = "main" }) {
  const prompt = `너는 ${PERSONA[blogKey] || "이 블로그 운영자"}다. 이웃 블로거의 아래 글에 달 댓글 한 개를 써라.

제목: ${title}
본문 앞부분: ${brief}

규칙:
- 2~3문장, 전체 60~140자. 글에서 실제로 다룬 내용 하나를 집어서 반응한다(제목만 보고 쓴 티가 나면 안 된다).
- "좋은 정보 감사합니다", "잘 보고 갑니다", "유익하네요" 같은 인사 템플릿 금지. 이모지·링크·해시태그·내 블로그 홍보 금지.
- 존댓말. 과장된 감탄 금지. 질문 하나를 붙여도 좋다.
- 댓글 본문만 출력한다. 따옴표·설명·제목 없이.`;
  return new Promise(async (resolve) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("CLAUDE") || k === "ANTHROPIC_BASE_URL" || k === "ANTHROPIC_AUTH_TOKEN") delete env[k];
    try { const tok = (await readFile(paths.oauthToken, "utf8")).trim(); if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok; } catch { /* 토큰 없음 */ }
    env.PATH = `/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:${env.PATH || ""}`;
    const child = spawn("claude", ["-p", prompt, "--model", "haiku", "--output-format", "text", "--tools", ""], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ text: "", error: "제안 시간 초과(90초)" }); }, 90000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim().replace(/^["“「]|["”」]$/g, "").trim();
      if (code !== 0 || !text) return resolve({ text: "", error: (err || out).trim().slice(0, 300) || `종료 코드 ${code}` });
      resolve({ text });
    });
  });
}

// 댓글 등록 — 모바일 댓글 페이지(CommentList.naver)에서 입력창에 쓰고 [등록] 클릭
export async function postComment(profile, blogKey, { blogId, logNo, text, title, nickname, dryRun = false }) {
  const browser = await getBrowser(profile);
  const page = await browser.newPage();
  try {
    await page.goto(`https://m.blog.naver.com/CommentList.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    const box = page.locator("#naverComment__write_textarea");
    await box.waitFor({ state: "visible", timeout: 15000 }).catch(() => { throw new Error("댓글 입력창이 안 보입니다 — 로그인이 풀렸거나 댓글이 막힌 글입니다"); });
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/보안문자|자동 입력 방지|일시적으로 제한|이용이 제한/.test(bodyText)) return { ok: false, fatal: true, message: "네이버가 보안문자·제한을 띄웠습니다. 오늘은 여기서 멈추세요." };
    // 플레이스홀더(.u_cbox_guide)가 입력창 위를 덮고 있어 그걸 먼저 클릭해 포커스를 준다
    const guide = page.locator("#naverComment .u_cbox_guide, .u_cbox_guide").first();
    if (await guide.isVisible().catch(() => false)) await guide.click({ timeout: 3000 }).catch(() => {});
    await box.click({ force: true, timeout: 3000 }).catch(() => {});
    await box.focus().catch(() => {});
    await page.keyboard.type(text, { delay: 18 });
    await page.waitForTimeout(600);
    const btn = page.locator("#naverComment .u_cbox_btn_upload, .u_cbox_btn_upload").first();
    if (dryRun) {
      const typed = await box.innerText().catch(() => "");
      return { ok: true, dryRun: true, message: `입력만 확인(등록 안 함): 입력된 글자 ${typed.length}자, 등록 버튼 ${await btn.isVisible().catch(() => false) ? "보임" : "안 보임"} (${(await btn.innerText().catch(() => "")).trim()})` };
    }
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(2500);
    const after = await page.locator("body").innerText().catch(() => "");
    if (/보안문자|자동 입력 방지|일시적으로 제한|이용이 제한/.test(after)) return { ok: false, fatal: true, message: "등록 직후 네이버가 보안문자·제한을 띄웠습니다. 오늘은 여기서 멈추세요." };
    const probe = text.slice(0, 18);
    const listed = await page.locator("#naverComment .u_cbox_contents").filter({ hasText: probe }).count().catch(() => 0);
    if (!listed) return { ok: false, message: "등록 버튼은 눌렀지만 목록에서 댓글을 찾지 못했습니다. 브라우저에서 확인해 주세요." };
    const st = await loadState(blogKey);
    st.done[`${blogId}/${logNo}`] = { at: new Date().toISOString(), text, title, nickname };
    await saveState(blogKey, st);
    return { ok: true, message: `댓글 등록 완료 — ${nickname || blogId}` };
  } finally {
    await page.close().catch(() => {});
  }
}
