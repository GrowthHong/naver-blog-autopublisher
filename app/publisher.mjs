// 사장님의 실제 크롬(로그인 세션 유지)을 열어 네이버 블로그 에디터에 제목·본문을 자동 입력한다.
// 발행 버튼은 절대 자동으로 누르지 않는다 — 사람이 확인 후 클릭 (반자동 원칙).
import { chromium } from "playwright-core";
import { buildSlideshow } from "./video.mjs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { paths } from "../lib/paths.mjs";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const contexts = new Map(); // 프로필명 → 크롬 컨텍스트 (블로그 계정마다 별도 프로필 = 별도 네이버 로그인)

function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = execFile("pbcopy", (error) => (error ? reject(error) : resolve()));
    child.stdin.end(text);
  });
}

export async function getBrowser(profile = "chrome-profile") {
  const existing = contexts.get(profile);
  if (existing) {
    try {
      existing.pages(); // 살아있는지 확인
      return existing;
    } catch {
      contexts.delete(profile);
    }
  }
  const context = await chromium.launchPersistentContext(path.isAbsolute(profile) ? profile : paths.profile(profile), {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  context.on("close", () => contexts.delete(profile));
  contexts.set(profile, context);
  return context;
}

// 서로이웃 신청 폼을 직접 연다 (데스크톱 이웃추가는 팝업이라 자동화 크롬에서 차단될 수 있음)
// 서로이웃 라디오 선택 + 메시지 입력까지 자동. autoSubmit=true면 [확인]까지 누르고 창을 닫는다.
// 보안문자·이용 제한이 감지되면 fatal로 보고하고 그 즉시 멈춘다 — 우회는 하지 않는다.
async function buddyForm(blogId, message, { autoSubmit = false, profile } = {}) {
  const browser = await getBrowser(profile);
  const page = await browser.newPage();
  const finish = async (result) => {
    if (autoSubmit) await page.close().catch(() => {});
    return result;
  };
  try {
    // returnUrl은 네이버 스크립트가 신청 요청(BothBuddyInviteCompleteAsync)에 그대로 실어 보내는 필수 파라미터 —
    // 블로그 화면에서 [이웃추가]를 누르면 자동으로 붙지만, 폼 URL을 직접 열면 빠져서 "잘못된 요청(invalid_parameter)"이 난다 (2026-10 확인)
    const returnUrl = encodeURIComponent(`https://m.blog.naver.com/${blogId}`);
    await page.goto(`https://m.blog.naver.com/BuddyAddForm.naver?blogId=${encodeURIComponent(blogId)}&mobileBuddyAddMessageType=1&returnUrl=${returnUrl}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    if (!autoSubmit) await page.bringToFront();
    // 폼 요소가 렌더될 때까지 대기 (고정 대기는 느린 로딩에서 자동 입력 실패의 원인이었다)
    await page.waitForSelector("textarea, input[type=radio], form", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);

    if (page.url().includes("nid.naver.com")) {
      return finish({ ok: false, fatal: true, message: "네이버 로그인이 필요합니다. [네이버 로그인 창]에서 로그인 후 다시 시도하세요." });
    }

    const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
    if (/보안문자|자동입력 방지|일시적으로 제한|이용이 제한/.test(bodyText)) {
      return finish({ ok: false, fatal: true, message: "네이버가 자동화 의심 제한을 걸었습니다. 오늘은 여기서 중단합니다 — 계속하면 계정이 위험합니다." });
    }
    if (/서로이웃.*(받지 않|신청.*불가)/.test(bodyText)) {
      return finish({ ok: false, skip: true, message: "서로이웃 신청을 받지 않는 블로그" });
    }
    if (/이미 (이웃|신청)/.test(bodyText)) {
      return finish({ ok: false, skip: true, message: "이미 이웃이거나 신청 대기 중" });
    }

    let prefilled = false;
    let debug = null;
    try {
      const mutual = page
        .locator(
          'label:has-text("서로이웃"), input[type=radio][value*="both" i], input[type=radio][id*="both" i], input[type=radio][value*="mutual" i], input[type=radio][id*="mutual" i], #bothBuddyRadio',
        )
        .first();
      await mutual.click({ timeout: 4000 });
      if (message) {
        const memo = page.locator("textarea").first();
        await memo.click({ timeout: 3000 });
        await memo.fill(message);
      }
      prefilled = true;
    } catch {
      // 실패 원인 파악용: 폼에 실제로 뭐가 있는지 돌려준다
      debug = await page
        .evaluate(() => ({
          url: location.href,
          radios: [...document.querySelectorAll("input[type=radio]")].map((r) => ({ id: r.id, value: r.value, label: r.labels?.[0]?.innerText?.trim() })),
          textareas: document.querySelectorAll("textarea").length,
          labels: [...document.querySelectorAll("label")].map((l) => l.innerText.trim()).filter(Boolean).slice(0, 10),
          text: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
        }))
        .catch(() => null);
      if (message) await copyToClipboard(message).catch(() => {}); // 사람이 붙여넣을 수 있게
    }

    if (!autoSubmit) {
      return {
        ok: true,
        prefilled,
        debug,
        message: prefilled
          ? "서로이웃 선택과 메시지 입력까지 끝났습니다. 열린 창에서 내용 확인 후 [확인]만 눌러주세요."
          : "신청 폼을 열었습니다. 서로이웃 선택 후 메시지를 붙여넣고(클립보드에 복사됨) [확인]을 눌러주세요.",
      };
    }

    if (!prefilled) return finish({ ok: false, skip: true, message: "폼 자동 입력 실패 — 반자동으로 시도하세요" });

    await page.locator('button:has-text("확인"), a:has-text("확인"), button[type="submit"]').first().click({ timeout: 4000 });
    await page.waitForTimeout(2000);
    const after = (await page.locator("body").innerText().catch(() => "")) ?? "";
    if (/보안문자|자동입력 방지|제한|초과/.test(after)) {
      return finish({ ok: false, fatal: true, message: "신청 단계에서 제한이 감지되어 중단합니다." });
    }
    if (/페이지를 불러오는 중에 오류|잘못된 요청/.test(after)) {
      // 2026-10-09 확인: 같은 세션·같은 폼에서 일반 이웃추가는 되고 서로이웃 신청만 invalid_parameter → 계정 단위 서로이웃 신청 제한.
      // 후보를 계속 소진하면 제한이 길어질 수 있어 즉시 멈춘다.
      return finish({ ok: false, fatal: true, message: "네이버가 이 계정의 서로이웃 신청을 거부하고 있습니다(일반 이웃추가는 됨 → 서로이웃 신청 제한 상태). 며칠 쉬었다가 다시 시도하세요. 그동안은 [댓글] 탭을 쓰세요." });
    }
    const formGone = (await page.locator("textarea").count().catch(() => 0)) === 0;
    if (/신청.*완료|신청되었|신청을 보냈/.test(after) || formGone) {
      return finish({ ok: true, message: "신청 완료" });
    }
    return finish({ ok: false, skip: true, message: "결과 확인 불가 — 수동 확인 필요" });
  } catch (error) {
    return finish({ ok: false, skip: true, message: `오류: ${String(error?.message ?? error).slice(0, 80)}` });
  }
}

export async function openBlog(blogId, message, profile) {
  return buddyForm(blogId, message, { autoSubmit: false, profile });
}

export async function autoBuddyRequest(blogId, message, profile) {
  return buddyForm(blogId, message, { autoSubmit: true, profile });
}

// 서버 종료 시 크롬을 정상 종료 — 강제 종료되면 네이버 로그인 세션 쿠키가 유실된다
export async function closeBrowser() {
  const all = [...contexts.values()];
  contexts.clear();
  await Promise.all(all.map((c) => c.close().catch(() => {})));
}

export async function openLogin(profile) {
  const browser = await getBrowser(profile);
  const page = browser.pages()[0] ?? (await browser.newPage());
  await page.goto("https://nid.naver.com/nidlogin.login", { waitUntil: "domcontentloaded" });
  return { ok: true, message: "브라우저에서 직접 로그인해 주세요. 로그인 상태는 다음부터 유지됩니다." };
}

async function dismissDraftPopup(frame) {
  // "작성 중인 글 이어쓰기" 등 se-popup 계열 팝업을 전부 닫는다 (취소 = 새 글로 시작)
  // 팝업이 늦게 뜨거나 연달아 뜰 수 있어 최대 8초 동안 반복 처리
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const popup = frame.locator(".se-popup, .se-popup-alert-confirm").first();
    if ((await popup.count()) === 0 || !(await popup.isVisible().catch(() => false))) {
      await frame.page().waitForTimeout(400);
      // 팝업이 완전히 사라졌으면 종료 (dim 레이어 기준)
      if ((await frame.locator(".se-popup-dim").count()) === 0) return;
      continue;
    }
    const cancel = frame
      .locator(".se-popup button.se-popup-button-cancel, .se-popup button:has-text('취소')")
      .first();
    if ((await cancel.count()) > 0) {
      await cancel.click({ timeout: 2000 }).catch(() => {});
    } else {
      // 취소 버튼이 없는 안내 팝업이면 닫기/확인으로 처리
      await frame
        .locator(".se-popup button.se-popup-close-button, .se-popup button:has-text('확인')")
        .first()
        .click({ timeout: 2000 })
        .catch(() => {});
    }
    await frame.page().waitForTimeout(500);
  }
}

// 원고 서식 규칙 → HTML 변환
// "## 제목"=소제목, "> 문장"=인용구, "---"=구분선, "**굵게**"=강조,
// "- 항목"=체크리스트(✓), "![설명](파일명.png)"=이미지(원고 폴더의 images/ 안 파일)
// 네이버 SmartEditor는 HTML 붙여넣기를 자기 서식(소제목·인용구·구분선·목록)으로 변환한다
import { readFile as readFileAsync } from "node:fs/promises";

const escapeHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// 가독성 테마 — 블로그별 강조색 (fillEditor 호출 시 theme으로 교체)
let THEME = { heading: "#0f4c5c", number: "#b91c1c", bar: "#155e75" };
export function setTheme(theme) { THEME = { ...THEME, ...(theme ?? {}) }; }
// 금액·날짜·비율·나이 같은 핵심 숫자는 자동으로 빨간 굵게 — 어르신이 훑어도 숫자가 먼저 보이게
const NUMBER = /(\d[\d,.]*\s?(?:만 ?원|천 ?원|원|%|퍼센트|세|월|일|개월|년|명|배|시간|분|회|건|장|개|칸|단계))/g;
const highlightNumbers = (html) =>
  html.split(/(<[^>]+>)/).map((seg) => (seg.startsWith("<") ? seg : seg.replace(NUMBER, (m) => `<span style="color: ${THEME.number};"><b>${m}</b></span>`))).join("");
const inline = (t) => {
  const urls = [];
  let h = escapeHtml(t).replace(/https?:\/\/[^\s<)"']+/g, (url) => { urls.push(url); return `\u0000${urls.length - 1}\u0000`; });
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = highlightNumbers(h);
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<a href="${urls[i]}" target="_blank">${urls[i]}</a>`);
};
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)]+)\)$/;

