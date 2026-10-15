// 네이버 블로그 발행 전 자동 검사 규칙 v2 (단일 소스 — 발행기와 클라우드 루틴이 함께 사용)
// 근거: 네이버 공식(서치앤테크 C-Rank/D.I.A./D.I.A.+/스팸 사례 2026-07/링크 가이드) + 실전 관찰
// 상세 근거 문서: ~/Documents/5060생활정보웹사이트/docs/naver-blog/naver-seo-rules.md
// severity: "fail"(발행 차단) / "warn"(경고만 — 발행 가능)

import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const DATA_DIR = process.env.BAP_HOME || path.join(os.homedir(), ".blog-autopublisher");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
// 연동 사이트 호스트(선택): blogs.json의 활성 블로그 siteUrl. 없으면 자기 링크 검사는 하지 않는다
const SELF_HOST = (() => { try { const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); const blogs = JSON.parse(readFileSync(path.join(DATA_DIR, "blogs.json"), "utf8")); const b = blogs[cfg.active] || Object.values(blogs)[0]; return b?.siteUrl ? new URL(b.siteUrl).host : ""; } catch { return ""; } })();

// 발행기 설정 탭에서 바꾸는 값 — 파일이 없거나 항목이 없으면 기본값
function loadUserRule(key, fallback) {
  try { const v = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))[key]; return typeof v === "number" ? v : fallback; } catch { return fallback; }
}

export const RULES = {
  titleMin: 15,
  titleMax: 35, // 모바일 노출 ~25자, 핵심 키워드는 앞쪽에
  titleKeywordRepeatMax: 2, // [공식] 키워드 반복·남용
  bodyMinChars: 1000, // 공백 제외 [관찰: 상위노출 2,000~3,000자]
  bodyRecommendChars: 1500,
  maxParagraphChars: 300, // [공식] 읽기 쉬운 구조
  keywordDensityMax: 0.03, // [관찰] 밀도 3%
  linksMax: 3, // 전체 외부 링크
  selfLinksMax: 1, // 자기 사이트(hyetaek.co.kr) 링크
  sameUrlInRecentMax: 3, // [공식] "모든 글에 동일 URL" 스팸 패턴 — 최근 발행 10건 중 동일 URL 상한
  duplicateSentenceRatioMax: 0.3, // [공식] 유사문서/템플릿 대량생성 판독 회피
  dailyPublishMax: loadUserRule("publishMax", 0), // 사용자 설정(~/.hyetaek/config.json). 0 = 제한 없음. 네이버 공식 상한은 없고 "기계적 일정 간격"만 주의
  selfHost: SELF_HOST,
  bannedTitleChars: /[★☆♥♡▶◀✔✅⭐️🔥‼️]|[☀-➿]/u, // [공식] 장식용 특수문자
  shortUrlPattern: /https?:\/\/(bit\.ly|goo\.gl|han\.gl|url\.kr|me2\.do)\//, // [공식] 목적지 불명 링크
  intentTitlePattern: /(방법|조건|금액|신청|얼마|기준)/, // [공식 D.I.A.+] 낚시성: 의도형 제목이면 본문에 실제 정보
  bannedPatterns: ["지금 바로 클릭", "최저가", "수익 보장", "무조건 받으세요", "100% 환급", "100% 보장"],
};

const strip = (t) => t.replace(/\s+/g, "");
const links = (t) => t.match(/https?:\/\/[^\s)\]]+/g) ?? [];

function sentences(text) {
  return text
    .split(/[.!?\n]+/)
    .map((s) => strip(s))
    .filter((s) => s.length >= 15);
}

