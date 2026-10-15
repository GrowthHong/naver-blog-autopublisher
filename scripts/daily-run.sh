#!/bin/zsh
# 매일 06:00 (launchd, 12·19시 보충) — 혜택수첩 사이트 글 + 블로그 원고 세트를 하루 TARGET편 생성.
# 한 편씩 독립 세션으로 순차 실행(앞 회차 결과를 보고 다음 주제 선택). 성공 횟수를 세어 모자란 만큼만 돈다.
# 작업 폴더는 자동화 전용 클론 ~/hyetaek/site (배경 작업은 ~/Documents·~/Desktop 접근 불가).
export PATH="$HOME/.local/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export LANG=ko_KR.UTF-8
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/usr/bin/false   # 자격증명 없으면 즉시 실패 (프롬프트 대기로 멈추는 것 방지)
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDECODE
for v in ${(k)parameters}; do [[ $v == CLAUDE_CODE_* ]] && unset $v; done
# 장기 토큰(claude setup-token)이 있으면 CLI 로그인 세션과 무관하게 동작
[ -s "$HOME/.hyetaek/oauth-token" ] && export CLAUDE_CODE_OAUTH_TOKEN="$(tr -d '[:space:]' < "$HOME/.hyetaek/oauth-token")"

WORK="$HOME/hyetaek/site"
REMOTE="https://github.com/GrowthHong/benefit-notebook-5060.git"
SKILL="$HOME/.claude/scheduled-tasks/hyetaek-blog-draft/SKILL.md"
LOG="$HOME/.hyetaek/logs/daily-$(date +%F).log"
LOCK="$HOME/.hyetaek/logs/.running"
TARGET=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.hyetaek/config.json'))).get('dailyTarget',3))" 2>/dev/null || echo 3)   # 발행기 설정 탭 "하루 생성 편수"

echo "===== RUN-START $(date) =====" >> "$LOG"
DONE=$(grep -c "RUN-DONE exit=0" "$LOG" 2>/dev/null); DONE=${DONE:-0}
if [ "$DONE" -ge "$TARGET" ]; then echo "오늘 목표 ${TARGET}편 달성(${DONE}) — 종료" >> "$LOG"; exit 0; fi
if [ -f "$LOCK" ] && [ $(( $(date +%s) - $(stat -f %m "$LOCK") )) -lt 5400 ]; then echo "실행 중 락 존재 — 종료" >> "$LOG"; exit 0; fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

mkdir -p "$HOME/hyetaek"
if [ ! -d "$WORK/.git" ]; then
  echo "전용 클론 생성" >> "$LOG"
  git clone -q "$REMOTE" "$WORK" >> "$LOG" 2>&1 || { echo "클론 실패(인증?)" >> "$LOG"; echo "===== RUN-DONE exit=3 $(date) =====" >> "$LOG"; exit 3; }
fi
cd "$WORK"
git config user.name "GrowthHong"; git config user.email "93091000+GrowthHong@users.noreply.github.com"  # Vercel은 다른 작성자 커밋을 차단
# 로컬 커밋 보존: reset --hard 금지. 못 올린 커밋이 있으면 먼저 푸시, 그다음 autostash rebase
git push -q origin main >> "$LOG" 2>&1 || true
git pull -q --rebase --autostash origin main >> "$LOG" 2>&1 || echo "pull 실패(오프라인/인증) — 로컬 상태로 진행" >> "$LOG"
[ -d node_modules ] || npm ci --no-audit --no-fund >> "$LOG" 2>&1

# 실행 중 절전 금지 + 네트워크 준비 대기(최대 5분)
caffeinate -i -w $$ &
for i in $(seq 1 30); do curl -s -m 5 -o /dev/null https://api.anthropic.com && break; sleep 10; done