export async function buildBodyHtml(body, imagesDir) {
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const images = []; // { alt, file, path }
  const htmlParts = [];
  // 입력 순서 계획: html 덩어리와 이미지를 원고 순서대로 번갈아 처리한다
  const parts = []; // { type: "html", html } | { type: "image", ...images[i] }
  const GAP = "<p><br></p>"; // 네이버 에디터에서 문단 사이 빈 줄 — 다닥다닥 방지
  const pushHtml = (fragment) => {
    htmlParts.push(fragment);
    const last = parts[parts.length - 1];
    if (last && last.type === "html") last.html += `\n${GAP}\n${fragment}`;
    else parts.push({ type: "html", html: fragment });
  };
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    const imageMatch = block.match(IMAGE_LINE);
    if (imageMatch && imagesDir) {
      const [, alt, file] = imageMatch;
      let filePath = path.join(imagesDir, path.basename(file));
      try {
        // PNG가 없고 SVG만 있으면(클라우드 생성분 — 클라우드엔 크롬이 없음) 여기서 PNG로 렌더
        const svgPath = filePath.replace(/\.(png|svg)$/i, ".svg");
        const pngPath = filePath.replace(/\.(png|svg)$/i, ".png");
        const exists = (f) => readFileAsync(f).then(() => true, () => false);
        if (!(await exists(pngPath)) && (await exists(svgPath))) {
          const b = await chromium.launch({ channel: "chrome", headless: true });
          const pg = await b.newPage({ viewport: { width: 1000, height: 750 } });
          await pg.goto(`file://${svgPath}`);
          await pg.screenshot({ path: pngPath });
          await b.close();
        }
        filePath = pngPath;
        await readFileAsync(filePath); // 존재 확인
        const image = { alt, file: path.basename(pngPath), path: filePath };
        images.push(image);
        parts.push({ type: "image", ...image });
      } catch {
        /* 이미지 파일 없으면 건너뜀 */
      }
      continue;
    }
    if (lines.every((l) => l.startsWith("- "))) {
      // 체크리스트: ul 불릿과 겹치지 않게 ✅ 문단으로 (한 줄 간격 유지)
      pushHtml(lines.map((l) => {
        const item = l.slice(2);
        const m = item.match(/^([^,(—]{4,28})(.*)$/);
        return `<p>✅ ${m ? `<b>${inline(m[1])}</b>${inline(m[2])}` : inline(item)}</p>`;
      }).join("\n"));
      continue;
    }
    const text = block.replace(/\n/g, " ");
    // 일반 문단: 블록 안의 줄바꿈은 "붙어 있는 줄"(빈 줄 없이), 블록 사이에만 GAP — 사람이 쓴 네이버 글의 리듬
    if (!/^(---+|##\s|■\s|>\s)/.test(block) && lines.length > 1) {
      pushHtml(lines.map((l) => `<p>${inline(l)}</p>`).join("\n"));
      continue;
    }
    // 소제목: h태그는 굵기만 남고 크기가 무시되어 폰트 크기를 직접 지정 (에디터 24px 단계로 매핑)
    // 소제목: 크기 + 블로그 강조색 + 앞 막대(▎) — 스크롤하며 훑을 때 구획이 보이게
    const heading = (t) => `<p><span style="font-size: 24px; color: ${THEME.heading};"><b>▎ ${escapeHtml(t.replace(/\*\*/g, ""))}</b></span></p>`;
    if (/^---+$/.test(block)) pushHtml("<hr>");
    else if (text.startsWith("## ")) pushHtml(heading(text.slice(3)));
    else if (text.startsWith("■ ")) pushHtml(heading(text.slice(2)));
    else if (text.startsWith("> ")) pushHtml(`<blockquote><b><span style="color: ${THEME.heading};">${inline(text.slice(2))}</span></b></blockquote>`);
    else pushHtml(`<p>${inline(text)}</p>`);
  }
  // 사람이 직접 붙여넣을 때 쓸 일반 텍스트 (서식 기호 제거, 이미지는 안내로 대체)
  const plain = blocks
    .map((b) => {
      const img = b.match(IMAGE_LINE);
      if (img) return `[사진: ${img[1]} — images/${img[2]}]`;
      return b
        .split("\n")
        .map((l) => l.trim().replace(/^- /, "✅ ").replace(/^(##|■|>)\s*/, ""))
        .join("\n")
        .replace(/^---+$/, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1");
    })
    .filter(Boolean)
    .join("\n\n");
  return { html: htmlParts.join(`\n${GAP}\n`), plain, images, parts };
}

export async function fillEditor({ blogId, title, body, imagesDir, profile, theme, video = true, publish = null }) {
  setTheme(theme);
  const { plain, images, parts } = await buildBodyHtml(body, imagesDir);
  // 실패해도 사람이 이어갈 수 있도록, 전체 원고를 항상 클립보드에 복사해 둔다
  await copyToClipboard(`${title}\n\n${plain}`);

  const browser = await getBrowser(profile);
  const page = await browser.newPage();
  await page.goto(`https://blog.naver.com/${blogId}/postwrite`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  // 로그인 페이지로 튕겼는지 확인
  if (page.url().includes("nid.naver.com")) {
    return { ok: false, stage: "login", message: "네이버 로그인이 필요합니다. 열린 창에서 로그인 후 다시 시도하세요." };
  }

  // 에디터는 iframe(mainFrame) 안일 수도, 아닐 수도 있다
  const frames = [page.mainFrame(), ...page.frames()];
  let editorFrame = null;
  for (const frame of frames) {
    try {
      if ((await frame.locator(".se-section-documentTitle").count()) > 0) {
        editorFrame = frame;
        break;
      }
    } catch {
      /* frame 접근 불가 무시 */
    }
  }

  if (!editorFrame) {
    // 에디터를 못 찾으면 수동 모드: 창은 열려 있고 원고는 클립보드에 있다
    return {
      ok: false,
      stage: "manual",
      message: "에디터 화면을 자동 인식하지 못했습니다. 원고 전체가 클립보드에 복사되어 있으니 붙여넣기(Cmd+V) 해주세요.",
    };
  }

  await dismissDraftPopup(editorFrame);

  // 제목 입력
  const titleArea = editorFrame.locator(".se-section-documentTitle .se-text-paragraph").first();
  await titleArea.click({ timeout: 10000 });
  await page.keyboard.insertText(title);
  await page.waitForTimeout(300);

  // 본문 입력 — 원고 순서대로 텍스트 덩어리는 서식 붙여넣기, 이미지는 [사진] 버튼 업로드
  const bodyArea = editorFrame.locator(".se-component.se-text .se-text-paragraph").last();
  await bodyArea.click({ timeout: 10000 });

  const pasteHtml = async (htmlContent) => {
    await page.evaluate(async (content) => {
      const item = new ClipboardItem({ "text/html": new Blob([content], { type: "text/html" }) });
      await navigator.clipboard.write([item]);
    }, htmlContent);
    await page.keyboard.press("Meta+v");
    await page.waitForTimeout(800);
  };

  const uploadImage = async (imagePath) => {
    // [사진] 버튼 → OS 파일 선택창을 filechooser로 가로채 업로드 (커서 위치에 삽입됨)
    const photoButton = editorFrame
      .locator('button[data-name="image"], .se-toolbar-item-image button, button:has-text("사진")')
      .first();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 8000 }),
      photoButton.click({ timeout: 5000 }),
    ]);
    await chooser.setFiles(imagePath);
    // 업로드 완료 대기: 이미지 컴포넌트 수가 늘어날 때까지 최대 12초
    const before = await editorFrame.locator(".se-component.se-image").count().catch(() => 0);
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(600);
      const now = await editorFrame.locator(".se-component.se-image").count().catch(() => 0);
      if (now > before) break;
    }
    // 이미지 다음에 커서를 본문 끝으로 (이미지 선택 상태 해제)
    await page.keyboard.press("Escape").catch(() => {});
    const lastParagraph = editorFrame.locator(".se-component.se-text .se-text-paragraph").last();
    await lastParagraph.click().catch(() => {});
    await page.keyboard.press("Meta+ArrowDown").catch(() => {});
  };

  // 동영상 업로드: [동영상] 버튼 → 파일 선택창 가로채기 → 인코딩 완료(영상 컴포넌트 등장)까지 최대 90초 대기
  const uploadVideo = async (mp4Path, postTitle = "") => {
    const before = await editorFrame.locator(".se-component.se-video, .se-video").count().catch(() => 0);
    // 커서를 본문 맨 끝으로
    const last = editorFrame.locator(".se-component.se-text .se-text-paragraph").last();
    await last.click().catch(() => {});
    await page.keyboard.press("Meta+ArrowDown").catch(() => {});
    await page.keyboard.press("End").catch(() => {});
    // 1) 툴바 [동영상] → 업로더 팝업(.se-popup-video-upload)
    await editorFrame.locator('button[data-name="video"], .se-video-toolbar-button').first().click({ timeout: 5000 });
    const popup = editorFrame.locator(".se-popup-video-upload, .nvu_wrap").first();
    await popup.waitFor({ state: "visible", timeout: 8000 });
    // 2) 팝업의 [동영상 추가] → 파일 선택
    const addBtn = popup.locator(".nvu_btn_append.nvu_local, button:has-text('동영상 추가')").first();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), addBtn.click({ timeout: 5000 })]);
    await chooser.setFiles(mp4Path);
    // 3) 업로드·인코딩 대기 — 제목 칸이 있으면 채우고, [완료/확인/업로드] 버튼이 보이면 누른다
    const deadline = Date.now() + 120000;
    let lastText = "";
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      const now = await editorFrame.locator(".se-component.se-video, .se-video").count().catch(() => 0);
      if (now > before) return { ok: true, message: "슬라이드 영상 삽입됨" };
      if (!(await popup.isVisible().catch(() => false))) continue;
      lastText = (await popup.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      const titleBox = popup.locator('input[type="text"]:visible, textarea:visible').first();
      if (postTitle && (await titleBox.count()) > 0 && !(await titleBox.inputValue().catch(() => "x"))) await titleBox.fill(postTitle.slice(0, 60)).catch(() => {});
      const done = popup.locator('button:visible').filter({ hasText: /^(완료|확인|업로드|등록)$/ }).first();
      if ((await done.count()) > 0 && (await done.isEnabled().catch(() => false))) await done.click({ timeout: 1500 }).catch(() => {});
    }
    return { ok: false, message: `영상 업로드 확인 시간 초과 — 팝업 상태: ${lastText.slice(0, 120)}` };
  };

  let richPasted = false;
  let imageCount = 0;
  let videoResult = null;
  try {
    await browser.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://blog.naver.com" });
    await page.bringToFront();
    await bodyArea.click();
    for (const part of parts) {
      if (part.type === "html") {
        await pasteHtml(part.html);
      } else {
        try {
          await uploadImage(part.path);
        } catch {
          /* 업로드 실패 시 다음 파트 진행 — 개수는 마지막에 집계 */
        }
      }
    }
    const pasted = await editorFrame.locator(".se-component.se-text").allInnerTexts();
    richPasted = pasted.join("").replace(/\s/g, "").length > 100;
    imageCount = await editorFrame.locator(".se-component.se-image").count().catch(() => 0);

    // 카드 이미지 3장 이상이면 슬라이드 영상(약 16~20초)을 만들어 글 끝에 삽입 — 체류시간·멀티미디어 신호
    if (video && images.length >= 3) {
      try {
        const slug = path.basename(images[0].path).replace(/-[a-z0-9]+\.png$/i, "");
        const mp4 = path.join(path.dirname(images[0].path), `${slug}-slideshow.mp4`);
        const made = await buildSlideshow(images.map((i) => i.path), mp4);
        if (made.ok) {
          videoResult = await uploadVideo(mp4, title);
        } else videoResult = { ok: false, message: made.message };
      } catch (e) {
        videoResult = { ok: false, message: String(e?.message ?? e).slice(0, 120) };
      }
    }
  } catch {
    richPasted = false;
  }

  if (!richPasted) {
    // 폴백: 일반 텍스트를 문단 단위로 직접 타이핑 (서식 없음)
    const paragraphs = plain.split(/\n{2,}/);
    for (let i = 0; i < paragraphs.length; i += 1) {
      await page.keyboard.insertText(paragraphs[i]);
      if (i < paragraphs.length - 1) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(120);
      }
    }
  }

  const videoNote = videoResult ? (videoResult.ok ? " 슬라이드 영상 삽입됨." : ` 영상: ${videoResult.message}.`) : "";
  // 발행 창 열고 주제·예약 시간을 미리 채운다 — 최종 [발행] 버튼은 사람이 누른다
  let publishNote = "";
  if (publish && (publish.topic || publish.scheduleAt)) {
    try {
      const r = await setPublishOptions(page, editorFrame, publish);
      publishNote = ` ${r.message}`;
    } catch (e) {
      publishNote = ` 발행 창 설정 실패: ${String(e?.message ?? e).slice(0, 100)}.`;
    }
  }
  const imageNote = images.length
    ? imageCount >= images.length
      ? ` 이미지 ${imageCount}/${images.length}장 삽입됨.`
      : ` 이미지는 ${imageCount}/${images.length}장만 들어갔습니다 — 나머지는 에디터의 [사진]으로 직접 첨부해 주세요 (파일: ${images.map((i) => i.file).join(", ")}).`
    : "";
  return {
    ok: true,
    stage: "filled",
    message: richPasted
      ? `서식 포함(소제목·인용구·체크리스트·구분선) 입력 완료.${imageNote}${videoNote} ${publishNote ? publishNote.trim() + " " : ""}브라우저에서 확인 후 [발행]을 직접 눌러주세요.`
      : "서식 붙여넣기가 안 되어 일반 텍스트로 입력했습니다. 소제목·인용구는 에디터에서 지정 후 [발행]해 주세요.",
  };
}


