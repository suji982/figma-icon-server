// api/generate-sticker.js
//
// Figma 스티커 플러그인 → /api/generate-sticker → Gemini(나노바나나) → 이미지 반환
//
// 기존 figma-icon-server 저장소의 api/ 폴더에 이 파일만 추가하면 됩니다.
// (같은 Vercel 프로젝트·같은 GEMINI_API_KEY·같은 도메인을 그대로 씀)
//
// 역할 분담 (v2)
//   서버/모델: 외곽선·흰 테두리 없는 "플랫한 색 면" 일러스트만 키 컬러 배경 위에 생성
//   플러그인:  배경 제거 → 실루엣을 따라 외곽선 + 흰 칼선 테두리를 직접 그림
//   → 모델이 선 두께·위치를 못 지키는 문제를 원천 차단. 외곽선 색/두께는 서버와 무관.
//
// 3D 아이콘과 다른 점
// 1) 사용자가 고른 색상(1~6개)을 받아서 팔레트로 강제합니다.
//    - 모델은 hex 코드를 잘 못 알아듣기 때문에 hex + 가장 가까운 색 이름을 같이 넣고,
//    - 팔레트 색상칩 이미지를 만들어서 참조 이미지로 함께 첨부합니다.
// 2) 배경을 흰색이 아니라 "키 컬러"(형광 그린/마젠타 등)로 생성합니다.
//    스티커는 흰 칼선 테두리가 있어서, 배경이 흰색이면 테두리까지 같이 지워지거든요.
//    키 컬러는 사용자가 고른 색과 가장 먼 색으로 자동 선택합니다.
//    흰 테두리가 피사체를 한 겹 감싸고 있어서 color spill 걱정도 거의 없습니다.

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

const GEMINI_MODEL = "gemini-2.5-flash-image";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const ASSETS_DIR = path.join(__dirname, "..", "assets");
const MAX_COLORS = 6;

// ── 색상 유틸 ─────────────────────────────────────────────────────
const HEX_RE = /^#[0-9a-f]{6}$/i;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const NAMED_COLORS = [
  ["red", [220, 40, 40]], ["coral", [245, 110, 90]], ["orange", [245, 140, 30]],
  ["peach", [250, 190, 150]], ["mustard yellow", [210, 170, 40]], ["yellow", [250, 210, 40]],
  ["cream", [250, 240, 215]], ["beige", [230, 210, 170]], ["brown", [130, 80, 40]],
  ["olive green", [120, 130, 50]], ["lime green", [150, 210, 50]], ["green", [40, 160, 70]],
  ["mint", [160, 230, 200]], ["teal", [20, 150, 150]], ["sky blue", [90, 180, 240]],
  ["blue", [40, 90, 220]], ["navy", [25, 35, 90]], ["lavender", [190, 160, 230]],
  ["purple", [130, 60, 190]], ["pink", [245, 150, 190]], ["hot pink", [235, 50, 130]],
  ["burgundy", [120, 20, 40]], ["white", [255, 255, 255]], ["light gray", [200, 200, 200]],
  ["gray", [128, 128, 128]], ["charcoal", [55, 55, 60]], ["black", [15, 15, 15]],
  // 외곽선용 어두운 색
  ["dark indigo", [37, 44, 70]], ["dark brown", [74, 46, 42]], ["dark forest green", [45, 74, 62]],
  ["dark plum purple", [91, 42, 110]], ["dark maroon", [90, 25, 30]],
];

function colorName(hex) {
  const rgb = hexToRgb(hex);
  let best = NAMED_COLORS[0];
  for (const c of NAMED_COLORS) if (dist(c[1], rgb) < dist(best[1], rgb)) best = c;
  return best[0];
}

// 배경(키 컬러) 후보 — 사용자가 고른 색 + 흰 테두리 + 검정 외곽선과 가장 먼 것을 고름
const KEY_CANDIDATES = [
  ["bright green", "#00FF00"],
  ["magenta", "#FF00FF"],
  ["cyan", "#00FFFF"],
  ["pure blue", "#0000FF"],
  ["chartreuse", "#80FF00"],
  ["orange-red", "#FF4000"],
];

