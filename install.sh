#!/bin/zsh
# 네이버 블로그 자동발행기 설치 (macOS). 사용: zsh install.sh
set -e
cd "$(dirname "$0")"
echo "▶ 필요한 것 확인"
command -v node >/dev/null || { echo "✗ Node.js가 없습니다. https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행하세요."; exit 1; }
[ -d "/Applications/Google Chrome.app" ] || echo "! 구글 크롬이 없습니다. 자동 입력에는 크롬이 필요합니다: https://www.google.com/chrome/"
command -v claude >/dev/null || echo "! 클로드 코드 CLI가 없습니다. 원고 생성에 필요합니다: npm install -g @anthropic-ai/claude-code  → claude 로 로그인"
command -v ffmpeg >/dev/null || echo "! ffmpeg가 없으면 슬라이드 영상 없이 올라갑니다(선택): brew install ffmpeg"
echo "▶ 패키지 설치"; npm install --no-audit --no-fund
DATA="${BAP_HOME:-$HOME/.blog-autopublisher}"; mkdir -p "$DATA"
echo ""
echo "✓ 설치 완료. 실행:  npm start   → 브라우저에서 http://localhost:5071 을 열고 설정 탭부터 채우세요."
echo "  자동 작업(매일 원고 생성 등) 등록:  zsh scripts/install-schedule.sh"