// 진단: 글쓰기 화면이 실제로 무엇을 보여주는지 (새 블로그 첫 글쓰기 안내 팝업 등 파악용)
export async function inspectPostwrite(blogId, profile) {
  const browser = await getBrowser(profile);
  const page = await browser.newPage();
  try {
    await page.goto(`https://blog.naver.com/${blogId}/postwrite`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);
    const frames = page.frames().map((f) => ({ url: f.url().slice(0, 120) }));
    const info = await page.evaluate(() => ({
      url: location.href, title: document.title,
      hasTitle: !!document.querySelector(".se-section-documentTitle"),
      popups: [...document.querySelectorAll(".se-popup, [role=dialog], .layer_popup, .popup")].filter((e) => e.offsetParent).map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)),
      buttons: [...document.querySelectorAll("button, a")].filter((e) => e.offsetParent && e.innerText.trim()).map((e) => e.innerText.trim().slice(0, 20)).slice(0, 30),
      text: document.body.innerText.replace(/\s+/g, " ").slice(0, 500),
    })).catch((e) => ({ evalError: String(e) }));
    return { frames, ...info };
  } finally {
    await page.close().catch(() => {});
  }
}


// 진단: 이웃 새글 피드가 쓰는 내부 API를 찾는다 (댓글 후보 패널용). 로그인된 프로필로 열어 XHR 주소를 수집
export async function probeBuddyFeed(profile, target = "https://m.blog.naver.com/FeedList.naver") {
  const browser = await getBrowser(profile);
  const page = await browser.newPage();
  const found = new Map();
  page.on("response", async (r) => {
    const u = r.url();
    const rt = r.request().resourceType();
    if ((rt === "xhr" || rt === "fetch" || rt === "document") && !/\.(png|jpg|gif|js|css|svg|woff)/i.test(u)) {
      let sample = "";
      try { sample = (await r.text()).slice(0, 300); } catch { /* 바이너리 */ }
      const rq = r.request();
      found.set(u.slice(0, 220), { status: r.status(), method: rq.method(), body: (rq.postData() || "").slice(0, 600), reqHeaders: Object.fromEntries(Object.entries(rq.headers()).filter(([k]) => /^(x-|content-type|accept$)/i.test(k))), sample });
    }
  });
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.mouse.wheel(0, 1500).catch(() => {});
    await page.waitForTimeout(2500);
    const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    return { url: page.url(), text, xhr: [...found.entries()].map(([u, v]) => ({ u, ...v })) };
  } finally {
    await page.close().catch(() => {});
  }
}