function topWordDensity(text) {
  const words = text
    .replace(/https?:\/\/[^\s)]+/g, " ")
    .split(/[\s.,!?()·—\-:;'"\[\]]+/)
    .filter((w) => w.length >= 2);
  if (!words.length) return { word: "", density: 0, count: 0 };
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const [word, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { word, density: count / words.length, count };
}

// 발행 보관함의 과거 글과 비교 (템플릿 재사용·동일 URL 반복 검사)
async function loadPublished(publishedDir) {
  try {
    const files = (await readdir(publishedDir)).filter((f) => f.endsWith(".md")).sort().slice(-10);
    const posts = [];
    for (const file of files) {
      posts.push(await readFile(path.join(publishedDir, file), "utf8"));
    }
    return posts;
  } catch {
    return [];
  }
}

export async function checkPost({ title, body, publishedDir }) {
  const results = [];
  const push = (id, ok, label, detail, severity = "fail", grade = "공식") =>
    results.push({ id, ok, label, detail, severity, grade });

  // ── 제목 ──
  const titleLen = title.trim().length;
  push("title-length", titleLen >= RULES.titleMin && titleLen <= RULES.titleMax, "제목 15~35자", `현재 ${titleLen}자`, "fail", "관찰");

  const titleWords = title.split(/\s+/).filter((w) => w.length >= 2);
  const repeated = titleWords.find((w) => titleWords.filter((x) => x === w).length > RULES.titleKeywordRepeatMax);
  push("title-repeat", !repeated, "제목 동일 단어 3회 반복 금지", repeated ? `"${repeated}" 반복` : "정상");

  push("title-chars", !RULES.bannedTitleChars.test(title), "제목 장식 특수문자·이모지 없음", "장식문자는 공식 스팸 신호");

  const missing = titleWords.filter((w) => {
    const clean = w.replace(/[.,!?]+$/, "");
    return clean.length >= 2 && !body.includes(clean);
  });
  push("title-body-match", missing.length <= Math.floor(titleWords.length / 3), "제목 키워드가 본문에 존재 (낚시성 차단)",
    missing.length ? `본문 미등장: ${missing.slice(0, 3).join(", ")}` : "정상");

  // ── 본문 ──
  const bodyChars = strip(body).length;
  push("body-length", bodyChars >= RULES.bodyMinChars, `본문 ${RULES.bodyMinChars}자+ (공백 제외)`, `현재 ${bodyChars}자`, "fail", "관찰");
  push("body-recommend", bodyChars >= RULES.bodyRecommendChars, `권장 ${RULES.bodyRecommendChars}자+`, `현재 ${bodyChars}자`, "warn", "관찰");

  const longPara = body.split(/\n{2,}/).find((p) => strip(p).length > RULES.maxParagraphChars);
  push("paragraph-length", !longPara, `한 문단 ${RULES.maxParagraphChars}자 이하 (읽기 쉬운 구조)`,
    longPara ? `${strip(longPara).length}자 문단 존재` : "정상", "warn");

  const { word, density, count } = topWordDensity(`${title} ${body}`);
  push("keyword-density", density <= RULES.keywordDensityMax, `키워드 밀도 ${RULES.keywordDensityMax * 100}% 이하`,
    word ? `"${word}" ${count}회 (${(density * 100).toFixed(1)}%)` : "-", "fail", "관찰");

  if (RULES.intentTitlePattern.test(title)) {
    const hasConcrete = /\d/.test(body) && /(①|②|1\.|2\.|첫째|둘째|순서|단계)/.test(body);
    push("intent-match", hasConcrete, "의도형 제목 ↔ 본문에 구체 정보(숫자·절차)", hasConcrete ? "정상" : "숫자/절차 목록 필요");
  }

  const banned = RULES.bannedPatterns.filter((p) => title.includes(p) || body.includes(p));
  push("banned", banned.length === 0, "광고성 문구 없음", banned.join(", ") || "정상");

  // ── 링크 ──
  const allLinks = links(body);
  const selfLinks = allLinks.filter((l) => l.includes(RULES.selfHost));
  push("links-total", allLinks.length <= RULES.linksMax, `외부 링크 ${RULES.linksMax}개 이하`, `현재 ${allLinks.length}개`);
  push("links-self", selfLinks.length <= RULES.selfLinksMax, `자기 사이트 링크 ${RULES.selfLinksMax}개 이하`, `현재 ${selfLinks.length}개`);
  push("links-short", !RULES.shortUrlPattern.test(body), "단축 URL 없음", "목적지 불명 링크는 공식 리스크");
  const hasGovLink = allLinks.some((l) => /go\.kr|or\.kr/.test(l));
  push("links-gov", true, "공식 기관 원문 링크 (권장)", hasGovLink ? "포함 ✓ (신뢰 가점)" : "미포함 — 넣으면 좋음", "warn");

  // ── 과거 발행 글과 교차 검사 ──
  if (publishedDir) {
    const published = await loadPublished(publishedDir);
    if (published.length) {
      for (const url of selfLinks) {
        const sameCount = published.filter((p) => p.includes(url)).length;
        push("link-variety", sameCount < RULES.sameUrlInRecentMax, "동일 URL 반복 금지 (기승전링크 패턴)",
          sameCount ? `최근 발행글에 같은 URL ${sameCount}회` : "정상");
      }
      const mySentences = new Set(sentences(body));
      let maxOverlap = 0;
      for (const p of published) {
        const theirs = new Set(sentences(p));
        const overlap = [...mySentences].filter((s) => theirs.has(s)).length;
        maxOverlap = Math.max(maxOverlap, mySentences.size ? overlap / mySentences.size : 0);
      }
      push("duplicate", maxOverlap <= RULES.duplicateSentenceRatioMax, "과거 글과 문장 중복 30% 이하 (템플릿 판독 회피)",
        `최대 중복률 ${(maxOverlap * 100).toFixed(0)}%`);
      const today = new Date().toISOString().slice(0, 10);
      const publishedToday = (await readdir(publishedDir).catch(() => [])).filter((f) => f.startsWith(today)).length;
      if (RULES.dailyPublishMax > 0) push("daily-limit", publishedToday < RULES.dailyPublishMax, `1일 발행 ${RULES.dailyPublishMax}건 이하`, `오늘 ${publishedToday}건 발행됨`);
    }
  }

  const failed = results.filter((r) => !r.ok && r.severity === "fail");
  const warned = results.filter((r) => !r.ok && r.severity === "warn");
  return { ok: failed.length === 0, results, failed, warned };
}


// CLI: node seo-rules.mjs <원고.md>  → 검사 결과 출력, failed 있으면 exit 1
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2]) {
  const file = path.resolve(process.argv[2]);
  const raw = readFileSync(file, "utf8");
  const lines = raw.split("\n");
  const title = (lines.find((l) => l.startsWith("제목:")) || "").slice(3).trim();
  const body = lines.filter((l) => !l.startsWith("제목:")).join("\n").trim();
  const publishedDir = path.join(path.dirname(file), "published");
  checkPost({ title, body, publishedDir }).then((r) => {
    for (const x of r.results || []) console.log(`${x.ok ? "✓" : "✗"} ${x.label} ${x.detail || ""}`);
    console.log(`failed ${r.failed?.length ?? 0} · warned ${r.warned?.length ?? 0}`);
    process.exit(r.ok ? 0 : 1);
  });
}
