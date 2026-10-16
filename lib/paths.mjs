// 모든 파일 위치는 여기서만 정한다. 데이터 폴더는 ~/.blog-autopublisher (환경변수 BAP_HOME으로 바꿀 수 있음)
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.BAP_HOME || path.join(os.homedir(), ".blog-autopublisher");

export const paths = {
  config: path.join(DATA_DIR, "config.json"),       // 전역 설정 (예약 시각·생성 편수·상한)
  blogs: path.join(DATA_DIR, "blogs.json"),         // 블로그별 설정 (아이디·주제·독자·검색어)
  logs: path.join(DATA_DIR, "logs"),
  state: (name) => path.join(DATA_DIR, "state", `${name}.json`), // 댓글·수락·통계·예약 기록
  reports: path.join(DATA_DIR, "reports"),
  oauthToken: path.join(DATA_DIR, "oauth-token"),   // claude setup-token 결과 (선택)
  searchad: path.join(DATA_DIR, "searchad.json"),   // 네이버 검색광고 API 키 (선택)
  openapi: path.join(DATA_DIR, "naver-openapi.json"), // 네이버 검색 API 키 — NAVER API HUB {keyId,key} (선택)
  blogDir: (key) => path.join(DATA_DIR, "blogs", key),
  drafts: (key) => path.join(DATA_DIR, "blogs", key, "drafts"),
  images: (key) => path.join(DATA_DIR, "blogs", key, "drafts", "images"),
  published: (key) => path.join(DATA_DIR, "blogs", key, "drafts", "published"),
  profile: (key) => path.join(DATA_DIR, "chrome-profiles", key),
  scripts: path.join(APP_DIR, "scripts"),
  prompts: path.join(APP_DIR, "prompts"),
};

export function ensureDirs(blogKey) {
  for (const d of [DATA_DIR, paths.logs, path.join(DATA_DIR, "state"), paths.reports, path.join(DATA_DIR, "chrome-profiles")]) mkdirSync(d, { recursive: true });
  if (blogKey) for (const d of [paths.drafts(blogKey), paths.images(blogKey), paths.published(blogKey), paths.profile(blogKey)]) mkdirSync(d, { recursive: true });
}