// 로그인된 블로그 세션으로 네이버 내부 JSON API 호출 (m.blog 페이지 컨텍스트에서 fetch)
export async function fetchAsBlog(profile, apiUrl, { method = "GET", body, headers = {} } = {}) {
  const browser = await getBrowser(profile);
  const opts = {
    headers: { referer: "https://m.blog.naver.com/FeedList.naver", accept: "application/json, text/plain, */*", ...headers },
    timeout: 20000,
  };
  if (body !== undefined) { opts.data = body; opts.headers["content-type"] = headers["content-type"] || "application/json"; }
  const r = method === "POST" ? await browser.request.post(apiUrl, opts) : await browser.request.get(apiUrl, opts);
  const t = await r.text();
  try { return { status: r.status(), json: JSON.parse(t) }; } catch { return { status: r.status(), text: t.slice(0, 1500) }; }
}

// 디버그: 페이지를 열고 JS 식을 평가해 결과 반환 (로컬 전용)
export async function evalOnPage(profile, url, script, { wait = 2500 } = {}) {
  const browser = await getBrowser(profile);
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(wait);
    return { url: page.url(), result: await page.evaluate(script) };
  } finally {
    await page.close().catch(() => {});
  }
}

// 디버그: 이미 열려 있는 페이지(URL 패턴 일치)에서 JS 평가 — 에디터 iframe 안도 가능(frame: 'editor')
export async function evalOnOpenPage(profile, urlPattern, script, { frame } = {}) {
  const browser = await getBrowser(profile);
  const re = new RegExp(urlPattern);
  const page = browser.pages().find((p) => re.test(p.url()));
  if (!page) return { error: "열린 페이지 없음", pages: browser.pages().map((p) => p.url().slice(0, 100)) };
  let target = page;
  if (frame === "editor") {
    target = page.frames().find((f) => /PostWriteForm|postwrite/i.test(f.url()) && f !== page.mainFrame()) || page.frame({ name: "mainFrame" }) || page.mainFrame();
  }
  return { url: page.url(), frame: target.url().slice(0, 100), result: await target.evaluate(script) };
}

