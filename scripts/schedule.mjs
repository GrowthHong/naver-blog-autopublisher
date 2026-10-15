// 자동 작업 등록: 맥은 launchd(install-schedule.sh), 윈도우는 작업 스케줄러(schedule.ps1)
// 사용: npm run schedule        해제: npm run schedule -- --remove
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const remove = process.argv.includes("--remove");
let r;
if (process.platform === "darwin") r = spawnSync("zsh", [path.join(here, "install-schedule.sh"), ...(remove ? ["--remove"] : [])], { stdio: "inherit" });
else if (process.platform === "win32") r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "schedule.ps1"), ...(remove ? ["-Remove"] : [])], { stdio: "inherit" });
else { console.log("리눅스는 cron에 직접 등록하세요 (예: 0 6 * * * cd <앱폴더> && node scripts/daily-generate.mjs)"); process.exit(0); }
process.exit(r.status ?? 1);
