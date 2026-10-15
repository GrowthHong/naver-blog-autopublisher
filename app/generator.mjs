// 새 원고 생성 — 클로드 CLI(claude -p)로 원고 1편(+카드 이미지)을 만든다.
// 프롬프트 = prompts/draft-prompt.md 템플릿 + 블로그 설정값 + 문체 가이드(prompts/style-guide.md)
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { APP_DIR, paths } from "../lib/paths.mjs";

const HOME = os.homedir();

export const job = { running: false, startedAt: null, finishedAt: null, exitCode: null, topic: "", newFiles: [], log: "", summary: "" };

export async function buildPrompt(blog, { topic = "", extra = "", notes = "" } = {}) {
  const template = await readFile(path.join(paths.prompts, "draft-prompt.md"), "utf8");
  const types = JSON.parse(await readFile(path.join(paths.prompts, "post-types.json"), "utf8"));
  const type = types[blog.postType] ? blog.postType : "info";
  const t = types[type];
  const needsNotes = type === "review" || type === "essay";
  if (needsNotes && !notes.trim()) throw new Error(`"${t.label}" 유형은 참고 메모(경험·수치·사진 설명)가 있어야 씁니다. 원고 탭의 참고 메모 칸에 적어 주세요.`);
  const style = await readFile(path.join(paths.prompts, "style-guide.md"), "utf8").catch(() => "");
  let searchadNote = "검색광고 API 키가 없어 검색량 게이트는 건너뛴다(자동완성·검색결과로 수요만 확인).";
  try { await readFile(paths.searchad, "utf8"); searchadNote = `node ${path.join(paths.scripts, "keyword-check.mjs")} "키워드1" "키워드2" 로 월 검색량을 확인해 pass:true 키워드만 쓴다(100~3,000 롱테일 우선).`; } catch { /* 키 없음 */ }
  const vars = {
    BLOG_NAME: blog.blogName || blog.label,
    BLOG_ID: blog.blogId,
    TOPIC_DESCRIPTION: blog.topicDescription || "(설정 탭에서 주제 설명을 적어 주세요)",
    AUDIENCE: blog.audience || "일반 독자",
    SITE_URL: blog.siteUrl || "",
    SITE_LINK_RULE: blog.siteUrl ? `글 끝에 연동 사이트(${blog.siteUrl})의 관련 글 주소를 한 줄 넣는다(홈 주소 말고 글 주소).` : "외부 링크는 공식 출처 1개만. 자기 사이트 링크 규칙 없음.",
    DRAFTS_DIR: blog.draftsDir,
    IMAGES_DIR: path.join(blog.draftsDir, "images"),
    PUBLISHED_DIR: path.join(blog.draftsDir, "published"),
    SCRIPTS_DIR: paths.scripts,
    SEARCHAD_NOTE: searchadNote,
    STYLE_GUIDE: style,
    POST_TYPE_LABEL: t.label,
    FACT_RULES: t.factRules,
    FORMAT_RULES: t.format,
    FOOTER_RULE: t.footer.replace(/\{\{BLOG_NAME\}\}/g, blog.blogName || blog.label),
    USER_NOTES: notes.trim() ? `## 참고 메모 (사용자가 직접 적은 재료 — 이 안의 사실만 쓴다)\n${notes.trim()}` : (needsNotes ? "" : "## 참고 메모\n(없음 — 공개 자료로 쓴다)"),
    TOPIC_REQUEST: topic.trim() ? `사용자가 지정한 주제: "${topic.trim()}". 이 주제로 쓴다(이미 같은 주제 원고가 있으면 다른 각도로).` : "주제는 주제 설명과 기존 원고 목록을 보고 아직 안 쓴 것 중에서 고른다.",
    EXTRA: extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ""));
}

export async function startGeneration(topic = "", blog = null, notes = "") {
  if (job.running) return { ok: false, message: "이미 원고를 생성하는 중입니다. 끝나면 목록에 자동으로 뜹니다." };
  if (!blog) return { ok: false, message: "먼저 설정 탭에서 블로그 정보를 저장하세요." };
  let prompt;
  try { prompt = await buildPrompt(blog, { topic, notes }); } catch (e) { return { ok: false, message: String(e.message) }; }
  const draftsDir = blog.draftsDir;
  const listPostsIn = async () => (await readdir(draftsDir)).filter((f) => f.startsWith("post-") && f.endsWith(".md"));
  const before = await listPostsIn();
  Object.assign(job, { running: true, startedAt: Date.now(), finishedAt: null, exitCode: null, topic, newFiles: [], log: "", summary: "" });

  // 다른 클로드 세션의 프록시·토큰이 상속되면 401이 난다 → 제거하고 CLI 자체 로그인(또는 장기 토큰)을 쓴다
  const childEnv = { ...process.env, PATH: process.platform === "win32" ? process.env.PATH : `${HOME}/.local/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
  for (const key of Object.keys(childEnv)) if (key.startsWith("CLAUDE") || key === "ANTHROPIC_BASE_URL" || key === "ANTHROPIC_AUTH_TOKEN") delete childEnv[key];
  try { const tok = (await readFile(paths.oauthToken, "utf8")).trim(); if (tok) childEnv.CLAUDE_CODE_OAUTH_TOKEN = tok; } catch { /* 토큰 없음 */ }

  const tools = blog.postType === "essay" ? ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] : ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"];
  const child = spawn("claude", ["-p", prompt, "--output-format", "json", "--max-turns", "120", "--add-dir", APP_DIR, "--allowedTools", ...tools], { cwd: draftsDir, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  let out = "";
  child.stdout.on("data", (d) => { out += d; job.log = out.slice(-4000); });
  child.stderr.on("data", (d) => { job.log = (job.log + d).slice(-4000); });
  child.on("close", async (code) => {
    job.exitCode = code; job.finishedAt = Date.now();
    try { job.summary = String(JSON.parse(out).result ?? "").slice(0, 600); } catch { job.summary = out.slice(-600); }
    job.authExpired = /Failed to authenticate|OAuth session expired|token has expired|Not logged in/.test(job.summary + job.log);
    if (job.authExpired) job.summary = "클로드 로그인이 만료됐습니다. 터미널에서 `claude auth login` 을 실행한 뒤 다시 눌러주세요. (반복되면 `claude setup-token`으로 장기 토큰을 발급해 설정 탭에 저장)";
    try { job.newFiles = (await listPostsIn()).filter((f) => !before.includes(f)); } catch { /* */ }
    job.running = false;
  });
  child.on("error", (err) => { job.log = `실행 실패: ${err.message} (claude CLI가 설치돼 있고 PATH에 있어야 합니다)`; job.exitCode = -1; job.finishedAt = Date.now(); job.running = false; });
  return { ok: true, message: "원고 생성을 시작했습니다. 조사·이미지 제작까지 보통 3~8분 걸립니다." };
}