function pickKeyColor(colors) {
  // 흰색·검정 계열도 피함 (모델이 팔레트 밖으로 흰 하이라이트나 어두운 그림자를 쓸 수 있어서)
  const avoid = colors.map(hexToRgb).concat([[255, 255, 255], [30, 30, 40]]);
  let best = KEY_CANDIDATES[0];
  let bestScore = -1;
  for (const cand of KEY_CANDIDATES) {
    const rgb = hexToRgb(cand[1]);
    const score = Math.min(...avoid.map((a) => dist(a, rgb)));
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return { name: best[0], hex: best[1] };
}

// 선택한 색을 가로로 이어붙인 팔레트 칩 이미지(PNG base64)
function makePaletteSwatch(colors) {
  const cell = 128;
  const png = new PNG({ width: cell * colors.length, height: cell });
  const rgbs = colors.map(hexToRgb);
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = rgbs[Math.floor(x / cell)];
      const i = (y * png.width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

// ── 스타일 앵커 ──────────────────────────────────────────────────
// assets/sticker-anchor-*.png (투명 배경 PNG)가 매 요청에 스타일 참조로 붙습니다.
// 3D 아이콘용 style-anchor-*.png 와는 파일명 접두사가 달라서 섞이지 않아요.
// 앵커는 요청마다 그때 고른 키 컬러 배경 위에 합성해서 보냅니다 —
// 모델이 "이 배경 위에 이런 스티커 하나"라는 결과물 형태를 그대로 보고 따라하게 하려는 것.
function flattenOnto(buffer, rgb) {
  const png = PNG.sync.read(buffer);
  const { data } = png;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    data[i] = Math.round(data[i] * a + rgb[0] * (1 - a));
    data[i + 1] = Math.round(data[i + 1] * a + rgb[1] * (1 - a));
    data[i + 2] = Math.round(data[i + 2] * a + rgb[2] * (1 - a));
    data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function loadStickerAnchors(keyHex) {
  try {
    const rgb = hexToRgb(keyHex);
    return fs
      .readdirSync(ASSETS_DIR)
      .filter((f) => /^sticker-anchor.*\.png$/i.test(f))
      .sort()
      .map((f) => ({
        mimeType: "image/png",
        data: flattenOnto(fs.readFileSync(path.join(ASSETS_DIR, f)), rgb).toString("base64"),
      }));
  } catch {
    return [];
  }
}

// ── 프롬프트 ─────────────────────────────────────────────────────
function buildPrompt({ subject, extraDetail, colors, key, hasAnchors }) {
  const palette = colors.length
    ? colors.map((c) => `${colorName(c)} (${c.toUpperCase()})`).join(", ")
    : null;

  const lines = [
    `A flat, minimal vector illustration of ${subject}, made only of solid color shapes.`,

    `NO LINES AT ALL (most important): no outlines, no strokes, no contour lines, no dark edges,
no line art, no dividing lines between parts — not around the silhouette and not inside it.
Parts are separated only by flat color changes. No white border or sticker border either
(it is added later in post-production). The shapes touch the background directly.`,

    `SIMPLICITY (very important): reduce the subject to its 3 to 5 most essential, large, chunky
shapes with rounded corners, simpler than an emoji. Merge similar or thin layers into one.
Leave out small details entirely: no seeds, dots, stitches, textures, patterns, sparkles,
tiny highlights, or small parts. One compact, solid silhouette. Shading, if any, is at most one
large, hard-edged lighter or darker tint shape per area — never gradients. No 3D, no
photorealism, no drop shadow.`,

    hasAnchors
      ? `The attached style reference sheet shows example illustrations in exactly this style:
bold, chunky flat color shapes, simple two-tone shading, no lines anywhere. Match that level of
simplicity and that shading approach. Do NOT copy their subjects, characters, faces, or colors,
and draw only ONE illustration of the requested subject.`
      : null,

    palette
      ? `COLOR PALETTE (strict): use only these colors: ${palette}, plus slightly lighter or darker
tints of them for the two-tone shading. The attached palette swatch image shows the exact
colors. Do not introduce other hues.`
      : `COLOR PALETTE: a small, harmonious palette of 3-4 cheerful, saturated colors.`,

    `BACKGROUND: the entire background is one flat, uniform ${key.name} (${key.hex}) color. No
gradient, no texture, no shadow, no scene, no floor. Never use this ${key.name} color or anything
close to it inside the illustration.`,

    `COMPOSITION: exactly one subject, centered, filling about 70% of the frame, with plenty of
background visible on all four sides. No text or lettering unless explicitly requested below.`,

    extraDetail ? `Additional detail: ${extraDetail}` : null,
  ];

  return lines
    .filter(Boolean)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .join("\n\n");
}

// ── 핸들러 ───────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 요청만 허용됩니다." });
  }

  try {
    const { subject, extraDetail, colors: rawColors, referenceImageBase64 } = req.body || {};

    if (!subject || typeof subject !== "string") {
      return res.status(400).json({ error: "subject(사물 이름, 예: 'cat')가 필요합니다." });
    }

    const colors = Array.isArray(rawColors)
      ? rawColors.filter((c) => typeof c === "string" && HEX_RE.test(c)).slice(0, MAX_COLORS)
      : [];

    const key = pickKeyColor(colors);
    const anchors = referenceImageBase64
      ? [{ mimeType: "image/png", data: referenceImageBase64 }]
      : loadStickerAnchors(key.hex);

    const parts = [
      { text: buildPrompt({ subject, extraDetail, colors, key, hasAnchors: anchors.length > 0 }) },
    ];

    if (anchors.length) {
      parts.push({ text: "Style reference sheet:" });
      for (const a of anchors) parts.push({ inlineData: a });
    }
    if (colors.length) {
      parts.push({ text: "Color palette swatch (use these colors):" });
      parts.push({ inlineData: { mimeType: "image/png", data: makePaletteSwatch(colors) } });
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
      return res.status(geminiRes.status).json({ error: "Gemini API 오류", detail: errText });
    }

    const data = await geminiRes.json();
    const responseParts = data?.candidates?.[0]?.content?.parts || [];
    const imagePart = responseParts.find((p) => p.inlineData?.data);

    if (!imagePart) {
      return res.status(502).json({ error: "이미지 생성 결과가 없습니다.", raw: data });
    }

    return res.status(200).json({
      subject,
      colors,
      mimeType: imagePart.inlineData.mimeType,
      imageBase64: imagePart.inlineData.data, // 키 컬러 배경 + 선 없는 일러스트 — 외곽선·테두리는 플러그인에서
      keyColor: key.hex,
    });
  } catch (err) {
    return res.status(500).json({ error: "서버 오류", detail: String(err) });
  }
};