// 디버그: 서로이웃 신청을 한 건 실제로 시도하면서 네이티브 dialog·레이어 문구·결과 화면을 모두 기록
export async function buddyTry(blogId, message, profile, shotPath, relation = "both") {
  const browser = await getBrowser(profile);
  const page = await browser.newPage();
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push({ type: d.type(), text: d.message() }); await d.accept().catch(() => {}); });
  const responses = [];
  page.on("response", async (r) => {
    const u = r.url();
    if (/Buddy|buddy|neighbor/i.test(u) && !/\.(png|jpg|js|css|gif)/.test(u)) {
      let body = ""; try { body = (await r.text()).slice(0, 400); } catch { /* 바이너리 */ }
      responses.push({ status: r.status(), method: r.request().method(), url: u.slice(0, 160), post: (r.request().postData() || "").slice(0, 600), body });
    }
  });
  try {
    await page.goto(`https://m.blog.naver.com/BuddyAddForm.naver?blogId=${encodeURIComponent(blogId)}&mobileBuddyAddMessageType=1&returnUrl=${encodeURIComponent(`https://m.blog.naver.com/${blogId}`)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("textarea, input[type=radio], form", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    const before = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400);
    await page.locator(relation === "both" ? '#bothBuddyRadio, label:has-text("서로이웃")' : '#buddyRadio, label:has-text("이웃으로 추가")').first().click({ timeout: 4000 });
    const memo = page.locator("textarea").first();
    if (relation === "both" && (await memo.count()) > 0) { await memo.click({ timeout: 3000 }); await memo.fill(message); }
    const btn = page.locator('button:has-text("확인"), a:has-text("확인"), button[type="submit"]').first();
    const btnInfo = await btn.evaluate((b) => ({ tag: b.tagName, text: b.innerText.trim(), cls: b.className, disabled: b.disabled })).catch(() => null);
    const form = await page.evaluate(() => ({
      radios: [...document.querySelectorAll("input[type=radio], input[type=checkbox]")].map((r) => ({ name: r.name, id: r.id, value: r.value, checked: r.checked, label: (r.labels?.[0]?.innerText || "").trim().slice(0, 30) })),
      selects: [...document.querySelectorAll("select")].map((s) => ({ name: s.name, value: s.value, opts: [...s.options].map((o) => o.text).slice(0, 5) })),
      hidden: [...document.querySelectorAll("input[type=hidden]")].map((h) => ({ name: h.name, value: String(h.value).slice(0, 40) })),
      textarea: [...document.querySelectorAll("textarea")].map((t) => ({ name: t.name, len: t.value.length })),
      groupArea: (document.body.innerText.match(/그룹[^\n]{0,80}/g) || []).slice(0, 4),
    })).catch(() => null);
    await btn.click({ timeout: 4000 });
    await page.waitForTimeout(3500);
    const after = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
    const layers = await page.evaluate(() => [...document.querySelectorAll('[class*="layer"], [class*="popup"], [class*="toast"], [class*="alert"], [role="dialog"]')].filter((e) => e.offsetWidth).map((e) => ({ cls: e.className.toString().slice(0, 60), text: e.innerText.replace(/\s+/g, " ").slice(0, 200) }))).catch(() => []);
    if (shotPath) await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    return { url: page.url(), before, btnInfo, form, dialogs, responses, after, layers };
  } finally {
    await page.close().catch(() => {});
  }
}

