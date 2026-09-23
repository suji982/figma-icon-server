// api/generate-sticker.js  (v3)
//
// Figma 스티커 플러그인 → /api/generate-sticker → Gemini(나노바나나) → 이미지 반환
//
// 역할 분담
//   서버/모델: 외곽선·흰 테두리 없는 "플랫한 색 면" 일러스트 1개를 키 컬러 배경 위에 생성
//   플러그인:  배경 제거 → 주 객체만 남김 → 팔레트로 색 스냅 → 외곽선 + 흰 칼선 (PNG 또는 벡터)
//
// v3에서 바뀐 점
// 1) 객체 여러 개 문제
//    - 스타일 앵커를 "여러 개가 한 장에 있는 시트" → "한 장에 하나씩, 따로따로" 보냄.
//      (예전 앵커 한 장에 5개가 있어서 모델이 "여러 개 그리는 게 정답"으로 학습했던 게 주원인)
//    - 프롬프트에 단일 객체 조건 강화 + 1:1 비율 고정.
// 2) 명암이 제멋대로인 문제
//    - 고른 색마다 서버에서 [밝은 면 / 기본 / 그림자 면] 3단 램프를 계산해서 hex로 못 박음.
//    - "빛은 왼쪽 위 하나" 규칙과 면 방향 → 톤 대응을 명시.
//    - 색 순서에 역할 부여: 1번 = 메인(면적 대부분), 2번 = 보조, 3번~ = 포인트.
//    - 램프를 응답(palette)으로 돌려줘서, 플러그인이 모든 픽셀을 이 색들로 스냅함
//      → 팔레트 밖 색은 결과물에 절대 안 남음.

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
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
}
function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// 한 색 → [밝은 면, 기본, 그림자 면]
// 그림자: 약간 푸른 기가 도는 multiply / 밝은 면: 약간 따뜻한 screen
// (HSL로 계산하면 크림·파스텔 계열 그림자가 형광 살구색처럼 튀어서 RGB 혼합 방식으로)
const SHADE_MUL = [0.78, 0.76, 0.86];
const LIGHT_MIX = [0.32, 0.30, 0.24];

function makeRamp(hex) {
  const rgb = hexToRgb(hex);
  const shadow = rgb.map((v, i) => v * SHADE_MUL[i]);
  const light = rgb.map((v, i) => v + (255 - v) * LIGHT_MIX[i]);
  return { light: rgbToHex(light), base: hex.toUpperCase(), shadow: rgbToHex(shadow) };
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
];

function colorName(hex) {
  const rgb = hexToRgb(hex);
  let best = NAMED_COLORS[0];
  for (const c of NAMED_COLORS) if (dist(c[1], rgb) < dist(best[1], rgb)) best = c;
  return best[0];
}

// 배경(키 컬러) 후보 — 팔레트 램프 전체 + 흰색 + 어두운 색과 가장 먼 것
const KEY_CANDIDATES = [
  ["bright green", "#00FF00"],
  ["magenta", "#FF00FF"],
  ["cyan", "#00FFFF"],
  ["pure blue", "#0000FF"],
  ["chartreuse", "#80FF00"],
  ["orange-red", "#FF4000"],
];

function pickKeyColor(paletteHexes) {
  const avoid = paletteHexes.map(hexToRgb).concat([[255, 255, 255], [30, 30, 40]]);
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

// 팔레트 칩: 색마다 세로 3칸 [밝은 면 / 기본 / 그림자 면], 1번 색이 가장 넓게
function makeRampSwatch(ramps) {
  const cellH = 96;
  const widths = ramps.map((_, i) => (i === 0 ? 192 : 128));
  const W = widths.reduce((a, b) => a + b, 0);
  const png = new PNG({ width: W, height: cellH * 3 });
  let x0 = 0;
  ramps.forEach((ramp, i) => {
    const rows = [ramp.light, ramp.base, ramp.shadow].map(hexToRgb);
    for (let y = 0; y < cellH * 3; y++) {
      const [r, g, b] = rows[Math.floor(y / cellH)];
      for (let x = x0; x < x0 + widths[i]; x++) {
        const o = (y * W + x) * 4;
        png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b; png.data[o + 3] = 255;
      }
    }
    x0 += widths[i];
  });
  return PNG.sync.write(png).toString("base64");
}

// ── 스타일 앵커 ──────────────────────────────────────────────────
// assets/sticker-anchor-*.png — ⚠️ 파일 하나에 객체 딱 하나. 여러 개가 들어간 시트는 넣지 마세요.
// 요청마다 그때 고른 키 컬러 위에 합성해서 "이 배경 위에 이런 거 하나"라는 결과 형태를 보여줍니다.
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
      .slice(0, 4)
      .map((f) => ({
        mimeType: "image/png",
        data: flattenOnto(fs.readFileSync(path.join(ASSETS_DIR, f)), rgb).toString("base64"),
      }));
  } catch {
    return [];
  }
}

// ── 프롬프트 ─────────────────────────────────────────────────────
const ROLE = ["MAIN color — covers most of the object", "SECONDARY color", "ACCENT color — small parts only"];

