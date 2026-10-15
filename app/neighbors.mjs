// 서로이웃 후보 발굴 — 발굴·점수화는 자동, 신청 클릭은 사람 (반자동 원칙)
// 데이터원: 네이버 블로그 검색 페이지의 내부 JSON (section.blog.naver.com/ajax/SearchList.naver)
//          + 모바일 블로그 정보 API (m.blog.naver.com/api/blogs/{id}) — 이웃 수 확인용
// 안전장치: 하루 신청 기록 상한 DAILY_CAP, 이미 신청/건너뛴 블로그 제외, 자기 블로그 제외
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../lib/paths.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 블로그별 파일 (기본 = 혜택수첩 기존 파일명 유지)
let LOG_PATH = path.join(ROOT, "neighbors-log.json");
let CACHE_PATH = path.join(ROOT, "neighbors-cache.json");
let ACTIVE_KEYWORDS = null;
let ACTIVE_MESSAGES = null;
export function useBlogContext({ key, keywords, messages }) {
  ACTIVE_MESSAGES = messages ?? null;
  LOG_PATH = paths.state(`neighbors-log-${key || "main"}`);
  CACHE_PATH = paths.state(`neighbors-cache-${key || "main"}`);
  ACTIVE_KEYWORDS = keywords && keywords.length ? keywords : null;
}

export const DAILY_CAP = 7; // 시스템 한도(100)의 1/15 — 기계적 패턴으로 안 보이는 수준

// 우리 주제와 겹치는 검색어 — 이 키워드로 글을 쓰는 블로거 = 우리 글을 읽을 사람
const KEYWORDS = []; // 설정에서 받는다 (비어 있으면 후보 발굴 불가)

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function loadLog() {
  return loadJson(LOG_PATH, { requested: {}, skipped: {} });
}

async function saveLog(log) {
  await writeFile(LOG_PATH, JSON.stringify(log, null, 2));
}

export async function todayRequestedCount() {
  const log = await loadLog();
  return Object.values(log.requested).filter((r) => r.date === today()).length;
}

// 검색 1회: 키워드로 최신순 블로그 글 목록
async function searchPosts(keyword, page = 1) {
  const params = new URLSearchParams({
    countPerPage: "7",
    currentPage: String(page),
    keyword,
    orderBy: "recentdate",
    type: "post",
  });
  const res = await fetch(`https://section.blog.naver.com/ajax/SearchList.naver?${params}`, {
    headers: {
      "User-Agent": UA,
      Referer: `https://section.blog.naver.com/Search/Post.naver?pageNo=1&rangeType=ALL&orderBy=recentdate&keyword=${encodeURIComponent(keyword)}`,
    },
  });
  if (!res.ok) throw new Error(`검색 실패 (${keyword}): HTTP ${res.status}`);
  const text = await res.text();
  const data = JSON.parse(text.replace(/^\)\]\}',?\s*/, "")); // 네이버 JSON 보호 프리픽스 제거
  return data?.result?.searchList ?? [];
}