// 디버그: PC 블로그 페이지의 [이웃추가] 레이어로 서로이웃 신청 시도 — PC는 오류 문구가 구체적이다
export async function buddyTryPc(blogId, message, profile, shotPath) {
  const browser = await getBrowser(profile);
  const page = await browser.newPage();
  const responses = [];
  page.on("response", async (r) => {
    const u = r.url();
    if (/Buddy|buddy/i.test(u) && !/\.(png|jpg|js|css|gif)/.test(u)) {
      let body = ""; try { body = (await r.text()).slice(0, 400); } catch { /* */ }
      responses.push({ status: r.status(), method: r.request().method(), url: u.slice(0, 160), post: (r.request().postData() || "").slice(0, 400), body });
    }
  });
  const steps = [];
  try {
    await page.goto(`https://blog.naver.com/${encodeURIComponent(blogId)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    const frame = page.frame({ name: "mainFrame" }) || page.frames().find((f) => /PostList|blog\.naver\.com\/\w+/.test(f.url()) && f !== page.mainFrame()) || page.mainFrame();
    const addBtn = frame.locator('a:has-text("이웃추가"), button:has-text("이웃추가")').first();
    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(2000);
    // 레이어는 iframe 안이나 팝업 창일 수 있다
    const popup = browser.pages().find((p) => p !== page && /Buddy/i.test(p.url()));
    const scope = popup || frame;
    const layerText = async () => (popup ? await popup.locator("body").innerText() : await frame.locator("body").innerText()).replace(/\s+/g, " ");
    steps.push({ step: "레이어 열림", popup: !!popup, text: (await layerText()).slice(0, 300) });
    const both = scope.locator('label:has-text("서로이웃"), input[type=radio][id*="both" i]').first();
    await both.click({ timeout: 5000 });
    const memo = scope.locator("textarea").first();
    if ((await memo.count()) > 0) { await memo.click(); await memo.fill(message); }
    const next = scope.locator('a:has-text("다음"), button:has-text("다음"), a:has-text("확인"), button:has-text("확인")').first();
    await next.click({ timeout: 5000 });
    await page.waitForTimeout(3000);
    steps.push({ step: "확인 클릭 후", text: (await layerText()).slice(0, 400) });
    if (shotPath) await (popup || page).screenshot({ path: shotPath }).catch(() => {});
    return { steps, responses };
  } catch (e) {
    return { steps, responses, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    for (const p of browser.pages()) if (p !== page && /Buddy/i.test(p.url())) await p.close().catch(() => {});
    await page.close().catch(() => {});
  }
}


// 발행 창: 주제 선택 + 예약 발행 시간 설정. 최종 [발행]은 누르지 않는다.
// 구조(2026-10 확인): 헤더 button.publish_btn__* → 설정 레이어. 주제는 a.link__*("주제 선택 안 함") → 라디오 label("비즈니스·경제") → 확인.
// 예약은 #radio_time2 → readonly 날짜 input(jQuery UI datepicker: td button.ui-state-default) + select.hour_option__*, select.minute_option__*(10분 단위)
export async function setPublishOptions(page, editorFrame, { topic, scheduleAt }) {
  const f = editorFrame || page.mainFrame();
  const notes = [];
  const openLayer = async () => {
    if ((await f.locator("#radio_time1").count()) > 0 && (await f.locator("#radio_time1").isVisible().catch(() => false))) return;
    await f.locator('button[class*="publish_btn"]').filter({ hasText: "발행" }).first().click({ timeout: 8000 });
    await f.locator("#radio_time1").waitFor({ state: "visible", timeout: 8000 });
    await page.waitForTimeout(500);
  };
  await openLayer();

  if (topic) {
    const link = f.locator('a[class*="link__"]').filter({ hasText: /주제|선택 안 함/ }).first();
    const current = ((await link.innerText().catch(() => "")) || "").trim();
    if (current.includes(topic)) notes.push(`주제 ${topic}(이미 설정)`);
    else {
      await link.click({ timeout: 5000 });
      await page.waitForTimeout(800);
      const radio = f.locator(`input[type="radio"][id^="${topic}_"]`).first();
      if ((await radio.count()) > 0) await radio.check({ force: true, timeout: 5000 }).catch(async () => { await f.locator(`label:has-text("${topic}")`).first().click({ timeout: 5000 }); });
      else await f.locator(`label:has-text("${topic}")`).first().click({ timeout: 5000 });
      await page.waitForTimeout(500);
      // 주제 설정 화면의 [확인]/[완료]로 돌아오기
      const confirm = f.locator('button:visible').filter({ hasText: /^(확인|완료)$/ }).first();
      if ((await confirm.count()) > 0) await confirm.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(600);
      await openLayer();
      const after = ((await f.locator('a[class*="link__"]').filter({ hasText: /주제|선택 안 함|·/ }).first().innerText().catch(() => "")) || "").trim();
      notes.push(after.includes(topic) ? `주제 ${topic} 설정됨` : `주제 설정 확인 안 됨(표시: ${after.slice(0, 20)})`);
    }
  }

  if (scheduleAt) {
    const t = new Date(scheduleAt);
    const kst = new Date(t.getTime() + 9 * 3600000); // 표시용 KST
    const y = kst.getUTCFullYear(), mo = kst.getUTCMonth() + 1, d = kst.getUTCDate();
    const hh = String(kst.getUTCHours()).padStart(2, "0"), mm = String(Math.floor(kst.getUTCMinutes() / 10) * 10).padStart(2, "0");
    await f.locator("#radio_time2").check({ force: true, timeout: 5000 });
    await page.waitForTimeout(600);
    const dateInput = f.locator('input[class*="input_date"]').first();
    const cur = (await dateInput.inputValue().catch(() => "")).replace(/\s/g, ""); // "2026.10.13"
    const want = `${y}.${mo}.${d}`;
    if (cur.replace(/\.$/, "") !== want) {
      await dateInput.click({ timeout: 4000 });
      await page.waitForTimeout(600);
      const pop = f.locator('div[class*="date__"]').first();
      // 월 이동
      for (let guard = 0; guard < 3; guard += 1) {
        const head = (await pop.innerText().catch(() => "")).match(/(\d{4})년\s*(\d{1,2})월/);
        if (!head) break;
        const cy = Number(head[1]), cm = Number(head[2]);
        if (cy === y && cm === mo) break;
        await pop.locator('button:has-text("다음 달"), a:has-text("다음 달"), [class*="next"]').first().click({ timeout: 3000 });
        await page.waitForTimeout(400);
      }
      await pop.locator("button.ui-state-default, td:not(.ui-state-disabled) button").filter({ hasText: new RegExp(`^${d}$`) }).first().click({ timeout: 4000 });
      await page.waitForTimeout(500);
    }
    await f.locator('select[class*="hour_option"]').first().selectOption(hh);
    await f.locator('select[class*="minute_option"]').first().selectOption(mm);
    await page.waitForTimeout(300);
    const finalDate = (await dateInput.inputValue().catch(() => "")).replace(/\s/g, "");
    notes.push(`예약 ${finalDate} ${hh}:${mm} 설정됨`);
  }
  return { ok: true, message: notes.join(", ") + "." };
}