PROMPT=$(python3 - "$SKILL" "$WORK" << 'PY'
import re,sys
s=open(sys.argv[1],encoding='utf-8').read(); work=sys.argv[2]
s=re.sub(r'^---[\s\S]*?---\s*','',s).strip()
s=s.replace('~/Documents/5060생활정보웹사이트', work)
s+=f"""

## 이번 실행 환경 주의 (자동 실행)
- 현재 작업 폴더는 {work} (저장소 루트). ~/Desktop 아래 blog-publisher 폴더에는 접근할 수 없다.
- 카드 이미지는 PNG 렌더가 불가하므로 **SVG 파일로만** docs/naver-blog/images/ 에 저장한다(규격은 위와 동일). 원고 본문에는 .png 이름으로 참조해도 된다(발행기가 SVG를 찾아 PNG로 변환함).
- 블로그 원고 검사기는 scripts/blog-seo-rules.mjs 를, 문체 검사기는 ~/growketer/style-check.mjs 를 node로 실행한다.
- 오늘 이미 생성된 글이 있을 수 있다 — docs/naver-blog/post-*.md 와 seo-keyword-map.md 끝의 오늘 날짜 기록을 반드시 확인해 **다른 주제**를 고른다.
- 완료 후 `git push origin main` 까지 시도하고 결과(성공/실패 사유)를 보고에 적는다. 푸시 실패는 글 실패가 아니다 — 커밋은 남긴다."""
print(s)
PY
)

# 45분 타임아웃
run_claude() {
  local out="$1"
  claude -p "$PROMPT" --output-format json --max-turns 150 \
    --allowedTools Read Write Edit Glob Grep Bash WebSearch WebFetch > "$out" 2>&1 < /dev/null &
  local cpid=$!
  for i in $(seq 1 270); do sleep 10; kill -0 $cpid 2>/dev/null || break; done
  if kill -0 $cpid 2>/dev/null; then echo "TIMEOUT 45min — kill" >> "$LOG"; kill $cpid 2>/dev/null; sleep 3; kill -9 $cpid 2>/dev/null; return 124; fi
  wait $cpid
}

NEED=$((TARGET - DONE))
echo "오늘 ${DONE}/${TARGET} 완료 — ${NEED}편 생성 시작" >> "$LOG"
STOP=0
for round in $(seq 1 $NEED); do
  echo "----- ROUND $round/$NEED $(date +%H:%M) -----" >> "$LOG"
  RC=1; ERR=""
  for attempt in 1 2 3; do
    TMP="$LOG.r${round}.attempt$attempt"
    run_claude "$TMP"; RC=$?
    cat "$TMP" >> "$LOG"
    if grep -qE 'Failed to authenticate|OAuth session expired|token has expired|Not logged in' "$TMP"; then
      echo "AUTH-EXPIRED: 클로드 CLI 로그인 만료 — claude auth login 또는 setup-token 필요. 중단" >> "$LOG"
      date > "$HOME/.hyetaek/logs/AUTH-EXPIRED"; rm -f "$TMP"; RC=3; STOP=1; break
    fi
    if grep -q '"is_error":true' "$TMP"; then
      if grep -qE 'Connection closed|api_error|ECONNRESET|fetch failed|ETIMEDOUT' "$TMP"; then
        echo "attempt $attempt: API 연결 오류 — 90초 후 재시도" >> "$LOG"; rm -f "$TMP"; RC=1; sleep 90; continue
      fi
      ERR="is_error"; rm -f "$TMP"; break
    fi
    rm -f "$TMP"; rm -f "$HOME/.hyetaek/logs/AUTH-EXPIRED"; break
  done
  if [ "$RC" -eq 0 ] && [ -z "$ERR" ]; then
    echo "===== RUN-DONE exit=0 $(date) (round $round) =====" >> "$LOG"
  else
    echo "===== RUN-DONE exit=${RC} $(date) (round $round 실패 ${ERR}) =====" >> "$LOG"
    [ "$RC" -eq 124 ] && STOP=1
  fi
  git push -q origin main >> "$LOG" 2>&1 || true
  [ "$STOP" -eq 1 ] && break
  sleep 20
done
