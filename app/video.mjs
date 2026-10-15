// 카드 이미지(PNG) → 짧은 슬라이드 영상(mp4). 네이버는 동영상 포함 글의 체류시간을 신호로 본다.
// 각 장 4초, 1초 크로스페이드, 무음, 1000×750 → 1280×960 (짝수 해상도, 모바일에서 선명)
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

const FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"];
const PER = 4; // 초/장
const FADE = 1;

export async function buildSlideshow(pngPaths, outPath) {
  const inputs = pngPaths.filter(Boolean);
  if (inputs.length < 2) return { ok: false, message: "이미지 2장 이상 필요" };
  const args = [];
  for (const p of inputs) args.push("-loop", "1", "-t", String(PER), "-i", p);
  // 각 입력을 같은 크기로 맞춘 뒤 xfade 체인으로 연결
  const scaled = inputs.map((_, i) => `[${i}:v]scale=1280:960:force_original_aspect_ratio=decrease,pad=1280:960:(ow-iw)/2:(oh-ih)/2:color=#f3f6f5,setsar=1,format=yuv420p[v${i}]`).join(";");
  let chain = "", prev = "v0";
  for (let i = 1; i < inputs.length; i += 1) {
    const out = i === inputs.length - 1 ? "vout" : `x${i}`;
    const offset = i * (PER - FADE);
    chain += `;[${prev}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${offset}[${out}]`;
    prev = out;
  }
  args.push("-filter_complex", scaled + chain, "-map", "[vout]", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", "-y", outPath);
  for (const bin of FFMPEG) {
    try {
      await new Promise((resolve, reject) => execFile(bin, args, { timeout: 120000 }, (err, _o, stderr) => (err ? reject(new Error(stderr?.slice(-300) || err.message)) : resolve())));
      const size = (await stat(outPath)).size;
      return { ok: true, path: outPath, seconds: inputs.length * PER - (inputs.length - 1) * FADE, bytes: size };
    } catch (e) {
      if (!/ENOENT/.test(String(e.message))) return { ok: false, message: e.message.slice(0, 200) };
    }
  }
  return { ok: false, message: "ffmpeg 없음" };
}
