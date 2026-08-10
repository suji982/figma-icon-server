// api/generate-icon.js
//
// Figma 플러그인 → 이 엔드포인트(/api/generate-icon) → Gemini 3 Pro Image(Nano Banana Pro) → 이미지 반환
//
// 이 파일은 Vercel Serverless Function입니다.
// API 키는 Vercel 프로젝트 설정 > Environment Variables 에 GEMINI_API_KEY 로 등록하세요.
//
// 이 서버의 역할은 "이미지 생성"까지입니다. 배경 제거는 이 서버의 책임이 아니고,
// Figma 플러그인 쪽 코드에서 처리하는 걸 전제로 합니다 (remove.bg의 Figma 플러그인처럼,
// 플러그인 자체 코드 안에서 배경 제거 로직/API를 호출하는 구조).
//
// 모델: gemini-2.5-flash-image ("나노바나나", Pro 아님) — 카드 등록 없이 하루 최대
// 500장까지 무료로 쓸 수 있어서 팀 공용 도구에 맞게 이걸로 선택했습니다.
// 나노바나나 프로(gemini-3-pro-image-preview)는 무료 티어가 없어서 제외했습니다.
// 품질(4K, 정밀 텍스트 렌더링 등)이 부족하다고 느껴지면 이 상수만 바꾸면 됩니다 —
// 다만 그 경우엔 결제가 필요해집니다. 무료/유료 정책은 Google 쪽에서 바뀔 수 있으니
// 배포 전에 https://ai.google.dev/gemini-api/docs/pricing 에서 최신 상태를 확인하세요.
//
// 배경은 플레인 화이트(#FFFFFF)로 생성합니다.

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const GEMINI_MODEL = "gemini-2.5-flash-image"; // = 나노바나나 (무료 티어 있음, Pro 아님)
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const BACKGROUND_HEX = "#FFFFFF";

// 참조 이미지(투명 PNG)를 흰 배경 위에 합성해서 모델에게 전달합니다.
// (알파를 그냥 버리면 모델이 검정으로 해석할 수 있어서, 명시적으로 흰색에 합성 후 전달 —
// 이건 "생성 품질"을 위한 전처리이고, 최종 결과물의 배경 제거와는 무관합니다.)
function flattenOntoWhite(buffer) {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const a = data[idx + 3] / 255;
    data[idx] = Math.round(data[idx] * a + 255 * (1 - a));
    data[idx + 1] = Math.round(data[idx + 1] * a + 255 * (1 - a));
    data[idx + 2] = Math.round(data[idx + 2] * a + 255 * (1 - a));
    data[idx + 3] = 255;
  }
  return PNG.sync.write(png);
}

function loadStyleAnchors() {
  try {
    const files = fs
      .readdirSync(ASSETS_DIR)
      .filter((f) => /^style-anchor.*\.png$/i.test(f))
      .sort();

    return files.map((filename) => {
      const raw = fs.readFileSync(path.join(ASSETS_DIR, filename));
      const flattened = flattenOntoWhite(raw);
      return { mimeType: "image/png", data: flattened.toString("base64") };
    });
  } catch {
    return [];
  }
}

// ── 스타일 고정 템플릿 ──────────────────────────────────────────────
const STYLE_TEMPLATE = `
A single 3D clay-render icon of {SUBJECT}, matching the exact material, color palette,
proportions, and lighting style of the attached reference images (rounded chibi-like proportions,
soft matte-to-glossy plastic/clay material with subtle specular highlights, toy-like confident
colors, soft even studio lighting from the upper-left, same slight 3/4 front elevated camera angle).
BACKGROUND: the entire background must be a single solid flat plain white (#FFFFFF), with no
gradient, no texture, no scene, no floor plane, no shadow cast onto the background itself.
Centered composition, single self-contained object/scene, small readable text/labels are allowed
only on the subject itself when relevant (e.g. logos, gauges, screens), high quality render.
`
  .trim()
  .replace(/\s+/g, " ");

function buildPrompt(subject, extraDetail) {
  let prompt = STYLE_TEMPLATE.replace("{SUBJECT}", subject);
  if (extraDetail) prompt += `. Additional detail: ${extraDetail}`;
  return prompt;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 허용됩니다." });
  }

  try {
    const { subject, extraDetail, referenceImageBase64 } = req.body || {};

    if (!subject || typeof subject !== "string") {
      return res
        .status(400)
        .json({ error: "subject(아이콘 이름, 예: 'car')가 필요합니다." });
    }

    const prompt = buildPrompt(subject, extraDetail);
    const parts = [{ text: prompt }];

    if (referenceImageBase64) {
      parts.push({
        inlineData: { mimeType: "image/png", data: referenceImageBase64 },
      });
    } else {
      for (const anchor of loadStyleAnchors()) {
        parts.push({ inlineData: anchor });
      }
    }

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({ contents: [{ parts }] }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return res
        .status(geminiRes.status)
        .json({ error: "Gemini API 오류", detail: errText });
    }

    const data = await geminiRes.json();
    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = responseParts.find((p) => p.inlineData?.data);

    if (!imagePart) {
      return res
        .status(502)
        .json({ error: "이미지 생성 결과가 없습니다.", raw: data });
    }

    return res.status(200).json({
      subject,
      mimeType: imagePart.inlineData.mimeType,
      imageBase64: imagePart.inlineData.data, // 화이트 배경 상태 그대로 - 배경 제거는 플러그인 쪽 몫
      backgroundColor: BACKGROUND_HEX,
    });
  } catch (err) {
    return res.status(500).json({ error: "서버 오류", detail: String(err) });
  }
};