function buildPrompt({ subject, extraDetail, ramps, key, anchorCount }) {
  const paletteLines = ramps.map((r, i) =>
    `Color ${i + 1} (${colorName(r.base)}, ${ROLE[Math.min(i, 2)]}): ` +
    `light face ${r.light}, base ${r.base}, shadow face ${r.shadow}`
  );

  const lines = [
    `Draw exactly ONE single ${subject} as a flat, minimal vector illustration made only of solid color shapes.`,

    `ONE OBJECT ONLY (most important): the image contains a single ${subject} and nothing else.
Not a set, not a pair, not a group, not a pattern, no copies, no variations side by side,
no extra props or background objects. If the subject name could mean several items, draw just one.
The whole illustration is one connected silhouette.`,

    `NO LINES AT ALL: no outlines, no strokes, no contour lines, no dark edges, no line art,
no dividing lines between parts — not around the silhouette and not inside it.
Parts are separated only by flat color changes. No white border or sticker border
(it is added later). The shapes touch the background directly.`,

    `LIGHTING (very important, apply the same rule to every part):
one single light source from the TOP-LEFT.
Surfaces facing up or toward the upper-left use the LIGHT tone of that part's color.
Surfaces facing the viewer use the BASE tone.
Surfaces facing down or toward the right use the SHADOW tone.
Shading is flat, hard-edged shapes following the object's form (like a cube's three faces,
or a crescent on the lower-right of a round shape) — never gradients, never random blobs,
never decorative patches that ignore the form. Every part of the object is lit from the same side.`,

    `SIMPLICITY: reduce the subject to its 3 to 6 most essential, large, chunky shapes with rounded
corners, simpler than an emoji. No scattered small details inside shapes: no dots, specks, stitches,
fine patterns, sparkles or tiny parts. No 3D rendering, no photorealism, no drop shadow, no cast shadow on the ground.`,

    `MATERIAL TEXTURE THROUGH CONTOUR (important): when the material has a characteristic texture,
show it ONLY through the outline shape of that part, never through small marks inside it.
Examples: rice = a bumpy, lumpy edge along the rice shape; whipped cream = a few big rounded
swirl lobes with one flat tone shape per lobe; lettuce = a wavy, ruffled edge; melted cheese = one
drip shape; fur = a few chunky tufts on the silhouette edge. Keep these edge bumps large and few,
so the shape still reads clearly at small sizes.`,

    anchorCount
      ? `The ${anchorCount} attached style examples each show ONE illustration in exactly this style and
lighting logic (top-left light, three flat tones per color, no lines, texture shown only through
contour shapes like the rice edge or the cream swirls). Match their simplicity, shading logic and
contour-based texture. Do NOT copy their subjects or colors, and draw only ONE ${subject}.`
      : null,

    ramps.length
      ? `COLOR PALETTE (strict): use ONLY these exact colors. Each color comes as a 3-tone ramp;
each part of the object uses one ramp and picks light/base/shadow by the lighting rule.
${paletteLines.join(" | ")}
The attached swatch image shows these ramps (top row light, middle base, bottom shadow).
No other hues. Small dark details (like eyes) may use the darkest shadow tone.`
      : `COLOR PALETTE: a small, harmonious palette of 2-3 cheerful, saturated colors, each used as a
3-tone ramp (light face / base / shadow face).`,

    `BACKGROUND: the entire background is one flat, uniform ${key.name} (${key.hex}). No gradient,
no texture, no shadow, no scene, no floor. Never use ${key.name} or anything close to it inside the illustration.`,

    `COMPOSITION: the single ${subject} is centered, filling about 65% of the frame, with plenty of
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
    const ramps = colors.map(makeRamp);
    const palette = ramps.flatMap((r) => [r.light, r.base, r.shadow]);

    const key = pickKeyColor(palette);
    const anchors = referenceImageBase64
      ? [{ mimeType: "image/png", data: referenceImageBase64 }]
      : loadStickerAnchors(key.hex);

    const parts = [
      { text: buildPrompt({ subject, extraDetail, ramps, key, anchorCount: anchors.length }) },
    ];

    // 앵커는 한 장씩 따로, "예시 n — 객체 하나" 라벨과 함께
    anchors.forEach((a, i) => {
      parts.push({ text: `Style example ${i + 1} of ${anchors.length} (one single illustration):` });
      parts.push({ inlineData: a });
    });
    if (ramps.length) {
      parts.push({ text: "Color ramp swatch (columns = colors in order, rows = light / base / shadow):" });
      parts.push({ inlineData: { mimeType: "image/png", data: makeRampSwatch(ramps) } });
    }

    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "1:1" },
        },
      }),
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
      palette,          // 플러그인이 색 스냅에 씀 (색을 안 골랐으면 빈 배열 → 플러그인이 자동 추출)
      mimeType: imagePart.inlineData.mimeType,
      imageBase64: imagePart.inlineData.data,
      keyColor: key.hex,
    });
  } catch (err) {
    return res.status(500).json({ error: "서버 오류", detail: String(err) });
  }
};
