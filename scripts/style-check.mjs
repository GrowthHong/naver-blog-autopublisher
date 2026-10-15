// "AI 티" 검사기 — 그로케터 문체 가이드(style-guide.md)의 수치 목표를 원고에 적용. 실패면 exit 1
import { readFile } from "node:fs/promises";
const file = process.argv[2];
if (!file) { console.error("사용: node style-check.mjs <원고.md>"); process.exit(2); }
const raw = await readFile(file, "utf8");
const lines = raw.split("\n");
const title = (lines[0] || "").replace(/^제목:\s*/, "");
const body = lines.slice(2).join("\n");
const text = body.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/https?:\/\/\S+/g, "").replace(/\*\*/g, "");
const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p && !p.startsWith("##") && !p.startsWith("---") && !/^\d+\.\s/.test(p) === false ? p && !p.startsWith("##") && !p.startsWith("---") : p && !p.startsWith("##") && !p.startsWith("---"));
const bodyParas = text.split(/\n+/).map((p) => p.trim()).filter((p) => p && !p.startsWith("##") && !p.startsWith("---") && !p.startsWith("> "));
const sents = text.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter((s) => s.length > 1 && !s.startsWith("##"));
const headings = [...text.matchAll(/^##\s*(.+)$/gm)].map((m) => m[1].trim());
const PROFILE = process.env.STYLE_PROFILE || "hyetaek"; // 배포판 기본 = 금지 목록만 검사(지표 강제 없음)
const fails = [], warns = [];
// 기본 프로필: 문체 지표 없이 금지 목록만 검사한다. 노출 지표는 seo-rules가 담당.
const HYETAEK_MINIMAL = PROFILE === "hyetaek";
if (HYETAEK_MINIMAL) {
  const cue = (text.match(/(더라고요|는데요|거든요|잖아요|죠)[.!?…]*/g) || []).length;
  const folksy = (text.match(/예순다섯|일흔|칠십 퍼센트|값어치|옮겨 타|문이 (훨씬 )?넓/g) || []);
  const dashN = (text.match(/—/g) || []).length;
  const parenN = (text.match(/\(/g) || []).length;
  const bannedH = ["핵심은 ", "알아보겠습니다", "정리해 보겠습니다", "즉,", "것이 중요합니다", "를 추천합니다", "흔한 실수 세 가지", "내일 바로 할 체크리스트", "핵심 요약", "한눈에 보기:"].filter((b) => text.includes(b)); // 정리하면·다음과 같습니다는 사람 글에도 흔해 제외
  const iStart = (text.match(/(^|\n)저는/g) || []).length;
  const canN = (text.match(/할 수 있습니다/g) || []).length;
  const numN = (text.match(/\d[\d,.]*\s?(원|%|세|만)/g) || []).length;
  const midBreak = bodyParas.filter((p) => /[가-힣](면|고|서|며|는|은|을|를|에|의|도|과|와)$/.test(p) && !/[.!?]$/.test(p)).length;
  if (dashN > 1) fails.push(`줄표(—) ${dashN}개 — 1개 이하`);
  if (parenN > 10) fails.push(`괄호 ${parenN}개 — 10개 이하`);
  if (bannedH.length) fails.push(`AI 티 표현: ${bannedH.join(", ")}`);
  if (/^>\s*(핵심|요약|한눈에|먼저 보실)/m.test(text)) fails.push("'> 핵심 요약/한눈에 보기' 인용구 블록 금지");
  if (folksy.length) fails.push(`억지 토속어: ${[...new Set(folksy)].join(", ")}`);
  if (cue > 6) fails.push(`구어 어미(더라고요·는데요·거든요·잖아요·죠) ${cue}회 — 6회 이하`);
  if (iStart > 2) fails.push(`"저는" 줄 시작 ${iStart}회 — 2회 이하`);
  if (canN > 4) fails.push(`"할 수 있습니다" ${canN}회 — 4회 이하`);
  if (midBreak >= 3) fails.push(`문장 중간 줄바꿈 ${midBreak}줄 — 한 문장은 한 줄에`);
  if (numN > 15) warns.push(`숫자 표현 ${numN}개 — 15개 넘으면 카드 이미지로 옮기기`);
  if (process.env.SITE_HOST && !new RegExp(process.env.SITE_HOST.replace(/\./g, "\\.") + "/").test(body)) fails.push(`연동 사이트 글 링크(${process.env.SITE_HOST}) 없음`);
  if (process.env.BLOG_NAME && !body.includes(process.env.BLOG_NAME)) fails.push(`하단 고정 문구(${process.env.BLOG_NAME}…) 없음`);
  console.log(`[style-check] ${title}`);
  console.log(`  구어어미 ${cue} · 숫자 ${numN} · 괄호 ${parenN} · 중간줄바꿈 ${midBreak}`);
  for (const w of warns) console.log(`  ⚠ ${w}`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  console.log(fails.length ? `  결과: ${fails.length}건 — 고치고 다시 검사` : "  결과: 통과 ✓");
  process.exit(fails.length ? 1 : 0);
}
const need = (cond, msg, warn = false) => { if (!cond) (warn ? warns : fails).push(msg); };

const avgPara = bodyParas.reduce((a, p) => a + p.length, 0) / Math.max(1, bodyParas.length);
const shortRatio = sents.filter((s) => s.length <= 25).length / Math.max(1, sents.length);
const q = (text.match(/\?/g) || []).length, ex = (text.match(/!/g) || []).length;
const paren = (text.match(/\(/g) || []).length, dash = (text.match(/—/g) || []).length;
const endings = sents.map((s) => s.replace(/[\s"”)]*$/, ""));
const casual = endings.filter((s) => /(죠|요|네요|거든요|는데요|더라고요|다)[.!?…]*$/.test(s) && !/(습니다|입니다)[.!?…]*$/.test(s)).length / Math.max(1, endings.length);
const qHead = headings.filter((h) => h.includes("?")).length;
const contentHeads = headings.filter((h) => !/목차|마무리/.test(h));

const chars = text.replace(/\s/g, "").replace(/#+/g, "").length;
need(chars <= 3000, `본문 공백 제외 ${chars}자 — 3,000자 이하 (사장님 글 평균 1,500~2,500자. 사례 하나만 깊게)`);
need(chars >= 1400, `본문 ${chars}자 — 1,400자 이상`);
need(avgPara <= 45, `문단(줄) 평균 ${avgPara.toFixed(0)}자 — 45자 이하 (한 문장 한 줄)`);
need(shortRatio >= 0.22, `25자 이하 짧은 문장 ${(shortRatio * 100).toFixed(0)}% — 22% 이상`);
need(q >= 2, `물음표 ${q}개 — 2개 이상`);
need(q <= 12, `물음표 ${q}개 — 12개 이하`);
need(q <= 6, `물음표 ${q}개 — 6개 이하 권장`, true);
need(ex >= 1, `느낌표 ${ex}개 — 1개 이상`, true);
need(paren <= 5, `괄호 ${paren}개 — 5개 이하 (용어풀이 나열 금지)`);
need(dash === 0, `줄표(—) ${dash}개 — 금지`);
need(casual >= 0.15, `죠·요·다. 종결 비율 ${(casual * 100).toFixed(0)}% — 15% 이상 (습니다만 반복 금지)`);

const banned = ["핵심은 ", "알아보겠습니다", "정리해 보겠습니다", "정리하면", "즉,", "다음과 같습니다", "것이 중요합니다", "를 추천합니다", "흔한 실수 세 가지", "내일 바로 할 체크리스트", "핵심 요약"];
const hit = banned.filter((b) => text.includes(b));
need(hit.length === 0, `AI 티 표현: ${hit.join(", ")}`);
const canCount = (text.match(/할 수 있습니다/g) || []).length;
need(canCount <= 3, `"할 수 있습니다" ${canCount}회 — 3회 이하`);
const iCount = (text.match(/(^|\n)저는/g) || []).length;
need(iCount <= 1, `줄 첫머리 "저는" ${iCount}회 — 1회 이하 (경험은 문장 중간에)`);
need(!/^>\s*(핵심|요약)/m.test(text), "'> 핵심 요약' 인용구 블록 금지 (인용구는 현장 대사 인용에만)");
need(!/[★☆♥♡▶◀✔✅⭐🔥‼]/.test(title), "제목에 이모지·장식문자 금지");

// 덩어리(빈 줄로 나뉜 블록) 구조 — 사람 글은 2~5줄 덩어리, AI 글은 1줄 덩어리 연속
const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b && !b.startsWith("##") && !b.startsWith("---") && !b.startsWith("> ") && !b.startsWith("![") && !b.startsWith("- "));
const lineCounts = blocks.map((b) => b.split("\n").filter((l) => l.trim()).length);
const singleRatio = lineCounts.filter((n) => n === 1).length / Math.max(1, lineCounts.length);
const avgLines = lineCounts.reduce((a, b) => a + b, 0) / Math.max(1, lineCounts.length);
need(singleRatio <= 0.45, `한 줄짜리 덩어리 ${(singleRatio * 100).toFixed(0)}% — 45% 이하 (문장마다 빈 줄 금지, 2~5줄씩 묶기)`);
need(avgLines >= 1.8, `덩어리당 평균 ${avgLines.toFixed(1)}줄 — 1.8줄 이상`);
const soft = (text.match(/(는데요|텐데요|거든요|더라고요|볼까 합니다|드릴게요|해보세요)[.!?…]*/g) || []).length;
need(soft >= 2 || casual >= 0.25, `부드러운 연결어미(는데요·텐데요·거든요…) ${soft}회 — 2회 이상 (또는 구어 종결 25%+)`);
need(soft >= 4, `연결어미 ${soft}회 — 4회 이상 권장`, true);
const longLine = bodyParas.filter((p) => p.length > 42).length / Math.max(1, bodyParas.length);
need(longLine <= 0.25, `42자 넘는 줄 ${(longLine * 100).toFixed(0)}% — 25% 이하 (긴 문장은 의미 단위로 줄 나누기)`);
console.log(`[style-check] ${title}`);
console.log(`  줄평균 ${avgPara.toFixed(0)}자 · 단문 ${(shortRatio * 100).toFixed(0)}% · ?${q} !${ex} (${paren} —${dash} · 구어종결 ${(casual * 100).toFixed(0)}% · 1줄덩어리 ${(singleRatio * 100).toFixed(0)}% · 덩어리평균 ${avgLines.toFixed(1)}줄 · 연결어미 ${soft}`);
for (const w of warns) console.log(`  ⚠ ${w}`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(fails.length ? `  결과: AI 티 ${fails.length}건 — 고치고 다시 검사` : "  결과: 통과 ✓ (사람이 쓴 글로 읽힘)");
process.exit(fails.length ? 1 : 0);
