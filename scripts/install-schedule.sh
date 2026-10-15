#!/bin/zsh
# macOS launchd에 자동 작업 등록: 원고 생성(06:00), 통계 수집(08:10), 색인 확인(09·13·18·22시), 받은 이웃 수락(10·20시), 순위 측정(월 07:30)
# 사용: zsh scripts/install-schedule.sh        해제: zsh scripts/install-schedule.sh --remove
set -e
APP="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${BAP_HOME:-$HOME/.blog-autopublisher}"
mkdir -p "$DATA/logs" "$HOME/Library/LaunchAgents"
NODE_BIN="$(dirname "$(command -v node)")"
make_plist() { # label, calendar(xml), script
  local label="$1" cal="$2" script="$3" f="$HOME/Library/LaunchAgents/$1.plist"
  cat > "$f" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-c</string><string>export PATH=$NODE_BIN:\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH; export BAP_HOME=$DATA; cd $APP && node $script >> $DATA/logs/$label.log 2>&1</string></array>
  <key>StartCalendarInterval</key>$cal
  <key>RunAtLoad</key><false/>
</dict></plist>
PL
  launchctl unload "$f" 2>/dev/null || true
  [ "$REMOVE" = "1" ] && { rm -f "$f"; echo "해제: $label"; return; }
  launchctl load "$f" && echo "등록: $label"
}
[ "$1" = "--remove" ] && REMOVE=1 || REMOVE=0
make_plist com.blog-autopublisher.generate '<dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>' scripts/daily-generate.mjs
make_plist com.blog-autopublisher.stats '<dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>10</integer></dict>' scripts/stats-run.mjs
make_plist com.blog-autopublisher.index '<array><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict><dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict><dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict><dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict></array>' scripts/index-check.mjs
make_plist com.blog-autopublisher.accept '<array><dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict><dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict></array>' scripts/accept-run.mjs
make_plist com.blog-autopublisher.rank '<dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>' scripts/rank-check.mjs
echo "완료. 맥이 켜져 있어야 돌아갑니다. 06시 정시 실행을 원하면: sudo pmset repeat wakeorpoweron MTWRFSU 05:58:00"
