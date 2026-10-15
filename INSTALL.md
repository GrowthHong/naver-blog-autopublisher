# 설치 매뉴얼 — 네이버 블로그 자동발행기

처음 설치하는 분 기준으로 씁니다. 터미널(맥) 또는 PowerShell(윈도우)에 명령을 **한 줄씩 복사해 붙여넣고 Enter**를 누르면 됩니다. 전체 30분 안팎, 대부분은 프로그램 설치 기다리는 시간입니다.

## 공통 — 먼저 알아둘 것

- 이 프로그램은 **내 컴퓨터에서만** 돌아갑니다. 어떤 서버에도 글이나 계정 정보를 보내지 않습니다.
- 네이버 글쓰기는 **내 크롬 브라우저**가 대신 입력하고, **[발행] 버튼은 내가 직접** 누릅니다.
- 원고는 **클로드(Claude)** 가 씁니다. 클로드 코드 CLI 로그인(유료 구독 또는 API 요금)이 필요하고, 한 편에 수 달러어치 사용량이 듭니다.
- 자동 작업(매일 06시 원고 생성 등)은 **컴퓨터가 켜져 있을 때만** 돕니다.
- 네이버는 자동 발행·자동 댓글·자동 이웃을 어뷰징으로 봅니다. 이 도구는 발행을 대신 누르지 않고 하루 상한과 보안문자 감지 중단이 들어 있지만, **계정에 대한 책임은 본인에게** 있습니다. 서로이웃은 하루 10~20건, 댓글은 10개 안팎을 권합니다.

필요한 프로그램 4가지:

| 프로그램 | 용도 | 꼭 필요? |
|---|---|---|
| Node.js (LTS) | 발행기 실행 | 필수 |
| 구글 크롬 | 네이버 에디터 자동 입력 | 필수 |
| 클로드 코드 CLI | 원고 생성 | 원고 생성 쓰려면 필수 |
| ffmpeg | 카드 이미지로 슬라이드 영상 | 선택 |

---

## A. 맥(macOS) 설치

### 1. 터미널 열기
Spotlight(⌘+Space)에서 "터미널" 입력 → 실행.

### 2. Node.js 설치
https://nodejs.org 에서 **LTS** 버튼을 눌러 내려받고 설치합니다. 끝나면 터미널을 **닫았다가 다시 열고** 확인:
```bash
node -v
```
`v20` 이상이 나오면 됩니다.

### 3. 구글 크롬 설치
이미 있으면 건너뜁니다. 없으면 https://www.google.com/chrome/ 에서 설치.

### 4. 클로드 코드 CLI 설치와 로그인
```bash
npm install -g @anthropic-ai/claude-code
```
```bash
claude
```
브라우저가 열리면 Anthropic 계정으로 로그인합니다. 터미널에 대화창이 뜨면 `/exit` 로 나옵니다.

### 5. 발행기 내려받기와 설치
```bash
cd ~ && git clone https://github.com/GrowthHong/naver-blog-autopublisher.git
```
`git`이 없다고 나오면 화면의 안내대로 명령어 도구를 설치한 뒤 다시 실행합니다. 그다음:
```bash
cd ~/naver-blog-autopublisher && zsh install.sh
```
"✓ 설치 완료"가 나오면 됩니다. 빠진 프로그램이 있으면 `!` 표시로 알려줍니다.

### 6. 실행
```bash
cd ~/naver-blog-autopublisher && npm start
```
터미널에 주소가 뜨면 크롬에서 **http://localhost:5071** 을 엽니다. 이 터미널 창은 쓰는 동안 닫지 않습니다(닫으면 발행기가 꺼집니다. 다시 켤 때는 이 명령을 다시 실행).

### 7. 첫 설정 (브라우저에서)
1. **설정 탭** — 네이버 블로그 아이디, 블로그 이름, **글 유형**, 주제 설명을 적고 [블로그 설정 저장]
2. **[네이버 로그인 창 열기]** — 새 크롬 창이 뜨면 네이버에 로그인합니다. **"로그인 상태 유지"를 꼭 체크**하세요. 이 크롬은 발행기 전용이라 평소 쓰는 크롬과 별개입니다. 로그인 후 창은 그대로 두거나 닫아도 됩니다.
3. **원고 탭** → [새 원고 생성] → 3~8분 뒤 원고가 목록에 뜹니다.
4. 원고를 누르고 → [자동 입력] → 크롬에 글이 들어가고 발행 창에 예약 시각까지 채워집니다 → 내용 확인 후 **네이버의 [발행]** 클릭 → 발행기로 돌아와 [발행 완료 처리].

