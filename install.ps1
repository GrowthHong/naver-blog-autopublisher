# 네이버 블로그 자동발행기 설치 (윈도우). PowerShell에서:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host "▶ 필요한 것 확인"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "✗ Node.js가 없습니다. https://nodejs.org 에서 LTS를 설치한 뒤 PowerShell을 다시 열고 실행하세요."; exit 1 }
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ }
if (-not $chrome) { Write-Host "! 구글 크롬이 없습니다. 자동 입력에는 크롬이 필요합니다: https://www.google.com/chrome/" }
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host "! 클로드 코드 CLI가 없습니다. 원고 생성에 필요합니다:  npm install -g @anthropic-ai/claude-code   그다음 PowerShell에서 claude 실행해 로그인" }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Write-Host "! ffmpeg가 없으면 슬라이드 영상 없이 올라갑니다(선택): winget install ffmpeg" }
Write-Host "▶ 패키지 설치"; npm install --no-audit --no-fund
$Data = if ($env:BAP_HOME) { $env:BAP_HOME } else { Join-Path $env:USERPROFILE ".blog-autopublisher" }
New-Item -ItemType Directory -Force -Path $Data | Out-Null
Write-Host ""
Write-Host "✓ 설치 완료. 실행:  npm start   → 브라우저에서 http://localhost:5071 을 열고 설정 탭부터 채우세요."
Write-Host "  자동 작업 등록:  npm run schedule"