// 블로그 이웃 수 등 기본 정보 (실패해도 후보에서 빼지 않음)
async function blogInfo(blogId) {
  try {
    const res = await fetch(`https://m.blog.naver.com/api/blogs/${blogId}`, {
      headers: { "User-Agent": UA, Referer: `https://m.blog.naver.com/${blogId}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.result ?? null;
  } catch {
    return null;
  }
}

// 신청 메시지 — 상대의 실제 글 제목을 넣어 매번 다르게 (동일 문구 대량 발송 방지)
// 신청 메시지 — 상대의 실제 글 제목 + 내 소개 한 줄(설정 intro)로 매번 다르게
let ACTIVE_INTRO = "비슷한 주제로 글을 쓰고 있는 블로거";
export function useIntro(intro) { if (intro) ACTIVE_INTRO = intro; }
const MESSAGE_TEMPLATES = [
  (nick, title) => `안녕하세요, ${nick}님. "${title}" 글 잘 읽었습니다. 저는 ${ACTIVE_INTRO}인데, 관심사가 닿는 것 같아 서로이웃 신청드립니다.`,
  (nick, title) => `${nick}님 안녕하세요. "${title}" 보고 들어왔습니다. ${ACTIVE_INTRO}로 글을 쓰고 있어서 이웃 맺고 좋은 정보 나누고 싶어 신청드려요.`,
  (nick, title) => `안녕하세요 ${nick}님, "${title}" 유익하게 읽었습니다. 저도 ${ACTIVE_INTRO}라 서로 도움이 될 것 같아 서로이웃 신청드립니다.`,
];

// want: 이번에 확보할 후보 수(하루 신청 상한과 맞춤). 키워드마다 여러 페이지를 넘기며 충분히 모일 때까지 읽는다.
export async function discoverCandidates(myBlogId, want = 30) {
  const log = await loadLog();
  const byBlog = new Map();
  const MAX_PAGES = 8; // 키워드당 최대 8페이지(7건씩 56건)
  const enough = () => byBlog.size >= want * 2; // 점수순으로 추린 뒤 want개가 남도록 두 배 확보

  for (let page = 1; page <= MAX_PAGES && !enough(); page += 1) {
    for (const keyword of ACTIVE_KEYWORDS ?? KEYWORDS) {
      if (enough()) break;
      let posts = [];
      try {
        posts = await searchPosts(keyword, page);
      } catch {
        continue; // 키워드 하나 실패해도 나머지 진행
      }
      await sleep(400); // 검색 간격 — 예의 있는 속도
      for (const post of posts) {
      const id = post.blogId ?? post.domainIdOrBlogId;
      if (!id || id === myBlogId) continue;
      if (log.requested[id] || log.skipped[id]) continue;
      const entry = byBlog.get(id) ?? {
        blogId: id,
        blogName: post.blogName ?? "",
        nickName: post.nickName ?? post.blogName ?? "",
        keywords: new Set(),
        latestTitle: "",
        latestDate: 0,
        postCount: 0,
      };
      entry.keywords.add(keyword);
      entry.postCount += 1;
      const added = Number(post.addDate ?? 0);
      if (added > entry.latestDate) {
        entry.latestDate = added;
        // 검색 결과 제목에 하이라이트 태그가 섞여 있어 제거
        entry.latestTitle = (post.noTagTitle ?? post.title ?? "").replace(/<[^>]+>/g, "").trim();
      }
      byBlog.set(id, entry);
      }
    }
  }

  // 이웃 수 조회는 상위 want개만 (요청 수 절약)
  const rough = [...byBlog.values()].sort((a, b) => b.keywords.size - a.keywords.size || b.latestDate - a.latestDate).slice(0, want);
  const candidates = [];
  for (const entry of rough) {
    const info = await blogInfo(entry.blogId);
    const buddyCount = info?.subscriberCount ?? null;
    const daysAgo = entry.latestDate ? Math.floor((Date.now() - entry.latestDate) / 86400000) : null;
    // 점수: 주제 겹침(키워드 수) + 활동성(7일 내 발행) + 규모 적정(이웃 30~800 = 수락률 높은 구간)
    let score = entry.keywords.size * 2 + entry.postCount;
    if (daysAgo !== null && daysAgo <= 7) score += 3;
    else if (daysAgo !== null && daysAgo <= 30) score += 1;
    if (buddyCount !== null) {
      if (buddyCount >= 30 && buddyCount <= 800) score += 3;
      else if (buddyCount < 30) score += 1;
      else if (buddyCount > 3000) score -= 2; // 대형 블로그: 수락률 낮음
    }
    const templates = ACTIVE_MESSAGES ?? MESSAGE_TEMPLATES;
    const template = templates[candidates.length % templates.length];
    candidates.push({
      blogId: entry.blogId,
      blogName: entry.blogName,
      nickName: entry.nickName,
      keywords: [...entry.keywords],
      latestTitle: entry.latestTitle,
      daysAgo,
      buddyCount,
      score,
      message: template(entry.nickName || entry.blogName || "블로거", entry.latestTitle || "최근 글"),
    });
    await sleep(300);
  }

  candidates.sort((a, b) => b.score - a.score);
  const cache = { fetchedAt: new Date().toISOString(), candidates };
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
  return cache;
}

export async function loadCandidates() {
  const cache = await loadJson(CACHE_PATH, { fetchedAt: null, candidates: [] });
  const log = await loadLog();
  cache.candidates = cache.candidates.filter((c) => !log.requested[c.blogId] && !log.skipped[c.blogId]);
  return cache;
}

export async function markRequested(blogId, name, cap = DAILY_CAP) {
  const count = await todayRequestedCount();
  if (count >= cap) {
    return { ok: false, message: `오늘 신청 기록이 상한(${cap}건)에 도달했습니다. 내일 이어서 하세요.` };
  }
  const log = await loadLog();
  log.requested[blogId] = { date: today(), name: name ?? "" };
  await saveLog(log);
  return { ok: true, todayCount: count + 1 };
}

export async function markSkipped(blogId) {
  const log = await loadLog();
  log.skipped[blogId] = today();
  await saveLog(log);
  return { ok: true };
}
