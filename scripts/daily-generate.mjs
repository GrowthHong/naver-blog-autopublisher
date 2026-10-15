// 매일 자동 원고 생성 (launchd). 설정 dailyTarget 편수만큼, 한 편씩 독립 세션으로 claude -p 실행.
// 사용: node scripts/daily-generate.mjs   로그: <데이터폴더>/logs/daily-YYYY-MM-DD.log
import { spawn } from "node:child_process";
import { readFile, appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { APP_DIR, paths, ensureDirs } from "../lib/paths.mjs";
import { buildPrompt } from "../app/generator.mjs";

const HOME = os.homedir();
ensureDirs();
const cfg = JSON.parse(await readFile(paths.config, "utf8").catch(() => "{}"));
const blogs = JSON.parse(await readFile(paths.blogs, "utf8").catch(() => "{}"));
const key = cfg.active && blogs[cfg.active] ? cfg.active : Object.keys(blogs)[0];
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const LOG = path.join(paths.logs, `daily-${today}.log`);
const log = async (m) => { const line = `[${new Date().toISOString()}] ${m}\n`; await appendFile(LOG, line); process.stdout.write(line); };
if (!key) { await log("설정된 블로그가 없습니다 — 종료"); process.exit(0); }
const raw = blogs[key];
const blog = { key, postType: raw.postType || "info", label: raw.label || raw.blogId, blogId: raw.blogId, blogName: raw.blogName || raw.label || raw.blogId, topicDescription: raw.topicDescription, audience: raw.audience, siteUrl: raw.siteUrl, draftsDir: paths.drafts(key) };
ensureDirs(key);
if (blog.postType === "review" || blog.postType === "essay") { await log(`글 유형 "${blog.postType}"은 참고 메모가 필요해 자동 생성을 하지 않습니다. 발행기 원고 탭에서 메모와 함께 생성하세요.`); process.exit(0); }
const target = Number(cfg.dailyTarget) || 1;
const prev = await readFile(LOG, "utf8").catch(() => "");
const done = (prev.match(/RUN-DONE exit=0/g) || []).length;
if (done >= target) { await log(`오늘 목표 ${target}편 달성(${done}) — 종료`); process.exit(0); }

const env = { ...process.env, PATH: `${HOME}/.local/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`, LANG: "ko_KR.UTF-8" };
for (const k of Object.keys(env)) if (k.startsWith("CLAUDE") || k === "ANTHROPIC_BASE_URL" || k === "ANTHROPIC_AUTH_TOKEN") delete env[k];
try { const tok = (await readFile(paths.oauthToken, "utf8")).trim(); if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok; } catch { /* 없음 */ }

function runClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", prompt, "--output-format", "json", "--max-turns", "120", "--add-dir", APP_DIR, "--allowedTools", "Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"], { cwd: blog.draftsDir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: 124, out }); }, 45 * 60 * 1000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e.message) }); });
  });
}

await log(`RUN-START 오늘 ${done}/${target} — ${target - done}편 생성`);
for (let round = done + 1; round <= target; round += 1) {
  const existing = (await readdir(blog.draftsDir)).filter((f) => /^post-.*\.md$/.test(f)).join(", ");
  const prompt = await buildPrompt(blog, { extra: `## 자동 실행 주의\n- 오늘 이미 생성된 원고가 있을 수 있다(현재 큐: ${existing || "없음"}). 반드시 다른 주제를 고른다.` });
  let result = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    result = await runClaude(prompt);
    if (/Failed to authenticate|OAuth session expired|token has expired|Not logged in/.test(result.out)) { await log("AUTH-EXPIRED: 클로드 로그인 만료 — `claude auth login` 또는 설정 탭에 장기 토큰 저장 필요. 중단"); process.exit(3); }
    if (/"is_error":true/.test(result.out) && /Connection closed|api_error|ECONNRESET|fetch failed|ETIMEDOUT/.test(result.out)) { await log(`attempt ${attempt}: API 연결 오류 — 90초 후 재시도`); await new Promise((r) => setTimeout(r, 90000)); continue; }
    break;
  }
  let summary = ""; try { summary = String(JSON.parse(result.out).result || "").slice(0, 400); } catch { summary = result.out.slice(-400); }
  const ok = result.code === 0 && !/"is_error":true/.test(result.out);
  await log(`${summary.replace(/\n/g, " ")}`);
  await log(`RUN-DONE exit=${ok ? 0 : result.code} (round ${round})`);
  if (result.code === 124) break;
}