### 8. 자동 작업 등록 (선택)
```bash
cd ~/naver-blog-autopublisher && npm run schedule
```
매일 06:00 원고 생성, 08:10 통계, 하루 4번 색인 확인, 10·20시 받은 이웃 수락, 월요일 순위 측정이 등록됩니다. 해제는 `npm run schedule -- --remove`.
잠자기 상태면 안 돌고 깨어나면 밀린 작업을 합니다. 06시 정시를 원하면:
```bash
sudo pmset repeat wakeorpoweron MTWRFSU 05:58:00
```

---

## B. 윈도우(Windows 10/11) 설치

### 1. PowerShell 열기
시작 메뉴에서 "PowerShell" 검색 → **Windows PowerShell** 실행(관리자 권한 불필요).

### 2. Node.js 설치
https://nodejs.org 에서 **LTS**를 내려받아 설치합니다. 설치 화면은 전부 기본값(Next)으로 진행. 끝나면 PowerShell을 **닫았다가 다시 열고** 확인:
```powershell
node -v
```
`v20` 이상이면 됩니다.

### 3. Git 설치
https://git-scm.com/download/win 에서 설치(전부 기본값). PowerShell을 다시 열고:
```powershell
git --version
```

### 4. 구글 크롬 설치
이미 있으면 건너뜁니다. 없으면 https://www.google.com/chrome/

### 5. 클로드 코드 CLI 설치와 로그인
```powershell
npm install -g @anthropic-ai/claude-code
```
```powershell
claude
```
브라우저가 열리면 Anthropic 계정으로 로그인합니다. 대화창이 뜨면 `/exit` 로 나옵니다.

### 6. 발행기 내려받기와 설치
```powershell
cd ~ ; git clone https://github.com/GrowthHong/naver-blog-autopublisher.git
```
```powershell
cd ~\naver-blog-autopublisher ; powershell -ExecutionPolicy Bypass -File install.ps1
```
"✓ 설치 완료"가 나오면 됩니다.

### 7. 실행
```powershell
cd ~\naver-blog-autopublisher ; npm start
```
크롬에서 **http://localhost:5071** 을 엽니다. 이 PowerShell 창은 쓰는 동안 닫지 않습니다.

### 8. 첫 설정
맥 7번과 같습니다. 설정 탭 저장 → [네이버 로그인 창 열기]에서 로그인("로그인 상태 유지" 체크) → 원고 탭 [새 원고 생성] → [자동 입력] → 네이버 [발행] → [발행 완료 처리].

### 9. 자동 작업 등록 (선택)
```powershell
cd ~\naver-blog-autopublisher ; npm run schedule
```
작업 스케줄러에 `BlogAutopublisher-*` 5개가 등록됩니다. 해제는 `npm run schedule -- --remove`. PC가 켜져 있어야 돌고, 절전 중이면 깨어난 뒤 실행됩니다.

---

## C. 자주 막히는 곳

| 증상 | 원인·해결 |
|---|---|
| `node`, `git`, `claude`를 찾을 수 없다고 함 | 설치 뒤 터미널/PowerShell을 **다시 열지 않아서**입니다. 닫고 다시 여세요. |
| 윈도우에서 "스크립트 실행이 비활성화" 오류 | 명령 앞에 `powershell -ExecutionPolicy Bypass -File` 를 붙여 실행하세요(위 명령 그대로). |
| 브라우저에서 localhost:5071 이 안 열림 | `npm start` 한 터미널이 꺼졌거나, 다른 프로그램이 5071 포트를 씁니다. 터미널을 확인하고, 겹치면 `PORT=5080 npm start`(윈도우: `$env:PORT=5080; npm start`) 로 바꿔 실행. |
| [새 원고 생성]이 "로그인이 만료" 라고 함 | 터미널에서 `claude` 를 다시 실행해 로그인. 자주 그러면 `claude setup-token` 결과를 설정 탭 "클로드 장기 토큰"에 저장. |
| 자동 입력 때 네이버 로그인 창이 뜸 | 발행기 전용 크롬의 로그인이 풀린 것. 설정 탭 [네이버 로그인 창 열기]에서 다시 로그인("로그인 상태 유지"). |
| 자동 입력이 중간에 멈춤 | 네이버 에디터 구조가 바뀌었을 수 있습니다. 원고 탭 [원고 텍스트 복사]로 직접 붙여넣고, GitHub 이슈로 알려주세요. |
| 서로이웃 신청이 "거부됨"으로 멈춤 | 네이버가 그 계정의 서로이웃 신청을 일시 제한한 상태. 며칠 쉬고 하루 10건 이하로. |

## D. 데이터와 삭제
- 모든 데이터는 `~/.blog-autopublisher`(윈도우: `C:\Users\<이름>\.blog-autopublisher`)에 있습니다. 원고·이미지·기록·크롬 로그인 세션이 전부 여기입니다.
- 프로그램을 지우려면 자동 작업 해제(`npm run schedule -- --remove`) 후 `naver-blog-autopublisher` 폴더와 `.blog-autopublisher` 폴더를 지우면 끝입니다.
